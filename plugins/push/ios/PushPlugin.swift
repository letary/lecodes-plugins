//
//  PushPlugin.swift — lecodes-plugins/push
//
//  The "push" registerService plugin. Beyond the engine registration it needs three
//  host-app moments that no plugin can implement itself — the shell templates (and the
//  launcher) forward them through the SDK's buffered hook surface:
//
//    • AppDelegate.didFinishLaunching:      LeCodesAppHooks.install()
//    • AppDelegate APNs token callbacks:    LeCodesAppHooks.remoteNotificationsToken/-Error
//    • SceneDelegate.willConnectTo:         LeCodesAppHooks.coldStartNotification(response)
//
//  plus the aps-environment entitlement (manifest "entitlements"). Without the
//  entitlement, register() times out into "unavailable" — nothing crashes.
//

import Foundation
import LeCodesSDK

public enum LeCodesPushPlugin {

    public static let pluginId = "push"

    public static func register(in engine: LeCodesEngine) {
        // Engine BEFORE handler: attaching drains the buffered cold-start tap, and that
        // path seeds the launch URL through the engine.
        PushManager.shared.engine = engine
        LeCodesAppHooks.setNotificationHandler(PushManager.shared)
        engine.registerService("push") { [weak engine] _, channel in
            PushService(channel, engine)
        }
    }
}
