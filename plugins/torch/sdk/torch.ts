// Torch — the device's flashlight: on / off, whether there is one, how bright.
//
// Hand-written over the generated wire (torch.gen.ts) for what a host WITHOUT the service answers —
// the web player, Web Lite, the headless renderer, a shell built without the plugin: `supported` is
// false, info() / available() / state() resolve "no torch, off" (an app asks them to decide what to
// show), set() / toggle() reject "unavailable" — the code the app already handles for a phone
// without a flash — before the host is touched. Nothing here throws on such a host.
//
// The torch is the DEVICE's: another app, the camera or the system may change it. `change` says
// so while the app listens; subscribing opens the session (a listener alone would not).

import { TorchBase, supports } from "./torch.gen"
import type { TorchInfo, TorchState } from "../contract"

export type { TorchInfo, TorchState }

type ChangeListener = (state: TorchState) => void

const OFF: TorchState = { on: false, level: 0 }

/**
 * The device's flashlight. `Torch.supported` reports whether this host registered the service (a
 * native shell with the plugin); `available()` whether the device has a torch.
 */
// PURE IIFE so an app that never names Torch carries none of the plugin.
export const Torch: {
  /** Whether this host registered the "torch" service: false on the web, in Web Lite, in the
   *  headless renderer and in a shell built without the plugin. */
  readonly supported: boolean
  /** What the torch can do: `{ available, dimmable }`. On a host without the service:
   *  `{ available: false, dimmable: false }`. Never rejects. */
  info(): Promise<TorchInfo>
  /** Whether the device has a torch the app can light. false on a host without the service, in the
   *  iOS simulator, on most tablets. Never rejects. */
  available(): Promise<boolean>
  /** Whether the torch is lit and how bright (`level` 0..1; 0 when off). Off on a host without the
   *  service. Never rejects. */
  state(): Promise<TorchState>
  /** Light the torch at `level` (0..1; 0 turns it off; left out: the platform's default — full on
   *  iOS, the flash's default strength on Android), or turn it off. Resolves with the state after it.
   *  Rejects "unavailable" (no torch — also on a host without the service — or iOS holds it back
   *  while the LED is too hot), "busy" (Android: the camera has it), "failed". */
  set(on: boolean, level?: number): Promise<TorchState>
  /** Turn a lit torch off, a dark one on at the level this app last lit it at. Rejects as set(). */
  toggle(): Promise<TorchState>
  /** Listen to the torch's changes — by this app, another app, the camera, the system. Returns a
   *  function that stops listening. Never called on a host without the service. */
  onChange(listener: ChangeListener): () => void
} = /*#__PURE__*/ (() => {
  let client: TorchBase | null = null
  const service = (): TorchBase => client ??= new TorchBase()

  const torch = {
    async info(): Promise<TorchInfo> {
      if (!supports()) return { available: false, dimmable: false }
      return await service().info()
    },

    async available(): Promise<boolean> {
      return (await torch.info()).available
    },

    async state(): Promise<TorchState> {
      if (!supports()) return { ...OFF }
      return await service().state()
    },

    async set(on: boolean, level?: number): Promise<TorchState> {
      if (typeof on !== "boolean") throw new Error("Torch.set: `on` is a boolean")
      if (level !== undefined && (typeof level !== "number" || Number.isNaN(level))) {
        throw new Error("Torch.set: `level` is a number from 0 to 1")
      }
      if (!supports()) throw new Error("unavailable")
      return await service().set(on, level === undefined ? undefined : Math.min(1, Math.max(0, level)))
    },

    async toggle(): Promise<TorchState> {
      if (!supports()) throw new Error("unavailable")
      return await service().toggle()
    },

    onChange(listener: ChangeListener): () => void {
      if (!supports()) return () => {}
      const s = service()
      s.on("change", listener)
      // The half hears of a listener when the session is open, and the first call opens it.
      s.state().catch(() => {})
      return () => { s.off("change", listener) }
    },
  }
  Object.defineProperty(torch, "supported", { get: (): boolean => supports() })
  return torch as any
})()
