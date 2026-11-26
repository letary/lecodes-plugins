//
//  RtcConnectionSession.swift — lecodes-plugins/rtc
//
//  One session of the "rtcConnection" service = one tinyrtc RtcConnection (one peer), made with the
//  session's params at the first call that needs it (a session opens cheaply: no socket before it
//  is used) and closed with the session. Its two received tracks are in RtcTracks under the ids the
//  session allocated when it opened ("rN.audio" / "rN.video"); its data channels are kept here
//  under integer ids of its own, the same for a channel it opened and one the other side opened.
//
//  Every call runs through one queue, in the order it came: two sends arrive in the order they
//  were made, a candidate goes in after the description before it. close() does not wait: what is
//  still queued rejects with `closed`, and nothing is raised after it.
//

import Foundation
import LeCodes

@MainActor
final class RtcConnectionSession: RtcConnectionPlugin {

    /// nil once the session closed: nothing is raised after it.
    private var events: RtcConnectionEvents?
    private let configuration: RtcConfiguration
    private let remote: (audio: String, video: String)
    private var connection: RtcConnection?
    private var channels: [Int32: RtcDataChannel] = [:]
    private var nextChannel: Int32 = 1
    private let calls = RtcCallQueue()
    private var closed = false

    init(_ params: RtcConnectionParams, _ events: RtcConnectionEvents) {
        self.events = events
        // tinyrtc's server is one url.
        configuration = RtcConfiguration(
            iceServers: (params.iceServers ?? []).flatMap { server in server.urls.map { RtcIceServer(url: $0) } },
            relayOnly: params.relayOnly ?? false)
        remote = RtcTracks.shared.remoteIds()
    }

    nonisolated func close() {
        MainActor.assumeIsolated {
            guard !closed else { return }
            closed = true
            events = nil
            channels = [:]
            // tinyrtc's close is silent and closes the channels with it.
            connection?.close()
            RtcTracks.shared.forget(remote.audio)
            RtcTracks.shared.forget(remote.video)
        }
    }

    /// The connection, made at the first call that needs it; `closed` after the session's close.
    private func live() throws -> RtcConnection {
        if closed { throw RtcError.closed }
        if let connection { return connection }
        let made = try RtcEngine.shared.connect(configuration)
        made.onStateChange = { [weak self] state in self?.events?.stateChange(state: state.wire) }
        made.onIceCandidate = { [weak self] line in self?.events?.iceCandidate(candidate: line) }
        made.onIceRestartNeeded = { [weak self] in self?.events?.iceRestartNeeded() }
        made.onRemoteMedia = { [weak self] kind, active in self?.events?.remoteMedia(kind: kind.wire, active: active) }
        made.onDataChannel = { [weak self] channel in
            guard let self else { return }
            // The other side's: it arrives open.
            let id = adopt(channel)
            events?.dataChannelOpen(id: id, label: channel.label)
        }
        RtcTracks.shared.set(remote.audio, .remoteAudio(made.remoteAudio))
        RtcTracks.shared.set(remote.video, .remoteVideo(made.remoteVideo))
        connection = made
        return made
    }

    // MARK: - signaling

