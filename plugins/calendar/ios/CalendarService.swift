//
//  CalendarService.swift — lecodes-plugins/calendar
//
//  One session of the "calendar" service over EventKit and EventKitUI. The channel (the calls,
//  CalendarEvent, the codes) is Calendar.gen.swift, generated from contract.d.ts; the glue asks the
//  `calendar` permission before calendars / list / get / show.
//
//  READING (EKEventStore) runs on a queue of the session's own; a reply is settled from there. ONE
//  store for the session, made at its first use (making one is slow, and the store's change
//  notification is posted while one is alive) — again once the permission is granted, when the
//  first was made without it: a store made before the grant is not trusted to see the calendars.
//
//  ALL-DAY events: EventKit keeps one as floating days — its start the local midnight of its first
//  day, its end 23:59:59 of its last. The contract's end is the local midnight AFTER the last day:
//  the end read is moved there by the calendar's arithmetic (a day is not always 24 hours), and a
//  draft's is moved back.
//
//  The SCREENS are the system's, presented over the app's top controller, one at a time — a call
//  while one is up rejects "busy":
//    - add: EKEventEditViewController with a new event filled from the draft. The person saves; the
//      plugin writes nothing itself (no programmatic save, no write-only access). iOS 17+ runs the
//      editor out of the app's process and it needs no permission; iOS 15 / 16 runs it in the app,
//      over the app's store, and it needs the calendar permission — asked here by hand through the
//      host's service, the one call whose need depends on the OS.
//    - show: EKEventViewController, where the event is edited and deleted; of a recurring event,
//      the occurrence that starts at `start`.
//

import EventKit
import EventKitUI
import Foundation
import LeCodes
import UIKit

public final class CalendarService: CalendarPlugin {

    private let events: CalendarEvents
    /// The host's permission service: openEditor() asks through it on iOS 15 / 16.
    private let permissions: Permissions
    private let queue = DispatchQueue(label: "io.letary.lecodes.calendar")

    private let storeLock = NSLock()
    /// The session's store and whether the permission was granted when it was made.
    private var made: (store: EKEventStore, granted: Bool)?

    /// The screen that is up (main thread).
    private var screen: Screen?
    private var changeObserver: NSObjectProtocol?
    private var changePending = false
    private var closed = false

    public init(_ events: CalendarEvents, _ permissions: Permissions) {
        self.events = events
        self.permissions = permissions
    }

    /// The session's store (any thread): made at the first use, made again once after the
    /// permission was granted under it.
    private var store: EKEventStore {
        storeLock.lock(); defer { storeLock.unlock() }
        let granted = CalendarAuthorization.access == .granted
        if let made, made.granted || !granted { return made.store }
        let store = EKEventStore()
        made = (store, granted)
        return store
    }

    // MARK: - Reading

    public func calendars(_ reply: Reply<[CalendarInfo], CalendarCode>) {
        queue.async { [self] in
            reply.resolve(store.calendars(for: .event).map(Self.info))
        }
    }

    public func list(_ options: CalendarListOptions, _ reply: Reply<[CalendarEvent], CalendarCode>) {
        let from = options.from, to = options.to
        let ids = options.calendars ?? []
        queue.async { [self] in
            let store = self.store
            var calendars: [EKCalendar]? = nil
            if !ids.isEmpty {
                // Only the calendars asked for that exist (an id of a reminders' list is none).
                let found = ids.compactMap { store.calendar(withIdentifier: $0) }.filter { $0.allowedEntityTypes.contains(.event) }
                guard !found.isEmpty else { return reply.resolve([]) }
                calendars = found
            }
            guard to > from else { return reply.resolve([]) }
            // One EKEvent per occurrence, unsorted. Kept: what overlaps [from, to) once all-day
            // ends are the contract's (EventKit's own test is its own ends').
            let predicate = store.predicateForEvents(withStart: Self.date(from), end: Self.date(to), calendars: calendars)
            let found = store.events(matching: predicate).map(Self.event)
                .filter { $0.start < to && ($0.end > from || $0.start >= from) }
                .sorted { ($0.start, $0.end, $0.title) < ($1.start, $1.end, $1.title) }
            reply.resolve(found)
        }
    }

    public func get(_ id: String, _ reply: Reply<CalendarEvent?, CalendarCode>) {
        queue.async { [self] in
            // Of a recurring event, the store gives its first occurrence.
            reply.resolve(store.event(withIdentifier: id).map(Self.event))
        }
    }

    // MARK: - The system's editor and card

