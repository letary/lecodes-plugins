// The sound: the voice-processing I/O unit (kAudioUnitSubType_VoiceProcessingIO) as the clock of
// both directions. Its render callback pulls the core's mix (tinyrtc_audio_pull) straight into the
// unit's buffer; its input callback renders what the microphone recorded, after the OS's echo
// canceller, noise suppression and gain, and pushes it (tinyrtc_audio_push).
//
// Why the unit and not AVAudioEngine with voice processing: the unit hands over 48 kHz mono int16
// in its own real-time callbacks, at the I/O buffer's size (10 ms), with no graph between. With
// AVAudioEngine the capture side is a tap (large, late buffers) or a sink node, both in the
// engine's float format to convert; and the engine rebuilds its graph on route changes
// (AVAudioEngineConfigurationChange) where the unit only needs a restart. About the same code, less
// latency, fewer moving parts.
//
// The rate: the unit's client side is set to 48 kHz and the unit converts from the hardware's rate
// (16 kHz on a Bluetooth headset, 44.1 / 24 kHz elsewhere). Where it refuses that, it runs at the
// hardware rate and AudioConverter (ours, set up before the start, nothing allocated in the
// callbacks) converts both ways.

import AudioToolbox
import AVFAudio
import Foundation
import TinyRTCCore

/// What drives the core's sound: the voice-processing unit, or a test's clock. Used on the audio
/// controller's queue only.
protocol AudioDevice: AnyObject, Sendable {
    /// Whether the microphone permission is the OS's (a test's device has none).
    var needsRecordPermission: Bool { get }
    /// Runs: the render side pulls the core's mix; with `input`, what is recorded is pushed.
    func start(context: CoreContext, input: Bool, hardwareRate: Double) throws
    /// Stops; no callback runs after it returned. Idempotent.
    func stop()
}

/// The format of both sides: mono int16 at `rate`.
func pcm16(_ rate: Double) -> AudioStreamBasicDescription {
    AudioStreamBasicDescription(
        mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
        mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16,
        mReserved: 0)
}

// MARK: rate conversion

/// A source of samples for the pulling converter: fills `frames` samples. Real-time safe.
typealias PcmSource = @convention(c) (_ user: UnsafeMutableRawPointer?, _ pcm: UnsafeMutablePointer<Int16>, _ frames: Int) -> Void

/// The state the converters' input procs read. Lives in memory that does not move.
struct PushFeed {
    var pointer: UnsafeMutablePointer<Int16>?
    var frames: Int
}

struct PullFeed {
    var source: PcmSource
    var user: UnsafeMutableRawPointer?
    var scratch: UnsafeMutablePointer<Int16>
    var capacity: Int
    var pulled: Int
}

/// "Nothing more for now": the converter keeps its state for the next call.
private let noMoreInput: OSStatus = 0x6E6F6D6F // 'nomo'

private let pushInput: AudioConverterComplexInputDataProc = { _, packets, data, _, user in
    let feed = user!.assumingMemoryBound(to: PushFeed.self)
    guard feed.pointee.frames > 0, let pointer = feed.pointee.pointer else {
        packets.pointee = 0
        return noMoreInput
    }
    let n = min(Int(packets.pointee), feed.pointee.frames)
    data.pointee.mNumberBuffers = 1
    data.pointee.mBuffers.mNumberChannels = 1
    data.pointee.mBuffers.mData = UnsafeMutableRawPointer(pointer)
    data.pointee.mBuffers.mDataByteSize = UInt32(n * 2)
    packets.pointee = UInt32(n)
    feed.pointee.pointer = pointer + n
    feed.pointee.frames -= n
    return noErr
}

private let pullInput: AudioConverterComplexInputDataProc = { _, packets, data, _, user in
    let feed = user!.assumingMemoryBound(to: PullFeed.self)
    let n = min(Int(packets.pointee), feed.pointee.capacity)
    feed.pointee.source(feed.pointee.user, feed.pointee.scratch, n)
    data.pointee.mNumberBuffers = 1
    data.pointee.mBuffers.mNumberChannels = 1
    data.pointee.mBuffers.mData = UnsafeMutableRawPointer(feed.pointee.scratch)
    data.pointee.mBuffers.mDataByteSize = UInt32(n * 2)
    packets.pointee = UInt32(n)
    feed.pointee.pulled += n
    return noErr
}

/// int16 mono from one rate to another. Made off the audio thread; `push` / `pull` are real-time
/// safe (no allocation, no lock).
final class RateConverter: @unchecked Sendable {
    let from: Double
    let to: Double
    private let converter: AudioConverterRef
    private let pushFeed = UnsafeMutablePointer<PushFeed>.allocate(capacity: 1)
    private let pullFeed: UnsafeMutablePointer<PullFeed>

