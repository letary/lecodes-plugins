package dev.tinyrtc

import android.annotation.SuppressLint
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.display.DisplayManager
import android.media.MediaCodec
import android.os.Handler
import android.os.HandlerThread
import android.util.Range
import android.util.Size
import android.view.Display
import android.view.Surface
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/** What the camera's track did (diagnostics, e.g. for a call screen's debug overlay). */
data class VideoTrackDiagnostics(
    val framesEncoded: Long,
    val framesSent: Long,
    val keyframes: Long,
    val keyframesRequested: Long,
    val encoder: String,
    val encodeWidth: Int,
    val encodeHeight: Int,
    val bitrate: Int,
    /** The core's last target: bitrate, fps, height (0 = none yet). */
    val targetBitrate: Int,
    val targetFps: Int,
    val targetHeight: Int,
    /** Degrees sent with the last frame. */
    val rotation: Int,
    /** The OS took the camera; it comes back by itself when it is free again. */
    val paused: Boolean,
)

/** What a local view needs to show the preview upright: the preview's buffer size and the sensor's mounting. */
internal data class PreviewGeometry(val width: Int, val height: Int, val sensorOrientation: Int, val facing: Facing)

/**
 * The sending side of the camera. Camera2 opens the device; ONE capture session has two outputs:
 * the encoder's input Surface (MediaCodec, H.264) and, while a view shows the track, the view's
 * SurfaceTexture. The ISP scales each output to its own size, so a smaller target is a smaller
 * encoder — recreated, with a new session (the first frame after is an IDR with its parameter
 * sets) — while the preview keeps the camera's format. No GL pass, no copy of a pixel.
 *
 * Frames are encoded as the sensor gives them; the degrees to show them upright (sensor
 * orientation, display rotation, facing) go with each frame to tinyrtc_video_source_send.
 *
 * Threads: everything here runs on one HandlerThread ("tinyrtc-video"): the camera's callbacks,
 * the session, the encoder's callbacks, the core's targets (posted). The core's source is created
 * and destroyed on the lane; frames go into it here, under [sourceLock].
 */
internal class CameraPipeline(private val engine: RtcEngine, private var options: CameraOptions) {
    private val manager = engine.app.getSystemService(CameraManager::class.java)
    private val displays = engine.app.getSystemService(DisplayManager::class.java)
    private val thread = HandlerThread("tinyrtc-video").apply { start() }
    private val handler = Handler(thread.looper)
    private val key = Registry.add(this)

    private val sourceLock = Any()

    /** The core's video source; 0 before start and after close. Read on the lane (send_video). */
    @Volatile
    var source = 0L
        private set

    /** Connections sending it (changed on the main thread). */
    @Volatile
    var takers = 0

    /** The track, told when the camera is gone for good. Weak through a lambda the track gives. */
    var onEnded: ((String) -> Unit)? = null

    @Volatile
    var settings: VideoSettings = VideoSettings("", options.facing, options.width, options.height, options.frameRate)
        private set

    // ---- the video thread ----

    private class Spec(
        val id: String,
        val facing: Facing,
        val sensorOrientation: Int,
        val codecSizes: List<Size>,
        val capture: Size,
        val preview: Size,
        val fpsRanges: List<Range<Int>>,
        val fps: Int,
    )

    private lateinit var spec: Spec
    private var device: CameraDevice? = null
    private var attempt: SessionAttempt? = null
    /** Every session not over yet (the current one and those still closing). */
    private val attempts = ArrayList<SessionAttempt>()
    private val losses = ArrayList<Long>()
    private var encoder: VideoEncoder? = null
    private var encodeSize = Size(0, 0)
    private var preview: Preview? = null
    private var opening: CancellableContinuation<Unit>? = null
    private var paused = false
    private var closed = false
    private var finished = false
    private var bitrate = START_BITRATE
    private var targetFps = 0
    private var targetHeight = 0
    private var wantedSize: Size? = null
    private var parameterSets: ByteArray? = null
    private var scratch: ByteBuffer? = null
    private var encoderFailures = 0

