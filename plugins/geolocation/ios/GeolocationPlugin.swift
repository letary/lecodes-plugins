//
//  GeolocationPlugin.swift — lecodes-plugins/geolocation
//
//  The "geolocation" service. A plugin and not part of the SDK so that only the apps that install
//  it link CoreLocation (Apple flags location usage from the mere presence of CLLocationManager
//  symbols); the manifest merges the Info.plist usage string.
//

import Foundation
import LeCodes

public enum LeCodesGeolocationPlugin {

    public static let pluginId = "geolocation"

    public static func register(in engine: LeCodesEngine) {
        GeolocationChannel.register(in: engine) { _, events in GeolocationService(events) }
    }
}
