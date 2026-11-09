// browser on the web: the sheet is a POPUP window, the embedded page an <iframe> — ONE page class
// (WebViewPage) behind the fullscreen View's instance and the host node's half (`UIWebViewNode`,
// Web Lite's `hostnode` feature), as on iOS and Android.
//
// What the browser allows is less than the native halves: a popup cannot be navigated to a custom
// scheme and a cross-origin iframe hides its navigations. So the sheet resolves with a URL only
// when the popup lands back on the page's own origin, and the iframe reports `navigate` / `load` /
// `stop` / the bridge only for same-origin pages. Of a cross-origin page nothing can be known: not
// where it navigated (a `load` reports the URL that was asked for, with no title), not its links (so
// `externalLinks` cannot act on them — the browser hands a tel: / mailto: link of its own to the
// system), not that it reached a stop URL — a stop URL on the web must be on the app's own origin.
// `userAgent` cannot be set for a frame (ignored); `ephemeral` is the frame's `credentialless`
// (a frame with storage of its own that ends with it — Chromium; elsewhere the attribute is
// ignored); `clearData` clears nothing (the frame's storage is its origin's). A checkout or an OAuth
// flow on the web wants the sheet with a return on the app's origin — see
// docs/plans/web-app-origin-plan.md.
//
// The channel is the contract's (../contract.d.ts): browser.gen.ts is generated from it, this file
// implements its BrowserPlugin, WebViewPlugin and UIWebViewNodeHalf.

import {
  BrowserError, WebViewError, registerBrowser, registerUIWebViewNode, registerWebView,
  type BrowserPlugin, type BrowserResult, type Json, type PluginHost, type UIWebViewNodeHalf, type WebViewEvents, type WebViewPlugin,
} from "./browser.gen"

const WEB_SCHEMES = new Set(["http:", "https:", "about:", "data:", "blob:"])

const parse = (url: string, base?: string): URL | null => {
  try { return new URL(url, base) } catch { return null }
}

/** The page's own location when it may be read (same origin), else null. Being readable IS the test:
 *  an about:srcdoc / about:blank page is of the origin that made it, though its URL's origin (what
 *  `location.origin` says) is none. */
const sameOrigin = (win: Window | null): string | null => {
  try { return win ? win.location.href : null } catch { return null }
}

type ExternalLinks = "open" | "block"

/** What a page is made with: the View's params, or the node's props of its first commit. */
interface PageOptions {
  url?: string
  stops?: string[]
  bridge?: boolean
  externalLinks?: ExternalLinks
  ephemeral?: boolean
}

/** The embedded page: an <iframe> filling `el`. `bridge` and `ephemeral` are read here, once — a frame
 *  is made with them; `url`, the stops and `externalLinks` change at any time. */
class WebViewPage {
  private readonly frame: HTMLIFrameElement
  private readonly bridge: boolean
  private stops: string[]
  private externalLinks: ExternalLinks
  private requested: string
  private destroyed = false

  constructor(readonly el: HTMLElement, private readonly doc: Document, private readonly events: WebViewEvents, options: PageOptions) {
    el.style.background = "#fff"
    el.style.overflow = "hidden"
    this.frame = doc.createElement("iframe")
    this.frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0"
    this.frame.setAttribute("allow", "payment *; camera; microphone; geolocation")
    if (options.ephemeral) this.frame.setAttribute("credentialless", "")
    el.appendChild(this.frame)

    this.stops = options.stops ?? []
    this.bridge = options.bridge === true
    this.externalLinks = options.externalLinks ?? "open"
    this.requested = options.url ?? "about:blank"

    window.addEventListener("message", this.onMessage)
    this.frame.addEventListener("load", this.onLoad)
    if (options.url) this.go(options.url)
  }

  private inside(): Window | null { return this.frame.contentWindow }
  private location(): string | null { return sameOrigin(this.inside()) }

  // Cross-origin pages that know the protocol can still talk: `parent.postMessage({ lecodes: data }, "*")`.
  private readonly onMessage = (event: MessageEvent): void => {
    if (event.source !== this.inside()) return
    const data = event.data
    if (data && typeof data === "object" && "lecodes" in data) this.events.message({ data: (data as { lecodes: Json }).lecodes })
  }

