// The remote picture before a decoder: the core's NAL list as an AVCC block, and that block as a
// CMSampleBuffer for AVSampleBufferDisplayLayer (or any VideoToolbox decoder).

import CoreMedia
import Foundation
import TinyRTCCore

/// One picture of the other side, copied off the core thread (the core's pointers die with the
/// callback). The units other than the parameter sets are in ONE block buffer, each behind a 4-byte
/// big-endian length (AVCC): every view of the track shares it, read-only.
struct EncodedFrame: @unchecked Sendable {
    let block: CMBlockBuffer
    let length: Int
    /// The parameter sets the frame came with (a keyframe), nil otherwise.
    let sps: Data?
    let pps: Data?
    /// The type of every unit, in order (parameter sets included).
    let nalTypes: [UInt8]
    let keyframe: Bool
    let rotation: UInt16
    let playDelayUs: Int64
    let rtpTimestamp: UInt32
    /// The host clock when the core handed it over.
    let arrival: CMTime

    /// `event` is a TINYRTC_EVENT_VIDEO_FRAME. (Its `video` struct is anonymous in the header, so it
    /// has no Swift name of its own: the whole event is passed.)
    init?(_ event: tinyrtc_event) {
        let video = event.video
        guard let first = video.nals, video.nal_count > 0 else { return nil }
        let nals = UnsafeBufferPointer(start: first, count: video.nal_count)
        var total = 0
        var types: [UInt8] = []
        types.reserveCapacity(nals.count)
        var sps: Data?
        var pps: Data?
        for nal in nals {
            guard let data = nal.data, nal.len > 0 else { continue }
            types.append(nal.type)
            switch nal.type {
            case 7: sps = sps ?? Data(bytes: data, count: nal.len)
            case 8: pps = pps ?? Data(bytes: data, count: nal.len)
            case 9: break // an access unit delimiter: nothing for a decoder
            default: total += 4 + nal.len
            }
        }
        guard total > 0 else { return nil }
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: total, blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil, offsetToData: 0, dataLength: total, flags: kCMBlockBufferAssureMemoryNowFlag,
            blockBufferOut: &block) == kCMBlockBufferNoErr, let block else { return nil }
        var pointer: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: nil, dataPointerOut: &pointer) == kCMBlockBufferNoErr,
              let base = pointer.map({ UnsafeMutableRawPointer($0) }) else { return nil }
        var at = 0
        for nal in nals {
            guard let data = nal.data, nal.len > 0, ![7, 8, 9].contains(nal.type) else { continue }
            var length = UInt32(nal.len).bigEndian
            withUnsafeBytes(of: &length) { base.advanced(by: at).copyMemory(from: $0.baseAddress!, byteCount: 4) }
            base.advanced(by: at + 4).copyMemory(from: data, byteCount: nal.len)
            at += 4 + nal.len
        }
        self.block = block
        length = total
        self.sps = sps
        self.pps = pps
        nalTypes = types
        keyframe = video.keyframe != 0
        rotation = video.rotation
        playDelayUs = video.play_delay_us
        rtpTimestamp = video.rtp_timestamp
        arrival = CMClockGetTime(CMClockGetHostTimeClock())
    }
}

/// Whoever turns a remote track's frames into a picture (a view; a test's decoder).
protocol VideoFrameSink: AnyObject, Sendable {
    /// On the connection's core thread: hop, do not decode here.
    func receive(_ frame: EncodedFrame)
}

/// The frames of one remote video track, fanned out to the sinks that show it. A frame no sink
/// wants is not even copied: a track that no view shows is not decoded.
final class RemoteVideoFeed: @unchecked Sendable {
    private struct Entry {
        weak var sink: (any VideoFrameSink)?
    }
    private let sinks = Locked<[ObjectIdentifier: Entry]>([:])
    private let keyframe = Locked<(@Sendable () -> Void)?>(nil)