    @Volatile private var displayDegrees = 0
    @Volatile private var lastTarget = IntArray(3)
    @Volatile private var lastRotation = 0
    private val encoded = AtomicLong()
    private val sent = AtomicLong()
    private val keyframesOut = AtomicLong()
    private val keyframesAsked = AtomicLong()

    private class Preview(val texture: SurfaceTexture, val surface: Surface, val geometry: (PreviewGeometry) -> Unit)

    fun diagnostics(): VideoTrackDiagnostics {
        val e = encoder
        val t = lastTarget
        return VideoTrackDiagnostics(
            encoded.get(), sent.get(), keyframesOut.get(), keyframesAsked.get(), e?.name ?: "",
            e?.width ?: 0, e?.height ?: 0, bitrate, t[0], t[1], t[2], lastRotation, paused,
        )
    }

    // ---- lifecycle (any thread → the video thread) ----

    /** Creates the core's source, opens the camera; returns once it is open. */
    suspend fun start() {
        val created = withContext(Core.lane) { Native.sourceCreate(engine.handle, key) }
        if (created == 0L) {
            close()
            throw RtcError.Failed("the core made no video source")
        }
        source = created
        try {
            suspendCancellableCoroutine<Unit> { cont -> handler.post { begin(options, cont) } }
        } catch (e: Throwable) {
            close()
            throw e
        }
        applyLimits()
    }

    /** Another camera, size or rate: the camera is reopened, the track and its source stay. */
    suspend fun apply(next: CameraOptions) {
        suspendCancellableCoroutine<Unit> { cont -> handler.post { begin(next, cont) } }
        applyLimits()
    }

    /** Idempotent, any thread (also a finalizer). */
    fun close() {
        handler.post { shutdown() }
    }

    /** The most this camera's stream may take, bits per second; applied by [applyLimits]. */
    @Volatile
    var maxBitrate: Int = DEFAULT_MAX_BITRATE

    /** The ceiling the core's target stays under: the app's bitrate, the camera's format. */
    suspend fun applyLimits() {
        val s = settings
        val bitrate = maxBitrate
        withContext(Core.lane) {
            val h = source
            if (h != 0L) Native.sourceSetLimits(h, bitrate, s.frameRate, min(s.width, s.height))
        }
    }

    private fun begin(next: CameraOptions, cont: CancellableContinuation<Unit>) {
        if (closed) return cont.resumeWithException(RtcError.Closed("the camera track is stopped"))
        val chosen = try {
            select(next)
        } catch (e: Exception) {
            return cont.resumeWithException(e as? RtcError ?: RtcError.Failed("camera: ${e.message}"))
        }
        val first = !this::spec.isInitialized
        if (!first) {
            // Another camera: everything of the old one goes.
            closeSession()
            encoder?.let { old -> encoder = null; retire { old.release() } }
            device?.close()
            device = null
        } else {
            readDisplay()
            displays.registerDisplayListener(displayListener, handler)
            manager.registerAvailabilityCallback(availability, handler)
        }
        options = next
        spec = chosen
        settings = VideoSettings(chosen.id, chosen.facing, chosen.capture.width, chosen.capture.height, chosen.fps)
        encodeSize = encodeSizeFor(targetHeight)
        preview?.let { it.geometry(geometry()) }
        opening?.resumeWithException(RtcError.Closed("another apply() came first"))
        opening = cont
        paused = false
        try {
            openDevice()
        } catch (e: RtcError) {
            opening = null
            cont.resumeWithException(e)
        }
    }

