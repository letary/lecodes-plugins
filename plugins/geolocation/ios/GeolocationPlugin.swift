//
//  GeolocationPlugin.swift — lecodes-plugins/geolocation
//
//  The "geolocation" registerService plugin: the SDK's Geolocation wrapper rides the
//  generic service channel, no per-plugin bridge methods. Extracted from the SDK so that
//  only apps that install it link CoreLocation (Apple flags location usage from the mere
//  presence of CLLocationManager symbols); the manifest merges the Info.plist usage string.
//

import Foundation
import LeCodesSDK

public enum LeCodesGeolocationPlugin {

    public static let pluginId = "geolocation"

    public static func register(in engine: LeCodesEngine) {
        engine.registerService("geolocation") { _, channel in
            GeolocationService(channel)
        }
    }
}
