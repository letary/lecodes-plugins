// The app's API of rtc, over the plugin's wire (../contract.d.ts): RtcMedia (the devices),
// RtcTrack, RtcConnection (one peer), RtcDataChannel, plus the picture of a track on two surfaces —
// UIRTCVideoNode (rtcVideoNode.ts, re-exported here), a node of a screen's layout (a call's tiles),
// and RTCVideoView, the fullscreen picture pushed or opened with widgets over it.
//
// Hand-written over the generated bases because the wire names ids and the app names objects: a
// track is kept here by the id the host gave it (ONE object per id, for the page: the track a view
// draws is the track a connection sends), a channel by the integer its connection gave it, and
// every event of the wire lands on the object it concerns.
//
// The shapes the wire does not have:
//   - `connection.remoteAudio` / `remoteVideo`: the host is asked for them (getRemoteTracks) when
//     the connection is made; they are null until `connection.ready` resolves, and set by the time
//     `createOffer()` / `acceptOffer()` resolve. A `remotemedia` event that comes before is held.
//   - the local candidates a description call raises while it is in flight are held and given
//     after its promise, in a task of their own: the app sends the description first;
//   - `createDataChannel` returns the channel at once ("connecting"); what is sent before it opened
//     is QUEUED (copied) and flushed in order when it opens, before the `open` event; a channel
//     closed before it opened rejects what was queued. `send()` returns a promise that resolves
//     when the host took the message — it never surfaces as an unhandled rejection when the app
//     does not await it;
//   - after `close()` nothing reaches the host again (a call would open a fresh session): every
//     method rejects "closed", the channels close, the remote tracks end.

import type { Listener, NativeView } from "lecodes-sdk/plugin"
import { RtcMediaBase, NAME as MEDIA_NAME } from "./rtc.RtcMedia.gen"
import { RtcConnectionBase, NAME as CONNECTION_NAME } from "./rtc.RtcConnection.gen"
import { RtcVideoBase, NAME as VIDEO_NAME } from "./rtc.RtcVideo.gen"
import type {
  AudioConstraints, AudioOutput, ConnectionState, ConnectionStats, DataChannelInit, DeviceInfo, DeviceKind, FacingMode,
  MediaConstraints, MediaKind, ObjectFit, RtcConnectionParams, RtcVideoEvents, TrackInfo, TrackSettings, VideoConstraints,
} from "../contract"

export { UIRTCVideoNode, type UIRTCVideoNodeStyle } from "./rtcVideoNode"
export type {
  AudioConstraints, AudioOutput, ConnectionState, ConnectionStats, DataChannelInit, DeviceInfo, DeviceKind, FacingMode,
  MediaKind, ObjectFit, RtcVideoEvents, TrackSettings, VideoConstraints,
}

const unsupported = (what: string, channel: string, kind: "service" | "view"): Error =>
  new Error(`${what} isn't available on this host — it needs the "rtc" plugin (app.json "plugins"), a registered "${channel}" ${kind}.`)

/** A promise the app may leave unawaited: its rejection is the app's to read, never an unhandled one. */
const quiet = <T>(promise: Promise<T>): Promise<T> => {
  promise.catch(() => {})
  return promise
}

const closedError = (): Error => new Error("closed")

// ---- events ----------------------------------------------------------------------------------------

/** An event of this API: its `type`, the object it happened on, and the fields of its type. */
export type RtcEvent<T, K extends string, Fields = {}> = { readonly type: K, readonly target: T } & Fields

/** What every object of the API emits from: `addEventListener` / `removeEventListener`, and the
 *  `on<type>` properties each class declares. `M` maps an event's type to the event. */
export class RtcEventTarget<M extends object> {
  private readonly _listeners = new Map<string, ((event: any) => void)[]>()

