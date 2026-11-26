// One data channel of a connection.

import Foundation
import TinyRTCCore

@MainActor
public final class RtcDataChannel {
    public enum State: Sendable, Equatable {
        case connecting, open, closed
    }

    public enum Message: Sendable, Equatable {
        case text(String)
        case binary(Data)
    }

    public let label: String
    public private(set) var state: State

    public var onOpen: (() -> Void)?
    public var onMessage: ((Message) -> Void)?
    public var onBufferedAmountLow: (() -> Void)?
    /// The other side (or the connection's end) closed it. Not after `close()`.
    public var onClose: (() -> Void)?

    /// `onBufferedAmountLow` fires when `bufferedAmount()` falls to this many bytes.
    public var bufferedAmountLowThreshold: UInt64 = 0 {
        didSet {
            let (id, threshold) = (id, bufferedAmountLowThreshold)
            core.post { _ = tinyrtc_channel_set_buffered_low($0, id, threshold) }
        }
    }

    /// The core's id of the channel (the one its events carry).
    let id: UInt32
    private weak var connection: RtcConnection?
    private let core: ConnectionCore

    init(id: UInt32, label: String, connection: RtcConnection, open: Bool) {
        self.id = id
        self.label = label
        self.connection = connection
        core = connection.core
        state = open ? .open : .connecting
    }

    public func send(_ text: String) async throws {
        try await send(Data(text.utf8), binary: false)
    }

    public func send(_ bytes: Data) async throws {
        try await send(bytes, binary: true)
    }

    private func send(_ data: Data, binary: Bool) async throws {
        guard state != .closed else { throw RtcError.closed }
        let id = id
        // The header does not mark it SYNC, but it waits for the connection's thread (its status
        // is the driver's answer): the worker queue.
        try await core.call { handle in
            let status = data.withUnsafeBytes { raw in
                tinyrtc_channel_send(handle, id, raw.bindMemory(to: UInt8.self).baseAddress, raw.count, binary ? 1 : 0)
            }
            try RtcError.check(status, "send")
        }
    }

    /// Bytes queued and not yet sent.
    public func bufferedAmount() async throws -> UInt64 {
        guard state != .closed else { throw RtcError.closed }
        let id = id
        return try await core.call { handle in
            var bytes: UInt64 = 0
            try RtcError.check(tinyrtc_channel_buffered(handle, id, &bytes), "bufferedAmount")
            return bytes
        }
    }

    /// Idempotent; no event of this channel arrives after it returns.
    public func close() {
        guard state != .closed else { return }
        state = .closed
        let id = id
        core.post { _ = tinyrtc_channel_close($0, id) }
        connection?.forget(self)
    }

    // MARK: from the connection, on the main thread

    func opened() {
        guard state == .connecting else { return }
        state = .open
        onOpen?()
    }

    func received(_ data: Data, binary: Bool) {
        guard state != .closed else { return }
        if binary {
            onMessage?(.binary(data))
        } else {
            onMessage?(.text(String(decoding: data, as: UTF8.self)))
        }
    }

    func bufferedLow() {
        guard state != .closed else { return }
        onBufferedAmountLow?()
    }

    func closedByCore() {
        guard state != .closed else { return }
        state = .closed
        onClose?()
    }

    /// The connection was closed by the app: silent, as `close()`.
    func connectionClosed() {
        state = .closed
    }
}
