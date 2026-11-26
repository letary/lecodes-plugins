// The hardware encoder: VTCompressionSession, steered by the core.
//
// - H.264 Constrained Baseline (auto level: 3.1 for 720p30, what the size needs otherwise), real
//   time, no frame reordering, the low-latency rate control where the device has it.
// - target(bitrate, max_fps, max_height): the bitrate (average + a 1.5x data-rate limit over 1 s)
//   changes on the fly; the rate by dropping frames; a smaller height by making the session again at
//   the new size (aspect kept) and letting VideoToolbox scale the camera's buffers into it. A new
//   session starts with a keyframe.
// - keyframe(): the next frame is forced to an IDR. Otherwise keyframes are rare (4 min / 7200
//   frames): they come on request.
// - Out: AVCC (4-byte lengths). On a keyframe, the SPS and PPS of the format description go IN
//   FRONT of the frame's units, as units of their own.
// - The picture is encoded as the sensor gives it; the rotation that shows it upright travels with
//   the frame.
//
// Threads: everything but the output runs on `queue` (the camera delivers its frames there); VT's
// output handler runs on VT's thread and hands the access unit straight to the core.

import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// One encoded picture for the core.
struct EncodedAccessUnit: Sendable {
    /// AVCC; SPS and PPS first on a keyframe.
    var data: [UInt8]
    var keyframe: Bool
    var rotation: UInt16
    var captureTimeUs: Int64
    var width: Int32
    var height: Int32
}

/// What the encoder did, for the tests and a bug report.
struct EncoderStats: Sendable {
    var framesIn = 0
    var framesEncoded = 0
    var framesDropped = 0
    var keyframes = 0
    var keyframesForced = 0
    var sessions = 0
    var width: Int32 = 0
    var height: Int32 = 0
    var bitrate: UInt32 = 0
    var maxFps: UInt32 = 0
    var maxHeight: UInt32 = 0
    var lowLatency = false
    var profile = ""
    /// "WxH" of every session made, in order.
    var sizes: [String] = []
}

final class H264Encoder: @unchecked Sendable {
    let queue = DispatchQueue(label: "tinyrtc.encoder", qos: .userInitiated)
    let stats = Locked(EncoderStats())

    /// Called on VT's thread with each access unit.
    private let output: @Sendable (EncodedAccessUnit) -> Void

    // On `queue`:
    private var session: VTCompressionSession?
    private var width: Int32 = 0
    private var height: Int32 = 0
    private var bitrate: UInt32 = 300_000
    private var maxFps: UInt32 = 30
    private var maxHeight: UInt32 = 720
    private var forceKeyframe = true
    private var nextDue = CMTime.negativeInfinity
    private var sending = false
    private var finished = false
    private var lowLatencyRefused = false

    /// Frames VT has and has not returned: more than a few = the encoder is behind, drop.
    private let inFlight = Locked(0)

    init(output: @escaping @Sendable (EncodedAccessUnit) -> Void) {
        self.output = output
    }

    /// The core's target (a video source callback: any thread).
    func setTarget(bitrate: UInt32, fps: UInt32, height: UInt32) {
        queue.async { [self] in
            self.bitrate = max(bitrate, 50_000)
            maxFps = max(fps, 1)
            maxHeight = max(height, 90)
            stats.write {
                $0.bitrate = self.bitrate
                $0.maxFps = maxFps
                $0.maxHeight = maxHeight
            }
            if let session {
                applyRate(session)
            }
            // A size change happens at the next frame (it depends on the frame's size).
        }
    }

    /// The core's keyframe request (any thread).
    func requestKeyframe() {
        queue.async { [self] in forceKeyframe = true }
    }

    /// Whether any connection takes the stream: without one, nothing is encoded.
    func setSending(_ on: Bool) {
        queue.async { [self] in
            if on && !sending { forceKeyframe = true }
            sending = on
        }
    }

