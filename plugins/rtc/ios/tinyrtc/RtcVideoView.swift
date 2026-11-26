// The picture of one track.
//
// Remote: an AVSampleBufferDisplayLayer decodes and shows the frames. The layer's control timebase
// runs on the host clock and every frame is stamped "arrival + play_delay_us": the layer decodes it
// at once and shows it at that moment, vsync-aligned, with no timer of ours (a delay of 0 is "now").
// Stamps never go backwards (the delay shrinks when the jitter buffer does). Decoding belongs to the
// view: frames reach it only while it shows the track. Attaching, coming back to a window, or a
// failed layer (status .failed / requiresFlushToResumeDecoding, e.g. after the background) flushes
// it, asks the other side for a keyframe, and drops frames until one arrives.
//
// Rotation and mirroring are the layer's transform; objectFit its videoGravity. onResize reports the
// picture's size as shown (rotation applied), from the format description.
//
// Local: an AVCaptureVideoPreviewLayer of the camera's session.

import AVFoundation
import UIKit

@MainActor
public final class RtcVideoView: UIView {
    public enum ObjectFit: Sendable, Equatable {
        /// Fills the view, cropping.
        case cover
        /// The whole picture, letterboxed.
        case contain
    }

    public var track: (any RtcVideoTrack)? {
        didSet {
            if track !== oldValue { attach() }
        }
    }

    public var objectFit: ObjectFit = .cover {
        didSet { applyGravity() }
    }

    /// Flips the picture left-right (as shown: after the rotation).
    public var mirror = false {
        didSet { setNeedsLayout() }
    }

    /// The picture's size as shown, when it changes.
    public var onResize: ((Int, Int) -> Void)?

    /// The picture's size as shown (rotation applied); zero before the first frame.
    public private(set) var videoSize: CGSize = .zero

    private let displayLayer = AVSampleBufferDisplayLayer()
    private var renderer: LayerRenderer?
    private var preview: AVCaptureVideoPreviewLayer?
    private weak var previewed: LocalVideoTrack?
    private var previewRotation: NSObject?
    private var previewObservation: NSKeyValueObservation?
    private var coded = CGSize.zero
    private var rotation: UInt16 = 0

