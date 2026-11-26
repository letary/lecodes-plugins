// The tracks: what this side sends (camera, microphone) and what the other side sends.

import Foundation
import TinyRTCCore

/// A track this side sends: `RtcConnection.setTrack(kind, track)`.
@MainActor
public protocol RtcLocalTrack: AnyObject {
    var kind: RtcMediaKind { get }
    /// false = not sent (the other side gets `onRemoteMedia(kind, false)`); nothing is freed.
    var isEnabled: Bool { get set }
    var isStopped: Bool { get }
    /// Releases the device. Idempotent; no event of the track after it returns.
    func stop()
}

/// A picture an `RtcVideoView` can show: a `LocalVideoTrack` (the camera's preview) or a
/// `RemoteVideoTrack`.
public protocol RtcVideoTrack: AnyObject {}

/// The camera: the capture session, the hardware encoder, the core's video source. Encoded once for
/// every connection it is set on.
///
/// The picture is sent as the sensor gives it (landscape on a phone); the degrees that show it
/// upright travel with every frame, and the receiving view rotates it.
@MainActor
public final class LocalVideoTrack: RtcLocalTrack, RtcVideoTrack {
    public let kind = RtcMediaKind.video
    public private(set) var settings: CameraSettings
    public private(set) var isStopped = false
    /// The OS took the camera for good (it was disconnected, a capture error). Interruptions (a call,
    /// the background, another app) pause the track and it resumes by itself.
    public var onEnded: (() -> Void)?

    public var isEnabled = true {
        didSet {
            guard isEnabled != oldValue, !isStopped else { return }
            prune()
            for connection in connections.values { connection.value?.updateVideo() }
            updateSending()
        }
    }

    nonisolated let pipeline: VideoPipeline
    private let engine: RtcEngine
    private var connections: [ObjectIdentifier: Weak<RtcConnection>] = [:]

    init(engine: RtcEngine, pipeline: VideoPipeline, settings: CameraSettings, options: CameraOptions) {
        self.engine = engine
        self.pipeline = pipeline
        self.settings = settings
        applyLimits(options)
        pipeline.capturer.onEnded = { [weak self] in
            guard let self else { return }
            onMain { self.ended() }
        }
    }

    deinit {
        let pipeline = pipeline
        Task { await pipeline.tearDown() }
    }

    /// Another camera, size or rate; the track (and every connection's use of it) stays.
    public func apply(_ options: CameraOptions) async throws {
        guard !isStopped else { throw RtcError.closed }
        settings = try await pipeline.capturer.apply(options)
        applyLimits(options)
        for view in previews.values.compactMap(\.value) { view.cameraChanged() }
    }

    /// The views showing this camera's preview.
    private var previews: [ObjectIdentifier: Weak<RtcVideoView>] = [:]

    func previewAttached(_ view: RtcVideoView) {
        previews = previews.filter { $0.value.value != nil }
        previews[ObjectIdentifier(view)] = Weak(value: view)
    }

    func previewDetached(_ view: RtcVideoView) {
        previews[ObjectIdentifier(view)] = nil
    }

    public func stop() {
        guard !isStopped else { return }
        isStopped = true
        prune()
        for connection in connections.values { connection.value?.trackStopped(.video) }
        connections.removeAll()
        let pipeline = pipeline
        Task { await pipeline.tearDown() }
    }

    /// The ceiling of the core's target (a size and a rate the app asked for). 0 = none.
    func setLimits(bitrate: UInt32, fps: UInt32, height: UInt32) {
        pipeline.source.setLimits(bitrate: bitrate, fps: fps, height: height)
    }

    /// The most this camera's stream may take, bits per second. The size and the rate under it keep
    /// following the network by themselves; every connection that sends this track is under the
    /// same ceiling (it is encoded once).
    public var maxBitrate: Int = 1_500_000 {
        didSet {
            if let options = limitedBy { applyLimits(options) }
        }
    }

    /// The options the limits were last derived from.
    private var limitedBy: CameraOptions?

    private func applyLimits(_ options: CameraOptions) {
        limitedBy = options
        let short = UInt32(clamping: min(options.width, options.height))
        setLimits(bitrate: UInt32(clamping: max(maxBitrate, 0)), fps: UInt32(clamping: options.frameRate), height: short)
    }

    private func ended() {
        guard !isStopped else { return }
        stop()
        onEnded?()
    }

    private func prune() {
        connections = connections.filter { $0.value.value != nil }
    }

    private func updateSending() {
        prune()
        pipeline.encoder.setSending(isEnabled && !isStopped && !connections.isEmpty)
    }

    func connectionAdded(_ connection: RtcConnection) {
        connections[ObjectIdentifier(connection)] = Weak(value: connection)
        pipeline.attached(connection.core)
        updateSending()
    }

    func connectionRemoved(_ connection: RtcConnection) {
        connections[ObjectIdentifier(connection)] = nil
        updateSending()
    }
}

/// The microphone's share of the audio unit. Sent by every connection it is set on (encoded once).
@MainActor
public final class LocalAudioTrack: RtcLocalTrack {
    public let kind = RtcMediaKind.audio
    public private(set) var isStopped = false
    /// The audio unit could not be brought back (after an interruption or a reset). Interruptions
    /// themselves pause the track and it resumes by itself.
    public var onEnded: (() -> Void)?

    public var isEnabled = true {
        didSet {
            guard isEnabled != oldValue, !isStopped else { return }
            for connection in connections.values { connection.value?.updateAudio() }
        }
    }

    private let engine: RtcEngine
    private var connections: [ObjectIdentifier: Weak<RtcConnection>] = [:]

    init(engine: RtcEngine) {
        self.engine = engine
    }

    deinit {
        let (engine, id) = (engine, ObjectIdentifier(self))
        onMain { engine.microphoneGone(id) }
    }

    public func stop() {
        guard !isStopped else { return }
        isStopped = true
        for connection in connections.values {
            connection.value?.trackStopped(.audio)
            connection.value?.updateAudio()
        }
        connections.removeAll()
        engine.microphoneGone(ObjectIdentifier(self))
    }

    func ended() {
        guard !isStopped else { return }
        stop()
        onEnded?()
    }

    func connectionAdded(_ connection: RtcConnection) {
        connections[ObjectIdentifier(connection)] = Weak(value: connection)
    }

    func connectionRemoved(_ connection: RtcConnection) {
        connections[ObjectIdentifier(connection)] = nil
    }
}

/// What the other side sends of its sound: always in the mix unless muted.
@MainActor
public final class RemoteAudioTrack {
    /// Left out of the mix (it still arrives and is decoded, so it comes back in step).
    public var isMuted = false {
        didSet {
            let muted: UInt8 = isMuted ? 1 : 0
            core.post { tinyrtc_connection_mute_playout($0, muted) }
        }
    }

    /// The other side sends it.
    public internal(set) var isActive = false

    private let core: ConnectionCore

    init(core: ConnectionCore) {
        self.core = core
    }
}

/// What the other side sends of its picture. Decoded only by the views that show it.
@MainActor
public final class RemoteVideoTrack: RtcVideoTrack {
    /// The other side sends it.
    public internal(set) var isActive = false

    nonisolated let feed: RemoteVideoFeed

    init(feed: RemoteVideoFeed) {
        self.feed = feed
    }

    func connectionClosed() {
        feed.removeAll()
    }
}