  addEventListener<K extends keyof M & string>(type: K, listener: (event: M[K]) => void): void {
    let list = this._listeners.get(type)
    if (!list) this._listeners.set(type, list = [])
    if (!list.includes(listener)) list.push(listener)
  }
  removeEventListener<K extends keyof M & string>(type: K, listener: (event: M[K]) => void): void {
    const list = this._listeners.get(type)
    if (!list) return
    const at = list.indexOf(listener)
    if (at >= 0) list.splice(at, 1)
  }
  /** @internal Deliver `event` (its `type` names the `on<type>` handler too). */
  _dispatch(event: { type: string, [key: string]: any }): void {
    ;(event as any).target = this
    const handler = (this as any)["on" + event.type]
    if (typeof handler === "function") handler.call(this, event)
    const list = this._listeners.get(event.type)
    if (list) for (const listener of list.slice()) listener(event)
  }
}

export interface RtcTrackEventMap {
  /** A local track: the OS took the device and did not give it back. A received one: its connection closed. */
  ended: RtcEvent<RtcTrack, "ended">
  /** A received track: its sender stopped sending (the camera went off, the microphone was muted). */
  mute: RtcEvent<RtcTrack, "mute">
  /** A received track: its sender sends again. */
  unmute: RtcEvent<RtcTrack, "unmute">
}

export interface RtcConnectionEventMap {
  statechange: RtcEvent<RtcConnection, "statechange", { state: ConnectionState }>
  /** A candidate of this side for the other one: its `candidate:` line, for the app's signaling. */
  icecandidate: RtcEvent<RtcConnection, "icecandidate", { candidate: string }>
  /** The network changed under the call: the side that made the offer calls `createOffer(true)`. */
  icerestartneeded: RtcEvent<RtcConnection, "icerestartneeded">
  /** The other side started or stopped sending a kind; `track` is the received track of that kind. */
  remotemedia: RtcEvent<RtcConnection, "remotemedia", { kind: MediaKind, active: boolean, track: RtcTrack }>
  /** A channel the other side opened — open already. */
  datachannel: RtcEvent<RtcConnection, "datachannel", { channel: RtcDataChannel }>
}

export interface RtcDataChannelEventMap {
  open: RtcEvent<RtcDataChannel, "open">
  /** A string for a text message, the bytes for a binary one. */
  message: RtcEvent<RtcDataChannel, "message", { data: string | Uint8Array }>
  bufferedamountlow: RtcEvent<RtcDataChannel, "bufferedamountlow">
  close: RtcEvent<RtcDataChannel, "close">
}

export interface RtcMediaEventMap {
  /** A device was plugged in or removed (a headset, a camera). */
  devicechange: RtcEvent<RtcMediaDevices, "devicechange">
}

// ---- the devices: one session for the app, the tracks by id ---------------------------------------

let mediaService: RtcMediaBase | null = null
/** Every track the app holds, by the host's id: where the host's events find their object. */
const tracks = new Map<string, RtcTrack>()

const media = (): RtcMediaBase => {
  if (mediaService) return mediaService
  if (!RtcMediaBase.supports(MEDIA_NAME)) throw unsupported("RtcMedia", MEDIA_NAME, "service")
  mediaService = new RtcMediaBase()
  mediaService.on("trackEnded", ({ trackId }) => tracks.get(trackId)?._ended())
  mediaService.on("deviceChange", () => RtcMedia._dispatch({ type: "devicechange" }))
  return mediaService
}

/** The track object of a host id: the one the app holds, or a new one for an id first seen now. */
const trackOf = (info: TrackInfo, remote: boolean): RtcTrack => {
  let track = tracks.get(info.id)
  if (!track) tracks.set(info.id, track = new RtcTrack(info, remote))
  return track
}

/** One track of audio or video: captured here (`RtcMedia.getUserMedia`) or received from a
 *  connection (`connection.remoteAudio` / `remoteVideo`). A handle of the host's track: one object
 *  per track, whoever names it. */
export class RtcTrack extends RtcEventTarget<RtcTrackEventMap> {
  /** The host's id of the track. */
  readonly id: string
  readonly kind: MediaKind
  /** The device's name for a local track; "" for a received one. */
  readonly label: string
  /** Received from a connection, not captured here. */
  readonly remote: boolean
  private _enabled: boolean
  private _muted: boolean
  private _state: "live" | "ended" = "live"

