// The WebRTC API of the browser, over the plugin's wire: RTCPeerConnection, MediaStream,
// MediaStreamTrack, RTCDataChannel, RTCRtpSender / Receiver / Transceiver, mediaDevices, plus
// RTCVideoView — the tree node that draws a track (the browser's <video> has no twin in a tree
// of nodes). Code written against the browser reads the same here; a client of an SFU
// (mediasoup-client, LiveKit's) runs over these objects.
//
// What differs from the browser, because the objects live in the host and a call crosses to it:
//   - what the browser answers at once from its own memory is a promise here when the host must
//     be asked: `track.getSettings()`, `sender.getParameters()`, `channel.getBufferedAmount()`
//     (there is no `bufferedAmount` property);
//   - `pc.getTransceivers()` / `getSenders()` / `getReceivers()` answer from the SDK's copy, which
//     is refreshed after every description is set and on every `track` event — the moments the
//     mids and the directions change;
//   - `createDataChannel` returns at once (the channel is "connecting"; what is sent before the
//     host made it is queued).
//
// Hand-written over the generated wire because the wire names ids and the app names objects: the
// tracks, the senders, the transceivers and the channels are kept here, by the id the host gave
// them, and every event is turned into the browser's event on the object it concerns.

import type { Listener, NativeView } from "lecodes-sdk/plugin"
import { RtcMediaBase, NAME as MEDIA_NAME } from "./webrtc.RtcMedia.gen"
import { RtcPeerConnectionBase, NAME as PC_NAME } from "./webrtc.RtcPeerConnection.gen"
import { RtcVideoBase, NAME as VIDEO_NAME } from "./webrtc.RtcVideo.gen"
import type {
  AudioConstraints, AudioOutput, DataChannelInfo, DataChannelInit, DataChannelState, DeviceInfo, Encoding, FacingMode,
  IceCandidate, IceConnectionState, IceGatheringState, IceServer, MediaKind, ObjectFit, OfferOptions,
  PeerConnectionState, RtcConfiguration, RtcVideoEvents, SdpType, SenderInfo, SenderParameters, SessionDescription,
  SignalingState, TrackInfo, TrackSettings, TransceiverDirection, TransceiverInfo, TransceiverInit, VideoConstraints,
} from "../contract"

export type {
  AudioConstraints, AudioOutput, DataChannelInit, DataChannelState, DeviceInfo, Encoding, FacingMode, IceCandidate,
  IceConnectionState, IceGatheringState, IceServer, MediaKind, ObjectFit, OfferOptions, PeerConnectionState,
  RtcConfiguration, RtcVideoEvents, SdpType, SenderParameters, SessionDescription, SignalingState, TrackSettings,
  TransceiverDirection, TransceiverInit, VideoConstraints,
}

const unsupported = (what: string, channel: string, kind: "service" | "view"): Error =>
  new Error(`${what} isn't available on this host — it needs the "webrtc" plugin (app.json "plugins"), a registered "${channel}" ${kind}.`)

// ---- events: the browser's shape, on the objects of this file -------------------------------------

/** A listener of one event type; it gets the event, which carries `type` and `target`. */
export type RTCEventListener<E> = (event: E) => void

/** What every object of the API emits from: `addEventListener` / `removeEventListener`, and the
 *  `on<type>` properties the subclasses declare. */
export class RTCEventTarget {
  private readonly _listeners = new Map<string, RTCEventListener<any>[]>()

