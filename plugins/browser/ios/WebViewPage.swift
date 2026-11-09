//
//  WebViewPage.swift — lecodes-plugins/browser
//
//  The ONE page behind both surfaces of the embedded web view (contract.d.ts): the fullscreen view
//  "webView" (WebViewInstance) and the host node "webView" (WebViewNodeInstance, a box of a screen's
//  layout — BrowserPlugin.swift) each wrap a WebViewPage — a WKWebView with the three rules the
//  contract gives a host: a main-frame navigation that starts with a stop prefix is cancelled and
//  reported, a non-web scheme goes to the system (or is dropped), the bridge is installed only when
//  asked (a user script disables Apple Pay in the view). The surfaces differ only in how the page is
//  made and changed: the View's params are read once, at creation; the node's live props are
//  `open`, `stops` and `openExternal` below.
//
//  The calls are the contract's WebViewMethods, one set for both surfaces: generic over the
//  surface's generated code enum (PageCode), so each instance forwards them as they come. The events
//  go through the surface's generated events struct (PageEventSink).
//
//  Threading: WebKit is main-thread-only, and so is every call the app makes.
//

import UIKit
import WebKit
import LeCodes

/// The codes the page's calls reject with — the contract's WebViewMethods, the same for both
/// surfaces: each surface's generated enum has them as cases.
protocol PageCode: PluginCode {
    static var invalid: Self { get }
    static var failed: Self { get }
}
extension WebViewCode: PageCode {}
extension UIWebViewNodeCode: PageCode {}

/// What the page tells the app — the contract's WebViewEvents: each surface's generated events struct.
protocol PageEventSink {
    func navigate(url: String)
    func load(url: String, title: String)
    func error(url: String, message: String)
    func stop(url: String)
    func message(data: Any)
    func exit()
}
extension WebViewEvents: PageEventSink {}
extension UIWebViewNodeEvents: PageEventSink {}