  /** A same-origin page: `window.lecodes` (with the bridge) and its links to a non-web scheme. */
  private install(): void {
    const win = this.inside() as (Window & { lecodes?: unknown }) | null
    if (!win || this.location() === null) return
    if (this.bridge && !win.lecodes) {
      win.lecodes = {
        postMessage: (data: Json) => this.events.message({ data }),
        onMessage: null as null | ((data: Json) => void),
      }
    }
    // (read at the click: a later externalLinks write applies to the next link)
    win.document.addEventListener("click", (event) => {
      if (this.externalLinks !== "block") return
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null
      const target = link ? parse(link.href) : null
      if (target && !WEB_SCHEMES.has(target.protocol)) event.preventDefault()
    }, true)
  }

  private readonly onLoad = (): void => {
    if (this.destroyed) return
    const here = this.location()
    if (here !== null) {
      const stopped = this.stops.find(s => here.startsWith(s))
      if (stopped) {
        this.frame.src = "about:blank"
        this.events.stop({ url: here })
        return
      }
      this.install()
      let title = ""
      try { title = this.inside()?.document.title ?? "" } catch { /* not ours */ }
      this.events.load({ url: here, title })
    } else {
      this.events.load({ url: this.requested, title: "" })
    }
  }

  go(url: string): void {
    const target = parse(url, this.doc.baseURI)
    if (!target || !WEB_SCHEMES.has(target.protocol)) throw new WebViewError("invalid")
    this.requested = target.href
    const stopped = this.stops.find(s => this.requested.startsWith(s))
    if (stopped) { this.events.stop({ url: this.requested }); return }
    this.events.navigate({ url: this.requested })
    this.frame.src = this.requested
  }

  loadHtml(html: string, baseUrl?: string): void {
    this.requested = baseUrl ?? "about:blank"
    this.frame.srcdoc = baseUrl ? `<base href="${baseUrl.replace(/"/g, "&quot;")}">${html}` : html
  }

  setStops(stops: string[]): void { this.stops = stops }
  setExternalLinks(mode: ExternalLinks): void { this.externalLinks = mode }

  /** The page as script may reach it: a same-origin one; another is not ours to script. */
  private page(): Window {
    const win = this.inside()
    if (!win || this.location() === null) throw new WebViewError("failed")
    return win
  }

  reload(): void {
    const win = this.inside()
    if (win && this.location() !== null) win.location.reload()
    else this.frame.src = this.requested
  }
  stopLoading(): void { try { this.inside()?.stop() } catch { /* not ours */ } }
  goBack(): void { try { this.inside()?.history.back() } catch { /* not ours */ } }
  goForward(): void { try { this.inside()?.history.forward() } catch { /* not ours */ } }
  canGoBack(): boolean { try { return (this.inside()?.history.length ?? 0) > 1 } catch { return false } }

  evaluate(js: string): Json {
    const result = (this.page() as Window & { eval(js: string): unknown }).eval(js)
    return result === undefined ? null : JSON.parse(JSON.stringify(result)) as Json
  }

  postMessage(data: Json): void {
    const win = this.page() as Window & { lecodes?: { onMessage?: ((data: Json) => void) | null } }
    win.lecodes?.onMessage?.(data)
  }

  /** The browser's storage is the page's own origin's: nothing a frame may clear. */
  clearData(): void {}

  destroy(): void {
    this.destroyed = true
    window.removeEventListener("message", this.onMessage)
    this.frame.src = "about:blank"
    this.el.remove()
  }
}

