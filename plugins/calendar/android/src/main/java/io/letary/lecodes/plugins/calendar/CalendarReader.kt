//
//  CalendarReader.kt — lecodes-plugins/calendar
//
//  The reads of the calendar provider (CalendarContract), all of them blocking: the service runs
//  them off the main thread.
//
//  list() reads INSTANCES, the provider's own expansion of the events over a range: a recurring
//  event answers once per occurrence, with the event's id. An exception of one (an occurrence moved
//  or edited alone) is a row of Events of its own and answers with ITS id — its card is the one
//  show() opens, its title the one the person gave it. A cancelled entry (a meeting called off, an
//  occurrence deleted alone) and a deleted event the sync has not purged yet are dropped, as the
//  Calendar app drops them.
//
//  ALL-DAY times: the provider stores an all-day event as UTC midnights, its date whatever the zone;
//  the contract tells it as LOCAL midnights. Converted by the calendar date — the UTC date's fields
//  rebuilt in the device's zone ([AllDay]) — not by an offset, which a DST change would break. A UTC
//  midnight is up to 14 hours away from the local one, so a range is read a day wider on each side
//  and cut to the contract's range once the times are local.
//

package io.letary.lecodes.plugins.calendar

import android.content.ContentUris
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.provider.CalendarContract
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import android.provider.CalendarContract.Instances
import java.util.Calendar as JavaCalendar
import java.util.GregorianCalendar
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs

internal const val DAY_MS = 86_400_000L
internal const val HOUR_MS = 3_600_000L

/** The times of an all-day event: the provider's UTC midnights, the contract's local ones. */
internal object AllDay {
    private val UTC: TimeZone = TimeZone.getTimeZone("UTC")

    /** The provider's UTC midnight → the local midnight of the same date. Rounded to the nearest UTC
     *  midnight first: a sync adapter that wrote a local midnight instead still lands on its date
     *  in a zone within 12 hours of UTC. */
    fun toLocal(utcMidnight: Long): Long =
        midnight(TimeZone.getDefault(), at(UTC, (utcMidnight + DAY_MS / 2).floorDiv(DAY_MS) * DAY_MS))

    /** The local date of `local` → its UTC midnight (what the provider stores). */
    fun toUtc(local: Long): Long = midnight(UTC, at(TimeZone.getDefault(), local))

    /** The local midnight at or before `t`. */
    fun floor(t: Long): Long = midnight(TimeZone.getDefault(), at(TimeZone.getDefault(), t))

    /** The local midnight at or after `t`. */
    fun ceil(t: Long): Long = floor(t).let { if (it == t) it else next(it) }

    /** The local midnight of the day after `t`'s date (a day is not always 24 hours). */
    fun next(t: Long): Long {
        val day = at(TimeZone.getDefault(), t)
        day.add(JavaCalendar.DAY_OF_MONTH, 1)
        return midnight(TimeZone.getDefault(), day)
    }

    private fun at(zone: TimeZone, t: Long) = GregorianCalendar(zone).apply { timeInMillis = t }

    private fun midnight(zone: TimeZone, date: GregorianCalendar): Long = GregorianCalendar(zone).apply {
        clear()
        set(date.get(JavaCalendar.YEAR), date.get(JavaCalendar.MONTH), date.get(JavaCalendar.DAY_OF_MONTH))
    }.timeInMillis
}

/** One occurrence as the provider stores it: what the Calendar app's card takes as its extras. */
internal class Occurrence(val begin: Long, val end: Long, val allDay: Boolean)

internal class CalendarReader(context: Context) {
    private val resolver = context.contentResolver

    // ── calendars ────────────────────────────────────────────────────────────

    fun calendars(): List<CalendarInfo> {
        val projection = arrayOf(
            Calendars._ID, Calendars.CALENDAR_DISPLAY_NAME, Calendars.NAME, Calendars.CALENDAR_COLOR,
            Calendars.ACCOUNT_NAME, Calendars.ACCOUNT_TYPE, Calendars.CALENDAR_ACCESS_LEVEL,
        )
        val out = ArrayList<CalendarInfo>()
        resolver.query(Calendars.CONTENT_URI, projection, null, null, Calendars._ID)?.use { c ->
            while (c.moveToNext()) {
                val local = c.getString(5) == CalendarContract.ACCOUNT_TYPE_LOCAL
                out.add(CalendarInfo(
                    id = c.getLong(0).toString(),
                    title = c.getString(1).clean() ?: c.getString(2).clean() ?: "",
                    color = String.format(Locale.ROOT, "#%06X", c.getInt(3) and 0xFFFFFF),
                    account = if (local) null else c.getString(4).clean(),
                    // A birthdays, a holidays, a subscribed calendar is READ (200) or below.
                    writable = !c.isNull(6) && c.getInt(6) >= Calendars.CAL_ACCESS_CONTRIBUTOR,
                ))
            }
        }
        return out
    }

