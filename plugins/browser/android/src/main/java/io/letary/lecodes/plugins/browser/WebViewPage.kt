//
//  WebViewPage.kt — lecodes-plugins/browser
//
//  The "webView" view: an android.webkit.WebView the host mounts (fullscreen or among a screen's
//  children) with the three rules the contract gives a host — a main-frame navigation that starts
//  with a stop prefix is cancelled and reported, a non-web scheme goes to the system (an `intent:`
//  URL through its own intent, a bank's app in a checkout) or is dropped, the bridge is installed
//  only when asked.
//
//  The stop rule has ONE decision point (`stopAt`) and two hooks into it: shouldOverrideUrlLoading
//  for what the page navigates to, shouldInterceptRequest for the main-frame requests that hook
//  never sees — a POST (a form back to the return URL, a 3DS TermUrl) and the view's own loads (an
//  intent's browser_fallback_url). Intercepted, the request is answered 204 in place: nothing is
//  sent, the page stays, as WKWebView's cancelled navigation does.
//
//  The bridge is a document-start script (androidx.webkit), so a page's own scripts find
//  window.lecodes, main frame only — the twin of the iOS WKUserScript. A WebView too old for it
//  gets the script evaluated at page start and finish (late for the page's load handlers).
//

package io.letary.lecodes.plugins.browser

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import io.letary.lecodes.services.Reply
import java.io.ByteArrayInputStream
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