export const register = (host: PluginHost): void => {
  if (typeof window === "undefined" || typeof document === "undefined") return

  // ---- the sheet: a popup ----
  registerBrowser(host, (_params, events): BrowserPlugin => {
    let popup: Window | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    let settle: ((result: BrowserResult) => void) | null = null

    const finish = (url?: string): void => {
      if (poll !== null) { clearInterval(poll); poll = null }
      const done = settle
      settle = null
      popup = null
      done?.(url === undefined ? {} : { url })
      if (done) events.closed()
    }

    return {
      show: (url) => new Promise<BrowserResult>((resolve) => {
        if (settle) throw new BrowserError("busy")
        const target = parse(url)
        if (!target || (target.protocol !== "http:" && target.protocol !== "https:")) throw new BrowserError("invalid")
        const win = window.open(target.href, "_blank", "popup,noopener=0,width=480,height=720")
        if (!win) throw new BrowserError("invalid")   // the popup was blocked
        popup = win
        settle = resolve
        poll = setInterval(() => {
          if (!popup || popup.closed) return finish()
          // Back on the page's own origin: the flow returned to us — the sheet's callback.
          const back = sameOrigin(popup)
          if (back && back !== "about:blank") { popup.close(); finish(back) }
        }, 250)
      }),
      dismiss: () => { popup?.close(); finish() },
      close: () => { popup?.close(); finish() },
    }
  })

  // ---- the fullscreen page: the View ----
  registerWebView(host, (params, events, doc): WebViewPlugin => {
    const page = new WebViewPage(doc.createElement("div"), doc, events, params)
    return {
      el: page.el,
      load: (url) => page.go(url),
      loadHtml: (html, baseUrl) => page.loadHtml(html, baseUrl),
      setStops: (stops) => page.setStops(stops),
      reload: () => page.reload(),
      stopLoading: () => page.stopLoading(),
      goBack: () => page.goBack(),
      goForward: () => page.goForward(),
      canGoBack: () => page.canGoBack(),
      evaluate: (js) => page.evaluate(js),
      postMessage: (data) => page.postMessage(data),
      clearData: () => page.clearData(),
      destroy: () => page.destroy(),
    }
  })

  // ---- the page in a layout: the host node ----
  // The page is made at the end of the task the node was made in, from the props written by then —
  // the first commit's, as natively (the SDK's element writes them all in its constructor): `bridge`
  // and `ephemeral` make the frame, and a later write of them (or of `userAgent`) is ignored with
  // one warning. A call made before the page is there waits for it.
  registerUIWebViewNode(host, (events, doc): UIWebViewNodeHalf => {
    const el = doc.createElement("div")
    const first: PageOptions = {}
    let page: WebViewPage | null = null
    let gone = false
    const made = new Promise<WebViewPage | null>((resolve) => queueMicrotask(() => {
      if (!gone) page = new WebViewPage(el, doc, events, first)
      resolve(page)
    }))
    const live = async (): Promise<WebViewPage> => {
      const p = await made
      if (!p || gone) throw new Error("the host node is gone")
      return p
    }
    const warned = new Set<string>()
    const atCreation = (prop: "bridge" | "userAgent" | "ephemeral", apply: () => void): void => {
      if (!page) { apply(); return }
      if (warned.has(prop)) return
      warned.add(prop)
      console.warn(`LeCodes: UIWebViewNode.${prop} is read when the page is made — a later write is ignored`)
    }

    return {
      el,
      setUrl: (url) => {
        if (!page) { first.url = url; return }
        if (url !== undefined) page.go(url)   // (clearing it loads nothing)
      },
      setStops: (stops) => {
        if (!page) first.stops = stops
        else page.setStops(stops ?? [])
      },
      setExternalLinks: (mode) => {
        if (!page) first.externalLinks = mode
        else page.setExternalLinks(mode ?? "open")
      },
      setBridge: (bridge) => atCreation("bridge", () => { first.bridge = bridge }),
      setUserAgent: () => atCreation("userAgent", () => { /* a frame has no user agent of its own */ }),
      setEphemeral: (ephemeral) => atCreation("ephemeral", () => { first.ephemeral = ephemeral }),
      load: async (url) => (await live()).go(url),
      loadHtml: async (html, baseUrl) => (await live()).loadHtml(html, baseUrl),
      reload: async () => (await live()).reload(),
      stopLoading: async () => (await live()).stopLoading(),
      goBack: async () => (await live()).goBack(),
      goForward: async () => (await live()).goForward(),
      canGoBack: async () => (await live()).canGoBack(),
      evaluate: async (js) => (await live()).evaluate(js),
      postMessage: async (data) => (await live()).postMessage(data),
      clearData: async () => (await live()).clearData(),
      destroy: () => {
        gone = true
        page?.destroy()
        page = null
      },
    }
  })
}
