//
//  AudioRecorderService.swift — lecodes-plugins/audio-recorder
//
//  One recording: the microphone's samples (AVAudioEngine's input into an AVAudioSinkNode — a tap
//  would hand them over a tenth of a second at a time), taken to a queue of the recording, which
//    - writes them into a temporary .m4a (AVAudioFile, AAC) — not with `file: false`;
//    - says what it hears, `rate` times a second: `level` (the loudest sample since the tick
//      before) and, while the app listens, `pitch` (PitchDetector over the newest window).
//  A pause drops the samples: nothing is written, nothing is said, the duration (the samples that
//  were kept) does not grow. The recording ends by the app, by its own limit (`maxDuration`) or by
//  an interruption of the audio session (a phone call); the file is kept until `stop()` hands it
//  over or `cancel()`. `raw` is the session's measurement mode: the least processing iOS has.
//  The samples are at the DEVICE's rate (the session is asked for `sampleRate`, and may say no).
//
//  The channel (the calls, the options, the codes) is AudioRecorder.gen.swift, generated from
//  contract.d.ts; a call arrives on the main thread with the microphone permission granted.
//

import AVFoundation
import Foundation
import LeCodes

final class AudioRecorderService: NSObject, AudioRecorderPlugin {

    private let events: AudioRecorderEvents
    /// The recording under way, or the one that ended and waits for stop().
    private var capture: Capture?
    private var interruption: NSObjectProtocol?
    /// The recording stopped on its own: what was recorded waits for stop().
    private var finished = false

    init(_ events: AudioRecorderEvents) {
        self.events = events
        super.init()
    }

    // MARK: - the calls

    func start(_ options: RecordOptions?, _ reply: Reply<Void, AudioRecorderCode>) {
        guard capture == nil else { return reply.reject(.busy) }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: options?.raw == true ? .measurement : .default, options: [.defaultToSpeaker, .allowBluetooth])
            try? session.setPreferredSampleRate(options?.sampleRate ?? 44100)
            try? session.setPreferredIOBufferDuration(0.01)
            try session.setActive(true)
        } catch {
            return reply.reject(.failed)
        }
        let file = options?.file == false ? nil : FileManager.default.temporaryDirectory.appendingPathComponent("lecodes-recording-\(UUID().uuidString).m4a")
        let capture: Capture
        do {
            capture = try Capture(options, file, events)
            capture.onEnded = { [weak self, weak capture] reason in
                guard let self, let capture else { return }
                self.finish(capture, reason)
            }
            try capture.start()
        } catch {
            if let file { try? FileManager.default.removeItem(at: file) }
            return reply.reject(.failed)
        }
        self.capture = capture
        finished = false
        interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self, weak capture] note in
            guard let self, let capture, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            self.finish(capture, .interrupted)
        }
        reply.resolve()
    }

    func pause(_ reply: Reply<Void, AudioRecorderCode>) {
        guard let capture, !finished else { return reply.reject(.notRecording) }
        capture.setPaused(true)
        reply.resolve()
    }

    func resume(_ reply: Reply<Void, AudioRecorderCode>) {
        guard let capture, !finished else { return reply.reject(.notRecording) }
        capture.setPaused(false)
        reply.resolve()
    }

    func stop(_ reply: Reply<Recording, AudioRecorderCode>) {
        guard let capture else { return reply.reject(.notRecording) }
        let (seconds, written) = capture.end()
        defer { discard() }
        guard let url = capture.url else { return reply.resolve(Recording(file: nil, mimeType: "", duration: seconds)) }
        guard written, let data = try? Data(contentsOf: url), !data.isEmpty else { return reply.reject(.failed) }
        reply.resolve(Recording(file: PluginFile(data: data, name: "recording.m4a"), mimeType: "audio/mp4", duration: seconds))
    }

    func cancel(_ reply: Reply<Void, AudioRecorderCode>) {
        _ = capture?.end()
        discard()
        reply.resolve()
    }

    /// `pitch` is sent — and looked for — while `events.pitchObserved`: the capture reads it each tick.
    func pitchObserved(_ observed: Bool) {}

    func close() {
        _ = capture?.end()
        discard()
    }

    // MARK: - plumbing

    /// The recording stopped on its own: keep the file, tell the app.
    private func finish(_ capture: Capture, _ reason: EndReason) {
        guard self.capture === capture, !finished else { return }
        _ = capture.end()
        finished = true
        events.ended(reason: reason)
    }

    private func discard() {
        if let url = capture?.url { try? FileManager.default.removeItem(at: url) }
        capture = nil
        finished = false
        if let interruption { NotificationCenter.default.removeObserver(interruption) }
        interruption = nil
    }
}