  addEventListener<E = any>(type: string, listener: RTCEventListener<E>): void {
    let list = this._listeners.get(type)
    if (!list) this._listeners.set(type, list = [])
    if (!list.includes(listener)) list.push(listener)
  }
  removeEventListener<E = any>(type: string, listener: RTCEventListener<E>): void {
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

export interface RTCPeerConnectionIceEvent { type: "icecandidate", candidate: RTCIceCandidate | null, target: RTCPeerConnection }
export interface RTCTrackEvent { type: "track", track: MediaStreamTrack, streams: MediaStream[], receiver: RTCRtpReceiver, transceiver: RTCRtpTransceiver, target: RTCPeerConnection }
export interface RTCDataChannelEvent { type: "datachannel", channel: RTCDataChannel, target: RTCPeerConnection }
export interface RTCMessageEvent { type: "message", data: string | ArrayBuffer, target: RTCDataChannel }
export interface RTCErrorEvent { type: "error", message: string, target: RTCDataChannel }
export interface RTCEvent<T extends RTCEventTarget = RTCEventTarget> { type: string, target: T }

// ---- the media service: one session, the tracks by id ---------------------------------------------

let mediaService: RtcMediaBase | null = null
/** Every track the app holds, by the host's id: where the host's events find their object. */
const tracks = new Map<string, MediaStreamTrack>()
let nextLocalId = 1

const media = (): RtcMediaBase => {
  if (mediaService) return mediaService
  if (!RtcMediaBase.supports(MEDIA_NAME)) throw unsupported("mediaDevices", MEDIA_NAME, "service")
  mediaService = new RtcMediaBase()
  mediaService.on("trackEnded", ({ trackId }) => tracks.get(trackId)?._ended())
  mediaService.on("deviceChange", () => mediaDevices._dispatch({ type: "devicechange" }))
  return mediaService
}

/** The track object of a host id: the one the app holds, or a new one for an id first seen now. */
const trackOf = (info: TrackInfo, remote: boolean): MediaStreamTrack => {
  let track = tracks.get(info.id)
  if (!track) tracks.set(info.id, track = new MediaStreamTrack(info, remote))
  return track
}

/** One track of audio or video, local (`mediaDevices.getUserMedia`) or received (`pc.ontrack`). */
export class MediaStreamTrack extends RTCEventTarget {
  readonly id: string
  readonly kind: MediaKind
  readonly label: string
  /** @internal */
  readonly _remote: boolean
  private _enabled: boolean
  private _muted: boolean
  private _state: "live" | "ended" = "live"

  onended: RTCEventListener<RTCEvent<MediaStreamTrack>> | null = null
  onmute: RTCEventListener<RTCEvent<MediaStreamTrack>> | null = null
  onunmute: RTCEventListener<RTCEvent<MediaStreamTrack>> | null = null

  /** @internal */
  constructor(info: TrackInfo, remote: boolean) {
    super()
    this.id = info.id
    this.kind = info.kind
    this.label = info.label
    this._remote = remote
    this._enabled = info.enabled
    this._muted = info.muted ?? false
  }

  /** A disabled track sends silence / black frames and stays in every connection. */
  get enabled(): boolean { return this._enabled }
  set enabled(value: boolean) {
    if (this._enabled === value || this._state === "ended") return
    this._enabled = value
    if (!this._remote) media().setTrackEnabled(this.id, value).catch(() => {})
  }
  /** A received track the other side is not sending on. */
  get muted(): boolean { return this._muted }
  get readyState(): "live" | "ended" { return this._state }

  /** End the track: a local one releases its device (once no track of it is left). */
  stop(): void {
    if (this._state === "ended") return
    this._state = "ended"
    tracks.delete(this.id)
    if (!this._remote && mediaService) mediaService.stopTrack(this.id).catch(() => {})
  }

  /** Re-aim a local video track: the other camera (`facingMode`), another size or rate. */
  applyConstraints(constraints: VideoConstraints = {}): Promise<void> {
    if (this._remote || this.kind !== "video") return Promise.reject(new Error("applyConstraints: a local video track only"))
    return media().applyConstraints(this.id, constraints)
  }
  /** What a local video track captures with (a promise: the host knows). */
  getSettings(): Promise<TrackSettings> {
    if (this._remote) return Promise.resolve({})
    return media().getTrackSettings(this.id)
  }
  /** The same track object (a track is a handle, not a buffer). */
  clone(): MediaStreamTrack { return this }

  /** @internal The host reports the track gone. */
  _ended(): void {
    if (this._state === "ended") return
    this._state = "ended"
    tracks.delete(this.id)
    this._dispatch({ type: "ended" })
  }
  /** @internal */
  _setMuted(muted: boolean): void {
    if (this._muted === muted) return
    this._muted = muted
    this._dispatch({ type: muted ? "mute" : "unmute" })
  }
}

/** A group of tracks: what `getUserMedia` resolves with, what a `track` event names, what
 *  `addTrack` associates a track with. The id is a label on the wire. */
export class MediaStream extends RTCEventTarget {
  readonly id: string
  private readonly _tracks: MediaStreamTrack[]

  onaddtrack: RTCEventListener<{ type: "addtrack", track: MediaStreamTrack, target: MediaStream }> | null = null
  onremovetrack: RTCEventListener<{ type: "removetrack", track: MediaStreamTrack, target: MediaStream }> | null = null

  constructor(tracks: MediaStreamTrack[] | MediaStream = [], id?: string) {
    super()
    this.id = id ?? `s${nextLocalId++}`
    this._tracks = tracks instanceof MediaStream ? tracks.getTracks() : tracks.slice()
  }

  /** Whether a track of it is live. */
  get active(): boolean { return this._tracks.some(t => t.readyState === "live") }
  getTracks(): MediaStreamTrack[] { return this._tracks.slice() }
  getAudioTracks(): MediaStreamTrack[] { return this._tracks.filter(t => t.kind === "audio") }
  getVideoTracks(): MediaStreamTrack[] { return this._tracks.filter(t => t.kind === "video") }
  getTrackById(id: string): MediaStreamTrack | null { return this._tracks.find(t => t.id === id) ?? null }
  addTrack(track: MediaStreamTrack): void {
    if (this._tracks.includes(track)) return
    this._tracks.push(track)
    this._dispatch({ type: "addtrack", track })
  }
  removeTrack(track: MediaStreamTrack): void {
    const at = this._tracks.indexOf(track)
    if (at < 0) return
    this._tracks.splice(at, 1)
    this._dispatch({ type: "removetrack", track })
  }
  clone(): MediaStream { return new MediaStream(this._tracks) }
}

/** The constraints of `getUserMedia`, the browser's: `true` for the default device, an object to say which. */
export interface MediaStreamConstraints {
  audio?: boolean | AudioConstraints
  video?: boolean | VideoConstraints
}

class MediaDevices extends RTCEventTarget {
  ondevicechange: RTCEventListener<RTCEvent<MediaDevices>> | null = null

  /** Whether this host registered the "rtcMedia" service — the devices. */
  get isSupported(): boolean { return RtcMediaBase.supports(MEDIA_NAME) }

  /** Capture: asks for the permissions it needs, resolves with a stream of the new tracks. Rejects
   *  with "denied" / "notFound" / "failed". */
  async getUserMedia(constraints: MediaStreamConstraints = { audio: true, video: true }): Promise<MediaStream> {
    const wire: { audio?: AudioConstraints, video?: VideoConstraints } = {}
    if (constraints.audio) wire.audio = constraints.audio === true ? {} : constraints.audio
    if (constraints.video) wire.video = constraints.video === true ? {} : constraints.video
    if (!wire.audio && !wire.video) throw new Error("getUserMedia: audio or video must be requested")
    const info = await media().getUserMedia(wire)
    return new MediaStream(info.tracks.map(t => trackOf(t, false)), info.id)
  }
  /** The devices the host can capture with (their labels need a granted permission on the web). */
  enumerateDevices(): Promise<DeviceInfo[]> { return media().enumerateDevices() }
  /** Where the call's audio plays on a phone: the earpiece or the loudspeaker. A no-op on the web. */
  setAudioOutput(output: AudioOutput): Promise<void> { return media().setAudioOutput(output) }
}

/** `navigator.mediaDevices` of the browser: the capture and the device list. Host-optional —
 *  `mediaDevices.isSupported` before offering a call. */
// PURE IIFE so an app that never captures tree-shakes the media side away.
export const mediaDevices: MediaDevices = /*#__PURE__*/ (() => new MediaDevices())()

// ---- the peer connection ---------------------------------------------------------------------------

/** The browser's RTCSessionDescription: `{ type, sdp }`, as it is signaled. */
export class RTCSessionDescription implements SessionDescription {
  readonly type: SdpType
  readonly sdp: string
  constructor(init: SessionDescription) { this.type = init.type; this.sdp = init.sdp }
  toJSON(): SessionDescription { return { type: this.type, sdp: this.sdp } }
}

/** The browser's RTCIceCandidate: what `icecandidate` carries and `addIceCandidate` takes. */
export class RTCIceCandidate implements IceCandidate {
  readonly candidate: string
  readonly sdpMid: string | null
  readonly sdpMLineIndex: number | null
  readonly usernameFragment: string | undefined
  constructor(init: RTCIceCandidateInit) {
    this.candidate = init.candidate ?? ""
    this.sdpMid = init.sdpMid ?? null
    this.sdpMLineIndex = init.sdpMLineIndex ?? null
    this.usernameFragment = init.usernameFragment
  }
  toJSON(): IceCandidate {
    const json: IceCandidate = { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex }
    if (this.usernameFragment !== undefined) json.usernameFragment = this.usernameFragment
    return json
  }
}
export interface RTCIceCandidateInit { candidate?: string, sdpMid?: string | null, sdpMLineIndex?: number | null, usernameFragment?: string }

/** The sending half of a transceiver: the track it sends and its encodings. */
export class RTCRtpSender {
  /** @internal */
  readonly _id: string
  private readonly _pc: RTCPeerConnection
  private _track: MediaStreamTrack | null

  /** @internal */
  constructor(pc: RTCPeerConnection, info: SenderInfo) {
    this._pc = pc
    this._id = info.id
    this._track = info.trackId ? tracks.get(info.trackId) ?? null : null
  }
  /** What it sends; null = nothing. */
  get track(): MediaStreamTrack | null { return this._track }
  /** Swap the track without renegotiating; null = send nothing. */
  async replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    await this._pc._s.replaceTrack(this._id, track?.id ?? null)
    this._track = track
  }
  /** The encodings (a promise: the host holds them). */
  getParameters(): Promise<SenderParameters> { return this._pc._s.getSenderParameters(this._id) }
  /** The encodings' active / bitrate / scale. */
  setParameters(parameters: SenderParameters): Promise<void> { return this._pc._s.setSenderParameters(this._id, parameters) }
  /** The stats of this sender. */
  getStats(): Promise<Map<string, any>> { return this._pc.getStats(this._track) }
  /** @internal */
  _update(info: SenderInfo): void { this._track = info.trackId ? tracks.get(info.trackId) ?? this._track : null }
}

/** The receiving half of a transceiver: its track exists from the start, media arrives into it. */
export class RTCRtpReceiver {
  readonly track: MediaStreamTrack
  private readonly _pc: RTCPeerConnection
  /** @internal */
  constructor(pc: RTCPeerConnection, track: MediaStreamTrack) { this._pc = pc; this.track = track }
  getStats(): Promise<Map<string, any>> { return this._pc.getStats(this.track) }
}

/** One m-line of the session: a sender and a receiver, a direction, a mid once negotiated. */
export class RTCRtpTransceiver {
  /** @internal */
  readonly _id: string
  readonly sender: RTCRtpSender
  readonly receiver: RTCRtpReceiver
  private readonly _pc: RTCPeerConnection
  private _mid: string | null
  private _direction: TransceiverDirection
  private _currentDirection: TransceiverDirection | null
  private _stopped: boolean

