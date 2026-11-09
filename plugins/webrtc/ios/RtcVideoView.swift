//
//  RtcVideoView.swift — lecodes-plugins/webrtc
//
//  The ONE video class behind both surfaces of the picture (contract.d.ts): one video track, local
//  or received, drawn by libwebrtc's Metal renderer into a black container the host sizes. Two thin
//  instances wrap it:
//   - the VIEW "rtcVideo" (RtcVideoViewInstance): the fullscreen picture the app pushes or opens;
//     its params are read at creation, the calls change them after;
//   - the HOST NODE "rtcVideo" (RtcVideoNodeInstance): the picture as a box of a screen's layout,
//     laid out and painted by the core's holder (UINodeHost); its props `trackId`, `objectFit`,
//     `mirror` are LIVE, each write applied as it comes (none needs the others: no commit to wait
//     for).
//
//  The calls are the contract's RtcVideoMethods, one set for both surfaces: generic over the
//  surface's generated code enum (VideoCode). The `resize` event goes through the surface's
//  generated events struct (VideoEventSink).
//

import UIKit
import WebRTC
import LeCodes

/// The codes the picture's calls reject with — the contract's RtcVideoMethods, the same for both
/// surfaces: each surface's generated enum has them as cases.
protocol VideoCode: PluginCode {
    static var notFound: Self { get }
}
extension RtcVideoCode: VideoCode {}
extension UIRTCVideoNodeCode: VideoCode {}

/// What the picture tells the app — the contract's RtcVideoEvents: each surface's generated events
/// struct.
protocol VideoEventSink {
    func resize(width: Int32, height: Int32)
}
extension RtcVideoEvents: VideoEventSink {}
extension UIRTCVideoNodeEvents: VideoEventSink {}

final class RtcVideoView: NSObject, RTCVideoViewDelegate {

    let container = UIView()
    private let renderer = RTCMTLVideoView()
    private let events: VideoEventSink
    private var track: RTCVideoTrack?

    init(_ params: RtcVideoParams, _ events: VideoEventSink) {
        self.events = events
        super.init()
        container.backgroundColor = .black
        container.clipsToBounds = true
        renderer.delegate = self
        renderer.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        renderer.frame = container.bounds
        container.addSubview(renderer)
        apply(fit: params.objectFit ?? .cover)
        apply(mirror: params.mirror ?? false)
        if let trackId = params.trackId { _ = show(trackId) }
    }

    /// Draw `trackId` (nil = black); false when no track of that id is known.
    func show(_ trackId: String?) -> Bool {
        if let track { track.remove(renderer) }
        track = nil
        // Without a track the Metal view would keep its last frame: hidden, the black container shows.
        renderer.isHidden = true
        guard let trackId else { return true }
        guard let found = RtcEngine.shared.track(trackId), let video = found.track as? RTCVideoTrack else { return false }
        track = video
        renderer.isHidden = false
        video.add(renderer)
        return true
    }

    func apply(fit: ObjectFit) {
        renderer.videoContentMode = fit == .cover ? .scaleAspectFill : .scaleAspectFit
    }

    func apply(mirror: Bool) {
        renderer.transform = mirror ? CGAffineTransform(scaleX: -1, y: 1) : .identity
    }

    // MARK: - RtcVideoMethods (main thread)

    func setTrack<C: VideoCode>(_ trackId: String?, _ reply: Reply<Void, C>) {
        if show(trackId) { reply.resolve() } else { reply.reject(.notFound) }
    }

    func setObjectFit<C: VideoCode>(_ fit: ObjectFit, _ reply: Reply<Void, C>) {
        apply(fit: fit)
        reply.resolve()
    }

    func setMirror<C: VideoCode>(_ mirror: Bool, _ reply: Reply<Void, C>) {
        apply(mirror: mirror)
        reply.resolve()
    }

    func destroy() {
        _ = show(nil)
    }

    // MARK: - RTCVideoViewDelegate

    func videoView(_ videoView: RTCVideoRenderer, didChangeVideoSize size: CGSize) {
        events.resize(width: Int32(size.width), height: Int32(size.height))
    }
}

// MARK: - The View

/// The view "rtcVideo": an RtcVideoView made from the View's params, its container the View's.
final class RtcVideoViewInstance: RtcVideoPlugin {
    private let video: RtcVideoView

    var view: UIView { video.container }

    init(_ params: RtcVideoParams, _ events: RtcVideoEvents) {
        video = RtcVideoView(params, events)
    }

    func setTrack(_ trackId: String?, _ reply: Reply<Void, RtcVideoCode>) { video.setTrack(trackId, reply) }
    func setObjectFit(_ fit: ObjectFit, _ reply: Reply<Void, RtcVideoCode>) { video.setObjectFit(fit, reply) }
    func setMirror(_ mirror: Bool, _ reply: Reply<Void, RtcVideoCode>) { video.setMirror(mirror, reply) }

    func destroy() { video.destroy() }
}

// MARK: - The host node

/// The host node "rtcVideo": an RtcVideoView as the node's box, its props applied as they come.
final class RtcVideoNodeInstance: UIRTCVideoNodeInstance {
    private let video: RtcVideoView
    /// The track ids no track was known for — logged once each.
    private var missing: Set<String> = []

    var view: UIView { video.container }

    init(_ events: UIRTCVideoNodeEvents) {
        video = RtcVideoView(RtcVideoParams(), events)
    }

    func set(trackId: String?) {
        if !video.show(trackId), let trackId, missing.insert(trackId).inserted {
            print("LeCodes: UIRTCVideoNode: no track \"\(trackId)\" — the node shows black")
        }
    }
    func set(objectFit: ObjectFit?) { video.apply(fit: objectFit ?? .cover) }
    func set(mirror: Bool?) { video.apply(mirror: mirror ?? false) }

    func setTrack(_ trackId: String?, _ reply: Reply<Void, UIRTCVideoNodeCode>) { video.setTrack(trackId, reply) }
    func setObjectFit(_ fit: ObjectFit, _ reply: Reply<Void, UIRTCVideoNodeCode>) { video.setObjectFit(fit, reply) }
    func setMirror(_ mirror: Bool, _ reply: Reply<Void, UIRTCVideoNodeCode>) { video.setMirror(mirror, reply) }

    /// The node released: the track lets go of the renderer.
    func destroy() { video.destroy() }
}
