// push — remote notifications (APNs on iOS, FCM on Android).
// The host owns the OS token, the permission prompt and the registration with the le.codes relay;
// the app sees the opaque project-scoped ADDRESS and the payloads, never the raw token.
//
// An OPEN SESSION is the delivery pipe of the events. Opening one is free (no prompt, no I/O).
// Identity: every call is attributed to the world that makes it (the project's uuid, held by the
// host); a world without one rejects "unavailable" BEFORE any permission path.
//
// A notification reaches the JS world through this channel ALONE: a tap is the "tap" event (or
// `getLaunch()` for the one that started the process — the SDK's wrapper replays it into the first
// "tap" listener), a foreground arrival is "message". Its `url` is the app's to route — it does NOT
// ride the app's deep-link path (`app.launchUrl`, the "url" event).

import type { Json, Service, i32 } from "lecodes-sdk/plugin"

/** A delivered notification, as the app sees it. */
export interface PushPayload {
  /** The push channel it was sent through — the id of the `pushChannel()` export of the project's
   *  server (`<path>#<name>`). Absent = sent outside one (a push key, `lecodes pn send`). */
  channel?: string
  title: string
  body?: string
  /** A deep link, for the app to open itself (it does not ride `app.launchUrl`). */
  url?: string
  /** The developer's own JSON object, ≤ 2 KB serialized. */
  data?: { [key: string]: Json }
  badge?: i32
}

export interface PushStatus {
  /** The OS permission of the host app. "prompt" = not asked yet. */
  permission: "granted" | "denied" | "prompt"
  /** Whether this device holds a registration (an address) for this app. */
  registered: boolean
  /** The device's address for this app, when it is registered. @since 2 */
  address?: string
}

export interface PushRegisterOptions {
  /** The app's OWN user id. Client-asserted and unverified. The registration reflects the latest
   *  call: registering without it clears it. */
  user?: string
}

export interface PushRegistration {
  address: string
}

/** What the app shows itself when a notification arrives while it is in the foreground (the
 *  "message" event): the host shows the system banner for every other one. */
export interface PushHandled {
  /** The push channels with a foreground handler. */
  channels: string[]
  /** Whether notifications sent outside a channel have one. */
  untyped: boolean
}

export interface PushParams {}

export interface PushEvents {
  /** Arrived while this app was in the foreground and the app handles it (PushHandled): no banner. */
  message: PushPayload
  /** Tapped while the world was alive. */
  tap: PushPayload
}

export interface Push extends Service<"push", PushParams, PushEvents> {
  /** Permission + registration state. Never prompts. */
  getStatus(): Promise<PushStatus>
  /** Ask for the permission (the first time) and register this device. Idempotent.
   *  @rejects denied unavailable */
  register(options?: PushRegisterOptions): Promise<PushRegistration>
  /** Remove this device's registration.
   *  @rejects unavailable */
  unregister(): Promise<void>
  /** The notification that cold-started this world, or null. Stable across calls. */
  getLaunch(): Promise<PushPayload | null>
  /** Which notifications the app handles itself in the foreground; the rest get the system banner.
   *  Until it is called nothing is handled. @since 2 */
  setMessageHandled(handled: PushHandled): Promise<void>
}