    nonisolated func createOffer(_ iceRestart: Bool?, _ reply: Reply<String, RtcConnectionCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "createOffer") { try await self.live().createOffer(iceRestart: iceRestart ?? false) }
        }
    }

    nonisolated func acceptOffer(_ offer: String, _ reply: Reply<String, RtcConnectionCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "acceptOffer") { try await self.live().acceptOffer(offer) }
        }
    }

    nonisolated func acceptAnswer(_ answer: String, _ reply: Reply<Void, RtcConnectionCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "acceptAnswer") { try await self.live().acceptAnswer(answer) }
        }
    }

    nonisolated func addIceCandidate(_ candidate: String, _ reply: Reply<Void, RtcConnectionCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "addIceCandidate") {
                // The contract rejects nothing here: a candidate that comes after the close is dropped.
                guard !self.closed else { return }
                // An empty line is the end of the other side's candidates, as in the browser.
                try self.live().addIceCandidate(candidate.isEmpty ? nil : candidate)
            }
        }
    }

    // MARK: - media

    nonisolated func setTrack(_ kind: MediaKind, _ trackId: String?, _ reply: Reply<Void, RtcConnectionCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "setTrack") {
                let connection = try self.live()
                var track: (any RtcLocalTrack)?
                if let trackId {
                    guard let found = RtcTracks.shared.local(trackId, kind) else { throw RtcError.notFound }
                    track = found
                }
                try connection.setTrack(kind.rtc, track)
            }
        }
    }

    nonisolated func getRemoteTracks(_ reply: Reply<RtcConnectionGetRemoteTracksResult, RtcConnectionCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "getRemoteTracks") {
                let connection = try self.live()
                return RtcConnectionGetRemoteTracksResult(
                    audio: TrackInfo(id: self.remote.audio, kind: .audio, label: "", enabled: true, muted: !connection.remoteAudio.isActive),
                    video: TrackInfo(id: self.remote.video, kind: .video, label: "", enabled: true, muted: !connection.remoteVideo.isActive))
            }
        }
    }

    nonisolated func setRemoteAudioMuted(_ muted: Bool, _ reply: Reply<Void, RtcConnectionCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "setRemoteAudioMuted") { try self.live().remoteAudio.isMuted = muted }
        }
    }

    nonisolated func getStats(_ reply: Reply<ConnectionStats, RtcConnectionCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "getStats") {
                let stats = try await self.live().stats()
                return ConnectionStats(stats)
            }
        }
    }

    // MARK: - data channels

    nonisolated func createDataChannel(_ label: String, _ options: DataChannelInit?, _ reply: Reply<Int32, RtcConnectionCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "createDataChannel") {
                let channel = try await self.live().createDataChannel(label, options: RtcDataChannelOptions(
                    ordered: options?.ordered ?? true,
                    maxRetransmits: options?.maxRetransmits.map { Int($0) },
                    maxPacketLifeTimeMs: options?.maxPacketLifeTime.map { Int($0) }))
                return self.adopt(channel)
            }
        }
    }

    nonisolated func sendText(_ channelId: Int32, _ text: String, _ reply: Reply<Void, RtcConnectionCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "sendText") { try await self.channel(channelId).send(text) }
        }
    }

    nonisolated func sendBinary(_ channelId: Int32, _ data: Data, _ reply: Reply<Void, RtcConnectionCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "sendBinary") { try await self.channel(channelId).send(data) }
        }
    }

    nonisolated func getBufferedAmount(_ channelId: Int32, _ reply: Reply<Double, RtcConnectionCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "getBufferedAmount") {
                let bytes = try await self.channel(channelId).bufferedAmount()
                return Double(bytes)
            }
        }
    }

    nonisolated func setBufferedAmountLowThreshold(_ channelId: Int32, _ threshold: Double, _ reply: Reply<Void, RtcConnectionCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "setBufferedAmountLowThreshold") {
                try self.channel(channelId).bufferedAmountLowThreshold = UInt64(min(max(threshold, 0), 9e15))
            }
        }
    }

    nonisolated func closeDataChannel(_ channelId: Int32, _ reply: Reply<Void, RtcConnectionCode>) {
        MainActor.assumeIsolated {
            calls.run(reply, "closeDataChannel") {
                guard let channel = self.channels.removeValue(forKey: channelId) else { return }
                channel.close()
                // tinyrtc's close is silent; the contract's channel closes like the browser's, which
                // says so on this side too.
                self.events?.dataChannelClose(id: channelId)
            }
        }
    }

    private func channel(_ id: Int32) throws -> RtcDataChannel {
        if closed { throw RtcError.closed }
        guard let channel = channels[id] else { throw RtcError.notFound }
        return channel
    }

    /// `channel` under the session's next id, its events raised with that id.
    private func adopt(_ channel: RtcDataChannel) -> Int32 {
        let id = nextChannel
        nextChannel += 1
        channels[id] = channel
        let label = channel.label
        channel.onOpen = { [weak self] in self?.events?.dataChannelOpen(id: id, label: label) }
        channel.onMessage = { [weak self] message in
            switch message {
            case .text(let text): self?.events?.dataChannelMessage(id: id, text: text)
            case .binary(let data): self?.events?.dataChannelMessage(id: id, binary: data)
            }
        }
        channel.onBufferedAmountLow = { [weak self] in self?.events?.dataChannelBufferedAmountLow(id: id) }
        channel.onClose = { [weak self] in
            self?.channels[id] = nil
            self?.events?.dataChannelClose(id: id)
        }
        return id
    }
}

extension RtcConnectionState {
    var wire: ConnectionState {
        switch self {
        case .new: return .new
        case .connecting: return .connecting
        case .connected: return .connected
        case .disconnected: return .disconnected
        case .failed: return .failed
        case .closed: return .closed
        }
    }
}

extension ConnectionStats {
    init(_ s: RtcStats) {
        self.init(state: s.state.wire, rttMs: Int32(clamping: s.rttMs), sendEstimate: Int32(clamping: s.sendEstimateBps),
                  audioSendBitrate: Int32(clamping: s.audioSendBps), audioRecvBitrate: Int32(clamping: s.audioRecvBps),
                  videoSendBitrate: Int32(clamping: s.videoSendBps), videoRecvBitrate: Int32(clamping: s.videoRecvBps),
                  audioLoss: Double(s.audioLoss), videoLoss: Double(s.videoLoss),
                  audioJitterBufferMs: Int32(clamping: s.audioJitterBufferMs), videoRecvFps: Int32(clamping: s.videoRecvFps),
                  bytesSent: Double(s.bytesSent), bytesReceived: Double(s.bytesReceived))
    }
}
