// The public value types of the half: the error, the options, the numbers.

import Foundation

/// The one error of the half (docs/platform-api.md, "Errors"). The core's status codes map onto it
/// and never surface as numbers.
public enum RtcError: Error, Equatable, Sendable, CustomStringConvertible {
    /// A permission is missing (camera, microphone). Asking is the app's business.
    case denied
    /// No such device, track or channel.
    case notFound
    case failed(String)
    /// The object was closed / stopped.
    case closed

    public var description: String {
        switch self {
        case .denied: return "denied"
        case .notFound: return "not found"
        case .failed(let message): return "failed: \(message)"
        case .closed: return "closed"
        }
    }
}

public enum RtcMediaKind: Sendable, Equatable {
    case audio, video
}

public enum RtcConnectionState: Sendable, Equatable {
    case new, connecting, connected
    /// The path is lost; it may come back, or an ICE restart brings it back.
    case disconnected
    case failed, closed
}

public enum CameraFacing: Sendable, Equatable {
    /// The front camera.
    case user
    /// The back camera.
    case environment
}

/// What `openCamera` / `LocalVideoTrack.apply` ask for. The half picks the closest format the camera
/// has. Width and height are of the picture as the sensor gives it: 1280 x 720 and 720 x 1280 ask
/// for the same format (the picture is never rotated, see `LocalVideoTrack`).
public struct CameraOptions: Sendable, Equatable {
    /// `RtcDevice.id` of a camera; nil = the first camera facing `facing`.
    public var deviceId: String?
    public var facing: CameraFacing
    public var width: Int
    public var height: Int
    public var frameRate: Int

    public init(deviceId: String? = nil, facing: CameraFacing = .user, width: Int = 1280, height: Int = 720, frameRate: Int = 30) {
        self.deviceId = deviceId
        self.facing = facing
        self.width = width
        self.height = height
        self.frameRate = frameRate
    }
}

/// What the camera actually runs at.
public struct CameraSettings: Sendable, Equatable {
    public var deviceId: String
    public var facing: CameraFacing
    public var width: Int
    public var height: Int
    public var frameRate: Int
}

public struct RtcDevice: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        case camera(CameraFacing)
        case microphone
        case speaker
    }
    public var id: String
    public var kind: Kind
    public var label: String
}

public struct RtcIceServer: Sendable, Equatable {
    /// "stun:host:port" (anything else is ignored: there is no TURN)
    public var url: String
    public var username: String?
    public var credential: String?

    public init(url: String, username: String? = nil, credential: String? = nil) {
        self.url = url
        self.username = username
        self.credential = credential
    }
}

public struct RtcConfiguration: Sendable, Equatable {
    public var iceServers: [RtcIceServer]
    /// Never reveal an address of this device: the only path is a relay's candidate the app adds
    /// (`typ relay`: the media server's), whatever else it adds. No candidate of its own is put
    /// into a description (an ICE restart's too) or raised as an event; of the other side's
    /// candidates — `addIceCandidate`, or inside its description — only `typ relay` ones are
    /// taken, and a datagram from any other address is dropped, so the other side never hears
    /// from this device's address. Without a relay candidate it never connects; an ICE restart
    /// needs a new relay reservation. The STUN servers of `iceServers` still see the address.
    public var relayOnly: Bool

    public init(iceServers: [RtcIceServer] = [], relayOnly: Bool = false) {
        self.iceServers = iceServers
        self.relayOnly = relayOnly
    }
}

public struct RtcDataChannelOptions: Sendable, Equatable {
    public var ordered: Bool
    /// nil = reliable. At most one of the two.
    public var maxRetransmits: Int?
    public var maxPacketLifeTimeMs: Int?

    public init(ordered: Bool = true, maxRetransmits: Int? = nil, maxPacketLifeTimeMs: Int? = nil) {
        self.ordered = ordered
        self.maxRetransmits = maxRetransmits
        self.maxPacketLifeTimeMs = maxPacketLifeTimeMs
    }
}

/// The numbers of a connection: the core's one fixed struct.
public struct RtcStats: Sendable, Equatable {
    public var state: RtcConnectionState
    /// Not reported yet: always false.
    public var relayed: Bool
    public var rttMs: UInt32
    /// What the network is believed to carry.
    public var sendEstimateBps: UInt32
    public var audioSendBps: UInt32
    public var audioRecvBps: UInt32
    public var videoSendBps: UInt32
    public var videoRecvBps: UInt32
    /// Received: the share lost, 0...1, over the last seconds.
    public var audioLoss: Float
    public var videoLoss: Float
    /// The delay the sound is played with.
    public var audioJitterBufferMs: UInt32
    public var videoRecvFps: UInt32
    public var videoNacksSent: UInt32
    public var videoKeyframesRequested: UInt32
    public var bytesSent: UInt64
    public var bytesReceived: UInt64
}

/// Where the sound of a call goes on a phone.
public enum RtcAudioOutput: Sendable, Equatable {
    /// The receiver at the ear (or a headset / Bluetooth device when one is connected).
    case earpiece
    case speaker
}

public enum RtcLogLevel: Int, Sendable, Comparable {
    case off = 0, error, warn, info, debug

    public static func < (a: RtcLogLevel, b: RtcLogLevel) -> Bool { a.rawValue < b.rawValue }
}