    private fun shutdown() {
        if (closed) return
        closed = true
        opening?.let {
            opening = null
            it.resumeWithException(RtcError.Closed("the camera track is stopped"))
        }
        Registry.remove(key)
        if (this::spec.isInitialized) {
            runCatching { displays.unregisterDisplayListener(displayListener) }
            runCatching { manager.unregisterAvailabilityCallback(availability) }
        }
        handler.removeCallbacks(resize)
        val enc = encoder
        encoder = null
        val pv = preview
        preview = null
        enc?.let { retire { it.release() } }
        pv?.let { retire { it.surface.release() } } // the texture is the view's until it lets go (detachPreview)
        closeSession()
        val dev = device
        device = null
        if (dev != null) {
            dev.close() // onClosed finishes; a camera that never says so is given 2 s
            handler.postDelayed({ finish() }, 2000)
        } else {
            finish()
        }
    }

    /** After the camera stopped drawing into anything: the source goes (on the lane), then the thread. */
    private fun finish() {
        if (finished) return
        finished = true
        attempt = null
        attempts.toList().forEach { it.done() }
        Core.scope.launch {
            synchronized(sourceLock) {
                val h = source
                source = 0L
                if (h != 0L) Native.sourceDestroy(h)
            }
        }
        thread.quitSafely()
    }

    // ---- the camera ----

    private fun select(o: CameraOptions): Spec {
        val ids = manager.cameraIdList
        val id = if (o.deviceId != null) {
            o.deviceId.takeIf { it in ids } ?: throw RtcError.NotFound("no camera ${o.deviceId}")
        } else {
            ids.firstOrNull { facingOf(manager.getCameraCharacteristics(it)) == o.facing }
                ?: throw RtcError.NotFound("no ${o.facing.name.lowercase()} camera")
        }
        val chars = manager.getCameraCharacteristics(id)
        val map = chars[CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP]
            ?: throw RtcError.Failed("camera $id has no stream configurations")
        val codecSizes = map.getOutputSizes(MediaCodec::class.java)?.toList().orEmpty()
            .filter { VideoEncoder.supports(it.width, it.height) }
        val previewSizes = map.getOutputSizes(SurfaceTexture::class.java)?.toList().orEmpty()
        val long = max(o.width, o.height)
        val short = min(o.width, o.height)
        val capture = closest(codecSizes, long, short) ?: throw RtcError.Failed("camera $id has no size the encoder takes")
        val preview = if (capture in previewSizes) capture else closest(previewSizes, capture.width, capture.height) ?: capture
        val ranges = chars[CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES]?.toList().orEmpty()
        val top = ranges.maxOfOrNull { it.upper } ?: 30
        return Spec(
            id = id,
            facing = facingOf(chars),
            sensorOrientation = chars[CameraCharacteristics.SENSOR_ORIENTATION] ?: 0,
            codecSizes = codecSizes,
            capture = capture,
            preview = preview,
            fpsRanges = ranges,
            fps = o.frameRate.coerceIn(1, top),
        )
    }

    private fun closest(sizes: List<Size>, long: Int, short: Int): Size? = sizes.minByOrNull { s ->
        abs(max(s.width, s.height) - long) + abs(min(s.width, s.height) - short)
    }

    /** The encoder's size for a target height: the camera's aspect, the largest one that fits. */
    private fun encodeSizeFor(maxHeight: Int): Size {
        val capture = spec.capture
        val short = min(capture.width, capture.height)
        if (maxHeight <= 0 || maxHeight >= short) return capture
        val aspect = max(capture.width, capture.height).toDouble() / short
        val same = spec.codecSizes.filter { s ->
            val sShort = min(s.width, s.height)
            sShort <= short && abs(max(s.width, s.height).toDouble() / sShort - aspect) < 0.02
        }
        return same.filter { min(it.width, it.height) <= maxHeight }.maxByOrNull { it.width * it.height }
            ?: same.minByOrNull { it.width * it.height }
            ?: capture
    }

