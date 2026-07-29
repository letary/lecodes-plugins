//
//  PushManager.swift — lecodes-plugins/push
//
//  The device-level push machinery (docs/push-plan.md): the APNs token, the
//  UNUserNotificationCenter moments (via LeCodesAppHooks — see PushPlugin.swift), the
//  le.codes registration calls, and tap/foreground routing. PushService is the thin
//  per-session adapter over it.
//
//  Registration attribution reads engine.currentProjectUuid (the trusted world identity —
//  see LeCodesEngine "World identity & trust"); worlds without an identity (launcher,
//  dev bundles, generated shells) get "unavailable".
//
//  Wire payload (APNs userInfo): { aps: { alert: { title, body? }, badge?, sound },
//  lecodes: { projectUuid, url?, data? } } — `lecodes.projectUuid` is stamped by the
//  backend and routes multi-tenant display/taps; it is stripped before payloads reach JS.
//

import Foundation
import UIKit
import UserNotifications
import LeCodesSDK

public final class PushManager: LeCodesNotificationHandler {

    public static let shared = PushManager()
    private init() {}

    public weak var engine: LeCodesEngine?
    /// The le.codes backend the viewer registers against.
    public var apiBase = "https://le.codes"
    /// APNs gateway of the tokens this build mints — "sandbox" or "production".
    ///
    /// Derived from the `aps-environment` this build was SIGNED with, because that entitlement is
    /// the only thing deciding which APNs environment issues a device token — and therefore which
    /// gateway will accept it. The build CONFIGURATION is not that signal: a Release build on a
    /// development profile still mints sandbox tokens, so the old `#if DEBUG` split reported
    /// "production" for it and every send came back `BadDeviceToken`. Settable, so a host
    /// embedding the SDK can still override.
    public lazy var environment: String = Self.detectApnsEnvironment()

    /// `Entitlements → aps-environment` out of the embedded provisioning profile. The file is CMS
    /// signed, so the payload plist is sliced from the raw bytes by its XML delimiters — a string
    /// round-trip would need a lossy encoding to survive the binary wrapper. App Store builds ship
    /// no embedded profile, and neither does the simulator: production is correct for the former
    /// and the safe default for anything unreadable.
    private static func detectApnsEnvironment() -> String {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let start = data.range(of: Data("<plist".utf8)),
              let end = data.range(of: Data("</plist>".utf8)),
              start.lowerBound < end.upperBound,
              let root = (try? PropertyListSerialization.propertyList(
                  from: Data(data[start.lowerBound ..< end.upperBound]), format: nil)) as? [String: Any],
              let entitlements = root["Entitlements"] as? [String: Any],
              let aps = entitlements["aps-environment"] as? String
        else { return "production" }
        // Apple spells it "development"; the APNs host that accepts those tokens is the sandbox one.
        return aps == "development" ? "sandbox" : "production"
    }

    // MARK: - Device token (LeCodesAppHooks forwards, main thread)

    private var deviceTokenHex: String? = nil
    private var tokenWaiters: [(String?) -> Void] = []

    public func remoteNotificationsToken(_ token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        onMainThread { [self] in
            let changed = deviceTokenHex != nil && deviceTokenHex != hex
            deviceTokenHex = hex
            let waiters = tokenWaiters
            tokenWaiters = []
            waiters.forEach { $0(hex) }
            // APNs rotated the token (restore, reinstall): every persisted registration
            // points at a dead token — re-register them all with their stored user keys.
            if changed {
                for (uuid, info) in persistedRegistrations() {
                    registerWithBackend(uuid, user: info["user"], token: hex) { _ in }
                }
            }
        }
    }

    public func remoteNotificationsError(_ error: Error) {
        print("LeCodes: APNs registration failed — \(error.localizedDescription)")
        onMainThread { [self] in
            let waiters = tokenWaiters
            tokenWaiters = []
            waiters.forEach { $0(nil) }
        }
    }

