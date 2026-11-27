//
//  ContactsService.swift — lecodes-plugins/contacts
//
//  One session of the "contacts" service over the Contacts framework and ContactsUI. The channel
//  (the calls, Contact, the codes) is Contacts.gen.swift, generated from contract.d.ts; the glue
//  asks the `contacts` permission before list / get / photo / show.
//
//  READING (CNContactStore) runs on a queue of the session's own; a reply is settled from there.
//
//  The SCREENS are the system's, presented over the app's top controller, one at a time — a call
//  while one is up rejects "busy":
//    - pick: CNContactPickerViewController. It runs out of the app's process and hands over the
//      contacts chosen, whole: no permission.
//    - add: CNContactViewController(forNewContact:), filled from the draft. The person saves.
//    - show: CNContactViewController(for:), where the contact is edited and deleted.
//    - manageAccess: iOS 18's contact access picker (SwiftUI's `contactAccessPicker`), hosted in a
//      clear controller.
//
//  A CNContact answers only for the keys it was fetched with — reading another RAISES — so every
//  read here asks `isKeyAvailable` first.
//

import Contacts
import ContactsUI
import Foundation
import LeCodes
import SwiftUI
import UIKit

public final class ContactsService: ContactsPlugin {

    private let events: ContactsEvents
    private let queue = DispatchQueue(label: "io.letary.lecodes.contacts")
    /// Kept for the session: the store's change notification is posted while a store is alive.
    private let store = CNContactStore()

    /// The screen that is up (main thread).
    private var screen: Screen?
    private var changeObserver: NSObjectProtocol?
    private var changePending = false

    public init(_ events: ContactsEvents) {
        self.events = events
    }

    // MARK: - Access

    public func access(_ reply: Reply<ContactsAccess, ContactsCode>) {
        reply.resolve(ContactsAuthorization.access)
    }

    public func manageAccess(_ reply: Reply<Void, ContactsCode>) {
        onMain { [self] in
            guard #available(iOS 18.0, *), ContactsAuthorization.access == .limited else { return reply.resolve(()) }
            guard self.screen == nil else { return reply.reject(.busy) }
            let screen = Screen { reply.resolve(()) }
            let host = UIHostingController(rootView: AccessPickerHost { [weak self] in
                // The store posts no change when the person changes the app's contacts here (seen
                // on iOS 18.6): the sheet closing is that change — a listening app lists again.
                self?.finish(screen, animated: false) {
                    self?.announceChange()
                    reply.resolve(())
                }
            })
            host.view.backgroundColor = .clear
            host.modalPresentationStyle = .overFullScreen
            if !self.present(host, as: screen, animated: false) { reply.resolve(()) }
        }
    }

    // MARK: - Reading

