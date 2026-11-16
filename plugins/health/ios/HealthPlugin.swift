//
//  HealthPlugin.swift — lecodes-plugins/health
//
//  The "health" service. A plugin and not part of the SDK so that only the apps that install it
//  link HealthKit and carry what HealthKit demands of an app: the entitlement
//  (com.apple.developer.healthkit — the manifest's `entitlements`, a capability of the App ID) and
//  NSHealthShareUsageDescription (the manifest's `infoPlist`; without it HealthKit raises at the
//  first request and the app dies).
//

import Foundation
import LeCodes

public enum LeCodesHealthPlugin {

    public static let pluginId = "health"

    public static func register(in engine: LeCodesEngine) {
        HealthChannel.register(in: engine) { _, _ in HealthService() }
    }
}