class WebViewPage(
    private val context: Context,
    params: WebViewParams,
    private val events: WebViewEvents,
) : WebViewPlugin {

    private companion object {
        val WEB_SCHEMES = setOf("http", "https", "about", "data", "blob", "file", "javascript")
        const val BRIDGE_SCRIPT = "if (window === window.top) window.lecodes = window.lecodes || { postMessage: function (d) { __lecodesBridge.postMessage(JSON.stringify(d === undefined ? null : d)) }, onMessage: null };"
    }

    private val web = WebView(context)
    private val bridge = params.bridge == true
    private val openExternal = params.externalLinks != WebViewParamsExternalLinks.BLOCK
    private val ephemeral = params.ephemeral == true
    /** Read on the network thread too (shouldInterceptRequest). */
    @Volatile private var stops: List<String> = params.stops ?: emptyList()
    /** The bridge goes in at document start (else it is evaluated at page start and finish). */
    private val documentStart = bridge && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

    override val view: android.view.View get() = web

    private inner class Bridge {
        @JavascriptInterface
        fun postMessage(json: String) {
            val value = runCatching { JSONTokener(json).nextValue() }.getOrNull() ?: return
            web.post { events.message(value) }
        }
    }

    init {
        @SuppressLint("SetJavaScriptEnabled")
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.settings.setSupportMultipleWindows(false)
        web.settings.javaScriptCanOpenWindowsAutomatically = false
        params.userAgent?.let { web.settings.userAgentString = it }
        if (bridge) {
            web.addJavascriptInterface(Bridge(), "__lecodesBridge")
            if (documentStart) WebViewCompat.addDocumentStartJavaScript(web, BRIDGE_SCRIPT, setOf("*"))
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (request.isForMainFrame && stopAt(url)) return true
                val scheme = request.url.scheme?.lowercase() ?: ""
                if (scheme !in WEB_SCHEMES) {
                    if (openExternal) external(request.url)
                    return true
                }
                return false
            }

            // The main-frame requests shouldOverrideUrlLoading is not asked about: a POST, a load of
            // the view's own. On the network thread; a stop is answered 204, which commits nothing.
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (!request.isForMainFrame) return null
                val url = request.url.toString()
                if (stops.none { url.startsWith(it) }) return null
                web.post { stopAt(url) }
                return WebResourceResponse("text/plain", "utf-8", 204, "No Content", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                if (bridge && !documentStart) view.evaluateJavascript(BRIDGE_SCRIPT, null)
                events.navigate(url)
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (bridge && !documentStart) view.evaluateJavascript(BRIDGE_SCRIPT, null)
                // The document's own title: WebView.getTitle() is the URL for a page without one
                // (WKWebView's is "", and the SDK's bar keeps its own title then).
                view.evaluateJavascript("document.title") { json ->
                    val title = runCatching { JSONTokener(json ?: "null").nextValue() as? String }.getOrNull() ?: ""
                    events.load(url, title)
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) events.error(request.url.toString(), error.description.toString())
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onCloseWindow(window: WebView) { events.exit() }
        }

        params.url?.let { url -> if (acceptable(url)) web.loadUrl(url) }
    }

    /** THE stop rule: `url` ends the flow — report it; the caller cancels the navigation. */
    private fun stopAt(url: String): Boolean {
        if (stops.none { url.startsWith(it) }) return false
        events.stop(url)
        return true
    }

    private fun acceptable(url: String): Boolean =
        runCatching { Uri.parse(url).scheme?.lowercase() }.getOrNull() in WEB_SCHEMES

    /** A non-web link to the system: an `intent:` URL as the intent it encodes (its
     *  browser_fallback_url when nothing takes it), anything else as a view of the URI. */
    private fun external(uri: Uri) {
        val intent = if (uri.scheme.equals("intent", ignoreCase = true)) {
            runCatching { Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME) }.getOrNull() ?: return
        } else Intent(Intent.ACTION_VIEW, uri)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            val fallback = intent.getStringExtra("browser_fallback_url") ?: return
            if (acceptable(fallback)) web.loadUrl(fallback)
        }
    }

    // ---- WebViewPlugin ----

    override fun load(url: String, headers: Map<String, String>?, reply: Reply<Unit, WebViewCode>) {
        if (!acceptable(url)) return reply.reject(WebViewCode.INVALID)
        web.loadUrl(url, headers ?: emptyMap())
        reply.resolve(Unit)
    }

    override fun loadHtml(html: String, baseUrl: String?, reply: Reply<Unit, WebViewCode>) {
        web.loadDataWithBaseURL(baseUrl, html, "text/html", "utf-8", null)
        reply.resolve(Unit)
    }

    override fun setStops(stops: List<String>, reply: Reply<Unit, WebViewCode>) {
        this.stops = stops
        reply.resolve(Unit)
    }

    override fun reload(reply: Reply<Unit, WebViewCode>) { web.reload(); reply.resolve(Unit) }
    override fun stopLoading(reply: Reply<Unit, WebViewCode>) { web.stopLoading(); reply.resolve(Unit) }
    override fun goBack(reply: Reply<Unit, WebViewCode>) { if (web.canGoBack()) web.goBack(); reply.resolve(Unit) }
    override fun goForward(reply: Reply<Unit, WebViewCode>) { if (web.canGoForward()) web.goForward(); reply.resolve(Unit) }
    override fun canGoBack(reply: Reply<Boolean, WebViewCode>) { reply.resolve(web.canGoBack()) }

    override fun evaluate(js: String, reply: Reply<Any, WebViewCode>) {
        web.evaluateJavascript(js) { json ->
            // The result comes as JSON text ("null" for undefined and null); a parse failure is a
            // value the page could not serialize.
            val value = runCatching { JSONTokener(json ?: "null").nextValue() }.getOrNull()
            if (value == null) reply.reject(WebViewCode.FAILED) else reply.resolve(value)
        }
    }

    override fun postMessage(data: Any, reply: Reply<Unit, WebViewCode>) {
        val json = when (data) {
            is JSONObject, is JSONArray -> data.toString()
            is String -> JSONObject.quote(data)
            else -> data.toString()   // a number, a boolean, JSONObject.NULL
        }
        web.evaluateJavascript("window.lecodes && window.lecodes.onMessage && window.lecodes.onMessage($json)", null)
        reply.resolve(Unit)
    }

    override fun clearData(reply: Reply<Unit, WebViewCode>) {
        clear()
        reply.resolve(Unit)
    }

    override fun destroy() {
        web.stopLoading()
        if (ephemeral) clear()
        web.destroy()
    }

    private fun clear() {
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        WebStorage.getInstance().deleteAllData()
        web.clearCache(true)
        web.clearHistory()
    }
}