    /// `source` / `user`: where `pull` takes its input from.
    init?(from: Double, to: Double, maxInputFrames: Int, source: PcmSource? = nil, user: UnsafeMutableRawPointer? = nil) {
        var input = pcm16(from)
        var output = pcm16(to)
        var made: AudioConverterRef?
        guard AudioConverterNew(&input, &output, &made) == noErr, let made else { return nil }
        var quality = kAudioConverterQuality_High
        AudioConverterSetProperty(made, kAudioConverterSampleRateConverterQuality, 4, &quality)
        converter = made
        self.from = from
        self.to = to
        pushFeed.initialize(to: PushFeed(pointer: nil, frames: 0))
        pullFeed = .allocate(capacity: 1)
        pullFeed.initialize(to: PullFeed(source: source ?? { _, pcm, frames in pcm.update(repeating: 0, count: frames) },
                                         user: user, scratch: .allocate(capacity: maxInputFrames),
                                         capacity: maxInputFrames, pulled: 0))
    }

    deinit {
        AudioConverterDispose(converter)
        pullFeed.pointee.scratch.deallocate()
        pullFeed.deallocate()
        pushFeed.deallocate()
    }

    /// Converts all of `input`; writes what comes out (at most `capacity`) and returns its count.
    func push(_ input: UnsafeMutablePointer<Int16>, count: Int, into output: UnsafeMutablePointer<Int16>, capacity: Int) -> Int {
        pushFeed.pointee = PushFeed(pointer: input, frames: count)
        var produced = UInt32(capacity)
        var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
            mNumberChannels: 1, mDataByteSize: UInt32(capacity * 2), mData: UnsafeMutableRawPointer(output)))
        let status = AudioConverterFillComplexBuffer(converter, pushInput, pushFeed, &produced, &list, nil)
        guard status == noErr || status == noMoreInput else { return 0 }
        return Int(produced)
    }

    /// Fills exactly `count` samples of `output`, taking input from the source as needed.
    func pull(into output: UnsafeMutablePointer<Int16>, count: Int) {
        var produced = UInt32(count)
        var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
            mNumberChannels: 1, mDataByteSize: UInt32(count * 2), mData: UnsafeMutableRawPointer(output)))
        let status = AudioConverterFillComplexBuffer(converter, pullInput, pullFeed, &produced, &list, nil)
        if status != noErr || Int(produced) < count {
            (output + Int(produced)).update(repeating: 0, count: count - Int(produced))
        }
    }

    /// Input frames the pulling side has taken so far.
    var pulled: Int { pullFeed.pointee.pulled }
}

// MARK: the unit

/// The core's mix as a PcmSource.
private let corePull: PcmSource = { user, pcm, frames in
    tinyrtc_audio_pull(OpaquePointer(user), pcm, frames)
}

/// What the real-time callbacks read: plain memory, set before the unit starts, freed after it stopped.
struct AudioIO {
    var context: OpaquePointer
    var unit: AudioUnit?
    /// What the unit recorded, at the unit's rate.
    var capture: UnsafeMutablePointer<Int16>
    var captureCapacity: Int
    /// The same at 48 kHz, when the unit runs at another rate.
    var converted: UnsafeMutablePointer<Int16>
    var convertedCapacity: Int
    var captureConverter: Unmanaged<RateConverter>?
    var renderConverter: Unmanaged<RateConverter>?
    // Counters (written by the audio threads; read approximately by tests).
    var renderFrames = 0
    var captureFrames = 0
    var pushedFrames = 0
}

private let renderCallback: AURenderCallback = { refCon, _, _, _, frames, data in
    let io = refCon.assumingMemoryBound(to: AudioIO.self)
    guard let data, let buffer = UnsafeMutableAudioBufferListPointer(data).first?.mData else { return noErr }
    let pcm = buffer.assumingMemoryBound(to: Int16.self)
    if let converter = io.pointee.renderConverter {
        converter._withUnsafeGuaranteedRef { $0.pull(into: pcm, count: Int(frames)) }
    } else {
        tinyrtc_audio_pull(io.pointee.context, pcm, Int(frames))
    }
    io.pointee.renderFrames += Int(frames)
    return noErr
}

