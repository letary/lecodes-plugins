// Browser.open — a URL on the surface the scenario needs, ONE verb for the three of them:
//
//   await Browser.open(url)                                        a page, in the system sheet
//   const back = await Browser.open(authUrl, { returnUrl: "myshop://oauth" })      OAuth: the sheet,
//                                                                  resolved with the redirect URL
//   const back = await Browser.open(checkoutUrl, { returnUrl: [paid, failed], embedded: true })
//                                                                  a checkout in an embedded page,
//                                                                  resolved with the URL it reached
//                                                                  (navigated to in the page, or
//                                                                  opened by a bank's app through
//                                                                  the app's verified link)
//
// It resolves with the return URL reached, or null when the user left. `returnUrl` says what ENDS
// the page; `embedded` says WHERE it runs — the system sheet (shared logins, passkeys, Apple Pay;
// the only surface OAuth providers accept) or an embedded page in a screen under a bar the SDK draws
// (an https return without verified app links, a 3DS flow, no system chrome).
//
// Hand-written over the generated wire because the flows are the SDK's, not the hosts':
//   - the sheet's return is ONE of two paths — iOS intercepts the scheme itself and resolves `show`
//     with the URL, Android and the web deliver the redirect as the app's "url" event. The wrapper
//     races both and the host does nothing it would not do for a plain deep link;
//   - the embedded flow is a UIWebViewNode (webViewNode.ts) with the return URLs as its `stops`, at
//     `flex: 1` in a screen under a close bar, pushed through the Router when one is showing and
//     opened directly otherwise — on iOS, Android and the web (Web Lite: an <iframe>, which sees
//     the stop URL only when it is on the app's own origin). A host that draws no such node (the
//     web player, desktop, a headless run) rejects it: a View is a destination, never a part of a
//     screen, so there is no embedded View to fall back on.
//
// WebView() is the fullscreen page: push it with your own chrome over it (`widgets`), drive it
// (`load`, `evaluate`, `postMessage`) and listen (`navigate`, `load`, `stop`, `message`). A page
// that is a part of a screen is a UIWebViewNode.

import {
  Presentable, Router, UIBox, UIButton, UIRow, UIScreen, UIText, theme, _onAppUrl, type Json, type Listener, type NativeView,
} from "lecodes-sdk/plugin"
import { BrowserBase, NAME as SHEET_NAME } from "./browser.Browser.gen"
import { WebViewBase, NAME as VIEW_NAME, supports as viewSupports, type Method as WebViewMethod } from "./browser.WebView.gen"
import { WebViewNodeElement } from "./webViewNode"
import type { WebViewEvents, WebViewParams, WebViewProps } from "../contract"

export type { WebViewEvents, WebViewParams } from "../contract"

export interface BrowserOpenOptions {
  /** What ends the page: a URL prefix, or several (a checkout's success and failure URLs). The
   *  promise resolves with the URL reached. In the sheet every prefix must share one scheme — the
   *  platform intercepts one; a custom scheme needs app.json `urlScheme`, an https one the app's
   *  verified links (app.json `appLinks`). Embedded, the view intercepts the navigation itself,
   *  and a verified https return from another app (a bank's) ends the page too. */
  returnUrl?: string | string[]
  /** Run the page in an embedded web page (a `UIWebViewNode`) in a screen under a close bar
   *  instead of the system sheet. The page intercepts any return URL itself, https included. */
  embedded?: boolean
  /** A private session: no cookies shared with the system browser, nothing kept after. */
  ephemeral?: boolean
  /** The sheet's tint, "#RRGGBB". */
  color?: string
  /** Embedded: the bar's title until the page reports its own. */
  title?: string
}

/** The fullscreen page — the element of the "webView" view: presentable (`open()`, `Router.push`)
 *  with widgets over it, with the page's controls and events. A page that is a part of a screen is
 *  a `UIWebViewNode`. */
