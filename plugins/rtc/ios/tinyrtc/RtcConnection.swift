// One peer: a core connection behind a main-actor object.

import CoreMedia
import Foundation
import TinyRTCCore

/// What the core says about a connection, copied off the core thread.
enum CoreEvent: Sendable {
    case state(RtcConnectionState)
    case localCandidate(String)
    case iceRestartNeeded
    case remoteMedia(RtcMediaKind, Bool)
    case channelOpen(UInt32, String)
    case channelMessage(UInt32, Data, Bool)
    case channelBufferedLow(UInt32)
    case channelClosed(UInt32)
}

/// The `user` of a connection's event callback. Lives from `tinyrtc_connection_create` until
/// `tinyrtc_connection_destroy` returned (no callback after that).
final class ConnectionSink: @unchecked Sendable {
    let video: RemoteVideoFeed
    /// Set once, before the connection exists.
    var deliver: (@Sendable (CoreEvent) -> Void)?

    init(video: RemoteVideoFeed) {
        self.video = video
    }

    /// On the connection's core thread: copy and hop.
    func handle(_ event: UnsafePointer<tinyrtc_event>) {
        let e = event.pointee
        switch e.type {
        case TINYRTC_EVENT_VIDEO_FRAME:
            // Not an event of the app: straight to the views (none = not even copied).
            video.deliver(e)
            return
        case TINYRTC_EVENT_STATE:
            deliver?(.state(e.state.swift))
        case TINYRTC_EVENT_LOCAL_CANDIDATE:
            guard let line = e.candidate.candidate else { return }
            deliver?(.localCandidate(String(cString: line)))
        case TINYRTC_EVENT_ICE_RESTART_NEEDED:
            deliver?(.iceRestartNeeded)
        case TINYRTC_EVENT_REMOTE_MEDIA:
            let media = e.remote_media
            deliver?(.remoteMedia(media.media == TINYRTC_MEDIA_AUDIO ? .audio : .video, media.active != 0))
        case TINYRTC_EVENT_CHANNEL_OPEN:
            let label = e.channel.label.map { String(cString: $0) } ?? ""
            deliver?(.channelOpen(e.channel.id, label))
        case TINYRTC_EVENT_CHANNEL_MESSAGE:
            let message = e.message
            let data = message.len == 0 || message.data == nil ? Data() : Data(bytes: message.data, count: message.len)
            deliver?(.channelMessage(message.id, data, message.binary != 0))
        case TINYRTC_EVENT_CHANNEL_BUFFERED_LOW:
            deliver?(.channelBufferedLow(e.channel.id))
        case TINYRTC_EVENT_CHANNEL_CLOSED:
            deliver?(.channelClosed(e.channel.id))
        default:
            break
        }
    }
}

private func connectionEvent(_ user: UnsafeMutableRawPointer?, _ event: UnsafePointer<tinyrtc_event>?) {
    guard let user, let event else { return }
    Unmanaged<ConnectionSink>.fromOpaque(user).takeUnretainedValue().handle(event)
}

/// The core connection: its handle, its worker queue (every call into it runs there), its sink.
final class ConnectionCore: @unchecked Sendable {
    /// At the core threads' QoS (default: Rust's threads set none): a worker above it that waits for
    /// the driver would be a priority inversion. Work is submitted with `.enforceQoS`, so the main
    /// thread's QoS does not propagate into it.
    let queue = DispatchQueue(label: "tinyrtc.connection", qos: .default)
    let context: CoreContext
    let sink: ConnectionSink

    private struct Held {
        var handle: OpaquePointer?
        var retained: Unmanaged<ConnectionSink>?
        var closed = false
    }
    private let held: Locked<Held>

    init(context: CoreContext, configuration: RtcConfiguration, sink: ConnectionSink) throws {
        self.context = context
        self.sink = sink
        let retained = Unmanaged.passRetained(sink)
        // The ICE servers' strings, alive for the call (the core copies them).
        var strings: [UnsafeMutablePointer<CChar>] = []
        defer { strings.forEach { free($0) } }
        func c(_ s: String?) -> UnsafePointer<CChar>? {
            guard let s, let copy = strdup(s) else { return nil }
            strings.append(copy)
            return UnsafePointer(copy)
        }
        let servers = configuration.iceServers.map {
            tinyrtc_ice_server(url: c($0.url), username: c($0.username), credential: c($0.credential))
        }
        let handle: OpaquePointer? = servers.withUnsafeBufferPointer { buffer in
            var config = tinyrtc_connection_config()
            config.ice_servers = buffer.baseAddress
            config.ice_server_count = buffer.count
            config.relay_only = configuration.relayOnly ? 1 : 0
            config.event = connectionEvent
            config.user = retained.toOpaque()
            return tinyrtc_connection_create(context.raw, &config)
        }
        guard let handle else {
            retained.release()
            throw RtcError.failed("the connection could not be made (no socket)")
        }
        held = Locked(Held(handle: handle, retained: retained))
    }

