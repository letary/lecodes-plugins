//
//  SpeechPlugin.swift — lecodes-plugins/speech
//
//  The "speech" service: speech recognition over SFSpeechRecognizer. A plugin and not part of the
//  SDK so that only the apps that install it link the Speech framework (Apple flags its use from
//  the symbols alone, and asks for the purpose string). It also brings the `speech` PERMISSION to
//  the host: the manifest declares the kind, this plugin hands the host who asks for it (the
//  generated `register` takes the asker) — the generated glue
//  (`@permission speech microphone` on start) and the SDK's `permissions` both go through it.
//

import Foundation
import LeCodes
import Speech

public enum LeCodesSpeechPlugin {

    public static let pluginId = "speech"

    public static func register(in engine: LeCodesEngine) {
        let speech = PermissionAsker(
            query: {
                switch SFSpeechRecognizer.authorizationStatus() {
                case .authorized: return .granted
                case .notDetermined: return .prompt
                default: return .denied
                }
            },
            request: { then in SFSpeechRecognizer.requestAuthorization { then($0 == .authorized ? .granted : .denied) } }
        )
        SpeechChannel.register(in: engine, speech: speech) { _, events in SpeechService(events) }
    }
}
