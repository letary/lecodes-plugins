// audio-recorder on the web: MediaRecorder over a getUserMedia audio stream, the level from an
// AnalyserNode. The browser prompts for the microphone itself (the contract's `@permission` is the
// native halves' gate); the file is what the browser encodes — mp4 where it can (Safari), webm/opus
// elsewhere — and `mimeType` says which.
//
// The channel is the contract's (../contract.d.ts): audio-recorder.gen.ts is generated from it,
// this file implements its AudioRecorderPlugin.

import { AudioRecorderError, registerAudioRecorder, type AudioRecorderPlugin, type PluginHost, type RecordOptions, type Recording } from "./audio-recorder.gen"

/** The containers in the order we would rather have them; the first the browser encodes wins. */
const PREFERRED = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]

const extensionOf = (mime: string): string => mime.startsWith("audio/mp4") ? "m4a" : mime.startsWith("audio/ogg") ? "ogg" : "webm"

export const register = (host: PluginHost): void => {
  if (typeof MediaRecorder === "undefined" || typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return

  registerAudioRecorder(host, (_params, events): AudioRecorderPlugin => {
    let stream: MediaStream | null = null
    let recorder: MediaRecorder | null = null
    let chunks: Blob[] = []
    let mime = ""
    let context: AudioContext | null = null
    let meter: ReturnType<typeof setInterval> | null = null
    let limit: ReturnType<typeof setTimeout> | null = null
    // Milliseconds recorded before the running segment, and when it began (0 = paused).
    let recordedMs = 0
    let segmentStart = 0
    /** The recording stopped on its own: the chunks are complete and wait for stop(). */
    let finished = false
    let stopped: Promise<void> | null = null

    const segmentEnd = (): void => {
      if (segmentStart) { recordedMs += performance.now() - segmentStart; segmentStart = 0 }
    }

    const startMeter = (): void => {
      if (!stream || meter) return
      try {
        context ??= new AudioContext()
        const analyser = context.createAnalyser()
        analyser.fftSize = 256
        context.createMediaStreamSource(stream).connect(analyser)
        const samples = new Uint8Array(analyser.fftSize)
        meter = setInterval(() => {
          if (!segmentStart) return
          analyser.getByteTimeDomainData(samples)
          let sum = 0
          for (const s of samples) { const v = (s - 128) / 128; sum += v * v }
          events.level({ value: Math.min(1, Math.sqrt(sum / samples.length) * 2) })
        }, 100)
      } catch { /* no AudioContext: no meter, the recording still runs */ }
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
      recorder = null
      chunks = []
      finished = false
      stopped = null
    }

    const finish = (reason: "maxDuration" | "interrupted" | "failed"): void => {
      if (finished || !recorder) return
      finished = true
      void stopRecorder().then(() => events.ended({ reason }))
    }

    return {
      async start(options?: RecordOptions): Promise<void> {
        if (recorder) throw new AudioRecorderError("busy")
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: options?.sampleRate ? { sampleRate: options.sampleRate } : true })
        } catch (e) {
          const name = e instanceof Error ? e.name : ""
          throw new AudioRecorderError(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "failed")
        }
        mime = PREFERRED.find(m => MediaRecorder.isTypeSupported(m)) ?? ""
        try {
          recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: (options?.bitrate ?? 64) * 1000 })
        } catch {
          stream.getTracks().forEach(t => t.stop())
          stream = null
          throw new AudioRecorderError("failed")
        }
        mime = recorder.mimeType || mime || "audio/webm"
        chunks = []
        recordedMs = 0
        finished = false
        stopped = null
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
        recorder.onerror = () => finish("failed")
        stream.getAudioTracks()[0]?.addEventListener("ended", () => finish("interrupted"))
        recorder.start(250)
        segmentStart = performance.now()
        startMeter()
        if (options?.maxDuration && options.maxDuration > 0) limit = setTimeout(() => finish("maxDuration"), options.maxDuration)
      },

      async pause(): Promise<void> {
        if (!recorder || finished) throw new AudioRecorderError("notRecording")
        if (recorder.state === "recording") {
          recorder.pause()
          segmentEnd()
        }
      },

      async resume(): Promise<void> {
        if (!recorder || finished) throw new AudioRecorderError("notRecording")
        if (recorder.state === "paused") {
          recorder.resume()
          segmentStart = performance.now()
        }
      },

      async stop(): Promise<Recording> {
        if (!recorder) throw new AudioRecorderError("notRecording")
        await stopRecorder()
        const blob = new Blob(chunks, { type: mime })
        const seconds = recordedMs / 1000
        const container = mime.split(";")[0]!
        discard()
        if (blob.size === 0) throw new AudioRecorderError("failed")
        return { file: { data: await blob.arrayBuffer(), name: `recording.${extensionOf(container)}` }, mimeType: container, duration: seconds }
      },

      async cancel(): Promise<void> {
        if (recorder) await stopRecorder()
        discard()
      },

      close(): void {
        void stopRecorder()
        discard()
      },
    }
  })
}