    // ── events ───────────────────────────────────────────────────────────────

    private val instanceColumns = arrayOf(
        Instances.EVENT_ID, Instances.BEGIN, Instances.END, Instances.CALENDAR_ID, Instances.TITLE,
        Instances.ALL_DAY, Instances.EVENT_LOCATION, Instances.DESCRIPTION,
        Instances.RRULE, Instances.RDATE, Instances.ORIGINAL_ID, Instances.ORIGINAL_SYNC_ID,
    )

    /** Instances of [begin, end] as the provider bounds them (begin <= end AND end >= begin). */
    private fun instances(begin: Long, end: Long, selection: String): Cursor? {
        val uri = Instances.CONTENT_URI.buildUpon()
            .also { ContentUris.appendId(it, begin); ContentUris.appendId(it, end) }.build()
        val live = "(${Instances.STATUS} IS NULL OR ${Instances.STATUS} != ${Events.STATUS_CANCELED})"
        return resolver.query(uri, instanceColumns, "$live AND ($selection)", null, null)
    }

    /** The events deleted on the device that the sync has not purged yet: the provider keeps their rows. */
    private fun deleted(): Set<Long> {
        val out = HashSet<Long>()
        resolver.query(Events.CONTENT_URI, arrayOf(Events._ID), "${Events.DELETED} = 1", null, null)?.use { c ->
            while (c.moveToNext()) out.add(c.getLong(0))
        }
        return out
    }

    /** The occurrences that overlap [from, to), sorted by start; `calendars`: only theirs. */
    fun list(from: Long, to: Long, calendars: List<String>?): List<CalendarEvent> {
        // An id that is no calendar's matches nothing.
        val only = calendars?.takeIf { it.isNotEmpty() }?.mapNotNull { it.trim().toLongOrNull() }
        if (only != null && only.isEmpty()) return emptyList()
        val selection = only?.let { "${Instances.CALENDAR_ID} IN (${it.joinToString(",")})" } ?: "1"
        val gone = deleted()
        val out = ArrayList<CalendarEvent>()
        instances(from - DAY_MS, to + DAY_MS, selection)?.use { c ->
            while (c.moveToNext()) {
                if (c.getLong(0) in gone) continue
                val event = event(c)
                // A zero-length event at `from` is in the range; one that ends at `from` is not.
                if (event.start < to && (event.end > from || event.start >= from)) out.add(event)
            }
        }
        return out.sortedWith(compareBy({ it.start }, { it.end }))
    }

    /** An occurrence of `instanceColumns`, its times as the contract tells them. */
    private fun event(c: Cursor): CalendarEvent {
        val allDay = c.getInt(5) != 0
        val (start, end) = times(c.getLong(1), c.getLong(2), allDay)
        return CalendarEvent(
            id = c.getLong(0).toString(),
            calendarId = c.getLong(3).toString(),
            title = c.getString(4) ?: "",
            start = start.toDouble(),
            end = end.toDouble(),
            allDay = allDay,
            recurring = c.getString(8).clean() != null || c.getString(9).clean() != null ||
                !c.isNull(10) || c.getString(11).clean() != null,
            location = c.getString(6).present(),
            notes = c.getString(7).present(),
        )
    }

    /** The provider's begin / end → the contract's: local midnights for an all-day event, the day
     *  after its start at least; otherwise as stored, never ending before it begins. */
    private fun times(begin: Long, end: Long, allDay: Boolean): Pair<Long, Long> {
        if (!allDay) return begin to maxOf(begin, end)
        val start = AllDay.toLocal(begin)
        val last = AllDay.toLocal(end)
        return start to (if (last > start) last else AllDay.next(start))
    }

    private val eventColumns = arrayOf(
        Events._ID, Events.CALENDAR_ID, Events.TITLE, Events.DTSTART, Events.DTEND, Events.DURATION,
        Events.ALL_DAY, Events.EVENT_LOCATION, Events.DESCRIPTION, Events.RRULE, Events.RDATE,
        Events.ORIGINAL_ID, Events.ORIGINAL_SYNC_ID, Events.STATUS, Events.DELETED,
    )