    public func list(_ options: ContactListOptions?, _ reply: Reply<[Contact], ContactsCode>) {
        let fields = Set(options?.fields ?? [])
        let query = options?.query?.trimmingCharacters(in: .whitespacesAndNewlines)
        queue.async { [store] in
            do {
                let keys = Self.keys(fields)
                var found: [CNContact] = []
                if let query, !query.isEmpty {
                    found = try store.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: query), keysToFetch: keys)
                    let order = CNContact.comparator(forNameSortOrder: .userDefault)
                    found.sort { order($0, $1) == .orderedAscending }
                } else {
                    let request = CNContactFetchRequest(keysToFetch: keys)
                    request.sortOrder = .userDefault
                    try store.enumerateContacts(with: request) { contact, _ in found.append(contact) }
                }
                reply.resolve(found.map { Self.contact($0, fields) })
            } catch {
                reply.reject(Self.code(error))
            }
        }
    }

    public func get(_ id: String, _ fields: [ContactField]?, _ reply: Reply<Contact?, ContactsCode>) {
        let fields = Set(fields ?? [])
        queue.async { [store] in
            do {
                reply.resolve(Self.contact(try store.unifiedContact(withIdentifier: id, keysToFetch: Self.keys(fields)), fields))
            } catch {
                if Self.isMissing(error) { reply.resolve(nil) } else { reply.reject(Self.code(error)) }
            }
        }
    }

    public func photo(_ id: String, _ size: ContactPhotoSize?, _ reply: Reply<PluginFile?, ContactsCode>) {
        let full = size == .full
        queue.async { [store] in
            do {
                let key = full ? CNContactImageDataKey : CNContactThumbnailImageDataKey
                let contact = try store.unifiedContact(withIdentifier: id, keysToFetch: [key as CNKeyDescriptor])
                guard let data = full ? contact.imageData : contact.thumbnailImageData, !data.isEmpty else { return reply.resolve(nil) }
                let png = data.starts(with: [0x89, 0x50, 0x4E, 0x47])
                reply.resolve(PluginFile(data: data, name: png ? "photo.png" : "photo.jpg"))
            } catch {
                if Self.isMissing(error) { reply.resolve(nil) } else { reply.reject(Self.code(error)) }
            }
        }
    }

    // MARK: - The picker

    public func pick(_ options: ContactPickOptions?, _ reply: Reply<[Contact], ContactsCode>) {
        let fields = Set(options?.fields ?? [])
        let multiple = options?.multiple == true
        onMain { [self] in
            guard self.screen == nil else { return reply.reject(.busy) }
            let screen = Screen { reply.resolve([]) }
            // The picker closes itself once the person chose or cancelled.
            let done: ([CNContact]) -> Void = { [weak self] picked in
                self?.finish(screen, dismiss: false) { reply.resolve(picked.map { Self.contact($0, fields) }) }
            }
            // Which delegate method exists is what makes the picker single or multiple.
            let delegate: NSObject & CNContactPickerDelegate = multiple ? PickMany(done) : PickOne(done)
            let picker = CNContactPickerViewController()
            picker.delegate = delegate
            screen.keep = delegate
            if !self.present(picker, as: screen) { reply.reject(.failed) }
        }
    }

    // MARK: - The system's editor and card

    public func add(_ draft: ContactDraft, _ reply: Reply<Bool, ContactsCode>) {
        onMain { [self] in
            guard self.screen == nil else { return reply.reject(.busy) }
            let screen = Screen { reply.resolve(false) }
            let editor = CNContactViewController(forNewContact: Self.newContact(draft))
            let card = CardDelegate { [weak self] saved in
                self?.finish(screen) { reply.resolve(saved) }
            }
            editor.delegate = card
            screen.keep = card
            let nav = UINavigationController(rootViewController: editor)
            // No swipe away: the editor ends by its own Cancel or Done, which is what answers the call.
            nav.isModalInPresentation = true
            if !self.present(nav, as: screen) { reply.reject(.failed) }
        }
    }

    public func show(_ id: String, _ reply: Reply<Void, ContactsCode>) {
        onMain { [self] in
            guard self.screen == nil else { return reply.reject(.busy) }
            let contact: CNContact
            do {
                contact = try self.store.unifiedContact(withIdentifier: id, keysToFetch: [CNContactViewController.descriptorForRequiredKeys()])
            } catch {
                return reply.reject(Self.isMissing(error) ? .notFound : Self.code(error))
            }
            let screen = Screen { reply.resolve(()) }
            let viewer = CNContactViewController(for: contact)
            viewer.contactStore = self.store
            viewer.allowsEditing = true
            let card = CardDelegate { [weak self] _ in
                self?.finish(screen) { reply.resolve(()) }
            }
            viewer.delegate = card
            viewer.navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .close, target: card, action: #selector(CardDelegate.close))
            screen.keep = card
            let nav = UINavigationController(rootViewController: viewer)
            nav.presentationController?.delegate = card   // swiped away: the card closed
            if !self.present(nav, as: screen) { reply.reject(.failed) }
        }
    }

    // MARK: - Presenting (main thread)

    /// A screen that is up: what settles its call when the session closes under it, and what must
    /// live as long as it does (a delegate is held weakly by its controller).
    private final class Screen {
        let abandon: () -> Void
        var keep: AnyObject?
        weak var controller: UIViewController?
        init(_ abandon: @escaping () -> Void) { self.abandon = abandon }
    }

    /// Present over the app's top controller; false when there is none to present over.
    private func present(_ controller: UIViewController, as screen: Screen, animated: Bool = true) -> Bool {
        guard let top = Self.topViewController() else { return false }
        screen.controller = controller
        self.screen = screen
        top.present(controller, animated: animated)
        return true
    }

    /// The screen ended: settle its call, once. A late answer after close() finds another screen
    /// (or none) and is dropped.
    private func finish(_ screen: Screen, dismiss: Bool = true, animated: Bool = true, _ settle: @escaping () -> Void) {
        onMain {
            guard self.screen === screen else { return }
            self.screen = nil
            if dismiss, let controller = screen.controller, controller.presentingViewController != nil {
                controller.dismiss(animated: animated)
            }
            settle()
        }
    }

    private static func topViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes.first(where: { $0 is UIWindowScene }) as? UIWindowScene,
              let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first else { return nil }
        var top = window.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }

    // MARK: - The changed event

    public func changedObserved(_ observed: Bool) {
        onMain { [self] in
            if !observed { return self.stopObserving() }
            guard self.changeObserver == nil else { return }
            self.changeObserver = NotificationCenter.default.addObserver(forName: .CNContactStoreDidChange, object: nil, queue: .main) { [weak self] _ in
                self?.announceChange()
            }
        }
    }

    /// One `changed` once a burst settles — one edit posts more than once (main thread); nothing
    /// while the app does not listen.
    private func announceChange() {
        guard changeObserver != nil, !changePending else { return }
        changePending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self, self.changePending else { return }
            self.changePending = false
            self.events.changed()
        }
    }

    private func stopObserving() {
        changePending = false
        if let changeObserver { NotificationCenter.default.removeObserver(changeObserver) }
        changeObserver = nil
    }

    public func close() {
        onMain {
            self.stopObserving()
            guard let screen = self.screen else { return }
            self.screen = nil
            if let controller = screen.controller, controller.presentingViewController != nil { controller.dismiss(animated: false) }
            screen.abandon()
        }
    }

    // MARK: - CNContact → Contact

    private static func keys(_ fields: Set<ContactField>) -> [CNKeyDescriptor] {
        var keys: [CNKeyDescriptor] = [
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
            CNContact.descriptorForAllComparatorKeys(),
        ]
        var names = [
            CNContactIdentifierKey, CNContactGivenNameKey, CNContactFamilyNameKey, CNContactMiddleNameKey,
            CNContactNicknameKey, CNContactOrganizationNameKey, CNContactImageDataAvailableKey,
        ]
        for field in fields {
            switch field {
            case .phones: names.append(CNContactPhoneNumbersKey)
            case .emails: names.append(CNContactEmailAddressesKey)
            case .addresses: names.append(CNContactPostalAddressesKey)
            case .urls: names.append(CNContactUrlAddressesKey)
            case .organization: names.append(CNContactJobTitleKey)
            case .birthday: names.append(CNContactBirthdayKey)
            }
        }
        keys.append(contentsOf: names.map { $0 as CNKeyDescriptor })
        return keys
    }

    private static func text(_ s: String?) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }

    /// A contact's value for `key`, nil when the contact was not fetched with it.
    private static func value<T>(_ c: CNContact, _ key: String, _ read: (CNContact) -> T?) -> T? {
        c.isKeyAvailable(key) ? read(c) : nil
    }

    private static func contact(_ c: CNContact, _ fields: Set<ContactField>) -> Contact {
        let company = value(c, CNContactOrganizationNameKey) { text($0.organizationName) }
        // The name as the device shows it; a company's card has no person's name.
        let name = text(CNContactFormatter.string(from: c, style: .fullName)) ?? company ?? ""
        var out = Contact(
            id: c.identifier, name: name,
            givenName: value(c, CNContactGivenNameKey) { text($0.givenName) },
            familyName: value(c, CNContactFamilyNameKey) { text($0.familyName) },
            middleName: value(c, CNContactMiddleNameKey) { text($0.middleName) },
            nickname: value(c, CNContactNicknameKey) { text($0.nickname) },
            hasPhoto: value(c, CNContactImageDataAvailableKey) { $0.imageDataAvailable } ?? false
        )
        // A field asked is present: empty where the contact has none (or was not fetched with it).
        if fields.contains(.phones) {
            out.phones = (value(c, CNContactPhoneNumbersKey) { $0.phoneNumbers } ?? []).compactMap { v in
                text(v.value.stringValue).map { ContactPhone(label: label(v.label), number: $0) }
            }
        }
        if fields.contains(.emails) {
            out.emails = (value(c, CNContactEmailAddressesKey) { $0.emailAddresses } ?? []).compactMap { v in
                text(v.value as String).map { ContactEmail(label: label(v.label), address: $0) }
            }
        }
        if fields.contains(.addresses) {
            out.addresses = (value(c, CNContactPostalAddressesKey) { $0.postalAddresses } ?? []).compactMap { v in
                let a = v.value
                let address = ContactAddress(
                    label: label(v.label), street: text(a.street), city: text(a.city), region: text(a.state),
                    postalCode: text(a.postalCode), country: text(a.country)
                )
                let empty = address.street == nil && address.city == nil && address.region == nil
                    && address.postalCode == nil && address.country == nil
                return empty ? nil : address
            }
        }
        if fields.contains(.urls) {
            out.urls = (value(c, CNContactUrlAddressesKey) { $0.urlAddresses } ?? []).compactMap { v in
                text(v.value as String).map { ContactUrl(label: label(v.label), url: $0) }
            }
        }
        if fields.contains(.organization) {
            let title = value(c, CNContactJobTitleKey) { text($0.jobTitle) }
            if company != nil || title != nil { out.organization = ContactOrganization(company: company, title: title) }
        }
        if fields.contains(.birthday), let day = value(c, CNContactBirthdayKey, { $0.birthday }),
           let month = day.month, let dayOfMonth = day.day {
            out.birthday = ContactBirthday(year: day.year.map { Int32($0) }, month: Int32(month), day: Int32(dayOfMonth))
        }
        return out
    }

    /// The contract's label of a system label; the person's own label as it is; nil for the system's
    /// other kinds (a fax, a pager) and for none.
    private static func label(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        switch raw {
        case CNLabelHome: return "home"
        case CNLabelWork: return "work"
        case CNLabelOther: return "other"
        case CNLabelPhoneNumberMobile, CNLabelPhoneNumberiPhone: return "mobile"
        case CNLabelPhoneNumberMain: return "main"
        case CNLabelURLAddressHomePage: return "homepage"
        default: return raw.hasPrefix("_$!<") ? nil : text(raw)
        }
    }

    // MARK: - ContactDraft → CNMutableContact

    private static func systemLabel(_ label: String?) -> String? {
        guard let label = text(label) else { return nil }
        switch label.lowercased() {
        case "home": return CNLabelHome
        case "work": return CNLabelWork
        case "other": return CNLabelOther
        case "mobile": return CNLabelPhoneNumberMobile
        case "main": return CNLabelPhoneNumberMain
        case "homepage": return CNLabelURLAddressHomePage
        default: return label
        }
    }

    private static func newContact(_ draft: ContactDraft) -> CNMutableContact {
        let c = CNMutableContact()
        if let v = text(draft.givenName) { c.givenName = v }
        if let v = text(draft.familyName) { c.familyName = v }
        if let v = text(draft.middleName) { c.middleName = v }
        if let v = text(draft.nickname) { c.nickname = v }
        if let v = text(draft.organization?.company) { c.organizationName = v }
        if let v = text(draft.organization?.title) { c.jobTitle = v }
        c.phoneNumbers = (draft.phones ?? []).compactMap { p in
            text(p.number).map { CNLabeledValue(label: systemLabel(p.label), value: CNPhoneNumber(stringValue: $0)) }
        }
        c.emailAddresses = (draft.emails ?? []).compactMap { e in
            text(e.address).map { CNLabeledValue(label: systemLabel(e.label), value: $0 as NSString) }
        }
        c.urlAddresses = (draft.urls ?? []).compactMap { u in
            text(u.url).map { CNLabeledValue(label: systemLabel(u.label), value: $0 as NSString) }
        }
        c.postalAddresses = (draft.addresses ?? []).map { a in
            let address = CNMutablePostalAddress()
            if let v = text(a.street) { address.street = v }
            if let v = text(a.city) { address.city = v }
            if let v = text(a.region) { address.state = v }
            if let v = text(a.postalCode) { address.postalCode = v }
            if let v = text(a.country) { address.country = v }
            return CNLabeledValue(label: systemLabel(a.label), value: address as CNPostalAddress)
        }
        if let day = draft.birthday {
            var components = DateComponents()
            components.year = day.year.map { Int($0) }
            components.month = Int(day.month)
            components.day = Int(day.day)
            c.birthday = components
        }
        return c
    }

    // MARK: - Errors

    private static func cnCode(_ error: Error) -> CNError.Code? {
        let ns = error as NSError
        guard ns.domain == CNErrorDomain else { return nil }
        return CNError.Code(rawValue: ns.code)
    }

    /// No such contact — or, with limited access, not one of those the app may read.
    private static func isMissing(_ error: Error) -> Bool { cnCode(error) == .recordDoesNotExist }

    private static func code(_ error: Error) -> ContactsCode {
        if cnCode(error) == .authorizationDenied { return .denied }
        NSLog("[contacts] a read failed: %@", String(describing: error))
        return .failed
    }

    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }
}

