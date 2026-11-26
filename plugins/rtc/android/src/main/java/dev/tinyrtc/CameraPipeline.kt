package dev.tinyrtc

import android.annotation.SuppressLint
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.display.DisplayManager
import android.media.MediaCodec
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
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
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine

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
 * The sending side of the camera. Camera2 opens the device; ONE capture session has two streams:
 * the encoder's input Surface (MediaCodec, H.264) and, while views show the track, the preview —
 * one view's SurfaceTexture, or the SurfaceTextures of several views sharing that one stream
 * ([rebuildSession]). The ISP scales each stream to its own size, so a smaller target is a smaller
 * encoder — recreated, with a new session (the first frame after is an IDR with its parameter
 * sets) — while the preview keeps the camera's format. No GL pass, no copy of a pixel.
 *
 * Frames are encoded as the sensor gives them; the degrees to show them upright (sensor
 * orientation, display rotation, facing) go with each frame to tinyrtc_video_source_send.
 *
 * A camera runs once its session is configured: [start] and [apply] return then. One that fails
 * before (it does not open, it errors, it takes no session, no encoder takes its size) fails
 * [start]; for [apply] the track goes back to the camera and format it had, and ends ([onEnded])
 * only when that one fails too ([openFailed]). Cancelled at any point, [start] leaves nothing
 * behind: [close] lets go of whatever exists by then, a camera still opening included.
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
        /** How many views may share the preview stream; 1 = no sharing (see [select]). */
        val views: Int,
    )

    /** A start() or an apply() waiting for its camera to run. */
    private class Opening(
        val cont: CancellableContinuation<Unit>,
        /** What an apply() goes back to when the camera it asked for fails; null for start(). */
        val back: Back?,
        /** Set while going back: what the apply() throws once the camera before runs again. */
        val failure: RtcError? = null,
    )

    /** A camera and format the track ran at (or was paused on). */
    private class Back(val options: CameraOptions, val spec: Spec, val paused: Boolean)

    private lateinit var spec: Spec
    /** The openCamera in use or under way; [device] once it opened. */
    private var current: DeviceOpen? = null
    private var device: CameraDevice? = null
    /** Every openCamera not over yet: the thread ends once each said onClosed ([CLOSE_TIMEOUT_MS] at most). */
    private val opens = ArrayList<DeviceOpen>()
    private var opening: Opening? = null
    /** The cameras no client has open, as the availability callback tells. */
    private val free = HashSet<String>()
    private var attempt: SessionAttempt? = null
    /** Every session not over yet (the current one and those still closing). */
    private val attempts = ArrayList<SessionAttempt>()
    /** Released in [finish]: what was let go of while the camera closed. */
    private val atFinish = ArrayList<() -> Unit>()
    private val losses = ArrayList<Long>()
    private var encoder: VideoEncoder? = null
    private var encodeSize = Size(0, 0)
    /** The views showing the track, in the order they came: the first ones get the preview. */
    private val previews = ArrayList<Preview>()
    /** Lowered when the camera refused a session with more previews; back up with each open. */
    private var previewCap = Int.MAX_VALUE
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

    private class Preview(val texture: SurfaceTexture, val surface: Surface, val onGeometry: (PreviewGeometry) -> Unit)

    fun diagnostics(): VideoTrackDiagnostics {
        val e = encoder
        val t = lastTarget
        return VideoTrackDiagnostics(
            encoded.get(), sent.get(), keyframesOut.get(), keyframesAsked.get(), e?.name ?: "",
            e?.width ?: 0, e?.height ?: 0, bitrate, t[0], t[1], t[2], lastRotation, paused,
        )
    }

    // ---- lifecycle (any thread → the video thread) ----

    /**
     * Creates the core's source, opens the camera; returns once it runs. Whatever stops it — an
     * error, the caller's cancellation at any point — closes everything made so far.
     */
    suspend fun start() {
        try {
            source = madeOn(Core.lane, { Native.sourceCreate(engine.handle, key) }) { made ->
                Core.scope.launch { Native.sourceDestroy(made) }
            }
            if (source == 0L) throw RtcError.Failed("the core made no video source")
            suspendCancellableCoroutine<Unit> { cont -> post(cont) { begin(options, cont) } }
        } catch (e: Throwable) {
            close() // the camera (open or still opening), the encoder, the source, the thread, the key
            throw e
        }
    }

    /**
     * Another camera, size or rate: the camera is reopened, the track and its source stay. When the
     * camera asked for fails, the track is back on the one it had before this throws ([openFailed]).
     * Cancelled, it stops waiting; the camera ends up on one or the other, nothing is left behind.
     */
    suspend fun apply(next: CameraOptions) {
        suspendCancellableCoroutine<Unit> { cont -> post(cont) { begin(next, cont) } }
    }

    /** Idempotent, any thread (also a finalizer). */
    fun close() {
        handler.post { shutdown() }
    }

    /** The most this camera's stream may take, bits per second; [pushLimits] gives it to the core. */
    @Volatile
    var maxBitrate: Int = DEFAULT_MAX_BITRATE

    /**
     * The ceiling the core's target stays under: the app's bitrate, the camera's format. Any thread;
     * on the lane, in order, reading the values when it runs (the last push has the last word).
     */
    fun pushLimits(): Job = Core.scope.launch {
        val h = source
        val s = settings
        if (h != 0L) Native.sourceSetLimits(h, maxBitrate, s.frameRate, min(s.width, s.height))
    }

    private inline fun post(cont: CancellableContinuation<Unit>, crossinline block: () -> Unit) {
        if (!handler.post { block() }) cont.resumeWithException(RtcError.Closed("the camera track is stopped"))
    }

    private fun begin(next: CameraOptions, cont: CancellableContinuation<Unit>) {
        if (closed) return cont.resumeWithException(RtcError.Closed("the camera track is stopped"))
        if (cont.isCancelled) return // nobody waits for it: the camera stays as it is
        val chosen = try {
            select(next)
        } catch (e: Exception) {
            // Nothing changed yet: the track goes on as it was.
            return cont.resumeWithException(e as? RtcError ?: RtcError.Failed("camera: ${e.message}"))
        }
        val first = !this::spec.isInitialized
        if (first) {
            readDisplay()
            displays.registerDisplayListener(displayListener, handler)
            manager.registerAvailabilityCallback(availability, handler)
        }
        // An apply() still waiting gives way; what to go back to stays the camera that last ran.
        val waiting = opening
        opening = null
        waiting?.let { it.cont.resumeWithException(it.failure ?: RtcError.Closed("another apply() came first")) }
        val back = if (first) null else waiting?.back ?: Back(options, spec, paused)
        switchTo(next, chosen, Opening(cont, back))
    }

    /** The camera in use goes (device, encoder, session); [chosen] opens for [o]. */
    private fun switchTo(next: CameraOptions, chosen: Spec, o: Opening) {
        releaseCamera()
        use(next, chosen)
        opening = o
        try {
            openDevice()
        } catch (e: RtcError) {
            openFailed(e)
        }
    }

    private fun use(next: CameraOptions, chosen: Spec) {
        options = next
        spec = chosen
        settings = VideoSettings(chosen.id, chosen.facing, chosen.capture.width, chosen.capture.height, chosen.fps)
        encodeSize = encodeSizeFor(targetHeight)
        paused = false
        val g = geometry()
        previews.forEach { it.onGeometry(g) }
    }

    private fun releaseCamera() {
        handler.removeCallbacks(resize)
        wantedSize = null
        encoder?.let { old -> encoder = null; retire { old.release() } } // once the session drawing into it closed
        closeSession()
        device?.close() // its onClosed takes it out of [opens]
        device = null
        current = null // one still opening closes its camera in onOpened
    }

    /**
     * The camera being opened for [opening] failed. start() throws [error] (and closes everything).
     * An apply() goes back to the camera and format the track had — reopened, or paused again if
     * the OS held it — and throws then; when that camera fails too, the track ends.
     */
    private fun openFailed(error: RtcError) {
        val o = opening ?: return
        opening = null
        releaseCamera()
        val back = o.back ?: return o.cont.resumeWithException(error)
        val failure = o.failure
        if (failure != null) {
            ended("camera ${spec.id} did not reopen after a failed apply(): ${error.message}")
            return o.cont.resumeWithException(
                failure.withMessage("${failure.message}; it did not reopen either (${error.message}): the track ended"),
            )
        }
        Log.w("apply(): ${error.message}: back to camera ${back.spec.id}")
        val thrown = error.withMessage("apply(): ${error.message}; the track is back on camera ${back.spec.id}")
        if (!back.paused) return switchTo(back.options, back.spec, Opening(o.cont, back, thrown))
        use(back.options, back.spec)
        paused = true
        o.cont.resumeWithException(thrown)
        if (spec.id in free) reopen()
    }

    /** The camera runs (its session is configured): the start() or apply() waiting returns. */
    private fun running() {
        val o = opening ?: return
        opening = null
        pushLimits()
        val failure = o.failure
        if (failure != null) o.cont.resumeWithException(failure) else o.cont.resume(Unit)
    }

    private fun shutdown() {
        if (closed) return
        closed = true
        opening?.let {
            opening = null
            it.cont.resumeWithException(RtcError.Closed("the camera track is stopped"))
        }
        Registry.remove(key)
        if (this::spec.isInitialized) {
            runCatching { displays.unregisterDisplayListener(displayListener) }
            runCatching { manager.unregisterAvailabilityCallback(availability) }
        }
        handler.removeCallbacks(resize)
        val enc = encoder
        encoder = null
        enc?.let { retire { it.release() } }
        previews.forEach { p -> retire { p.surface.release() } } // the texture is the view's until it lets go (detachPreview)
        previews.clear()
        closeSession()
        device = null
        current = null
        // Every camera open or still opening closes (one still opening, in its onOpened); the thread
        // ends when the last says onClosed. A camera service that never answers is given a while.
        opens.toList().forEach { it.camera?.close() }
        if (opens.isEmpty()) finish() else handler.postDelayed({ finish() }, CLOSE_TIMEOUT_MS)
    }

    /** After the camera stopped drawing into anything: the source goes (on the lane), then the thread. */
    private fun finish() {
        if (finished) return
        finished = true
        if (opens.isNotEmpty()) Log.w("camera ${opens.joinToString { it.id }} did not say it closed: the thread ends anyway")
        attempt = null
        attempts.toList().forEach { it.done() }
        atFinish.forEach { runCatching(it) }
        atFinish.clear()
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
        // LEGACY and LIMITED guarantee two streams of this kind (PRIV: the encoder, one preview),
        // never three: several views share the one preview stream (surface sharing, Android 8+),
        // up to what the platform shares ([rebuildSession]). A LEGACY camera keeps to one view.
        val level = chars[CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL]
        val sharing = Build.VERSION.SDK_INT >= 26 && level != null &&
            level != CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY
        return Spec(
            id = id,
            facing = facingOf(chars),
            sensorOrientation = chars[CameraCharacteristics.SENSOR_ORIENTATION] ?: 0,
            codecSizes = codecSizes,
            capture = capture,
            preview = preview,
            fpsRanges = ranges,
            fps = o.frameRate.coerceIn(1, top),
            views = if (sharing) Int.MAX_VALUE else 1,
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
        val open = DeviceOpen(spec.id)
        try {
            manager.openCamera(spec.id, open, handler)
        } catch (e: SecurityException) {
            throw RtcError.Denied("the CAMERA permission is missing")
        } catch (e: CameraAccessException) {
            throw RtcError.Failed("camera ${spec.id}: ${e.message}")
        } catch (e: IllegalArgumentException) {
            throw RtcError.NotFound("camera ${spec.id}: ${e.message}")
        }
        opens += open
        current = open
    }

    /** One openCamera, with callbacks of its own: a late callback of an older open is known as such. */
    private inner class DeviceOpen(val id: String) : CameraDevice.StateCallback() {
        var camera: CameraDevice? = null

        override fun onOpened(camera: CameraDevice) {
            this.camera = camera
            if (closed || this !== current) return camera.close()
            device = camera
            previewCap = Int.MAX_VALUE
            Log.i("camera ${camera.id} open: ${spec.capture} @${spec.fps}, sensor ${spec.sensorOrientation}°, ${spec.facing}")
            ensureEncoder()?.let { return failed(it) }
            rebuildSession()
        }

        override fun onDisconnected(camera: CameraDevice) = lost(this, camera, "disconnected")

        override fun onError(camera: CameraDevice, error: Int) = lost(this, camera, "error $error")

        override fun onClosed(camera: CameraDevice) {
            opens -= this
            if (closed && opens.isEmpty()) finish()
        }
    }

    /**
     * The camera of [open] errored or was taken (another app, the app in the background, the camera
     * service). While opening for a start() or an apply(), that open failed; else the track pauses
     * until the camera is free again.
     */
    private fun lost(open: DeviceOpen, camera: CameraDevice, why: String) {
        open.camera = camera
        camera.close()
        if (closed || open !== current) return
        device = null
        current = null
        closeSession()
        if (opening != null) return openFailed(RtcError.Failed("camera ${camera.id}: $why"))
        val now = SystemClock.elapsedRealtime()
        losses.removeAll { now - it > 30_000 }
        losses += now
        if (losses.size > 5) return ended("camera ${camera.id} keeps failing ($why)")
        Log.w("camera ${camera.id} $why: paused until it is free again")
        paused = true
    }

    private val availability = object : CameraManager.AvailabilityCallback() {
        override fun onCameraAvailable(cameraId: String) {
            free += cameraId
            if (paused && !closed && current == null && cameraId == spec.id) reopen()
        }

        override fun onCameraUnavailable(cameraId: String) {
            free -= cameraId
        }
    }

    private fun reopen() {
        paused = false
        Log.i("camera ${spec.id} is free again: reopening")
        try {
            openDevice()
        } catch (e: RtcError) {
            ended("the camera could not be reopened: ${e.message}")
        }
    }

    /** What cannot go on: an open under way fails ([openFailed]); a running camera ends the track. */
    private fun failed(reason: String) {
        if (opening != null) openFailed(RtcError.Failed(reason)) else ended(reason)
    }

    private fun ended(reason: String) {
        if (closed) return
        Log.e("camera track ended: $reason")
        val callback = onEnded
        Core.main.post { callback?.invoke(reason) }
    }

    // ---- the encoder ----

    /** null = an encoder runs; else why none could be made. */
    private fun ensureEncoder(): String? {
        if (encoder != null) return null
        return try {
            encoder = VideoEncoder.open(encodeSize.width, encodeSize.height, spec.fps, bitrate, handler, encoderListener)
            parameterSets = null
            null
        } catch (e: Exception) {
            "no encoder: ${e.message}"
        }
    }

    private fun recreateEncoder(size: Size) {
        encodeSize = size
        encoder?.let { old -> encoder = null; retire { old.release() } }
        if (device == null) return
        ensureEncoder()?.let { return failed(it) }
        rebuildSession()
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
            if (++encoderFailures > 3) return failed("the encoder keeps failing: ${error.message}")
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

    /**
     * One createCaptureSession, of the encoder and [showing] previews: what was retired while it ran
     * is released when it closes.
     */
    private inner class SessionAttempt(val outputs: List<Surface>, val showing: Int) : CameraCaptureSession.StateCallback() {
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
            running()
        }

        override fun onConfigureFailed(session: CameraCaptureSession) {
            Log.w("camera session not configured (${outputs.size} outputs)")
            done()
            if (attempt !== this) return
            attempt = null
            if (!closed && device != null) refused(this)
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
        when {
            current != null -> current.retire(release)
            closed && !finished -> atFinish += release // the camera is closing: once it closed
            else -> runCatching(release)
        }
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

    /** The camera took no session with these outputs: fewer previews, then none, then the camera failed. */
    private fun refused(a: SessionAttempt) {
        when {
            a.showing > 1 -> {
                previewCap = 1
                Log.w("camera ${spec.id}: no session with ${a.showing} views on its preview: the first shows it, the others stay black")
            }
            a.showing == 1 -> {
                previewCap = 0
                Log.w("camera ${spec.id}: no session with a preview (${spec.preview}) beside the encoder: the views stay black")
            }
            else -> return failed("camera ${spec.id}: no capture session for the encoder at $encodeSize")
        }
        rebuildSession()
    }

    /**
     * The encoder and the preview. Several views share ONE preview stream (surface sharing: their
     * SurfaceTextures have the same size, format and kind, the combination the platform guarantees;
     * the camera's buffers are shared, not copied) — as many as [Spec.views] and the platform allow
     * (OutputConfiguration.getMaxSharedSurfaceCount, 4 on current versions: addSurface refuses the
     * one past it). The views after those, in the order they came, stay black (logged) until one
     * before them lets go: a view that shows the camera never loses it to one that came later. A
     * session the camera refuses is made again with one preview, then none ([refused]).
     */
    private fun rebuildSession() {
        val dev = device ?: return
        val enc = encoder ?: return
        val previous = attempt
        val wanted = previews.take(min(previewCap, spec.views))
        for (p in wanted) p.texture.setDefaultBufferSize(spec.preview.width, spec.preview.height)
        var shown = wanted.take(1)
        var shared: OutputConfiguration? = null
        if (wanted.size > 1 && Build.VERSION.SDK_INT >= 26) {
            try {
                val config = OutputConfiguration(wanted[0].surface)
                config.enableSurfaceSharing()
                var n = 1
                while (n < wanted.size) {
                    try {
                        config.addSurface(wanted[n].surface)
                    } catch (e: IllegalArgumentException) {
                        break // more than the platform shares
                    }
                    n++
                }
                if (n > 1) {
                    shown = wanted.take(n)
                    shared = config
                }
            } catch (e: IllegalArgumentException) {
                Log.w("camera ${spec.id}: the views' surfaces are not shared", e)
            }
        }
        if (previews.size > shown.size) {
            Log.w("camera ${spec.id}: ${previews.size} views, its preview in ${shown.size}: the others stay black")
        }
        val outputs = ArrayList<Surface>(1 + shown.size)
        outputs += enc.surface
        shown.forEach { outputs += it.surface }
        val next = SessionAttempt(outputs, shown.size)
        attempt = next
        previous?.session?.let { s ->
            runCatching { s.stopRepeating() }
            runCatching { s.close() }
        }
        try {
            if (shared != null && Build.VERSION.SDK_INT >= 26) {
                @Suppress("DEPRECATION") // the Handler form (API 24), as the one below
                dev.createCaptureSessionByOutputConfigurations(listOf(OutputConfiguration(enc.surface), shared), next, handler)
            } else {
                @Suppress("DEPRECATION") // the List<Surface> form exists on every API level the library runs on
                dev.createCaptureSession(outputs, next, handler)
            }
        } catch (e: Exception) {
            Log.w("camera session", e)
            attempt = null
            next.done()
            // A disconnection says so through the device's callbacks, which come first; else it is a refusal.
            handler.post { if (attempt == null && device === dev && !closed) refused(next) }
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

    // ---- the preview (local RtcVideoViews) ----

    private fun geometry() = PreviewGeometry(spec.preview.width, spec.preview.height, spec.sensorOrientation, spec.facing)

    /**
     * The view's texture shows the camera's preview, beside the views already there when the camera
     * shares it ([rebuildSession]); past that, it stays black and the views before it keep theirs.
     */
    fun attachPreview(texture: SurfaceTexture, onGeometry: (PreviewGeometry) -> Unit) {
        handler.post {
            if (closed) return@post
            previews += Preview(texture, Surface(texture), onGeometry)
            if (!this::spec.isInitialized) return@post
            onGeometry(geometry())
            val showing = attempt?.showing
            if (previews.size > min(previewCap, spec.views) || (showing != null && showing < previews.size - 1)) {
                // Past what the camera shares (views before it are black already): it stays black,
                // and the session of the views that show the camera is left alone.
                Log.w("camera ${spec.id}: ${previews.size} views, its preview in ${showing ?: 0}: the others stay black")
                return@post
            }
            rebuildSession()
        }
    }

    /** The view lets go of its texture: released here once the camera no longer draws into it. */
    fun detachPreview(texture: SurfaceTexture) {
        val posted = handler.post {
            val p = previews.firstOrNull { it.texture === texture }
                ?: return@post retire { texture.release() }
            previews -= p
            val release = {
                p.surface.release()
                texture.release()
            }
            // Released when the last session that drew into it is over; a black view's at once.
            val drawnBy = attempts.lastOrNull { p.surface in it.outputs } ?: return@post release()
            drawnBy.retire(release)
            if (drawnBy === attempt && !closed) rebuildSession()
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
        /** How long a closing pipeline waits for its cameras' onClosed before its thread ends anyway. */
        const val CLOSE_TIMEOUT_MS = 5000L
    }
}
