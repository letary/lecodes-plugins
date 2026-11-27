// Calendar — the device's calendars: reading calendars and events behind the `calendar`
// permission, adding and editing an event through the system's own screens.
//
// Hand-written over the generated wire (calendar.gen.ts) for what a host WITHOUT the service
// answers — the web, the desktop, the headless renderer, a shell built without the plugin:
// `supported` is false, access() resolves "denied" (an app asks it to decide what to offer), every
// other call rejects "unavailable" before the host is touched. For a range that is not one, said
// here and not by a half. And for `onChange`, the listener API over the wire's `changed` event.
//
// The permission is asked by the HOST, at the first calendars() / list() / get() / show(): a refusal
// is the rejection "denied". add() asks none (iOS 15 / 16 excepted: the system's editor needs it there).
//
// Times are milliseconds since the epoch (`Date.now()`, `date.getTime()`).

import { CalendarBase, supports } from "./calendar.gen"
import type { CalendarAccess, CalendarEvent, CalendarEventDraft, CalendarInfo, CalendarListOptions } from "../contract"

export type { CalendarAccess, CalendarEvent, CalendarEventDraft, CalendarInfo, CalendarListOptions }

/** list() takes at most this long a range: iOS searches four years in one go and silently shortens
 *  more — four years of 365 days, so a range with a leap day in it is still inside. */
const MAX_RANGE = 4 * 365 * 24 * 60 * 60 * 1000

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/**
 * The device's calendars. `Calendar.supported` reports whether this host registered the service —
 * a native shell with the plugin.
 */
// PURE IIFE so an app that never names Calendar carries none of the plugin.
export const Calendar: {
  /** Whether this host registered the "calendar" service: false on the web, on the desktop, in the
   *  headless renderer and in a shell built without the plugin. */
  readonly supported: boolean
  /** Whether the app may read the calendars: "granted", "denied", or "prompt" (never asked — the
   *  first read asks). Never prompts. "denied" on a host without the service. */
  access(): Promise<CalendarAccess>
  /** The device's calendars. Asks the calendar permission the first time. Rejects "denied",
   *  "unavailable" (a host without the service), "failed". */
  calendars(): Promise<CalendarInfo[]>
  /** The events that overlap [from, to) — ms since the epoch, at most four years apart — sorted by
   *  start; a recurring event once per occurrence. `calendars` keeps those calendars' events.
   *  Rejects as calendars(). */
  list(options: CalendarListOptions): Promise<CalendarEvent[]>
  /** One event by its id (a recurring one: its first occurrence), null when there is none.
   *  Rejects as calendars(). */
  get(id: string): Promise<CalendarEvent | null>
  /** The system's "new event" editor, filled from `draft`. true when the person saved the event
   *  (Android: false when its calendar app does not say). No permission, except on iOS 15 / 16.
   *  Rejects "unavailable", "busy" (a screen of Calendar is up), "denied" (iOS 15 / 16), "failed". */
  add(draft: CalendarEventDraft): Promise<boolean>
  /** The system's card of an event — where the person edits or deletes it; `start` names the
   *  occurrence of a recurring one. Resolves when it closes. Rejects "notFound", and as calendars(). */
  show(id: string, start?: number): Promise<void>
  /** Listen to changes of the calendars (by anyone, a sync included). No payload: list() again.
   *  Returns a function that stops listening. Heard only while the app may read the calendars;
   *  never called on a host without the service. */
  onChange(listener: () => void): () => void
} = /*#__PURE__*/ (() => {
  let client: CalendarBase | null = null
  const service = (): CalendarBase => client ??= new CalendarBase()

  /** The host's own rejection for a call it cannot serve — same shape as a half's. */
  const assertSupported = (): void => {
    if (!supports()) throw new Error("unavailable")
  }

  const calendar = {
    async access(): Promise<CalendarAccess> {
      if (!supports()) return "denied"
      return await service().access()
    },

    async calendars(): Promise<CalendarInfo[]> {
      assertSupported()
      return await service().calendars()
    },

    async list(options: CalendarListOptions): Promise<CalendarEvent[]> {
      if (!isTime(options?.from) || !isTime(options?.to)) throw new Error("Calendar.list: `from` and `to` are times in ms since the epoch")
      if (options.to <= options.from) throw new Error("Calendar.list: `to` is after `from`")
      if (options.to - options.from > MAX_RANGE) throw new Error("Calendar.list: a range is at most four years")
      assertSupported()
      const calendars = options.calendars
      return await service().list({ from: options.from, to: options.to, ...(calendars && calendars.length > 0 ? { calendars } : {}) })
    },

    async get(id: string): Promise<CalendarEvent | null> {
      if (typeof id !== "string") throw new Error("Calendar.get: `id` is an event's id")
      assertSupported()
      if (id === "") return null
      return await service().get(id)
    },

    async add(draft: CalendarEventDraft): Promise<boolean> {
      if (typeof draft !== "object" || draft === null) throw new Error("Calendar.add: a draft is required — {} opens an empty editor")
      if (isTime(draft.start) && isTime(draft.end) && draft.end < draft.start) throw new Error("Calendar.add: `end` is not before `start`")
      assertSupported()
      return await service().add(draft)
    },

    async show(id: string, start?: number): Promise<void> {
      if (typeof id !== "string") throw new Error("Calendar.show: `id` is an event's id")
      assertSupported()
      if (id === "") throw new Error("notFound")
      await service().show(id, isTime(start) ? start : undefined)
    },

    onChange(listener: () => void): () => void {
      if (!supports()) return () => {}
      const s = service()
      const heard = (): void => listener()
      s.on("changed", heard)
      // The half hears of a listener when the session is open, and the first call opens it.
      s.access().catch(() => {})
      return () => { s.off("changed", heard) }
    },
  }
  Object.defineProperty(calendar, "supported", { get: (): boolean => supports() })
  return calendar as any
})()