    /// The handle while the connection is not closed. Read on the worker queue.
    private var live: OpaquePointer? { held.read { $0.closed ? nil : $0.handle } }

    var isClosed: Bool { held.read { $0.closed } }

    /// `work` on the worker queue, in order, at the queue's own QoS.
    func submit(_ work: @escaping @Sendable () -> Void) {
        queue.async(qos: .default, flags: .enforceQoS, execute: work)
    }

    /// `work` with the live handle on the worker queue, not waited for; skipped once closed.
    func post(_ work: @escaping @Sendable (OpaquePointer) -> Void) {
        submit { [self] in
            if let handle = live { work(handle) }
        }
    }

    /// `work` with the live handle on the worker queue, awaited; `.closed` once closed. Queued
    /// before this returns control: calls made in a row run in that order.
    func call<T: Sendable>(_ work: @escaping @Sendable (OpaquePointer) throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            submit { [self] in
                continuation.resume(with: Result {
                    guard let handle = live else { throw RtcError.closed }
                    return try work(handle)
                })
            }
        }
    }

    /// The video source the core connection takes. On the worker queue only.
    private var video: CoreVideoSource?

    /// On the worker queue: take `source` (nil = none). Its callbacks may run inside, on this thread.
    func setVideo(_ source: CoreVideoSource?) {
        guard let handle = live else { return }
        video = source
        if let source {
            source.withHandle { tinyrtc_connection_send_video(handle, $0) }
        } else {
            tinyrtc_connection_send_video(handle, nil)
        }
    }

    /// On the worker queue: let go of `source` if it is the one taken (a source about to be
    /// destroyed). After it, no callback of that source comes from this connection.
    func detachVideo(_ source: CoreVideoSource) {
        guard video === source else { return }
        video = nil
        if let handle = live { tinyrtc_connection_send_video(handle, nil) }
    }

    /// Idempotent, any thread. Later calls are skipped at once; the destroy (SYNC: it closes towards
    /// the other side and joins the core's threads) runs on the worker queue after what is queued.
    func close() {
        let taken: (OpaquePointer, Unmanaged<ConnectionSink>)? = held.write { held in
            defer { held = Held(handle: nil, retained: nil, closed: true) }
            guard !held.closed, let handle = held.handle, let retained = held.retained else { return nil }
            return (handle, retained)
        }
        guard let (handle, retained) = taken else { return }
        let destroy = Unchecked(value: (handle, retained))
        submit {
            tinyrtc_connection_destroy(destroy.value.0)
            // No callback runs after the destroy returned: the sink can go.
            destroy.value.1.release()
        }
    }

    deinit {
        close()
    }
}

/// The relay from the core's events to the connection object, which may be gone.
private final class EventRelay: @unchecked Sendable {
    /// Read and written on the main thread only.
    weak var connection: RtcConnection?
}

/// One peer (a core connection). Made by `RtcEngine.connect`.
///
/// Signaling is the app's: `createOffer` / `acceptOffer` / `acceptAnswer` and the candidates of
/// `onIceCandidate` travel over whatever channel it has. Every connection holds audio, video and
/// data from its first offer: `setTrack` and `createDataChannel` never need another one.
@MainActor
public final class RtcConnection {
    public private(set) var state: RtcConnectionState = .new
    public private(set) var isClosed = false

    public var onStateChange: ((RtcConnectionState) -> Void)?
    /// A `candidate:` line for the other side's `addIceCandidate`.
    public var onIceCandidate: ((String) -> Void)?
    /// The path is gone: the offering side should `createOffer(iceRestart: true)`.
    public var onIceRestartNeeded: (() -> Void)?
    /// The other side started (true) / stopped (false) sending a kind.
    public var onRemoteMedia: ((RtcMediaKind, Bool) -> Void)?
    /// A channel the other side opened, already open.
    public var onDataChannel: ((RtcDataChannel) -> Void)?

