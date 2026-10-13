//
//  WebViewPage.swift — lecodes-plugins/browser
//
//  The "webView" view: a WKWebView the host mounts (fullscreen or among a screen's children) with
//  the three rules the contract gives a host — a main-frame navigation that starts with a stop
//  prefix is cancelled and reported, a non-web scheme goes to the system (or is dropped), the
//  bridge is installed only when asked (a user script disables Apple Pay in the view).
//

import UIKit
import WebKit
import LeCodes

final class WebViewPage: NSObject, WebViewPlugin, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    private static let webSchemes: Set<String> = ["http", "https", "about", "data", "blob", "file", "javascript"]
    private static let bridgeScript = """
    window.lecodes = { postMessage: function (d) { window.webkit.messageHandlers.lecodes.postMessage(JSON.stringify(d === undefined ? null : d)) }, onMessage: null };
    """

    private let events: WebViewEvents
    private let webView: WKWebView
    private let bridge: Bool
    private let openExternal: Bool
    private var stops: [String]
    /// A finished page whose title WebKit has not reported yet (see didFinish).
    private var pendingLoad: (url: String, timeout: DispatchWorkItem)?
    private var titleObservation: NSKeyValueObservation?

    var view: UIView { webView }

    init(_ params: WebViewParams, _ events: WebViewEvents) {
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
        if let url = params.url, let target = URL(string: url) { webView.load(URLRequest(url: target)) }
    }

    // MARK: - WebViewPlugin

    func load(_ url: String, _ headers: [String: String]?, _ reply: Reply<Void, WebViewCode>) {
        guard let target = URL(string: url), let scheme = target.scheme?.lowercased(), Self.webSchemes.contains(scheme) else {
            return reply.reject(.invalid)
        }
        var request = URLRequest(url: target)
        for (name, value) in headers ?? [:] { request.setValue(value, forHTTPHeaderField: name) }
        webView.load(request)
        reply.resolve()
    }

    func loadHtml(_ html: String, _ baseUrl: String?, _ reply: Reply<Void, WebViewCode>) {
        webView.loadHTMLString(html, baseURL: baseUrl.flatMap(URL.init(string:)))
        reply.resolve()
    }

    func setStops(_ stops: [String], _ reply: Reply<Void, WebViewCode>) {
        self.stops = stops
        reply.resolve()
    }

    func reload(_ reply: Reply<Void, WebViewCode>) { webView.reload(); reply.resolve() }
    func stopLoading(_ reply: Reply<Void, WebViewCode>) { webView.stopLoading(); reply.resolve() }
    func goBack(_ reply: Reply<Void, WebViewCode>) { webView.goBack(); reply.resolve() }
    func goForward(_ reply: Reply<Void, WebViewCode>) { webView.goForward(); reply.resolve() }
    func canGoBack(_ reply: Reply<Bool, WebViewCode>) { reply.resolve(webView.canGoBack) }

    func evaluate(_ js: String, _ reply: Reply<Any, WebViewCode>) {
        webView.evaluateJavaScript(js) { result, error in
            if error != nil { return reply.reject(.failed) }
            reply.resolve(result ?? NSNull())
        }
    }

    func postMessage(_ data: Any, _ reply: Reply<Void, WebViewCode>) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: data, options: [.fragmentsAllowed]),
              let json = String(data: bytes, encoding: .utf8) else { return reply.reject(.failed) }
        webView.evaluateJavaScript("window.lecodes && window.lecodes.onMessage && window.lecodes.onMessage(\(json))") { _, _ in }
        reply.resolve()
    }

    func clearData(_ reply: Reply<Void, WebViewCode>) {
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