  onended: ((event: RtcTrackEventMap["ended"]) => void) | null = null
  onmute: ((event: RtcTrackEventMap["mute"]) => void) | null = null
  onunmute: ((event: RtcTrackEventMap["unmute"]) => void) | null = null

  /** @internal Tracks come from `RtcMedia.getUserMedia` and from a connection, never from `new`. */
  constructor(info: TrackInfo, remote: boolean) {
    super()
    this.id = info.id
    this.kind = info.kind
    this.label = info.label
    this.remote = remote
    this._enabled = info.enabled
    this._muted = info.muted ?? false
  }

  /** A local track: false = not sent (the other side gets `remotemedia`, inactive); the device stays
   *  open and the track stays in every connection. A received track: the app's flag only — leave a
   *  peer's sound out with `connection.setRemoteAudioMuted(true)`. */
  get enabled(): boolean { return this._enabled }
  set enabled(value: boolean) {
    if (this._enabled === value || this._state === "ended") return
    this._enabled = value
    if (!this.remote) quiet(media().setTrackEnabled(this.id, value))
  }
  /** A received track whose sender is not sending (its camera is off, its microphone muted). */
  get muted(): boolean { return this._muted }
  get readyState(): "live" | "ended" { return this._state }

  /** End a local track: the device is released, every connection stops sending it. A received
   *  track is only let go of here. */
  stop(): void {
    if (this._state === "ended") return
    this._state = "ended"
    tracks.delete(this.id)
    if (!this.remote && mediaService) quiet(mediaService.stopTrack(this.id))
  }

  /** Re-aim a local video track: the other camera (`facingMode`), another device, size or rate.
   *  The track and its id stay; every connection keeps sending it. */
  applyConstraints(constraints: VideoConstraints = {}): Promise<void> {
    if (this.remote || this.kind !== "video") return Promise.reject(new Error("applyConstraints: a local video track only"))
    return media().applyConstraints(this.id, constraints)
  }
  /** What a local video track captures with (a promise: the host knows). {} for a received track. */
  getSettings(): Promise<TrackSettings> {
    if (this.remote) return Promise.resolve({})
    return media().getTrackSettings(this.id)
  }
  /** The most a local video track may take, bits per second (default 1 500 000): one ceiling for
   *  every connection that sends it; the size and the rate under it follow the network. */
  setMaxBitrate(bitrate: number): Promise<void> {
    if (this.remote || this.kind !== "video") return Promise.reject(new Error("setMaxBitrate: a local video track only"))
    return media().setMaxVideoBitrate(this.id, Math.round(bitrate))
  }

  /** @internal The host reports the track gone (the OS took it; its connection closed). */
  _ended(): void {
    if (this._state === "ended") return
    this._state = "ended"
    tracks.delete(this.id)
    this._dispatch({ type: "ended" })
  }
  /** @internal */
  _setMuted(muted: boolean): void {
    if (this._muted === muted || this._state === "ended") return
    this._muted = muted
    this._dispatch({ type: muted ? "mute" : "unmute" })
  }
}

/** What to capture: `true` for the default (the front camera at 1280×720, 30 fps; the microphone
 *  with the voice processing on), an object to say more. */
export interface RtcMediaConstraints {
  audio?: boolean | AudioConstraints
  video?: boolean | VideoConstraints
}

/** The devices of the app — `RtcMedia`. */
export class RtcMediaDevices extends RtcEventTarget<RtcMediaEventMap> {
  /** Heard once the devices were asked anything (`getUserMedia`, `enumerateDevices`). */
  ondevicechange: ((event: RtcMediaEventMap["devicechange"]) => void) | null = null

  /** Whether this host registered the "rtcMedia" service — the devices. */
  get supported(): boolean { return RtcMediaBase.supports(MEDIA_NAME) }