    /// What the other side sends. They exist from the connection's creation.
    public let remoteAudio: RemoteAudioTrack
    public let remoteVideo: RemoteVideoTrack

    nonisolated let core: ConnectionCore
    nonisolated let engine: RtcEngine
    private var channels: [UInt32: RtcDataChannel] = [:]
    private(set) var audioTrack: LocalAudioTrack?
    private(set) var videoTrack: LocalVideoTrack?

    init(engine: RtcEngine, configuration: RtcConfiguration) throws {
        let feed = RemoteVideoFeed()
        let sink = ConnectionSink(video: feed)
        let core = try ConnectionCore(context: engine.context, configuration: configuration, sink: sink)
        let relay = EventRelay()
        // Every event goes through the worker queue on its way to the main thread: a channel's
        // open, coming right after `tinyrtc_channel_open` returned, then arrives after the
        // `createDataChannel` that made it has resumed (and registered it).
        sink.deliver = { [queue = core.queue] event in
            queue.async {
                onMain { relay.connection?.handle(event) }
            }
        }
        self.core = core
        self.engine = engine
        remoteAudio = RemoteAudioTrack(core: core)
        remoteVideo = RemoteVideoTrack(feed: feed)
        feed.requestKeyframe = { [weak core] in
            core?.post { tinyrtc_connection_request_keyframe($0) }
        }
        relay.connection = self
    }

    deinit {
        // Dropped without close(): the same cleanup (no event reaches a connection that is gone).
        core.close()
        let (engine, id) = (engine, ObjectIdentifier(self))
        onMain { engine.unregister(id) }
    }

    // MARK: signaling

    /// The offering side. `iceRestart` for every offer after the first.
    public func createOffer(iceRestart: Bool = false) async throws -> String {
        try await core.call { handle in
            var text = tinyrtc_text()
            try RtcError.check(tinyrtc_connection_offer(handle, iceRestart ? 1 : 0, &text), "createOffer")
            return take(text)
        }
    }

    /// The answering side: takes the offer, returns the answer.
    public func acceptOffer(_ offer: String) async throws -> String {
        try await core.call { handle in
            var text = tinyrtc_text()
            let status = offer.withCString { tinyrtc_connection_accept_offer(handle, $0, &text) }
            try RtcError.check(status, "acceptOffer")
            return take(text)
        }
    }

    /// The offering side: takes the answer.
    public func acceptAnswer(_ answer: String) async throws {
        try await core.call { handle in
            try RtcError.check(answer.withCString { tinyrtc_connection_accept_answer(handle, $0) }, "acceptAnswer")
        }
    }

    /// A `candidate:` line of the other side, or a relay's (`typ relay`); nil = it has no more.
    /// Under `relayOnly` a line that is not `typ relay` is ignored. Nothing after `close()`.
    public func addIceCandidate(_ line: String?) {
        core.post { handle in
            if let line {
                _ = line.withCString { tinyrtc_connection_add_candidate(handle, $0) }
            } else {
                _ = tinyrtc_connection_add_candidate(handle, nil)
            }
        }
    }

    // MARK: media

    /// What this connection sends of a kind; nil = nothing. A track may be set on many connections
    /// (it is encoded once).
    public func setTrack(_ kind: RtcMediaKind, _ track: (any RtcLocalTrack)?) throws {
        guard !isClosed else { throw RtcError.closed }
        if let track, track.kind != kind { throw RtcError.failed("setTrack: a \(track.kind) track given for \(kind)") }
        switch kind {
        case .video:
            let track = track as? LocalVideoTrack
            if track?.isStopped == true { throw RtcError.closed }
            if videoTrack !== track {
                videoTrack?.connectionRemoved(self)
                videoTrack = track
                track?.connectionAdded(self)
            }
            updateVideo()
        case .audio:
            let track = track as? LocalAudioTrack
            if track?.isStopped == true { throw RtcError.closed }
            if audioTrack !== track {
                audioTrack?.connectionRemoved(self)
                audioTrack = track
                track?.connectionAdded(self)
            }
            updateAudio()
        }
    }

