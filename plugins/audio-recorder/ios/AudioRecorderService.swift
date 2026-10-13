//
//  AudioRecorderService.swift — lecodes-plugins/audio-recorder
//
//  One recording: AVAudioRecorder into a temporary .m4a (AAC), metered ten times a second for the
//  `level` event, stopped by the app, by its own limit (`maxDuration`) or by an interruption of the
//  audio session (a phone call). The file is kept until `stop()` hands it over or `cancel()`.
//  The channel (the calls, the options, the codes) is AudioRecorder.gen.swift, generated from
//  contract.d.ts; a call arrives with the microphone permission granted.
//

import AVFoundation
import Foundation
import LeCodes

final class AudioRecorderService: NSObject, AudioRecorderPlugin, AVAudioRecorderDelegate {

    private let events: AudioRecorderEvents
    private var recorder: AVAudioRecorder?
    private var url: URL?
    private var meter: Timer?
    private var interruption: NSObjectProtocol?
    /// Seconds recorded, read from the recorder while it runs (it reads 0 once stopped).
    private var duration: TimeInterval = 0
    /// The recording stopped on its own (or by us): the file is complete and waits for stop().
    private var finished = false
    /// A stop of ours: the delegate's "did finish" is not an `ended` then.
    private var stopping = false

    init(_ events: AudioRecorderEvents) {
        self.events = events
        super.init()
    }

    // MARK: - the calls

    func start(_ options: RecordOptions?, _ reply: Reply<Void, AudioRecorderCode>) {
        guard recorder == nil, url == nil else { return reply.reject(.busy) }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
        } catch {
            return reply.reject(.failed)
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("lecodes-recording-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: options?.sampleRate ?? 44100,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: Int((options?.bitrate ?? 64) * 1000),
        ]
        let recorder: AVAudioRecorder
        do {
            recorder = try AVAudioRecorder(url: file, settings: settings)
        } catch {
            return reply.reject(.failed)
        }
        recorder.delegate = self
        recorder.isMeteringEnabled = true
        guard recorder.prepareToRecord() else { return reply.reject(.failed) }
        let limit = options?.maxDuration ?? 0
        let started = limit > 0 ? recorder.record(forDuration: limit / 1000) : recorder.record()
        guard started else {
            try? FileManager.default.removeItem(at: file)
            return reply.reject(.failed)
        }
        self.recorder = recorder
        self.url = file
        duration = 0
        finished = false
        stopping = false
        startMeter()
        interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            self.finish(.interrupted)
        }
        reply.resolve()
    }

    func pause(_ reply: Reply<Void, AudioRecorderCode>) {
        guard let recorder, !finished else { return reply.reject(.notRecording) }
        duration = recorder.currentTime
        recorder.pause()
        stopMeter()
        reply.resolve()
    }

    func resume(_ reply: Reply<Void, AudioRecorderCode>) {
        guard let recorder, !finished else { return reply.reject(.notRecording) }
        guard recorder.record() else { return reply.reject(.failed) }
        startMeter()
        reply.resolve()
    }

    func stop(_ reply: Reply<Recording, AudioRecorderCode>) {
        guard let url else { return reply.reject(.notRecording) }
        stopRecorder()
        defer { discard() }
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return reply.reject(.failed) }
        reply.resolve(Recording(file: PluginFile(data: data, name: "recording.m4a"), mimeType: "audio/mp4", duration: duration))
    }

    func cancel(_ reply: Reply<Void, AudioRecorderCode>) {
        stopRecorder()
        discard()
        reply.resolve()
    }

    func close() {
        stopRecorder()
        discard()
    }

    // MARK: - the recorder's own ends

    func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        guard !stopping, !finished else { return }
        finish(flag ? .maxDuration : .failed)
    }

    func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        guard !finished else { return }
        finish(.failed)
    }

    /// The recording stopped on its own: keep the file, tell the app.
    private func finish(_ reason: EndReason) {
        stopRecorder()
        finished = true
        events.ended(reason: reason)
    }

    // MARK: - plumbing

    private func stopRecorder() {
        guard let recorder else { return }
        if recorder.isRecording || duration == 0 { duration = max(duration, recorder.currentTime) }
        stopping = true
        recorder.stop()
        stopMeter()
        self.recorder = nil
        if let interruption { NotificationCenter.default.removeObserver(interruption) }
        interruption = nil
    }

    private func discard() {
        if let url { try? FileManager.default.removeItem(at: url) }
        url = nil
        finished = false
    }

    private func startMeter() {
        stopMeter()
        meter = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self, let recorder = self.recorder, recorder.isRecording else { return }
            recorder.updateMeters()
            self.duration = recorder.currentTime
            // dB full scale (−160…0) to a linear 0…1.
            let level = pow(10, Double(recorder.averagePower(forChannel: 0)) / 20)
            self.events.level(value: min(max(level, 0), 1))
        }
    }

    private func stopMeter() {
        meter?.invalidate()
        meter = nil
    }
}
