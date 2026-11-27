//
//  ContactsPlugin.swift — lecodes-plugins/contacts
//
//  The "contacts" service. A plugin and not part of the SDK so that only the apps that install it
//  link the Contacts framework (Apple reads its API off the binary and demands
//  NSContactsUsageDescription at upload, run or not); the manifest merges the usage string. For the
//  same reason it brings the `contacts` PERMISSION to the host: the core knows the kind, this plugin
//  registers who asks for it — the generated glue (`@permission contacts`) and the SDK's
//  `permissions` both go through it.
//
//  An App Clip does not carry this plugin: Contacts and ContactsUI are not available to a clip.
//

import Contacts
import Foundation
import LeCodes

public enum LeCodesContactsPlugin {

    public static let pluginId = "contacts"

    public static func register(in engine: LeCodesEngine) {
        engine.permissions.register(.contacts, PermissionAsker(
            query: { ContactsAuthorization.state },
            // The store answers on a queue of its own; the status after the dialog is the answer
            // (it tells a limited grant from a full one, the completion's flag does not).
            request: { then in
                CNContactStore().requestAccess(for: .contacts) { _, _ in then(ContactsAuthorization.state) }
            }
        ))
        ContactsChannel.register(in: engine) { _, events in ContactsService(events) }
    }
}

/// The app's access to the address book. iOS 18 has a fourth answer: SOME contacts, the person's
/// choice — a grant for the host's permission service (the calls go through), "limited" for the app.
enum ContactsAuthorization {

    static var access: ContactsAccess {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        if #available(iOS 18.0, *), status == .limited { return .limited }
        switch status {
        case .authorized: return .granted
        case .notDetermined: return .prompt
        default: return .denied   // denied, or restricted by the device's policy
        }
    }

    static var state: PermissionState {
        switch access {
        case .granted, .limited: return .granted
        case .prompt: return .prompt
        case .denied: return .denied
        }
    }
}
