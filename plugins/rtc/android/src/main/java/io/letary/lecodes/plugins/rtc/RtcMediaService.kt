//
//  RtcMediaService.kt — lecodes-plugins/rtc
//
//  The "rtcMedia" service: capture, the device list, the audio route. One session for the app.
//
//  getUserMedia asks the permissions it needs BY HAND, through the host's Permissions (which ones
//  depends on the constraints, so the contract cannot tag it), then opens the microphone first and
//  the camera second; a camera that fails after the microphone opened stops the microphone. The
//  tracks it opens go into the registry (RtcTracks) as "audioN" / "videoN", where the connections
//  and the pictures find them, and belong to this session: its close stops and forgets them.
//
//  tinyrtc keeps ONE device-change callback (RtcEngine.onDevicesChanged): this session owns it,
//  from its first call (the engine is not started before), and lets it go when it closes.
//
//  The microphone's three flags are tinyrtc's AudioSession's, process-wide: the last getUserMedia's
//  flags apply, from the next time the microphone starts (tinyrtc attaches the effects when its
//  capture starts).
//

package io.letary.lecodes.plugins.rtc

import dev.tinyrtc.CameraOptions
import dev.tinyrtc.LocalAudioTrack
import dev.tinyrtc.LocalVideoTrack
import dev.tinyrtc.RtcDevice
import dev.tinyrtc.RtcEngine
import dev.tinyrtc.RtcError
import io.letary.lecodes.services.Permissions
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import dev.tinyrtc.AudioOutput as TinyAudioOutput

