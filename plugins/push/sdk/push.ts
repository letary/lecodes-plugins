// Push — remote notifications. The host owns the OS token, the permission prompt and the
// registration with the le.codes relay; the app only ever sees the opaque project-scoped ADDRESS
// (never the raw APNs / FCM token) plus payloads.
//
// Two readers of this module:
//   - the app, through `Push`: the permission (`register`), the state (`getStatus`), and the
//     notifications sent OUTSIDE a push channel — a push key, `lecodes pn send` — as events;
//   - the SDK's transport and its push-channel proxies, through the runtime `__pushEnable()`
//     installs (lecodes-sdk/plugin `_pushRuntime`): the device's address for the `x-lecodes-push`
//     header, the registration the server asks for, the handlers of each `pushChannel()` export.
//     The compiler puts `__pushEnable()` at the top of every server stub of a project with push
//     channels, so an app that has none never carries this module.
//
// The app is not running when a push arrives — display is host / OS work. The JS world sees
// exactly two delivery paths:
//   - "tap":     tapped, whether the app was running or the tap started it (the cold start is
//                read with the service's getLaunch once and replayed into the first matching
//                tap handler, AFTER the top-level code — the handler may route);
//   - "message": arrived while this app was in the foreground AND the app handles it (a message
//                handler of its channel, or an untyped one): the host shows no banner for those,
//                and the system banner for every other.
// A payload's `url` is the app's to route; it does not ride the deep-link path.
//
// A notification is heard ONCE: one sent through a push channel by its channel's handlers, one
// sent outside a channel by the untyped listeners (`Push.addEventListener`).
//
// The OS permission prompt happens inside `register()`; `getStatus()` never prompts. On a host
// without the service every method rejects at once, BEFORE any permission path.

import { NAME, PushBase, supports } from "./push.gen"
import { _pushRuntime } from "lecodes-sdk/plugin"
import type { PushEvents, PushPayload, PushRegisterOptions, PushRegistration, PushStatus } from "../contract"

export type { PushPayload, PushRegisterOptions, PushStatus }

export type PushEvent = keyof PushEvents
type Handler = (payload: PushPayload) => void
/** Handlers by push channel id; "" = the untyped ones. */
type Handlers = Map<string, Set<Handler>>

