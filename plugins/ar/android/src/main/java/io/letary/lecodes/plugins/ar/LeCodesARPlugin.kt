//
//  LeCodesARPlugin.kt — lecodes-plugins/ar
//
//  The "ar" service: world tracking over ARCore. A session is one AR scene (ARScene opens it with the
//  scene and its camera entity) and drives that scene through the host's gl facade (`engine.gl`):
//  the camera's pose and projection, the camera image as the scene's background, the entities the
//  app pinned. The camera permission is the contract's (`@permission camera` on start): the
//  generated glue asks the host before `start` reaches the session; the merged manifest carries
//  CAMERA, the optional `android.hardware.camera.ar` feature and ARCore as "optional" — the app
//  installs on a phone without it, where `start` rejects "unavailable".
//

package io.letary.lecodes.plugins.ar

import android.content.Context
import io.letary.lecodes.LecodesEngine

object LeCodesARPlugin {

    const val PLUGIN_ID = "ar"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        ARChannel.register(engine) { params, events -> ARCoreSession(engine, appContext, params, events) }
    }
}
