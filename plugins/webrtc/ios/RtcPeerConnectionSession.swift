//
//  RtcPeerConnectionSession.swift — lecodes-plugins/webrtc
//
//  One session of the "rtcPeerConnection" service = one RTCPeerConnection, made with the
//  session's params (the configuration) and closed with the session. The senders, the
//  transceivers and the data channels are kept here by the id the wire names them with; a received
//  track goes into RtcEngine's registry, where a view or another connection finds it.
//
//  Threading: the calls arrive on the main thread, libwebrtc's delegates on its signaling thread;
//  the tables are under one lock, the replies and the events go from any thread.
//
//  libwebrtc's ObjC wrappers are TRANSIENT: `pc.transceivers` / `senders` make new wrapper objects
//  at every call. So a sender or a transceiver is keyed by its NATIVE id (`senderId`, `receiverId`
//  — stable for the life of the connection), never by a wrapper's identity, and a live wrapper is
//  looked up at the moment of a call.
//

import Foundation
import WebRTC
import LeCodes

final class RtcPeerConnectionSession: NSObject, RtcPeerConnectionPlugin, RTCPeerConnectionDelegate {

    private let events: RtcPeerConnectionEvents
    private let engine = RtcEngine.shared
    private let pc: RTCPeerConnection
    private let sessionId: String
    private let lock = NSLock()
    /// The wire's sender id ↔ libwebrtc's sender id.
    private var senderIds: [String: String] = [:]
    private var nativeSenders: [String: String] = [:]
    /// The wire's transceiver id ↔ libwebrtc's RECEIVER id (every transceiver has one from the start).
    private var transceiverIds: [String: String] = [:]
    private var nativeReceivers: [String: String] = [:]
    private var channels: [String: RtcDataChannel] = [:]
    /// The received tracks' registry ids by libwebrtc's track id (unique within a connection).
    private var received: [String: String] = [:]
    private var closed = false

    init(_ configuration: RtcConfiguration, _ events: RtcPeerConnectionEvents) {
        self.events = events
        sessionId = engine.allocate("pc")
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        pc = engine.factory.peerConnection(with: Self.rtcConfiguration(configuration), constraints: constraints, delegate: nil)!
        super.init()
        pc.delegate = self
    }

    func close() {
        lock.lock()
        if closed { lock.unlock(); return }
        closed = true
        let channels = self.channels
        let tracks = received
        self.channels = [:]
        received = [:]
        lock.unlock()
        pc.close()
        for (_, channel) in channels { channel.channel.close() }
        for (_, id) in tracks {
            engine.remove(id)
            events.trackEnded(trackId: id)
        }
    }

    // MARK: - the configuration

    private static func rtcConfiguration(_ c: RtcConfiguration) -> RTCConfiguration {
        let out = RTCConfiguration()
        out.sdpSemantics = .unifiedPlan
        out.iceServers = (c.iceServers ?? []).map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
        switch c.iceTransportPolicy ?? .all {
        case .all: out.iceTransportPolicy = .all
        case .relay: out.iceTransportPolicy = .relay
        }
        switch c.bundlePolicy ?? .balanced {
        case .balanced: out.bundlePolicy = .balanced
        case .maxCompat: out.bundlePolicy = .maxCompat
        case .maxBundle: out.bundlePolicy = .maxBundle
        }
        out.iceCandidatePoolSize = Int32(c.iceCandidatePoolSize ?? 0)
        return out
    }

    // MARK: - ids

    private func id(of sender: RTCRtpSender) -> String {
        lock.lock(); defer { lock.unlock() }
        if let id = senderIds[sender.senderId] { return id }
        let id = engine.allocate("sender")
        senderIds[sender.senderId] = id
        nativeSenders[id] = sender.senderId
        return id
    }

    private func id(of transceiver: RTCRtpTransceiver) -> String { id(ofReceiver: transceiver.receiver.receiverId) }

    private func id(ofReceiver receiverId: String) -> String {
        lock.lock(); defer { lock.unlock() }
        if let id = transceiverIds[receiverId] { return id }
        let id = engine.allocate("transceiver")
        transceiverIds[receiverId] = id
        nativeReceivers[id] = receiverId
        return id
    }

