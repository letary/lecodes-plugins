//
//  SpeechService.swift — lecodes-plugins/speech
//
//  One listening: the microphone through AVAudioEngine into an SFSpeechAudioBufferRecognitionRequest,
//  its task's results as events. Apple finalizes a request when its audio ends (or after about a
//  minute): a pause in the speech is OURS to notice — `SILENCE` seconds without a new partial ends
//  the audio in a one-utterance listening and restarts the request in a continuous one. The channel
//  (the calls, the options, the codes) is Speech.gen.swift, generated from contract.d.ts; a call
//  arrives with the speech and microphone permissions granted.
//

import AVFoundation
import Foundation
import LeCodes
import Speech

final class SpeechService: SpeechPlugin {

    /// Seconds without a new partial result that count as the end of an utterance.
    private static let silence: TimeInterval = 1.6

    private let events: SpeechEvents
    private let audio = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var options: SpeechOptions?
    private var silenceTimer: Timer?
    private var speaking = false
    /// What the app asked for: `stop` finishes the utterance, `abort` drops it; nil = still listening.
    private var ending: Ending?
    private enum Ending { case stop, abort }

    init(_ events: SpeechEvents) { self.events = events }

    // MARK: - the calls

    func start(_ options: SpeechOptions?, _ reply: Reply<Void, SpeechCode>) {
        guard task == nil, !audio.isRunning else { return reply.reject(.busy) }
        let locale = options?.language.map { Locale(identifier: $0) } ?? Locale.current
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else { return reply.reject(.unavailable) }
        if options?.onDevice == true && !recognizer.supportsOnDeviceRecognition { return reply.reject(.unavailable) }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            return reply.reject(.failed)
        }
        self.recognizer = recognizer
        self.options = options
        ending = nil
        speaking = false
        let input = audio.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        audio.prepare()
        do {
            try audio.start()
        } catch {
            input.removeTap(onBus: 0)
            return reply.reject(.failed)
        }
        listen()
        reply.resolve()
    }

    func stop(_ reply: Reply<Void, SpeechCode>) {
        if task != nil {
            ending = .stop
            request?.endAudio()   // the final result comes, then the task ends
        }
        reply.resolve()
    }

    func abort(_ reply: Reply<Void, SpeechCode>) {
        if task != nil {
            ending = .abort
            task?.cancel()
        }
        reply.resolve()
    }

    func supportedLanguages(_ reply: Reply<[String], SpeechCode>) {
        reply.resolve(SFSpeechRecognizer.supportedLocales().map { $0.identifier.replacingOccurrences(of: "_", with: "-") }.sorted())
    }

    func close() {
        ending = .abort
        task?.cancel()
        tearDown()
    }

    // MARK: - one request

    private func listen() {
        guard let recognizer else { return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = options?.interimResults ?? true
        if #available(iOS 13.0, *), options?.onDevice == true { request.requiresOnDeviceRecognition = true }
        self.request = request
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async { self?.heard(result, error) }
        }
    }

    private func heard(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
        if let result {
            if !speaking {
                speaking = true
                events.speechStart()
            }
            let text = result.bestTranscription.formattedString
            let confidence = result.isFinal ? result.bestTranscription.segments.map { Double($0.confidence) }.min() : nil
            if result.isFinal || options?.interimResults ?? true {
                events.result(SpeechResult(transcript: text, isFinal: result.isFinal, confidence: confidence))
            }
            if result.isFinal { utteranceDone() } else { armSilence() }
            return
        }
        guard let error else { return }
        silenceTimer?.invalidate()
        // Apple's "no speech detected" and our own cancels are not failures of the app's.
        let nsError = error as NSError
        if ending == .abort {
            finish()
        } else if nsError.domain == "kAFAssistantErrorDomain" && (nsError.code == 1110 || nsError.code == 203 || nsError.code == 216) {
            if speaking { utteranceDone() } else { fail(.noSpeech, "no speech was heard") }
        } else {
            fail(nsError.domain == NSURLErrorDomain ? .network : .failed, error.localizedDescription)
        }
    }

    /// Silence: the utterance is over — end its audio (the final result follows).
    private func armSilence() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: Self.silence, repeats: false) { [weak self] _ in
            guard let self, self.ending == nil else { return }
            self.speaking = false
            self.events.speechEnd()
            self.request?.endAudio()
        }
    }

    private func utteranceDone() {
        silenceTimer?.invalidate()
        task = nil
        request = nil
        if ending == nil, options?.continuous == true, audio.isRunning {
            speaking = false
            listen()   // the next utterance on the same microphone
        } else {
            finish()
        }
    }

    private func fail(_ code: SpeechErrorCode, _ message: String) {
        events.error(code: code, message: message)
        finish()
    }

    private func finish() {
        tearDown()
        events.end()
    }

    private func tearDown() {
        silenceTimer?.invalidate()
        silenceTimer = nil
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if audio.isRunning {
            audio.stop()
            audio.inputNode.removeTap(onBus: 0)
        }
        speaking = false
    }
}
