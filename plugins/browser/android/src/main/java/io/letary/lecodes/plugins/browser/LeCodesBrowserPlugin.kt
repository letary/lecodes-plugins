//
//  LeCodesBrowserPlugin.kt — lecodes-plugins/browser
//
//  The "browser" service (the system sheet: a Chrome Custom Tab) and the "webView" view
//  (android.webkit.WebView). WHEN and WITH WHAT to open them is the app's code; the channels
//  themselves (the calls, the params, the events) are BrowserPlugin.gen.kt, generated from
//  contract.d.ts.
//

package io.letary.lecodes.plugins.browser

import android.content.Context
import io.letary.lecodes.LecodesEngine

object LeCodesBrowserPlugin {

    const val PLUGIN_ID = "browser"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        BrowserChannel.register(engine) { _, events -> BrowserSheet(engine, appContext, events) }
        WebViewChannel.register(engine) { params, events -> WebViewPage(appContext, params, events) }
    }
}
