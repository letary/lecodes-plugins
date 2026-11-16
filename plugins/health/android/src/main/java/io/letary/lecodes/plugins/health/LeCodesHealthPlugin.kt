//
//  LeCodesHealthPlugin.kt — lecodes-plugins/health
//
//  The "health" registerService plugin — backs the SDK `Health` global. A plugin and not part of the
//  SDK so that only the apps that install it carry Health Connect's client, its READ permissions and
//  the privacy screen of its manifest (Google Play reviews an app that declares health permissions).
//

package io.letary.lecodes.plugins.health

import android.content.Context
import io.letary.lecodes.LecodesEngine

object LeCodesHealthPlugin {

    const val PLUGIN_ID = "health"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        HealthChannel.register(engine) { _, _ -> HealthService(engine, appContext) }
    }
}
