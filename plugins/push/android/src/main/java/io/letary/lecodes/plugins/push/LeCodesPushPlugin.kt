//
//  LeCodesPushPlugin.kt — lecodes-plugins/push
//
//  The "push" service on Android. The FCM <service> in this module's manifest is the plugin's own
//  entry point; routing a notification TAP needs three moments of the host's activity, which the
//  host forwards to the SDK's LeCodesAppHooks — it names no plugin, this one attaches a handler:
//
//    launchIntent   a tap that cold-started the app: its payload is parked for Push.getLaunch()
//                   before the engine boots
//    newIntent      a tap while the app lives — consumed, so the host skips its deep-link path
//    foreground     a banner is suppressed only for a foregrounded same-project world
//
//  Delivery scope: the le.codes relay sends through Letary's Firebase project, so the shell's
//  google-services.json must belong to it (the Android mirror of the iOS com.letary.* APNs
//  team scope) — other projects' tokens reject at registration ("unavailable").
//

package io.letary.lecodes.plugins.push

import android.content.Context
import android.content.Intent
import io.letary.lecodes.LeCodesAppHooks
import io.letary.lecodes.LeCodesIntentHandler
import io.letary.lecodes.LecodesEngine

object LeCodesPushPlugin {

    const val PLUGIN_ID = "push"

    /** Activity.onCreate, before engine.run(): PushManager wiring + the "push" service. */
    fun register(engine: LecodesEngine, context: Context) {
        PushManager.init(context.applicationContext, engine)
        LeCodesAppHooks.addHandler(Taps)
        PushChannel.register(engine) { _, events -> PushService(events) }
    }

    /** One handler for the process: a host that recreates its activity registers again. */
    private object Taps : LeCodesIntentHandler {
        override fun launchIntent(intent: Intent) = PushManager.parkLaunchPayload(intent)
        override fun newIntent(intent: Intent): Boolean = PushManager.handleTapIntent(intent)
        override fun foreground(isForeground: Boolean) { PushManager.isForeground = isForeground }
    }
}
