// audio-recorder — audio recording to a file: voice messages, voice notes.
// A session is ONE recording (the app-facing `AudioRecorder` opens one per `start()`): start, pause
// / resume, then `stop()` for the file or `cancel()` to discard it. The microphone permission is the
// contract's (`@permission microphone` on start): the host asks, the halves never do.
//
// The format is the platform's encoder: AAC in an .m4a on iOS and Android, what the browser's
// MediaRecorder gives on the web (webm/opus in Chrome and Firefox, mp4 in Safari) — `mimeType`
// says which, the app's server decides whether to transcode.

import type { File, Service, f64 } from "lecodes-sdk/plugin"

export interface RecordOptions {
  /** Kilobits per second of the encoded audio. Default 64 — speech; 128 for music. */
  bitrate?: f64
  /** Samples per second. Default 44100; the browser keeps its own. */
  sampleRate?: f64
  /** Stop on its own after this many ms: `ended` fires with "maxDuration", `stop()` then returns
   *  the recording. Default: no limit. */
  maxDuration?: f64
}

export type EndReason = "maxDuration" | "interrupted" | "failed"

export interface Recording {
  /** The audio file — `recording.m4a` / `.webm` / `.mp4` by the encoder. */
  file: File
  /** "audio/mp4", "audio/webm", … — the container, without codec parameters. */
  mimeType: string
  /** Seconds of audio (the pauses left out). */
  duration: f64
}

export interface AudioRecorderParams {}

export interface AudioRecorderEvents {
  /** The input level, 0..1, about ten times a second while recording (not while paused): a meter,
   *  a waveform. */
  level: { value: f64 }
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
  /** Pause: the level stops, the duration does not grow. Rejects "notRecording" before a start
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