  /** Capture: asks for the permissions it needs, resolves with the new tracks — the microphone
   *  first when both were asked for. Rejects "denied" / "notFound" / "failed". */
  async getUserMedia(constraints: RtcMediaConstraints = { audio: true, video: true }): Promise<RtcTrack[]> {
    const wire: MediaConstraints = {}
    if (constraints.audio) wire.audio = constraints.audio === true ? {} : constraints.audio
    if (constraints.video) wire.video = constraints.video === true ? {} : constraints.video
    if (!wire.audio && !wire.video) throw new Error("RtcMedia.getUserMedia: audio or video must be asked for")
    const infos = await media().getUserMedia(wire)
    return infos.map((info) => trackOf(info, false))
  }
  /** The devices the host can capture with (their labels need a granted permission on the web). */
  enumerateDevices(): Promise<DeviceInfo[]> {
    try { return media().enumerateDevices() } catch (e) { return Promise.reject(e) }
  }
  /** Where the call's audio plays on a phone: the earpiece (or a headset) or the loudspeaker. A
   *  no-op on the web. */
  setAudioOutput(output: AudioOutput): Promise<void> {
    try { return media().setAudioOutput(output) } catch (e) { return Promise.reject(e) }
  }
}

/** The devices: capture, the device list, the audio route. Host-optional — `RtcMedia.supported`
 *  before offering a call. */
// PURE IIFE so an app that never captures tree-shakes the devices away.
export const RtcMedia: RtcMediaDevices = /*#__PURE__*/ (() => new RtcMediaDevices())()

// ---- a connection ----------------------------------------------------------------------------------

/** The ICE servers of a connection: STUN only ("stun:host:port"), one URL or several. */
export interface RtcIceServer { urls: string | string[] }

export interface RtcConnectionOptions {
  /** STUN servers; the reflexive address a server sees is offered as a candidate. */
  iceServers?: RtcIceServer[]
  /** Never reveal an address of this device: the only path is the relay's candidate the app adds
   *  (`typ relay`), whatever else it adds — no candidate of its own goes into a description or out
   *  as `icecandidate`, and of the other side's only `typ relay` ones are taken (passed to
   *  `addIceCandidate` or inside its description: every other kind is ignored), so the two never
   *  meet directly. Without a relay candidate it never connects; after an ICE restart, add the new
   *  reservation's. Default false. */
  relayOnly?: boolean
}

const paramsOf = (options: RtcConnectionOptions): RtcConnectionParams => {
  const params: RtcConnectionParams = {}
  if (options.iceServers) params.iceServers = options.iceServers.map((s) => ({ urls: Array.isArray(s.urls) ? s.urls.slice() : [s.urls] }))
  if (options.relayOnly !== undefined) params.relayOnly = options.relayOnly
  return params
}

type ChannelEvent = "open" | "message" | "low" | "close"

/**
 * A connection to one peer — a session of the host, made with the connection and ended by
 * `close()`. Both kinds of media and the data channels are in it from the first offer: sending a
 * track, stopping it or opening a channel is never a new offer; the only second offer is an ICE
 * restart. Signaling — carrying the offer, the answer and the candidates to the other side — is the
 * app's. Host-optional: `RtcConnection.supported`; `new RtcConnection()` throws where it is false.
 */
export class RtcConnection extends RtcEventTarget<RtcConnectionEventMap> {
  /** Whether this host registered the "rtcConnection" service. */
  static get supported(): boolean { return RtcConnectionBase.supports(CONNECTION_NAME) }

  /** @internal The session. */
  readonly _s: RtcConnectionBase
  /** Resolves when `remoteAudio` / `remoteVideo` are known (asked for when the connection is made). */
  readonly ready: Promise<void>
  private _state: ConnectionState = "new"
  private _remoteAudio: RtcTrack | null = null
  private _remoteVideo: RtcTrack | null = null
  /** `remoteMedia` that came before the remote tracks were known. */
  private _heldMedia: { kind: MediaKind, active: boolean }[] = []
  private readonly _channels = new Map<number, RtcDataChannel>()
  /** Our channels the host has not given an id yet: an event of an unknown id may be theirs. */
  private readonly _creating = new Set<RtcDataChannel>()
  private _heldChannelEvents: [ChannelEvent, any][] = []
  /** While a description is being made, the candidates it raises wait for its promise. */
  private _describing = 0
  private _heldCandidates: string[] = []
  /** After the app's close(): what the dying session still says is no event, and nothing is called. */
  private _closedByApp = false

