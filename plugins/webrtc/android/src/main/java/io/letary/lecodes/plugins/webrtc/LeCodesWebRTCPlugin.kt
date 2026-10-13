//
//  LeCodesWebRTCPlugin.kt — lecodes-plugins/webrtc
//
//  The "rtcMedia" service (the devices), the "rtcPeerConnection" service (a session per
//  connection) and the "rtcVideo" view (a track drawn), over libwebrtc (Stream's build of
//  Google's library: io.getstream:stream-webrtc-android). The channels themselves — the calls,
//  their arguments, the events — are RtcMediaPlugin.gen.kt, generated from contract.d.ts.
//
//  What is shared by the three: ONE libwebrtc factory for the process and the registry of the
//  tracks by the id the wire names them with (RtcEngine). Signaling is the app's: nothing here
//  knows a room or a server.
//

package io.letary.lecodes.plugins.webrtc

import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.letary.lecodes.LecodesEngine
import org.webrtc.AudioSource
import org.webrtc.Camera1Enumerator
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraEnumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnectionFactory
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

object LeCodesWebRTCPlugin {

    const val PLUGIN_ID = "webrtc"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        RtcMediaChannel.register(engine) { _, events -> RtcMediaService(engine, appContext, events) }
        RtcPeerConnectionChannel.register(engine) { configuration, events -> RtcPeerConnectionSession(appContext, configuration, events) }
        RtcVideoChannel.register(engine) { params, events -> RtcVideoView(appContext, params, events) }
    }
}

/** A track the app holds, by the id the wire names it with: the libwebrtc track, and for a local
 *  video one its capture. A received track's wrapper may be TRANSIENT (libwebrtc disposes the
 *  wrappers of a transceiver list when the next list is asked for): it is refreshed by the session,
 *  and `stable` once the observer's own wrapper (never disposed) took its place. */
class RtcTrack(
    val id: String,
    track: MediaStreamTrack,
    val remote: Boolean,
    val label: String,
    /** A local video track's camera. */
    val capture: RtcCapture? = null,
    /** A local audio track's source, released with the track. */
    val audioSource: AudioSource? = null,
    @Volatile var stable: Boolean = !remote,
) {
    @Volatile var track: MediaStreamTrack = track
    val kind: MediaKind = if (track.kind() == MediaStreamTrack.VIDEO_TRACK_KIND) MediaKind.VIDEO else MediaKind.AUDIO

    /** Whether the wrapper still stands (a disposed one throws on every call). */
    val live: Boolean get() = runCatching { track.id(); true }.getOrDefault(false)

    val info: TrackInfo get() = TrackInfo(id = id, kind = kind, label = label, enabled = runCatching { track.enabled() }.getOrDefault(true), muted = null)
}

/** The one libwebrtc of the process, the tracks by id, the audio mode. Every member is safe from
 *  any thread: the calls arrive on the main thread, libwebrtc's observers on its own threads. */
object RtcEngine {
    private val tracks = ConcurrentHashMap<String, RtcTrack>()
    private val nextId = AtomicInteger(1)
    private var factoryOrNull: PeerConnectionFactory? = null
    private var eglOrNull: EglBase? = null
    val mainHandler = Handler(Looper.getMainLooper())

    val eglBase: EglBase get() = synchronized(this) { eglOrNull ?: EglBase.create().also { eglOrNull = it } }

