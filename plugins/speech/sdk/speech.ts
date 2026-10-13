// SpeechRecognizer — speech recognition: the microphone to text, live (dictation, voice commands).
//
// Hand-written over the generated wire because the app's object is not the wire's session: a
// `SpeechRecognizer` is reusable — every `start()` opens a fresh host session (one listening),
// `end` closes it — and its events are the SDK's `addEventListener` pattern.
//
// The permissions (speech recognition, the microphone) are asked by the host on `start()` (the
// contract's `@permission`); to ask earlier, or to act on a denial, `permissions`.

import { Emitter } from "lecodes-sdk/plugin"
import { SpeechBase, NAME } from "./speech.gen"
import type { SpeechErrorCode, SpeechOptions, SpeechResult } from "../contract"

export type { SpeechErrorCode, SpeechOptions, SpeechResult }

export type SpeechRecognizerEvents = {
  /** A result: partials while the user speaks (`interimResults`), then the final one. */
  result: (result: SpeechResult) => void
  /** The user started speaking. */
  speechStart: () => void
  /** The user stopped speaking: the final result follows. */
  speechEnd: () => void
  /** The listening is over — after the final result, after `stop()` / `abort()`, after an error. */
  end: () => void
  /** The listening failed; `end` follows. */
  error: (code: SpeechErrorCode, message: string) => void
}

/**
 * Recognizes speech from the microphone. `SpeechRecognizer.isSupported` reports whether this host
 * registered the service — check it before showing a dictation button.
 *
 * ```ts
 * const speech = new SpeechRecognizer()
 * speech.addEventListener('result', r => input.value = r.transcript)
 * speech.addEventListener('end', () => micButton.style({ opacity: 1 }))
 * await speech.start({ language: 'en-US' })
 * ```
 */
export class SpeechRecognizer extends Emitter<SpeechRecognizerEvents> {
  /** Whether this host registered a "speech" service. */
  static get isSupported(): boolean { return SpeechBase.supports(NAME) }

  private _session: SpeechBase | null = null

  /** Whether a listening is under way. */
  get listening(): boolean { return this._session !== null }

  /** Start listening. The host asks for the permissions first; rejects `"denied"` when refused,
   *  `"unavailable"` when there is no recognizer for the language or on the device, and before
   *  touching the host when the plugin is not there or a listening is under way. */
  async start(options?: SpeechOptions): Promise<void> {
    if (!SpeechRecognizer.isSupported) {
      throw new Error('SpeechRecognizer isn\'t available on this host — it needs a registered "speech" service.')
    }
    if (this._session) throw new Error("SpeechRecognizer: a listening is under way — stop() or abort() it first")
    const session = new SpeechBase()
    session.on("result", result => { if (result && this._session === session) this.dispatch("result", result) })
    session.on("speechStart", () => { if (this._session === session) this.dispatch("speechStart") })
    session.on("speechEnd", () => { if (this._session === session) this.dispatch("speechEnd") })
    session.on("error", payload => { if (payload && this._session === session) this.dispatch("error", payload.code, payload.message) })
    session.on("end", () => {
      if (this._session !== session) return
      this._drop(session)
      this.dispatch("end")
    })
    this._session = session
    try {
      await session.start(options ?? {})
    } catch (e) {
      this._drop(session)
      throw e
    }
  }

  /** Stop listening and finish: the final result of what was heard, then `end`. */
  stop(): void {
    this._session?.stop().catch(() => {})
  }

  /** Stop and drop what was heard: `end`, no result. */
  abort(): void {
    this._session?.abort().catch(() => {})
  }

  /** The languages this host recognizes (BCP-47), sorted; empty when it cannot say (the web). */
  static async supportedLanguages(): Promise<string[]> {
    if (!SpeechRecognizer.isSupported) return []
    const session = new SpeechBase()
    try {
      return await session.supportedLanguages()
    } finally {
      session.close()
    }
  }

  private _drop(session: SpeechBase): void {
    if (this._session !== session) return
    session.close()
    this._session = null
  }
}