    /// One picture. On `queue`.
    func encode(_ pixelBuffer: CVPixelBuffer, time: CMTime, rotation: UInt16) {
        dispatchPrecondition(condition: .onQueue(queue))
        stats.write { $0.framesIn += 1 }
        guard sending, !finished else { return }

        // The rate: a frame is due one interval after the last one kept (a quarter of an interval
        // of slack, so 30 -> 20 fps keeps two frames of three, not one of two).
        let interval = CMTime(value: 1, timescale: CMTimeScale(maxFps))
        let slack = CMTime(value: 1, timescale: CMTimeScale(maxFps) * 4)
        if !nextDue.isNumeric { nextDue = time }
        if CMTimeCompare(CMTimeAdd(time, slack), nextDue) < 0 {
            stats.write { $0.framesDropped += 1 }
            return
        }
        nextDue = CMTimeAdd(nextDue, interval)
        // Behind (a pause of the camera): due again one interval from now.
        if CMTimeCompare(nextDue, time) < 0 { nextDue = CMTimeAdd(time, interval) }
        if inFlight.get > 3 {
            stats.write { $0.framesDropped += 1 }
            return
        }

        // The size: the short side at most `maxHeight`, the aspect of the buffer kept, even numbers.
        let sourceWidth = Int32(CVPixelBufferGetWidth(pixelBuffer))
        let sourceHeight = Int32(CVPixelBufferGetHeight(pixelBuffer))
        let (w, h) = Self.size(width: sourceWidth, height: sourceHeight, maxShortSide: Int32(maxHeight))
        if session == nil || w != width || h != height {
            makeSession(width: w, height: h)
        }
        guard let session else { return }

        var properties: CFDictionary?
        if forceKeyframe {
            properties = [kVTEncodeFrameOptionKey_ForceKeyFrame as String: true] as CFDictionary
            forceKeyframe = false
            stats.write { $0.keyframesForced += 1 }
        }
        let captureUs = Int64(CMTimeGetSeconds(time) * 1_000_000)
        let (outWidth, outHeight) = (w, h)
        inFlight.write { $0 += 1 }
        let status = VTCompressionSessionEncodeFrame(
            session, imageBuffer: pixelBuffer, presentationTimeStamp: time, duration: .invalid,
            frameProperties: properties, infoFlagsOut: nil
        ) { [weak self] status, flags, sampleBuffer in
            self?.encoded(status: status, flags: flags, sampleBuffer: sampleBuffer, rotation: rotation,
                          captureUs: captureUs, width: outWidth, height: outHeight)
        }
        if status != noErr {
            inFlight.write { $0 -= 1 }
            log.error("VTCompressionSessionEncodeFrame: \(status)")
            // A session the system took (the app in the background, media services reset): a
            // new one at the next frame.
            if status == kVTInvalidSessionErr { tearDown() }
        }
    }

    /// For good: the session ends and no frame is taken after. On `queue`.
    func finish() {
        dispatchPrecondition(condition: .onQueue(queue))
        finished = true
        tearDown()
    }

    /// Ends the session; nothing is output after it ran. On `queue`.
    func tearDown() {
        dispatchPrecondition(condition: .onQueue(queue))
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
        session = nil
        width = 0
        height = 0
    }

    static func size(width: Int32, height: Int32, maxShortSide: Int32) -> (Int32, Int32) {
        let short = min(width, height)
        guard short > maxShortSide, short > 0 else { return (width & ~1, height & ~1) }
        let scale = Double(maxShortSide) / Double(short)
        let even = { (v: Int32) -> Int32 in max(2, Int32((Double(v) * scale / 2).rounded()) * 2) }
        return (even(width), even(height))
    }

    // MARK: the session

    private func makeSession(width: Int32, height: Int32) {
        tearDown()
        var made: (VTCompressionSession, String)?
        var lowLatency = false
        if !lowLatencyRefused {
            // The low-latency rate control is documented for High profiles only: kept only where the
            // encoder takes Constrained Baseline with it.
            let specification = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl as String: true] as CFDictionary
            if let session = Self.create(width: width, height: height, specification: specification) {
                if Self.set(session, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel) {
                    made = (session, "ConstrainedBaseline")
                    lowLatency = true
                } else {
                    VTCompressionSessionInvalidate(session)
                }
            }
            if made == nil {
                lowLatencyRefused = true
                log.info("no low-latency H.264 Constrained Baseline encoder: the normal one")
            }
        }
        if made == nil, let session = Self.create(width: width, height: height, specification: nil) {
            if Self.set(session, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel) {
                made = (session, "ConstrainedBaseline")
            } else if Self.set(session, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Baseline_AutoLevel) {
                // Baseline as VideoToolbox makes it is constrained in practice (no FMO / ASO /
                // redundant slices): a receiver of 42e01f decodes it.
                made = (session, "Baseline")
            } else {
                VTCompressionSessionInvalidate(session)
                log.error("the H.264 encoder takes neither Constrained Baseline nor Baseline")
            }
        }
        guard let (session, profile) = made else { return }

