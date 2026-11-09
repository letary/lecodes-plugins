// browser — web content inside the app, on the two surfaces the platforms give:
//   - the SYSTEM SHEET (the "browser" service): SFSafariViewController / ASWebAuthenticationSession on
//     iOS, Chrome Custom Tabs on Android, a popup on the web. It shares the system browser's logins,
//     passkeys and Apple Pay, and OAuth providers accept it. The app sees nothing of the page.
//   - the EMBEDDED PAGE: WKWebView / android.webkit.WebView / an iframe, with navigation events the
//     app acts on, on two surfaces with one set of methods (WebViewMethods): the fullscreen VIEW
//     "webView" (`WebView`: its own layer, `Router.push`, widgets over it) and the HOST NODE
//     "webView" (`UIWebViewNode`: a box in a screen's layout, docs/plans/host-node-plan.md in core).
//     On every platform both are one page class under two thin instances — on the web an <iframe>,
//     the node's on Web Lite (the web player draws no host node: an empty box there).
//
// The hosts are dumb on purpose: they intercept a URL prefix and report it, forward the platform's
// callback URL, hand a non-http link to the system. Which URL ends a flow and what it means is the
// app's side (`Browser.open` in sdk/).

import type { Json, Service, UIHostNode, View } from "lecodes-sdk/plugin"

// ---- the sheet ------------------------------------------------------------------------------------

export interface BrowserParams {}

export interface BrowserOpenOptions {
  /** An auth flow: the scheme the provider redirects back to (`myshop` of `myshop://oauth`). iOS
   *  runs an ASWebAuthenticationSession and resolves `open` with the callback URL itself. Android
   *  and the web have nothing to do here: the redirect reaches the app as its "url" event. */
  callbackScheme?: string
  /** A private session: no cookies shared with the system browser. Honored on iOS (with a
   *  callbackScheme), ignored elsewhere. Default false. */
  ephemeral?: boolean
  /** The sheet's tint, "#RRGGBB". */
  color?: string
}

export interface BrowserResult {
  /** The callback URL the platform intercepted (iOS, with a callbackScheme); absent when the sheet
   *  was dismissed. */
  url?: string
}

export interface BrowserEvents {
  /** The sheet went away: the user dismissed it, the platform handed back the callback, or
   *  close(). */
  closed: void
}

export interface Browser extends Service<"browser", BrowserParams, BrowserEvents> {
  /** Show `url` in the system's in-app browser sheet. Resolves when the sheet is dismissed — with
   *  the callback URL when the platform intercepted one. One sheet at a time.
   *  @rejects busy invalid */
  show(url: string, options?: BrowserOpenOptions): Promise<BrowserResult>
  /** Dismiss the sheet; a no-op without one. */
  dismiss(): Promise<void>
}

// ---- the embedded page ----------------------------------------------------------------------------

export interface WebViewParams {
  /** What to load first. */
  url?: string
  /** Main-frame URLs that END a flow: a navigation whose URL starts with one is NOT loaded, the
   *  view emits `stop` instead. */
  stops?: string[]
  /** Install `window.lecodes.postMessage(data)` for the page (the `message` event) and let
   *  `postMessage` reach it (`window.lecodes.onMessage`). Default false — a user script disables
   *  Apple Pay in that WKWebView, so a checkout page wants it off. */
  bridge?: boolean
  /** A navigation to a non-http(s) URL — tel:, mailto:, intent:, a bank's app in a checkout:
   *  "open" hands it to the system, "block" drops it. Default "open". */
  externalLinks?: "open" | "block"
  userAgent?: string
  /** A private session: no cookies or storage kept after the view goes. Default false. */
  ephemeral?: boolean
}

export interface WebViewEvents {
  /** A main-frame navigation started. */
  navigate: { url: string }
  /** The page finished loading. */
  load: { url: string, title: string }
  /** The page failed to load. */
  error: { url: string, message: string }
  /** A stop URL was reached: the navigation was cancelled, the page did not load. */
  stop: { url: string }
  /** The page called `window.lecodes.postMessage(data)` (with `bridge`). */
  message: { data: Json }
  /** The page called `window.close()`. */
  exit: void
}

/** The methods of both surfaces: the View's and the node's, one implementation per platform. */
export interface WebViewMethods {
  /** Load `url`, with extra request headers for the first request. @rejects invalid */
  load(url: string, headers?: { [name: string]: string }): Promise<void>
  /** Show `html` as the page; relative URLs in it resolve against `baseUrl`. */
  loadHtml(html: string, baseUrl?: string): Promise<void>
  /** Replace the stop list (see WebViewParams.stops). */
  setStops(stops: string[]): Promise<void>
  reload(): Promise<void>
  /** Stop the current load. */
  stopLoading(): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  canGoBack(): Promise<boolean>
  /** Run `js` in the page and return what it evaluates to, as JSON. On iOS this disables Apple Pay
   *  in the view until its next navigation. @rejects failed */
  evaluate(js: string): Promise<Json>
  /** Deliver `data` to the page's `window.lecodes.onMessage(data)` (with `bridge`). */
  postMessage(data: Json): Promise<void>
  /** Clear the cookies and the storage of this view's session. */
  clearData(): Promise<void>
}

/** The node's props: the View's params. `url`, `stops` and `externalLinks` are LIVE — a `url` write
 *  loads it (the props one commit writes land together: one load), a `stops` write is `setStops`,
 *  an `externalLinks` write applies to the next link. `bridge`, `userAgent` and `ephemeral` make the
 *  platform's web view (WKWebView's configuration): read at the node's first commit, the view made
 *  then — a later write of one is ignored, with a warning in the host's log. */
export interface WebViewProps {
  /** What to load; a write loads it (clearing it loads nothing). */
  url?: string
  /** Main-frame URLs that END a flow: a navigation whose URL starts with one is NOT loaded, the
   *  node emits `stop` instead. */
  stops?: string[]
  /** Install `window.lecodes.postMessage(data)` for the page (the `message` event) and let
   *  `postMessage` reach it (`window.lecodes.onMessage`). Default false — a user script disables
   *  Apple Pay in that WKWebView, so a checkout page wants it off. At creation only. */
  bridge?: boolean
  /** A navigation to a non-http(s) URL — tel:, mailto:, intent:, a bank's app in a checkout:
   *  "open" hands it to the system, "block" drops it. Default "open". */
  externalLinks?: "open" | "block"
  /** At creation only. */
  userAgent?: string
  /** A private session: no cookies or storage kept after the node goes. Default false. At creation
   *  only. */
  ephemeral?: boolean
}

export interface WebView extends View<"webView", WebViewParams, WebViewEvents>, WebViewMethods {}

/** The page as a node of the layout: a box in a screen, sized by its styles, drawn by the host's web
 *  view; the holder paints the box (radius, border, shadow) over it. */
export interface UIWebView extends UIHostNode<"webView", WebViewProps, WebViewEvents>, WebViewMethods {}
