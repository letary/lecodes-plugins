//
//  WebRTCPlugin.swift — lecodes-plugins/webrtc
//
//  The "rtcMedia" service (the devices), the "rtcPeerConnection" service (a session per
//  connection) and the "rtcVideo" view (a track drawn), over libwebrtc (the WebRTC package:
//  Google's build, stasel/WebRTC). The channels themselves — the calls, their arguments, the
//  events — are RtcMediaPlugin.gen.swift, generated from contract.d.ts.
//
//  What is shared by the three: ONE libwebrtc factory for the process and the registry of the
//  tracks by the id the wire names them with (RtcEngine). Signaling is the app's: nothing here
//  knows a room or a server.
//

import AVFoundation
import UIKit
import WebRTC
import LeCodes

public enum LeCodesWebRTCPlugin {

    public static let pluginId = "webrtc"

    public static func register(in engine: LeCodesEngine) {
        RtcMediaChannel.register(in: engine) { _, events in RtcMediaService(events) }
        RtcPeerConnectionChannel.register(in: engine) { configuration, events in RtcPeerConnectionSession(configuration, events) }
        RtcVideoChannel.register(in: engine) { params, events in RtcVideoView(params, events) }
    }
}

/// A track the app holds, by the id the wire names it with: the libwebrtc track, and for a local
/// video one its capture.
final class RtcTrack {
    let id: String
    let track: RTCMediaStreamTrack
    let remote: Bool
    let label: String
    /// A local video track's camera.
    let capture: RtcCapture?

    init(id: String, track: RTCMediaStreamTrack, remote: Bool, label: String, capture: RtcCapture? = nil) {
        self.id = id
        self.track = track
        self.remote = remote
        self.label = label
        self.capture = capture
    }

    var kind: MediaKind { track.kind == kRTCMediaStreamTrackKindVideo ? .video : .audio }

    var info: TrackInfo { TrackInfo(id: id, kind: kind, label: label, enabled: track.isEnabled, muted: nil) }
}

/// The one libwebrtc of the process, the tracks by id, the audio session. Every member is safe
/// from any thread: the calls arrive on main, libwebrtc's delegates on its signaling thread.
final class RtcEngine {
    static let shared = RtcEngine()

    let factory: RTCPeerConnectionFactory
    private let lock = NSLock()
    private var tracks: [String: RtcTrack] = [:]
    private var nextId = 1
    private var audioConfigured = false

    private init() {
        RTCInitializeSSL()
        factory = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
    }

    func allocate(_ prefix: String) -> String {
        lock.lock(); defer { lock.unlock() }
        let id = "\(prefix)\(nextId)"
        nextId += 1
        return id
    }

    func track(_ id: String) -> RtcTrack? {
        lock.lock(); defer { lock.unlock() }
        return tracks[id]
    }

    func add(_ track: RtcTrack) {
        lock.lock(); defer { lock.unlock() }
        tracks[track.id] = track
    }

    @discardableResult
    func remove(_ id: String) -> RtcTrack? {
        lock.lock(); defer { lock.unlock() }
        return tracks.removeValue(forKey: id)
    }

    func allTracks() -> [RtcTrack] {
        lock.lock(); defer { lock.unlock() }
        return Array(tracks.values)
    }

    /// The audio session of a call: play and record, voice chat, Bluetooth allowed. Set once, at
    /// the first capture — never at registration, so a project without calls keeps its own session.
    func configureAudioSession() {
        lock.lock()
        let done = audioConfigured
        audioConfigured = true
        lock.unlock()
        if done { return }
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        let configuration = RTCAudioSessionConfiguration.webRTC()
        configuration.category = AVAudioSession.Category.playAndRecord.rawValue
        configuration.mode = AVAudioSession.Mode.voiceChat.rawValue
        configuration.categoryOptions = [.allowBluetooth, .allowBluetoothA2DP]
        try? session.setConfiguration(configuration, active: true)
        session.unlockForConfiguration()
    }

    func setAudioOutput(_ output: AudioOutput) {
        configureAudioSession()
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        try? session.overrideOutputAudioPort(output == .speaker ? .speaker : .none)
        session.unlockForConfiguration()
    }
}

/// The camera behind a local video track: a capturer into a source, the format chosen for the
/// constraints, re-aimed by applyConstraints.
final class RtcCapture {
    let source: RTCVideoSource
    private let capturer: RTCCameraVideoCapturer
    private(set) var device: AVCaptureDevice?
    private(set) var width: Int32 = 0
    private(set) var height: Int32 = 0
    private(set) var frameRate = 0.0
    private(set) var facing: FacingMode = .user

    init(source: RTCVideoSource) {
        self.source = source
        capturer = RTCCameraVideoCapturer(delegate: source)
    }

    static func device(for constraints: VideoConstraints) -> AVCaptureDevice? {
        let devices = RTCCameraVideoCapturer.captureDevices()
        if let id = constraints.deviceId, let device = devices.first(where: { $0.uniqueID == id }) { return device }
        let position: AVCaptureDevice.Position = (constraints.facingMode ?? .user) == .user ? .front : .back
        return devices.first(where: { $0.position == position }) ?? devices.first
    }

    /// Start (or restart) capturing for `constraints`; `completion` tells whether the camera runs.
    func start(_ constraints: VideoConstraints, completion: @escaping (Bool) -> Void) {
        guard let device = Self.device(for: constraints) else { return completion(false) }
        let wantedWidth = Int32(constraints.width ?? (width > 0 ? width : 1280))
        let wantedHeight = Int32(constraints.height ?? (height > 0 ? height : 720))
        let wantedFps = constraints.frameRate ?? (frameRate > 0 ? frameRate : 30)
        let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
        guard let format = formats.min(by: { Self.distance($0, wantedWidth, wantedHeight) < Self.distance($1, wantedWidth, wantedHeight) }) else { return completion(false) }
        let maxFps = format.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 30
        let fps = min(wantedFps, maxFps)
        let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        self.device = device
        width = dimensions.width
        height = dimensions.height
        frameRate = fps
        facing = device.position == .front ? .user : .environment
        capturer.startCapture(with: device, format: format, fps: Int(fps)) { error in
            completion(error == nil)
        }
    }

    func stop() {
        capturer.stopCapture()
    }

    var settings: TrackSettings {
        TrackSettings(deviceId: device?.uniqueID, facingMode: facing, width: width, height: height, frameRate: frameRate)
    }

    private static func distance(_ format: AVCaptureDevice.Format, _ width: Int32, _ height: Int32) -> Int {
        let d = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        return abs(Int(d.width) - Int(width)) + abs(Int(d.height) - Int(height))
    }
}