final class WebViewPage: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    private static let webSchemes: Set<String> = ["http", "https", "about", "data", "blob", "file", "javascript"]
    private static let bridgeScript = """
    window.lecodes = { postMessage: function (d) { window.webkit.messageHandlers.lecodes.postMessage(JSON.stringify(d === undefined ? null : d)) }, onMessage: null };
    """

    private let events: PageEventSink
    let webView: WKWebView
    private let bridge: Bool
    /// A non-web link goes to the system (`externalLinks: "open"`) or is dropped. Live (the node's).
    var openExternal: Bool
    /// The main-frame URL prefixes that end a flow. Live (the node's prop, `setStops`).
    var stops: [String]
    /// A finished page whose title WebKit has not reported yet (see didFinish).
    private var pendingLoad: (url: String, timeout: DispatchWorkItem)?
    private var titleObservation: NSKeyValueObservation?

    /// The page as the View's params (or the node's first props, the same fields) say: the
    /// configuration WKWebView is made with (`bridge`, `userAgent`, `ephemeral`), the rules, the
    /// first page.
    init(_ params: WebViewParams, _ events: PageEventSink) {
        self.events = events
        bridge = params.bridge ?? false
        openExternal = params.externalLinks != .block
        stops = params.stops ?? []

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        if params.ephemeral ?? false { config.websiteDataStore = .nonPersistent() }
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        if bridge {
            config.userContentController.addUserScript(WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            config.userContentController.add(WeakScriptHandler(self), name: "lecodes")
        }
        if let userAgent = params.userAgent { webView.customUserAgent = userAgent }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        titleObservation = webView.observe(\.title) { [weak self] webView, _ in
            guard let self, self.pendingLoad != nil, !(webView.title ?? "").isEmpty else { return }
            self.flushLoad()
        }
        if let url = params.url { open(url) }
    }

    /// Load `url` as the first page, or as the node's `url` prop written later.
    func open(_ url: String) {
        if let target = URL(string: url) { webView.load(URLRequest(url: target)) }
    }

    // MARK: - WebViewMethods

    func load<C: PageCode>(_ url: String, _ headers: [String: String]?, _ reply: Reply<Void, C>) {
        guard let target = URL(string: url), let scheme = target.scheme?.lowercased(), Self.webSchemes.contains(scheme) else {
            return reply.reject(.invalid)
        }
        var request = URLRequest(url: target)
        for (name, value) in headers ?? [:] { request.setValue(value, forHTTPHeaderField: name) }
        webView.load(request)
        reply.resolve()
    }

    func loadHtml<C: PageCode>(_ html: String, _ baseUrl: String?, _ reply: Reply<Void, C>) {
        webView.loadHTMLString(html, baseURL: baseUrl.flatMap(URL.init(string:)))
        reply.resolve()
    }

    func setStops<C: PageCode>(_ stops: [String], _ reply: Reply<Void, C>) {
        self.stops = stops
        reply.resolve()
    }

    func reload<C: PageCode>(_ reply: Reply<Void, C>) { webView.reload(); reply.resolve() }
    func stopLoading<C: PageCode>(_ reply: Reply<Void, C>) { webView.stopLoading(); reply.resolve() }
    func goBack<C: PageCode>(_ reply: Reply<Void, C>) { webView.goBack(); reply.resolve() }
    func goForward<C: PageCode>(_ reply: Reply<Void, C>) { webView.goForward(); reply.resolve() }
    func canGoBack<C: PageCode>(_ reply: Reply<Bool, C>) { reply.resolve(webView.canGoBack) }

    func evaluate<C: PageCode>(_ js: String, _ reply: Reply<Any, C>) {
        webView.evaluateJavaScript(js) { result, error in
            if error != nil { return reply.reject(.failed) }
            reply.resolve(result ?? NSNull())
        }
    }

    func postMessage<C: PageCode>(_ data: Any, _ reply: Reply<Void, C>) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: data, options: [.fragmentsAllowed]),
              let json = String(data: bytes, encoding: .utf8) else { return reply.reject(.failed) }
        webView.evaluateJavaScript("window.lecodes && window.lecodes.onMessage && window.lecodes.onMessage(\(json))") { _, _ in }
        reply.resolve()
    }

    func clearData<C: PageCode>(_ reply: Reply<Void, C>) {
        let store = webView.configuration.websiteDataStore
        store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { reply.resolve() }
    }

    func destroy() {
        pendingLoad?.timeout.cancel()
        pendingLoad = nil
        titleObservation = nil
        if bridge { webView.configuration.userContentController.removeScriptMessageHandler(forName: "lecodes") }
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        let text = url.absoluteString
        let isMain = action.targetFrame?.isMainFrame ?? true
        if isMain { flushLoad() }   // the previous page's `load` before anything of the next one
        if isMain, stops.contains(where: { text.hasPrefix($0) }) {
            events.stop(url: text)
            return decisionHandler(.cancel)
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if !Self.webSchemes.contains(scheme) {
            if openExternal { UIApplication.shared.open(url, options: [:], completionHandler: nil) }
            return decisionHandler(.cancel)
        }
        if isMain { events.navigate(url: text) }
        decisionHandler(.allow)
    }

    /// `load` carries the page's title, which WebKit reports just AFTER didFinish (on iOS 26 `title`
    /// is still empty here): wait for it through the title's KVO, at most `titleWait` (a page with no
    /// title at all).
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        flushLoad()
        let url = webView.url?.absoluteString ?? ""
        if let title = webView.title, !title.isEmpty { return events.load(url: url, title: title) }
        let timeout = DispatchWorkItem { [weak self] in self?.flushLoad() }
        pendingLoad = (url, timeout)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.titleWait, execute: timeout)
    }

    private static let titleWait: TimeInterval = 0.5

    private func flushLoad() {
        guard let pending = pendingLoad else { return }
        pendingLoad = nil
        pending.timeout.cancel()
        events.load(url: pending.url, title: webView.title ?? "")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { report(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { report(error) }

    private func report(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }   // a stop, a new load
        let url = (nsError.userInfo[NSURLErrorFailingURLStringErrorKey] as? String) ?? webView.url?.absoluteString ?? ""
        events.error(url: url, message: nsError.localizedDescription)
    }

    // MARK: - WKUIDelegate

    /// target="_blank": the same view, there is no second window.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil { webView.load(action.request) }
        return nil
    }

    func webViewDidClose(_ webView: WKWebView) { events.exit() }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "lecodes", let text = message.body as? String, let bytes = text.data(using: .utf8),
              let data = try? JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed]) else { return }
        events.message(data: data)
    }
}

/// WKUserContentController retains its handlers: a weak hop so the page can go.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