    /// The registry entry of a received track, made when first seen.
    private func receivedTrack(_ track: RTCMediaStreamTrack) -> RtcTrack {
        lock.lock()
        if let id = received[track.trackId], let entry = engine.track(id) { lock.unlock(); return entry }
        let id = engine.allocate(track.kind == kRTCMediaStreamTrackKindVideo ? "rvideo" : "raudio")
        received[track.trackId] = id
        lock.unlock()
        let entry = RtcTrack(id: id, track: track, remote: true, label: track.trackId)
        engine.add(entry)
        return entry
    }

    private func senderInfo(_ sender: RTCRtpSender) -> SenderInfo {
        var trackId: String? = nil
        if let track = sender.track {
            trackId = engine.trackId(of: track) ?? receivedTrackId(track)
        }
        return SenderInfo(id: id(of: sender), trackId: trackId)
    }

    private func receivedTrackId(_ track: RTCMediaStreamTrack) -> String? {
        lock.lock(); defer { lock.unlock() }
        return received[track.trackId]
    }

    private func transceiverInfo(_ t: RTCRtpTransceiver) -> TransceiverInfo {
        var current = RTCRtpTransceiverDirection.inactive
        let negotiated = t.currentDirection(&current)
        let receiverTrack = t.receiver.track.map { receivedTrack($0).info }
            ?? TrackInfo(id: "", kind: t.mediaType == .video ? .video : .audio, label: "", enabled: false, muted: nil)
        return TransceiverInfo(
            id: id(of: t), mid: t.mid.isEmpty ? nil : t.mid, direction: Self.direction(t.direction),
            currentDirection: negotiated ? Self.direction(current) : nil,
            sender: senderInfo(t.sender), receiverTrack: receiverTrack, stopped: t.isStopped)
    }

    private static func direction(_ d: RTCRtpTransceiverDirection) -> TransceiverDirection {
        switch d {
        case .sendRecv: return .sendrecv
        case .sendOnly: return .sendonly
        case .recvOnly: return .recvonly
        case .inactive: return .inactive
        case .stopped: return .stopped
        @unknown default: return .inactive
        }
    }

    private static func direction(_ d: TransceiverDirection) -> RTCRtpTransceiverDirection {
        switch d {
        case .sendrecv: return .sendRecv
        case .sendonly: return .sendOnly
        case .recvonly: return .recvOnly
        case .inactive: return .inactive
        case .stopped: return .stopped
        }
    }

    private static func sdpType(_ t: SdpType) -> RTCSdpType {
        switch t {
        case .offer: return .offer
        case .answer: return .answer
        case .pranswer: return .prAnswer
        case .rollback: return .rollback
        }
    }

    private static func description(_ d: RTCSessionDescription) -> SessionDescription {
        let type: SdpType
        switch d.type {
        case .offer: type = .offer
        case .answer: type = .answer
        case .prAnswer: type = .pranswer
        case .rollback: type = .rollback
        @unknown default: type = .offer
        }
        return SessionDescription(type: type, sdp: d.sdp)
    }

