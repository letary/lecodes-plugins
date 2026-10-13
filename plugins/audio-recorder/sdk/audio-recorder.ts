// AudioRecorder — audio recording to a file: voice messages, voice notes.
//
// Hand-written over the generated wire because the app's object is not the wire's session: an
// `AudioRecorder` is reusable — every `start()` opens a fresh host session (one recording), `stop()`
// / `cancel()` close it — and its events are the SDK's `addEventListener` pattern.
//
// The microphone permission is asked by the host on `start()` (the contract's `@permission`); to
// ask earlier, or to act on a denial, `permissions.request("microphone")` / `openSettings()`.

import { Emitter } from "lecodes-sdk/plugin"
import { AudioRecorderBase, NAME } from "./audio-recorder.gen"
import type { EndReason, RecordOptions, Recording } from "../contract"

export type { EndReason, RecordOptions, Recording }

/** `"stopped"` = the recording ended on its own (`ended` fired): `stop()` still returns it. */
export type RecorderState = "inactive" | "recording" | "paused" | "stopped"

export type AudioRecorderEvents = {
  /** The input level, 0..1, about ten times a second while recording — a meter, a waveform. */
  level: (value: number) => void
  /** The recording stopped on its own: the limit, an interruption (a call came in), a failure.
   *  `stop()` returns what was recorded. */
  ended: (reason: EndReason) => void
}

/**
 * Records the microphone to a file. `AudioRecorder.isSupported` reports whether this host
 * registered the service — check it before showing a record button.
 *
 * ```ts
 * const recorder = new AudioRecorder()
 * recorder.addEventListener('level', v => meter.style({ width: v * 100 }))
 * await recorder.start({ maxDuration: 60_000 })
 * const { file, duration, mimeType } = await recorder.stop()
 * ```
 */
export class AudioRecorder extends Emitter<AudioRecorderEvents> {
  /** Whether this host registered an "audioRecorder" service. */
  static get isSupported(): boolean { return AudioRecorderBase.supports(NAME) }

  private _session: AudioRecorderBase | null = null
  private _state: RecorderState = "inactive"

  get state(): RecorderState { return this._state }

  /** Start a recording. The host asks for the microphone first; rejects `"denied"` when refused,
   *  `"failed"` when the recorder could not start, and before touching the host when it is not
   *  supported or a recording is under way. */
  async start(options?: RecordOptions): Promise<void> {
    if (!AudioRecorder.isSupported) {
      throw new Error('AudioRecorder isn\'t available on this host — it needs a registered "audioRecorder" service.')
    }
    if (this._session) throw new Error("AudioRecorder: a recording is under way — stop() or cancel() it first")
    const session = new AudioRecorderBase()
    session.on("level", payload => { if (payload) this.dispatch("level", payload.value) })
    session.on("ended", payload => {
      if (!payload || this._session !== session) return
      this._state = "stopped"
      this.dispatch("ended", payload.reason)
    })
    this._session = session
    try {
      await session.start(options ?? {})
    } catch (e) {
      this._drop(session)
      throw e
    }
    if (this._session === session && this._state === "inactive") this._state = "recording"
  }

  /** Pause: the level stops, the duration does not grow. */
  async pause(): Promise<void> {
    if (!this._session || this._state !== "recording") throw new Error("AudioRecorder: not recording")
    await this._session.pause()
    if (this._state === "recording") this._state = "paused"
  }

  async resume(): Promise<void> {
    if (!this._session || this._state !== "paused") throw new Error("AudioRecorder: not paused")
    await this._session.resume()
    if (this._state === "paused") this._state = "recording"
  }

  /** Stop and get the recording — also after `ended`. Rejects `"failed"` when nothing could be
   *  encoded. The recorder is ready for another `start()` afterwards. */
  async stop(): Promise<Recording> {
    const session = this._session
    if (!session) throw new Error("AudioRecorder: nothing to stop")
    try {
      return await session.stop()
    } finally {
      this._drop(session)
    }
  }

  /** Stop and discard. Nothing under way is not an error. */
  cancel(): void {
    const session = this._session
    if (!session) return
    session.cancel().catch(() => {})
    this._drop(session)
  }

  private _drop(session: AudioRecorderBase): void {
    if (this._session !== session) return
    session.close()
    this._session = null
    this._state = "inactive"
  }
}
