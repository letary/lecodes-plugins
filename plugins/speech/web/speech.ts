// speech on the web: the browser's SpeechRecognition (webkitSpeechRecognition in Chrome and Safari;
// Firefox has none — the plugin does not register there and `isSupported` is false). The browser
// prompts for the microphone itself and reports a refusal as the "not-allowed" error, which arrives
// as the `denied` error event. `onDevice` is ignored: where the audio goes is the browser's.
//
// The channel is the contract's (../contract.d.ts): speech.gen.ts is generated from it, this file
// implements its SpeechPlugin.

import { SpeechError, registerSpeech, type PluginHost, type SpeechErrorCode, type SpeechOptions, type SpeechPlugin } from "./speech.gen"

type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((e: any) => void) | null
  onspeechstart: (() => void) | null
  onspeechend: (() => void) | null
  onend: (() => void) | null
  onerror: ((e: any) => void) | null
  start(): void
  stop(): void
  abort(): void
}

const recognitionClass = (): (new () => Recognition) | null => {
  const w = globalThis as any
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

const codeOf = (error: string): SpeechErrorCode =>
  error === "no-speech" ? "noSpeech"
  : error === "audio-capture" ? "audio"
  : error === "network" ? "network"
  : error === "not-allowed" || error === "service-not-allowed" ? "denied"
  : error === "aborted" ? "aborted"
  : error === "language-not-supported" ? "unavailable"
  : "failed"

export const register = (host: PluginHost): void => {
  if (!recognitionClass()) return

  registerSpeech(host, (_params, events): SpeechPlugin => {
    let recognition: Recognition | null = null
    let aborted = false

    const tearDown = (): void => {
      if (!recognition) return
      recognition.onresult = recognition.onend = recognition.onerror = recognition.onspeechstart = recognition.onspeechend = null
      recognition = null
    }

    return {
      async start(options?: SpeechOptions): Promise<void> {
        if (recognition) throw new SpeechError("busy")
        const Recognition = recognitionClass()
        if (!Recognition) throw new SpeechError("unavailable")
        const r = new Recognition()
        if (options?.language) r.lang = options.language
        r.continuous = options?.continuous ?? false
        r.interimResults = options?.interimResults ?? true
        r.maxAlternatives = 1
        aborted = false
        r.onspeechstart = () => events.speechStart()
        r.onspeechend = () => events.speechEnd()
        r.onresult = (e: any) => {
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const result = e.results[i]
            const best = result[0]
            if (!best) continue
            events.result({ transcript: best.transcript, isFinal: !!result.isFinal, confidence: result.isFinal && typeof best.confidence === "number" ? best.confidence : null })
          }
        }
        r.onerror = (e: any) => {
          const error = String(e?.error ?? "")
          if (aborted || error === "aborted") return
          events.error({ code: codeOf(error), message: String(e?.message || error || "recognition failed") })
        }
        r.onend = () => {
          tearDown()
          events.end()
        }
        recognition = r
        try {
          r.start()
        } catch {
          tearDown()
          throw new SpeechError("failed")
        }
      },

      async stop(): Promise<void> {
        recognition?.stop()   // the final result, then onend
      },

      async abort(): Promise<void> {
        if (!recognition) return
        aborted = true
        recognition.abort()   // onend follows
      },

      async supportedLanguages(): Promise<string[]> {
        return []   // the browser does not say
      },

      close(): void {
        if (!recognition) return
        aborted = true
        const r = recognition
        tearDown()
        r.abort()
      },
    }
  })
}