    public override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        clipsToBounds = true
        layer.addSublayer(displayLayer)
        applyGravity()
    }

    public required init?(coder: NSCoder) {
        super.init(coder: coder)
        backgroundColor = .black
        clipsToBounds = true
        layer.addSublayer(displayLayer)
        applyGravity()
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let sideways = rotation == 90 || rotation == 270
        displayLayer.bounds = CGRect(x: 0, y: 0,
                                     width: sideways ? bounds.height : bounds.width,
                                     height: sideways ? bounds.width : bounds.height)
        displayLayer.position = CGPoint(x: bounds.midX, y: bounds.midY)
        // UIKit's y points down: a positive angle turns clockwise on screen.
        let turn = CGAffineTransform(rotationAngle: CGFloat(rotation) * .pi / 180)
        displayLayer.setAffineTransform(mirror ? turn.concatenating(CGAffineTransform(scaleX: -1, y: 1)) : turn)
        if let preview {
            preview.frame = bounds
            if let connection = preview.connection, connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = mirror
            }
            orientPreview()
        }
        CATransaction.commit()
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        // Back on screen: the layer may have lost its decoder meanwhile.
        if window != nil { renderer?.restart() }
    }

    private func applyGravity() {
        let gravity: AVLayerVideoGravity = objectFit == .cover ? .resizeAspectFill : .resizeAspect
        displayLayer.videoGravity = gravity
        preview?.videoGravity = gravity
    }

    // MARK: attaching

    private func attach() {
        if let renderer {
            renderer.feed.remove(renderer)
            renderer.stop()
        }
        renderer = nil
        preview?.removeFromSuperlayer()
        preview = nil
        previewed?.previewDetached(self)
        previewed = nil
        previewObservation = nil
        previewRotation = nil
        displayLayer.isHidden = false
        setSize(coded: .zero, rotation: 0)

        switch track {
        case let remote as RemoteVideoTrack:
            let me = MainWeak(self)
            let renderer = LayerRenderer(layer: displayLayer, feed: remote.feed) { size, rotation in
                onMain { me.value?.setSize(coded: size, rotation: rotation) }
            }
            self.renderer = renderer
            remote.feed.add(renderer)
            renderer.restart()
        case let local as LocalVideoTrack:
            displayLayer.isHidden = true
            guard let session = local.pipeline.capturer.previewSession else { break }
            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.frame = bounds
            layer.addSublayer(preview)
            self.preview = preview
            previewed = local
            local.previewAttached(self)
            applyGravity()
            cameraChanged()
        default:
            break
        }
    }

    /// The local track's camera (or its format) changed: the preview's rotation follows the device.
    func cameraChanged() {
        guard let preview, let local = previewed else { return }
        previewObservation = nil
        previewRotation = nil
        if #available(iOS 17.0, *), let device = local.pipeline.capturer.device {
            let me = MainWeak(self)
            let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: preview)
            previewRotation = coordinator
            previewObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { _, _ in
                onMain { me.value?.setNeedsLayout() }
            }
        }
        setNeedsLayout()
    }

    /// The local preview upright on screen; its size as shown follows the angle.
    private func orientPreview() {
        guard let preview, let connection = preview.connection, let local = previewed else { return }
        var angle: CGFloat = 90
        if #available(iOS 17.0, *) {
            if let coordinator = previewRotation as? AVCaptureDevice.RotationCoordinator {
                angle = coordinator.videoRotationAngleForHorizonLevelPreview
                if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
            }
        } else if connection.isVideoOrientationSupported {
            switch window?.windowScene?.interfaceOrientation {
            case .landscapeLeft:
                connection.videoOrientation = .landscapeLeft
                angle = 180
            case .landscapeRight:
                connection.videoOrientation = .landscapeRight
                angle = 0
            case .portraitUpsideDown:
                connection.videoOrientation = .portraitUpsideDown
                angle = 270
            default:
                connection.videoOrientation = .portrait
            }
        }
        // The preview layer turns the picture itself: only the size as shown is ours to report.
        let sideways = Int(angle.rounded()) % 180 == 90
        let settings = local.settings
        let shown = sideways ? CGSize(width: settings.height, height: settings.width) : CGSize(width: settings.width, height: settings.height)
        if shown != videoSize {
            videoSize = shown
            onResize?(Int(shown.width), Int(shown.height))
        }
    }

    private func setSize(coded: CGSize, rotation: UInt16, notify: Bool = true) {
        let changedRotation = rotation != self.rotation
        self.coded = coded
        self.rotation = rotation
        let sideways = rotation == 90 || rotation == 270
        let shown = sideways ? CGSize(width: coded.height, height: coded.width) : coded
        if changedRotation { setNeedsLayout() }
        guard shown != videoSize else { return }
        videoSize = shown
        if notify, shown != .zero { onResize?(Int(shown.width), Int(shown.height)) }
    }
}

/// The remote frames of one view, on the view's own queue: depacketized into CMSampleBuffers,
/// stamped, enqueued into the display layer.
///
/// iOS 17+: the layer's AVSampleBufferVideoRenderer, which takes buffers on any queue. Before, the
/// layer itself, whose API this SDK marks main-actor: each buffer hops to the main thread.
final class LayerRenderer: VideoFrameSink, @unchecked Sendable {
    let feed: RemoteVideoFeed
    private let queue = DispatchQueue(label: "tinyrtc.view", qos: .userInteractive)
    private let onFormat: @Sendable (CGSize, UInt16) -> Void
    /// iOS 17+: the AVSampleBufferVideoRenderer; before: nil, and `layer` on the main thread.
    private let videoRenderer: AnyObject?
    private let layer: Unchecked<AVSampleBufferDisplayLayer>