    private func withDeviceToken(_ proceed: @escaping (String?) -> Void) {
        if let token = deviceTokenHex { return proceed(token) }
        tokenWaiters.append(proceed)
        UIApplication.shared.registerForRemoteNotifications()
        // APNs normally answers in well under a second; a token that never arrives
        // (no entitlement, no network) must reject, not hang the app's promise.
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [self] in
            guard !tokenWaiters.isEmpty else { return }
            let waiters = tokenWaiters
            tokenWaiters = []
            waiters.forEach { $0(deviceTokenHex) }
        }
    }

    // MARK: - Persistence (per-project registrations)

    private let registrationsKey = "lecodes.push.registrations"

    private func persistedRegistrations() -> [String: [String: String]] {
        (UserDefaults.standard.dictionary(forKey: registrationsKey) as? [String: [String: String]]) ?? [:]
    }
    private func persistRegistration(_ uuid: String, address: String, user: String?) {
        var all = persistedRegistrations()
        var info = ["address": address]
        if let user { info["user"] = user }
        all[uuid] = info
        UserDefaults.standard.set(all, forKey: registrationsKey)
    }
    private func removeRegistration(_ uuid: String) {
        var all = persistedRegistrations()
        all.removeValue(forKey: uuid)
        UserDefaults.standard.set(all, forKey: registrationsKey)
    }

    // MARK: - Service calls (invoked by PushService on the main thread)

    func getStatus(_ projectUuid: String?, _ settle: ChannelSettle) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let permission: String
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: permission = "granted"
            case .denied: permission = "denied"
            default: permission = "prompt"
            }
            let registered = projectUuid != nil && self.persistedRegistrations()[projectUuid!] != nil
            settle.resolve(["permission": permission, "registered": registered])
        }
    }

    func register(_ projectUuid: String?, _ options: [String: Any]?, _ settle: ChannelSettle) {
        // No identity = an unattributed world (launcher, dev bundle): push can't know which
        // app is asking, so it fails BEFORE any permission path (the plugin ordering rule).
        guard let uuid = projectUuid else { return settle.reject("unavailable") }
        let user = options?["user"] as? String

        // Straight to the OS prompt — no viewer-level consent sheet. Turning a project's
        // notifications OFF is enforced at the RELAY, not here: when the app isn't running iOS
        // displays the push itself and no LeCodes code runs, so a device-side gate could never be
        // the real control. Per-project opt-out lives on the registration row (`Push.unregister()`,
        // and the mute the launcher sets) — see docs/push-plan.md.
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            onMainThread { [self] in
                guard granted else { return settle.reject("denied") }
                withDeviceToken { [self] token in
                    guard let token else { return settle.reject("unavailable") }
                    registerWithBackend(uuid, user: user, token: token) { address in
                        if let address {
                            settle.resolve(["address": address])
                        } else {
                            settle.reject("unavailable")
                        }
                    }
                }
            }
        }
    }

    func unregister(_ projectUuid: String?, _ settle: ChannelSettle) {
        guard let uuid = projectUuid else { return settle.reject("unavailable") }
        if let address = persistedRegistrations()[uuid]?["address"], let token = deviceTokenHex {
            var request = URLRequest(url: URL(string: "\(apiBase)/api/push/registrations/\(address)")!)
            request.httpMethod = "DELETE"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token])
            URLSession.shared.dataTask(with: request).resume()   // best effort
        }
        removeRegistration(uuid)
        settle.resolve()
    }

    func getLaunch(_ projectUuid: String?, _ settle: ChannelSettle) {
        guard let uuid = projectUuid, let payload = launchPayload,
              payload.projectUuid == uuid else { return settle.resolve() }
        settle.resolve(payload.appPayload)
    }

    // MARK: - Backend registration

    private func registerWithBackend(_ uuid: String, user: String?, token: String,
                                     _ done: @escaping (String?) -> Void) {
        var body: [String: Any] = [
            "projectUuid": uuid, "platform": "apns", "token": token, "environment": environment,
        ]
        // The relay picks send credentials — and the apns-topic — from the host app's bundle
        // id. A standalone shell MUST send its own: registered under the viewer's topic its
        // sends would die with DeviceTokenNotForTopic. The relay also fail-fasts registration
        // for bundle ids it can never sign for (foreign teams, until per-app keys exist).
        if let hostApp = Bundle.main.bundleIdentifier { body["hostApp"] = hostApp }
        if let user { body["user"] = user }
        var request = URLRequest(url: URL(string: "\(apiBase)/api/push/registrations")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: request) { data, response, _ in
            var address: String? = nil
            if let data, (response as? HTTPURLResponse)?.statusCode == 200,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                address = json["address"] as? String
            }
            onMainThread { [self, address] in
                if let address { persistRegistration(uuid, address: address, user: user) }
                done(address)
            }
        }.resume()
    }

    // MARK: - Delivery (LeCodesAppHooks handler + cold start)

    /// One parsed notification. `appPayload` is what JS sees (routing fields stripped).
    private struct Payload {
        let projectUuid: String
        let appPayload: [String: Any]
        let url: String?
    }

    /// The notification that launched (or re-routed) the current world — served by
    /// getLaunch to the matching project's world, stable for that world's lifetime.
    private var launchPayload: Payload? = nil

    private func parse(_ userInfo: [AnyHashable: Any]) -> Payload? {
        guard let lecodes = userInfo["lecodes"] as? [String: Any],
              let uuid = lecodes["projectUuid"] as? String else { return nil }
        var app: [String: Any] = [:]
        if let aps = userInfo["aps"] as? [String: Any] {
            if let alert = aps["alert"] as? [String: Any] {
                app["title"] = alert["title"] ?? ""
                if let body = alert["body"] { app["body"] = body }
            }
            if let badge = aps["badge"] { app["badge"] = badge }
        }
        if let url = lecodes["url"] { app["url"] = url }
        if let data = lecodes["data"] { app["data"] = data }
        return Payload(projectUuid: uuid, appPayload: app, url: lecodes["url"] as? String)
    }

    /// `connectionOptions.notificationResponse` (buffered by LeCodesAppHooks) — the app was
    /// cold-started by a notification tap. The plugin registers BEFORE the JS world boots
    /// (registerBundledPlugins / postInit precede run), so the seeded launch URL is what
    /// initial code observes — the same seeding order rule as deep links.
    public func coldStart(_ response: UNNotificationResponse) {
        guard let engine,
              let payload = parse(response.notification.request.content.userInfo) else { return }
        launchPayload = payload
        coldStartHandledId = response.notification.request.identifier
        engine.setLaunchUrl("https://le.codes/qr/\(payload.projectUuid)")
    }

    /// The notification this launch was started by, once the cold-start path has consumed it.
    ///
    /// iOS reports a launching tap TWICE — through `connectionOptions.notificationResponse` and
    /// again to the delegate as `didReceive`. The second delivery lands while the launcher is still
    /// fetching the project, so `currentProjectUuid` has not been set yet, and `didReceive` reads
    /// that as "a notification for some other app" and re-enters the launcher. The world is then
    /// built twice, and everything the first one had in flight (its `register()` above all) dies
    /// with its context. Same notification, already routed — the redelivery is nothing to act on.
    /// (LeCodesAppHooks drains the cold-start response before any buffered didReceive, so the id
    /// is always set before the redelivery is seen.)
    private var coldStartHandledId: String? = nil

    /// Foreground receipt: the target app is on screen → no banner, deliver as the
    /// "message" event; any other app's notification shows normally.
    public func willPresent(_ notification: UNNotification,
                            completion completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        guard let payload = parse(notification.request.content.userInfo) else {
            return completionHandler([.banner, .sound, .list])
        }
        onMainThread { [self] in
            if payload.projectUuid == engine?.currentProjectUuid {
                emit("message", payload.appPayload)
                completionHandler([])
            } else {
                completionHandler([.banner, .sound, .list])
            }
        }
    }

    /// Tap while the process is alive: same-project world → warm "tap" event (+ the url
    /// riding the deep-link path); any other project → re-enter the launcher with a seeded
    /// QR URL (the same primitive quit() uses) and serve the payload via getLaunch.
    public func didReceive(_ response: UNNotificationResponse,
                           completion completionHandler: @escaping () -> Void) {
        guard let payload = parse(response.notification.request.content.userInfo) else {
            return completionHandler()
        }
        // Already consumed by the cold-start path — see `coldStartHandledId`. Acting on it again
        // would rebuild the world the launcher is in the middle of building.
        if coldStartHandledId == response.notification.request.identifier {
            coldStartHandledId = nil
            return completionHandler()
        }
        onMainThread { [self] in
            guard let engine else { return completionHandler() }
            if payload.projectUuid == engine.currentProjectUuid {
                emit("tap", payload.appPayload)
                if let url = payload.url { engine.emitUrl(url) }
            } else {
                launchPayload = payload
                engine.openLauncher(withUrl: "https://le.codes/qr/\(payload.projectUuid)")
            }
            completionHandler()
        }
    }

    // MARK: - Live sessions (the event pipe)

    private var sessions: [WeakPushService] = []
    private struct WeakPushService { weak var service: PushService? }

    func attach(_ service: PushService) { sessions.append(.init(service: service)) }
    func detach(_ service: PushService) { sessions.removeAll { $0.service === service || $0.service == nil } }

    private func emit(_ event: String, _ payload: [String: Any]) {
        sessions.removeAll { $0.service == nil }
        for session in sessions { session.service?.channel.emit(event, payload) }
    }
}