internal class RtcMediaService(
    private val shared: RtcShared,
    private val events: RtcMediaEvents,
) : RtcMediaPlugin {

    private val tracks get() = shared.tracks
    private val calls = SessionCalls(RtcMediaCode.FAILED, ::mediaCode)

    /** The ids of the tracks this session opened: stopped and forgotten with it. */
    private val mine = LinkedHashSet<String>()

    /** What this session put into tinyrtc's one device-change slot; null while it holds none. */
    private var deviceSlot: (() -> Unit)? = null

    init {
        // A session made after an earlier one started the engine (a new world) hears the devices at once.
        shared.engineIfStarted?.let(::takeDeviceSlot)
    }

    /** The engine, started if need be; this session takes the device slot with it. */
    private fun rtc(): RtcEngine = shared.rtc().also(::takeDeviceSlot)

    private fun takeDeviceSlot(rtc: RtcEngine) {
        if (deviceSlot != null || calls.isClosed) return
        val slot = { events.deviceChange() }
        deviceSlot = slot
        rtc.onDevicesChanged = slot
    }

    override fun close() {
        calls.close()
        val slot = deviceSlot
        deviceSlot = null
        shared.engineIfStarted?.let { rtc -> if (slot != null && rtc.onDevicesChanged === slot) rtc.onDevicesChanged = null }
        for (id in mine.toList()) stop(id)
        mine.clear()
    }

    // ---- capture ------------------------------------------------------------------------------

    override fun getUserMedia(constraints: MediaConstraints, reply: Reply<List<TrackInfo>, RtcMediaCode>) {
        val audio = constraints.audio
        val video = constraints.video
        if (audio == null && video == null) return reply.fail("getUserMedia: neither audio nor video was asked for")
        val kinds = buildList {
            if (audio != null) add(Permissions.Kind.MICROPHONE)
            if (video != null) add(Permissions.Kind.CAMERA)
        }
        shared.host.permissions.ensure(kinds) { granted ->
            if (!granted) reply.reject(RtcMediaCode.DENIED)
            else calls.launch(reply) { capture(audio, video) }
        }
    }

    /**
     * Opens what was asked for and registers it. Not cancellable: a device tinyrtc opened is never
     * dropped on the way — when the session closed meanwhile, what was opened is stopped here.
     */
    private suspend fun capture(audio: AudioConstraints?, video: VideoConstraints?): List<TrackInfo> = withContext(NonCancellable) {
        val rtc = rtc()
        var microphone: LocalAudioTrack? = null
        if (audio != null) {
            rtc.audioSession.echoCanceler = audio.echoCancellation ?: true
            rtc.audioSession.noiseSuppressor = audio.noiseSuppression ?: true
            rtc.audioSession.gainControl = audio.autoGainControl ?: true
            microphone = rtc.openMicrophone()
        }
        val options = video?.let { cameraOptions(it, CameraOptions()) }
        val camera: LocalVideoTrack? = if (options == null) null else try {
            rtc.openCamera(options)
        } catch (t: Throwable) {
            microphone?.stop()
            throw t
        }
        if (calls.isClosed) {
            microphone?.stop()
            camera?.stop()
            throw RtcError.Closed("getUserMedia: the session closed")
        }
        val devices = runCatching { rtc.devices() }.getOrDefault(emptyList())
        val out = ArrayList<TrackInfo>(2)
        if (microphone != null) {
            val label = devices.firstOrNull { it.kind == RtcDevice.Kind.MICROPHONE }?.label ?: "microphone"
            val id = tracks.localId(MediaKind.AUDIO)
            tracks.add(RtcTracks.LocalAudio(id, microphone, label))
            mine += id
            microphone.onEnded = { ended(id) }
            out += TrackInfo(id = id, kind = MediaKind.AUDIO, label = label, enabled = microphone.isEnabled)
        }
        if (camera != null && options != null) {
            val deviceId = camera.settings.deviceId
            val label = devices.firstOrNull { it.kind == RtcDevice.Kind.CAMERA && it.id == deviceId }?.label ?: "camera $deviceId"
            val id = tracks.localId(MediaKind.VIDEO)
            tracks.add(RtcTracks.LocalVideo(id, camera, label, options))
            mine += id
            camera.onEnded = { ended(id) }
            out += TrackInfo(id = id, kind = MediaKind.VIDEO, label = label, enabled = camera.isEnabled)
        }
        out
    }

    /** The OS ended a track (tinyrtc stopped it already): its id goes, the app hears it. */
    private fun ended(id: String) {
        mine.remove(id)
        if (tracks.forget(id) != null) events.trackEnded(id)
    }

    /** A local track ends: the device is released, every connection stops sending it, the id goes. */
    private fun stop(id: String) {
        mine.remove(id)
        when (val entry = tracks.forget(id)) {
            is RtcTracks.LocalAudio -> {
                entry.track.onEnded = null
                entry.track.stop()
            }
            is RtcTracks.LocalVideo -> {
                entry.track.onEnded = null
                entry.track.stop()
            }
            else -> {}
        }
    }

    // ---- the devices --------------------------------------------------------------------------

    override fun enumerateDevices(reply: Reply<List<DeviceInfo>, RtcMediaCode>) = calls.now(reply) {
        rtc().devices().map { d ->
            when (d.kind) {
                RtcDevice.Kind.CAMERA -> DeviceInfo(deviceId = d.id, kind = DeviceKind.VIDEOINPUT, label = d.label, facing = d.facing?.wire())
                RtcDevice.Kind.MICROPHONE -> DeviceInfo(deviceId = d.id, kind = DeviceKind.AUDIOINPUT, label = d.label)
                RtcDevice.Kind.AUDIO_OUTPUT -> DeviceInfo(deviceId = d.id, kind = DeviceKind.AUDIOOUTPUT, label = d.label)
            }
        }
    }

    override fun setAudioOutput(output: AudioOutput, reply: Reply<Unit, RtcMediaCode>) = calls.now(reply) {
        rtc().audioOutput = when (output) {
            AudioOutput.EARPIECE -> TinyAudioOutput.EARPIECE
            AudioOutput.SPEAKER -> TinyAudioOutput.SPEAKER
        }
    }

    // ---- the tracks ---------------------------------------------------------------------------

    override fun setTrackEnabled(trackId: String, enabled: Boolean, reply: Reply<Unit, RtcMediaCode>) {
        when (val entry = tracks.local(trackId)) {
            is RtcTracks.LocalAudio -> entry.track.isEnabled = enabled
            is RtcTracks.LocalVideo -> entry.track.isEnabled = enabled
            else -> return reply.reject(RtcMediaCode.NOT_FOUND)
        }
        reply.resolve()
    }

    override fun applyConstraints(trackId: String, constraints: VideoConstraints, reply: Reply<Unit, RtcMediaCode>) {
        val entry = tracks.localVideo(trackId) ?: return reply.reject(RtcMediaCode.NOT_FOUND)
        val options = cameraOptions(constraints, entry.options)
        calls.launch(reply) {
            entry.track.apply(options)
            entry.options = options
        }
    }

    override fun getTrackSettings(trackId: String, reply: Reply<TrackSettings, RtcMediaCode>) {
        when (val entry = tracks.local(trackId)) {
            is RtcTracks.LocalVideo -> {
                val s = entry.track.settings
                reply.resolve(TrackSettings(deviceId = s.deviceId, facingMode = s.facing.wire(), width = s.width, height = s.height, frameRate = s.frameRate))
            }
            is RtcTracks.LocalAudio -> reply.resolve(TrackSettings())
            else -> reply.reject(RtcMediaCode.NOT_FOUND)
        }
    }

    override fun setMaxVideoBitrate(trackId: String, bitrate: Int, reply: Reply<Unit, RtcMediaCode>) {
        val entry = tracks.localVideo(trackId) ?: return reply.reject(RtcMediaCode.NOT_FOUND)
        // tinyrtc require()s a positive one; the contract has no code for it.
        if (bitrate <= 0) return reply.fail("setMaxVideoBitrate: the bitrate must be positive ($bitrate)")
        calls.launch(reply) { entry.track.setMaxBitrate(bitrate) }
    }

    override fun stopTrack(trackId: String, reply: Reply<Unit, RtcMediaCode>) {
        if (tracks.local(trackId) != null) stop(trackId)
        reply.resolve()
    }
}

/**
 * tinyrtc's full camera options from the contract's partial ones, over [base] (the defaults, or the
 * track's last options): what is given wins; a deviceId wins over facingMode, and a facingMode given
 * without a deviceId clears the one [base] had (the other camera is asked for by its side).
 */
private fun cameraOptions(c: VideoConstraints, base: CameraOptions): CameraOptions = CameraOptions(
    deviceId = when {
        c.deviceId != null -> c.deviceId
        c.facingMode != null -> null
        else -> base.deviceId
    },
    facing = c.facingMode?.tiny() ?: base.facing,
    width = c.width ?: base.width,
    height = c.height ?: base.height,
    frameRate = c.frameRate ?: base.frameRate,
)

private fun mediaCode(e: RtcError): RtcMediaCode = when (e) {
    is RtcError.Denied -> RtcMediaCode.DENIED
    is RtcError.NotFound -> RtcMediaCode.NOT_FOUND
    is RtcError.Failed, is RtcError.Closed -> RtcMediaCode.FAILED
}
