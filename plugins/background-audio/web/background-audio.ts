// background-audio on the web: one <audio> element, and the browser's Media Session for what the
// system shows of it — the title in the notification / on the lock screen, its play and pause
// buttons, a headset's. Whether the record plays on in a hidden tab is the browser's to decide; the
// half pauses nothing itself.
//
// The channel is the contract's (../contract.d.ts): background-audio.gen.ts is generated from it,
// this file implements its BackgroundAudioPlugin.

import {
  registerBackgroundAudio, type BackgroundAudioPlugin, type PlaybackState, type PluginHost, type Status, type Track,
} from "./background-audio.gen"

/** How often `position` is sent while the record plays and the app listens, ms. */
const TICK_MS = 500

export const register = (host: PluginHost): void => {
  if (typeof Audio === "undefined") return

  registerBackgroundAudio(host, (_params, events): BackgroundAudioPlugin => {
    let audio: HTMLAudioElement | null = null
    /** The record the element was made for: what the system is shown again when it plays again. */
    let playing: Track | null = null
    /** Ends the listeners of the element that plays: an element let go says nothing more. */
    let listening: AbortController | null = null
    let state: PlaybackState = "idle"
    let duration = 0
    /** Where a record starts, asked before its length was known. */
    let startAt = 0
    let observed = false
    let ticker: ReturnType<typeof setInterval> | null = null
    const session = typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : null

    const position = (): number => audio && Number.isFinite(audio.currentTime) ? audio.currentTime : startAt
    const tick = (): void => { if (observed) events.position({ value: position() }) }
    /** The position ticks only while the record plays AND the app listens. */
    const pace = (): void => {
      if (ticker !== null) { clearInterval(ticker); ticker = null }
      if (observed && state === "playing") ticker = setInterval(tick, TICK_MS)
    }
    const set = (next: PlaybackState): void => {
      if (next === state) return
      state = next
      if (session) session.playbackState = next === "playing" ? "playing" : next === "paused" ? "paused" : "none"
      events.state({ value: next })
      tick()            // what moved the state moved the position: a listener hears where it stands
      pace()
    }
    const known = (seconds: number): void => {
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds === duration) return
      duration = seconds
      events.duration({ value: seconds })
    }

    const show = (track: Track): void => {
      if (!session) return
      if (typeof MediaMetadata !== "undefined") session.metadata = new MediaMetadata({ title: track.title, artist: track.artist ?? "" })
      const on = (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
        try { session.setActionHandler(action, handler) } catch { /* an action this browser has no button for */ }
      }
      on("play", () => { void plugin.resume() })
      on("pause", () => { void plugin.pause() })
      on("seekto", (details) => { if (typeof details.seekTime === "number") void plugin.seek(details.seekTime) })
    }
    const hide = (): void => {
      if (!session) return
      session.metadata = null
      session.playbackState = "none"
      for (const action of ["play", "pause", "seekto"] as const) {
        try { session.setActionHandler(action, null) } catch { /* as above */ }
      }
    }

    /** The element is let go: nothing plays, nothing is downloaded, it says nothing more. */
    const release = (): void => {
      listening?.abort()
      listening = null
      if (audio) {
        audio.pause()
        audio.removeAttribute("src")
        audio.load()
      }
      audio = null
      playing = null
      duration = 0
      startAt = 0
    }

    /** Start the element: a browser that refuses (no gesture behind the call) leaves it paused, to be
     *  started by the next tap — any other failure is the record's. */
    const start = (el: HTMLAudioElement): void => {
      el.play().catch((error: unknown) => {
        if (el !== audio) return
        set(error instanceof DOMException && error.name === "NotAllowedError" ? "paused" : "failed")
      })
    }

    const plugin: BackgroundAudioPlugin = {
      play(track) {
        release()
        const el = new Audio()
        const { signal } = listening = new AbortController()
        el.preload = "auto"
        el.addEventListener("loadedmetadata", () => {
          known(el.duration)
          if (startAt > 0) { el.currentTime = Math.min(startAt, Number.isFinite(el.duration) ? el.duration : startAt); startAt = 0 }
        }, { signal })
        el.addEventListener("durationchange", () => known(el.duration), { signal })
        el.addEventListener("playing", () => set("playing"), { signal })
        // The browser paused it — a headset's button, the notification, another tab's sound — as
        // well as the app: either way it is paused. The end of the record pauses it too.
        el.addEventListener("pause", () => { if (!el.ended && state === "playing") set("paused") }, { signal })
        el.addEventListener("ended", () => { set("ended"); hide() }, { signal })
        el.addEventListener("error", () => { set("failed"); hide() }, { signal })
        el.addEventListener("seeked", tick, { signal })
        audio = el
        playing = track
        startAt = track.position !== undefined && track.position > 0 ? track.position : 0
        show(track)
        set("loading")
        el.src = track.src
        start(el)
      },
      pause() {
        audio?.pause()
      },
      resume() {
        if (!audio || state === "playing" || state === "loading") return
        if (state === "ended") audio.currentTime = 0
        if (state === "failed") audio.load()
        if (playing) show(playing)        // the system's player went with the record's end
        start(audio)
      },
      seek(to) {
        const at = Math.max(0, duration > 0 ? Math.min(to, duration) : to)
        if (audio && audio.readyState >= 1) audio.currentTime = at        // HAVE_METADATA: the element can seek
        else { startAt = at; tick() }
      },
      stop() {
        release()
        hide()
        set("idle")
      },
      status(): Status {
        return { state, duration, position: position() }
      },
      positionObserved(on) {
        observed = on
        tick()
        pace()
      },
      close() {
        observed = false
        pace()
        release()
        hide()
      },
    }
    return plugin
  })
}