  /** @internal */
  constructor(pc: RTCPeerConnection, info: TransceiverInfo) {
    this._pc = pc
    this._id = info.id
    this.sender = new RTCRtpSender(pc, info.sender)
    this.receiver = new RTCRtpReceiver(pc, trackOf(info.receiverTrack, true))
    this._mid = info.mid
    this._direction = info.direction
    this._currentDirection = info.currentDirection
    this._stopped = info.stopped
  }
  /** The m-line's id once a description named it. */
  get mid(): string | null { return this._mid }
  /** The direction wanted; setting it takes effect at the next negotiation. */
  get direction(): TransceiverDirection { return this._direction }
  set direction(value: TransceiverDirection) {
    if (this._direction === value) return
    this._direction = value
    this._pc._s.setTransceiverDirection(this._id, value).catch(() => {})
  }
  /** The direction negotiated; null before the first answer. */
  get currentDirection(): TransceiverDirection | null { return this._currentDirection }
  get stopped(): boolean { return this._stopped }
  /** Stop sending and receiving on it; the next negotiation removes the m-line. */
  stop(): void {
    if (this._stopped) return
    this._stopped = true
    this._direction = "stopped"
    this._pc._s.stopTransceiver(this._id).catch(() => {})
  }
  /** @internal */
  _update(info: TransceiverInfo): void {
    this._mid = info.mid
    this._direction = info.direction
    this._currentDirection = info.currentDirection
    this._stopped = info.stopped
    this.sender._update(info.sender)
  }
}

/** A data channel: strings and bytes, ordered and reliable unless said otherwise. */
export class RTCDataChannel extends RTCEventTarget {
  readonly label: string
  readonly ordered: boolean
  readonly maxPacketLifeTime: number | null
  readonly maxRetransmits: number | null
  readonly protocol: string
  readonly negotiated: boolean
  /** Bytes arrive as an ArrayBuffer (the browser's "blob" is not a thing here). */
  binaryType: "arraybuffer" = "arraybuffer"
  private readonly _pc: RTCPeerConnection
  /** @internal The host's id; null until the host made the channel. */
  _id: string | null
  private _streamId: number | null
  private _state: DataChannelState
  private _threshold = 0
  /** What was sent before the host made the channel. */
  private _queue: (string | Uint8Array)[] | null = null

