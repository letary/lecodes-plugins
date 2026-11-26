//
//  RtcMediaService.swift — lecodes-plugins/rtc
//
//  The "rtcMedia" service: capture, the device list, the audio route — over tinyrtc's RtcEngine.
//  One session for the app. getUserMedia asks for the permissions itself, by hand through the
//  host's `Permissions` (which ones depends on the constraints), before tinyrtc opens anything:
//  tinyrtc never asks, it fails with `denied`. The tracks it makes go into RtcTracks, where the
//  connections and the pictures find them; the session stops them when it closes (the world went).
//
//  The microphone always runs through the OS's voice processing — one unit, all or nothing — so the
//  three flags of AudioConstraints do nothing on iOS (the contract says so). The audio session is
//  tinyrtc's (RtcAudioSession, given back as it was found): nothing here touches AVAudioSession.
//

import Foundation
import LeCodes

@MainActor
final class RtcMediaService: RtcMediaPlugin {

    private let permissions: Permissions
    /// nil once the session closed: nothing is raised after it.
    private var events: RtcMediaEvents?
    private let tracks = RtcTracks.shared
    /// The tracks this session made: stopped when it closes.
    private var made: Set<String> = []
    /// applyConstraints in the order they came: each merges over the options the one before left.
    private let calls = RtcCallQueue()
    /// The microphones and cameras last seen, by id. tinyrtc's one devices callback fires on every
    /// change of the audio route too (the speaker, a call's start): `deviceChange` is said only
    /// when these change.
    private var inputs: Set<String>
    private var routedToSpeaker = false
    private var closed = false

    /// The session that hears tinyrtc's devices callback (one slot, `RtcEngine.onDevicesChanged`):
    /// the newest.
    private static weak var listening: RtcMediaService?

    init(_ permissions: Permissions, _ events: RtcMediaEvents) {
        self.permissions = permissions
        self.events = events
        let engine = RtcEngine.shared
        inputs = Self.inputs(engine.devices())
        Self.listening = self
        engine.onDevicesChanged = { RtcMediaService.listening?.devicesChanged() }
    }

    nonisolated func close() {
        MainActor.assumeIsolated {
            guard !closed else { return }
            closed = true
            events = nil
            for id in made {
                tracks.local(id)?.stop()
                tracks.forget(id)
            }
            made = []
            if routedToSpeaker { RtcEngine.shared.audioOutput = .earpiece }
            if Self.listening === self {
                Self.listening = nil
                RtcEngine.shared.onDevicesChanged = nil
            }
        }
    }

    // MARK: - capture

    nonisolated func getUserMedia(_ constraints: MediaConstraints, _ reply: Reply<[TrackInfo], RtcMediaCode>) {
        MainActor.assumeIsolated {
            var kinds: [PermissionKind] = []
            if constraints.audio != nil { kinds.append(.microphone) }
            if constraints.video != nil { kinds.append(.camera) }
            guard !kinds.isEmpty else { return reply.fail("getUserMedia: ask for audio, video or both") }
            // Answered on the main thread, once.
            permissions.ensure(kinds) { granted in
                MainActor.assumeIsolated {
                    guard granted else { return reply.reject(.denied) }
                    Task { @MainActor in
                        do {
                            let infos = try await self.capture(constraints)
                            reply.resolve(infos)
                        } catch {
                            reply.reject(error, in: "getUserMedia")
                        }
                    }
                }
            }
        }
    }

    /// Opens what `constraints` asks for and registers it, the microphone first. Nothing stays open
    /// on a failure: a microphone opened before the camera failed is stopped.
    private func capture(_ constraints: MediaConstraints) async throws -> [TrackInfo] {
        let engine = RtcEngine.shared
        var microphone: LocalAudioTrack?
        if constraints.audio != nil { microphone = try await engine.openMicrophone() }
        var camera: (track: LocalVideoTrack, options: CameraOptions)?
        if let video = constraints.video {
            let options = Self.options(video, over: CameraOptions())
            do {
                camera = (try await engine.openCamera(options), options)
            } catch {
                microphone?.stop()
                throw error
            }
        }
        guard !closed else {
            microphone?.stop()
            camera?.track.stop()
            throw RtcError.failed("the session closed while the devices opened")
        }
        let devices = engine.devices()
        var infos: [TrackInfo] = []
        if let microphone {
            let id = adopt(.microphone(microphone))
            // tinyrtc does not say which input the unit records from: the first one listed.
            let label = devices.first { $0.kind == .microphone }?.label ?? "Microphone"
            infos.append(TrackInfo(id: id, kind: .audio, label: label, enabled: true))
        }
        if let camera {
            let id = adopt(.camera(camera.track, options: camera.options))
            let label = devices.first { $0.id == camera.track.settings.deviceId }?.label ?? "Camera"
            infos.append(TrackInfo(id: id, kind: .video, label: label, enabled: true))
        }
        return infos
    }