export interface WebView extends NativeView {
  /** Load `url`, with extra request headers for the first request. Rejects "invalid" for a URL
   *  that is not a web one. */
  load(url: string, headers?: { [name: string]: string }): Promise<void>
  /** Show `html` as the page; relative URLs in it resolve against `baseUrl`. */
  loadHtml(html: string, baseUrl?: string): Promise<void>
  /** Replace the URL prefixes that end a navigation with the `stop` event. */
  setStops(stops: string[]): Promise<void>
  reload(): Promise<void>
  /** Stop the current load. */
  stopLoading(): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  canGoBack(): Promise<boolean>
  /** Run `js` in the page and get what it evaluates to, as JSON. On iOS this disables Apple Pay
   *  in the view until its next navigation. */
  evaluate(js: string): Promise<Json>
  /** Deliver `data` to the page's `window.lecodes.onMessage(data)` (a view created with `bridge`). */
  postMessage(data: Json): Promise<void>
  /** Clear the cookies and the storage of this view's session. */
  clearData(): Promise<void>
  /** The page's events: `navigate`, `load`, `error`, `stop`, `message`, `exit`. */
  on<K extends keyof WebViewEvents & string>(event: K, callback: Listener<WebViewEvents, K>): this
  off<K extends keyof WebViewEvents & string>(event: K, callback: Listener<WebViewEvents, K>): this
}

const returnUrls = (options: BrowserOpenOptions): string[] =>
  options.returnUrl === undefined ? [] : Array.isArray(options.returnUrl) ? options.returnUrl : [options.returnUrl]

const matching = (url: string, prefixes: string[]): string | undefined =>
  prefixes.some(p => url.startsWith(p)) ? url : undefined

const schemeOf = (url: string): string => {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url)
  return m ? m[1]!.toLowerCase() : ""
}

const unsupported = (what: string, registered: string): Error =>
  new Error(`${what} isn't available on this host — it needs the "browser" plugin (app.json "plugins"), a registered ${registered}.`)

// ---- the sheet -------------------------------------------------------------------------------------

let sheet: BrowserBase | null = null
const service = (): BrowserBase => sheet ??= new BrowserBase()

const openSheet = (url: string, options: BrowserOpenOptions): Promise<string | null> => new Promise((resolve, reject) => {
  if (!BrowserBase.supports(SHEET_NAME)) return reject(unsupported("Browser.open", `"${SHEET_NAME}" service`))
  const stops = returnUrls(options)
  const schemes = new Set(stops.map(schemeOf))
  if (schemes.size > 1) return reject(new Error("Browser.open: every returnUrl must share one scheme — the platform intercepts one."))
  const scheme = stops.length ? [...schemes][0]! : ""
  const wire: { callbackScheme?: string, ephemeral?: boolean, color?: string } = {}
  // A custom scheme is what a platform can intercept; an https return is the app's verified link,
  // which reaches it as a "url" event like any deep link.
  if (scheme && scheme !== "http" && scheme !== "https") wire.callbackScheme = scheme
  if (options.ephemeral) wire.ephemeral = true
  if (options.color) wire.color = options.color

  let done = false
  const off = stops.length ? _onAppUrl(back => {
    if (!matching(back, stops)) return
    finish(back)
    service().dismiss().catch(() => {})
  }) : () => {}
  const finish = (back: string | null): void => {
    if (done) return
    done = true
    off()
    resolve(back)
  }
  service().show(url, wire).then(
    result => finish(result?.url ?? null),
    error => { if (done) return; done = true; off(); reject(error) },
  )
})

// ---- the embedded page ----------------------------------------------------------------------------