    /** Run `read` on the row of event `id`, null when there is none (deleted, cancelled, never was). */
    private fun <T> row(id: String, read: (Cursor) -> T): T? {
        val row = id.trim().toLongOrNull() ?: return null
        resolver.query(ContentUris.withAppendedId(Events.CONTENT_URI, row), eventColumns, null, null, null)?.use { c ->
            if (!c.moveToFirst()) return null
            if (c.getInt(14) == 1 || (!c.isNull(13) && c.getInt(13) == Events.STATUS_CANCELED)) return null
            return read(c)
        }
        return null
    }

    /** An event's first occurrence as stored: DTSTART, and DTEND — or, for a recurring one (which has
     *  none), DTSTART + DURATION. */
    private fun first(c: Cursor): Occurrence {
        val begin = c.getLong(3)
        val end = if (!c.isNull(4)) c.getLong(4) else begin + duration(c.getString(5))
        return Occurrence(begin, end, c.getInt(6) != 0)
    }

    /** One event by its id: of a recurring one, its first occurrence. */
    fun get(id: String): CalendarEvent? = row(id) { c ->
        val first = first(c)
        val (start, end) = times(first.begin, first.end, first.allDay)
        CalendarEvent(
            id = c.getLong(0).toString(),
            calendarId = c.getLong(1).toString(),
            title = c.getString(2) ?: "",
            start = start.toDouble(),
            end = end.toDouble(),
            allDay = first.allDay,
            recurring = c.getString(9).clean() != null || c.getString(10).clean() != null ||
                !c.isNull(11) || c.getString(12).clean() != null,
            location = c.getString(7).present(),
            notes = c.getString(8).present(),
        )
    }

    /** The provider's own times of the occurrence of `id` that the contract's `start` names — the
     *  nearest one within two days of it — else of its first. Null when there is no such event. */
    fun occurrence(id: String, start: Long?): Occurrence? {
        val first = row(id) { first(it) } ?: return null
        if (start == null) return first
        var best: Occurrence? = null
        var distance = Long.MAX_VALUE
        instances(start - 2 * DAY_MS, start + 2 * DAY_MS, "${Instances.EVENT_ID} = ${id.trim().toLong()}")?.use { c ->
            while (c.moveToNext()) {
                val allDay = c.getInt(5) != 0
                val begin = c.getLong(1)
                val d = abs(times(begin, c.getLong(2), allDay).first - start)
                if (d < distance) { distance = d; best = Occurrence(begin, c.getLong(2), allDay) }
            }
        }
        return best ?: first
    }

    // ── what an editor added ─────────────────────────────────────────────────

    /** The highest event row id now, -1 for none: an event saved later has a higher one. */
    fun lastEventId(): Long =
        resolver.query(Events.CONTENT_URI, arrayOf(Events._ID), null, null, "${Events._ID} DESC")?.use { c ->
            if (c.moveToFirst()) c.getLong(0) else -1L
        } ?: -1L

    /** An event (not deleted) was added since `lastEventId()` answered `last`. */
    fun addedSince(last: Long): Boolean =
        resolver.query(Events.CONTENT_URI, arrayOf(Events._ID), "${Events._ID} > ? AND ${Events.DELETED} = 0", arrayOf(last.toString()), null)
            ?.use { it.count > 0 } ?: false

    /** The card of an event: what the Calendar app opens. */
    fun cardUri(id: String): Uri = ContentUris.withAppendedId(Events.CONTENT_URI, id.trim().toLong())

    private companion object {
        fun String?.clean(): String? = this?.trim()?.takeIf { it.isNotEmpty() }

        /** As written, absent when there is nothing in it. */
        fun String?.present(): String? = this?.takeIf { it.isNotBlank() }

        /** RFC 5545's DURATION ("PT1H", "P1D", "P1W") — and Android's own "P3600S", which has no T. */
        private val DURATION = Regex("""^([+-])?P(?:(\d+)W)?(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$""")

        fun duration(text: String?): Long {
            val m = DURATION.matchEntire(text?.trim()?.uppercase(Locale.ROOT) ?: return 0) ?: return 0
            fun part(i: Int) = m.groupValues[i].toLongOrNull() ?: 0L
            val ms = part(2) * 7 * DAY_MS + part(3) * DAY_MS + part(4) * HOUR_MS + part(5) * 60_000L + part(6) * 1_000L
            return if (m.groupValues[1] == "-") -ms else ms
        }
    }
}
