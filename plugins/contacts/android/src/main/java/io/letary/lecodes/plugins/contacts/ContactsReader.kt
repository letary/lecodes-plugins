//
//  ContactsReader.kt — lecodes-plugins/contacts
//
//  The reads of the contacts provider (ContactsContract), all of them blocking: the service runs
//  them off the main thread. Three sources hand over the same rows — the provider's Data table
//  (list / get, behind READ_CONTACTS), the one row or contact a legacy picker granted, the session
//  of Android 17's picker — so one builder takes a contact's rows from any of them.
//
//  A contact's id is its LOOKUP KEY: the provider's handle that survives a re-aggregation and a
//  sync (the row id does not).
//
//  A contact joined from several accounts carries a number or an address once per account: the
//  duplicates are dropped here.
//

package io.letary.lecodes.plugins.contacts

import android.content.ContentUris
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.provider.ContactsContract.CommonDataKinds.Email
import android.provider.ContactsContract.CommonDataKinds.Event
import android.provider.ContactsContract.CommonDataKinds.Nickname
import android.provider.ContactsContract.CommonDataKinds.Organization
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.ContactsContract.CommonDataKinds.StructuredName
import android.provider.ContactsContract.CommonDataKinds.StructuredPostal
import android.provider.ContactsContract.CommonDataKinds.Website
import android.provider.ContactsContract.Contacts
import android.provider.ContactsContract.Data

/** The Data columns the rows are read by: `d[n]` is DATAn (index 0 is unused). */
private val DATA = arrayOf(
    Data.DATA1, Data.DATA2, Data.DATA3, Data.DATA4, Data.DATA5,
    Data.DATA6, Data.DATA7, Data.DATA8, Data.DATA9, Data.DATA10,
)

private fun String?.clean(): String? = this?.trim()?.takeIf { it.isNotEmpty() }

/** One contact being put together from its rows. */
internal class ContactBuilder(private val id: String, private val name: String, private val hasPhoto: Boolean) {
    private var given: String? = null
    private var family: String? = null
    private var middle: String? = null
    private var nickname: String? = null
    private val phones = ArrayList<ContactPhone>()
    private val emails = ArrayList<ContactEmail>()
    private val addresses = ArrayList<ContactAddress>()
    private val urls = ArrayList<ContactUrl>()
    private var organization: ContactOrganization? = null
    private var birthday: ContactBirthday? = null

    /** One Data row: its MIME type and DATA1..DATA10 (`d[1]`..`d[10]`). */
    fun row(mime: String?, d: Array<String?>) {
        when (mime) {
            StructuredName.CONTENT_ITEM_TYPE -> if (given == null && family == null && middle == null) {
                given = d[2].clean(); family = d[3].clean(); middle = d[5].clean()
            }
            Nickname.CONTENT_ITEM_TYPE -> if (nickname == null) nickname = d[1].clean()
            Phone.CONTENT_ITEM_TYPE -> d[1].clean()?.let { number ->
                if (phones.none { it.number == number }) phones.add(ContactPhone(label = phoneLabel(d[2], d[3]), number = number))
            }
            Email.CONTENT_ITEM_TYPE -> d[1].clean()?.let { address ->
                if (emails.none { it.address.equals(address, ignoreCase = true) }) emails.add(ContactEmail(label = emailLabel(d[2], d[3]), address = address))
            }
            StructuredPostal.CONTENT_ITEM_TYPE -> {
                val address = ContactAddress(
                    label = postalLabel(d[2], d[3]),
                    street = d[4].clean(), city = d[7].clean(), region = d[8].clean(),
                    postalCode = d[9].clean(), country = d[10].clean(),
                )
                val empty = address.street == null && address.city == null && address.region == null &&
                    address.postalCode == null && address.country == null
                if (!empty && addresses.none { it.copy(label = null) == address.copy(label = null) }) addresses.add(address)
            }
            Website.CONTENT_ITEM_TYPE -> d[1].clean()?.let { url ->
                if (urls.none { it.url == url }) urls.add(ContactUrl(label = urlLabel(d[2], d[3]), url = url))
            }
            Organization.CONTENT_ITEM_TYPE -> if (organization == null) {
                val company = d[1].clean()
                val title = d[4].clean()
                if (company != null || title != null) organization = ContactOrganization(company = company, title = title)
            }
            Event.CONTENT_ITEM_TYPE -> if (birthday == null && d[2] == Event.TYPE_BIRTHDAY.toString()) birthday = parseBirthday(d[1])
        }
    }

