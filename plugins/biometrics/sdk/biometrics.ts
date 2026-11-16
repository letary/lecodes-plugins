// Biometrics — the device owner's confirmation: `status()` and `authenticate()`.
//
// Hand-written over the generated wire for what a host without the service answers: `status()`
// resolves "nothing available" there (an app asks it to decide whether to offer the button, and a
// host that cannot confirm has nothing to offer), `authenticate()` rejects "unavailable" — the code
// the app already handles for a device with nothing enrolled — before the host is touched. And an
// empty reason is the app's mistake, said here: iOS refuses the dialog without one.
//
// A confirmation is a yes or no, nothing is unlocked by it: the app that guards data calls
// authenticate() and reads its storage itself.

import { BiometricsBase, supports } from "./biometrics.gen"
import type { BiometricKind, BiometricOptions, BiometricStatus } from "../contract"

export type { BiometricKind, BiometricOptions, BiometricStatus }

/**
 * The device owner's confirmation — Face ID / Touch ID, an Android fingerprint or face, optionally
 * the passcode in their place. `Biometrics.supported` reports whether this host registered the
 * service; `status().available` whether a biometric can confirm now.
 */
// PURE IIFE so an app that never asks for a confirmation tree-shakes the whole plugin away.
export const Biometrics: {
  /** Whether this host registered a "biometrics" service. */
  readonly supported: boolean
  /** Whether a biometric can confirm the owner (a sensor AND something enrolled), and which one the
   *  device has — to label a button. Never prompts. On a host without the service:
   *  `{ available: false, kind: "unknown" }`. */
  status(): Promise<BiometricStatus>
  /** Show the system's dialog with `reason`. true = the owner confirmed; false = the dialog closed
   *  without it (cancelled, dismissed). Rejects "unavailable" (nothing to confirm with — also on a
   *  host without the service), "lockout" (too many failed attempts), "busy" (a dialog is up),
   *  "failed" (not recognized, or the dialog could not be shown). `allowPasscode` lets the device's
   *  passcode / PIN stand in for the biometric. */
  authenticate(options: BiometricOptions): Promise<boolean>
} = /*#__PURE__*/ (() => {
  let client: BiometricsBase | null = null
  const service = (): BiometricsBase => client ??= new BiometricsBase()

  const biometrics = {
    async status(): Promise<BiometricStatus> {
      if (!supports()) return { available: false, kind: "unknown" }
      return await service().status()
    },

    async authenticate(options: BiometricOptions): Promise<boolean> {
      if (typeof options?.reason !== "string" || options.reason.trim() === "") {
        throw new Error("Biometrics.authenticate: a reason is required — the text the system's dialog shows")
      }
      if (!supports()) throw new Error("unavailable")
      return await service().authenticate({ reason: options.reason, allowPasscode: options.allowPasscode === true })
    },
  }
  Object.defineProperty(biometrics, "supported", {
    get: (): boolean => supports(),
  })
  return biometrics as any
})()