    /// The video source this connection takes, after a change of the track or its `isEnabled`.
    func updateVideo() {
        guard !isClosed else { return }
        let source = videoTrack.flatMap { $0.isEnabled && !$0.isStopped ? $0.pipeline.source : nil }
        let core = core
        core.submit { core.setVideo(source) }
    }

    func updateAudio() {
        guard !isClosed else { return }
        let on: UInt8 = audioTrack.map { $0.isEnabled && !$0.isStopped } == true ? 1 : 0
        core.post { tinyrtc_connection_send_audio($0, on) }
    }

    /// A track was stopped: it is not sent any more.
    func trackStopped(_ kind: RtcMediaKind) {
        switch kind {
        case .video: videoTrack = nil
        case .audio: audioTrack = nil
        }
    }

    // MARK: data

    /// A channel to the other side, opened in-band (no renegotiation). Usable once `onOpen` came.
    public func createDataChannel(_ label: String, options: RtcDataChannelOptions = .init()) async throws -> RtcDataChannel {
        let id: UInt32 = try await core.call { handle in
            var c = tinyrtc_channel_options()
            c.unordered = options.ordered ? 0 : 1
            c.max_retransmits = options.maxRetransmits.map { Int32(clamping: $0) } ?? -1
            c.max_packet_life_ms = options.maxPacketLifeTimeMs.map { Int32(clamping: $0) } ?? -1
            var id: UInt32 = 0
            try RtcError.check(label.withCString { tinyrtc_channel_open(handle, $0, &c, &id) }, "createDataChannel")
            return id
        }
        guard !isClosed else { throw RtcError.closed }
        let channel = RtcDataChannel(id: id, label: label, connection: self, open: false)
        channels[id] = channel
        return channel
    }

    func forget(_ channel: RtcDataChannel) {
        channels[channel.id] = nil
    }

    // MARK: numbers, end

    public func stats() async throws -> RtcStats {
        try await core.call { handle in
            var s = tinyrtc_stats()
            try RtcError.check(tinyrtc_connection_stats(handle, &s), "stats")
            return RtcStats(
                state: s.state.swift, relayed: s.relayed != 0, rttMs: s.rtt_ms, sendEstimateBps: s.send_estimate_bps,
                audioSendBps: s.audio_send_bps, audioRecvBps: s.audio_recv_bps,
                videoSendBps: s.video_send_bps, videoRecvBps: s.video_recv_bps,
                audioLoss: s.audio_loss, videoLoss: s.video_loss, audioJitterBufferMs: s.audio_jitter_buffer_ms,
                videoRecvFps: s.video_recv_fps, videoNacksSent: s.video_nacks_sent,
                videoKeyframesRequested: s.video_keyframes_requested,
                bytesSent: s.bytes_sent, bytesReceived: s.bytes_received)
        }
    }

    /// Closes (the other side sees it at once) and frees. Idempotent; no event of this connection or
    /// of its channels arrives after it returns. Never blocks: the core's destroy runs on the worker.
    public func close() {
        guard !isClosed else { return }
        isClosed = true
        state = .closed
        for channel in channels.values { channel.connectionClosed() }
        channels.removeAll()
        videoTrack?.connectionRemoved(self)
        audioTrack?.connectionRemoved(self)
        videoTrack = nil
        audioTrack = nil
        remoteVideo.connectionClosed()
        core.close()
        engine.unregister(ObjectIdentifier(self))
    }

    private func handle(_ event: CoreEvent) {
        guard !isClosed else { return }
        switch event {
        case .state(let state):
            self.state = state
            onStateChange?(state)
        case .localCandidate(let line):
            onIceCandidate?(line)
        case .iceRestartNeeded:
            onIceRestartNeeded?()
        case .remoteMedia(let kind, let active):
            switch kind {
            case .audio: remoteAudio.isActive = active
            case .video: remoteVideo.isActive = active
            }
            onRemoteMedia?(kind, active)
        case .channelOpen(let id, let label):
            if let channel = channels[id] {
                channel.opened()
            } else {
                let channel = RtcDataChannel(id: id, label: label, connection: self, open: true)
                channels[id] = channel
                onDataChannel?(channel)
            }
        case .channelMessage(let id, let data, let binary):
            channels[id]?.received(data, binary: binary)
        case .channelBufferedLow(let id):
            channels[id]?.bufferedLow()
        case .channelClosed(let id):
            channels.removeValue(forKey: id)?.closedByCore()
        }
    }
}
