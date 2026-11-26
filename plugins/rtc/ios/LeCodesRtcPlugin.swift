//
//  LeCodesRtcPlugin.swift — lecodes-plugins/rtc
//
//  The "rtcMedia" service (the devices), the "rtcConnection" service (a session per peer) and the
//  picture of a track on its two surfaces — the "rtcVideo" view (fullscreen) and the "rtcVideo"
//  host node (a box of a screen's layout), one picture class under both (RtcPicture.swift) — over
//  tinyrtc: its Swift half is vendored as sources in tinyrtc/ (hash-locked, never edited here), its
//  core is the TinyRTCCore xcframework. The channels themselves — the calls, their arguments, the
//  props, the events — are RtcMediaPlugin.gen.swift, generated from contract.d.ts.
//
//  What the channels share: tinyrtc's RtcEngine (one per process) and the registry of the tracks
//  by the ids the wire names them with (RtcTracks). Signaling is the app's: nothing here knows a
//  room or a server.
//
//  Threads: tinyrtc is main-actor and async, the generated protocols are plain and called on the
//  main thread. The half's own classes are main-actor; a call enters through
//  `MainActor.assumeIsolated`, and what awaits tinyrtc runs in a Task — through RtcCallQueue where
//  the order of the calls matters.
//

import Foundation
import LeCodes

public enum LeCodesRtcPlugin {

    public static let pluginId = "rtc"

    public static func register(in engine: LeCodesEngine) {
        let permissions = engine.permissions
        RtcMediaChannel.register(in: engine) { _, events in
            let service: RtcMediaService = MainActor.assumeIsolated { RtcMediaService(permissions, events) }
            return service
        }
        RtcConnectionChannel.register(in: engine) { params, events in
            let session: RtcConnectionSession = MainActor.assumeIsolated { RtcConnectionSession(params, events) }
            return session
        }
        RtcVideoChannel.register(in: engine) { params, events in RtcVideoViewInstance(params, events) }
        UIRTCVideoNodeGlue.register(in: engine) { events in RtcVideoNodeInstance(events) }
    }
}

// MARK: - The errors

/// The contract's codes tinyrtc's one error maps onto: each service's generated enum.
protocol RtcRejection: PluginCode {
    static func of(_ error: RtcError) -> Self
}

extension RtcMediaCode: RtcRejection {
    static func of(_ error: RtcError) -> RtcMediaCode {
        switch error {
        case .denied: return .denied
        // A track stopped under the call is a track that is gone.
        case .notFound, .closed: return .notFound
        case .failed: return .failed
        }
    }
}

extension RtcConnectionCode: RtcRejection {
    static func of(_ error: RtcError) -> RtcConnectionCode {
        switch error {
        case .notFound: return .notFound
        case .closed: return .closed
        case .denied, .failed: return .failed
        }
    }
}

extension Reply where Code: RtcRejection {
    /// Reject with the code `error` maps onto. A code carries no message: a failure's goes to the log.
    func reject(_ error: Error, in call: String) {
        let rtc = error as? RtcError ?? .failed(String(describing: error))
        if case .failed(let message) = rtc { print("[rtc] \(call): \(message)") }
        reject(Code.of(rtc))
    }
}

// MARK: - The order of the calls

/// The calls of a session that must run in the order they came — two sends, a candidate after the
/// description it belongs to, a constraint over the one before it. Each starts when the one before
/// it has settled: a `Task` alone is not ordered.
@MainActor
final class RtcCallQueue {
    private var last: Task<Void, Never>?

    func run<Value, Code: RtcRejection>(_ reply: Reply<Value, Code>, _ call: String, _ work: @escaping @MainActor () async throws -> Value) {
        let previous = last
        last = Task { @MainActor in
            await previous?.value
            do {
                let value = try await work()
                reply.resolve(value)
            } catch {
                reply.reject(error, in: call)
            }
        }
    }
}