    /** The contact with the fields asked: a list asked is present (empty when there is none). */
    fun build(fields: Set<ContactField>) = Contact(
        id = id, name = name,
        givenName = given, familyName = family, middleName = middle, nickname = nickname,
        hasPhoto = hasPhoto,
        phones = if (ContactField.PHONES in fields) phones else null,
        emails = if (ContactField.EMAILS in fields) emails else null,
        addresses = if (ContactField.ADDRESSES in fields) addresses else null,
        urls = if (ContactField.URLS in fields) urls else null,
        organization = if (ContactField.ORGANIZATION in fields) organization else null,
        birthday = if (ContactField.BIRTHDAY in fields) birthday else null,
    )

    private companion object {
        fun custom(label: String?) = label.clean()

        // The contract's labels for the kinds an address book commonly has; the provider's other
        // kinds (a fax, a pager, an assistant) have no label here.
        fun phoneLabel(type: String?, label: String?): String? = when (type?.toIntOrNull()) {
            Phone.TYPE_CUSTOM -> custom(label)
            Phone.TYPE_MOBILE, Phone.TYPE_WORK_MOBILE -> "mobile"
            Phone.TYPE_HOME -> "home"
            Phone.TYPE_WORK, Phone.TYPE_COMPANY_MAIN -> "work"
            Phone.TYPE_MAIN -> "main"
            Phone.TYPE_OTHER -> "other"
            else -> null
        }

        fun emailLabel(type: String?, label: String?): String? = when (type?.toIntOrNull()) {
            Email.TYPE_CUSTOM -> custom(label)
            Email.TYPE_HOME -> "home"
            Email.TYPE_WORK -> "work"
            Email.TYPE_MOBILE -> "mobile"
            Email.TYPE_OTHER -> "other"
            else -> null
        }

        fun postalLabel(type: String?, label: String?): String? = when (type?.toIntOrNull()) {
            StructuredPostal.TYPE_CUSTOM -> custom(label)
            StructuredPostal.TYPE_HOME -> "home"
            StructuredPostal.TYPE_WORK -> "work"
            StructuredPostal.TYPE_OTHER -> "other"
            else -> null
        }

        fun urlLabel(type: String?, label: String?): String? = when (type?.toIntOrNull()) {
            Website.TYPE_CUSTOM -> custom(label)
            Website.TYPE_HOMEPAGE -> "homepage"
            Website.TYPE_HOME -> "home"
            Website.TYPE_WORK -> "work"
            Website.TYPE_OTHER -> "other"
            else -> null
        }

        /** "1990-05-17", "--05-17" (no year), "19900517". */
        private val DATE = Regex("""^(\d{4}|-)-?(\d{2})-?(\d{2})""")

        fun parseBirthday(text: String?): ContactBirthday? {
            val m = DATE.find(text?.trim() ?: return null) ?: return null
            val month = m.groupValues[2].toInt()
            val day = m.groupValues[3].toInt()
            if (month !in 1..12 || day !in 1..31) return null
            return ContactBirthday(year = m.groupValues[1].toIntOrNull(), month = month, day = day)
        }
    }
}

internal class ContactsReader(context: Context) {
    private val resolver = context.contentResolver

    /** The MIME types of the rows a read takes: the name parts always, then the fields asked. */
    fun mimes(fields: Set<ContactField>, nickname: Boolean = true): ArrayList<String> {
        val out = arrayListOf(StructuredName.CONTENT_ITEM_TYPE)
        if (nickname) out.add(Nickname.CONTENT_ITEM_TYPE)
        for (field in fields) out.add(when (field) {
            ContactField.PHONES -> Phone.CONTENT_ITEM_TYPE
            ContactField.EMAILS -> Email.CONTENT_ITEM_TYPE
            ContactField.ADDRESSES -> StructuredPostal.CONTENT_ITEM_TYPE
            ContactField.URLS -> Website.CONTENT_ITEM_TYPE
            ContactField.ORGANIZATION -> Organization.CONTENT_ITEM_TYPE
            ContactField.BIRTHDAY -> Event.CONTENT_ITEM_TYPE
        })
        return out
    }

    private fun data(c: Cursor, first: Int): Array<String?> =
        Array(DATA.size + 1) { i -> if (i == 0) null else runCatching { c.getString(first + i - 1) }.getOrNull() }

    // ── the address book (READ_CONTACTS) ─────────────────────────────────────

    private val contactColumns = arrayOf(Contacts._ID, Contacts.LOOKUP_KEY, Contacts.DISPLAY_NAME_PRIMARY, Contacts.PHOTO_THUMBNAIL_URI)

    private fun contacts(uri: Uri, sorted: Boolean): LinkedHashMap<Long, ContactBuilder> {
        val out = LinkedHashMap<Long, ContactBuilder>()
        resolver.query(uri, contactColumns, null, null, if (sorted) Contacts.SORT_KEY_PRIMARY else null)?.use { c ->
            while (c.moveToNext()) {
                val key = c.getString(1) ?: continue
                out[c.getLong(0)] = ContactBuilder(key, c.getString(2) ?: "", c.getString(3) != null)
            }
        }
        return out
    }