    private func guardOpen<V>(_ reply: Reply<V, RtcPeerConnectionCode>) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if closed { reply.reject(.closed) }
        return !closed
    }

    // MARK: - negotiation

    func createOffer(_ options: OfferOptions?, _ reply: Reply<SessionDescription, RtcPeerConnectionCode>) {
        guard guardOpen(reply) else { return }
        var mandatory: [String: String] = [:]
        if let v = options?.offerToReceiveAudio { mandatory["OfferToReceiveAudio"] = v ? "true" : "false" }
        if let v = options?.offerToReceiveVideo { mandatory["OfferToReceiveVideo"] = v ? "true" : "false" }
        if options?.iceRestart == true { mandatory["IceRestart"] = "true" }
        pc.offer(for: RTCMediaConstraints(mandatoryConstraints: mandatory, optionalConstraints: nil)) { sdp, _ in
            guard let sdp else { return reply.reject(.failed) }
            reply.resolve(Self.description(sdp))
        }
    }

    func createAnswer(_ reply: Reply<SessionDescription, RtcPeerConnectionCode>) {
        guard guardOpen(reply) else { return }
        pc.answer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { sdp, _ in
            guard let sdp else { return reply.reject(.failed) }
            reply.resolve(Self.description(sdp))
        }
    }

    func setLocalDescription(_ description: SessionDescription?, _ reply: Reply<SessionDescription, RtcPeerConnectionCode>) {
        guard guardOpen(reply) else { return }
        let done = { (error: Error?) in
            guard error == nil, let local = self.pc.localDescription else { return reply.reject(.failed) }
            reply.resolve(Self.description(local))
        }
        if let description {
            pc.setLocalDescription(RTCSessionDescription(type: Self.sdpType(description.type), sdp: description.sdp), completionHandler: done)
        } else {
            pc.setLocalDescriptionWithCompletionHandler(done)
        }
    }

    func setRemoteDescription(_ description: SessionDescription, _ reply: Reply<Void, RtcPeerConnectionCode>) {
        guard guardOpen(reply) else { return }
        pc.setRemoteDescription(RTCSessionDescription(type: Self.sdpType(description.type), sdp: description.sdp)) { error in
            if error == nil { reply.resolve() } else { reply.reject(.failed) }
        }
    }

    func addIceCandidate(_ candidate: IceCandidate?, _ reply: Reply<Void, RtcPeerConnectionCode>) {
        guard guardOpen(reply) else { return }
        guard let candidate, !candidate.candidate.isEmpty else { return reply.resolve() }   // the end of the remote candidates
        let ice = RTCIceCandidate(sdp: candidate.candidate, sdpMLineIndex: Int32(candidate.sdpMLineIndex ?? 0), sdpMid: candidate.sdpMid)
        pc.add(ice) { error in
            if error == nil { reply.resolve() } else { reply.reject(.failed) }
        }
    }

    func restartIce(_ reply: Reply<Void, RtcPeerConnectionCode>) {
        pc.restartIce()
        reply.resolve()
    }

    func setConfiguration(_ configuration: RtcConfiguration, _ reply: Reply<Void, RtcPeerConnectionCode>) {
        if pc.setConfiguration(Self.rtcConfiguration(configuration)) { reply.resolve() } else { reply.reject(.failed) }
    }

    // MARK: - the tracks

    func addTrack(_ trackId: String, _ streamIds: [String]?, _ reply: Reply<SenderInfo, RtcPeerConnectionCode>) {
        guard guardOpen(reply) else { return }
        guard let track = engine.track(trackId) else { return reply.reject(.notFound) }
        let ids = (streamIds?.isEmpty == false) ? streamIds! : [engine.allocate("stream")]
        guard let sender = pc.add(track.track, streamIds: ids) else { return reply.reject(.failed) }
        reply.resolve(senderInfo(sender))
    }

    func removeTrack(_ senderId: String, _ reply: Reply<Void, RtcPeerConnectionCode>) {
        guard guardOpen(reply) else { return }
        guard let sender = self.sender(senderId) else { return reply.reject(.notFound) }
        pc.removeTrack(sender)
        reply.resolve()
    }

    func replaceTrack(_ senderId: String, _ trackId: String?, _ reply: Reply<Void, RtcPeerConnectionCode>) {
        guard guardOpen(reply) else { return }
        guard let sender = self.sender(senderId) else { return reply.reject(.notFound) }
        if let trackId {
            guard let track = engine.track(trackId) else { return reply.reject(.notFound) }
            sender.track = track.track
        } else {
            sender.track = nil
        }
        reply.resolve()
    }

    /// A live wrapper of the sender the wire names, looked up now.
    private func sender(_ id: String) -> RTCRtpSender? {
        lock.lock()
        let native = nativeSenders[id]
        lock.unlock()
        guard let native else { return nil }
        return pc.senders.first(where: { $0.senderId == native })
    }

    private func transceiver(_ id: String) -> RTCRtpTransceiver? {
        lock.lock()
        let native = nativeReceivers[id]
        lock.unlock()
        guard let native else { return nil }
        return pc.transceivers.first(where: { $0.receiver.receiverId == native })
    }

    func getSenderParameters(_ senderId: String, _ reply: Reply<SenderParameters, RtcPeerConnectionCode>) {
        guard let sender = self.sender(senderId) else { return reply.reject(.notFound) }
        let encodings = sender.parameters.encodings.map { e in
            Encoding(rid: e.rid, active: e.isActive, maxBitrate: e.maxBitrateBps?.int32Value, maxFramerate: e.maxFramerate?.doubleValue, scaleResolutionDownBy: e.scaleResolutionDownBy?.doubleValue)
        }
        reply.resolve(SenderParameters(encodings: encodings))
    }

    func setSenderParameters(_ senderId: String, _ parameters: SenderParameters, _ reply: Reply<Void, RtcPeerConnectionCode>) {
        guard let sender = self.sender(senderId) else { return reply.reject(.notFound) }
        let current = sender.parameters
        // The encodings are matched by position (by rid when both have one): what the app says wins.
        for (i, encoding) in current.encodings.enumerated() {
            guard let wanted = parameters.encodings.first(where: { $0.rid != nil && $0.rid == encoding.rid }) ?? (i < parameters.encodings.count ? parameters.encodings[i] : nil) else { continue }
            if let v = wanted.active { encoding.isActive = v }
            if let v = wanted.maxBitrate { encoding.maxBitrateBps = NSNumber(value: v) }
            if let v = wanted.maxFramerate { encoding.maxFramerate = NSNumber(value: v) }
            if let v = wanted.scaleResolutionDownBy { encoding.scaleResolutionDownBy = NSNumber(value: v) }
        }
        sender.parameters = current
        reply.resolve()
    }

    func addTransceiver(_ kind: MediaKind, _ options: TransceiverInit?, _ reply: Reply<TransceiverInfo, RtcPeerConnectionCode>) {
        guard guardOpen(reply) else { return }
        let initv = RTCRtpTransceiverInit()
        if let d = options?.direction { initv.direction = Self.direction(d) }
        if let ids = options?.streamIds { initv.streamIds = ids }
        if let encodings = options?.sendEncodings {
            initv.sendEncodings = encodings.map { e in
                let p = RTCRtpEncodingParameters()
                p.rid = e.rid
                p.isActive = e.active ?? true
                if let v = e.maxBitrate { p.maxBitrateBps = NSNumber(value: v) }
                if let v = e.maxFramerate { p.maxFramerate = NSNumber(value: v) }
                if let v = e.scaleResolutionDownBy { p.scaleResolutionDownBy = NSNumber(value: v) }
                return p
            }
        }
        let transceiver: RTCRtpTransceiver?
        if let trackId = options?.trackId {
            guard let track = engine.track(trackId) else { return reply.reject(.notFound) }
            transceiver = pc.addTransceiver(with: track.track, init: initv)
        } else {
            transceiver = pc.addTransceiver(of: kind == .video ? .video : .audio, init: initv)
        }
        guard let transceiver else { return reply.reject(.failed) }
        reply.resolve(transceiverInfo(transceiver))
    }

    func getTransceivers(_ reply: Reply<[TransceiverInfo], RtcPeerConnectionCode>) {
        reply.resolve(pc.transceivers.map { transceiverInfo($0) })
    }

    func setTransceiverDirection(_ transceiverId: String, _ direction: TransceiverDirection, _ reply: Reply<Void, RtcPeerConnectionCode>) {
        guard let transceiver = self.transceiver(transceiverId) else { return reply.reject(.notFound) }
        var error: NSError?
        transceiver.setDirection(Self.direction(direction), error: &error)
        if error == nil { reply.resolve() } else { reply.reject(.failed) }
    }

    func stopTransceiver(_ transceiverId: String, _ reply: Reply<Void, RtcPeerConnectionCode>) {
        guard let transceiver = self.transceiver(transceiverId) else { return reply.reject(.notFound) }
        transceiver.stopInternal()
        reply.resolve()
    }

    // MARK: - stats

    func getStats(_ trackId: String?, _ reply: Reply<Any, RtcPeerConnectionCode>) {
        let done = { (report: RTCStatisticsReport) in
            var out: [String: Any] = [:]
            for (id, stats) in report.statistics {
                var entry: [String: Any] = ["id": stats.id, "type": stats.type, "timestamp": stats.timestamp_us / 1000]
                for (key, value) in stats.values { entry[key] = value }
                out[id] = entry
            }
            reply.resolve(out)
        }
        guard let trackId, let track = engine.track(trackId) else { return pc.statistics(completionHandler: done) }
        if let sender = pc.senders.first(where: { $0.track?.trackId == track.track.trackId }) {
            pc.statistics(for: sender, completionHandler: done)
        } else if let receiver = pc.receivers.first(where: { $0.track?.trackId == track.track.trackId }) {
            pc.statistics(for: receiver, completionHandler: done)
        } else {
            pc.statistics(completionHandler: done)
        }
    }

    // MARK: - data channels

    func createDataChannel(_ label: String, _ options: DataChannelInit?, _ reply: Reply<DataChannelInfo, RtcPeerConnectionCode>) {
        guard guardOpen(reply) else { return }
        let configuration = RTCDataChannelConfiguration()
        if let v = options?.ordered { configuration.isOrdered = v }
        if let v = options?.maxPacketLifeTime { configuration.maxPacketLifeTime = v }
        if let v = options?.maxRetransmits { configuration.maxRetransmits = v }
        if let v = options?.protocol { configuration.protocol = v }
        if let v = options?.negotiated { configuration.isNegotiated = v }
        if let v = options?.id { configuration.channelId = v }
        guard let channel = pc.dataChannel(forLabel: label, configuration: configuration) else { return reply.reject(.failed) }
        let handle = watch(channel, maxPacketLifeTime: options?.maxPacketLifeTime, maxRetransmits: options?.maxRetransmits)
        reply.resolve(handle.info)
    }

    private func watch(_ channel: RTCDataChannel, maxPacketLifeTime: Int32?, maxRetransmits: Int32?) -> RtcDataChannel {
        let id = engine.allocate("channel")
        let handle = RtcDataChannel(id: id, channel: channel, maxPacketLifeTime: maxPacketLifeTime, maxRetransmits: maxRetransmits, events: events) { [weak self] in
            self?.lock.lock()
            self?.channels.removeValue(forKey: id)
            self?.lock.unlock()
        }
        lock.lock()
        channels[id] = handle
        lock.unlock()
        return handle
    }

    private func channel(_ id: String) -> RtcDataChannel? {
        lock.lock(); defer { lock.unlock() }
        return channels[id]
    }

    func sendText(_ channelId: String, _ text: String, _ reply: Reply<Void, RtcPeerConnectionCode>) {
        guard let handle = channel(channelId) else { return reply.reject(.notFound) }
        guard handle.channel.readyState == .open, handle.channel.sendData(RTCDataBuffer(data: Data(text.utf8), isBinary: false)) else { return reply.reject(.closed) }
        reply.resolve()
    }

    func sendBinary(_ channelId: String, _ data: Data, _ reply: Reply<Void, RtcPeerConnectionCode>) {
        guard let handle = channel(channelId) else { return reply.reject(.notFound) }
        guard handle.channel.readyState == .open, handle.channel.sendData(RTCDataBuffer(data: data, isBinary: true)) else { return reply.reject(.closed) }
        reply.resolve()
    }

    func getBufferedAmount(_ channelId: String, _ reply: Reply<Double, RtcPeerConnectionCode>) {
        guard let handle = channel(channelId) else { return reply.reject(.notFound) }
        reply.resolve(Double(handle.channel.bufferedAmount))
    }

    func setBufferedAmountLowThreshold(_ channelId: String, _ threshold: Double, _ reply: Reply<Void, RtcPeerConnectionCode>) {
        guard let handle = channel(channelId) else { return reply.reject(.notFound) }
        handle.threshold = UInt64(max(0, threshold))
        reply.resolve()
    }

    func closeDataChannel(_ channelId: String, _ reply: Reply<Void, RtcPeerConnectionCode>) {
        channel(channelId)?.channel.close()
        reply.resolve()
    }

    // MARK: - RTCPeerConnectionDelegate (the signaling thread)

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
        let state: SignalingState
        switch stateChanged {
        case .stable: state = .stable
        case .haveLocalOffer: state = .haveLocalOffer
        case .haveLocalPrAnswer: state = .haveLocalPranswer
        case .haveRemoteOffer: state = .haveRemoteOffer
        case .haveRemotePrAnswer: state = .haveRemotePranswer
        case .closed: state = .closed
        @unknown default: state = .stable
        }
        events.signalingStateChange(state: state)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {
        events.negotiationNeeded()
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        let state: IceConnectionState
        switch newState {
        case .new: state = .new
        case .checking: state = .checking
        case .connected: state = .connected
        case .completed: state = .completed
        case .failed: state = .failed
        case .disconnected: state = .disconnected
        case .closed: state = .closed
        default: return
        }
        events.iceConnectionStateChange(state: state)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        let state: IceGatheringState
        switch newState {
        case .new: state = .new
        case .gathering: state = .gathering
        case .complete: state = .complete
        @unknown default: return
        }
        events.iceGatheringStateChange(state: state)
        if state == .complete { events.iceCandidate(candidate: nil) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        let state: PeerConnectionState
        switch newState {
        case .new: state = .new
        case .connecting: state = .connecting
        case .connected: state = .connected
        case .disconnected: state = .disconnected
        case .failed: state = .failed
        case .closed: state = .closed
        @unknown default: return
        }
        events.connectionStateChange(state: state)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        events.iceCandidate(candidate: IceCandidate(candidate: candidate.sdp, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex, usernameFragment: nil))
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        let handle = watch(dataChannel, maxPacketLifeTime: nil, maxRetransmits: nil)
        events.dataChannel(handle.info)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams mediaStreams: [RTCMediaStream]) {
        guard let track = rtpReceiver.track else { return }
        let entry = receivedTrack(track)
        events.track(track: entry.info, streamIds: mediaStreams.map { $0.streamId }, transceiverId: id(ofReceiver: rtpReceiver.receiverId))
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove rtpReceiver: RTCRtpReceiver) {
        guard let track = rtpReceiver.track else { return }
        lock.lock()
        let id = received.removeValue(forKey: track.trackId)
        lock.unlock()
        guard let id else { return }
        engine.remove(id)
        events.trackEnded(trackId: id)
    }
}

