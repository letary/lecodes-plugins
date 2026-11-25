// audio-recorder on the web: a getUserMedia audio stream, MediaRecorder over it for the file (not
// with `file: false`), an AnalyserNode for what is heard. The browser prompts for the microphone
// itself (the contract's `@permission` is the native halves' gate); the file is what the browser
// encodes — mp4 where it can (Safari), webm/opus elsewhere — and `mimeType` says which.
//
// What is heard: the analyser keeps the last `fftSize` samples, sized to hold more than a tick's
// worth — so each tick reads everything since the one before: `level` is the loudest of those
// samples, `pitch` the note in the newest window (pitch.ts), found only while the app listens.
// `raw` turns the browser's voice processing off (echo cancellation, noise suppression, gain).
//
// The channel is the contract's (../contract.d.ts): audio-recorder.gen.ts is generated from it,
// this file implements its AudioRecorderPlugin.

import { AudioRecorderError, registerAudioRecorder, type AudioRecorderPlugin, type PluginHost, type RecordOptions, type Recording } from "./audio-recorder.gen"
import { createPitchDetector } from "./pitch"

/** The containers in the order we would rather have them; the first the browser encodes wins. */
const PREFERRED = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]

const extensionOf = (mime: string): string => mime.startsWith("audio/mp4") ? "m4a" : mime.startsWith("audio/ogg") ? "ogg" : "webm"

/** The events a second: 10 unless asked, 1..50. */
const rateOf = (options?: RecordOptions): number => Math.min(50, Math.max(1, options?.rate ?? 10))

