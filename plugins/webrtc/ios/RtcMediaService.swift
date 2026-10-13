//
//  RtcMediaService.swift — lecodes-plugins/webrtc
//
//  The "rtcMedia" service: capture (the permissions asked on the first call that needs them — by
//  hand through the host's `Permissions`, since which ones depends on the constraints), the
//  device list, the audio route. One session for the app; the tracks it makes live in RtcEngine's
//  registry, where the connections and the views find them.
//

import AVFoundation
import Foundation
import WebRTC
import LeCodes

final class RtcMediaService: RtcMediaPlugin {

    private let events: RtcMediaEvents
    private let permissions: Permissions
    private let engine = RtcEngine.shared
    private var routeObserver: NSObjectProtocol?

    init(_ permissions: Permissions, _ events: RtcMediaEvents) {
        self.events = events
        self.permissions = permissions
        routeObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [events] note in
            guard let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt else { return }
            if reason == AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue || reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                events.deviceChange()
            }
        }
    }

    func close() {
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
        routeObserver = nil
    }

    // MARK: - capture

    func getUserMedia(_ constraints: MediaConstraints, _ reply: Reply<StreamInfo, RtcMediaCode>) {
        let wantsAudio = constraints.audio != nil
        let wantsVideo = constraints.video != nil
        guard wantsAudio || wantsVideo else { return reply.fail("getUserMedia: audio or video must be requested") }
        var kinds: [PermissionKind] = []
        if wantsAudio { kinds.append(.microphone) }
        if wantsVideo { kinds.append(.camera) }
        permissions.ensure(kinds) { granted in
            guard granted else { return reply.reject(.denied) }
            self.capture(constraints, reply)
        }
    }

    private func capture(_ constraints: MediaConstraints, _ reply: Reply<StreamInfo, RtcMediaCode>) {
        var tracks: [RtcTrack] = []
        if constraints.audio != nil {
            engine.configureAudioSession()
            let id = engine.allocate("audio")
            let source = engine.factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
            let track = engine.factory.audioTrack(with: source, trackId: id)
            let label = AVAudioSession.sharedInstance().currentRoute.inputs.first?.portName ?? "Microphone"
            tracks.append(RtcTrack(id: id, track: track, remote: false, label: label))
        }
        let finish = { (ok: Bool) in
            guard ok else {
                for t in tracks { t.capture?.stop() }
                return reply.reject(.notFound)
            }
            for t in tracks { self.engine.add(t) }
            reply.resolve(StreamInfo(id: self.engine.allocate("stream"), tracks: tracks.map { $0.info }))
        }
        guard let video = constraints.video else { return finish(true) }
        guard let device = RtcCapture.device(for: video) else { return finish(false) }
        let id = engine.allocate("video")
        let source = engine.factory.videoSource()
        let capture = RtcCapture(source: source)
        let track = engine.factory.videoTrack(with: source, trackId: id)
        tracks.append(RtcTrack(id: id, track: track, remote: false, label: device.localizedName, capture: capture))
        capture.start(video) { started in DispatchQueue.main.async { finish(started) } }
    }

    // MARK: - the devices

    func enumerateDevices(_ reply: Reply<[DeviceInfo], RtcMediaCode>) {
        var devices: [DeviceInfo] = []
        for input in AVAudioSession.sharedInstance().availableInputs ?? [] {
            devices.append(DeviceInfo(deviceId: input.uid, kind: .audioinput, label: input.portName, facing: nil))
        }
        for camera in RTCCameraVideoCapturer.captureDevices() {
            devices.append(DeviceInfo(deviceId: camera.uniqueID, kind: .videoinput, label: camera.localizedName, facing: camera.position == .front ? .user : .environment))
        }
        devices.append(DeviceInfo(deviceId: "earpiece", kind: .audiooutput, label: "Earpiece", facing: nil))
        devices.append(DeviceInfo(deviceId: "speaker", kind: .audiooutput, label: "Speaker", facing: nil))
        reply.resolve(devices)
    }

    // MARK: - the tracks

    func setTrackEnabled(_ trackId: String, _ enabled: Bool, _ reply: Reply<Void, RtcMediaCode>) {
        guard let track = engine.track(trackId) else { return reply.reject(.notFound) }
        track.track.isEnabled = enabled
        reply.resolve()
    }

    func applyConstraints(_ trackId: String, _ constraints: VideoConstraints, _ reply: Reply<Void, RtcMediaCode>) {
        guard let track = engine.track(trackId), let capture = track.capture else { return reply.reject(.notFound) }
        capture.start(constraints) { ok in
            if ok { reply.resolve() } else { reply.reject(.failed) }
        }
    }

    func getTrackSettings(_ trackId: String, _ reply: Reply<TrackSettings, RtcMediaCode>) {
        guard let track = engine.track(trackId) else { return reply.reject(.notFound) }
        reply.resolve(track.capture?.settings ?? TrackSettings())
    }

    func stopTrack(_ trackId: String, _ reply: Reply<Void, RtcMediaCode>) {
        if let track = engine.remove(trackId) {
            track.track.isEnabled = false
            track.capture?.stop()
        }
        reply.resolve()
    }

    func setAudioOutput(_ output: AudioOutput, _ reply: Reply<Void, RtcMediaCode>) {
        engine.setAudioOutput(output)
        reply.resolve()
    }
}
