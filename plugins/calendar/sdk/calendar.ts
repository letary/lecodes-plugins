// Calendar — the device's calendars: reading calendars and events behind the `calendar`
// permission, adding and editing an event through the system's own screens.
//
// Hand-written over the generated wire (calendar.gen.ts) for what a host WITHOUT the service
// answers — the web, the desktop, the headless renderer, a shell built without the plugin:
// `supported` is false and every call rejects "unavailable" before the host is touched. For a range that is not one, said
// here and not by a half. And for `onChange`, the listener API over the wire's `changed` event.
//
// The METHODS THAT OPEN A SYSTEM SCREEN say so: openEditor() is the "new event" editor, openEvent()
// an event's card. Neither writes for the person.
//
// The permission is the host's (`permissions.query("calendar")` / `request`): it asks at the first
// calendars() / list() / get() / openEvent(), and a refusal is the rejection "denied". openEditor()
// asks none (iOS 15 / 16 excepted: the system's editor needs it there).
//
// Times are milliseconds since the epoch (`Date.now()`, `date.getTime()`).

import { CalendarBase, supports } from "./calendar.gen"
import type { CalendarEvent, CalendarEventDraft, CalendarInfo, CalendarListOptions } from "../contract"

export type { CalendarEvent, CalendarEventDraft, CalendarInfo, CalendarListOptions }

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
  /** OPEN the system's "new event" editor, filled from `draft`; the person saves, or not. true when
   *  they saved the event (Android: false when its calendar app does not say). Nothing is written
   *  without them. No permission, except on iOS 15 / 16.
   *  Rejects "unavailable", "busy" (a screen of Calendar is up), "denied" (iOS 15 / 16), "failed". */
  openEditor(draft: CalendarEventDraft): Promise<boolean>
  /** OPEN the system's card of an event — where the person edits or deletes it; `start` names the
   *  occurrence of a recurring one. Resolves when it closes. Rejects "notFound", and as calendars(). */
  openEvent(id: string, start?: number): Promise<void>
  /** Listen to changes of the calendars (by anyone, a sync included). No payload: list() again.
   *  Returns a function that stops listening. Heard from the app's first call on, while it may read
   *  the calendars; never called on a host without the service. */
  onChange(listener: () => void): () => void
} = /*#__PURE__*/ (() => {
  let client: CalendarBase | null = null
  const service = (): CalendarBase => client ??= new CalendarBase()

  /** The host's own rejection for a call it cannot serve — same shape as a half's. */
  const assertSupported = (): void => {
    if (!supports()) throw new Error("unavailable")
  }

  const calendar = {
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

    async openEditor(draft: CalendarEventDraft): Promise<boolean> {
      if (typeof draft !== "object" || draft === null) throw new Error("Calendar.openEditor: a draft is required — {} opens an empty editor")
      if (isTime(draft.start) && isTime(draft.end) && draft.end < draft.start) throw new Error("Calendar.openEditor: `end` is not before `start`")
      assertSupported()
      return await service().openEditor(draft)
    },

    async openEvent(id: string, start?: number): Promise<void> {
      if (typeof id !== "string") throw new Error("Calendar.openEvent: `id` is an event's id")
      assertSupported()
      if (id === "") throw new Error("notFound")
      await service().openEvent(id, isTime(start) ? start : undefined)
    },

    onChange(listener: () => void): () => void {
      if (!supports()) return () => {}
      const s = service()
      const heard = (): void => listener()
      // The half hears of the listener when the session opens — the app's first call: there is
      // nothing to read again before the app has read.
      s.on("changed", heard)
      return () => { s.off("changed", heard) }
    },
  }
  Object.defineProperty(calendar, "supported", { get: (): boolean => supports() })
  return calendar as any
})()