export const register = (host: PluginHost): void => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return

  registerAudioRecorder(host, (_params, events): AudioRecorderPlugin => {
    let stream: MediaStream | null = null
    /** A recording is under way or waits for stop(): from a start to the stop / cancel. */
    let active = false
    /** The encoder; none with `file: false`. */
    let recorder: MediaRecorder | null = null
    let chunks: Blob[] = []
    let mime = ""
    let context: AudioContext | null = null
    let meter: ReturnType<typeof setInterval> | null = null
    let limit: ReturnType<typeof setTimeout> | null = null
    let rate = 10
    /** The app listens to `pitch` (a @lazy event). */
    let pitchObserved = false
    // Milliseconds recorded before the running segment, and when it began (0 = paused).
    let recordedMs = 0
    let segmentStart = 0
    /** The recording stopped on its own: what was recorded waits for stop(). */
    let finished = false
    let stopped: Promise<void> | null = null

    const segmentEnd = (): void => {
      if (segmentStart) { recordedMs += performance.now() - segmentStart; segmentStart = 0 }
    }

    const startMeter = (): void => {
      if (!stream || meter) return
      try {
        const audio = context ??= new AudioContext()
        void audio.resume().catch(() => {})
        const detector = createPitchDetector(audio.sampleRate)
        // More than a tick of samples (a late timer still finds all of its own), and a detector's window.
        const need = Math.max(detector.size, Math.ceil(audio.sampleRate / rate * 1.5))
        const analyser = audio.createAnalyser()
        analyser.fftSize = Math.min(32768, 2 ** Math.ceil(Math.log2(need)))
        audio.createMediaStreamSource(stream).connect(analyser)
        const samples = new Float32Array(analyser.fftSize)
        let heardUntil = audio.currentTime
        meter = setInterval(() => {
          const now = audio.currentTime
          if (!segmentStart) { heardUntil = now; return }      // paused: nothing of it is heard later
          const fresh = Math.min(samples.length, Math.round((now - heardUntil) * audio.sampleRate))
          heardUntil = now
          if (fresh <= 0) return
          analyser.getFloatTimeDomainData(samples)
          let peak = 0
          for (let i = samples.length - fresh; i < samples.length; i++) { const a = Math.abs(samples[i]!); if (a > peak) peak = a }
          events.level({ value: Math.min(1, peak) })
          if (pitchObserved) events.pitch(detector.detect(samples, samples.length - detector.size))
        }, 1000 / rate)
      } catch { /* no AudioContext: no events, the recording still runs */ }
    }

    const stopMeter = (): void => {
      if (meter) clearInterval(meter)
      meter = null
    }

    /** Stop the recorder (its last chunk arrives before `onstop`) and the stream. */
    const stopRecorder = (): Promise<void> => {
      if (stopped) return stopped
      const r = recorder
      segmentEnd()
      stopMeter()
      if (limit) clearTimeout(limit)
      limit = null
      stopped = new Promise<void>(resolve => {
        if (!r || r.state === "inactive") return resolve()
        r.onstop = () => resolve()
        r.stop()
      }).then(() => {
        stream?.getTracks().forEach(t => t.stop())
        stream = null
        context?.close().catch(() => {})
        context = null
      })
      return stopped
    }

    const discard = (): void => {
      active = false
      recorder = null
      chunks = []
      finished = false
      stopped = null
    }

    const finish = (reason: "maxDuration" | "interrupted" | "failed"): void => {
      if (finished || !active) return
      finished = true
      void stopRecorder().then(() => events.ended({ reason }))
    }

    return {
      async start(options?: RecordOptions): Promise<void> {
        if (active) throw new AudioRecorderError("busy")
        const toFile = options?.file !== false
        if (toFile && typeof MediaRecorder === "undefined") throw new AudioRecorderError("failed")
        active = true
        const audio: MediaTrackConstraints = {}
        if (options?.sampleRate) audio.sampleRate = options.sampleRate
        if (options?.raw) { audio.echoCancellation = false; audio.noiseSuppression = false; audio.autoGainControl = false }
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: Object.keys(audio).length ? audio : true })
        } catch (e) {
          discard()
          const name = e instanceof Error ? e.name : ""
          throw new AudioRecorderError(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "failed")
        }
        if (!active) {                                           // cancelled while the browser asked
          stream.getTracks().forEach(t => t.stop())
          stream = null
          throw new AudioRecorderError("failed")
        }
        chunks = []
        mime = ""
        if (toFile) {
          mime = PREFERRED.find(m => MediaRecorder.isTypeSupported(m)) ?? ""
          try {
            recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: (options?.bitrate ?? 64) * 1000 })
          } catch {
            stream.getTracks().forEach(t => t.stop())
            stream = null
            discard()
            throw new AudioRecorderError("failed")
          }
          mime = recorder.mimeType || mime || "audio/webm"
          recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
          recorder.onerror = () => finish("failed")
          recorder.start(250)
        }
        rate = rateOf(options)
        recordedMs = 0
        finished = false
        stopped = null
        stream.getAudioTracks()[0]?.addEventListener("ended", () => finish("interrupted"))
        segmentStart = performance.now()
        startMeter()
        if (options?.maxDuration && options.maxDuration > 0) limit = setTimeout(() => finish("maxDuration"), options.maxDuration)
      },

      async pause(): Promise<void> {
        if (!active || finished) throw new AudioRecorderError("notRecording")
        if (segmentStart) {
          if (recorder?.state === "recording") recorder.pause()
          segmentEnd()
        }
      },

      async resume(): Promise<void> {
        if (!active || finished) throw new AudioRecorderError("notRecording")
        if (!segmentStart) {
          if (recorder?.state === "paused") recorder.resume()
          segmentStart = performance.now()
        }
      },

      async stop(): Promise<Recording> {
        if (!active) throw new AudioRecorderError("notRecording")
        const toFile = recorder !== null
        await stopRecorder()
        const blob = new Blob(chunks, { type: mime })
        const seconds = recordedMs / 1000
        const container = mime.split(";")[0]!
        discard()
        if (!toFile) return { file: null, mimeType: "", duration: seconds }
        if (blob.size === 0) throw new AudioRecorderError("failed")
        return { file: { data: await blob.arrayBuffer(), name: `recording.${extensionOf(container)}` }, mimeType: container, duration: seconds }
      },

      async cancel(): Promise<void> {
        if (active) await stopRecorder()
        discard()
      },

      pitchObserved(observed: boolean): void {
        pitchObserved = observed
      },

      close(): void {
        void stopRecorder()
        discard()
      },
    }
  })
}