    @SuppressLint("MissingPermission") // openCamera() checked it; a revoked one throws SecurityException
    private fun openDevice() {
        try {
            manager.openCamera(spec.id, deviceCallback, handler)
        } catch (e: SecurityException) {
            throw RtcError.Denied("the CAMERA permission is missing")
        } catch (e: CameraAccessException) {
            throw RtcError.Failed("camera ${spec.id}: ${e.message}")
        } catch (e: IllegalArgumentException) {
            throw RtcError.NotFound("camera ${spec.id}: ${e.message}")
        }
    }

    private val deviceCallback = object : CameraDevice.StateCallback() {
        override fun onOpened(camera: CameraDevice) {
            if (closed || camera.id != spec.id) {
                camera.close()
                return
            }
            device = camera
            paused = false
            Log.i("camera ${camera.id} open: ${spec.capture} @${spec.fps}, sensor ${spec.sensorOrientation}°, ${spec.facing}")
            if (ensureEncoder()) rebuildSession()
            opening?.let {
                opening = null
                it.resume(Unit)
            }
        }

        override fun onDisconnected(camera: CameraDevice) = lost(camera, "disconnected")

        override fun onError(camera: CameraDevice, error: Int) = lost(camera, "error $error")

        override fun onClosed(camera: CameraDevice) {
            if (closed && device == null) finish()
        }
    }

    /** The OS took the camera (another app, the app in the background, the camera service). */
    private fun lost(camera: CameraDevice, why: String) {
        camera.close()
        if (device === camera || device == null) {
            device = null
            closeSession()
        }
        opening?.let {
            opening = null
            it.resumeWithException(RtcError.Failed("camera ${camera.id}: $why"))
            return
        }
        if (closed) return
        val now = android.os.SystemClock.elapsedRealtime()
        losses.removeAll { now - it > 30_000 }
        losses += now
        if (losses.size > 5) return ended("camera ${camera.id} keeps failing ($why)")
        Log.w("camera ${camera.id} $why: paused until it is free again")
        paused = true
    }

    private val availability = object : CameraManager.AvailabilityCallback() {
        override fun onCameraAvailable(cameraId: String) {
            if (!paused || closed || device != null || cameraId != spec.id) return
            paused = false
            Log.i("camera $cameraId is free again: reopening")
            try {
                openDevice()
            } catch (e: RtcError) {
                ended("the camera could not be reopened: ${e.message}")
            }
        }
    }

    private fun ended(reason: String) {
        if (closed) return
        Log.e("camera track ended: $reason")
        val callback = onEnded
        Core.main.post { callback?.invoke(reason) }
    }

    // ---- the encoder ----

    /** false = no encoder (the track ended). */
    private fun ensureEncoder(): Boolean {
        if (encoder != null) return true
        return try {
            encoder = VideoEncoder.open(encodeSize.width, encodeSize.height, spec.fps, bitrate, handler, encoderListener)
            parameterSets = null
            true
        } catch (e: Exception) {
            ended("no encoder: ${e.message}")
            false
        }
    }

    private fun recreateEncoder(size: Size) {
        encodeSize = size
        encoder?.let { old -> encoder = null; retire { old.release() } }
        if (device != null && ensureEncoder()) rebuildSession()
    }

    private val encoderListener = object : VideoEncoder.Listener {
        override fun onConfig(encoder: VideoEncoder, parameterSets: ByteArray) {
            if (encoder === this@CameraPipeline.encoder) this@CameraPipeline.parameterSets = parameterSets
        }

        override fun onFrame(encoder: VideoEncoder, buffer: ByteBuffer, info: MediaCodec.BufferInfo) {
            if (encoder !== this@CameraPipeline.encoder) return // a retired one's last frames
            send(encoder, buffer, info)
        }

        override fun onError(encoder: VideoEncoder, error: Exception) {
            if (encoder !== this@CameraPipeline.encoder) return
            Log.w("encoder error", error)
            if (++encoderFailures > 3) return ended("the encoder keeps failing: ${error.message}")
            recreateEncoder(encodeSize)
        }
    }

