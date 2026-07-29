//
//  PushPlugin.kt — lecodes-plugins/push
//
//  The "push" registerService plugin (docs/push-plan.md, Android host). Unlike iOS there is
//  no LeCodesAppHooks surface — the FCM <service> in this module's manifest is the plugin's
//  own entry point — but tap routing still needs three host-activity moments, exposed here.
//
//  Host wiring (the generated-shell MainActivity template carries these lines):
//    onCreate:            PushPlugin.register(engine, applicationContext)
//                         if (savedInstanceState == null) PushPlugin.parkLaunchPayload(intent)
//    onResume/onPause:    PushPlugin.setForeground(true / false)
//    onNewIntent:         if (PushPlugin.handleTapIntent(intent)) return   // before generic deep links
//
//  Delivery scope: the le.codes relay sends through Letary's Firebase project, so the shell's
//  google-services.json must belong to it (the Android mirror of the iOS com.letary.* APNs
//  team scope) — other projects' tokens reject at registration ("unavailable").
//

package io.letary.lecodes.plugins.push

import android.content.Context
import android.content.Intent
import io.letary.lecodes.LecodesEngine

object PushPlugin {

    const val PLUGIN_ID = "push"

    /** Activity.onCreate, before engine.run(): PushManager wiring + the "push" service. */
    fun register(engine: LecodesEngine, context: Context) {
        PushManager.init(context.applicationContext, engine)
        engine.registerService("push") { _, channel -> PushService(channel).instance() }
    }

    /** Cold start (onCreate, only when savedInstanceState == null): park a notification tap's
     *  payload for Push.getLaunch() BEFORE the engine boots. Consumes the intent extra so an
     *  Activity recreation cannot re-park it. */
    fun parkLaunchPayload(intent: Intent) = PushManager.parkLaunchPayload(intent)

    /** Warm tap (onNewIntent). @return true when consumed — the caller MUST then skip its
     *  generic deep-link path (a same-project tap must not reload the running app). */
    fun handleTapIntent(intent: Intent): Boolean = PushManager.handleTapIntent(intent)

    /** onResume(true) / onPause(false) — a banner is suppressed only for a foregrounded
     *  same-project world (the iOS willPresent rule). */
    fun setForeground(foreground: Boolean) { PushManager.isForeground = foreground }
}
