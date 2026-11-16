//
//  BiometricsPlugin.swift — lecodes-plugins/biometrics
//
//  The "biometrics" service. A plugin and not part of the SDK so that only the apps that install it
//  link LocalAuthentication and carry the Face ID usage string (the manifest merges
//  NSFaceIDUsageDescription — without it the Face ID question is never asked and Face ID fails).
//

import Foundation
import LeCodes

public enum LeCodesBiometricsPlugin {

    public static let pluginId = "biometrics"

    public static func register(in engine: LeCodesEngine) {
        BiometricsChannel.register(in: engine) { _, _ in BiometricsService() }
    }
}
