// What touches the C face directly: the context, the status codes, the log, the worker queues.
//
// THREADS (the header's rules, and what this half adds to them):
// - A SYNC function of the header waits for a connection's thread. It is only ever called on that
//   connection's worker queue (ConnectionCore.queue), never on the main thread.
// - The core's callbacks run on core threads. They copy what they need and hop with an `async`
//   (main queue, an encoder queue, a view's queue); they never wait on anything and never call into
//   the core. (Calling a connection function from inside a callback could deadlock: the caller of a
//   SYNC function holds the connection's lock while it waits for the very thread that is in the
//   callback.)
// - A handle lives in a final class whose deinit destroys it; whoever needs it alive holds the class.

import Foundation
import os
import TinyRTCCore

let log = Logger(subsystem: "tinyrtc", category: "apple")
private let coreLogger = Logger(subsystem: "tinyrtc", category: "core")

/// The core's context: the process's audio engine and the local sources. Destroyed when the last
/// holder (the engine, the audio device, a connection, a video source) lets go.
final class CoreContext: @unchecked Sendable {
    let raw: OpaquePointer

    init(logLevel: RtcLogLevel) {
        var config = tinyrtc_context_config()
        if logLevel != .off { config.log = coreLog }
        config.log_level = tinyrtc_log_level(rawValue: UInt32(logLevel.rawValue))
        config.user = nil
        guard let raw = tinyrtc_context_create(&config) else {
            fatalError("tinyrtc_context_create returned NULL")
        }
        precondition(tinyrtc_abi_version() == TINYRTC_ABI_VERSION, "the core's ABI is not the header's")
        self.raw = raw
    }

    deinit {
        tinyrtc_context_destroy(raw)
    }
}

private func coreLog(_ user: UnsafeMutableRawPointer?, _ level: tinyrtc_log_level, _ line: UnsafePointer<CChar>?) {
    guard let line else { return }
    let text = String(cString: line)
    switch level {
    case TINYRTC_LOG_ERROR: coreLogger.error("\(text, privacy: .public)")
    case TINYRTC_LOG_WARN: coreLogger.warning("\(text, privacy: .public)")
    case TINYRTC_LOG_INFO: coreLogger.info("\(text, privacy: .public)")
    default: coreLogger.debug("\(text, privacy: .public)")
    }
}

extension RtcError {
    /// A status of the core as the half's error; nil for TINYRTC_OK.
    static func from(_ status: tinyrtc_status, _ what: String) -> RtcError? {
        switch status {
        case TINYRTC_OK: return nil
        case TINYRTC_ERR_HANDLE: return .closed
        case TINYRTC_ERR_ARGUMENT: return .failed("\(what): a malformed argument")
        case TINYRTC_ERR_STATE: return .failed("\(what): not in this state")
        case TINYRTC_ERR_SDP: return .failed("\(what): the description does not parse or is outside the profile")
        case TINYRTC_ERR_NOT_FOUND: return .notFound
        case TINYRTC_ERR_CLOSED: return .closed
        default: return .failed("\(what): status \(status.rawValue)")
        }
    }

    static func check(_ status: tinyrtc_status, _ what: String) throws {
        if let error = from(status, what) { throw error }
    }
}

extension tinyrtc_state {
    var swift: RtcConnectionState {
        switch self {
        case TINYRTC_STATE_NEW: return .new
        case TINYRTC_STATE_CONNECTING: return .connecting
        case TINYRTC_STATE_CONNECTED: return .connected
        case TINYRTC_STATE_DISCONNECTED: return .disconnected
        case TINYRTC_STATE_FAILED: return .failed
        default: return .closed
        }
    }
}

/// Takes the core's text (an SDP) and frees it.
func take(_ text: tinyrtc_text) -> String {
    guard let data = text.data else { return "" }
    let string = String(cString: data)
    tinyrtc_text_free(text)
    return string
}

/// A value that crosses to the main queue in an event hop. The core's events carry only copies.
struct Unchecked<T>: @unchecked Sendable {
    let value: T
}

extension DispatchQueue {
    /// `work` on this queue, awaited. The work item is queued before this returns control, so calls
    /// made in a row from the main actor run in that order.
    func run<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            self.async { continuation.resume(with: Result { try work() }) }
        }
    }
}

/// The main queue, in order (a `Task { @MainActor }` is not ordered), for the core's events.
func onMain(_ work: @escaping @MainActor @Sendable () -> Void) {
    DispatchQueue.main.async { MainActor.assumeIsolated(work) }
}

/// A weak reference for the registries of the main actor.
struct Weak<T: AnyObject> {
    weak var value: T?
}

/// A weak reference to a main-thread object, carried through a hop to the main thread (and read
/// only there).
final class MainWeak<T: AnyObject>: @unchecked Sendable {
    weak var value: T?

    init(_ value: T) {
        self.value = value
    }
}

/// A small lock around a value, for state shared between a core thread and a queue of ours.
final class Locked<Value>: @unchecked Sendable {
    private var value: Value
    private let lock = NSLock()

    init(_ value: Value) { self.value = value }

    func read<R>(_ body: (Value) -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return body(value)
    }

    @discardableResult
    func write<R>(_ body: (inout Value) -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }

    var get: Value { read { $0 } }
}