/// One data channel of a session: its delegate turned into the contract's events.
final class RtcDataChannel: NSObject, RTCDataChannelDelegate {
    let id: String
    let channel: RTCDataChannel
    private let maxPacketLifeTime: Int32?
    private let maxRetransmits: Int32?
    private let events: RtcPeerConnectionEvents
    private let onClosed: () -> Void
    var threshold: UInt64 = 0
    private var lastAmount: UInt64 = 0

    init(id: String, channel: RTCDataChannel, maxPacketLifeTime: Int32?, maxRetransmits: Int32?, events: RtcPeerConnectionEvents, onClosed: @escaping () -> Void) {
        self.id = id
        self.channel = channel
        self.maxPacketLifeTime = maxPacketLifeTime
        self.maxRetransmits = maxRetransmits
        self.events = events
        self.onClosed = onClosed
        super.init()
        channel.delegate = self
    }

    var info: DataChannelInfo {
        DataChannelInfo(
            id: id, label: channel.label, ordered: channel.isOrdered, maxPacketLifeTime: maxPacketLifeTime, maxRetransmits: maxRetransmits,
            protocol: channel.`protocol`, negotiated: channel.isNegotiated, streamId: channel.channelId >= 0 ? channel.channelId : nil,
            readyState: Self.state(channel.readyState))
    }