private let inputCallback: AURenderCallback = { refCon, flags, timestamp, bus, frames, _ in
    let io = refCon.assumingMemoryBound(to: AudioIO.self)
    guard let unit = io.pointee.unit, Int(frames) <= io.pointee.captureCapacity else { return noErr }
    var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
        mNumberChannels: 1, mDataByteSize: frames * 2, mData: UnsafeMutableRawPointer(io.pointee.capture)))
    let status = AudioUnitRender(unit, flags, timestamp, bus, frames, &list)
    guard status == noErr else { return status }
    io.pointee.captureFrames += Int(frames)
    if let converter = io.pointee.captureConverter {
        let n = converter._withUnsafeGuaranteedRef {
            $0.push(io.pointee.capture, count: Int(frames), into: io.pointee.converted, capacity: io.pointee.convertedCapacity)
        }
        tinyrtc_audio_push(io.pointee.context, io.pointee.converted, n)
        io.pointee.pushedFrames += n
    } else {
        tinyrtc_audio_push(io.pointee.context, io.pointee.capture, Int(frames))
        io.pointee.pushedFrames += Int(frames)
    }
    return noErr
}

final class VoiceProcessingAudioDevice: AudioDevice, @unchecked Sendable {
    let needsRecordPermission = true
    /// Tests: run the unit's client side at this rate, with our converters, even where it takes
    /// 48 kHz (the unit then converts between it and the hardware, ours between it and the core).
    var forcedRate: Double?

    private var unit: AudioUnit?
    private var io: UnsafeMutablePointer<AudioIO>?
    private var context: CoreContext?
    private var converters: [RateConverter] = []
    private(set) var unitRate: Double = 0
    private(set) var input = false

    /// The most the unit asks for in one callback (4096 with the screen locked).
    private static let maxFrames = 4096

    struct Counters: Sendable {
        var unitRate: Double
        var converted: Bool
        var renderFrames: Int
        var captureFrames: Int
        var pushedFrames: Int
        var pulledFrames: Int
    }

    var counters: Counters? {
        guard let io else { return nil }
        let pulled = io.pointee.renderConverter.map { $0.takeUnretainedValue().pulled } ?? io.pointee.renderFrames
        return Counters(unitRate: unitRate, converted: io.pointee.renderConverter != nil,
                        renderFrames: io.pointee.renderFrames, captureFrames: io.pointee.captureFrames,
                        pushedFrames: io.pointee.pushedFrames, pulledFrames: pulled)
    }

    func start(context: CoreContext, input: Bool, hardwareRate: Double) throws {
        stop()
        if let forcedRate {
            try open(context: context, input: input, rate: forcedRate)
            return
        }
        do {
            try open(context: context, input: input, rate: 48_000)
            return
        } catch {
            log.info("the voice-processing unit does not take 48 kHz (\(String(describing: error), privacy: .public)): converting")
        }
        try open(context: context, input: input, rate: hardwareRate > 0 && hardwareRate != 48_000 ? hardwareRate : 16_000)
    }

    func stop() {
        if let unit {
            AudioOutputUnitStop(unit)
            AudioUnitUninitialize(unit)
            AudioComponentInstanceDispose(unit)
        }
        unit = nil
        if let io {
            io.pointee.capture.deallocate()
            io.pointee.converted.deallocate()
            io.deinitialize(count: 1)
            io.deallocate()
        }
        io = nil
        converters = []
        context = nil
    }

    private func open(context: CoreContext, input: Bool, rate: Double) throws {
        var description = AudioComponentDescription(
            componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_VoiceProcessingIO,
            componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
        guard let component = AudioComponentFindNext(nil, &description) else {
            throw RtcError.failed("no voice-processing audio unit")
        }
        var made: AudioUnit?
        try check(AudioComponentInstanceNew(component, &made), "AudioComponentInstanceNew")
        guard let unit = made else { throw RtcError.failed("no voice-processing audio unit") }

        let converting = rate != 48_000
        let maxConverted = Int((Double(Self.maxFrames) * 48_000 / rate).rounded(.up)) + 64
        let io = UnsafeMutablePointer<AudioIO>.allocate(capacity: 1)
        io.initialize(to: AudioIO(
            context: context.raw, unit: unit,
            capture: .allocate(capacity: Self.maxFrames), captureCapacity: Self.maxFrames,
            converted: .allocate(capacity: maxConverted), convertedCapacity: maxConverted))
        var made_converters: [RateConverter] = []
        if converting {
            guard let render = RateConverter(from: 48_000, to: rate, maxInputFrames: maxConverted, source: corePull,
                                             user: UnsafeMutableRawPointer(context.raw)),
                  let capture = RateConverter(from: rate, to: 48_000, maxInputFrames: Self.maxFrames) else {
                io.pointee.capture.deallocate()
                io.pointee.converted.deallocate()
                io.deallocate()
                AudioComponentInstanceDispose(unit)
                throw RtcError.failed("no sample-rate converter \(rate) <-> 48000")
            }
            io.pointee.renderConverter = Unmanaged.passUnretained(render)
            io.pointee.captureConverter = Unmanaged.passUnretained(capture)
            made_converters = [render, capture]
        }
        // From here on `stop()` frees it all.
        self.unit = unit
        self.io = io
        self.context = context
        converters = made_converters
        unitRate = rate
        self.input = input

        do {
            var on: UInt32 = 1
            var off: UInt32 = 0
            var recording: UInt32 = input ? 1 : 0
            let size4 = UInt32(MemoryLayout<UInt32>.size)
            try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1,
                                           &recording, size4), "EnableIO input")
            try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &on, size4),
                      "EnableIO output")
            var format = pcm16(rate)
            let formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
            // What we render into the unit (bus 0, its input side) and what it records (bus 1, its output side).
            try check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &format, formatSize),
                      "render format")
            if input {
                try check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &format, formatSize),
                          "capture format")
                try check(AudioUnitSetProperty(unit, kAudioUnitProperty_ShouldAllocateBuffer, kAudioUnitScope_Output, 1, &off, size4),
                          "capture buffer")
                var capture = AURenderCallbackStruct(inputProc: inputCallback, inputProcRefCon: UnsafeMutableRawPointer(io))
                try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 1, &capture,
                                               UInt32(MemoryLayout<AURenderCallbackStruct>.size)), "input callback")
            }
            var render = AURenderCallbackStruct(inputProc: renderCallback, inputProcRefCon: UnsafeMutableRawPointer(io))
            try check(AudioUnitSetProperty(unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &render,
                                           UInt32(MemoryLayout<AURenderCallbackStruct>.size)), "render callback")
            var maxFrames = UInt32(Self.maxFrames)
            AudioUnitSetProperty(unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFrames, size4)
            try check(AudioUnitInitialize(unit), "AudioUnitInitialize")
            try check(AudioOutputUnitStart(unit), "AudioOutputUnitStart")
        } catch {
            stop()
            throw error
        }
    }

    private func check(_ status: OSStatus, _ what: String) throws {
        if status != noErr { throw RtcError.failed("\(what): \(status)") }
    }
}

