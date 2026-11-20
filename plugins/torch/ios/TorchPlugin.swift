//
//  TorchPlugin.swift — lecodes-plugins/torch
//
//  The "torch" service. A plugin and not part of the SDK so that only the apps that install it look
//  up the camera devices (AVFoundation's capture classes) — nothing else of an app needs them.
//

import Foundation
import LeCodes

public enum LeCodesTorchPlugin {

    public static let pluginId = "torch"

    public static func register(in engine: LeCodesEngine) {
        TorchChannel.register(in: engine) { _, events in TorchService(events) }
    }
}