    private fun send(encoder: VideoEncoder, buffer: ByteBuffer, info: MediaCodec.BufferInfo) {
        val keyframe = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
        var data = buffer
        var offset = info.offset
        var length = info.size
        if (keyframe && !H264.hasParameterSets(buffer, offset, length)) {
            // A keyframe always goes WITH its SPS and PPS (the core refuses it otherwise).
            val sets = parameterSets ?: return encoder.requestKeyframe()
            data = prepend(sets, buffer, offset, length)
            offset = 0
            length = sets.size + info.size
        }
        encoded.incrementAndGet()
        if (keyframe) keyframesOut.incrementAndGet()
        val rotation = rotation()
        lastRotation = rotation
        synchronized(sourceLock) {
            val h = source
            if (h != 0L) {
                Native.sourceSend(h, data, offset, length, info.presentationTimeUs, keyframe, rotation)
                if (takers > 0) sent.incrementAndGet()
            }
        }
    }

    private fun prepend(sets: ByteArray, buffer: ByteBuffer, offset: Int, length: Int): ByteBuffer {
        val size = sets.size + length
        val out = scratch?.takeIf { it.capacity() >= size } ?: ByteBuffer.allocateDirect(size + size / 2).also { scratch = it }
        out.clear()
        out.put(sets)
        val view = buffer.duplicate()
        view.limit(offset + length)
        view.position(offset)
        out.put(view)
        return out
    }

    /** Degrees clockwise that show the sensor's picture upright on this display. */
    private fun rotation(): Int {
        val sensor = spec.sensorOrientation
        val display = displayDegrees
        return if (spec.facing == Facing.USER) (sensor + display) % 360 else (sensor - display + 360) % 360
    }

    // ---- the core's targets (core threads → here) ----

    fun onTarget(bitrate: Int, fps: Int, height: Int) {
        lastTarget = intArrayOf(bitrate, fps, height)
        handler.post { applyTarget(bitrate, fps, height) }
    }

    fun onKeyframeRequested() {
        keyframesAsked.incrementAndGet()
        handler.post { encoder?.requestKeyframe() }
    }

    private fun applyTarget(bitrate: Int, fps: Int, height: Int) {
        if (closed || !this::spec.isInitialized) return
        this.bitrate = bitrate
        encoder?.setBitrate(bitrate)
        if (fps != targetFps) {
            targetFps = fps
            attempt?.session?.let { startRepeating(it) }
        }
        targetHeight = height
        val size = encodeSizeFor(height)
        handler.removeCallbacks(resize)
        if (size != encodeSize) {
            // A size change costs a new session (a hitch in the preview): only once it held for a second.
            wantedSize = size
            handler.postDelayed(resize, 1000)
        }
    }

    private val resize = Runnable {
        val size = wantedSize ?: return@Runnable
        wantedSize = null
        if (size != encodeSize && !closed) {
            Log.i("encoder resize: $encodeSize -> $size")
            recreateEncoder(size)
        }
    }

    // ---- the session ----

    /** One createCaptureSession: what was retired while it ran is released when it closes. */
    private inner class SessionAttempt(val outputs: List<Surface>) : CameraCaptureSession.StateCallback() {
        var session: CameraCaptureSession? = null
        private val retired = ArrayList<() -> Unit>()
        private var over = false

        init {
            attempts += this
        }

        fun retire(release: () -> Unit) {
            if (over) release() else retired += release
        }

        override fun onConfigured(session: CameraCaptureSession) {
            this.session = session
            if (attempt !== this || closed) {
                session.close()
                return
            }
            startRepeating(session)
            // A new session is a new start for whoever decodes: a keyframe with its parameter sets.
            encoder?.requestKeyframe()
        }

        override fun onConfigureFailed(session: CameraCaptureSession) {
            Log.w("camera session not configured (${outputs.size} outputs)")
            done()
            if (attempt === this) attempt = null
        }

        override fun onClosed(session: CameraCaptureSession) = done()

        fun done() {
            if (over) return
            over = true
            attempts -= this
            retired.forEach { runCatching(it) }
            retired.clear()
        }
    }

