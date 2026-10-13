//
//  AudioRecorderPlugin.swift — lecodes-plugins/audio-recorder
//
//  The "audioRecorder" service: audio recording to a file over AVAudioRecorder. A session is one
//  recording. The microphone permission is the contract's (`@permission microphone`): the generated
//  glue asks the host before `start` reaches the service; the manifest merges the usage string.
//

import Foundation
import LeCodes

public enum LeCodesAudioRecorderPlugin {

    public static let pluginId = "audio-recorder"

    public static func register(in engine: LeCodesEngine) {
        AudioRecorderChannel.register(in: engine) { _, events in AudioRecorderService(events) }
    }
}
