// background-audio — ONE record that plays on while the app is in the background and the screen is
// locked: an audio guide, a podcast, a lesson. The system shows it — the lock screen, the
// notification — with its title and a play / pause button; a headset's button, a call coming in and
// headphones pulled out are the half's to answer.
//
// The app's code does not run in the background, so the half plays by itself: a button of the lock
// screen is answered without the app, and a record that ends lets the system's player go. What the
// app missed meanwhile it reads with `status()` when it is back (the wrapper does, on "resume").
//
// Three events, each its own: what the player does (`state`), how long the record is (`duration`,
// once it is known), where it is (`position`). The position is the one that ticks, so it is a
// `@lazy` event: the half sends it only while the app has a listener of it — with nobody listening
// it never calls into the app.

import type { Service, f64 } from "lecodes-sdk/plugin"

export interface Track {
  /** A url of the record (http / https). */
  src: string
  /** What the lock screen and the notification call it. */
  title: string
  /** The line under the title: the app's name, an author. */
  artist?: string
  /** Seconds: where to go on from. Default 0. */
  position?: f64
}

/**
 * "idle": no record. "loading": the record is asked for, nothing is heard yet. "ended": it was heard
 * to its end (the system's player is gone; `resume()` plays it again from the start). "failed": it
 * could not be loaded or played.
 */
export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "ended" | "failed"

export interface Status {
  state: PlaybackState
  /** Seconds; 0 while the record's length is not known. */
  duration: f64
  /** Seconds from the start. */
  position: f64
}

export interface BackgroundAudioParams {}

export interface BackgroundAudioEvents {
  /** The player does another thing: by a call of the app, a button of the lock screen or a headset,
   *  an interruption (a call), the record's end. */
  state: { value: PlaybackState }
  /** The record's length is known, seconds: once per record, after `play`. */
  duration: { value: f64 }
  /** Where the record is, seconds: at once when the first listener comes, about twice a second
   *  while it plays, and once after anything that moves it (a seek, a pause, the end). Never while
   *  the app is in the background.
   *  @lazy */
  position: { value: f64 }
}

export interface BackgroundAudio extends Service<"backgroundAudio",BackgroundAudioParams, BackgroundAudioEvents> {
  /** Play a record; the one that played is let go. Resolves once the half took it — what becomes
   *  of it is the `state` event ("loading", then "playing" or "failed"). */
  play(track: Track): Promise<void>
  /** Not playing is not an error. */
  pause(): Promise<void>
  /** Go on after a pause; after "ended", from the start. Nothing without a record. */
  resume(): Promise<void>
  /** Seconds from the start, clamped to the record. Before the length is known: where it starts. */
  seek(position: f64): Promise<void>
  /** Let the record go: nothing plays, the system's player is gone, the state is "idle". */
  stop(): Promise<void>
  /** Everything at once, as it is now: for an app that comes back from the background. */
  status(): Promise<Status>
}