// MARK: the policy

/// Runs the device as the engine wants it ("audio runs while at least one connection exists to be
/// heard or sends the microphone, and stops with the last"), and keeps it running through the
/// session's interruptions, route changes and media-services resets. Everything on `queue`.
final class AudioController: @unchecked Sendable {
    let queue = DispatchQueue(label: "tinyrtc.audio", qos: .userInitiated)
    let device: AudioDevice
    let session: RtcAudioSession
    private let context: CoreContext

    // On `queue`:
    private var wantRun = false
    private var wantInput = false
    /// nil = stopped; otherwise whether the microphone side runs.
    private var running: Bool?
    private var interrupted = false
    private var rate: Double = 0
    private var observers: [NSObjectProtocol] = []

    /// The microphone could not be brought back (any thread).
    var onInputLost: (@Sendable () -> Void)?
    /// The audio route changed (any thread).
    var onRouteChange: (@Sendable () -> Void)?

    init(context: CoreContext, device: AudioDevice, session: RtcAudioSession) {
        self.context = context
        self.device = device
        self.session = session
        queue.async { [self] in
            observers = session.observe(
                on: queue,
                interruption: { [weak self] began in self?.interruption(began: began) },
                routeChange: { [weak self] in self?.routeChanged() },
                reset: { [weak self] in self?.mediaServicesReset() })
        }
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        device.stop()
    }

    func set(run: Bool, input: Bool) {
        queue.async { [self] in
            wantRun = run
            wantInput = input
            reconcile()
        }
    }

    func setOutput(_ output: RtcAudioOutput) {
        queue.async { [self] in session.setOutput(output) }
    }

    /// Stops for good (the engine is going).
    func shutdown() {
        queue.async { [self] in
            wantRun = false
            reconcile()
        }
    }

    private func reconcile() {
        guard !interrupted else { return }
        let wanted: Bool? = wantRun ? wantInput : nil
        guard wanted != running else { return }
        if running != nil {
            device.stop()
            running = nil
        }
        guard let input = wanted else {
            session.deactivate()
            return
        }
        do {
            try session.activate()
            rate = session.hardwareSampleRate
            try device.start(context: context, input: input, hardwareRate: rate)
            running = input
        } catch {
            log.error("audio: \(String(describing: error), privacy: .public)")
            if input { onInputLost?() }
        }
    }

    private func interruption(began: Bool) {
        if began {
            interrupted = true
            if running != nil {
                device.stop()
                running = nil
            }
        } else {
            interrupted = false
            reconcile()
        }
    }

    private func routeChanged() {
        onRouteChange?()
        guard running != nil, session.hardwareSampleRate != rate else { return }
        // Another hardware rate: the unit (or our converters) start again at it.
        device.stop()
        running = nil
        reconcile()
    }

    private func mediaServicesReset() {
        // Every audio object is gone: the unit is made again, the session set up again.
        device.stop()
        running = nil
        interrupted = false
        reconcile()
    }
}
