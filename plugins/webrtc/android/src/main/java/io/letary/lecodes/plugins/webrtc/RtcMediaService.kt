//
//  RtcMediaService.kt — lecodes-plugins/webrtc
//
//  The "rtcMedia" service: capture (the permissions asked on the first call that needs them — by
//  hand through the host's `Permissions`, since which ones depends on the constraints), the
//  device list, the audio route. One session for the app; the
//  tracks it makes live in RtcEngine's registry, where the connections and the views find them.
//

package io.letary.lecodes.plugins.webrtc

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.Permissions
import io.letary.lecodes.services.resolve
import org.webrtc.MediaConstraints as RtcMediaConstraints

class RtcMediaService(
    private val engine: LecodesEngine,
    private val context: Context,
    private val events: RtcMediaEvents,
) : RtcMediaPlugin {

    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<AudioDeviceInfo>) = events.deviceChange()
        override fun onAudioDevicesRemoved(removedDevices: Array<AudioDeviceInfo>) = events.deviceChange()
    }

    init {
        audioManager.registerAudioDeviceCallback(deviceCallback, RtcEngine.mainHandler)
    }

    override fun close() {
        audioManager.unregisterAudioDeviceCallback(deviceCallback)
    }

    // ── capture ──────────────────────────────────────────────────────────────

    override fun getUserMedia(constraints: MediaConstraints, reply: Reply<StreamInfo, RtcMediaCode>) {
        val wantsAudio = constraints.audio != null
        val wantsVideo = constraints.video != null
        if (!wantsAudio && !wantsVideo) return reply.fail("getUserMedia: audio or video must be requested")
        val kinds = ArrayList<Permissions.Kind>()
        if (wantsAudio) kinds.add(Permissions.Kind.MICROPHONE)
        if (wantsVideo) kinds.add(Permissions.Kind.CAMERA)
        engine.permissions.ensure(kinds) { granted ->
            if (!granted) reply.reject(RtcMediaCode.DENIED)
            else RtcEngine.mainHandler.post { capture(constraints, reply) }
        }
    }

    private fun capture(constraints: MediaConstraints, reply: Reply<StreamInfo, RtcMediaCode>) {
        val factory = RtcEngine.factory(context)
        val tracks = ArrayList<RtcTrack>()
        constraints.audio?.let { audio ->
            RtcEngine.configureAudio(context)
            val id = RtcEngine.allocate("audio")
            val source = factory.createAudioSource(RtcMediaConstraints().apply {
                mandatory.add(RtcMediaConstraints.KeyValuePair("googEchoCancellation", (audio.echoCancellation ?: true).toString()))
                mandatory.add(RtcMediaConstraints.KeyValuePair("googNoiseSuppression", (audio.noiseSuppression ?: true).toString()))
                mandatory.add(RtcMediaConstraints.KeyValuePair("googAutoGainControl", (audio.autoGainControl ?: true).toString()))
            })
            val track = factory.createAudioTrack(id, source)
            tracks.add(RtcTrack(id, track, remote = false, label = "Microphone", audioSource = source))
        }
        val finish = { ok: Boolean ->
            if (!ok) {
                tracks.forEach { it.capture?.stop(); it.audioSource?.dispose() }
                reply.reject(RtcMediaCode.NOT_FOUND)
            } else {
                tracks.forEach { RtcEngine.add(it) }
                reply.resolve(StreamInfo(RtcEngine.allocate("stream"), tracks.map { it.info }))
            }
        }
        val video = constraints.video ?: return finish(true)
        val id = RtcEngine.allocate("video")
        val source = factory.createVideoSource(false)
        val capture = RtcCapture(context, source)
        val name = capture.device(video) ?: run { source.dispose(); return finish(false) }
        val track = factory.createVideoTrack(id, source)
        tracks.add(RtcTrack(id, track, remote = false, label = name, capture = capture))
        capture.start(video) { started -> RtcEngine.mainHandler.post { finish(started) } }
    }

    // ── the devices ──────────────────────────────────────────────────────────

    override fun enumerateDevices(reply: Reply<List<DeviceInfo>, RtcMediaCode>) {
        val devices = ArrayList<DeviceInfo>()
        for (input in audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            devices.add(DeviceInfo(deviceId = input.id.toString(), kind = DeviceKind.AUDIOINPUT, label = input.productName.toString()))
        }
        val cameras = RtcEngine.cameraEnumerator(context)
        for (name in cameras.deviceNames) {
            devices.add(DeviceInfo(deviceId = name, kind = DeviceKind.VIDEOINPUT, label = name, facing = if (cameras.isFrontFacing(name)) FacingMode.USER else FacingMode.ENVIRONMENT))
        }
        devices.add(DeviceInfo(deviceId = "earpiece", kind = DeviceKind.AUDIOOUTPUT, label = "Earpiece"))
        devices.add(DeviceInfo(deviceId = "speaker", kind = DeviceKind.AUDIOOUTPUT, label = "Speaker"))
        reply.resolve(devices)
    }

    // ── the tracks ───────────────────────────────────────────────────────────

    override fun setTrackEnabled(trackId: String, enabled: Boolean, reply: Reply<Unit, RtcMediaCode>) {
        val track = RtcEngine.track(trackId) ?: return reply.reject(RtcMediaCode.NOT_FOUND)
        track.track.setEnabled(enabled)
        reply.resolve()
    }

    override fun applyConstraints(trackId: String, constraints: VideoConstraints, reply: Reply<Unit, RtcMediaCode>) {
        val capture = RtcEngine.track(trackId)?.capture ?: return reply.reject(RtcMediaCode.NOT_FOUND)
        capture.start(constraints) { ok -> if (ok) reply.resolve() else reply.reject(RtcMediaCode.FAILED) }
    }

    override fun getTrackSettings(trackId: String, reply: Reply<TrackSettings, RtcMediaCode>) {
        val track = RtcEngine.track(trackId) ?: return reply.reject(RtcMediaCode.NOT_FOUND)
        reply.resolve(track.capture?.settings ?: TrackSettings())
    }

    override fun stopTrack(trackId: String, reply: Reply<Unit, RtcMediaCode>) {
        RtcEngine.remove(trackId)?.let { track ->
            track.track.setEnabled(false)
            track.capture?.stop()
            track.audioSource?.dispose()
        }
        reply.resolve()
    }

    override fun setAudioOutput(output: AudioOutput, reply: Reply<Unit, RtcMediaCode>) {
        RtcEngine.setAudioOutput(context, output)
        reply.resolve()
    }
}