    /** The Data rows of `builders`' contacts — of the ids in `only`, or of the whole table. */
    private fun fill(builders: Map<Long, ContactBuilder>, fields: Set<ContactField>, only: Collection<Long>?) {
        if (builders.isEmpty()) return
        val mimes = mimes(fields)
        val projection = arrayOf(Data.CONTACT_ID, Data.MIMETYPE, *DATA)
        val ofMimes = "${Data.MIMETYPE} IN (${mimes.joinToString(",") { "?" }})"
        val run = { selection: String ->
            resolver.query(Data.CONTENT_URI, projection, selection, mimes.toTypedArray(), null)?.use { c ->
                while (c.moveToNext()) builders[c.getLong(0)]?.row(c.getString(1), data(c, 2))
            }
        }
        if (only == null) run(ofMimes)
        // In chunks: SQLite bounds the length of a statement.
        else only.chunked(400).forEach { ids -> run("$ofMimes AND ${Data.CONTACT_ID} IN (${ids.joinToString(",")})") }
    }

    /** The address book by name; with `query`, the contacts the provider's own filter matches. */
    fun list(fields: Set<ContactField>, query: String?): List<Contact> {
        val text = query.clean()
        val uri = if (text == null) Contacts.CONTENT_URI else Uri.withAppendedPath(Contacts.CONTENT_FILTER_URI, Uri.encode(text))
        val builders = contacts(uri, sorted = true)
        fill(builders, fields, if (text == null) null else builders.keys)
        return builders.values.map { it.build(fields) }
    }

    /** The provider's row of a lookup key, null when no contact answers to it. */
    private fun rowUri(id: String): Uri? {
        if (id.isBlank()) return null
        return runCatching { Contacts.lookupContact(resolver, Uri.withAppendedPath(Contacts.CONTENT_LOOKUP_URI, id)) }.getOrNull()
    }

    fun get(id: String, fields: Set<ContactField>): Contact? {
        val builders = contacts(rowUri(id) ?: return null, sorted = false)
        fill(builders, fields, builders.keys)
        return builders.values.firstOrNull()?.build(fields)
    }

    /** The contact's picture as stored, null when it has none. */
    fun photo(id: String, full: Boolean): ByteArray? {
        val uri = rowUri(id) ?: return null
        return Contacts.openContactPhotoInputStream(resolver, uri, full)?.use { it.readBytes() }?.takeIf { it.isNotEmpty() }
    }

    /** What the Contacts app opens the card of, null when there is no such contact. */
    fun cardUri(id: String): Uri? {
        val row = rowUri(id) ?: return null
        return Contacts.getLookupUri(ContentUris.parseId(row), id)
    }

    // ── what a picker handed over ────────────────────────────────────────────

    /** The contact a legacy picker of CONTACTS returned: its name by the result's own grant, and its
     *  rows when the app may read the address book. */
    fun pickedContact(uri: Uri, fields: Set<ContactField>, mayRead: Boolean): Contact? {
        val builders = contacts(uri, sorted = false)
        if (mayRead) fill(builders, fields, builders.keys)
        return builders.values.firstOrNull()?.build(fields)
    }

    /** The one row (a number, an email, an address) a legacy picker of DATA returned, as its contact. */
    fun pickedRow(uri: Uri, fields: Set<ContactField>): Contact? {
        val projection = arrayOf(Data.LOOKUP_KEY, Data.DISPLAY_NAME_PRIMARY, Data.PHOTO_THUMBNAIL_URI, Data.MIMETYPE, *DATA)
        resolver.query(uri, projection, null, null, null)?.use { c ->
            if (!c.moveToFirst()) return null
            val builder = ContactBuilder(c.getString(0) ?: "", c.getString(1) ?: "", c.getString(2) != null)
            builder.row(c.getString(3), data(c, 4))
            return builder.build(fields)
        }
        return null
    }

    /** The session of Android 17's picker: Data rows of the contacts chosen, in the picker's order.
     *  No selection may be passed to it, and it says nothing of a picture. */
    fun pickedSession(uri: Uri, fields: Set<ContactField>): List<Contact> {
        val builders = LinkedHashMap<String, ContactBuilder>()
        val projection = arrayOf(Data.LOOKUP_KEY, Data.DISPLAY_NAME_PRIMARY, Data.MIMETYPE, *DATA)
        resolver.query(uri, projection, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val key = c.getString(0)
                val name = c.getString(1) ?: ""
                val builder = builders.getOrPut(key ?: "name:$name") { ContactBuilder(key ?: "", name, false) }
                builder.row(c.getString(2), data(c, 3))
            }
        }
        return builders.values.map { it.build(fields) }
    }
}