  onopen: RTCEventListener<RTCEvent<RTCDataChannel>> | null = null
  onclose: RTCEventListener<RTCEvent<RTCDataChannel>> | null = null
  onerror: RTCEventListener<RTCErrorEvent> | null = null
  onmessage: RTCEventListener<RTCMessageEvent> | null = null
  onbufferedamountlow: RTCEventListener<RTCEvent<RTCDataChannel>> | null = null

  /** @internal `info` for a channel the host already made (the other side's); `init` + a label for
   *  one being made. */
  constructor(pc: RTCPeerConnection, label: string, init: DataChannelInit, info: DataChannelInfo | null) {
    super()
    this._pc = pc
    this.label = info?.label ?? label
    this.ordered = info?.ordered ?? init.ordered ?? true
    this.maxPacketLifeTime = info?.maxPacketLifeTime ?? init.maxPacketLifeTime ?? null
    this.maxRetransmits = info?.maxRetransmits ?? init.maxRetransmits ?? null
    this.protocol = info?.protocol ?? init.protocol ?? ""
    this.negotiated = info?.negotiated ?? init.negotiated ?? false
    this._id = info?.id ?? null
    this._streamId = info?.streamId ?? init.id ?? null
    this._state = info?.readyState ?? "connecting"
    if (!info) this._queue = []
  }

