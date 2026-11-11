//
//  BackgroundAudioPlugin.swift — lecodes-plugins/background-audio
//
//  The "backgroundAudio" service: one record that plays on with the app in the background and the
//  screen locked. A plugin and not part of the SDK so that only the apps that install it declare
//  the `audio` background mode (the manifest merges `UIBackgroundModes` into Info.plist — Apple
//  rejects an app that declares the mode and does not use it).
//

import Foundation
import LeCodes

public enum LeCodesBackgroundAudioPlugin {

    public static let pluginId = "background-audio"

    public static func register(in engine: LeCodesEngine) {
        BackgroundAudioChannel.register(in: engine) { _, events in BackgroundAudioService(events) }
    }
}
