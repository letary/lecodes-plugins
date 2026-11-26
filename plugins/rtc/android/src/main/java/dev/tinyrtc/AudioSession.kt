package dev.tinyrtc

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build

/** Where the call's sound plays. */
enum class AudioOutput {
    /** The phone's receiver — or a headset (wired, USB, Bluetooth) while one is connected. */
    EARPIECE,
    SPEAKER,
}

/**
 * The ONE place this half configures the OS's audio: the mode (IN_COMMUNICATION while a call has
 * sound), the audio focus, the route (earpiece / speaker), what the voice path is made of (the
 * microphone's source, the playback's attributes) and the voice-processing effects on the
 * microphone. Nothing else in the library touches AudioManager.
 *
 * An app with its own audio sets [managedByApp] (before its first connection): from then on the
 * mode, the focus and the route are left alone — [onActiveChanged] says when the call's sound
 * starts and stops, and the app configures AudioManager itself. The microphone and the playback
 * still run (they are the call), with the source, attributes and effects below.
 */
class AudioSession internal constructor(context: Context) {
    private val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    /** true = the app configures the mode, the focus and the route; nothing here touches them. */
    @Volatile
    var managedByApp: Boolean = false

    /** The route while a call has sound. Set on the main thread; applied at once when active. */
    @Volatile
    var output: AudioOutput = AudioOutput.EARPIECE
        set(value) {
            Core.checkMain("audioOutput")
            if (field == value) return
            field = value
            routeChanged?.invoke()
        }

    /** The platform's voice-processing effects on the microphone, attached when the device has them. */
    @Volatile var echoCanceler: Boolean = true
    @Volatile var noiseSuppressor: Boolean = true
    @Volatile var gainControl: Boolean = true

    /** Main thread: the call's sound started (true) or stopped (false). */
    var onActiveChanged: ((Boolean) -> Unit)? = null

    /** Main thread: whether the call's sound runs now. */
    var isActive: Boolean = false
        private set

    // ---- what the voice path is made of ----

    internal val recordSource = MediaRecorder.AudioSource.VOICE_COMMUNICATION

    internal val playbackAttributes: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    /** Set by AudioDevice: re-route on its thread. */
    internal var routeChanged: (() -> Unit)? = null

    // ---- the audio thread (AudioDevice) ----

    private var savedMode = AudioManager.MODE_NORMAL
    private var savedSpeaker = false
    private var focusRequest: AudioFocusRequest? = null
    private var touched = false
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        // A phone call or another app's voice takes the focus: the OS silences our capture and
        // ducks / pauses our playout itself; the call goes on and comes back with the focus.
        Log.i("audio focus: $change")
    }

    internal fun activate() {
        if (!managedByApp) {
            touched = true
            savedMode = manager.mode
            @Suppress("DEPRECATION")
            savedSpeaker = manager.isSpeakerphoneOn
            requestFocus()
            manager.mode = AudioManager.MODE_IN_COMMUNICATION
            route()
        }
        Core.main.post {
            isActive = true
            onActiveChanged?.invoke(true)
        }
    }

    internal fun deactivate() {
        if (touched) {
            touched = false
            if (Build.VERSION.SDK_INT >= 31) {
                manager.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                manager.isSpeakerphoneOn = savedSpeaker
            }
            manager.mode = savedMode
            abandonFocus()
        }
        Core.main.post {
            isActive = false
            onActiveChanged?.invoke(false)
        }
    }

    /** Applies [output]; also after a headset came or went. */
    internal fun route() {
        if (!touched || managedByApp) return
        val want = output
        if (Build.VERSION.SDK_INT >= 31) {
            val devices = manager.availableCommunicationDevices
            val pick = when (want) {
                AudioOutput.SPEAKER -> devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                AudioOutput.EARPIECE -> devices.firstOrNull { it.type in HEADSETS }
                    ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
            }
            val ok = pick != null && manager.setCommunicationDevice(pick)
            if (!ok) manager.clearCommunicationDevice()
            Log.i("audio route: $want -> ${pick?.let { typeName(it.type) } ?: "default"}${if (pick != null && !ok) " (refused)" else ""}")
        } else {
            @Suppress("DEPRECATION")
            manager.isSpeakerphoneOn = want == AudioOutput.SPEAKER
        }
    }

    /** The voice-processing effects the device has, attached to a capture session. */
    internal fun attachEffects(sessionId: Int): List<AudioEffect> {
        val effects = ArrayList<AudioEffect>(3)
        fun add(name: String, available: Boolean, make: () -> AudioEffect?) {
            if (!available) return
            try {
                val effect = make() ?: return
                effect.enabled = true
                effects += effect
            } catch (t: Throwable) {
                Log.w("audio effect $name not attached", t)
            }
        }
        add("echo canceler", echoCanceler && AcousticEchoCanceler.isAvailable()) { AcousticEchoCanceler.create(sessionId) }
        add("noise suppressor", noiseSuppressor && NoiseSuppressor.isAvailable()) { NoiseSuppressor.create(sessionId) }
        add("gain control", gainControl && AutomaticGainControl.isAvailable()) { AutomaticGainControl.create(sessionId) }
        return effects
    }

    private fun requestFocus() {
        if (Build.VERSION.SDK_INT >= 26) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(playbackAttributes)
                .setOnAudioFocusChangeListener(focusListener)
                .build()
            focusRequest = request
            manager.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            manager.requestAudioFocus(focusListener, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN)
        }
    }

    private fun abandonFocus() {
        if (Build.VERSION.SDK_INT >= 26) {
            focusRequest?.let { manager.abandonAudioFocusRequest(it) }
            focusRequest = null
        } else {
            @Suppress("DEPRECATION")
            manager.abandonAudioFocus(focusListener)
        }
    }

    private companion object {
        /** Only read on API 31+ (setCommunicationDevice), where every one of these exists. */
        val HEADSETS = buildSet {
            add(AudioDeviceInfo.TYPE_WIRED_HEADSET)
            add(AudioDeviceInfo.TYPE_WIRED_HEADPHONES)
            add(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
            if (Build.VERSION.SDK_INT >= 26) add(AudioDeviceInfo.TYPE_USB_HEADSET)
            if (Build.VERSION.SDK_INT >= 28) add(AudioDeviceInfo.TYPE_HEARING_AID)
            if (Build.VERSION.SDK_INT >= 31) add(AudioDeviceInfo.TYPE_BLE_HEADSET)
        }

        fun typeName(type: Int) = when (type) {
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
            else -> "type $type"
        }
    }
}