  /** The SCTP stream id; null until the transport assigned one. */
  get id(): number | null { return this._streamId }
  get readyState(): DataChannelState { return this._state }
  /** Bytes queued and not yet sent (a promise: the host counts them). */
  getBufferedAmount(): Promise<number> { return this._id ? this._pc._s.getBufferedAmount(this._id) : Promise.resolve(0) }
  get bufferedAmountLowThreshold(): number { return this._threshold }
  set bufferedAmountLowThreshold(value: number) {
    this._threshold = value
    if (this._id) this._pc._s.setBufferedAmountLowThreshold(this._id, value).catch(() => {})
  }

  /** Send a string or bytes. Throws when the channel is closing or closed. */
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this._state === "closing" || this._state === "closed") throw new Error("RTCDataChannel.send: the channel is " + this._state)
    const payload = typeof data === "string" ? data
      : data instanceof ArrayBuffer ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (this._queue) { this._queue.push(payload); return }
    this._send(payload)
  }
  private _send(payload: string | Uint8Array): void {
    const id = this._id!
    const sent = typeof payload === "string" ? this._pc._s.sendText(id, payload) : this._pc._s.sendBinary(id, payload)
    sent.catch(e => this._dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) }))
  }
  close(): void {
    if (this._state === "closed" || this._state === "closing") return
    this._state = "closing"
    this._queue = null
    if (this._id) this._pc._s.closeDataChannel(this._id).catch(() => {})
    else this._setState("closed")
  }

  /** @internal The host made it: flush what was sent meanwhile. */
  _made(info: DataChannelInfo): void {
    this._id = info.id
    this._streamId = info.streamId
    if (this._threshold) this._pc._s.setBufferedAmountLowThreshold(info.id, this._threshold).catch(() => {})
    const queue = this._queue
    this._queue = null
    if (this._state === "closing") { this._pc._s.closeDataChannel(info.id).catch(() => {}); return }
    if (info.readyState !== this._state) this._setState(info.readyState)
    if (queue) for (const payload of queue) this._send(payload)
  }
  /** @internal */
  _setState(state: DataChannelState): void {
    if (this._state === state) return
    this._state = state
    if (state === "open") this._dispatch({ type: "open" })
    else if (state === "closed") this._dispatch({ type: "close" })
  }
  /** @internal */
  _message(text: string | undefined, binary: Uint8Array | undefined): void {
    const data = text !== undefined ? text : binary ? binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) : ""
    this._dispatch({ type: "message", data })
  }
}

/** `RTCConfiguration` of the browser, with `iceServers[].urls` as one URL or several. */
export interface RTCConfiguration extends Omit<RtcConfiguration, "iceServers"> {
  iceServers?: { urls: string | string[], username?: string, credential?: string }[]
}

const configurationWire = (config: RTCConfiguration): RtcConfiguration => {
  const { iceServers, ...rest } = config
  const wire: RtcConfiguration = { ...rest }
  if (iceServers) {
    wire.iceServers = iceServers.map(s => {
      const server: IceServer = { urls: Array.isArray(s.urls) ? s.urls : [s.urls] }
      if (s.username !== undefined) server.username = s.username
      if (s.credential !== undefined) server.credential = s.credential
      return server
    })
  }
  return wire
}

const descriptionOf = (d: SessionDescription | RTCSessionDescription | { type: SdpType, sdp?: string }): SessionDescription =>
  ({ type: d.type, sdp: d.sdp ?? "" })

/** A connection to one peer: the browser's RTCPeerConnection. The session with the host opens on
 *  the first call and closes with `close()`. Signaling — carrying the descriptions and the
 *  candidates to the other side — is the app's. */
export class RTCPeerConnection extends RTCEventTarget {
  /** Whether this host registered the "rtcPeerConnection" service. */
  static get isSupported(): boolean { return RtcPeerConnectionBase.supports(PC_NAME) }