    /** The factory, made on first use (libwebrtc initialised once for the process). */
    fun factory(context: Context): PeerConnectionFactory = synchronized(this) {
        factoryOrNull?.let { return it }
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions()
        )
        val egl = eglBase.eglBaseContext
        val audio = JavaAudioDeviceModule.builder(context.applicationContext)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule()
        val factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl))
            .setAudioDeviceModule(audio)
            .createPeerConnectionFactory()
        factoryOrNull = factory
        factory
    }

    fun allocate(prefix: String): String = "$prefix${nextId.getAndIncrement()}"

    fun track(id: String): RtcTrack? = tracks[id]
    fun add(track: RtcTrack) { tracks[track.id] = track }
    fun remove(id: String): RtcTrack? = tracks.remove(id)
    fun allTracks(): Collection<RtcTrack> = tracks.values

    /** The registry id of a libwebrtc track the app holds; null for one it never saw. */
    fun trackId(of: MediaStreamTrack): String? {
        val nativeId = runCatching { of.id() }.getOrNull() ?: return null
        return tracks.values.firstOrNull { it.track === of || runCatching { it.track.id() }.getOrNull() == nativeId }?.id
    }

    /** The audio mode of a call. Set at the first capture, never at registration. */
    fun configureAudio(context: Context) {
        val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (manager.mode != AudioManager.MODE_IN_COMMUNICATION) manager.mode = AudioManager.MODE_IN_COMMUNICATION
    }

    fun setAudioOutput(context: Context, output: AudioOutput) {
        configureAudio(context)
        val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        @Suppress("DEPRECATION")
        manager.isSpeakerphoneOn = output == AudioOutput.SPEAKER
    }

    fun cameraEnumerator(context: Context): CameraEnumerator =
        if (Camera2Enumerator.isSupported(context)) Camera2Enumerator(context) else Camera1Enumerator(true)
}

/** The camera behind a local video track: a capturer into a source, re-aimed by applyConstraints. */
class RtcCapture(private val context: Context, private val source: VideoSource) {
    private val enumerator = RtcEngine.cameraEnumerator(context)
    private val helper = SurfaceTextureHelper.create("LeCodesRtcCapture", RtcEngine.eglBase.eglBaseContext)
    private var capturer: CameraVideoCapturer? = null
    var deviceName: String? = null
        private set
    var width = 1280
        private set
    var height = 720
        private set
    var frameRate = 30.0
        private set
    var facing = FacingMode.USER
        private set

    fun device(constraints: VideoConstraints): String? {
        val names = enumerator.deviceNames
        constraints.deviceId?.let { id -> names.firstOrNull { it == id }?.let { return it } }
        val front = (constraints.facingMode ?: FacingMode.USER) == FacingMode.USER
        return names.firstOrNull { enumerator.isFrontFacing(it) == front } ?: names.firstOrNull()
    }

    /** Start (or restart) capturing for [constraints]; [done] tells whether the camera runs. */
    fun start(constraints: VideoConstraints, done: (Boolean) -> Unit) {
        val name = device(constraints) ?: return done(false)
        constraints.width?.let { width = it }
        constraints.height?.let { height = it }
        constraints.frameRate?.let { frameRate = it }
        val fps = frameRate.toInt().coerceAtLeast(1)
        val current = capturer
        if (current != null && name == deviceName) {
            current.changeCaptureFormat(width, height, fps)
            return done(true)
        }
        if (current != null) {
            // Another camera: libwebrtc swaps it under the same source, the track keeps sending.
            current.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
                override fun onCameraSwitchDone(isFrontCamera: Boolean) {
                    deviceName = name
                    facing = if (isFrontCamera) FacingMode.USER else FacingMode.ENVIRONMENT
                    current.changeCaptureFormat(width, height, fps)
                    done(true)
                }
                override fun onCameraSwitchError(errorDescription: String?) = done(false)
            }, name)
            return
        }
        val made = enumerator.createCapturer(name, null) ?: return done(false)
        made.initialize(helper, context, source.capturerObserver)
        try {
            made.startCapture(width, height, fps)
        } catch (e: Exception) {
            made.dispose()
            return done(false)
        }
        capturer = made
        deviceName = name
        facing = if (enumerator.isFrontFacing(name)) FacingMode.USER else FacingMode.ENVIRONMENT
        done(true)
    }

    fun stop() {
        capturer?.let {
            try { it.stopCapture() } catch (_: InterruptedException) {}
            it.dispose()
        }
        capturer = null
        helper.dispose()
        source.dispose()
    }

    val settings: TrackSettings
        get() = TrackSettings(deviceId = deviceName, facingMode = facing, width = width, height = height, frameRate = frameRate)
}