const openEmbedded = (url: string, options: BrowserOpenOptions): Promise<string | null> => new Promise((resolve, reject) => {
  // The page is the host node, a box of the screen's layout (iOS, Android, Web Lite). A host that
  // draws no "webView" node — the web player, desktop, a headless run — has no page inside a screen.
  if (!WebViewNodeElement.supported) return reject(unsupported("Browser.open({ embedded: true })", `"${VIEW_NAME}" node — this host draws none (the web player, desktop and headless runs have no host nodes): use the sheet there, or push a fullscreen WebView`))
  const stops = returnUrls(options)
  const props: WebViewProps = { url, stops }
  if (options.ephemeral) props.ephemeral = true
  const node = new WebViewNodeElement(props)
  const page = node.style({ flex: 1 })

  const title = UIText(options.title ?? "")
    .style({ flex: 1, fontSize: 16, fontWeight: "600", color: theme.text, textAlign: "center", lineClamp: 1 })
  const close = UIButton(UIText("✕").style({ fontSize: 20, color: theme.text }))
    .style({ width: 44, height: 44, alignItems: "center", justifyContent: "center" })
  const bar = UIRow(close, title, UIBox().style({ width: 44 }))
    .style({ pt: "safe-top", alignItems: "center", bgColor: theme.surface, borderBottomWidth: 1, borderColor: theme.border })
  const screen = UIScreen(bar, page).style({ bgColor: theme.bg })

  // Where it goes: onto the Router when its page is what is on screen, else in place of what is —
  // and back to it after.
  const previous = Presentable.current
  const routed = previous !== null && previous === Router.current
  let left = false
  const leave = (): void => {
    if (left) return
    left = true
    if (routed) Router.pop()
    else { screen.close(); previous?.open() }
  }
  // Two ways the return URL arrives: the page navigates to it inside the view (`stop`), or
  // another app does — a bank's app the checkout handed off to sends the person back through the
  // app's verified link (app.json "appLinks"), which reaches the app as its "url" event while the
  // page still shows the bank's form. Both end the flow; `done` makes the second a no-op.
  let done = false
  const off = stops.length ? _onAppUrl(back => { if (matching(back, stops)) finish(back) }) : () => {}
  const finish = (back: string | null): void => {
    if (done) return
    done = true
    off()
    leave()
    resolve(back)
  }
  const stopped = ({ url: back }: { url: string }): void => finish(back)
  const exited = (): void => finish(null)   // the page called window.close()
  const loaded = ({ title: shown }: { title: string }): void => { if (shown) title.text = shown }
  node.onStop(stopped).onExit(exited).onLoad(loaded)
  close.onClick(() => finish(null))
  screen.onBack(() => finish(null))
  // Gone by another hand (the back swipe popped it, another destination replaced it): the flow is
  // over and there is nothing left to leave.
  screen.onClose(() => { left = true; finish(null) })

  if (routed) Router.push(screen)
  else screen.open()
})

// ---- the app's side -------------------------------------------------------------------------------

/**
 * Web content inside the app. `Browser.isSupported` reports whether this host registered the
 * system sheet; `UIWebViewNode.supported` the page inside a screen (what `embedded` builds),
 * `WebView.isSupported` the fullscreen page.
 */
// PURE IIFE so an app that never opens a page tree-shakes the whole plugin away.
export const Browser: {
  /** Whether this host registered the "browser" service — the system sheet. */
  readonly isSupported: boolean
  /** Open `url`: in the system sheet, or (`embedded`) in a screen of a close bar over a
   *  `UIWebViewNode`. Resolves with the return URL reached (`returnUrl`), or null when the user
   *  left. */
  open(url: string, options?: BrowserOpenOptions): Promise<string | null>
} = /*#__PURE__*/ (() => {
  const browser = {
    open: (url: string, options: BrowserOpenOptions = {}): Promise<string | null> =>
      options.embedded ? openEmbedded(url, options) : openSheet(url, options),
  }
  Object.defineProperty(browser, "isSupported", { get: (): boolean => BrowserBase.supports(SHEET_NAME) })
  return browser as any
})()

/**
 * Create a fullscreen page (push it, or open it). `WebView.isSupported` reports whether this host
 * has the capability — check it before offering the feature. A page inside a screen is
 * `UIWebViewNode`.
 */
// PURE IIFE so an app that never shows a page tree-shakes the view away.
export const WebView: {
  (params?: WebViewParams): WebView
  /** Whether this host registered a "webView" view. */
  readonly isSupported: boolean
  /** Whether the host's half has `method`: false on a host whose half is older than it. */
  supports(method: WebViewMethod): boolean
} = /*#__PURE__*/ (() => {
  const factory = (params?: WebViewParams): WebView => new WebViewBase(params) as unknown as WebView
  Object.defineProperty(factory, "isSupported", { get: (): boolean => viewSupports() })
  factory.supports = viewSupports
  return factory as any
})()