  /** @internal The session. */
  readonly _s: RtcPeerConnectionBase
  private _configuration: RTCConfiguration
  private _local: RTCSessionDescription | null = null
  private _remote: RTCSessionDescription | null = null
  private _signaling: SignalingState = "stable"
  private _gathering: IceGatheringState = "new"
  private _ice: IceConnectionState = "new"
  private _connection: PeerConnectionState = "new"
  private readonly _transceivers: RTCRtpTransceiver[] = []
  private readonly _channels = new Map<string, RTCDataChannel>()
  private readonly _remoteTracks = new Set<string>()
  /** While a local description is being set, its candidates wait: the browser delivers them
   *  after the promise, and the app's signaling expects the description first. */
  private _settingLocal = 0
  private _heldCandidates: (RTCIceCandidate | null)[] = []
  /** After the app's close(): what the host still says of the dying session is not an event (the
   *  browser fires none for close()). */
  private _closedByApp = false

  onnegotiationneeded: RTCEventListener<RTCEvent<RTCPeerConnection>> | null = null
  onicecandidate: RTCEventListener<RTCPeerConnectionIceEvent> | null = null
  onsignalingstatechange: RTCEventListener<RTCEvent<RTCPeerConnection>> | null = null
  onicegatheringstatechange: RTCEventListener<RTCEvent<RTCPeerConnection>> | null = null
  oniceconnectionstatechange: RTCEventListener<RTCEvent<RTCPeerConnection>> | null = null
  onconnectionstatechange: RTCEventListener<RTCEvent<RTCPeerConnection>> | null = null
  ontrack: RTCEventListener<RTCTrackEvent> | null = null
  ondatachannel: RTCEventListener<RTCDataChannelEvent> | null = null

  constructor(configuration: RTCConfiguration = {}) {
    super()
    if (!RtcPeerConnectionBase.supports(PC_NAME)) throw unsupported("RTCPeerConnection", PC_NAME, "service")
    this._configuration = configuration
    const s = this._s = new RtcPeerConnectionBase(configurationWire(configuration))
    const on: typeof s.on = (event, callback) => s.on(event, ((payload?: any) => { if (!this._closedByApp) (callback as any)(payload) }) as any)
    on("negotiationNeeded", () => this._dispatch({ type: "negotiationneeded" }))
    on("iceCandidate", ({ candidate }) => {
      const ice = candidate ? new RTCIceCandidate(candidate) : null
      if (this._settingLocal > 0) this._heldCandidates.push(ice)
      else this._dispatch({ type: "icecandidate", candidate: ice })
    })
    on("signalingStateChange", ({ state }) => { this._signaling = state; this._dispatch({ type: "signalingstatechange" }) })
    on("iceGatheringStateChange", ({ state }) => { this._gathering = state; this._dispatch({ type: "icegatheringstatechange" }) })
    on("iceConnectionStateChange", ({ state }) => { this._ice = state; this._dispatch({ type: "iceconnectionstatechange" }) })
    on("connectionStateChange", ({ state }) => { this._connection = state; this._dispatch({ type: "connectionstatechange" }) })
    on("track", ({ track, streamIds, transceiverId }) => { this._onTrack(track, streamIds, transceiverId).catch(() => {}) })
    on("trackMute", ({ trackId, muted }) => tracks.get(trackId)?._setMuted(muted))
    on("trackEnded", ({ trackId }) => tracks.get(trackId)?._ended())
    on("dataChannel", info => {
      const channel = new RTCDataChannel(this, info.label, {}, info)
      this._channels.set(info.id, channel)
      this._dispatch({ type: "datachannel", channel })
    })
    on("dataChannelStateChange", ({ id, state }) => {
      const channel = this._channels.get(id)
      if (!channel) return
      channel._setState(state)
      if (state === "closed") this._channels.delete(id)
    })
    on("dataChannelMessage", ({ id, text, binary }) => this._channels.get(id)?._message(text, binary))
    on("dataChannelError", ({ id, message }) => this._channels.get(id)?._dispatch({ type: "error", message }))
    on("dataChannelBufferedAmountLow", ({ id }) => this._channels.get(id)?._dispatch({ type: "bufferedamountlow" }))
  }

  get localDescription(): RTCSessionDescription | null { return this._local }
  get remoteDescription(): RTCSessionDescription | null { return this._remote }
  get currentLocalDescription(): RTCSessionDescription | null { return this._local }
  get currentRemoteDescription(): RTCSessionDescription | null { return this._remote }
  get signalingState(): SignalingState { return this._signaling }
  get iceGatheringState(): IceGatheringState { return this._gathering }
  get iceConnectionState(): IceConnectionState { return this._ice }
  get connectionState(): PeerConnectionState { return this._connection }