    // On `queue`:
    private let builder = SampleBufferBuilder()
    private var waitingForKeyframe = true
    private var askedAt = CMTime.negativeInfinity
    private var lastStamp = CMTime.negativeInfinity
    private var lastSize = CMVideoDimensions(width: 0, height: 0)
    private var lastRotation: UInt16 = 0
    private var stopped = false
    private let clock = CMClockGetHostTimeClock()

    @MainActor
    init(layer: AVSampleBufferDisplayLayer, feed: RemoteVideoFeed, onFormat: @escaping @Sendable (CGSize, UInt16) -> Void) {
        self.layer = Unchecked(value: layer)
        self.feed = feed
        self.onFormat = onFormat
        // The layer's clock: the host clock itself, so a stamp is a moment of CMClockGetHostTimeClock.
        var timebase: CMTimebase?
        CMTimebaseCreateWithSourceClock(allocator: kCFAllocatorDefault, sourceClock: clock, timebaseOut: &timebase)
        if let timebase {
            CMTimebaseSetTime(timebase, time: CMClockGetTime(clock))
            CMTimebaseSetRate(timebase, rate: 1)
            layer.controlTimebase = timebase
        }
        if #available(iOS 17.0, *) {
            videoRenderer = layer.sampleBufferRenderer
        } else {
            videoRenderer = nil
        }
    }

    func receive(_ frame: EncodedFrame) {
        queue.async { [self] in render(frame) }
    }

    /// Flush, ask for a keyframe, show nothing until it comes.
    func restart() {
        queue.async { [self] in
            guard !stopped else { return }
            flush()
            waitingForKeyframe = true
            ask()
        }
    }

    func stop() {
        queue.async { [self] in
            stopped = true
            flush()
        }
    }

    // MARK: on `queue`

    private func render(_ frame: EncodedFrame) {
        guard !stopped else { return }
        if waitingForKeyframe {
            guard frame.keyframe, frame.sps != nil else {
                // The first request may have gone before the other side was ready.
                if CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(clock), askedAt)) > 1 { ask() }
                return
            }
            waitingForKeyframe = false
        }
        var stamp = CMTimeAdd(frame.arrival, CMTime(value: frame.playDelayUs, timescale: 1_000_000))
        if lastStamp.isNumeric, CMTimeCompare(stamp, lastStamp) <= 0 {
            stamp = CMTimeAdd(lastStamp, CMTime(value: 1, timescale: 1000))
        }
        guard let (buffer, _) = builder.make(frame, presentationTime: stamp, displayImmediately: false) else {
            waitingForKeyframe = true
            ask()
            return
        }
        lastStamp = stamp
        enqueue(buffer)
        if let size = builder.dimensions, size.width != lastSize.width || size.height != lastSize.height || frame.rotation != lastRotation {
            lastSize = size
            lastRotation = frame.rotation
            onFormat(CGSize(width: Int(size.width), height: Int(size.height)), frame.rotation)
        }
    }

    private func ask() {
        askedAt = CMClockGetTime(clock)
        feed.askKeyframe()
    }

    /// The layer lost its decoder (failed, or it must be flushed to go on: after the background).
    private func failed() {
        guard !stopped else { return }
        flush()
        waitingForKeyframe = true
        ask()
    }

    private func enqueue(_ buffer: CMSampleBuffer) {
        if #available(iOS 17.0, *), let renderer = videoRenderer as? AVSampleBufferVideoRenderer {
            if renderer.status == .failed || renderer.requiresFlushToResumeDecoding {
                failed()
            } else {
                renderer.enqueue(buffer)
            }
        } else {
            let (layer, buffer) = (layer, Unchecked(value: buffer))
            onMain { [self] in
                if layer.value.status == .failed || layer.value.requiresFlushToResumeDecoding {
                    queue.async { self.failed() }
                } else {
                    layer.value.enqueue(buffer.value)
                }
            }
        }
    }

    private func flush() {
        if #available(iOS 17.0, *), let renderer = videoRenderer as? AVSampleBufferVideoRenderer {
            renderer.flush()
        } else {
            let layer = layer
            onMain { layer.value.flush() }
        }
        builder.reset()
        lastStamp = .negativeInfinity
    }
}
