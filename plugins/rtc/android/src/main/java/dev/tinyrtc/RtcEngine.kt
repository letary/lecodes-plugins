package dev.tinyrtc

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import java.lang.ref.WeakReference

/**
 * One per process ([getInstance]): the core's context, the audio (the microphone, the playout and
 * the [audioSession] that configures them), the watch on network changes, and every connection.
 * Public methods are called on the main thread; events arrive there.
 */
class RtcEngine private constructor(context: Context) {
    companion object {
        @SuppressLint("StaticFieldLeak") // it holds the application context only
        @Volatile
        private var instance: RtcEngine? = null

        @JvmStatic
        fun getInstance(context: Context): RtcEngine =
            instance ?: synchronized(this) {
                instance ?: RtcEngine(context.applicationContext).also { instance = it }
            }

        private const val LOG_WARN = 2
    }

    internal val app: Context = context

    /** The core's context: lives as long as the process (the audio threads use it without a lock). */
    internal val handle: Long = Native.contextCreate(LOG_WARN).also {
        check(it != 0L) { "tinyrtc: the core made no context" }
    }

    /** The one place the OS audio session is configured; an app with its own audio takes it over there. */
    val audioSession = AudioSession(app)

    internal val audio = AudioDevice(this)

    /** Main thread only. Weak: a connection the app dropped without close() closes itself. */
    private val connections = ArrayList<WeakReference<RtcConnection>>()

    /** Earpiece (or a connected headset) / speaker. */
    var audioOutput: AudioOutput
        get() = audioSession.output
        set(value) {
            audioSession.output = value
        }

    /** Main thread: a camera or an audio device came or went. */
    var onDevicesChanged: (() -> Unit)? = null

    val audioDiagnostics: AudioDiagnostics get() = audio.diagnostics()

    private val cameras = app.getSystemService(CameraManager::class.java)
    private val audioManager = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var cameraIds: Set<String> = emptySet()

    init {
        audioSession.routeChanged = { audio.reroute() }
        watchNetwork()
        watchDevices()
    }

    /** Cameras, microphones and audio outputs. */
    fun devices(): List<RtcDevice> {
        val out = ArrayList<RtcDevice>()
        try {
            for (id in cameras.cameraIdList) {
                val facing = facingOf(cameras.getCameraCharacteristics(id))
                out += RtcDevice(id, RtcDevice.Kind.CAMERA, "camera $id (${facing.name.lowercase()})", facing)
            }
        } catch (e: Exception) {
            Log.w("cameras not listed", e)
        }
        for (d in audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            out += RtcDevice(d.id.toString(), RtcDevice.Kind.MICROPHONE, "${d.productName} (type ${d.type})")
        }
        for (d in audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            out += RtcDevice(d.id.toString(), RtcDevice.Kind.AUDIO_OUTPUT, "${d.productName} (type ${d.type})")
        }
        return out
    }

    /**
     * Opens the camera (suspends until it runs) with its hardware encoder and the core's video
     * source. [RtcError.Denied] without the CAMERA permission, [RtcError.NotFound] when no camera
     * matches. Failed or cancelled at any point, it leaves nothing behind: no camera held, no thread,
     * no core source.
     */
    suspend fun openCamera(options: CameraOptions = CameraOptions()): LocalVideoTrack {
        Core.checkMain("openCamera")
        if (app.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            throw RtcError.Denied("the CAMERA permission is missing")
        }
        val pipe = CameraPipeline(this, options)
        pipe.start()
        return LocalVideoTrack(this, pipe)
    }

    /** [RtcError.Denied] without the RECORD_AUDIO permission. The microphone runs while a connection sends it. */
    @Suppress("RedundantSuspendModifier") // the same shape as openCamera, and as the Swift half
    suspend fun openMicrophone(): LocalAudioTrack {
        Core.checkMain("openMicrophone")
        if (app.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            throw RtcError.Denied("the RECORD_AUDIO permission is missing")
        }
        if (!app.packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE)) {
            throw RtcError.NotFound("this device has no microphone")
        }
        return LocalAudioTrack(this)
    }

    /** A connection to one peer. Its sound plays from now on (silence until the peer sends). */
    fun connect(config: RtcConfiguration = RtcConfiguration()): RtcConnection {
        Core.checkMain("connect")
        val connection = RtcConnection(this, config)
        connections += WeakReference(connection)
        tracksChanged()
        return connection
    }

    // ---- internal: what runs follows the tracks and the connections (main thread) ----

    private fun live(): List<RtcConnection> {
        connections.removeAll { ref -> ref.get().let { it == null || it.isClosed } }
        return connections.mapNotNull { it.get() }
    }

    /** After any change of a track or a connection: what each connection sends, and the sound. */
    internal fun tracksChanged() {
        val live = live()
        for (connection in live) connection.syncSends()
        audio.update(capture = live.any { it.sendsMicrophone }, playout = live.isNotEmpty())
    }

    internal fun microphoneFailed(reason: String) {
        for (track in live().mapNotNull { it.audioTrack }.distinct()) track.endedByOs(reason)
    }

    // ---- watches ----

    private fun watchNetwork() {
        val manager = app.getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            private var current: Network? = null

            override fun onAvailable(network: Network) {
                val before = current
                current = network
                if (before != null && before != network) changed()
            }

            override fun onLost(network: Network) {
                if (network == current) {
                    current = null
                    changed()
                }
            }

            private fun changed() {
                Log.i("network changed")
                Native.networkChanged(handle) // not SYNC: a message to each connection
            }
        }
        try {
            if (Build.VERSION.SDK_INT >= 24) {
                manager.registerDefaultNetworkCallback(callback)
            } else {
                val request = NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build()
                manager.registerNetworkCallback(request, callback)
            }
        } catch (e: Exception) {
            Log.w("no network watch", e)
        }
    }

    private fun watchDevices() {
        cameraIds = runCatching { cameras.cameraIdList.toSet() }.getOrDefault(emptySet())
        cameras.registerAvailabilityCallback(object : CameraManager.AvailabilityCallback() {
            override fun onCameraAvailable(cameraId: String) = camerasMaybeChanged()
            override fun onCameraUnavailable(cameraId: String) = camerasMaybeChanged()
        }, Core.main)
        audioManager.registerAudioDeviceCallback(object : AudioDeviceCallback() {
            private var first = true // the registration reports every device once

            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
                if (first) {
                    first = false
                    return
                }
                audioDevicesChanged()
            }

            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = audioDevicesChanged()
        }, Core.main)
    }

    private fun camerasMaybeChanged() {
        val ids = runCatching { cameras.cameraIdList.toSet() }.getOrDefault(cameraIds)
        if (ids != cameraIds) {
            cameraIds = ids
            onDevicesChanged?.invoke()
        }
    }

    private fun audioDevicesChanged() {
        audio.reroute()
        onDevicesChanged?.invoke()
    }
}

internal fun facingOf(characteristics: CameraCharacteristics): Facing =
    if (characteristics[CameraCharacteristics.LENS_FACING] == CameraCharacteristics.LENS_FACING_FRONT) Facing.USER
    else Facing.ENVIRONMENT