        func set(_ key: CFString, _ value: CFTypeRef) {
            _ = Self.set(session, key, value)
        }
        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
        set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
        set(kVTCompressionPropertyKey_H264EntropyMode, kVTH264EntropyMode_CAVLC)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: 7200))
        set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, NSNumber(value: 240))
        applyRate(session)
        VTCompressionSessionPrepareToEncodeFrames(session)

        self.session = session
        self.width = width
        self.height = height
        forceKeyframe = true
        stats.write {
            $0.sessions += 1
            $0.width = width
            $0.height = height
            $0.sizes.append("\(width)x\(height)")
            $0.lowLatency = lowLatency
            $0.profile = profile
        }
    }

    private static func create(width: Int32, height: Int32, specification: CFDictionary?) -> VTCompressionSession? {
        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil, width: width, height: height, codecType: kCMVideoCodecType_H264,
            encoderSpecification: specification, imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: nil, refcon: nil, compressionSessionOut: &session)
        if status != noErr { log.info("VTCompressionSessionCreate \(width)x\(height): \(status)") }
        return status == noErr ? session : nil
    }

    private static func set(_ session: VTCompressionSession, _ key: CFString, _ value: CFTypeRef) -> Bool {
        let status = VTSessionSetProperty(session, key: key, value: value)
        if status != noErr { log.info("VTSessionSetProperty \(key as String, privacy: .public): \(status)") }
        return status == noErr
    }

    private func applyRate(_ session: VTCompressionSession) {
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: bitrate))
        // Bytes per second, over one second: room for a keyframe above the average.
        let limit = [NSNumber(value: Double(bitrate) * 1.5 / 8), NSNumber(value: 1.0)] as CFArray
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: limit)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: maxFps))
    }

    // MARK: out

    private func encoded(status: OSStatus, flags: VTEncodeInfoFlags, sampleBuffer: CMSampleBuffer?, rotation: UInt16,
                         captureUs: Int64, width: Int32, height: Int32) {
        inFlight.write { $0 -= 1 }
        guard status == noErr, !flags.contains(.frameDropped), let sampleBuffer,
              let (data, keyframe) = Self.accessUnit(sampleBuffer) else {
            if status != noErr { log.error("encoder output: \(status)") }
            stats.write { $0.framesDropped += 1 }
            return
        }
        stats.write {
            $0.framesEncoded += 1
            if keyframe { $0.keyframes += 1 }
        }
        output(EncodedAccessUnit(data: data, keyframe: keyframe, rotation: rotation, captureTimeUs: captureUs,
                                 width: width, height: height))
    }

    static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]],
              let first = attachments.first else { return true }
        return !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
    }

    /// The access unit as the core wants it: AVCC with 4-byte lengths, and on a keyframe every
    /// parameter set of the format description in front, as length-prefixed units.
    static func accessUnit(_ sampleBuffer: CMSampleBuffer) -> ([UInt8], Bool)? {
        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer),
              let format = CMSampleBufferGetFormatDescription(sampleBuffer) else { return nil }
        let keyframe = isKeyframe(sampleBuffer)
        var count = 0
        var headerLength: Int32 = 4
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
            parameterSetCountOut: &count, nalUnitHeaderLengthOut: &headerLength) == noErr else { return nil }

        let length = CMBlockBufferGetDataLength(block)
        var out: [UInt8] = []
        out.reserveCapacity(length + 128)
        func appendLength(_ n: Int) {
            out.append(UInt8(truncatingIfNeeded: n >> 24))
            out.append(UInt8(truncatingIfNeeded: n >> 16))
            out.append(UInt8(truncatingIfNeeded: n >> 8))
            out.append(UInt8(truncatingIfNeeded: n))
        }
        if keyframe {
            for index in 0..<count {
                var pointer: UnsafePointer<UInt8>?
                var size = 0
                guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size,
                    parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer else { return nil }
                appendLength(size)
                out.append(contentsOf: UnsafeBufferPointer(start: pointer, count: size))
            }
        }
        var units = [UInt8](repeating: 0, count: length)
        guard units.withUnsafeMutableBytes({
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!)
        }) == kCMBlockBufferNoErr else { return nil }
        if headerLength == 4 {
            out.append(contentsOf: units)
        } else {
            // Another length size: each unit again behind 4 bytes.
            let n = Int(headerLength)
            var at = 0
            while at + n <= units.count {
                var size = 0
                for i in 0..<n { size = size << 8 | Int(units[at + i]) }
                at += n
                guard size > 0, at + size <= units.count else { return nil }
                appendLength(size)
                out.append(contentsOf: units[at..<at + size])
                at += size
            }
        }
        return (out, keyframe)
    }
}
