// biometrics — the device owner's confirmation: Face ID / Touch ID on iOS (LocalAuthentication),
// the fingerprint or the face the device enrolled on Android (BiometricPrompt).
//
// A CONFIRMATION, not a key: authenticate() answers whether the person holding the device just
// proved to be its owner. It unlocks nothing — no key, no secret: an app that guards its data calls
// authenticate() and then reads its storage itself.
//
// A session opens without a prompt and status() never prompts. The dialog is the system's, one at a
// time. iOS asks once whether the app may use Face ID (the usage string of the manifest), at the
// first authenticate(); a refusal takes Face ID from the app (status: `available: false`) and the
// passcode still works where it is allowed. That question is not one of the host's permission kinds:
// there is no `@permission` here.
//
// No web half: a browser has no such confirmation (WebAuthn is a sign-in, with a server).

import type { Service } from "lecodes-sdk/plugin"

/** The biometric the device has — to label a button ("Unlock with Face ID"), nothing more. Android
 *  does not say which one its prompt will take: "unknown" there unless the device has one kind of
 *  sensor only. */
export type BiometricKind = "face" | "fingerprint" | "unknown"

export interface BiometricStatus {
  /** A biometric can confirm the owner: the device has one AND something is enrolled (and, on iOS,
   *  the person did not refuse the app Face ID). Locked out after failed attempts it is still
   *  available — authenticate() says `lockout`. The passcode is not counted here. */
  available: boolean
  /** What the device has, enrolled or not. */
  kind: BiometricKind
}

export interface BiometricOptions {
  /** Why the app asks, shown in the system's dialog ("Unlock your notes"). Not empty. */
  reason: string
  /** Let the device's passcode / PIN / pattern stand in for the biometric: the dialog offers it, and
   *  it is enough on its own where no biometric is enrolled or the biometric is locked out.
   *  Default false. */
  allowPasscode?: boolean
}

export interface BiometricsParams {}

export interface BiometricsEvents {}

export interface Biometrics extends Service<"biometrics", BiometricsParams, BiometricsEvents> {
  /** Whether a biometric can confirm the owner, and which one the device has. Never prompts. */
  status(): Promise<BiometricStatus>
  /** Show the system's dialog. Resolves with true when the owner confirmed, with false when the
   *  dialog closed without it: the person cancelled, the system dismissed it (the app went to the
   *  background). One dialog at a time.
   *  `unavailable`: nothing to confirm with (no biometric enrolled; with allowPasscode, no passcode
   *  either). `lockout`: too many failed attempts locked the biometric until the device is unlocked
   *  with its passcode (with allowPasscode the dialog offers the passcode instead). `busy`: a dialog
   *  is up. `failed`: the person was not recognized (iOS closes its dialog after a few attempts), or
   *  the dialog could not be shown (the app is in the background).
   *  @rejects unavailable lockout busy failed */
  authenticate(options: BiometricOptions): Promise<boolean>
}
