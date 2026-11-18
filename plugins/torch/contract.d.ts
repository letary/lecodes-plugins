// torch — the device's flashlight: the LED beside the back camera, lit as a lamp. iOS:
// AVCaptureDevice's torch (setTorchModeOn(level:)). Android: CameraManager.setTorchMode and, from
// Android 13 on a device whose flash has strength levels, turnOnTorchWithStrengthLevel.
//
// No permission: lighting the torch needs no camera access on either platform (the camera's
// permission is for its pictures) — there is no `@permission` here, no usage string. The torch is
// the DEVICE's, not the session's: closing the session leaves it as it is, and another app, the
// camera or the system (the LED is too hot) may take it — what `change` reports.
//
// A level is a fraction of full brightness, (0, 1]. iOS dims continuously; Android 13+ in the
// strength steps its flash has (the level the torch reports is the step it took); every other
// device lights at its one brightness and reports 1.
//
// No web half: a browser has no torch it lets a page light (a camera stream's `torch` constraint is
// the camera's, behind its permission, on a few Android browsers only).

import type { Service, f64 } from "lecodes-sdk/plugin"

/** What the device's torch can do. */
export interface TorchInfo {
  /** The device has a torch the app can light (the iOS simulator, most iPads and tablets: no). */
  available: boolean
  /** Its brightness can be set: iOS; Android 13+ where the flash has several strength levels. */
  dimmable: boolean
}

/** The torch as it is now. */
export interface TorchState {
  /** It is lit. */
  on: boolean
  /** Its brightness, (0, 1] while lit (1 on a torch that does not dim); 0 when off. */
  level: f64
}

export interface TorchParams {}

export interface TorchEvents {
  /** The torch changed: by this app, by another app or the camera, by the system (the LED is too
   *  hot: iOS lowers its level, then turns it off). Sent while the app listens.
   *  @lazy */
  change: TorchState
}

export interface Torch extends Service<"torch", TorchParams, TorchEvents> {
  /** What the device's torch can do. Never prompts, never rejects. */
  info(): Promise<TorchInfo>
  /** Whether the torch is lit, and how bright. Off on a device without one. Never rejects. */
  state(): Promise<TorchState>
  /** Light the torch (`on`) at `level` — (0, 1], clamped; 0 or less turns it off; left out, the
   *  platform's default brightness (iOS: full, Android: the flash's default strength) — or turn it
   *  off. Resolves with the state the torch is in after it.
   *  `unavailable`: no torch, or the system holds it back (iOS: the LED is too hot). `busy`: the
   *  camera holds it (Android: another app, or a camera of this one, has it open). `failed`:
   *  anything else.
   *  @rejects unavailable busy failed */
  set(on: boolean, level?: f64): Promise<TorchState>
  /** Turn a lit torch off, a dark one on at the level this session last lit it at (else the
   *  default). Resolves with the state after it.
   *  @rejects unavailable busy failed */
  toggle(): Promise<TorchState>
}