    private static func state(_ s: RTCDataChannelState) -> DataChannelState {
        switch s {
        case .connecting: return .connecting
        case .open: return .open
        case .closing: return .closing
        case .closed: return .closed
        @unknown default: return .closed
        }
    }

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        let state = Self.state(dataChannel.readyState)
        events.dataChannelStateChange(id: id, state: state)
        if state == .closed { onClosed() }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        if buffer.isBinary {
            events.dataChannelMessage(id: id, text: nil, binary: buffer.data)
        } else {
            events.dataChannelMessage(id: id, text: String(decoding: buffer.data, as: UTF8.self), binary: nil)
        }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didChangeBufferedAmount amount: UInt64) {
        // libwebrtc reports the change; the browser's event fires when the amount falls to the threshold.
        let now = dataChannel.bufferedAmount
        if lastAmount > threshold && now <= threshold { events.dataChannelBufferedAmountLow(id: id) }
        lastAmount = now
    }
}

extension RtcEngine {
    /// The registry id of a libwebrtc track the app holds (a local one, or a received one another
    /// connection registered); nil for one it never saw.
    func trackId(of track: RTCMediaStreamTrack) -> String? {
        for entry in allTracks() where entry.track === track || entry.track.trackId == track.trackId { return entry.id }
        return nil
    }
}
