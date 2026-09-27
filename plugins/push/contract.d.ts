// push — remote notifications (APNs on iOS, FCM on Android).
// The host owns the OS token, the permission prompt and the registration with the le.codes relay;
// the app sees the opaque project-scoped ADDRESS and the payloads, never the raw token.
//
// An OPEN SESSION is the delivery pipe of the events. Opening one is free (no prompt, no I/O).
// Identity: every call is attributed to the world that makes it (the project's uuid, held by the
// host); a world without one rejects "unavailable" BEFORE any permission path.

import type { Json, Service, i32 } from "lecodes-sdk/plugin"

/** A delivered notification, as the app sees it. */
export interface PushPayload {
  title: string
  body?: string
  /** A deep link — it also rides the app's own link path (`app.launchUrl`, the "url" event). */
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
}

export interface PushRegisterOptions {
  /** The app's OWN user id. Client-asserted and unverified. The registration reflects the latest
   *  call: registering without it clears it. */
  user?: string
}

export interface PushRegistration {
  address: string
}

export interface PushParams {}

export interface PushEvents {
  /** Arrived while this app was in the foreground (the host shows no banner). */
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
}