  onstatechange: ((event: RtcConnectionEventMap["statechange"]) => void) | null = null
  onicecandidate: ((event: RtcConnectionEventMap["icecandidate"]) => void) | null = null
  onicerestartneeded: ((event: RtcConnectionEventMap["icerestartneeded"]) => void) | null = null
  onremotemedia: ((event: RtcConnectionEventMap["remotemedia"]) => void) | null = null
  ondatachannel: ((event: RtcConnectionEventMap["datachannel"]) => void) | null = null

  constructor(options: RtcConnectionOptions = {}) {
    super()
    if (!RtcConnectionBase.supports(CONNECTION_NAME)) throw unsupported("RtcConnection", CONNECTION_NAME, "service")
    const s = this._s = new RtcConnectionBase(paramsOf(options))
    const on: typeof s.on = (event, callback) => s.on(event, ((payload?: any) => { if (!this._closedByApp) (callback as any)(payload) }) as any)
    on("stateChange", ({ state }) => {
      if (this._state === state) return
      this._state = state
      this._dispatch({ type: "statechange", state })
    })
    on("iceCandidate", ({ candidate }) => {
      if (this._describing > 0) this._heldCandidates.push(candidate)
      else this._dispatch({ type: "icecandidate", candidate })
    })
    on("iceRestartNeeded", () => this._dispatch({ type: "icerestartneeded" }))
    on("remoteMedia", (payload) => this._remoteMedia(payload))
    on("dataChannelOpen", (payload) => this._channelEvent("open", payload))
    on("dataChannelMessage", (payload) => this._channelEvent("message", payload))
    on("dataChannelBufferedAmountLow", (payload) => this._channelEvent("low", payload))
    on("dataChannelClose", (payload) => this._channelEvent("close", payload))
    // The session opens here: the received tracks exist from its start.
    this.ready = quiet(s.getRemoteTracks().then(({ audio, video }) => {
      if (this._closedByApp) return
      this._remoteAudio = trackOf(audio, true)
      this._remoteVideo = trackOf(video, true)
      const held = this._heldMedia
      this._heldMedia = []
      for (const payload of held) this._remoteMedia(payload)
    }))
  }

  /** "new" → "connecting" → "connected"; "disconnected" while the path is lost (it heals, or the
   *  offering side restarts ICE), "failed" when it is gone, "closed" after `close()`. */
  get state(): ConnectionState { return this._state }
  /** The audio this connection receives: it plays by itself. Null until `ready`. */
  get remoteAudio(): RtcTrack | null { return this._remoteAudio }
  /** The video this connection receives: draw it with a `UIRTCVideoNode` or an `RTCVideoView`.
   *  Null until `ready`. */
  get remoteVideo(): RtcTrack | null { return this._remoteVideo }

  // -- signaling

  /** The offering side: the offer to send. `iceRestart` for every offer after the first.
   *  Rejects "failed" / "closed". */
  createOffer(iceRestart?: boolean): Promise<string> {
    return this._describe(() => this._s.createOffer(iceRestart))
  }
  /** The answering side: takes the offer, resolves with the answer to send. Rejects "failed" / "closed". */
  acceptOffer(offer: string): Promise<string> {
    return this._describe(() => this._s.acceptOffer(offer))
  }
  /** The offering side: takes the answer. Rejects "failed" / "closed". */
  acceptAnswer(answer: string): Promise<void> {
    return this._closedByApp ? Promise.reject(closedError()) : this._s.acceptAnswer(answer)
  }
  /** A candidate of the other side (its `candidate:` line), or a relay's (`typ relay`). A line that
   *  cannot be read is skipped; so is, on a `relayOnly` connection, any that is not `typ relay`. */
  addIceCandidate(candidate: string): Promise<void> {
    return this._closedByApp ? Promise.reject(closedError()) : this._s.addIceCandidate(candidate)
  }

  // -- media