  async createOffer(options?: OfferOptions): Promise<RTCSessionDescription> {
    return new RTCSessionDescription(await this._s.createOffer(options))
  }
  async createAnswer(): Promise<RTCSessionDescription> {
    return new RTCSessionDescription(await this._s.createAnswer())
  }
  /** Without a description: the implicit form — an answer to a pending remote offer, an offer
   *  otherwise. `localDescription` holds what is in force after. */
  async setLocalDescription(description?: SessionDescription | RTCSessionDescription | { type: SdpType, sdp?: string }): Promise<void> {
    this._settingLocal++
    try {
      const inForce = await this._s.setLocalDescription(description ? descriptionOf(description) : undefined)
      this._local = new RTCSessionDescription(inForce)
      await this._syncTransceivers()
    } finally {
      this._settingLocal--
      if (this._settingLocal === 0) {
        const held = this._heldCandidates
        this._heldCandidates = []
        // a task after the promise settled, like the browser's: the caller sends the description first
        if (held.length) setTimeout(() => { for (const ice of held) this._dispatch({ type: "icecandidate", candidate: ice }) }, 0)
      }
    }
  }
  async setRemoteDescription(description: SessionDescription | RTCSessionDescription | { type: SdpType, sdp?: string }): Promise<void> {
    const wire = descriptionOf(description)
    await this._s.setRemoteDescription(wire)
    this._remote = wire.type === "rollback" ? null : new RTCSessionDescription(wire)
    await this._syncTransceivers()
  }
  /** A candidate of the other side; none (or an empty one) = the end of its candidates. */
  addIceCandidate(candidate?: RTCIceCandidateInit | RTCIceCandidate | null): Promise<void> {
    if (!candidate || !candidate.candidate) return this._s.addIceCandidate()
    return this._s.addIceCandidate(new RTCIceCandidate(candidate).toJSON())
  }
  /** The next offer carries new ICE credentials. */
  restartIce(): void { this._s.restartIce().catch(() => {}) }
  getConfiguration(): RTCConfiguration { return this._configuration }
  async setConfiguration(configuration: RTCConfiguration): Promise<void> {
    await this._s.setConfiguration(configurationWire(configuration))
    this._configuration = configuration
  }

  /** Send a local track, in the streams named (the browser's `addTrack(track, ...streams)`). The
   *  sender is known once the host made it: a promise, where the browser answers at once. */
  async addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): Promise<RTCRtpSender> {
    const info = await this._s.addTrack(track.id, streams.map(s => s.id))
    await this._syncTransceivers()
    return this._transceivers.find(t => t.sender._id === info.id)?.sender ?? new RTCRtpSender(this, info)
  }
  async removeTrack(sender: RTCRtpSender): Promise<void> {
    await this._s.removeTrack(sender._id)
    sender._update({ id: sender._id, trackId: null })
  }
  /** Add an m-line: for a kind, or for a track to send on it. A promise, where the browser answers at once. */
  async addTransceiver(trackOrKind: MediaStreamTrack | MediaKind, init: Omit<TransceiverInit, "trackId" | "streamIds"> & { streams?: MediaStream[] } = {}): Promise<RTCRtpTransceiver> {
    const { streams, ...rest } = init
    const wire: TransceiverInit = { ...rest }
    if (typeof trackOrKind !== "string") wire.trackId = trackOrKind.id
    if (streams) wire.streamIds = streams.map(s => s.id)
    const info = await this._s.addTransceiver(typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind, wire)
    return this._transceiverOf(info)
  }
  /** The transceivers as last synced (after every description, on every `track` event). */
  getTransceivers(): RTCRtpTransceiver[] { return this._transceivers.slice() }
  getSenders(): RTCRtpSender[] { return this._transceivers.map(t => t.sender) }
  getReceivers(): RTCRtpReceiver[] { return this._transceivers.map(t => t.receiver) }

  /** The RTCStatsReport: a Map of the stats id → the stats object (`type`, `timestamp` in ms, the
   *  fields of its type), for the whole connection or one track's senders / receivers. */
  async getStats(selector?: MediaStreamTrack | null): Promise<Map<string, any>> {
    const report = await this._s.getStats(selector?.id)
    const map = new Map<string, any>()
    if (report && typeof report === "object" && !Array.isArray(report)) for (const [id, stats] of Object.entries(report)) map.set(id, stats)
    return map
  }

  /** Open a data channel. The channel is "connecting" until the host and the other side are ready;
   *  what is sent before counts as queued. */
  createDataChannel(label: string, init: DataChannelInit = {}): RTCDataChannel {
    const channel = new RTCDataChannel(this, label, init, null)
    this._s.createDataChannel(label, init).then(
      info => { this._channels.set(info.id, channel); channel._made(info) },
      e => { channel._dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) }); channel._setState("closed") },
    )
    return channel
  }

  /** Close the connection: the session with the host ends, every received track ends, every
   *  channel closes. */
  close(): void {
    if (this._connection === "closed") return
    this._closedByApp = true
    this._connection = "closed"
    this._signaling = "closed"
    this._ice = "closed"
    this._s.close()
    for (const channel of this._channels.values()) channel._setState("closed")
    this._channels.clear()
    for (const id of this._remoteTracks) tracks.get(id)?._ended()
    this._remoteTracks.clear()
  }

  private _transceiverOf(info: TransceiverInfo): RTCRtpTransceiver {
    let transceiver = this._transceivers.find(t => t._id === info.id)
    if (transceiver) transceiver._update(info)
    else this._transceivers.push(transceiver = new RTCRtpTransceiver(this, info))
    this._remoteTracks.add(info.receiverTrack.id)
    return transceiver
  }
  private async _syncTransceivers(): Promise<void> {
    if (this._connection === "closed") return
    const infos = await this._s.getTransceivers()
    for (const info of infos) this._transceiverOf(info)
  }
  private async _onTrack(info: TrackInfo, streamIds: string[], transceiverId: string): Promise<void> {
    const track = trackOf(info, true)
    this._remoteTracks.add(track.id)
    await this._syncTransceivers()
    let transceiver = this._transceivers.find(t => t._id === transceiverId)
    if (!transceiver) {
      // The host told of a transceiver the sync did not list (closed meanwhile): stand one up for the event.
      transceiver = new RTCRtpTransceiver(this, { id: transceiverId, mid: null, direction: "recvonly", currentDirection: null, sender: { id: "", trackId: null }, receiverTrack: info, stopped: false })
    }
    const streams = streamIds.map(id => new MediaStream([track], id))
    this._dispatch({ type: "track", track, streams, receiver: transceiver.receiver, transceiver })
  }
}

