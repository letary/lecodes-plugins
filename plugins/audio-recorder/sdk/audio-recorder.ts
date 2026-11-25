// AudioRecorder — the microphone: a recording to a file (voice messages, voice notes, music) and
// what is heard meanwhile — the volume (`level`) and the note (`pitch`): a tuner, a singing game.
//
// Hand-written over the generated wire because the app's object is not the wire's session: an
// `AudioRecorder` is reusable — every `start()` opens a fresh host session (one recording), `stop()`
// / `cancel()` close it — and its events are the SDK's `addEventListener` pattern.
//
// `pitch` is a `@lazy` event of the contract: the host looks for the note only while the app
// listens. The listeners are the recorder's, the wire's are the session's — so the session hears
// `pitch` exactly while the recorder has a listener of it (`_syncPitch`).
//
// The microphone permission is asked by the host on `start()` (the contract's `@permission`); to
// ask earlier, or to act on a denial, `permissions.request("microphone")` / `openSettings()`.

import { Emitter } from "lecodes-sdk/plugin"
import { AudioRecorderBase, NAME } from "./audio-recorder.gen"
import type { EndReason, RecordOptions, Recording } from "../contract"

export type { EndReason, RecordOptions, Recording }

/** `"stopped"` = the recording ended on its own (`ended` fired): `stop()` still returns it. */
export type RecorderState = "inactive" | "recording" | "paused" | "stopped"

/** What the `pitch` event says: the note that is heard. */
export type AudioPitch = {
  /** Hz; 0 when there is no clear note (silence, noise). */
  frequency: number
  /** 0..1, how sure the detector is of the note. */
  clarity: number
}

/** A note as a musician reads it — of a frequency (`AudioRecorder.note`) or of a MIDI number
 *  (`AudioRecorder.midiNote`). */
export type AudioNote = {
  /** "C", "C#", "D", … "B". */
  name: string
  /** The octave in scientific pitch notation: A4 = 440 Hz, C4 = middle C. */
  octave: number
  /** The MIDI number of the nearest note (A4 = 69): `midi % 12` compares notes across octaves. */
  midi: number
  /** How far the frequency is from that note, −50..50 cents (negative = flat); 0 for a note made
   *  of its MIDI number. */
  cents: number
  /** The frequency of the note itself, Hz: what a tuner aims at, what a reference tone plays. */
  frequency: number
}

export type AudioRecorderEvents = {
  /** The volume, 0..1: the loudest moment since the previous event, `rate` times a second while
   *  recording (10 by default) — a meter, a waveform. */
  level: (value: number) => void
  /** The note that is heard, on the tick of `level`. The host looks for it only while this event
   *  has a listener. */
  pitch: (pitch: AudioPitch) => void
  /** The recording stopped on its own: the limit, an interruption (a call came in), a failure.
   *  `stop()` returns what was recorded. */
  ended: (reason: EndReason) => void
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

/**
 * The microphone: records it to a file, and says what it hears. `AudioRecorder.supported` reports
 * whether this host registered the service — check it before showing a record button.
 *
 * ```ts
 * const recorder = new AudioRecorder()
 * recorder.addEventListener('level', v => meter.style({ width: v * 100 }))
 * await recorder.start({ maxDuration: 60_000 })
 * const { file, duration, mimeType } = await recorder.stop()
 * ```
 *
 * A tuner — no file, the raw microphone, the note:
 *
 * ```ts
 * recorder.addEventListener('pitch', p => {
 *   const note = AudioRecorder.note(p.frequency)
 *   if (note) label.text = note.name + note.octave
 * })
 * await recorder.start({ file: false, raw: true })
 * ```
 */
export class AudioRecorder extends Emitter<AudioRecorderEvents> {
  /** Whether this host registered an "audioRecorder" service. */
  static get supported(): boolean { return AudioRecorderBase.supports(NAME) }

  /** A frequency as a note: its name, octave, MIDI number and how many cents off it is. null for
   *  no frequency (a `pitch` event without a note). `a4` = the tuning's A, 440 Hz by default. */
  static note(frequency: number, a4 = 440): AudioNote | null {
    if (!(frequency > 0) || !(a4 > 0)) return null
    const exact = 69 + 12 * Math.log2(frequency / a4)
    const midi = Math.round(exact)
    return { ...AudioRecorder.midiNote(midi, a4), cents: Math.round((exact - midi) * 100) }
  }

  /** The note of a MIDI number (A4 = 69, middle C = 60; rounded to a whole one): its name, octave
   *  and frequency — a target to show or to play. `a4` = the tuning's A, 440 Hz by default. */
  static midiNote(midi: number, a4 = 440): AudioNote {
    const n = Math.round(midi)
    return { name: NOTE_NAMES[((n % 12) + 12) % 12]!, octave: Math.floor(n / 12) - 1, midi: n, cents: 0, frequency: a4 * 2 ** ((n - 69) / 12) }
  }

  private _session: AudioRecorderBase | null = null
  private _state: RecorderState = "inactive"
  /** Whether the session hears `pitch` — it does exactly while the recorder has a listener of it. */
  private _pitchHeard = false
  private readonly _onPitch = (payload: AudioPitch): void => { if (payload) this.dispatch("pitch", payload) }

  get state(): RecorderState { return this._state }

  override addEventListener<K extends keyof AudioRecorderEvents>(channel: K, callback: AudioRecorderEvents[K]): void {
    super.addEventListener(channel, callback)
    if (channel === "pitch") this._syncPitch()
  }

  override removeEventListener<K extends keyof AudioRecorderEvents>(channel: K, callback: AudioRecorderEvents[K]): void {
    super.removeEventListener(channel, callback)
    if (channel === "pitch") this._syncPitch()
  }

  /** Start a recording. The host asks for the microphone first; rejects `"denied"` when refused,
   *  `"failed"` when the recorder could not start, and before touching the host when it is not
   *  supported or a recording is under way. */
  async start(options?: RecordOptions): Promise<void> {
    if (!AudioRecorder.supported) {
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
    this._pitchHeard = false
    this._syncPitch()
    try {
      await session.start(options ?? {})
    } catch (e) {
      this._drop(session)
      throw e
    }
    if (this._session === session && this._state === "inactive") this._state = "recording"
  }

  /** Pause: the events stop, the duration does not grow. */
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

  /** Stop and get the recording — also after `ended`. Its `file` is null when the recording was
   *  started with `file: false`. Rejects `"failed"` when nothing could be encoded. The recorder
   *  is ready for another `start()` afterwards. */
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

  /** The session listens to `pitch` while the recorder has a listener of it, and only then: a
   *  listener of the session is what tells the host to look for the note. */
  private _syncPitch(): void {
    const session = this._session
    const want = session !== null && this.hasListeners("pitch")
    if (!session || want === this._pitchHeard) return
    this._pitchHeard = want
    if (want) session.on("pitch", this._onPitch)
    else session.off("pitch", this._onPitch)
  }

  private _drop(session: AudioRecorderBase): void {
    if (this._session !== session) return
    session.close()
    this._session = null
    this._pitchHeard = false
    this._state = "inactive"
  }
}
