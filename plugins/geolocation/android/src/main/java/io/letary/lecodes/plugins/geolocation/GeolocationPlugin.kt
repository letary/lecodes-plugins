//
//  GeolocationPlugin.kt — lecodes-plugins/geolocation
//
//  The "geolocation" registerService plugin — backs the SDK `Geolocation` global.
//  Extracted from the SDK for the same reason as on iOS (there: linking CoreLocation
//  flags every consumer; here: the location permissions in the merged manifest do).
//

package io.letary.lecodes.plugins.geolocation

import android.content.Context
import io.letary.lecodes.LecodesEngine

object GeolocationPlugin {

    const val PLUGIN_ID = "geolocation"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        engine.registerService("geolocation") { _, channel ->
            GeolocationService(engine, appContext, channel).instance()
        }
    }
}
