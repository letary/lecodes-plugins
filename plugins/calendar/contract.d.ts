// calendar — the device's calendars and their events. iOS: EventKit and EventKitUI. Android: the
// calendar provider (CalendarContract) and the Calendar app's own screens.
//
// Two ways in, and only one of them asks a permission:
//   - calendars() / list() / get() / show(): READING, behind the `calendar` permission
//     (`@permission calendar`: the host asks before the first call, the halves never do).
//   - add() / show(): WRITING is the system's — its "new event" editor, an event's card (where it is
//     edited and deleted). The plugin writes nothing itself and declares no write permission (no
//     WRITE_CALENDAR on Android, no write-only access on iOS).
//
// TIMES are milliseconds since the epoch. An ALL-DAY event is told in the device's time zone,
// whatever the platform stores: `start` is the local midnight its first day begins at, `end` the
// local midnight AFTER its last day — a one-day event spans exactly that day. The same goes for a
// draft.
//
// A RECURRING event is one event with many occurrences: list() answers one entry per occurrence in
// the range — the same `id`, each its own `start` / `end` — and `start` is what tells them apart
// (show() takes it). On Android an occurrence the person edited or moved on its own is an event of
// its own in the provider: it comes with its own `id`.
//
// Reminders (the to-do lists of iOS) are not part of the contract: Android has none.
//
// No web half: a browser has no calendar a page may read or write.

import type { Service, f64 } from "lecodes-sdk/plugin"

/** "prompt": never asked — the first read asks. "denied": refused, or restricted by the device. */
export type CalendarAccess = "granted" | "denied" | "prompt"

/** One of the device's calendars ("Work", "Birthdays", a subscribed one). */
export interface CalendarInfo {
  /** The calendar's id on THIS device — what `calendars` of list() takes. */
  id: string
  /** Its name as the device shows it. */
  title: string
  /** Its color, "#RRGGBB". */
  color: string
  /** The account it belongs to ("iCloud", an email address); absent for a local one. */
  account?: string
  /** Events can be added to it (not a subscribed or a birthdays calendar). */
  writable: boolean
}

export interface CalendarEvent {
  /** The event's id on THIS device — what get() and show() take. Every occurrence of a recurring
   *  event has the same one (Android: but for an occurrence edited on its own, see above). */
  id: string
  calendarId: string
  /** "" for an event without a title. */
  title: string
  /** When this occurrence begins, ms since the epoch. */
  start: f64
  /** When it ends, ms since the epoch. */
  end: f64
  /** It takes whole days: `start` and `end` are local midnights (see the head of the file). */
  allDay: boolean
  /** It repeats: one of its occurrences. */
  recurring: boolean
  location?: string
  notes?: string
  /** iOS only: an Android event has no link of its own. */
  url?: string
}

export interface CalendarListOptions {
  /** The range, ms since the epoch: the occurrences that overlap [from, to). At most four years. */
  from: f64
  to: f64
  /** Only these calendars (their ids). Default: every calendar. */
  calendars?: string[]
}

/** What the system's "new event" editor opens with: the person may change any of it. */
export interface CalendarEventDraft {
  title?: string
  /** ms since the epoch. Left out: the editor's own default (the next hour). */
  start?: f64
  /** ms since the epoch. Left out: an hour after `start` (a day for an all-day event). */
  end?: f64
  allDay?: boolean
  location?: string
  notes?: string
  /** Android: an event has no link of its own there — it is put at the end of the notes. */
  url?: string
}

export interface CalendarParams {}

export interface CalendarEvents {
  /** The calendars changed (an event added, edited, deleted — by anyone, a sync included). No
   *  payload: list() again. Sent while the app listens and may read the calendars.
   *  @lazy */
  changed: void
}

export interface Calendar extends Service<"calendar", CalendarParams, CalendarEvents> {
  /** Whether the app may read the calendars. Never prompts. */
  access(): Promise<CalendarAccess>

  /** The device's calendars.
   *  @permission calendar
   *  @rejects failed */
  calendars(): Promise<CalendarInfo[]>
  /** The events of a range, sorted by `start`; a recurring event once per occurrence in it.
   *  @permission calendar
   *  @rejects failed */
  list(options: CalendarListOptions): Promise<CalendarEvent[]>
  /** One event by its id — of a recurring one, its first occurrence; null when there is none.
   *  @permission calendar
   *  @rejects failed */
  get(id: string): Promise<CalendarEvent | null>

  /** The system's "new event" editor, opened with `draft`. Resolves with true when the person
   *  saved the event, false when they left without saving. No permission of the plugin's — except
   *  on iOS 15 / 16, where the system's editor itself needs the calendar permission: it is asked
   *  first there, and a refusal is `denied`.
   *  Android cannot always tell: its editor is another app's, and one that does not say whether it
   *  saved answers false.
   *  `unavailable`: the device has no calendar app.
   *  @rejects busy denied unavailable failed */
  add(draft: CalendarEventDraft): Promise<boolean>
  /** The system's card of an event: where the person sees it, edits it, deletes it. `start` names
   *  the occurrence of a recurring event (left out: its first). Resolves when the card closes
   *  (`changed` says whether anything was written).
   *  `notFound`: no such event.
   *  @permission calendar
   *  @rejects busy notFound unavailable failed */
  show(id: string, start?: f64): Promise<void>
}