// ---- the picture -----------------------------------------------------------------------------------

export interface RTCVideoViewOptions {
  /** The track to draw; none = black. */
  track?: MediaStreamTrack | null
  /** Default "cover". */
  objectFit?: ObjectFit
  /** Flip horizontally — the front camera's preview. Default false. */
  mirror?: boolean
}

/** A tree node that draws one video track: embed it among a screen's children (sized by its
 *  styles) or present it fullscreen (`open()`). `track` may change at any time. */
export interface RTCVideoView extends NativeView {
  /** The track drawn; null = black. */
  track: MediaStreamTrack | null
  objectFit: ObjectFit
  mirror: boolean
  /** `resize`: the first frame, and every change of the picture's size. */
  on<K extends keyof RtcVideoEvents & string>(event: K, callback: Listener<RtcVideoEvents, K>): this
  off<K extends keyof RtcVideoEvents & string>(event: K, callback: Listener<RtcVideoEvents, K>): this
}

class RTCVideoViewElement extends RtcVideoBase {
  private _track: MediaStreamTrack | null
  private _objectFit: ObjectFit
  private _mirror: boolean

  constructor(options: RTCVideoViewOptions) {
    super({ ...(options.track ? { trackId: options.track.id } : {}), objectFit: options.objectFit ?? "cover", mirror: options.mirror ?? false })
    this._track = options.track ?? null
    this._objectFit = options.objectFit ?? "cover"
    this._mirror = options.mirror ?? false
  }
  get track(): MediaStreamTrack | null { return this._track }
  set track(track: MediaStreamTrack | null) {
    if (this._track === track) return
    this._track = track
    this.setTrack(track?.id ?? null).catch(() => {})
  }
  get objectFit(): ObjectFit { return this._objectFit }
  set objectFit(fit: ObjectFit) {
    if (this._objectFit === fit) return
    this._objectFit = fit
    this.setObjectFit(fit).catch(() => {})
  }
  get mirror(): boolean { return this._mirror }
  set mirror(mirror: boolean) {
    if (this._mirror === mirror) return
    this._mirror = mirror
    this.setMirror(mirror).catch(() => {})
  }
}

/**
 * Create a video view. `RTCVideoView.isSupported` reports whether this host has the capability —
 * check it before offering the feature (a view no host registered mounts nothing).
 */
// PURE IIFE so an app that never shows a track tree-shakes the view away.
export const RTCVideoView: {
  (options?: RTCVideoViewOptions): RTCVideoView
  /** Whether this host registered an "rtcVideo" view. */
  readonly isSupported: boolean
} = /*#__PURE__*/ (() => {
  const factory = (options: RTCVideoViewOptions = {}): RTCVideoView => new RTCVideoViewElement(options) as unknown as RTCVideoView
  Object.defineProperty(factory, "isSupported", { get: (): boolean => RtcVideoBase.supports(VIDEO_NAME) })
  return factory as any
})()
