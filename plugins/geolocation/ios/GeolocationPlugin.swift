//
//  GeolocationPlugin.swift — lecodes-plugins/geolocation
//
//  The "geolocation" service. A plugin and not part of the SDK so that only the apps that install
//  it link CoreLocation (Apple flags location usage from the mere presence of CLLocationManager
//  symbols); the manifest merges the Info.plist usage string. For the same reason it brings the
//  `location` PERMISSION to the host: the manifest declares the kind, this plugin hands the host
//  who asks for it (the generated `register` takes the asker) — the generated glue
//  (`@permission location`) and the SDK's `permissions` both go through it.
//

import CoreLocation
import Foundation
import LeCodes

public enum LeCodesGeolocationPlugin {

    public static let pluginId = "geolocation"

    public static func register(in engine: LeCodesEngine) {
        let location = LocationAsker()
        let asker = PermissionAsker(
            query: { location.state },
            request: { then in location.request(then) }
        )
        GeolocationChannel.register(in: engine, location: asker) { _, events in GeolocationService(events) }
    }
}

/// Location (while in use): CLLocationManager's status, its dialog answered through the delegate.
/// Asked on the main thread (the host's permission queue), one request at a time.
private final class LocationAsker: NSObject, CLLocationManagerDelegate {
    private lazy var manager: CLLocationManager = {
        let m = CLLocationManager()
        m.delegate = self
        return m
    }()
    private var pending: ((PermissionState) -> Void)?

    var state: PermissionState {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: return .granted
        case .notDetermined: return .prompt
        default: return .denied
        }
    }

    func request(_ then: @escaping (PermissionState) -> Void) {
        pending = then
        manager.requestWhenInUseAuthorization()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        // Fires once at the manager's creation too (still undetermined): not an answer.
        let now = state
        guard now != .prompt, let then = pending else { return }
        pending = nil
        then(now)
    }
}