  /** Send a local track (the microphone, the camera); null = stop sending that kind. Never a new
   *  offer. Rejects "notFound" / "failed" / "closed". */
  setTrack(kind: MediaKind, track: RtcTrack | null): Promise<void> {
    if (this._closedByApp) return Promise.reject(closedError())
    if (track && track.kind !== kind) return Promise.reject(new Error(`setTrack: a ${track.kind} track is not ${kind}`))
    return this._s.setTrack(kind, track ? track.id : null)
  }
  /** Leave this peer's sound out of what is played (true), or back in. */
  setRemoteAudioMuted(muted: boolean): Promise<void> {
    return this._closedByApp ? Promise.reject(closedError()) : this._s.setRemoteAudioMuted(muted)
  }
  /** What a call screen and a bug report need: the round trip, the bitrates, the loss. Rejects "closed". */
  getStats(): Promise<ConnectionStats> {
    return this._closedByApp ? Promise.reject(closedError()) : this._s.getStats()
  }

  // -- data channels

  /** Open a data channel, in-band (never a new offer). It is "connecting" until the other side
   *  has it; what is sent before is queued. */
  createDataChannel(label: string, options: DataChannelInit = {}): RtcDataChannel {
    const channel = new RtcDataChannel(this, label, null, "connecting")
    if (this._closedByApp) { channel._closed(); return channel }
    this._creating.add(channel)
    this._s.createDataChannel(label, options).then(
      (id) => {
        this._creating.delete(channel)
        if (this._closedByApp) return
        this._channels.set(id, channel)
        channel._made(id)
        this._replayChannelEvents()
      },
      (e) => {
        this._creating.delete(channel)
        channel._closed(e instanceof Error ? e.message : String(e))
        this._replayChannelEvents()
      },
    )
    return channel
  }

  /** End the connection: the session with the host ends, every channel closes (`close`), the
   *  received tracks end (`ended`). No `statechange` follows; every method rejects "closed" after. */
  close(): void {
    if (this._closedByApp) return
    this._closedByApp = true
    this._state = "closed"
    this._s.close()
    for (const channel of this._channels.values()) channel._closed()
    for (const channel of this._creating) channel._closed()
    this._channels.clear()
    this._creating.clear()
    this._heldChannelEvents = []
    this._heldCandidates = []
    this._remoteAudio?._ended()
    this._remoteVideo?._ended()
  }

  /** @internal Whether the app closed it: a channel's calls stop there. */
  get _gone(): boolean { return this._closedByApp }

  private async _describe(make: () => Promise<string>): Promise<string> {
    if (this._closedByApp) throw closedError()
    this._describing++
    try {
      const sdp = await make()
      // the remote tracks are known once a description resolved
      await this.ready.catch(() => {})
      return sdp
    } finally {
      this._describing--
      if (this._describing === 0 && this._heldCandidates.length) {
        const held = this._heldCandidates
        this._heldCandidates = []
        // a task after the promise settled: the caller sends the description first
        setTimeout(() => { for (const candidate of held) if (!this._closedByApp) this._dispatch({ type: "icecandidate", candidate }) }, 0)
      }
    }
  }

  private _remoteMedia(payload: { kind: MediaKind, active: boolean }): void {
    const track = payload.kind === "audio" ? this._remoteAudio : this._remoteVideo
    if (!track) { this._heldMedia.push(payload); return }
    track._setMuted(!payload.active)
    this._dispatch({ type: "remotemedia", kind: payload.kind, active: payload.active, track })
  }

  private _channelEvent(event: ChannelEvent, payload: any): void {
    const channel = this._channels.get(payload.id)
    if (!channel) {
      // one of ours whose id is still on its way, or the other side's
      if (this._creating.size > 0) { this._heldChannelEvents.push([event, payload]); return }
      if (event !== "open") return
      const theirs = new RtcDataChannel(this, payload.label, payload.id, "open")
      this._channels.set(payload.id, theirs)
      this._dispatch({ type: "datachannel", channel: theirs })
      theirs._dispatch({ type: "open" })
      return
    }
    if (event === "open") channel._open()
    else if (event === "message") channel._message(payload.text, payload.binary)
    else if (event === "low") channel._dispatch({ type: "bufferedamountlow" })
    else {
      this._channels.delete(payload.id)
      channel._closed()
    }
  }

