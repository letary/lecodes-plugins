//
//  CalendarPlugin.swift — lecodes-plugins/calendar
//
//  The "calendar" service. A plugin and not part of the SDK so that only the apps that install it
//  link EventKit (Apple reads its API off the binary and demands the calendar usage strings at
//  upload, run or not); the manifest merges the usage strings. For the same reason it brings the
//  `calendar` PERMISSION to the host: the manifest declares the kind, this plugin hands the host
//  who asks for it (the generated `register` takes the asker) — the generated glue
//  (`@permission calendar`), the SDK's `permissions` and add() on iOS 15 / 16 all go through it.
//
//  The permission is FULL access (reading). iOS 17 has a write-only grant as well: the app never
//  asks for it (writing is the system's editor, which needs none there), and a full-access request
//  upgrades it — so for the host it is still "prompt".
//

import EventKit
import Foundation
import LeCodes

public enum LeCodesCalendarPlugin {

    public static let pluginId = "calendar"

    public static func register(in engine: LeCodesEngine) {
        let asker = PermissionAsker(
            query: { CalendarAuthorization.state },
            // The store answers on a queue of its own; the status after the dialog is the answer.
            request: { then in CalendarAuthorization.request { then(CalendarAuthorization.state) } }
        )
        let permissions = engine.permissions
        CalendarChannel.register(in: engine, calendar: asker) { _, events in CalendarService(events, permissions) }
    }
}

/// The app's access to the calendars' events.
enum CalendarAuthorization {

    static var access: CalendarAccess {
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(iOS 17.0, *) {
            switch status {
            case .fullAccess: return .granted
            // Write-only: the app may add events but not read them — a full-access request still asks.
            case .writeOnly, .notDetermined: return .prompt
            default: return .denied   // denied, or restricted by the device's policy
            }
        }
        switch status {
        case .authorized: return .granted
        case .notDetermined: return .prompt
        default: return .denied
        }
    }

    static var state: PermissionState {
        switch access {
        case .granted: return .granted
        case .prompt: return .prompt
        case .denied: return .denied
        }
    }

    /// Show the dialog of full access; `done` runs once, on any thread, after it.
    static func request(_ done: @escaping () -> Void) {
        let store = EKEventStore()
        // The store is held until it answers.
        if #available(iOS 17.0, *) {
            store.requestFullAccessToEvents { _, _ in withExtendedLifetime(store) { done() } }
        } else {
            store.requestAccess(to: .event) { _, _ in withExtendedLifetime(store) { done() } }
        }
    }
}
