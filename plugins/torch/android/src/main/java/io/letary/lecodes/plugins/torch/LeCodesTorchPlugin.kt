//
//  LeCodesTorchPlugin.kt — lecodes-plugins/torch
//
//  The "torch" registerService plugin — backs the SDK `Torch` global. A plugin and not part of the
//  SDK so that only the apps that install it reach the camera service; it needs no permission (its
//  manifest only says the flash is not required).
//

package io.letary.lecodes.plugins.torch

import android.content.Context
import io.letary.lecodes.LecodesEngine

object LeCodesTorchPlugin {

    const val PLUGIN_ID = "torch"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        TorchChannel.register(engine) { _, events -> TorchService(appContext, events) }
    }
}
