//
//  ARPlugin.swift — lecodes-plugins/ar
//
//  The "ar" service: world tracking over ARKit. A session is one AR scene (ARScene opens it with the
//  scene and its camera entity) and drives that scene through the host's gl facade (`engine.gl`):
//  the camera's pose and projection, the camera image as the scene's background, the entities the
//  app pinned. The camera permission is the contract's (`@permission camera` on start): the
//  generated glue asks the host before `start` reaches the session; the manifest merges the usage
//  string. A plugin, not the SDK, so that only the apps that list it link ARKit.
//

import Foundation
import LeCodes

public enum LeCodesARPlugin {

    public static let pluginId = "ar"

    public static func register(in engine: LeCodesEngine) {
        let gl = engine.gl
        ARChannel.register(in: engine) { params, events in ARKitSession(params, events, gl) }
    }
}