    /// Registers a track this session made; its end (the OS took the device) is `trackEnded`.
    private func adopt(_ track: RtcTracks.Track) -> String {
        let id = tracks.add(track)
        made.insert(id)
        let ended: () -> Void = { [weak self] in self?.ended(id) }
        switch track {
        case .microphone(let microphone): microphone.onEnded = ended
        case .camera(let camera, _): camera.onEnded = ended
        case .remoteAudio, .remoteVideo: break
        }
        return id
    }

    /// tinyrtc stopped the track itself.
    private func ended(_ id: String) {
        guard made.remove(id) != nil else { return }
        tracks.forget(id)
        events?.trackEnded(trackId: id)
    }

    /// `constraints` over `base`: what it names replaces, the rest stays. A facing without a device
    /// clears the device (tinyrtc, like the contract, lets a deviceId win over the facing).
    static func options(_ constraints: VideoConstraints, over base: CameraOptions) -> CameraOptions {
        var options = base
        if let deviceId = constraints.deviceId {
            options.deviceId = deviceId
        } else if constraints.facingMode != nil {
            options.deviceId = nil
        }
        if let facing = constraints.facingMode { options.facing = facing.camera }
        if let width = constraints.width { options.width = Int(width) }
        if let height = constraints.height { options.height = Int(height) }
        if let frameRate = constraints.frameRate { options.frameRate = Int(frameRate) }
        return options
    }

    // MARK: - the devices

    nonisolated func enumerateDevices(_ reply: Reply<[DeviceInfo], RtcMediaCode>) {
        MainActor.assumeIsolated {
            reply.resolve(RtcEngine.shared.devices().map { device in
                switch device.kind {
                case .camera(let facing):
                    return DeviceInfo(deviceId: device.id, kind: .videoinput, label: device.label, facing: facing.wire)
                case .microphone:
                    return DeviceInfo(deviceId: device.id, kind: .audioinput, label: device.label)
                case .speaker:
                    return DeviceInfo(deviceId: device.id, kind: .audiooutput, label: device.label)
                }
            })
        }
    }

    private func devicesChanged() {
        let now = Self.inputs(RtcEngine.shared.devices())
        guard now != inputs else { return }
        inputs = now
        events?.deviceChange()
    }

    private static func inputs(_ devices: [RtcDevice]) -> Set<String> {
        Set(devices.filter { $0.kind != .speaker }.map(\.id))
    }

    nonisolated func setAudioOutput(_ output: AudioOutput, _ reply: Reply<Void, RtcMediaCode>) {
        MainActor.assumeIsolated {
            routedToSpeaker = output == .speaker
            RtcEngine.shared.audioOutput = output == .speaker ? .speaker : .earpiece
            reply.resolve()
        }
    }

    // MARK: - the tracks

    nonisolated func setTrackEnabled(_ trackId: String, _ enabled: Bool, _ reply: Reply<Void, RtcMediaCode>) {
        MainActor.assumeIsolated {
            guard let track = tracks.local(trackId) else { return reply.reject(.notFound) }
            track.isEnabled = enabled
            reply.resolve()
        }
    }

    nonisolated func applyConstraints(_ trackId: String, _ constraints: VideoConstraints, _ reply: Reply<Void, RtcMediaCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "applyConstraints") {
                guard case .camera(let track, let last)? = self.tracks.track(trackId) else { throw RtcError.notFound }
                let options = Self.options(constraints, over: last)
                try await track.apply(options)
                // Stopped meanwhile: not put back.
                if self.tracks.track(trackId) != nil { self.tracks.set(trackId, .camera(track, options: options)) }
            }
        }
    }

    nonisolated func getTrackSettings(_ trackId: String, _ reply: Reply<TrackSettings, RtcMediaCode>) {
        MainActor.assumeIsolated {
            switch tracks.track(trackId) {
            case .camera(let track, _)?:
                let s = track.settings
                reply.resolve(TrackSettings(deviceId: s.deviceId, facingMode: s.facing.wire,
                                            width: Int32(clamping: s.width), height: Int32(clamping: s.height),
                                            frameRate: Int32(clamping: s.frameRate)))
            case .some:
                // A microphone, a received track: nothing a capture is set to.
                reply.resolve(TrackSettings())
            case nil:
                reply.reject(.notFound)
            }
        }
    }

    nonisolated func setMaxVideoBitrate(_ trackId: String, _ bitrate: Int32, _ reply: Reply<Void, RtcMediaCode>) {
        MainActor.assumeIsolated {
            guard case .camera(let track, _)? = tracks.track(trackId) else { return reply.reject(.notFound) }
            track.maxBitrate = Int(bitrate)
            reply.resolve()
        }
    }

    nonisolated func stopTrack(_ trackId: String, _ reply: Reply<Void, RtcMediaCode>) {
        MainActor.assumeIsolated {
            // A received track is its connection's: it goes when the connection closes.
            if let track = tracks.local(trackId) {
                track.stop()
                made.remove(trackId)
                tracks.forget(trackId)
            }
            reply.resolve()
        }
    }
}

extension FacingMode {
    var camera: CameraFacing { self == .user ? .user : .environment }
}

extension CameraFacing {
    var wire: FacingMode { self == .user ? .user : .environment }
}
