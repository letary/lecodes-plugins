//
//  AppleSignInPlugin.swift — lecodes-plugins/apple-sign-in
//
//  The "appleSignIn" service: Sign in with Apple through the system's sheet. A plugin and not part
//  of the SDK so that only the apps that install it carry the Sign in with Apple entitlement (the
//  manifest merges `com.apple.developer.applesignin`) — an app with the entitlement must have the
//  capability on its App ID, or it does not sign.
//

import Foundation
import LeCodes

public enum LeCodesAppleSignInPlugin {

    public static let pluginId = "apple-sign-in"

    public static func register(in engine: LeCodesEngine) {
        AppleSignInChannel.register(in: engine) { _, _ in AppleSignInService() }
    }
}
