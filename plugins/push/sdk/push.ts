// Push — remote notifications. The host owns the OS token, the permission prompt and the
// registration with the le.codes relay; the app only ever sees the opaque project-scoped ADDRESS
// (never the raw APNs / FCM token) plus payloads.
//
// Hand-written over the generated wire because the public API is a module singleton with
// `addEventListener`, and a listener must OPEN the session: events arrive on a live one only.
//
// The app is not running when a push arrives — display is host / OS work. The JS world sees
// exactly three delivery paths:
//   - event "message": arrived while this app was foregrounded (the host suppresses the banner)
//   - event "tap":     tapped while the world was alive (warm)
//   - getLaunch():     the notification that cold-started this world (stable pull, or null)
// A payload's `url` additionally rides the app-lifecycle deep-link path (`app.launchUrl` /
// the "url" event), so apps that already route links get notification routing for free.
//
// The OS permission prompt happens inside `register()`; `getStatus()` and `getLaunch()` never
// prompt. On a host without the service every method rejects at once, BEFORE any permission path.

import { NAME, PushBase } from "./push.gen"
import type { PushEvents, PushPayload, PushRegisterOptions, PushRegistration, PushStatus } from "../contract"

export type { PushPayload, PushRegisterOptions, PushStatus }

export type PushEvent = keyof PushEvents

/**
 * Remote push notifications. `Push.isSupported` reports whether this host registered the
 * service — check it before offering notification features.
 */
// PURE IIFE so an app that never uses push tree-shakes the whole plugin away.
export const Push: {
  /** Whether this host registered a "push" service. */
  readonly isSupported: boolean
  /** Permission + registration state. Never prompts. */
  getStatus(): Promise<PushStatus>
  /** Ask for permission (first time) and register this device → the opaque address your server
   *  targets. Idempotent — safe to call every launch; rejects "denied" / "unavailable". */
  register(options?: PushRegisterOptions): Promise<PushRegistration>
  /** Remove this device's registration (the address stops receiving). */
  unregister(): Promise<void>
  /** The notification that cold-started this app run, or null. Stable across calls. */
  getLaunch(): Promise<PushPayload | null>
  /** "message" = received while the app is open; "tap" = the user tapped one while it ran. */
  addEventListener(event: PushEvent, callback: (payload: PushPayload) => void): void
  removeEventListener(event: PushEvent, callback: (payload: PushPayload) => void): void
} = /*#__PURE__*/ (() => {
  let client: PushBase | null = null
  const service = (): PushBase => client ??= new PushBase()

  const assertSupported = (): void => {
    // Fail before the host is touched — a permission dialog for a feature that can't exist
    // would be worse than the error.
    if (!PushBase.supports(NAME)) {
      throw new Error('Push isn\'t available on this host — it needs a registered "push" service.')
    }
  }

  // `on` only records listeners; events need a live session to arrive on. Poke the host with the
  // prompt-free getStatus once so a listener-only app (already registered on a previous run)
  // still hears warm taps.
  let pipeOpened = false
  const ensurePipe = (): void => {
    if (pipeOpened || !PushBase.supports(NAME)) return
    pipeOpened = true
    service().getStatus().catch(() => { pipeOpened = false })
  }

  const push = {
    async getStatus(): Promise<PushStatus> {
      assertSupported()
      return await service().getStatus()
    },

    async register(options?: PushRegisterOptions): Promise<PushRegistration> {
      assertSupported()
      return await service().register(options ?? {})
    },

    async unregister(): Promise<void> {
      assertSupported()
      await service().unregister()
    },

    async getLaunch(): Promise<PushPayload | null> {
      assertSupported()
      return (await service().getLaunch()) ?? null
    },

    addEventListener(event: PushEvent, callback: (payload: PushPayload) => void): void {
      // Recording on an unsupported host is a silent no-op (the events just never fire),
      // like app / device listeners — only the promise-returning methods reject loudly.
      service().on(event, callback)
      ensurePipe()
    },
    removeEventListener(event: PushEvent, callback: (payload: PushPayload) => void): void {
      service().off(event, callback)
    },
  }
  Object.defineProperty(push, "isSupported", {
    get: (): boolean => PushBase.supports(NAME),
  })
  return push as any
})()