    /// Asks the other side for a keyframe (rate-limited by the core).
    var requestKeyframe: (@Sendable () -> Void)? {
        get { keyframe.get }
        set { keyframe.write { $0 = newValue } }
    }

    func add(_ sink: any VideoFrameSink) {
        sinks.write { $0[ObjectIdentifier(sink)] = Entry(sink: sink) }
    }

    func remove(_ sink: any VideoFrameSink) {
        sinks.write { $0[ObjectIdentifier(sink)] = nil }
    }

    func removeAll() {
        sinks.write { $0.removeAll() }
    }

    func askKeyframe() {
        keyframe.get?()
    }

    /// A TINYRTC_EVENT_VIDEO_FRAME, on the connection's core thread.
    func deliver(_ event: tinyrtc_event) {
        let current: [any VideoFrameSink] = sinks.write { sinks in
            sinks = sinks.filter { $0.value.sink != nil }
            return sinks.values.compactMap(\.sink)
        }
        guard !current.isEmpty, let frame = EncodedFrame(event) else { return }
        for sink in current { sink.receive(frame) }
    }
}

/// EncodedFrame -> CMSampleBuffer. The format description is made from the SPS / PPS of a keyframe
/// and made again when they change; until there is one, nothing can be built. Used on one queue.
final class SampleBufferBuilder {
    private(set) var format: CMVideoFormatDescription?
    private var sps = Data()
    private var pps = Data()

    /// The coded size of the current parameter sets.
    var dimensions: CMVideoDimensions? { format.map(CMVideoFormatDescriptionGetDimensions) }

    func reset() {
        format = nil
        sps = Data()
        pps = Data()
    }

    /// `formatChanged` = new parameter sets came with this frame (a decoder may need to be made again).
    func make(_ frame: EncodedFrame, presentationTime: CMTime, displayImmediately: Bool) -> (buffer: CMSampleBuffer, formatChanged: Bool)? {
        var changed = false
        if let newSPS = frame.sps, let newPPS = frame.pps, format == nil || newSPS != sps || newPPS != pps {
            guard let made = Self.format(sps: newSPS, pps: newPPS) else { return nil }
            format = made
            sps = newSPS
            pps = newPPS
            changed = true
        }
        guard let format else { return nil }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: presentationTime, decodeTimeStamp: .invalid)
        var size = frame.length
        var buffer: CMSampleBuffer?
        guard CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault, dataBuffer: frame.block, formatDescription: format, sampleCount: 1,
            sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &size,
            sampleBufferOut: &buffer) == noErr, let buffer else { return nil }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: true), CFArrayGetCount(attachments) > 0 {
            let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            func set(_ key: CFString, _ value: Bool) {
                CFDictionarySetValue(dictionary, Unmanaged.passUnretained(key).toOpaque(),
                                     Unmanaged.passUnretained(value ? kCFBooleanTrue : kCFBooleanFalse).toOpaque())
            }
            set(kCMSampleAttachmentKey_NotSync, !frame.keyframe)
            set(kCMSampleAttachmentKey_DependsOnOthers, !frame.keyframe)
            if displayImmediately { set(kCMSampleAttachmentKey_DisplayImmediately, true) }
        }
        return (buffer, changed)
    }

    static func format(sps: Data, pps: Data) -> CMVideoFormatDescription? {
        sps.withUnsafeBytes { s in
            pps.withUnsafeBytes { p in
                guard let sBase = s.bindMemory(to: UInt8.self).baseAddress, let pBase = p.bindMemory(to: UInt8.self).baseAddress else {
                    return nil
                }
                let pointers = [sBase, pBase]
                let sizes = [s.count, p.count]
                var format: CMFormatDescription?
                let status = CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    allocator: kCFAllocatorDefault, parameterSetCount: 2, parameterSetPointers: pointers,
                    parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &format)
                return status == noErr ? format : nil
            }
        }
    }
}
