// UIWebViewNode — a web page as a NODE of a screen's layout (contract.d.ts: the host node "webView"):
// a box sized by its styles like any element, drawn by the host's web view (WKWebView on iOS,
// android.webkit.WebView on Android; on the web and in headless runs an empty box —
// `UIWebViewNode.supported` is false there). The fullscreen page with widgets over it stays
// `WebView` (browser.ts); `Browser.open(url, { embedded: true })` builds its screen on this node.
//
// Hand-written over the generated element (browser.UIWebView.gen.ts, the class `UIWebViewNode`,
// imported as UIWebViewNodeBase) for the app's shape of it — WebView's minus what only a View has
// (`open` / `close`, `onBack`, `widgets`) and minus the `exit` event (`window.close()` closes nothing
// in a layout; the embedded `Browser.open` still hears it, on the element). browser.ts holds no
// logic the two share — WebView is its generated class as is — so this wrapper is thin:
//   - `url`, `stops`, `externalLinks` are LIVE props: a `url` write loads it, the other two apply to
//     the next navigation;
//   - `bridge`, `userAgent`, `ephemeral` make the platform's web view: read at the node's first
//     commit (the half makes the page then), so they are options of the factory and read-only here
//     (a write that reaches the host later is ignored there, with a log line);
//   - `setStops(stops)` writes the prop too, so the getter answers the stops in force, and settles
//     once the host has them (the call lands after the write: `nodeCall` keeps its place in the
//     commit);
//   - default style `overflow: "hidden"` (the box clips the page to its corners).

import type { HostNodeElement, Json } from "lecodes-sdk/plugin"
import type { WebViewProps } from "../contract"
import { UIWebViewNode as UIWebViewNodeBase, type UIWebViewNodeStyle } from "./browser.UIWebView.gen"

export type { UIWebViewNodeStyle, WebViewProps }

/**
 * A web page as a node of the layout:
 *
 * ```ts
 * const terms = UIWebViewNode({ url: "https://example.com/terms" }).style({ height: 300, borderRadius: 12 })
 * UIScreen(UIText("Terms"), terms, UIButton(UIText("Accept")))
 * ```
 *
 * A box like any element: size it with its styles (a `height`, or `flex: 1` in a column); it
 * measures nothing itself. Its corners follow `borderRadius` (the node clips: `overflow: "hidden"`
 * is its default style). Its calls work from the start — one made right after the factory reaches
 * the page once the node is made. Branch on `UIWebViewNode.supported`: where it is `false` (the
 * web, desktop, headless runs, a build without the `browser` plugin) the node is an empty box.
 */
export interface UIWebViewNode extends HostNodeElement<UIWebViewNodeStyle> {
  /** The page to show — writing it loads it (writing the same URL again reloads it; clearing it
   *  loads nothing). Reads what was written last: the page's own navigations are `onNavigate`. */
  url: string | undefined
  /** URL prefixes that END a flow: a main-frame navigation to one is cancelled and reported as
   *  `onStop`, the page is not loaded. Writing it replaces the list. */
  stops: string[] | undefined
  /** A navigation to a non-web URL (tel:, mailto:, intent:, a bank's app): "open" hands it to the
   *  system (the default), "block" drops it. */
  externalLinks: "open" | "block" | undefined
  /** `window.lecodes` in the page (the `onMessage` event, `postMessage`) — given to the factory,
   *  read when the page is made. */
  readonly bridge: boolean | undefined
  /** Given to the factory, read when the page is made. */
  readonly userAgent: string | undefined
  /** A private session: nothing kept after the node goes — given to the factory, read when the
   *  page is made. */
  readonly ephemeral: boolean | undefined

  /** A main-frame navigation started. */
  onNavigate(callback: (event: { url: string }) => void): this
  /** The page finished loading; `title` is "" when it has none. */
  onLoad(callback: (event: { url: string, title: string }) => void): this
  /** The page failed to load. */
  onError(callback: (event: { url: string, message: string }) => void): this
  /** A URL of `stops` was reached: the navigation was cancelled, the page did not load. */
  onStop(callback: (event: { url: string }) => void): this
  /** The page called `window.lecodes.postMessage(data)` (a node made with `bridge`). */
  onMessage(callback: (event: { data: Json }) => void): this

  /** Load `url`, with extra request headers for the first request. Rejects "invalid" for a URL
   *  that is not a web one. */
  load(url: string, headers?: { [name: string]: string }): Promise<void>
  /** Show `html` as the page; relative URLs in it resolve against `baseUrl`. */
  loadHtml(html: string, baseUrl?: string): Promise<void>
  /** Replace the URL prefixes that end a navigation — the same as writing `stops`; settles once
   *  the host has them. */
  setStops(stops: string[]): Promise<void>
  reload(): Promise<void>
  /** Stop the current load. */
  stopLoading(): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  canGoBack(): Promise<boolean>
  /** Run `js` in the page and get what it evaluates to, as JSON. On iOS this disables Apple Pay
   *  in the page until its next navigation. Rejects "failed". */
  evaluate(js: string): Promise<Json>
  /** Deliver `data` to the page's `window.lecodes.onMessage(data)` (a node made with `bridge`). */
  postMessage(data: Json): Promise<void>
  /** Clear the cookies and the storage of this page's session. */
  clearData(): Promise<void>
}

/** @internal The element the factory builds — `Browser.open({ embedded })` builds it too, and hears
 *  its `exit` (the public interface has none). */
export class WebViewNodeElement extends UIWebViewNodeBase {
  constructor(props: WebViewProps = {}) {
    super(props)
    this.style({ overflow: "hidden" })
  }

  override setStops(stops: string[]): Promise<void> {
    this.stops = stops
    return super.setStops(stops)
  }
}

/**
 * Create a web page node — see {@link UIWebViewNode}. `bridge`, `userAgent` and `ephemeral` are
 * read when the page is made; default style `overflow: "hidden"`.
 */
// PURE IIFE so an app that never builds a web page node tree-shakes it away.
export const UIWebViewNode: {
  (props?: WebViewProps): UIWebViewNode
  /** Does this host draw the web page node (iOS and Android with the `browser` plugin)? Read at run
   *  time, on every access. */
  readonly supported: boolean
} = /*#__PURE__*/ (() => {
  const factory = (props: WebViewProps = {}): UIWebViewNode => new WebViewNodeElement(props) as unknown as UIWebViewNode
  Object.defineProperty(factory, "supported", { get: (): boolean => UIWebViewNodeBase.supported })
  return factory as any
})()
