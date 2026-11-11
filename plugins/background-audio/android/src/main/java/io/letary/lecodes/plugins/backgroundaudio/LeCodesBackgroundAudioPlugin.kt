//
//  LeCodesBackgroundAudioPlugin.kt — lecodes-plugins/background-audio
//
//  The "backgroundAudio" service: one record that plays on with the app in the background and the
//  screen off. The record plays in a media3 session service (BackgroundAudioService) — the system's
//  media notification, its buttons, a headset's, the audio focus are the session's; the app's
//  session of the channel (BackgroundAudioSession) drives it through a MediaController.
//

package io.letary.lecodes.plugins.backgroundaudio

import android.content.Context
import io.letary.lecodes.LecodesEngine

object LeCodesBackgroundAudioPlugin {

    const val PLUGIN_ID = "background-audio"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        BackgroundAudioChannel.register(engine) { _, events -> BackgroundAudioSession(appContext, events) }
    }
}
