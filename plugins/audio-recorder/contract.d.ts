// audio-recorder — the microphone: a recording to a file (voice messages, voice notes, music) and
// what is heard meanwhile — the volume (`level`) and the note (`pitch`): a tuner, a singing game.
// A session is ONE recording (the app-facing `AudioRecorder` opens one per `start()`): start, pause
// / resume, then `stop()` for the file or `cancel()` to discard it. With `file: false` nothing is
// written: only the events. The microphone permission is the contract's (`@permission microphone`
// on start): the host asks, the halves never do.
//
// The format is the platform's encoder: AAC in an .m4a on iOS and Android, what the browser's
// MediaRecorder gives on the web (webm/opus in Chrome and Firefox, mp4 in Safari) — `mimeType`
// says which, the app's server decides whether to transcode.
//
// `level` and `pitch` come off the same samples on the same tick (`rate` a second). The note is
// found in the half (one detector, ported: YIN over ~46 ms, 60–1500 Hz) — samples never cross.

import type { File, Service, f64 } from "lecodes-sdk/plugin"

export interface RecordOptions {
  /** Kilobits per second of the encoded audio. Default 64 — speech; 128 for music. */
  bitrate?: f64
  /** Samples per second. Default 44100; the browser and iOS keep the device's own. */
  sampleRate?: f64
  /** Stop on its own after this many ms: `ended` fires with "maxDuration", `stop()` then returns
   *  the recording. Default: no limit. */
  maxDuration?: f64
  /** Write the audio file. Default true; false = only the events (`stop()` returns no file). */
  file?: boolean
  /** The microphone with as little of the system's voice processing (noise suppression, gain
   *  control, echo cancellation) as the device allows: music, a tuner, singing. Default false. */
  raw?: boolean
  /** How many times a second `level` and `pitch` fire. Default 10, at most 50. */
  rate?: f64
}

export type EndReason = "maxDuration" | "interrupted" | "failed"

export interface Recording {
  /** The audio file — `recording.m4a` / `.webm` / `.mp4` by the encoder; null when the recording
   *  was started with `file: false`. */
  file: File | null
  /** "audio/mp4", "audio/webm", … — the container, without codec parameters; "" without a file. */
  mimeType: string
  /** Seconds of audio (the pauses left out). */
  duration: f64
}

export interface AudioRecorderParams {}

export interface AudioRecorderEvents {
  /** The volume, 0..1: the loudest sample since the previous event, `rate` times a second while
   *  recording (not while paused): a meter, a waveform. */
  level: { value: f64 }
  /** The note that is heard, on the tick of `level`: `frequency` in Hz, 0 when there is no clear
   *  note (silence, noise); `clarity` 0..1, how periodic the sound is. One note at a time, 60–1500 Hz.
   *  @lazy */
  pitch: { frequency: f64, clarity: f64 }
  /** The recording stopped on its own: the limit (`maxDuration`), an interruption (a call came in),
   *  a failure of the encoder. What was recorded is kept until `stop()` (which returns it) or
   *  `cancel()`. */
  ended: { reason: EndReason }
}

export interface AudioRecorder extends Service<"audioRecorder", AudioRecorderParams, AudioRecorderEvents> {
  /** Start recording. One recording per session: a second start rejects "busy".
   *  @permission microphone
   *  @rejects busy failed */
  start(options?: RecordOptions): Promise<void>
  /** Pause: the events stop, the duration does not grow. Rejects "notRecording" before a start
   *  or after the recording ended.
   *  @rejects notRecording failed */
  pause(): Promise<void>
  /** @rejects notRecording failed */
  resume(): Promise<void>
  /** Stop and get the recording (also after `ended`: the file was kept). Rejects "failed" when
   *  nothing could be encoded.
   *  @rejects notRecording failed */
  stop(): Promise<Recording>
  /** Stop and discard. Nothing to discard is not an error. */
  cancel(): Promise<void>
}
