//
//  RtcVideoView.swift — lecodes-plugins/webrtc
//
//  The "rtcVideo" view: one video track, local or received, drawn by libwebrtc's Metal renderer.
//  The host sizes the container; the renderer fills it.
//

import UIKit
import WebRTC
import LeCodes

final class RtcVideoView: NSObject, RtcVideoPlugin, RTCVideoViewDelegate {

    private let container = UIView()
    private let renderer = RTCMTLVideoView()
    private let events: RtcVideoEvents
    private var track: RTCVideoTrack?
    private var mirror = false

    var view: UIView { container }

    init(_ params: RtcVideoParams, _ events: RtcVideoEvents) {
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
        if let trackId = params.trackId { show(trackId) }
    }

    private func show(_ trackId: String?) -> Bool {
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

    private func apply(fit: ObjectFit) {
        renderer.videoContentMode = fit == .cover ? .scaleAspectFill : .scaleAspectFit
    }

    private func apply(mirror: Bool) {
        self.mirror = mirror
        renderer.transform = mirror ? CGAffineTransform(scaleX: -1, y: 1) : .identity
    }

    // MARK: - the calls (main thread)

    func setTrack(_ trackId: String?, _ reply: Reply<Void, RtcVideoCode>) {
        if show(trackId) { reply.resolve() } else { reply.reject(.notFound) }
    }

    func setObjectFit(_ fit: ObjectFit, _ reply: Reply<Void, RtcVideoCode>) {
        apply(fit: fit)
        reply.resolve()
    }

    func setMirror(_ mirror: Bool, _ reply: Reply<Void, RtcVideoCode>) {
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
