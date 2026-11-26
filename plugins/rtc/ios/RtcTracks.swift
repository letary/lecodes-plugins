//
//  RtcTracks.swift — lecodes-plugins/rtc
//
//  The tracks by the ids the wire names them with: what an id stands for in tinyrtc. One registry
//  for the process, shared by the channels — rtcMedia puts the local tracks in, a connection
//  session the two it receives; a connection's setTrack and the picture look them up. A wrong kind
//  (an audio id for a picture) answers like an unknown id: nothing.
//
//  Local: "audioN" / "videoN", made by getUserMedia; forgotten by stopTrack, by the track's end
//  (the OS took the device for good) and by the close of the rtcMedia session that made them.
//  Received: "rN.audio" / "rN.video", N the session's number, allocated when the session opens,
//  registered when it makes its connection, forgotten when it closes. A picture that shows an id
//  when it is forgotten goes black.
//

import Foundation

@MainActor
final class RtcTracks {

    static let shared = RtcTracks()

    enum Track {
        case microphone(LocalAudioTrack)
        /// The camera, with the options it was last opened or re-aimed with: tinyrtc's `apply`
        /// takes whole options, applyConstraints names a part of them.
        case camera(LocalVideoTrack, options: CameraOptions)
        case remoteAudio(RemoteAudioTrack)
        case remoteVideo(RemoteVideoTrack)

        var kind: MediaKind {
            switch self {
            case .microphone, .remoteAudio: return .audio
            case .camera, .remoteVideo: return .video
            }
        }
    }

    private var tracks: [String: Track] = [:]
    private var nextLocal = 1
    private var nextConnection = 1
    /// The live pictures, for the ones showing an id that is forgotten.
    private let pictures = NSHashTable<RtcPicture>.weakObjects()

    private init() {}

    /// A local track under a new id.
    func add(_ track: Track) -> String {
        let id = "\(track.kind.rawValue)\(nextLocal)"
        nextLocal += 1
        tracks[id] = track
        return id
    }

    /// The ids of a connection's two received tracks (put in with `set` when it is made).
    func remoteIds() -> (audio: String, video: String) {
        let n = nextConnection
        nextConnection += 1
        return ("r\(n).audio", "r\(n).video")
    }

    func set(_ id: String, _ track: Track) {
        tracks[id] = track
    }

    func track(_ id: String) -> Track? {
        tracks[id]
    }

    /// A local track of `kind` (any kind when nil): what a connection sends, what rtcMedia drives.
    func local(_ id: String, _ kind: MediaKind? = nil) -> (any RtcLocalTrack)? {
        switch tracks[id] {
        case .microphone(let track)? where kind != .video: return track
        case .camera(let track, _)? where kind != .audio: return track
        default: return nil
        }
    }

    /// What a picture shows: a local camera's preview or a received picture.
    func video(_ id: String) -> (any RtcVideoTrack)? {
        switch tracks[id] {
        case .camera(let track, _)?: return track
        case .remoteVideo(let track)?: return track
        default: return nil
        }
    }

    func forget(_ id: String) {
        guard tracks.removeValue(forKey: id) != nil else { return }
        for picture in pictures.allObjects where picture.trackId == id { picture.show(nil) }
    }

    func watch(_ picture: RtcPicture) {
        pictures.add(picture)
    }
}

extension MediaKind {
    var rtc: RtcMediaKind { self == .audio ? .audio : .video }
}

extension RtcMediaKind {
    var wire: MediaKind { self == .audio ? .audio : .video }
}
