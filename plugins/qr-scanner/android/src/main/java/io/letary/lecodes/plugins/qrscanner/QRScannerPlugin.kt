//
//  QRScannerPlugin.kt — lecodes-plugins/qr-scanner
//
//  The "qrScanner" registerView plugin. Event surface matches iOS and the SDK QRScanner
//  wrapper exactly: only "scan" { data } is emitted (data null when the code leaves the
//  frame) — there is no "open" event in the contract.
//

package io.letary.lecodes.plugins.qrscanner

import android.content.Context
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.utils.NativeViews
import org.json.JSONObject

object QRScannerPlugin {

    const val PLUGIN_ID = "qr-scanner"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        engine.registerView("qrScanner") { _, channel ->
            val view = QRScannerView(appContext,
                onOpen = {},
                onData = { data -> channel.emit("scan", JSONObject().put("data", data ?: JSONObject.NULL).toString()) })
            NativeViews.Instance(view)
        }
    }
}