// PURE IIFE so an app that never uses push tree-shakes the whole plugin away.
const built = /*#__PURE__*/ (() => {
  let client: PushBase | null = null
  const service = (): PushBase => client ??= new PushBase()
  const supported = (): boolean => supports()

  const assertSupported = (): void => {
    // Fail before the host is touched — a permission dialog for a feature that can't exist
    // would be worse than the error.
    if (!supported()) {
      throw new Error('Push isn\'t available on this host — it needs a registered "push" service.')
    }
  }

  // ── the address: what the transport tells the server ──
  let address: string | null = null
  const learn = (a: string | null | undefined): void => { if (a) address = a }

  // ── the handlers ──
  const taps: Handlers = new Map()
  const messages: Handlers = new Map()
  const add = (map: Handlers, key: string, fn: Handler): void => {
    let set = map.get(key)
    if (!set) map.set(key, set = new Set())
    set.add(fn)
  }
  const remove = (map: Handlers, key: string, fn: Handler): void => { map.get(key)?.delete(fn) }
  /** A payload's handlers: its channel's, or the untyped ones when it was sent outside a channel. */
  const handlersOf = (map: Handlers, p: PushPayload): Set<Handler> | undefined => map.get(p.channel ?? "")
  const dispatch = (map: Handlers, p: PushPayload): void => {
    const set = handlersOf(map, p)
    if (set) for (const fn of [...set]) fn(p)
  }

  // Events arrive on a live session only; a handler opens the pipe. The prompt-free getStatus is the
  // opening call, and it tells the address of an earlier registration.
  let piped = false
  const ensurePipe = (): void => {
    if (piped || !supported()) return
    piped = true
    const s = service()
    s.on("tap", (p: PushPayload) => dispatch(taps, p))
    s.on("message", (p: PushPayload) => dispatch(messages, p))
    s.getStatus().then(st => learn(st.address), () => {})
  }

  // The notification that started the process: replayed into the first tap handler that matches it,
  // asynchronously — after the top-level code that attached the handler, so it may route.
  let launch: Promise<PushPayload | null> | null = null
  let launchDelivered = false
  const replayLaunch = (): void => {
    if (launchDelivered || !supported()) return
    launch ??= service().getLaunch().catch(() => null)
    launch.then(p => {
      if (!p || launchDelivered) return
      const set = handlersOf(taps, p)
      if (!set?.size) return                       // its handler may be attached later: tried again then
      launchDelivered = true
      for (const fn of [...set]) fn(p)
    })
  }

  // What the host shows no banner for in the foreground: the channels with a message handler.
  const announceHandled = (): void => {
    if (!supports("setMessageHandled")) return
    const channels = [...messages].filter(([key, set]) => key && set.size).map(([key]) => key)
    service().setMessageHandled({ channels, untyped: (messages.get("")?.size ?? 0) > 0 }).catch(() => {})
  }

  /** One handler of one kind for one channel ("" = untyped); returns its remover. Recording on an
   *  unsupported host is a silent no-op (the events never fire), like app / device listeners. */
  const listen = (kind: PushEvent, channel: string, fn: Handler): () => void => {
    const map = kind === "tap" ? taps : messages
    add(map, channel, fn)
    ensurePipe()
    if (kind === "tap") replayLaunch()
    else announceHandled()
    return () => {
      remove(map, channel, fn)
      if (kind === "message") announceHandled()
    }
  }

  // The server asked this device to register (the envelope's `push: true`): once per run. The prompt
  // appears only when the permission was never asked; a refusal is final (the OS asks no twice).
  let asked = false
  const requestRegister = (): void => {
    if (asked || !supported()) return
    asked = true
    service().getStatus()
      .then(st => {
        learn(st.address)
        if (st.permission === "denied") return
        return service().register({}).then(r => learn(r.address))
      })
      .catch(() => {})
  }

  const push = {
    async getStatus(): Promise<PushStatus> {
      assertSupported()
      const st = await service().getStatus()
      learn(st.address)
      return st
    },

    async register(options?: PushRegisterOptions): Promise<PushRegistration> {
      assertSupported()
      const r = await service().register(options ?? {})
      learn(r.address)
      return r
    },

    async unregister(): Promise<void> {
      assertSupported()
      await service().unregister()
      address = null
    },

    addEventListener(event: PushEvent, callback: Handler): void {
      listen(event, "", callback)
    },
    removeEventListener(event: PushEvent, callback: Handler): void {
      remove(event === "tap" ? taps : messages, "", callback)
      if (event === "message") announceHandled()
    },
  }
  Object.defineProperty(push, "isSupported", {
    get: (): boolean => supported(),
  })

  const runtime = {
    address: (): string | null => address,
    requestRegister,
    on: listen,
  }
  return { push, runtime }
})()

/**
 * Remote push notifications. `Push.isSupported` reports whether this host registered the
 * service — check it before offering notification features.
 *
 * A project with a backend needs none of this: its `pushChannel()` exports are heard with their
 * own `onTap` / `onMessage`, and the device is registered when the server asks (after a sign-in).
 * `Push` is for the rest — a permission asked at a moment of the app's choosing, and the
 * notifications sent outside a channel (a push key, `lecodes pn send`).
 */
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
  /** The notifications sent outside a push channel: "tap" = tapped (the one that started the app
   *  too); "message" = arrived while the app is open (the app shows it, the host no banner). */
  addEventListener(event: PushEvent, callback: (payload: PushPayload) => void): void
  removeEventListener(event: PushEvent, callback: (payload: PushPayload) => void): void
} = built.push as any

/** Installs the push runtime for the SDK's transport and its push-channel proxies (lecodes-sdk/plugin
 *  `_pushRuntime`). A line of every server stub of a project with push channels — never app code. */
export const __pushEnable = (): void => { _pushRuntime.current = built.runtime }
