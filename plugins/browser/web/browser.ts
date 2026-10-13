// browser on the web: the sheet is a POPUP window, the embedded page an <iframe>.
//
// What the browser allows is less than the native halves: a popup cannot be navigated to a custom
// scheme and a cross-origin iframe hides its navigations. So the sheet resolves with a URL only
// when the popup lands back on the page's own origin, and the iframe reports `navigate` / `load` /
// `stop` / the bridge only for same-origin pages. A checkout or an OAuth flow on the web wants the
// sheet with a return on the app's origin — see docs/plans/web-app-origin-plan.md.
//
// The channel is the contract's (../contract.d.ts): browser.gen.ts is generated from it, this file
// implements its BrowserPlugin and WebViewPlugin.

import {
  BrowserError, WebViewError, registerBrowser, registerWebView,
  type BrowserPlugin, type BrowserResult, type Json, type PluginHost, type WebViewPlugin,
} from "./browser.gen"

const WEB_SCHEMES = new Set(["http:", "https:", "about:", "data:", "blob:"])

const parse = (url: string, base?: string): URL | null => {
  try { return new URL(url, base) } catch { return null }
}

/** The page's own location when it may be read (same origin), else null. */
const sameOrigin = (win: Window | null, origin: string): string | null => {
  try {
    const href = win?.location.href
    return href && new URL(href).origin === origin ? href : null
  } catch { return null }
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
        const origin = window.location.origin
        poll = setInterval(() => {
          if (!popup || popup.closed) return finish()
          // Back on the page's own origin: the flow returned to us — the sheet's callback.
          const back = sameOrigin(popup, origin)
          if (back && back !== "about:blank") { popup.close(); finish(back) }
        }, 250)
      }),
      dismiss: () => { popup?.close(); finish() },
      close: () => { popup?.close(); finish() },
    }
  })

  // ---- the embedded page: an iframe ----
  registerWebView(host, (params, events, doc): WebViewPlugin => {
    const el = doc.createElement("div")
    el.style.cssText = "background:#fff;overflow:hidden"
    const frame = doc.createElement("iframe")
    frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0"
    frame.setAttribute("allow", "payment *; camera; microphone; geolocation")
    el.appendChild(frame)

    let stops = params.stops ?? []
    const bridge = params.bridge === true
    let requested = params.url ?? "about:blank"
    const origin = window.location.origin
    let destroyed = false

    const inside = (): Window | null => frame.contentWindow
    const location = (): string | null => sameOrigin(inside(), origin)

    // Cross-origin pages that know the protocol can still talk: `parent.postMessage({ lecodes: data }, "*")`.
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== inside()) return
      const data = event.data
      if (data && typeof data === "object" && "lecodes" in data) events.message({ data: (data as { lecodes: Json }).lecodes })
    }
    window.addEventListener("message", onMessage)

    const install = (): void => {
      const win = inside() as (Window & { lecodes?: unknown }) | null
      if (!bridge || !win || location() === null || win.lecodes) return
      win.lecodes = {
        postMessage: (data: Json) => events.message({ data }),
        onMessage: null as null | ((data: Json) => void),
      }
    }

    frame.addEventListener("load", () => {
      if (destroyed) return
      const here = location()
      if (here !== null) {
        const stopped = stops.find(s => here.startsWith(s))
        if (stopped) {
          frame.src = "about:blank"
          events.stop({ url: here })
          return
        }
        install()
        let title = ""
        try { title = inside()?.document.title ?? "" } catch { /* not ours */ }
        events.load({ url: here, title })
      } else {
        events.load({ url: requested, title: "" })
      }
    })

    const go = (url: string): void => {
      const target = parse(url, doc.baseURI)
      if (!target || !WEB_SCHEMES.has(target.protocol)) throw new WebViewError("invalid")
      requested = target.href
      const stopped = stops.find(s => requested.startsWith(s))
      if (stopped) { events.stop({ url: requested }); return }
      events.navigate({ url: requested })
      frame.src = requested
    }

    if (params.url) go(params.url)

    const page = (): Window => {
      const win = inside()
      if (!win || location() === null) throw new WebViewError("failed")   // not ours to script
      return win
    }

    return {
      el,
      load: (url) => { go(url) },
      loadHtml: (html, baseUrl) => {
        requested = baseUrl ?? "about:blank"
        frame.srcdoc = baseUrl ? `<base href="${baseUrl.replace(/"/g, "&quot;")}">${html}` : html
      },
      setStops: (next) => { stops = next },
      reload: () => { const win = inside(); if (win && location() !== null) win.location.reload(); else frame.src = requested },
      stopLoading: () => { try { inside()?.stop() } catch { /* not ours */ } },
      goBack: () => { try { inside()?.history.back() } catch { /* not ours */ } },
      goForward: () => { try { inside()?.history.forward() } catch { /* not ours */ } },
      canGoBack: () => { try { return (inside()?.history.length ?? 0) > 1 } catch { return false } },
      evaluate: (js) => {
        const result = (page() as Window & { eval(js: string): unknown }).eval(js)
        return result === undefined ? null : JSON.parse(JSON.stringify(result)) as Json
      },
      postMessage: (data) => {
        const win = page() as Window & { lecodes?: { onMessage?: ((data: Json) => void) | null } }
        win.lecodes?.onMessage?.(data)
      },
      clearData: () => { /* the browser's storage is the page's own: nothing a frame may clear */ },
      destroy: () => {
        destroyed = true
        window.removeEventListener("message", onMessage)
        frame.src = "about:blank"
        el.remove()
      },
    }
  })
}
