// A local video track's machinery: capturer -> encoder -> the core's video source -> connections.

import AVFoundation
import CoreMedia
import Foundation
import TinyRTCCore

/// The `user` of a video source's callbacks: they may run on a connection's thread, or inside
/// `tinyrtc_connection_send_video` / `tinyrtc_video_source_set_limits` on the caller's thread. They
/// only post to the encoder's queue.
final class SourceCallbacks: @unchecked Sendable {
    weak var encoder: H264Encoder?

    init(encoder: H264Encoder) {
        self.encoder = encoder
    }
}

private func sourceTarget(_ user: UnsafeMutableRawPointer?, _ bitrate: UInt32, _ fps: UInt32, _ height: UInt32) {
    guard let user else { return }
    Unmanaged<SourceCallbacks>.fromOpaque(user).takeUnretainedValue().encoder?.setTarget(bitrate: bitrate, fps: fps, height: height)
}

private func sourceKeyframe(_ user: UnsafeMutableRawPointer?) {
    guard let user else { return }
    Unmanaged<SourceCallbacks>.fromOpaque(user).takeUnretainedValue().encoder?.requestKeyframe()
}

/// The core's video source: one encoded stream, sent to every connection that takes it.
///
/// Destroyed only once no connection takes it (`VideoPipeline.tearDown`): a connection that still
/// holds the source in the core could call its callbacks after `tinyrtc_video_source_destroy`.
final class CoreVideoSource: @unchecked Sendable {
    let context: CoreContext
    private let handle: Locked<OpaquePointer?>
    private let callbacks: Unmanaged<SourceCallbacks>

    init(context: CoreContext, encoder: H264Encoder) {
        self.context = context
        let callbacks = Unmanaged.passRetained(SourceCallbacks(encoder: encoder))
        var c = tinyrtc_video_source_callbacks()
        c.target = sourceTarget
        c.keyframe = sourceKeyframe
        c.user = callbacks.toOpaque()
        self.callbacks = callbacks
        handle = Locked(tinyrtc_video_source_create(context.raw, &c))
    }

    /// The live handle, under the lock: `destroy` waits for whoever is using it.
    func withHandle(_ body: (OpaquePointer) -> Void) {
        handle.read { if let raw = $0 { body(raw) } }
    }

    /// On VT's thread. The core copies the frame and returns at once.
    func send(_ unit: EncodedAccessUnit) {
        withHandle { raw in
            unit.data.withUnsafeBufferPointer { bytes in
                var frame = tinyrtc_video_frame_in()
                frame.data = bytes.baseAddress
                frame.len = bytes.count
                frame.framing = TINYRTC_H264_AVCC
                frame.capture_time_us = unit.captureTimeUs
                frame.keyframe = unit.keyframe ? 1 : 0
                frame.rotation = unit.rotation
                tinyrtc_video_source_send(raw, &frame)
            }
        }
    }

    /// The app's ceiling; the target never goes above it. 0 = none of that kind.
    func setLimits(bitrate: UInt32, fps: UInt32, height: UInt32) {
        withHandle { tinyrtc_video_source_set_limits($0, bitrate, fps, height) }
    }

    func destroy() {
        let raw: OpaquePointer? = handle.write { handle in
            defer { handle = nil }
            return handle
        }
        guard let raw else { return }
        tinyrtc_video_source_destroy(raw)
        callbacks.release()
    }

    deinit {
        destroy()
    }
}

/// Where pictures come from: the camera, or a test's pattern.
protocol VideoCapturer: AnyObject, Sendable {
    /// Starts delivering frames to `encoder.encode`, on `encoder.queue`.
    func start(_ options: CameraOptions, into encoder: H264Encoder) async throws -> CameraSettings
    func apply(_ options: CameraOptions) async throws -> CameraSettings
    /// Idempotent; no frame is delivered after it returned.
    func stop() async
    /// The OS took the device for good. Any thread.
    var onEnded: (@Sendable () -> Void)? { get set }
    /// The session a preview layer shows, if the capturer has one.
    var previewSession: AVCaptureSession? { get }
    /// The camera device (for the preview's rotation), if there is one.
    var device: AVCaptureDevice? { get }
}

/// capturer -> encoder -> source, and the connections the source was given to.
final class VideoPipeline: @unchecked Sendable {
    let encoder: H264Encoder
    let source: CoreVideoSource
    let capturer: VideoCapturer
    /// Every connection the source was set on: each is told to let go before the source goes.
    private let cores = Locked<[ObjectIdentifier: ConnectionCore]>([:])
    private let tornDown = Locked(false)

    init(context: CoreContext, capturer: VideoCapturer) {
        let sink = Locked<CoreVideoSource?>(nil)
        let encoder = H264Encoder(output: { unit in sink.get?.send(unit) })
        let source = CoreVideoSource(context: context, encoder: encoder)
        sink.write { $0 = source }
        self.encoder = encoder
        self.source = source
        self.capturer = capturer
    }

    func attached(_ core: ConnectionCore) {
        cores.write { $0[ObjectIdentifier(core)] = core }
    }

    /// Stops everything, in the order that keeps every callback on live memory: no more frames,
    /// no connection that takes the source, the encoder drained, then the source.
    func tearDown() async {
        guard tornDown.write({ done in defer { done = true }; return !done }) else { return }
        await capturer.stop()
        let cores = cores.read { Array($0.values) }
        let (encoder, source) = (encoder, source)
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            let group = DispatchGroup()
            for core in cores {
                group.enter()
                core.submit {
                    core.detachVideo(source)
                    group.leave()
                }
            }
            group.notify(queue: encoder.queue) {
                encoder.finish()
                source.destroy()
                done.resume()
            }
        }
    }
}
