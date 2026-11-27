//
//  ContactsService.kt — lecodes-plugins/contacts
//
//  One session of the "contacts" service: the contract's ContactsPlugin (Contacts.gen.kt reads the
//  calls off the wire and asks the `contacts` permission before list / get / photo / show).
//
//  READING is the provider's (ContactsReader), on a thread of the session's own; a reply is settled
//  back on the main thread.
//
//  The SCREENS are the Contacts app's, started for a result from a fragment of the host's activity
//  (ContactsFragment), one at a time — a call while one is up rejects BUSY:
//    - pick, Android 17+ (API 37): the system's contact picker (ACTION_PICK_CONTACTS) — several
//      contacts, the data kinds asked, read from the session it returns. No permission.
//    - pick, before: ACTION_PICK, one contact. Its result grants the picked URI and nothing else,
//      so what is picked depends on what may be read: a CONTACT when the app may read the address
//      book (its rows are then read) or asked for no data; else a DATA row of the first of phones /
//      emails / addresses asked — the picker then lists numbers (emails, addresses), the person
//      taps one and the contact carries that one.
//    - add: ACTION_INSERT, the editor filled from the draft. The app writes nothing itself.
//    - show: ACTION_VIEW of the contact's card.
//
//  The API 37 names are written as their values: this module compiles against an older SDK.
//

