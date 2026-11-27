// contacts — the person's address book. iOS: the Contacts framework and ContactsUI. Android: the
// contacts provider (ContactsContract) and the Contacts app's own screens.
//
// Three ways in, and only one of them asks a permission:
//   - pick(): the SYSTEM's picker. The person chooses, the app gets what was chosen and nothing
//     else — no permission, no dialog of ours. What most apps need ("invite a friend").
//   - list() / get() / photo() / show(): READING the address book, behind the `contacts` permission
//     (`@permission contacts`: the host asks before the first call, the halves never do).
//   - add() / show(): WRITING is the system's — its "new contact" editor, its contact card (where a
//     contact is edited and deleted). The plugin writes nothing itself and declares no write
//     permission (no WRITE_CONTACTS on Android).
//
// iOS 18 lets the person give an app SOME contacts: access() says "limited", list() answers with
// those, manageAccess() shows the system's sheet that changes the choice.
//
// A contact's name parts always come; everything else is asked for by `fields` (a big address book
// is cheap to list by name) and is ABSENT from a contact when not asked. Phone numbers come as the
// person typed them, not normalized. Notes are not part of the contract (iOS: Apple's entitlement).
//
// The web half is the browser's Contact Picker (Chrome on Android): pick() only — a browser has no
// address book to read; every other call rejects `unavailable` there and access() says "denied".

import type { Service, File, i32 } from "lecodes-sdk/plugin"

/** What a contact carries beyond its name, when asked. */
export type ContactField = "phones" | "emails" | "addresses" | "organization" | "birthday" | "urls"

/** "prompt": never asked — the first list() asks. "limited": iOS 18, the person chose some contacts.
 *  "denied": refused, or the host has no address book to read (the web). */
export type ContactsAccess = "granted" | "limited" | "denied" | "prompt"

export type ContactPhotoSize = "thumbnail" | "full"

export interface ContactPhone {
  /** "mobile", "home", "work", "main", "other", or the person's own label; absent: none. */
  label?: string
  /** As typed: "+1 (555) 010-9999", "8 800 555 35 35". */
  number: string
}

export interface ContactEmail {
  /** "home", "work", "other", or the person's own label; absent: none. */
  label?: string
  address: string
}

export interface ContactAddress {
  /** "home", "work", "other", or the person's own label; absent: none. */
  label?: string
  street?: string
  city?: string
  /** The state, the province. */
  region?: string
  postalCode?: string
  country?: string
}

export interface ContactUrl {
  /** "homepage", "home", "work", "other", or the person's own label; absent: none. */
  label?: string
  url: string
}

export interface ContactOrganization {
  company?: string
  /** The job title. */
  title?: string
}

export interface ContactBirthday {
  /** Absent when the person gave a day without a year. */
  year?: i32
  /** 1..12. */
  month: i32
  /** 1..31. */
  day: i32
}

export interface Contact {
  /** The contact's id on THIS device (iOS: the contact's identifier, Android: its lookup key) —
   *  what get(), photo() and show() take. Not the same on another device. "" on the web: the
   *  browser's picker hands over no id. */
  id: string
  /** The name as the device shows it; "" for a contact without one. */
  name: string
  givenName: string | null
  familyName: string | null
  middleName: string | null
  nickname: string | null
  /** photo() has a picture to give. */
  hasPhoto: boolean
  /** The lists below are present when asked for (`fields`) — empty when the contact has none —
   *  and absent otherwise. */
  phones?: ContactPhone[]
  emails?: ContactEmail[]
  addresses?: ContactAddress[]
  urls?: ContactUrl[]
  /** Absent: not asked for, or the contact has none. */
  organization?: ContactOrganization
  /** Absent: not asked for, or the contact has none. */
  birthday?: ContactBirthday
}

/** What the system's "new contact" editor opens with: the person may change any of it. */
export interface ContactDraft {
  givenName?: string
  familyName?: string
  middleName?: string
  nickname?: string
  phones?: ContactPhone[]
  emails?: ContactEmail[]
  addresses?: ContactAddress[]
  urls?: ContactUrl[]
  organization?: ContactOrganization
  birthday?: ContactBirthday
}

export interface ContactPickOptions {
  /** What the picked contacts carry beyond their names. Default: nothing. */
  fields?: ContactField[]
  /** Let the person choose several. Default false. */
  multiple?: boolean
}

export interface ContactListOptions {
  /** What the contacts carry beyond their names. Default: nothing. */
  fields?: ContactField[]
  /** Only the contacts whose NAME matches this text (the platform's own name search). */
  query?: string
}

export interface ContactsParams {}

export interface ContactsEvents {
  /** The address book changed (a contact added, edited, deleted — by anyone; iOS: also the person
   *  changing which contacts the app may read). No payload: list() again. Sent while the app listens
   *  and may read the address book.
   *  @lazy */
  changed: void
}

export interface Contacts extends Service<"contacts", ContactsParams, ContactsEvents> {
  /** Whether the app may read the address book. Never prompts. */
  access(): Promise<ContactsAccess>
  /** iOS 18+, while access is "limited": the system's sheet where the person changes which contacts
   *  the app may read; resolves when it closes. Resolves at once everywhere else.
   *  @rejects busy */
  manageAccess(): Promise<void>

  /** The system's picker. No permission. Resolves with what the person chose — an empty list when
   *  they chose nothing (cancelled).
   *  Android before 17 has a picker of ONE contact that hands over one kind of data: with several
   *  `fields` asked and no `contacts` permission granted, the picked contact carries the first of
   *  phones / emails / addresses asked (the one number, address the person tapped) and the other
   *  fields empty; with the permission granted it carries every field asked.
   *  `busy`: a screen of this plugin is up. `unavailable`: the device has no picker. `failed`: it
   *  could not be shown (the app is in the background).
   *  @rejects busy unavailable failed */
  pick(options?: ContactPickOptions): Promise<Contact[]>

  /** The address book, sorted by name. With iOS's limited access: the contacts the person chose.
   *  `unavailable`: the host has no address book to read (the web).
   *  @permission contacts
   *  @rejects unavailable failed */
  list(options?: ContactListOptions): Promise<Contact[]>
  /** One contact by its id; null when there is none (deleted, or not among the ones the app may read).
   *  @permission contacts
   *  @rejects unavailable failed */
  get(id: string, fields?: ContactField[]): Promise<Contact | null>
  /** A contact's picture (JPEG or PNG, as stored); null when it has none. "thumbnail" (the default)
   *  is the small one a list shows.
   *  @permission contacts
   *  @rejects unavailable failed */
  photo(id: string, size?: ContactPhotoSize): Promise<File | null>

  /** The system's "new contact" editor, opened with `draft`. Resolves with true when the person
   *  saved the contact, false when they left without saving. No permission of the plugin's.
   *  `unavailable`: the device has no contacts app.
   *  @rejects busy unavailable failed */
  add(draft: ContactDraft): Promise<boolean>
  /** The system's card of a contact: where the person sees it, edits it, deletes it. Resolves when
   *  the card closes (`changed` says whether anything was written).
   *  `notFound`: no such contact.
   *  @permission contacts
   *  @rejects busy notFound unavailable failed */
  show(id: string): Promise<void>
}