/// One recording's engine, file and queue. Made, started and ended on the main thread; the samples
/// are the queue's.
private final class Capture {

    let url: URL?
    /// The recording stopped on its own (the limit, a failure of the file). Called on the main thread.
    var onEnded: ((EndReason) -> Void)?

    private let events: AudioRecorderEvents
    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "lecodes.audio-recorder")
    private let sampleRate: Double
    /// The samples between two ticks of the events.
    private let tickFrames: Int
    /// The samples of the limit; 0 = none.
    private let maxFrames: Int64
    private let detector: PitchDetector

    // The queue's:
    private var file: AVAudioFile?
    /// The newest samples, the last one at the end.
    private var window: [Float]
    private var paused = false
    /// Nothing more is kept: the recording ended (by the app or on its own).
    private var closed = false
    private var failed = false
    /// The samples that were kept (the pauses left out).
    private var frames: Int64 = 0
    private var peak: Float = 0
    private var sinceTick = 0

    init(_ options: RecordOptions?, _ url: URL?, _ events: AudioRecorderEvents) throws {
        self.url = url
        self.events = events
        let format = engine.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw CaptureError.noInput }
        sampleRate = format.sampleRate
        tickFrames = max(1, Int(sampleRate / min(50, max(1, options?.rate ?? 10))))
        maxFrames = Int64((options?.maxDuration ?? 0) / 1000 * sampleRate)
        detector = PitchDetector(sampleRate: sampleRate)
        window = [Float](repeating: 0, count: detector.size)
        if let url {
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: sampleRate,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: Int((options?.bitrate ?? 64) * 1000),
            ]
            file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        }
        // The sink's block runs on the audio thread: it only takes the first channel's samples
        // out (the engine's own format: Float32, a buffer per channel) and hands them to the queue.
        let sink = AVAudioSinkNode { [weak self] _, frameCount, list -> OSStatus in
            guard let self, frameCount > 0, let data = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list)).first?.mData else { return noErr }
            let chunk = Array(UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self), count: Int(frameCount)))
            self.queue.async { self.take(chunk) }
            return noErr
        }
        engine.attach(sink)
        engine.connect(engine.inputNode, to: sink, format: format)
    }

    func start() throws {
        engine.prepare()
        try engine.start()
    }

    func setPaused(_ paused: Bool) {
        queue.async {
            self.paused = paused
            self.peak = 0
            self.sinceTick = 0
        }
    }

    /// Stop hearing and close the file: the seconds that were kept, and whether a file that plays
    /// was written. Safe to call again.
    func end() -> (seconds: Double, written: Bool) {
        if engine.isRunning { engine.stop() }
        return queue.sync {
            closed = true
            file = nil                               // the file is finished when it is let go
            return (Double(frames) / sampleRate, url != nil && !failed && frames > 0)
        }
    }

    // MARK: - the queue's

    private func take(_ chunk: [Float]) {
        if closed || paused { return }
        let n = chunk.count

        if n >= window.count {
            window = Array(chunk[(n - window.count)...])
        } else {
            window.removeFirst(n)
            window.append(contentsOf: chunk)
        }
        for s in chunk { let a = abs(s); if a > peak { peak = a } }

        if let file {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(n)),
                  let channel = buffer.floatChannelData?[0] else { return fail() }
            buffer.frameLength = AVAudioFrameCount(n)
            chunk.withUnsafeBufferPointer { src in _ = memcpy(channel, src.baseAddress!, n * MemoryLayout<Float>.size) }
            do { try file.write(from: buffer) } catch { return fail() }
        }
        frames += Int64(n)

        sinceTick += n
        if sinceTick >= tickFrames {
            sinceTick = 0
            events.level(value: Double(min(1, peak)))
            peak = 0
            if events.pitchObserved {
                let (frequency, clarity) = detector.detect(window)
                events.pitch(frequency: frequency, clarity: clarity)
            }
        }
        if maxFrames > 0 && frames >= maxFrames { ended(.maxDuration) }
    }

    private func fail() {
        failed = true
        ended(.failed)
    }

    /// Nothing more is kept; the service is told on the main thread (it ends the capture there).
    private func ended(_ reason: EndReason) {
        closed = true
        DispatchQueue.main.async { [weak self] in self?.onEnded?(reason) }
    }

    private enum CaptureError: Error { case noInput }
}