package io.letary.lecodes.plugins.contacts

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Email
import android.provider.ContactsContract.CommonDataKinds.Event
import android.provider.ContactsContract.CommonDataKinds.Nickname
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.ContactsContract.CommonDataKinds.StructuredPostal
import android.provider.ContactsContract.CommonDataKinds.Website
import android.provider.ContactsContract.Contacts
import android.provider.ContactsContract.Data
import android.util.Log
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.services.Permissions
import io.letary.lecodes.services.PluginFile
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class ContactsService(
    private val engine: LecodesEngine,
    context: Context,
    private val events: ContactsEvents,
) : ContactsPlugin {
    private val appContext = context.applicationContext
    private val reader = ContactsReader(appContext)
    private val main = Handler(Looper.getMainLooper())
    private val io: ExecutorService = Executors.newSingleThreadExecutor()
    private var closed = false

    /** The screen that is up: what settles its call when the session closes under it. */
    private var screen: Screen? = null
    private class Screen(val abandon: () -> Unit)

    private var observer: ContentObserver? = null

    private val mayRead: Boolean
        get() = appContext.checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

    // ── access ───────────────────────────────────────────────────────────────

    override fun access(reply: Reply<ContactsAccess, ContactsCode>) {
        reply.resolve(when (engine.permissions.query(Permissions.Kind.CONTACTS)) {
            Permissions.State.GRANTED -> ContactsAccess.GRANTED
            Permissions.State.DENIED -> ContactsAccess.DENIED
            Permissions.State.PROMPT -> ContactsAccess.PROMPT
        })
    }

    /** Android gives an app the whole address book or none of it: nothing to manage. */
    override fun manageAccess(reply: Reply<Unit, ContactsCode>) = reply.resolve()

    // ── reading ──────────────────────────────────────────────────────────────

    /** Run a provider read off the main thread and settle `reply` on it. */
    private fun <T> read(reply: Reply<T, ContactsCode>, work: () -> T) {
        if (closed) return reply.reject(ContactsCode.FAILED)
        io.execute {
            val settle: () -> Unit = try {
                val value = work()
                ({ reply.resolve(value) })
            } catch (e: SecurityException) {
                ({ reply.reject(ContactsCode.DENIED) })   // revoked between the glue's check and the read
            } catch (e: Exception) {
                Log.w(TAG, "[contacts] a read failed: $e")
                ({ reply.reject(ContactsCode.FAILED) })
            }
            main.post {
                settle()
                observe()   // a watch asked for before the permission was granted starts now
            }
        }
    }

    override fun list(options: ContactListOptions?, reply: Reply<List<Contact>, ContactsCode>) {
        val fields = options?.fields.orEmpty().toSet()
        read(reply) { reader.list(fields, options?.query) }
    }

    override fun get(id: String, fields: List<ContactField>?, reply: Reply<Contact?, ContactsCode>) {
        read(reply) { reader.get(id, fields.orEmpty().toSet()) }
    }

    override fun photo(id: String, size: ContactPhotoSize?, reply: Reply<PluginFile?, ContactsCode>) {
        read(reply) {
            reader.photo(id, full = size == ContactPhotoSize.FULL)?.let { bytes ->
                val png = bytes.size > 3 && bytes[0] == 0x89.toByte() && bytes[1] == 'P'.code.toByte() && bytes[2] == 'N'.code.toByte()
                PluginFile(bytes, if (png) "photo.png" else "photo.jpg")
            }
        }
    }

    // ── the picker ───────────────────────────────────────────────────────────

    override fun pick(options: ContactPickOptions?, reply: Reply<List<Contact>, ContactsCode>) {
        val fields = options?.fields.orEmpty().toSet()
        val multiple = options?.multiple == true

        if (Build.VERSION.SDK_INT >= API_CONTACT_PICKER) {
            val intent = Intent(ACTION_PICK_CONTACTS)
                // The name's rows always: the extra may not be empty, and a contact's name parts come with it.
                .putStringArrayListExtra(EXTRA_REQUESTED_DATA_FIELDS, reader.mimes(fields, nickname = false))
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
            if (multiple) intent.putExtra(EXTRA_SELECTION_LIMIT, SELECTION_LIMIT)
            return present(intent, reply, onAbandon = { reply.resolve(emptyList()) }) { code, data ->
                val session = data?.data
                if (code != Activity.RESULT_OK || session == null) reply.resolve(emptyList())
                else read(reply) { reader.pickedSession(session, fields) }
            }
        }

        // One contact. Without the permission its rows cannot be read: pick the one row asked instead.
        val granted = mayRead
        val rows: Uri? = if (granted) null else fields.firstNotNullOfOrNull {
            when (it) {
                ContactField.PHONES -> Phone.CONTENT_URI
                ContactField.EMAILS -> Email.CONTENT_URI
                ContactField.ADDRESSES -> StructuredPostal.CONTENT_URI
                else -> null
            }
        }
        present(Intent(Intent.ACTION_PICK, rows ?: Contacts.CONTENT_URI), reply, onAbandon = { reply.resolve(emptyList()) }) { code, data ->
            val picked = data?.data
            if (code != Activity.RESULT_OK || picked == null) reply.resolve(emptyList())
            else read(reply) {
                listOfNotNull(if (rows != null) reader.pickedRow(picked, fields) else reader.pickedContact(picked, fields, granted))
            }
        }
    }

    // ── the system's editor and card ─────────────────────────────────────────

    override fun add(draft: ContactDraft, reply: Reply<Boolean, ContactsCode>) {
        val intent = Intent(Intent.ACTION_INSERT, Contacts.CONTENT_URI)
            // Come back when the contact is saved, with RESULT_OK (the AOSP editor's own extra).
            .putExtra("finishActivityOnSaveCompleted", true)
        // The name and the organization by the editor's plain extras (every editor reads them), the
        // rest as rows.
        listOfNotNull(draft.givenName, draft.middleName, draft.familyName).map { it.trim() }.filter { it.isNotEmpty() }
            .joinToString(" ").takeIf { it.isNotEmpty() }?.let { intent.putExtra(ContactsContract.Intents.Insert.NAME, it) }
        draft.organization?.company?.let { intent.putExtra(ContactsContract.Intents.Insert.COMPANY, it) }
        draft.organization?.title?.let { intent.putExtra(ContactsContract.Intents.Insert.JOB_TITLE, it) }

        val rows = ArrayList<ContentValues>()
        fun row(mime: String, fill: ContentValues.() -> Unit) = rows.add(ContentValues().apply { put(Data.MIMETYPE, mime); fill() })
        draft.nickname?.let { row(Nickname.CONTENT_ITEM_TYPE) { put(Nickname.NAME, it) } }
        for (phone in draft.phones.orEmpty()) row(Phone.CONTENT_ITEM_TYPE) {
            put(Phone.NUMBER, phone.number)
            typed(phone.label, Phone.TYPE, Phone.LABEL, Phone.TYPE_CUSTOM, mapOf(
                "mobile" to Phone.TYPE_MOBILE, "home" to Phone.TYPE_HOME, "work" to Phone.TYPE_WORK,
                "main" to Phone.TYPE_MAIN, "other" to Phone.TYPE_OTHER,
            ))
        }
        for (email in draft.emails.orEmpty()) row(Email.CONTENT_ITEM_TYPE) {
            put(Email.ADDRESS, email.address)
            typed(email.label, Email.TYPE, Email.LABEL, Email.TYPE_CUSTOM, mapOf(
                "home" to Email.TYPE_HOME, "work" to Email.TYPE_WORK, "mobile" to Email.TYPE_MOBILE, "other" to Email.TYPE_OTHER,
            ))
        }
        for (address in draft.addresses.orEmpty()) row(StructuredPostal.CONTENT_ITEM_TYPE) {
            address.street?.let { put(StructuredPostal.STREET, it) }
            address.city?.let { put(StructuredPostal.CITY, it) }
            address.region?.let { put(StructuredPostal.REGION, it) }
            address.postalCode?.let { put(StructuredPostal.POSTCODE, it) }
            address.country?.let { put(StructuredPostal.COUNTRY, it) }
            typed(address.label, StructuredPostal.TYPE, StructuredPostal.LABEL, StructuredPostal.TYPE_CUSTOM, mapOf(
                "home" to StructuredPostal.TYPE_HOME, "work" to StructuredPostal.TYPE_WORK, "other" to StructuredPostal.TYPE_OTHER,
            ))
        }
        for (url in draft.urls.orEmpty()) row(Website.CONTENT_ITEM_TYPE) {
            put(Website.URL, url.url)
            typed(url.label, Website.TYPE, Website.LABEL, Website.TYPE_CUSTOM, mapOf(
                "homepage" to Website.TYPE_HOMEPAGE, "home" to Website.TYPE_HOME, "work" to Website.TYPE_WORK, "other" to Website.TYPE_OTHER,
            ))
        }
        draft.birthday?.let { day ->
            row(Event.CONTENT_ITEM_TYPE) {
                put(Event.TYPE, Event.TYPE_BIRTHDAY)
                val tail = "%02d-%02d".format(day.month, day.day)
                put(Event.START_DATE, day.year?.let { "%04d-%s".format(it, tail) } ?: "--$tail")
            }
        }
        if (rows.isNotEmpty()) intent.putParcelableArrayListExtra(ContactsContract.Intents.Insert.DATA, rows)

        present(intent, reply, onAbandon = { reply.resolve(false) }) { code, _ -> reply.resolve(code == Activity.RESULT_OK) }
    }

    /** A row's type from a contract label: a known one by its constant, any other text as a custom one. */
    private fun ContentValues.typed(label: String?, typeColumn: String, labelColumn: String, custom: Int, known: Map<String, Int>) {
        val text = label?.trim()?.takeIf { it.isNotEmpty() } ?: return
        val type = known[text.lowercase()]
        if (type != null) put(typeColumn, type) else { put(typeColumn, custom); put(labelColumn, text) }
    }

    override fun show(id: String, reply: Reply<Unit, ContactsCode>) {
        if (closed) return reply.reject(ContactsCode.FAILED)
        if (screen != null) return reply.reject(ContactsCode.BUSY)
        io.execute {
            val card = try { reader.cardUri(id) } catch (e: Exception) { null }
            main.post {
                if (card == null) reply.reject(ContactsCode.NOT_FOUND)
                else present(Intent(Intent.ACTION_VIEW, card), reply, onAbandon = { reply.resolve() }) { _, _ -> reply.resolve() }
            }
        }
    }

    // ── presenting ───────────────────────────────────────────────────────────

    /** Start a screen of the Contacts app for its result. `then` runs once, on the main thread, when
     *  the screen closes; `onAbandon` instead when the session closes under it. */
    private fun present(intent: Intent, reply: Reply<*, ContactsCode>, onAbandon: () -> Unit, then: (Int, Intent?) -> Unit) {
        if (closed) return reply.reject(ContactsCode.FAILED)
        if (screen != null) return reply.reject(ContactsCode.BUSY)
        val activity = engine.getActivity() ?: return reply.reject(ContactsCode.FAILED)
        val fm = activity.supportFragmentManager
        // No fragment is added once the activity saved its state (the app is in the background).
        if (activity.isFinishing || activity.isDestroyed || fm.isStateSaved) return reply.reject(ContactsCode.FAILED)
        val fragment = fm.findFragmentByTag(ContactsFragment.TAG) as? ContactsFragment
            ?: ContactsFragment().also { fm.beginTransaction().add(it, ContactsFragment.TAG).commitNow() }

        val mine = Screen(onAbandon)
        screen = mine
        try {
            fragment.launch(intent) { code, data ->
                if (screen === mine) { screen = null; then(code, data) }   // else: close() settled it
            }
        } catch (e: ActivityNotFoundException) {
            screen = null
            reply.reject(ContactsCode.UNAVAILABLE)   // no Contacts app (a TV, a stripped device)
        } catch (e: Exception) {
            Log.w(TAG, "[contacts] the screen did not start: $e")
            screen = null
            reply.reject(ContactsCode.FAILED)
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
            // One edit is several writes: one `changed` once they settle.
            override fun onChange(selfChange: Boolean) {
                main.removeCallbacks(changed)
                main.postDelayed(changed, 400)
            }
        }
        try {
            appContext.contentResolver.registerContentObserver(Contacts.CONTENT_URI, true, watch)
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
        private const val TAG = "LeCodesContacts"

        // android.provider.ContactsPickerSessionContract, API 37 (Android 17).
        private const val API_CONTACT_PICKER = 37
        private const val ACTION_PICK_CONTACTS = "android.provider.action.PICK_CONTACTS"
        private const val EXTRA_REQUESTED_DATA_FIELDS = "android.provider.extra.PICK_CONTACTS_REQUESTED_DATA_FIELDS"
        private const val EXTRA_SELECTION_LIMIT = "android.provider.extra.PICK_CONTACTS_SELECTION_LIMIT"
        /** The picker's own maximum. */
        private const val SELECTION_LIMIT = 100
    }
}

/**
 * The fragment a screen of the Contacts app is started from (the activity result contract needs
 * one). The callback is the CLASS's, not the instance's: the activity made again under a screen (a
 * turn of the device) brings a new instance, and the result still finds who waits for it.
 */
class ContactsFragment : Fragment() {

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
        const val TAG = "LecodesContactsFragment"
        private var pending: ((Int, Intent?) -> Unit)? = null
    }
}
