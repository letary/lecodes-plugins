//
//  LeCodesBiometricsPlugin.kt — lecodes-plugins/biometrics
//
//  The "biometrics" registerService plugin — backs the SDK `Biometrics` global. A plugin and not
//  part of the SDK so that only the apps that install it carry androidx.biometric and the
//  USE_BIOMETRIC / USE_FINGERPRINT permissions of its manifest.
//

package io.letary.lecodes.plugins.biometrics

import android.content.Context
import io.letary.lecodes.LecodesEngine

object LeCodesBiometricsPlugin {

    const val PLUGIN_ID = "biometrics"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        BiometricsChannel.register(engine) { _, _ -> BiometricsService(engine, appContext) }
    }
}
