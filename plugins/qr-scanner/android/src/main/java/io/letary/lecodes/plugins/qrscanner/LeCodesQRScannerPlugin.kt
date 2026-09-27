//
//  LeCodesQRScannerPlugin.kt — lecodes-plugins/qr-scanner
//
//  The "qrScanner" view: the contract's QRScannerPlugin (QRScanner.gen.kt) over QRScannerView.
//  The channel has one event and no call: "scan" { data }, data null when the code leaves the
//  frame.
//

package io.letary.lecodes.plugins.qrscanner

import android.content.Context
import io.letary.lecodes.LecodesEngine

object LeCodesQRScannerPlugin {

    const val PLUGIN_ID = "qr-scanner"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        QRScannerChannel.register(engine) { _, events -> Scanner(appContext, events) }
    }
}

private class Scanner(context: Context, events: QRScannerEvents) : QRScannerPlugin {
    override val view: android.view.View = QRScannerView(context, onOpen = {}, onData = { data -> events.scan(data = data) })
}