    /** Released once nothing draws into it any more: when the session in use now closes. */
    private fun retire(release: () -> Unit) {
        val current = attempt
        if (current == null) runCatching(release) else current.retire(release)
    }

    private fun closeSession() {
        val previous = attempt ?: return
        attempt = null
        previous.session?.let { s ->
            runCatching { s.stopRepeating() }
            runCatching { s.close() }
        }
        // One still configuring closes itself in onConfigured; one already gone released its own.
        if (previous.session == null) handler.postDelayed({ previous.done() }, 2000)
    }

    private fun rebuildSession() {
        val dev = device ?: return
        val enc = encoder ?: return
        val previous = attempt
        val outputs = ArrayList<Surface>(2)
        outputs += enc.surface
        preview?.let { p ->
            p.texture.setDefaultBufferSize(spec.preview.width, spec.preview.height)
            outputs += p.surface
        }
        val next = SessionAttempt(outputs)
        attempt = next
        previous?.session?.let { s ->
            runCatching { s.stopRepeating() }
            runCatching { s.close() }
        }
        try {
            @Suppress("DEPRECATION") // the List<Surface> form exists on every API level the library runs on
            dev.createCaptureSession(outputs, next, handler)
        } catch (e: Exception) {
            Log.w("camera session", e)
            attempt = null
            next.done()
        }
    }

    private fun startRepeating(session: CameraCaptureSession) {
        val dev = device ?: return
        val current = attempt ?: return
        try {
            val request = dev.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
                current.outputs.forEach { addTarget(it) }
                set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                fpsRange()?.let { set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
            }
            session.setRepeatingRequest(request.build(), null, handler)
        } catch (e: Exception) {
            Log.w("camera request", e)
        }
    }

    /** A fixed range at the rate wanted where the camera has one, else the closest above it. */
    private fun fpsRange(): Range<Int>? {
        val want = if (targetFps > 0) min(spec.fps, targetFps) else spec.fps
        val ranges = spec.fpsRanges
        return ranges.filter { it.upper == want }.maxByOrNull { it.lower }
            ?: ranges.filter { it.upper >= want }.minWithOrNull(compareBy<Range<Int>>({ it.upper }, { -it.lower }))
            ?: ranges.maxByOrNull { it.upper }
    }

    // ---- the preview (a local RtcVideoView) ----

    private fun geometry() = PreviewGeometry(spec.preview.width, spec.preview.height, spec.sensorOrientation, spec.facing)

    /** The view's texture becomes a second output of the session. The last view to attach wins. */
    fun attachPreview(texture: SurfaceTexture, geometry: (PreviewGeometry) -> Unit) {
        handler.post {
            if (closed) return@post
            preview?.let { old -> retire { old.surface.release() } }
            preview = Preview(texture, Surface(texture), geometry)
            geometry(geometry())
            rebuildSession()
        }
    }

    /** The view lets go of its texture: released here once the camera no longer draws into it. */
    fun detachPreview(texture: SurfaceTexture) {
        val posted = handler.post {
            val p = preview
            if (p != null && p.texture === texture) {
                preview = null
                retire {
                    p.surface.release()
                    texture.release()
                }
                if (!closed) rebuildSession()
            } else {
                retire { texture.release() }
            }
        }
        if (!posted) texture.release() // the thread is gone: nothing draws into it
    }

    // ---- the display ----

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) {
            if (displayId == Display.DEFAULT_DISPLAY) readDisplay()
        }
    }

    private fun readDisplay() {
        displayDegrees = when (displays.getDisplay(Display.DEFAULT_DISPLAY)?.rotation) {
            Surface.ROTATION_90 -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 0
        }
    }

    private companion object {
        const val START_BITRATE = 1_000_000
        const val DEFAULT_MAX_BITRATE = 1_500_000
    }
}
