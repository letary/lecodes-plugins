// Contacts — the person's address book: the system's picker, reading behind the `contacts`
// permission, adding and editing through the system's own screens.
//
// Hand-written over the generated wire (contacts.gen.ts) for what a host WITHOUT the service
// answers — the desktop, the headless renderer, a browser without the Contact Picker, a shell built
// without the plugin: `supported` is false, limited() resolves false and manageLimitedAccess()
// does nothing (there is no selection to speak of), every other call rejects "unavailable" — the
// code the web half already answers for the calls a browser cannot serve — before the host is
// touched. And for `onChange`, the listener API over the wire's `changed` event.
//
// The METHODS THAT OPEN A SYSTEM SCREEN say so: pick() is the picker, openEditor() the "new
// contact" editor, openCard() a contact's card. None of them writes for the person.
//
// The permission is the host's (`permissions.query("contacts")` / `request`): it asks at the first
// list() / get() / photo() / openCard(), and a refusal is the rejection "denied". pick() and
// openEditor() never ask one.

import { ContactsBase, supports } from "./contacts.gen"
import type {
  Contact, ContactAddress, ContactBirthday, ContactDraft, ContactEmail, ContactField, ContactListOptions,
  ContactOrganization, ContactPhone, ContactPhotoSize, ContactPickOptions, ContactUrl,
} from "../contract"
import type { File } from "lecodes-sdk/plugin"

export type {
  Contact, ContactAddress, ContactBirthday, ContactDraft, ContactEmail, ContactField, ContactListOptions,
  ContactOrganization, ContactPhone, ContactPhotoSize, ContactPickOptions, ContactUrl,
}

/**
 * The person's address book. `Contacts.supported` reports whether this host registered the service:
 * a native shell with the plugin, or a browser with the Contact Picker (Chrome on Android) — where
 * only `pick()` works.
 */
// PURE IIFE so an app that never names Contacts carries none of the plugin.
export const Contacts: {
  /** Whether this host registered the "contacts" service. */
  readonly supported: boolean
  /** The system's contact picker — no permission. Resolves with the contacts the person chose, an
   *  empty list when they chose none. `fields` says what they carry beyond their names;
   *  `multiple` lets the person choose several (Android before 17: always one, and without the
   *  contacts permission it carries only the first of phones / emails / addresses asked).
   *  Rejects "unavailable" (no picker — also on a host without the service), "busy" (a screen of
   *  Contacts is up), "failed". */
  pick(options?: ContactPickOptions): Promise<Contact[]>
  /** The address book, sorted by name; `query` keeps the contacts whose name matches. Asks the
   *  contacts permission the first time. Rejects "denied", "unavailable" (the web, a host without
   *  the service), "failed". */
  list(options?: ContactListOptions): Promise<Contact[]>
  /** One contact by its id, null when there is none. Rejects as list(). */
  get(id: string, fields?: ContactField[]): Promise<Contact | null>
  /** A contact's picture — "thumbnail" (the default) or "full" — null when it has none. A File: an
   *  image's source, an upload. Rejects as list(). */
  photo(id: string, size?: ContactPhotoSize): Promise<File | null>
  /** OPEN the system's "new contact" editor, filled from `draft`; the person saves, or not. true
   *  when they saved the contact. Nothing is written without them, and no permission is asked.
   *  Rejects "unavailable", "busy", "failed". */
  openEditor(draft: ContactDraft): Promise<boolean>
  /** OPEN the system's card of a contact — where the person edits or deletes it. Resolves when it
   *  closes. Rejects "notFound", and as list(). */
  openCard(id: string): Promise<void>
  /** iOS 18+: whether the person gave the app SOME contacts, not the address book. The permission
   *  reads "granted" then, and list() answers with the ones chosen. false everywhere else, and on a
   *  host without the service. Never prompts. */
  limited(): Promise<boolean>
  /** iOS 18+, while limited() is true: the system's sheet where the person changes which contacts
   *  the app may read; resolves when it closes. Resolves at once everywhere else. */
  manageLimitedAccess(): Promise<void>
  /** Listen to changes of the address book (by anyone). No payload: list() again. Returns a
   *  function that stops listening. Heard from the app's first call on, while it may read the
   *  address book; never called on a host without the service. */
  onChange(listener: () => void): () => void
} = /*#__PURE__*/ (() => {
  let client: ContactsBase | null = null
  const service = (): ContactsBase => client ??= new ContactsBase()

  /** The host's own rejection for a call it cannot serve — same shape as a half's. */
  const assertSupported = (): void => {
    if (!supports()) throw new Error("unavailable")
  }

  const contacts = {
    async pick(options?: ContactPickOptions): Promise<Contact[]> {
      assertSupported()
      return await service().pick({ fields: options?.fields ?? [], multiple: options?.multiple === true })
    },

    async list(options?: ContactListOptions): Promise<Contact[]> {
      assertSupported()
      const query = options?.query?.trim()
      return await service().list({ fields: options?.fields ?? [], ...(query ? { query } : {}) })
    },

    async get(id: string, fields?: ContactField[]): Promise<Contact | null> {
      if (typeof id !== "string") throw new Error("Contacts.get: `id` is a contact's id")
      assertSupported()
      if (id === "") return null   // the web picker's contacts have none
      return await service().get(id, fields ?? [])
    },

    async photo(id: string, size?: ContactPhotoSize): Promise<File | null> {
      if (typeof id !== "string") throw new Error("Contacts.photo: `id` is a contact's id")
      assertSupported()
      if (id === "") return null
      return await service().photo(id, size ?? "thumbnail")
    },

    async openEditor(draft: ContactDraft): Promise<boolean> {
      if (typeof draft !== "object" || draft === null) throw new Error("Contacts.openEditor: a draft is required — {} opens an empty editor")
      assertSupported()
      return await service().openEditor(draft)
    },

    async openCard(id: string): Promise<void> {
      if (typeof id !== "string") throw new Error("Contacts.openCard: `id` is a contact's id")
      assertSupported()
      if (id === "") throw new Error("notFound")
      await service().openCard(id)
    },

    async limited(): Promise<boolean> {
      if (!supports()) return false
      return await service().limited()
    },

    async manageLimitedAccess(): Promise<void> {
      if (!supports()) return
      await service().manageLimitedAccess()
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
  Object.defineProperty(contacts, "supported", { get: (): boolean => supports() })
  return contacts as any
})()