// MARK: - The screens' delegates

/// The picker of ONE contact: it has `didSelect contact` and not the plural.
private final class PickOne: NSObject, CNContactPickerDelegate {
    private let done: ([CNContact]) -> Void
    init(_ done: @escaping ([CNContact]) -> Void) { self.done = done }
    func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) { done([contact]) }
    func contactPickerDidCancel(_ picker: CNContactPickerViewController) { done([]) }
}

/// The picker of SEVERAL contacts: it has `didSelect contacts`.
private final class PickMany: NSObject, CNContactPickerDelegate {
    private let done: ([CNContact]) -> Void
    init(_ done: @escaping ([CNContact]) -> Void) { self.done = done }
    func contactPicker(_ picker: CNContactPickerViewController, didSelect contacts: [CNContact]) { done(contacts) }
    func contactPickerDidCancel(_ picker: CNContactPickerViewController) { done([]) }
}

/// The editor of a new contact (Cancel: nil; Done: the saved contact) and the card of an existing
/// one (its own end — a contact deleted there — the Close button, a swipe away).
private final class CardDelegate: NSObject, CNContactViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
    private let done: (_ saved: Bool) -> Void
    init(_ done: @escaping (Bool) -> Void) { self.done = done }

    func contactViewController(_ viewController: CNContactViewController, didCompleteWith contact: CNContact?) {
        done(contact != nil)
    }

    @objc func close() { done(false) }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { done(false) }
}

/// iOS 18: the system's sheet that changes which contacts a limited app may read. It is SwiftUI's
/// only (`contactAccessPicker`), so it is hosted in a clear view that shows it as it appears.
@available(iOS 18.0, *)
private struct AccessPickerHost: View {
    private let done: () -> Void
    @State private var shown = false

    init(_ done: @escaping () -> Void) { self.done = done }

    var body: some View {
        Color.clear
            .contactAccessPicker(isPresented: $shown) { _ in done() }
            .onAppear { shown = true }
            .onChange(of: shown) { _, now in if !now { done() } }
    }
}