  private _replayChannelEvents(): void {
    if (!this._heldChannelEvents.length) return
    const held = this._heldChannelEvents
    this._heldChannelEvents = []
    for (const [event, payload] of held) this._channelEvent(event, payload)
  }
}

export type RtcDataChannelState = "connecting" | "open" | "closing" | "closed"

type Queued = { payload: string | Uint8Array, resolve: () => void, reject: (e: Error) => void }

/** A data channel of a connection: strings and bytes, ordered and reliable unless its options said
 *  otherwise. Made by `connection.createDataChannel()` or by the other side (`datachannel`). */
export class RtcDataChannel extends RtcEventTarget<RtcDataChannelEventMap> {
  readonly label: string
  private readonly _conn: RtcConnection
  /** @internal The connection's id of it; null until the host gave it. */
  _id: number | null
  private _state: RtcDataChannelState
  private _threshold = 0
  /** What was sent before it opened. */
  private _queue: Queued[] = []

  onopen: ((event: RtcDataChannelEventMap["open"]) => void) | null = null
  onmessage: ((event: RtcDataChannelEventMap["message"]) => void) | null = null
  onbufferedamountlow: ((event: RtcDataChannelEventMap["bufferedamountlow"]) => void) | null = null
  onclose: ((event: RtcDataChannelEventMap["close"]) => void) | null = null

  /** @internal Channels come from `createDataChannel` and from the other side, never from `new`. */
  constructor(conn: RtcConnection, label: string, id: number | null, state: RtcDataChannelState) {
    super()
    this._conn = conn
    this.label = label
    this._id = id
    this._state = state
  }

  get readyState(): RtcDataChannelState { return this._state }

  /** Send a string or bytes. Before the channel opened it is queued (a copy) and goes when it
   *  opens. Resolves when the host took it; rejects "closed" on a closing or closed channel, or
   *  with the host's code. Leaving it unawaited is fine. */
  send(data: string | Uint8Array | ArrayBuffer | ArrayBufferView): Promise<void> {
    const payload = typeof data === "string" ? data
      : data instanceof ArrayBuffer ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (this._state === "closing" || this._state === "closed") return quiet(Promise.reject(closedError()))
    if (this._state === "connecting") {
      const copy = typeof payload === "string" ? payload : payload.slice()
      return quiet(new Promise<void>((resolve, reject) => this._queue.push({ payload: copy, resolve, reject })))
    }
    return quiet(this._send(payload))
  }

  /** Bytes queued and not yet sent (a promise: the host counts them), with what waits for the
   *  channel to open (a string counted by its length). */
  getBufferedAmount(): Promise<number> {
    const waiting = this._queue.reduce((n, q) => n + q.payload.length, 0)
    if (this._id === null || this._state !== "open" || this._conn._gone) return Promise.resolve(waiting)
    return this._conn._s.getBufferedAmount(this._id).then((n) => n + waiting)
  }
  /** `bufferedamountlow` fires when the buffered amount falls to it. Default 0. */
  get bufferedAmountLowThreshold(): number { return this._threshold }
  set bufferedAmountLowThreshold(value: number) {
    this._threshold = value
    if (this._id !== null && this._state !== "closed" && !this._conn._gone) quiet(this._conn._s.setBufferedAmountLowThreshold(this._id, value))
  }

  /** Close the channel; `close` follows. One that has not opened closes at once. */
  close(): void {
    if (this._state === "closing" || this._state === "closed") return
    if (this._state === "connecting") {
      if (this._id !== null && !this._conn._gone) quiet(this._conn._s.closeDataChannel(this._id))
      this._closed()
      return
    }
    this._state = "closing"
    if (this._id !== null && !this._conn._gone) quiet(this._conn._s.closeDataChannel(this._id))
  }

  private _send(payload: string | Uint8Array): Promise<void> {
    if (this._conn._gone) return Promise.reject(closedError())
    const id = this._id!
    return typeof payload === "string" ? this._conn._s.sendText(id, payload) : this._conn._s.sendBinary(id, payload)
  }

