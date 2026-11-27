//
//  CalendarService.kt — lecodes-plugins/calendar
//
//  One session of the "calendar" service: the contract's CalendarPlugin (Calendar.gen.kt reads the
//  calls off the wire and asks the `calendar` permission before calendars / list / get / show).
//
//  READING is the provider's (CalendarReader), on a thread of the session's own; a reply is settled
//  back on the main thread.
//
//  The SCREENS are the Calendar app's, started for a result from a fragment of the host's activity
//  (CalendarFragment), one at a time — a call while one is up rejects BUSY:
//    - add: ACTION_INSERT on Events, the editor filled from the draft. The app writes nothing
//      itself and holds no WRITE_CALENDAR: the person saves, or does not. The editor is another
//      app's and seldom says which (most answer RESULT_CANCELED either way), so when the app may
//      read the calendars the answer is the provider's — an event row newer than the last one
//      before the editor opened; without the permission it is the result code alone.
//    - show: ACTION_VIEW of the event, with the provider's begin / end of the occurrence named.
//
//  `changed` watches the whole provider (CalendarContract.CONTENT_URI) while the app listens and may
//  read it.
//

package io.letary.lecodes.plugins.calendar

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import android.provider.CalendarContract.Events
import android.util.Log
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.services.Permissions
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class CalendarService(
    private val engine: LecodesEngine,
    context: Context,
    private val events: CalendarEvents,
) : CalendarPlugin {
    private val appContext = context.applicationContext
    private val reader = CalendarReader(appContext)
    private val main = Handler(Looper.getMainLooper())
    private val io: ExecutorService = Executors.newSingleThreadExecutor()
    private var closed = false

    /** The screen that is up: what settles its call when the session closes under it. */
    private var screen: Screen? = null
    private class Screen(val abandon: () -> Unit)

    private var observer: ContentObserver? = null

    private val mayRead: Boolean
        get() = appContext.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED

    // ── access ───────────────────────────────────────────────────────────────

    override fun access(reply: Reply<CalendarAccess, CalendarCode>) {
        reply.resolve(when (engine.permissions.query(Permissions.Kind.of("calendar"))) {
            Permissions.State.GRANTED -> CalendarAccess.GRANTED
            Permissions.State.DENIED -> CalendarAccess.DENIED
            Permissions.State.PROMPT -> CalendarAccess.PROMPT
        })
    }

    // ── reading ──────────────────────────────────────────────────────────────

    /** Run a provider read off the main thread and settle `reply` on it. */
    private fun <T> read(reply: Reply<T, CalendarCode>, work: () -> T) {
        if (closed) return reply.reject(CalendarCode.FAILED)
        io.execute {
            val settle: () -> Unit = try {
                val value = work()
                ({ reply.resolve(value) })
            } catch (e: SecurityException) {
                ({ reply.reject(CalendarCode.DENIED) })   // revoked between the glue's check and the read
            } catch (e: Exception) {
                Log.w(TAG, "[calendar] a read failed: $e")
                ({ reply.reject(CalendarCode.FAILED) })
            }
            main.post {
                settle()
                observe()   // a watch asked for before the permission was granted starts now
            }
        }
    }

    override fun calendars(reply: Reply<List<CalendarInfo>, CalendarCode>) {
        read(reply) { reader.calendars() }
    }

    override fun list(options: CalendarListOptions, reply: Reply<List<CalendarEvent>, CalendarCode>) {
        read(reply) { reader.list(options.from.toLong(), options.to.toLong(), options.calendars) }
    }

    override fun get(id: String, reply: Reply<CalendarEvent?, CalendarCode>) {
        read(reply) { reader.get(id) }
    }

    // ── the system's editor and card ─────────────────────────────────────────

    override fun add(draft: CalendarEventDraft, reply: Reply<Boolean, CalendarCode>) {
        if (closed) return reply.reject(CalendarCode.FAILED)
        if (screen != null) return reply.reject(CalendarCode.BUSY)
        val intent = Intent(Intent.ACTION_INSERT, Events.CONTENT_URI)
        draft.title?.let { intent.putExtra(Events.TITLE, it) }
        draft.location?.let { intent.putExtra(Events.EVENT_LOCATION, it) }
        // The editor has no field for a link: it goes with the notes, where the person sees it.
        listOfNotNull(draft.notes?.takeIf { it.isNotBlank() }, draft.url?.takeIf { it.isNotBlank() })
            .joinToString("\n\n").takeIf { it.isNotEmpty() }?.let { intent.putExtra(Events.DESCRIPTION, it) }
        val allDay = draft.allDay == true
        if (allDay) intent.putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, true)
        // Without a start the editor picks its own (the next hour), and the end with it.
        draft.start?.toLong()?.let { start ->
            val end = draft.end?.toLong()
            if (allDay) {
                // Whole local days: the editor reads an all-day time by its local date, and an end
                // at a midnight as the day before it.
                val first = AllDay.floor(start)
                val after = end?.let { AllDay.ceil(it) }?.takeIf { it > first } ?: AllDay.next(first)
                intent.putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, first)
                intent.putExtra(CalendarContract.EXTRA_EVENT_END_TIME, after)
            } else {
                intent.putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start)
                intent.putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end?.takeIf { it >= start } ?: (start + HOUR_MS))
            }
        }

        if (!mayRead) return present(intent, reply, onAbandon = { reply.resolve(false) }) { code, _ -> reply.resolve(code == Activity.RESULT_OK) }
        // The newest event row before the editor opens: a row above it after is the one saved.
        io.execute {
            val last = try { reader.lastEventId() } catch (e: Exception) { null }
            main.post {
                present(intent, reply, onAbandon = { reply.resolve(false) }) { code, _ ->
                    if (code == Activity.RESULT_OK || last == null) return@present reply.resolve(code == Activity.RESULT_OK)
                    saved(last) { reply.resolve(it) }
                }
            }
        }
    }

    /** Whether an event was saved since `last` — the editor may write it after it closed: asked
     *  again for a moment. On the main thread. */
    private fun saved(last: Long, then: (Boolean) -> Unit) {
        if (closed) return then(false)
        io.execute {
            var added = false
            for (wait in SAVE_WAITS) {
                if (wait > 0) try { Thread.sleep(wait) } catch (e: InterruptedException) { break }
                added = try { reader.addedSince(last) } catch (e: Exception) { false }
                if (added) break
            }
            main.post { then(added) }
        }
    }

    override fun show(id: String, start: Double?, reply: Reply<Unit, CalendarCode>) {
        if (closed) return reply.reject(CalendarCode.FAILED)
        if (screen != null) return reply.reject(CalendarCode.BUSY)
        io.execute {
            val settle: () -> Unit = try {
                val occurrence = reader.occurrence(id, start?.toLong())
                if (occurrence == null) ({ reply.reject(CalendarCode.NOT_FOUND) })
                else ({
                    // The provider's own times, as the Calendar app's widgets hand them over.
                    val intent = Intent(Intent.ACTION_VIEW, reader.cardUri(id))
                        .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, occurrence.begin)
                        .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, occurrence.end)
                        .putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, occurrence.allDay)
                    present(intent, reply, onAbandon = { reply.resolve() }) { _, _ -> reply.resolve() }
                })
            } catch (e: SecurityException) {
                ({ reply.reject(CalendarCode.DENIED) })
            } catch (e: Exception) {
                Log.w(TAG, "[calendar] the event could not be read: $e")
                ({ reply.reject(CalendarCode.FAILED) })
            }
            main.post(settle)
        }
    }

    // ── presenting ───────────────────────────────────────────────────────────

    /** Start a screen of the Calendar app for its result. `then` runs once, on the main thread, when
     *  the screen closes; `onAbandon` instead when the session closes under it. */
    private fun present(intent: Intent, reply: Reply<*, CalendarCode>, onAbandon: () -> Unit, then: (Int, Intent?) -> Unit) {
        if (closed) return reply.reject(CalendarCode.FAILED)
        if (screen != null) return reply.reject(CalendarCode.BUSY)
        val activity = engine.getActivity() ?: return reply.reject(CalendarCode.FAILED)
        val fm = activity.supportFragmentManager
        // No fragment is added once the activity saved its state (the app is in the background).
        if (activity.isFinishing || activity.isDestroyed || fm.isStateSaved) return reply.reject(CalendarCode.FAILED)
        val fragment = fm.findFragmentByTag(CalendarFragment.TAG) as? CalendarFragment
            ?: CalendarFragment().also { fm.beginTransaction().add(it, CalendarFragment.TAG).commitNow() }

        val mine = Screen(onAbandon)
        screen = mine
        try {
            fragment.launch(intent) { code, data ->
                if (screen === mine) { screen = null; then(code, data) }   // else: close() settled it
            }
        } catch (e: ActivityNotFoundException) {
            screen = null
            reply.reject(CalendarCode.UNAVAILABLE)   // no Calendar app (a TV, a stripped device)
        } catch (e: Exception) {
            Log.w(TAG, "[calendar] the screen did not start: $e")
            screen = null
            reply.reject(CalendarCode.FAILED)
        }
    }

    // ── the changed event ────────────────────────────────────────────────────

    override fun changedObserved(observed: Boolean) {
        if (observed) observe() else unobserve()
    }

    private val changed = Runnable { events.changed() }

    /** Watch the provider while the app listens. It is watched only by an app that may read it:
     *  asked for earlier, the watch starts at the first read that went through. */
    private fun observe() {
        if (closed || observer != null || !events.changedObserved || !mayRead) return
        val watch = object : ContentObserver(main) {
            // One edit is several writes, a sync many: one `changed` once they settle.
            override fun onChange(selfChange: Boolean) {
                main.removeCallbacks(changed)
                main.postDelayed(changed, 400)
            }
        }
        try {
            appContext.contentResolver.registerContentObserver(CalendarContract.CONTENT_URI, true, watch)
            observer = watch
        } catch (e: SecurityException) {
        }
    }

    private fun unobserve() {
        main.removeCallbacks(changed)
        observer?.let { appContext.contentResolver.unregisterContentObserver(it) }
        observer = null
    }

    override fun close() {
        closed = true
        unobserve()
        screen?.let { up -> screen = null; up.abandon() }
        io.shutdown()   // a read under way still settles its reply
    }

    companion object {
        private const val TAG = "LeCodesCalendar"

        /** How long after the editor closed its event is looked for, ms between the tries. */
        private val SAVE_WAITS = longArrayOf(0, 250, 400, 600)
    }
}

/**
 * The fragment a screen of the Calendar app is started from (the activity result contract needs
 * one). The callback is the CLASS's, not the instance's: the activity made again under a screen (a
 * turn of the device) brings a new instance, and the result still finds who waits for it.
 */
class CalendarFragment : Fragment() {

    private val launcher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val done = pending
        pending = null
        done?.invoke(result.resultCode, result.data)
    }

    fun launch(intent: Intent, callback: (Int, Intent?) -> Unit) {
        pending = callback
        launcher.launch(intent)
    }

    companion object {
        const val TAG = "LecodesCalendarFragment"
        private var pending: ((Int, Intent?) -> Unit)? = null
    }
}
