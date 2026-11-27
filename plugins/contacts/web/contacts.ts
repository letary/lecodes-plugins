// contacts on the web: the browser's Contact Picker (navigator.contacts.select — Chrome on Android).
// pick() only: a browser has no address book a page may read, no editor, no card — access() says
// "denied" and the other calls reject "unavailable". Where the browser has no picker the half does
// not register at all, and `Contacts.supported` is false.
//
// The picker hands over values without their labels and without an id: a picked contact's id is "",
// its name parts are null (the browser gives one display name), it has no photo. It needs a user
// gesture and a top-level page; a refusal of either is "failed".
//
// The channel is the contract's (../contract.d.ts): contacts.gen.ts is generated from it, this
// file implements its ContactsPlugin.

import {
  ContactsError, registerContacts,
  type Contact, type ContactAddress, type ContactPickOptions, type ContactsPlugin, type PluginHost,
} from "./contacts.gen"

/** The Contact Picker API, as far as the half reads it (not in TypeScript's DOM library). */
type PickerProperty = "name" | "tel" | "email" | "address" | "icon"
type PickedAddress = { addressLine?: string[], city?: string, region?: string, postalCode?: string, country?: string }
type PickedContact = { name?: string[], tel?: string[], email?: string[], address?: PickedAddress[] }
type ContactsManager = {
  select(properties: PickerProperty[], options?: { multiple?: boolean }): Promise<PickedContact[]>
  getProperties?(): Promise<PickerProperty[]>
}

const text = (s: string | undefined): string | undefined => {
  const t = s?.trim()
  return t ? t : undefined
}

const address = (a: PickedAddress): ContactAddress => {
  const out: ContactAddress = {}
  const street = text(a.addressLine?.join(", "))
  if (street) out.street = street
  const city = text(a.city); if (city) out.city = city
  const region = text(a.region); if (region) out.region = region
  const postalCode = text(a.postalCode); if (postalCode) out.postalCode = postalCode
  const country = text(a.country); if (country) out.country = country
  return out
}

export const register = (host: PluginHost): void => {
  const manager = typeof navigator === "undefined" ? undefined : (navigator as { contacts?: ContactsManager }).contacts
  if (!manager || typeof manager.select !== "function") return

  registerContacts(host, (): ContactsPlugin => {
    let picking = false
    const unavailable = (): never => { throw new ContactsError("unavailable") }

    return {
      access: () => "denied",
      manageAccess: () => {},

      async pick(options?: ContactPickOptions): Promise<Contact[]> {
        if (picking) throw new ContactsError("busy")
        const fields = new Set(options?.fields ?? [])
        // What this browser's picker can hand over; one that does not say is asked for the common three.
        const has = new Set<PickerProperty>(await manager.getProperties?.().catch(() => undefined) ?? ["name", "tel", "email"])
        const properties: PickerProperty[] = ["name"]
        if (fields.has("phones") && has.has("tel")) properties.push("tel")
        if (fields.has("emails") && has.has("email")) properties.push("email")
        if (fields.has("addresses") && has.has("address")) properties.push("address")

        picking = true
        let picked: PickedContact[]
        try {
          picked = await manager.select(properties, { multiple: options?.multiple === true })
        } catch {
          // No user gesture, not a top-level page, the picker already up.
          throw new ContactsError("failed")
        } finally {
          picking = false
        }

        return picked.map((p): Contact => {
          const contact: Contact = {
            id: "", name: text(p.name?.[0]) ?? "",
            givenName: null, familyName: null, middleName: null, nickname: null, hasPhoto: false,
          }
          // A field asked is present, empty where the browser cannot hand it over.
          if (fields.has("phones")) contact.phones = (p.tel ?? []).flatMap(n => text(n) ? [{ number: n.trim() }] : [])
          if (fields.has("emails")) contact.emails = (p.email ?? []).flatMap(a => text(a) ? [{ address: a.trim() }] : [])
          if (fields.has("addresses")) contact.addresses = (p.address ?? []).map(address).filter(a => Object.keys(a).length > 0)
          if (fields.has("urls")) contact.urls = []
          return contact
        })
      },

      list: unavailable,
      get: unavailable,
      photo: unavailable,
      add: unavailable,
      show: unavailable,
      changedObserved: () => {},
    }
  })
}