  /** @internal The host gave it its id. */
  _made(id: number): void {
    this._id = id
    if (this._state === "closed") { quiet(this._conn._s.closeDataChannel(id)); return }
    if (this._threshold) quiet(this._conn._s.setBufferedAmountLowThreshold(id, this._threshold))
  }
  /** @internal It can carry messages: what was queued goes first, then `open`. */
  _open(): void {
    if (this._state !== "connecting") return
    this._state = "open"
    const queue = this._queue
    this._queue = []
    for (const q of queue) this._send(q.payload).then(q.resolve, q.reject)
    this._dispatch({ type: "open" })
  }
  /** @internal Closed — by the host, the app, the connection, or a creation that failed (`reason`). */
  _closed(reason = "closed"): void {
    if (this._state === "closed") return
    this._state = "closed"
    const queue = this._queue
    this._queue = []
    for (const q of queue) q.reject(new Error(reason))
    this._dispatch({ type: "close" })
  }
  /** @internal */
  _message(text: string | undefined, binary: Uint8Array | undefined): void {
    if (this._state === "closed") return
    this._dispatch({ type: "message", data: text !== undefined ? text : binary ?? new Uint8Array(0) })
  }
}

// ---- the picture -----------------------------------------------------------------------------------

export interface RTCVideoViewOptions {
  /** The track to draw; none = black. */
  track?: RtcTrack | null
  /** Default "cover". */
  objectFit?: ObjectFit
  /** Flip horizontally — the front camera's preview. Default false. */
  mirror?: boolean
}

/** One video track fullscreen: a destination of its own — `Router.push(view)` or `open()`, its
 *  controls over it as `widgets`. `track` may change at any time. A picture that is a part of a
 *  screen (a call's tiles) is a `UIRTCVideoNode`. */
export interface RTCVideoView extends NativeView {
  /** The track drawn; null = black. */
  track: RtcTrack | null
  objectFit: ObjectFit
  mirror: boolean
  /** `resize`: the first frame, and every change of the picture's size. */
  on<K extends keyof RtcVideoEvents & string>(event: K, callback: Listener<RtcVideoEvents, K>): this
  off<K extends keyof RtcVideoEvents & string>(event: K, callback: Listener<RtcVideoEvents, K>): this
}

class RTCVideoViewElement extends RtcVideoBase {
  private _track: RtcTrack | null
  private _objectFit: ObjectFit
  private _mirror: boolean

  constructor(options: RTCVideoViewOptions) {
    super({ ...(options.track ? { trackId: options.track.id } : {}), objectFit: options.objectFit ?? "cover", mirror: options.mirror ?? false })
    this._track = options.track ?? null
    this._objectFit = options.objectFit ?? "cover"
    this._mirror = options.mirror ?? false
  }
  get track(): RtcTrack | null { return this._track }
  set track(track: RtcTrack | null) {
    if (this._track === track) return
    this._track = track
    quiet(this.setTrack(track ? track.id : null))
  }
  get objectFit(): ObjectFit { return this._objectFit }
  set objectFit(fit: ObjectFit) {
    if (this._objectFit === fit) return
    this._objectFit = fit
    quiet(this.setObjectFit(fit))
  }
  get mirror(): boolean { return this._mirror }
  set mirror(mirror: boolean) {
    if (this._mirror === mirror) return
    this._mirror = mirror
    quiet(this.setMirror(mirror))
  }
}

/**
 * Create a fullscreen video view (push it, or open it). `RTCVideoView.supported` reports whether
 * this host has it — check it before offering the feature. A picture inside a screen is
 * `UIRTCVideoNode`.
 */
// PURE IIFE so an app that never shows a track tree-shakes the view away.
export const RTCVideoView: {
  (options?: RTCVideoViewOptions): RTCVideoView
  /** Whether this host registered an "rtcVideo" view. */
  readonly supported: boolean
} = /*#__PURE__*/ (() => {
  const factory = (options: RTCVideoViewOptions = {}): RTCVideoView => new RTCVideoViewElement(options) as unknown as RTCVideoView
  Object.defineProperty(factory, "supported", { get: (): boolean => RtcVideoBase.supports(VIDEO_NAME) })
  return factory as any
})()
