//
//  RtcPicture.swift — lecodes-plugins/rtc
//
//  The ONE picture class under both surfaces of a track's picture (contract.d.ts): a black
//  container the host sizes, holding one tinyrtc RtcVideoView — a local camera's preview or a
//  received picture, which it decodes, turns upright and fits (its size as shown is the `resize`
//  event). No track = the RtcVideoView hidden: the black container shows, whatever last frame the
//  view may keep. Two thin instances wrap it:
//   - the VIEW "rtcVideo" (RtcVideoViewInstance): the fullscreen picture the app pushes or opens;
//     its params are read at creation, the calls change them after;
//   - the HOST NODE "rtcVideo" (RtcVideoNodeInstance): the picture as a box of a screen's layout,
//     laid out and painted by the core's holder (UINodeHost); its props `trackId`, `objectFit`,
//     `mirror` are LIVE, each write doing what the method of its name does.
//
//  The calls are the contract's RtcVideoMethods, one set for both surfaces: generic over the
//  surface's generated code enum (RtcPictureCode); `resize` goes out through the surface's
//  generated events (RtcPictureEvents).
//

import UIKit
import LeCodes

/// The codes the picture's calls reject with: each surface's generated enum has them.
protocol RtcPictureCode: PluginCode {
    static var notFound: Self { get }
}
extension RtcVideoCode: RtcPictureCode {}
extension UIRTCVideoNodeCode: RtcPictureCode {}

/// What the picture tells the app: each surface's generated events.
protocol RtcPictureEvents {
    func resize(width: Int32, height: Int32)
}
extension RtcVideoEvents: RtcPictureEvents {}
extension UIRTCVideoNodeEvents: RtcPictureEvents {}

@MainActor
final class RtcPicture {

    let container = UIView()
    private let video = RtcVideoView(frame: .zero)
    private let events: RtcPictureEvents
    /// The id shown; nil = black.
    private(set) var trackId: String?

    init(_ params: RtcVideoParams, _ events: RtcPictureEvents) {
        self.events = events
        container.backgroundColor = .black
        container.clipsToBounds = true
        video.frame = container.bounds
        video.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        video.isHidden = true
        container.addSubview(video)
        video.onResize = { [weak self] width, height in
            self?.events.resize(width: Int32(clamping: width), height: Int32(clamping: height))
        }
        RtcTracks.shared.watch(self)
        set(fit: params.objectFit ?? .cover)
        set(mirror: params.mirror ?? false)
        if let trackId = params.trackId, !show(trackId) { Self.missing(trackId) }
    }

    /// Show `trackId`, nil = black. False when it names no video track: the picture is black then.
    @discardableResult
    func show(_ trackId: String?) -> Bool {
        let track = trackId.flatMap { RtcTracks.shared.video($0) }
        self.trackId = track == nil ? nil : trackId
        video.track = track
        video.isHidden = track == nil
        return trackId == nil || track != nil
    }

    func set(fit: ObjectFit) {
        video.objectFit = fit == .contain ? .contain : .cover
    }

    func set(mirror: Bool) {
        video.mirror = mirror
    }

    static func missing(_ trackId: String) {
        print("[rtc] rtcVideo: no video track \"\(trackId)\" — the picture is black")
    }

    // MARK: - RtcVideoMethods

    func setTrack<C: RtcPictureCode>(_ trackId: String?, _ reply: Reply<Void, C>) {
        if show(trackId) { reply.resolve() } else { reply.reject(.notFound) }
    }

    func setObjectFit<C: RtcPictureCode>(_ fit: ObjectFit, _ reply: Reply<Void, C>) {
        set(fit: fit)
        reply.resolve()
    }

    func setMirror<C: RtcPictureCode>(_ mirror: Bool, _ reply: Reply<Void, C>) {
        set(mirror: mirror)
        reply.resolve()
    }
}

// MARK: - The View

/// The view "rtcVideo": a picture made from the View's params, its container the View's.
final class RtcVideoViewInstance: RtcVideoPlugin {
    private let picture: RtcPicture

    init(_ params: RtcVideoParams, _ events: RtcVideoEvents) {
        picture = MainActor.assumeIsolated { RtcPicture(params, events) }
    }

    var view: UIView { MainActor.assumeIsolated { picture.container } }

    func setTrack(_ trackId: String?, _ reply: Reply<Void, RtcVideoCode>) {
        MainActor.assumeIsolated { picture.setTrack(trackId, reply) }
    }

    func setObjectFit(_ fit: ObjectFit, _ reply: Reply<Void, RtcVideoCode>) {
        MainActor.assumeIsolated { picture.setObjectFit(fit, reply) }
    }

    func setMirror(_ mirror: Bool, _ reply: Reply<Void, RtcVideoCode>) {
        MainActor.assumeIsolated { picture.setMirror(mirror, reply) }
    }

    /// The instance goes: the picture lets go of its track.
    func destroy() {
        MainActor.assumeIsolated { _ = picture.show(nil) }
    }
}

// MARK: - The host node

/// The host node "rtcVideo": a picture as the node's box, its props applied as they come.
final class RtcVideoNodeInstance: UIRTCVideoNodeInstance {
    private let picture: RtcPicture

    init(_ events: UIRTCVideoNodeEvents) {
        picture = MainActor.assumeIsolated { RtcPicture(RtcVideoParams(), events) }
    }

    var view: UIView { MainActor.assumeIsolated { picture.container } }

    func set(trackId: String?) {
        MainActor.assumeIsolated {
            if !picture.show(trackId), let trackId { RtcPicture.missing(trackId) }
        }
    }

    func set(objectFit: ObjectFit?) {
        MainActor.assumeIsolated { picture.set(fit: objectFit ?? .cover) }
    }

    func set(mirror: Bool?) {
        MainActor.assumeIsolated { picture.set(mirror: mirror ?? false) }
    }

    func setTrack(_ trackId: String?, _ reply: Reply<Void, UIRTCVideoNodeCode>) {
        MainActor.assumeIsolated { picture.setTrack(trackId, reply) }
    }

    func setObjectFit(_ fit: ObjectFit, _ reply: Reply<Void, UIRTCVideoNodeCode>) {
        MainActor.assumeIsolated { picture.setObjectFit(fit, reply) }
    }

    func setMirror(_ mirror: Bool, _ reply: Reply<Void, UIRTCVideoNodeCode>) {
        MainActor.assumeIsolated { picture.setMirror(mirror, reply) }
    }

    /// The node is released: the picture lets go of its track.
    func destroy() {
        MainActor.assumeIsolated { _ = picture.show(nil) }
    }
}