    public func openEditor(_ draft: CalendarEventDraft, _ reply: Reply<Bool, CalendarCode>) {
        onMain { [self] in
            guard self.screen == nil else { return reply.reject(.busy) }
            if #available(iOS 17.0, *) { return self.edit(draft, reply) }
            // iOS 15 / 16: the editor runs in the app, over the app's store — it needs the permission.
            self.permissions.ensure(["calendar"]) { [weak self] granted in
                guard granted else { return reply.reject(.denied) }
                guard let self, !self.closed else { return reply.resolve(false) }
                self.edit(draft, reply)
            }
        }
    }

    /// The editor of a new event (main thread).
    private func edit(_ draft: CalendarEventDraft, _ reply: Reply<Bool, CalendarCode>) {
        guard screen == nil else { return reply.reject(.busy) }
        let store = self.store
        let event = Self.newEvent(draft, in: store)
        // Out of the app's process (iOS 17+ without the permission) the editor picks its default
        // calendar itself; in it, it takes the store's.
        if CalendarAuthorization.access == .granted { event.calendar = store.defaultCalendarForNewEvents }
        let screen = Screen { reply.resolve(false) }
        let editor = EKEventEditViewController()
        editor.eventStore = store
        editor.event = event
        let delegate = EditDelegate { [weak self] saved in
            self?.finish(screen) { reply.resolve(saved) }
        }
        editor.editViewDelegate = delegate
        screen.keep = delegate
        // No swipe away: the editor ends by its own Cancel or Add, which is what answers the call.
        editor.isModalInPresentation = true
        if !present(editor, as: screen) { reply.reject(.failed) }
    }

    public func openEvent(_ id: String, _ start: Double?, _ reply: Reply<Void, CalendarCode>) {
        onMain { [self] in
            guard self.screen == nil else { return reply.reject(.busy) }
            guard let event = self.occurrence(id, start) else { return reply.reject(.notFound) }
            let screen = Screen { reply.resolve(()) }
            let viewer = EKEventViewController()
            viewer.event = event
            viewer.allowsEditing = true
            let card = CardDelegate { [weak self] in
                self?.finish(screen) { reply.resolve(()) }
            }
            viewer.delegate = card
            // iOS 18 and 27 replace it with the card's own Edit and Done (Done ends the card through
            // the delegate); kept for a system whose card brings no way out of its own.
            viewer.navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .close, target: card, action: #selector(CardDelegate.close))
            screen.keep = card
            let nav = UINavigationController(rootViewController: viewer)
            nav.presentationController?.delegate = card   // swiped away: the card closed
            if !self.present(nav, as: screen) { reply.reject(.failed) }
        }
    }

    /// The event `id`; of a recurring one, the occurrence that starts at `start` (the nearest in a
    /// day around it: an occurrence moved since list() is still found), its first without one.
    private func occurrence(_ id: String, _ start: Double?) -> EKEvent? {
        let store = self.store
        guard let first = store.event(withIdentifier: id) else { return nil }
        guard let start, first.hasRecurrenceRules || first.isDetached else { return first }
        let day: TimeInterval = 86_400
        let at = Self.date(start)
        let calendar: EKCalendar? = first.calendar
        let predicate = store.predicateForEvents(
            withStart: at.addingTimeInterval(-day), end: at.addingTimeInterval(day),
            calendars: calendar.map { [$0] }
        )
        let occurrences = store.events(matching: predicate).filter { $0.eventIdentifier == id }
        return occurrences.min { abs(Self.times($0).start - start) < abs(Self.times($1).start - start) }
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
    private func finish(_ screen: Screen, animated: Bool = true, _ settle: @escaping () -> Void) {
        onMain {
            guard self.screen === screen else { return }
            self.screen = nil
            if let controller = screen.controller, controller.presentingViewController != nil {
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
            // The notification is a store's: one must be alive.
            self.queue.async { [self] in _ = store }
            self.changeObserver = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: nil, queue: .main) { [weak self] _ in
                // One edit (a sync above all) posts more than once: one `changed` once they settle.
                guard let self, !self.changePending else { return }
                self.changePending = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                    guard let self, self.changePending else { return }
                    self.changePending = false
                    self.events.changed()
                }
            }
        }
    }

    private func stopObserving() {
        changePending = false
        if let changeObserver { NotificationCenter.default.removeObserver(changeObserver) }
        changeObserver = nil
    }

    public func close() {
        onMain {
            self.closed = true
            self.stopObserving()
            guard let screen = self.screen else { return }
            self.screen = nil
            if let controller = screen.controller, controller.presentingViewController != nil { controller.dismiss(animated: false) }
            screen.abandon()
        }
    }

    // MARK: - EventKit → the contract

    private static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    private static func ms(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }

