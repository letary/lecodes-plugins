// speech — speech recognition: the microphone to text, live (dictation, voice commands).
// A session is ONE listening (the app-facing `SpeechRecognizer` opens one per `start()`): results
// arrive as events, partial ones while the user speaks and a final one after, then `end`. The
// permissions are the contract's (`@permission speech microphone` on start): the host asks, the
// halves never do.
//
// The recognizer is the platform's: Apple's (SFSpeechRecognizer: on-device where the language
// allows, else Apple's servers), Google's on Android (the device's RecognitionService — absent on a
// phone without Google's app: `start` rejects "unavailable"), the browser's on the web (Chrome sends
// the audio to Google; Safari to Apple). Languages and quality differ with them.

import type { Service, f64 } from "lecodes-sdk/plugin"

export interface SpeechOptions {
  /** BCP-47 — "en-US", "ru-RU". Default: the device's language. */
  language?: string
  /** Keep listening and delivering results until `stop()`; default false: one utterance — the
   *  listening ends after a pause in the speech. */
  continuous?: boolean
  /** Deliver partial results while the user speaks (`isFinal` false). Default true. */
  interimResults?: boolean
  /** Recognize on the device only — no audio leaves it; fewer languages, and "unavailable" where
   *  the device cannot. Default false. The web ignores it. */
  onDevice?: boolean
}

export interface SpeechResult {
  /** The text so far (a partial), or of the utterance (final). */
  transcript: string
  isFinal: boolean
  /** 0..1 when the recognizer says; null when it does not (partials, Android). */
  confidence: f64 | null
}

export type SpeechErrorCode = "noSpeech" | "audio" | "network" | "denied" | "aborted" | "unavailable" | "failed"

export interface SpeechParams {}

export interface SpeechEvents {
  /** A result: partials while speaking (when `interimResults`), then the final one. */
  result: SpeechResult
  /** The user started speaking. */
  speechStart: void
  /** The user stopped speaking (a pause): the final result follows. */
  speechEnd: void
  /** The listening is over — after the final result, after `stop()` / `abort()`, after an error. */
  end: void
  /** The listening failed; `end` follows. "noSpeech": nothing was heard (not continuous). */
  error: { code: SpeechErrorCode, message: string }
}

export interface Speech extends Service<"speech", SpeechParams, SpeechEvents> {
  /** Start listening. One listening per session: a second start rejects "busy". "unavailable":
   *  no recognizer on this device, or none for the language / on the device.
   *  @permission speech microphone
   *  @rejects busy unavailable failed */
  start(options?: SpeechOptions): Promise<void>
  /** Stop listening and finish: the final result of what was heard, then `end`. Not listening is
   *  not an error. */
  stop(): Promise<void>
  /** Stop and drop what was heard: `end`, no result. */
  abort(): Promise<void>
  /** The languages this host recognizes, BCP-47; empty when the host cannot say (the web). */
  supportedLanguages(): Promise<string[]>
}
