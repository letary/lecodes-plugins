// The process's engine: the core context, the audio unit and the audio route, the watch on the
// network.

import AVFoundation
import Foundation
import Network
import TinyRTCCore

/// One per process (`RtcEngine.shared`). Opens the camera and the microphone, makes connections.
///
/// Every method is called on the main thread and never blocks it; events come on the main thread.
@MainActor
public final class RtcEngine {
    public static let shared = RtcEngine()

    public struct Configuration: Sendable {
        /// The core's log, to os_log (subsystem "tinyrtc", category "core").
        public var logLevel: RtcLogLevel

        public init(logLevel: RtcLogLevel = .warn) {
            self.logLevel = logLevel
        }
    }

    /// The one place the half configures AVAudioSession; an app with its own audio takes it over there.
    public let audioSession = RtcAudioSession.shared

    /// Earpiece or speaker.
    public var audioOutput: RtcAudioOutput = .earpiece {
        didSet { audio.setOutput(audioOutput) }
    }

    /// A camera, a microphone or an audio route came or went.
    public var onDevicesChanged: (() -> Void)?

    nonisolated let context: CoreContext
    nonisolated let audio: AudioController
    private nonisolated let monitor = NWPathMonitor()
    private nonisolated let observers = Locked<[NSObjectProtocol]>([])
    private var connections: [ObjectIdentifier: Weak<RtcConnection>] = [:]
    private var microphones: [ObjectIdentifier: Weak<LocalAudioTrack>] = [:]

    public convenience init(configuration: Configuration = .init()) {
        self.init(configuration: configuration, audioDevice: VoiceProcessingAudioDevice())
    }

    /// With another audio device (the tests' clock).
    init(configuration: Configuration, audioDevice: AudioDevice) {
        context = CoreContext(logLevel: configuration.logLevel)
        audio = AudioController(context: context, device: audioDevice, session: .shared)
        audio.onInputLost = { [weak self] in
            guard let self else { return }
            onMain { self.microphonesLost() }
        }
        audio.onRouteChange = { [weak self] in
            guard let self else { return }
            onMain { self.onDevicesChanged?() }
        }

        // The network: the first report is the network as it is; every later one is a change.
        let (context, first) = (context, Locked(true))
        monitor.pathUpdateHandler = { _ in
            if first.write({ value in defer { value = false }; return value }) { return }
            tinyrtc_context_network_changed(context.raw)
        }
        monitor.start(queue: DispatchQueue(label: "tinyrtc.network"))

        let center = NotificationCenter.default
        let changed: @Sendable (Notification) -> Void = { [weak self] _ in
            guard let self else { return }
            onMain { self.onDevicesChanged?() }
        }
        observers.write {
            $0.append(center.addObserver(forName: AVCaptureDevice.wasConnectedNotification, object: nil, queue: nil, using: changed))
            $0.append(center.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: nil, using: changed))
        }
    }

    deinit {
        monitor.cancel()
        observers.read { $0.forEach(NotificationCenter.default.removeObserver) }
        audio.shutdown()
    }

    /// The cameras, the microphones and the current outputs.
    public func devices() -> [RtcDevice] {
        let cameras = CameraCapturer.cameras.map {
            RtcDevice(id: $0.uniqueID, kind: .camera(CameraCapturer.facing(of: $0)), label: $0.localizedName)
        }
        return cameras + audioSession.ports
    }

    /// The camera, at the format closest to `options`. `.denied` without the camera permission
    /// (asking is the app's business), `.notFound` without such a camera.
    public func openCamera(_ options: CameraOptions = .init()) async throws -> LocalVideoTrack {
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { throw RtcError.denied }
        guard CameraCapturer.find(options) != nil else { throw RtcError.notFound }
        return try await makeVideoTrack(capturer: CameraCapturer.make(), options: options)
    }

    /// A video track from any capturer (the camera; a test's pattern).
    func makeVideoTrack(capturer: VideoCapturer, options: CameraOptions) async throws -> LocalVideoTrack {
        let pipeline = VideoPipeline(context: context, capturer: capturer)
        do {
            let settings = try await capturer.start(options, into: pipeline.encoder)
            return LocalVideoTrack(engine: self, pipeline: pipeline, settings: settings, options: options)
        } catch {
            await pipeline.tearDown()
            throw error
        }
    }

    /// The microphone (through the OS's voice processing). `.denied` without the permission.
    public func openMicrophone() async throws -> LocalAudioTrack {
        if audio.device.needsRecordPermission && !audioSession.hasRecordPermission { throw RtcError.denied }
        let track = LocalAudioTrack(engine: self)
        microphones[ObjectIdentifier(track)] = Weak(value: track)
        updateAudio()
        return track
    }

    /// A connection to one peer.
    public func connect(_ configuration: RtcConfiguration = .init()) throws -> RtcConnection {
        let connection = try RtcConnection(engine: self, configuration: configuration)
        connections[ObjectIdentifier(connection)] = Weak(value: connection)
        updateAudio()
        return connection
    }

    // MARK: the audio rule

    func unregister(_ connection: ObjectIdentifier) {
        connections[connection] = nil
        updateAudio()
    }

    func microphoneGone(_ track: ObjectIdentifier) {
        microphones[track] = nil
        updateAudio()
    }

    /// Audio runs while a connection exists (to be heard, or to send the microphone); the
    /// microphone side runs while a microphone track is open.
    private func updateAudio() {
        connections = connections.filter { $0.value.value.map { !$0.isClosed } ?? false }
        microphones = microphones.filter { $0.value.value.map { !$0.isStopped } ?? false }
        audio.set(run: !connections.isEmpty, input: !microphones.isEmpty)
    }

    private func microphonesLost() {
        for track in microphones.values.compactMap(\.value) { track.ended() }
    }
}