    private static func text(_ s: String?) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }

    private static func info(_ c: EKCalendar) -> CalendarInfo {
        // A local calendar is no account's; any other source is named by its title ("iCloud",
        // "Gmail", "Subscribed Calendars", "Other" for the birthdays).
        let source: EKSource? = c.source
        let account = source.flatMap { $0.sourceType == .local ? nil : text($0.title) }
        return CalendarInfo(id: c.calendarIdentifier, title: c.title, color: hex(c.cgColor), account: account,
                            writable: c.allowsContentModifications)
    }

    /// "#RRGGBB" in sRGB.
    private static func hex(_ color: CGColor?) -> String {
        guard let color, let srgb = CGColorSpace(name: CGColorSpace.sRGB),
              let c = color.converted(to: srgb, intent: .defaultIntent, options: nil)?.components, c.count >= 3 else { return "#000000" }
        let byte = { (v: CGFloat) -> Int in Int((min(max(v, 0), 1) * 255).rounded()) }
        return String(format: "#%02lX%02lX%02lX", byte(c[0]), byte(c[1]), byte(c[2]))
    }

    /// An occurrence's times in ms, an all-day one's in the contract's convention: its first day's
    /// local midnight to the local midnight after its last day.
    private static func times(_ e: EKEvent) -> (start: Double, end: Double) {
        let start: Date = e.startDate ?? Date(timeIntervalSince1970: 0)
        let end: Date = max(e.endDate ?? start, start)
        guard e.isAllDay else { return (ms(start), ms(end)) }
        let calendar = Calendar.current
        let first = calendar.startOfDay(for: start)
        let last = max(calendar.startOfDay(for: end), first)
        // EventKit's end is the last second of the last day; one already a midnight after the
        // first day is the contract's own.
        if end == last && last > first { return (ms(first), ms(last)) }
        let after = calendar.date(byAdding: .day, value: 1, to: last) ?? last.addingTimeInterval(86_400)
        return (ms(first), ms(after))
    }

    private static func event(_ e: EKEvent) -> CalendarEvent {
        let (start, end) = times(e)
        return CalendarEvent(
            id: e.eventIdentifier ?? e.calendarItemIdentifier,
            calendarId: e.calendar?.calendarIdentifier ?? "",
            title: e.title ?? "",
            start: start, end: end,
            allDay: e.isAllDay,
            // A detached occurrence (one moved or edited alone) is one of a recurring event too.
            recurring: e.hasRecurrenceRules || e.isDetached,
            location: text(e.location),
            notes: e.hasNotes ? text(e.notes) : nil,
            url: e.url?.absoluteString
        )
    }

    // MARK: - CalendarEventDraft → EKEvent

    private static func newEvent(_ draft: CalendarEventDraft, in store: EKEventStore) -> EKEvent {
        let event = EKEvent(eventStore: store)
        if let v = text(draft.title) { event.title = v }
        if let v = text(draft.location) { event.location = v }
        if let v = text(draft.notes) { event.notes = v }
        if let v = text(draft.url), let url = URL(string: v) { event.url = url }
        let calendar = Calendar.current
        let now = Date()
        if draft.allDay == true {
            let first = calendar.startOfDay(for: draft.start.map(date) ?? now)
            // The day of the last instant before the contract's end (the midnight after the last day).
            var last = draft.end.map { calendar.startOfDay(for: date($0).addingTimeInterval(-0.001)) } ?? first
            if last < first { last = first }
            event.isAllDay = true
            event.startDate = first
            // EventKit's own end of an all-day event: the last second of its last day.
            event.endDate = calendar.date(byAdding: .day, value: 1, to: last)?.addingTimeInterval(-1) ?? last
        } else {
            // Left out: the next full hour, as the system's editor would.
            let hour = calendar.dateInterval(of: .hour, for: now)?.start ?? now
            let start = draft.start.map(date) ?? calendar.date(byAdding: .hour, value: 1, to: hour) ?? now
            var end = draft.end.map(date) ?? start.addingTimeInterval(3600)
            if end < start { end = start.addingTimeInterval(3600) }
            event.startDate = start
            event.endDate = end
        }
        return event
    }

    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }
}

// MARK: - The screens' delegates

/// The editor of a new event: Add is `.saved`, Cancel `.canceled`.
private final class EditDelegate: NSObject, EKEventEditViewDelegate {
    private let done: (_ saved: Bool) -> Void
    init(_ done: @escaping (Bool) -> Void) { self.done = done }

    func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
        done(action == .saved)
    }
}

/// The card of an event: its own end (Done, the event deleted there, an invitation answered), the
/// Close button, a swipe away.
private final class CardDelegate: NSObject, EKEventViewDelegate, UIAdaptivePresentationControllerDelegate {
    private let done: () -> Void
    init(_ done: @escaping () -> Void) { self.done = done }

    func eventViewController(_ controller: EKEventViewController, didCompleteWith action: EKEventViewAction) { done() }

    @objc func close() { done() }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { done() }
}
