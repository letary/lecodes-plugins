// webrtc on the web: the browser's own stack. A track, a sender, a transceiver and a data channel
// are the browser's objects, kept here by an id the half allocates (a track by its own id); the
// picture — the fullscreen view's and the host node's (`UIRTCVideoNode`, Web Lite's `hostnode`
// feature) — is a <video> fed by a MediaStream of the one track.
//
// The channel is the contract's (../contract.d.ts): webrtc.gen.ts is generated from it, this file
// implements its RtcMediaPlugin, RtcPeerConnectionPlugin, RtcVideoPlugin and UIRTCVideoNodeHalf.

import {
  RtcMediaError, RtcPeerConnectionError, RtcVideoError, registerRtcMedia, registerRtcPeerConnection, registerRtcVideo, registerUIRTCVideoNode,
  type DataChannelInfo, type DataChannelInit, type DeviceInfo, type IceCandidate, type Json, type MediaConstraints, type ObjectFit,
  type OfferOptions, type PluginHost, type RtcConfiguration, type RtcMediaPlugin, type RtcPeerConnectionEvents,
  type RtcPeerConnectionPlugin, type RtcVideoPlugin, type SenderInfo, type SenderParameters, type SessionDescription,
  type StreamInfo, type TrackInfo, type TrackSettings, type TransceiverDirection, type TransceiverInfo, type TransceiverInit,
  type UIRTCVideoNodeHalf, type VideoConstraints,
} from "./webrtc.gen"

// ---- the registry: the browser's objects by the ids on the wire ----------------------------------

/** Every track the app knows, by its id — local ones from getUserMedia, received ones from the
 *  connections. One for the page: a received track may be shown by a view and sent on by another
 *  connection. */
const tracks = new Map<string, MediaStreamTrack>()
/** The streams the app named, by the id it gave: a stream is made up for an id first seen. */
const streams = new Map<string, MediaStream>()
/** The facing a local video track was opened with — the browser's getSettings() may not say. */
const facings = new Map<string, "user" | "environment">()
let nextId = 1
const allocate = (prefix: string): string => `${prefix}${nextId++}`

const trackInfo = (track: MediaStreamTrack): TrackInfo =>
  ({ id: track.id, kind: track.kind as "audio" | "video", label: track.label, enabled: track.enabled, muted: track.muted })

const streamOf = (id: string): MediaStream => {
  let stream = streams.get(id)
  if (!stream) streams.set(id, stream = new MediaStream())
  return stream
}

const message = (e: unknown): string => e instanceof Error ? e.message : String(e)

// ---- media ------------------------------------------------------------------------------------------

const videoConstraints = (c: VideoConstraints): MediaTrackConstraints => {
  const out: MediaTrackConstraints = {}
  if (c.deviceId) out.deviceId = { exact: c.deviceId }
  else if (c.facingMode) out.facingMode = c.facingMode
  if (c.width) out.width = { ideal: c.width }
  if (c.height) out.height = { ideal: c.height }
  if (c.frameRate) out.frameRate = { ideal: c.frameRate }
  return out
}

const mediaCode = (e: unknown): RtcMediaError => {
  const name = e instanceof DOMException ? e.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return new RtcMediaError("denied")
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") return new RtcMediaError("notFound")
  return new RtcMediaError("failed")
}

const makeMedia = (host: PluginHost): void => {
  registerRtcMedia(host, (_params, events): RtcMediaPlugin => {
    const onDeviceChange = (): void => events.deviceChange()
    navigator.mediaDevices.addEventListener?.("devicechange", onDeviceChange)

    return {
      async getUserMedia(constraints: MediaConstraints): Promise<StreamInfo> {
        const wanted: MediaStreamConstraints = {}
        if (constraints.audio) {
          const a = constraints.audio
          const audio: MediaTrackConstraints = {}
          if (a.deviceId) audio.deviceId = { exact: a.deviceId }
          if (a.echoCancellation !== undefined) audio.echoCancellation = a.echoCancellation
          if (a.noiseSuppression !== undefined) audio.noiseSuppression = a.noiseSuppression
          if (a.autoGainControl !== undefined) audio.autoGainControl = a.autoGainControl
          wanted.audio = Object.keys(audio).length ? audio : true
        }
        if (constraints.video) {
          const video = videoConstraints(constraints.video)
          if (!constraints.video.deviceId && !constraints.video.facingMode) video.facingMode = "user"
          wanted.video = video
        }
        let stream: MediaStream
        try { stream = await navigator.mediaDevices.getUserMedia(wanted) } catch (e) { throw mediaCode(e) }
        for (const track of stream.getTracks()) {
          tracks.set(track.id, track)
          if (track.kind === "video") facings.set(track.id, constraints.video?.facingMode ?? "user")
          track.addEventListener("ended", () => { if (tracks.get(track.id) === track) { tracks.delete(track.id); events.trackEnded({ trackId: track.id }) } })
        }
        streams.set(stream.id, stream)
        return { id: stream.id, tracks: stream.getTracks().map(trackInfo) }
      },
      async enumerateDevices(): Promise<DeviceInfo[]> {
        const devices = await navigator.mediaDevices.enumerateDevices()
        return devices.map(d => ({ deviceId: d.deviceId, kind: d.kind, label: d.label }))
      },
      setTrackEnabled(trackId, enabled) {
        const track = tracks.get(trackId)
        if (!track) throw new RtcMediaError("notFound")
        track.enabled = enabled
      },
      async applyConstraints(trackId, constraints) {
        const track = tracks.get(trackId)
        if (!track || track.kind !== "video") throw new RtcMediaError("notFound")
        try { await track.applyConstraints(videoConstraints(constraints)) } catch { throw new RtcMediaError("failed") }
        if (constraints.facingMode) facings.set(trackId, constraints.facingMode)
      },
      getTrackSettings(trackId) {
        const track = tracks.get(trackId)
        if (!track) throw new RtcMediaError("notFound")
        const s = track.getSettings()
        const out: TrackSettings = {}
        if (s.deviceId) out.deviceId = s.deviceId
        const facing = (s.facingMode as "user" | "environment" | undefined) ?? facings.get(trackId)
        if (facing) out.facingMode = facing
        if (s.width) out.width = s.width
        if (s.height) out.height = s.height
        if (s.frameRate) out.frameRate = s.frameRate
        return out
      },
      stopTrack(trackId) {
        const track = tracks.get(trackId)
        if (!track) return
        tracks.delete(trackId)
        facings.delete(trackId)
        track.stop()
      },
      setAudioOutput() { /* the browser routes its own audio */ },
      close() {
        navigator.mediaDevices.removeEventListener?.("devicechange", onDeviceChange)
      },
    }
  })
}

// ---- the peer connection ---------------------------------------------------------------------------

const configuration = (c: RtcConfiguration): RTCConfiguration => {
  const out: RTCConfiguration = {}
  if (c.iceServers) out.iceServers = c.iceServers.map(s => ({ urls: s.urls, ...(s.username !== undefined ? { username: s.username } : {}), ...(s.credential !== undefined ? { credential: s.credential } : {}) }))
  if (c.iceTransportPolicy) out.iceTransportPolicy = c.iceTransportPolicy
  if (c.bundlePolicy) out.bundlePolicy = c.bundlePolicy
  if (c.iceCandidatePoolSize !== undefined) out.iceCandidatePoolSize = c.iceCandidatePoolSize
  return out
}

const pcCode = (e: unknown): RtcPeerConnectionError =>
  new RtcPeerConnectionError(e instanceof DOMException && e.name === "InvalidStateError" && /closed/i.test(e.message) ? "closed" : "failed")

const description = (d: RTCSessionDescription | RTCSessionDescriptionInit | null): SessionDescription =>
  ({ type: (d?.type ?? "offer") as SessionDescription["type"], sdp: d?.sdp ?? "" })

const makePeerConnection = (host: PluginHost): void => {
  registerRtcPeerConnection(host, (params, events): RtcPeerConnectionPlugin => {
    const pc = new RTCPeerConnection(configuration(params))
    const senders = new Map<string, RTCRtpSender>()
    const senderIds = new Map<RTCRtpSender, string>()
    const transceivers = new Map<string, RTCRtpTransceiver>()
    const transceiverIds = new Map<RTCRtpTransceiver, string>()
    const channels = new Map<string, RTCDataChannel>()
    /** The received tracks this connection told the app of. */
    const received = new Set<string>()
    let closed = false

    const senderId = (sender: RTCRtpSender): string => {
      let id = senderIds.get(sender)
      if (!id) { id = allocate("sender"); senderIds.set(sender, id); senders.set(id, sender) }
      return id
    }
    const transceiverId = (t: RTCRtpTransceiver): string => {
      let id = transceiverIds.get(t)
      if (!id) { id = allocate("transceiver"); transceiverIds.set(t, id); transceivers.set(id, t) }
      return id
    }
    const senderInfo = (sender: RTCRtpSender): SenderInfo => ({ id: senderId(sender), trackId: sender.track?.id ?? null })
    const watchReceived = (track: MediaStreamTrack): void => {
      if (received.has(track.id)) return
      received.add(track.id)
      tracks.set(track.id, track)
      track.addEventListener("mute", () => events.trackMute({ trackId: track.id, muted: true }))
      track.addEventListener("unmute", () => events.trackMute({ trackId: track.id, muted: false }))
      track.addEventListener("ended", () => { if (tracks.get(track.id) === track) tracks.delete(track.id); events.trackEnded({ trackId: track.id }) })
    }
    const transceiverInfo = (t: RTCRtpTransceiver): TransceiverInfo => {
      watchReceived(t.receiver.track)
      return {
        id: transceiverId(t), mid: t.mid, direction: t.direction as TransceiverDirection,
        currentDirection: (t.currentDirection as TransceiverDirection | null) ?? null,
        sender: senderInfo(t.sender), receiverTrack: trackInfo(t.receiver.track), stopped: t.direction === "stopped",
      }
    }
    const channelInfo = (id: string, c: RTCDataChannel): DataChannelInfo => ({
      id, label: c.label, ordered: c.ordered, maxPacketLifeTime: c.maxPacketLifeTime ?? null, maxRetransmits: c.maxRetransmits ?? null,
      protocol: c.protocol, negotiated: c.negotiated, streamId: c.id ?? null, readyState: c.readyState,
    })
    const watchChannel = (id: string, c: RTCDataChannel): void => {
      channels.set(id, c)
      c.binaryType = "arraybuffer"
      c.addEventListener("open", () => events.dataChannelStateChange({ id, state: "open" }))
      c.addEventListener("closing", () => events.dataChannelStateChange({ id, state: "closing" }))
      c.addEventListener("close", () => { channels.delete(id); events.dataChannelStateChange({ id, state: "closed" }) })
      c.addEventListener("error", (e) => events.dataChannelError({ id, message: message((e as RTCErrorEvent).error ?? "error") }))
      c.addEventListener("bufferedamountlow", () => events.dataChannelBufferedAmountLow({ id }))
      c.addEventListener("message", (e) => {
        const data = (e as MessageEvent).data
        if (typeof data === "string") events.dataChannelMessage({ id, text: data })
        else events.dataChannelMessage({ id, binary: new Uint8Array(data as ArrayBuffer) })
      })
    }
    const channel = (id: string): RTCDataChannel => {
      const c = channels.get(id)
      if (!c) throw new RtcPeerConnectionError("notFound")
      return c
    }
    const sender = (id: string): RTCRtpSender => {
      const s = senders.get(id)
      if (!s) throw new RtcPeerConnectionError("notFound")
      return s
    }
    const localTrack = (id: string): MediaStreamTrack => {
      const t = tracks.get(id)
      if (!t) throw new RtcPeerConnectionError("notFound")
      return t
    }
    const guard = (): void => { if (closed) throw new RtcPeerConnectionError("closed") }

    pc.addEventListener("negotiationneeded", () => events.negotiationNeeded())
    pc.addEventListener("icecandidate", (e) => {
      const c = e.candidate
      const candidate: IceCandidate | null = c && c.candidate ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, ...(c.usernameFragment ? { usernameFragment: c.usernameFragment } : {}) } : null
      events.iceCandidate({ candidate })
    })
    pc.addEventListener("signalingstatechange", () => events.signalingStateChange({ state: pc.signalingState }))
    pc.addEventListener("icegatheringstatechange", () => events.iceGatheringStateChange({ state: pc.iceGatheringState }))
    pc.addEventListener("iceconnectionstatechange", () => events.iceConnectionStateChange({ state: pc.iceConnectionState }))
    pc.addEventListener("connectionstatechange", () => events.connectionStateChange({ state: pc.connectionState }))
    pc.addEventListener("track", (e) => {
      watchReceived(e.track)
      for (const s of e.streams) streams.set(s.id, s)
      events.track({ track: trackInfo(e.track), streamIds: e.streams.map(s => s.id), transceiverId: transceiverId(e.transceiver) })
    })
    pc.addEventListener("datachannel", (e) => {
      const id = allocate("channel")
      watchChannel(id, e.channel)
      events.dataChannel(channelInfo(id, e.channel))
    })

    return {
      async createOffer(options?: OfferOptions) {
        guard()
        try { return description(await pc.createOffer(options ?? {})) } catch (e) { throw pcCode(e) }
      },
      async createAnswer() {
        guard()
        try { return description(await pc.createAnswer()) } catch (e) { throw pcCode(e) }
      },
      async setLocalDescription(d?: SessionDescription) {
        guard()
        try { if (d) await pc.setLocalDescription(d); else await pc.setLocalDescription() } catch (e) { throw pcCode(e) }
        return description(pc.localDescription)
      },
      async setRemoteDescription(d: SessionDescription) {
        guard()
        try { await pc.setRemoteDescription(d) } catch (e) { throw pcCode(e) }
      },
      async addIceCandidate(candidate?: IceCandidate) {
        guard()
        try { await pc.addIceCandidate(candidate ?? undefined) } catch (e) { throw pcCode(e) }
      },
      restartIce() { pc.restartIce() },
      setConfiguration(c: RtcConfiguration) {
        try { pc.setConfiguration(configuration(c)) } catch (e) { throw pcCode(e) }
      },
      addTrack(trackId: string, streamIds: string[] = []) {
        guard()
        const track = localTrack(trackId)
        try { return senderInfo(pc.addTrack(track, ...streamIds.map(streamOf))) } catch (e) { throw pcCode(e) }
      },
      removeTrack(id: string) {
        guard()
        try { pc.removeTrack(sender(id)) } catch (e) { throw pcCode(e) }
      },
      async replaceTrack(id: string, trackId: string | null) {
        guard()
        const track = trackId === null ? null : localTrack(trackId)
        try { await sender(id).replaceTrack(track) } catch (e) { throw pcCode(e) }
      },
      getSenderParameters(id: string): SenderParameters {
        const p = sender(id).getParameters()
        return { encodings: (p.encodings ?? []).map(e => ({
          ...(e.rid !== undefined ? { rid: e.rid } : {}), ...(e.active !== undefined ? { active: e.active } : {}),
          ...(e.maxBitrate !== undefined ? { maxBitrate: e.maxBitrate } : {}), ...(e.maxFramerate !== undefined ? { maxFramerate: e.maxFramerate } : {}),
          ...(e.scaleResolutionDownBy !== undefined ? { scaleResolutionDownBy: e.scaleResolutionDownBy } : {}),
        })) }
      },
      async setSenderParameters(id: string, parameters: SenderParameters) {
        const s = sender(id)
        const p = s.getParameters()
        // The encodings are matched by position (by rid when both have one): what the app says wins.
        p.encodings = (p.encodings ?? []).map((e, i) => {
          const wanted = parameters.encodings.find(w => w.rid && w.rid === e.rid) ?? parameters.encodings[i]
          if (!wanted) return e
          if (wanted.active !== undefined) e.active = wanted.active
          if (wanted.maxBitrate !== undefined) e.maxBitrate = wanted.maxBitrate
          if (wanted.maxFramerate !== undefined) e.maxFramerate = wanted.maxFramerate
          if (wanted.scaleResolutionDownBy !== undefined) e.scaleResolutionDownBy = wanted.scaleResolutionDownBy
          return e
        })
        try { await s.setParameters(p) } catch (e) { throw pcCode(e) }
      },
      addTransceiver(kind, options: TransceiverInit = {}) {
        guard()
        const init: RTCRtpTransceiverInit = {}
        if (options.direction) init.direction = options.direction as RTCRtpTransceiverDirection
        if (options.streamIds) init.streams = options.streamIds.map(streamOf)
        if (options.sendEncodings) init.sendEncodings = options.sendEncodings.map(e => ({ ...e }))
        const source = options.trackId ? localTrack(options.trackId) : kind
        try { return transceiverInfo(pc.addTransceiver(source, init)) } catch (e) { throw pcCode(e) }
      },
      getTransceivers() { return pc.getTransceivers().map(transceiverInfo) },
      setTransceiverDirection(id, direction) {
        const t = transceivers.get(id)
        if (!t) throw new RtcPeerConnectionError("notFound")
        try { t.direction = direction as RTCRtpTransceiverDirection } catch (e) { throw pcCode(e) }
      },
      stopTransceiver(id) {
        const t = transceivers.get(id)
        if (!t) throw new RtcPeerConnectionError("notFound")
        t.stop()
      },
      async getStats(trackId?: string): Promise<Json> {
        const report = await pc.getStats(trackId ? tracks.get(trackId) ?? null : null)
        const out: { [id: string]: Json } = {}
        report.forEach((stats, id) => { out[id] = JSON.parse(JSON.stringify(stats)) })
        return out
      },
      createDataChannel(label, options: DataChannelInit = {}) {
        guard()
        let c: RTCDataChannel
        try { c = pc.createDataChannel(label, options) } catch (e) { throw pcCode(e) }
        const id = allocate("channel")
        watchChannel(id, c)
        return channelInfo(id, c)
      },
      sendText(id, text) {
        const c = channel(id)
        if (c.readyState !== "open") throw new RtcPeerConnectionError("closed")
        c.send(text)
      },
      sendBinary(id, data) {
        const c = channel(id)
        if (c.readyState !== "open") throw new RtcPeerConnectionError("closed")
        c.send(data)
      },
      getBufferedAmount(id) { return channel(id).bufferedAmount },
      setBufferedAmountLowThreshold(id, threshold) { channel(id).bufferedAmountLowThreshold = threshold },
      closeDataChannel(id) { channels.get(id)?.close() },
      close() {
        if (closed) return
        closed = true
        pc.close()
        for (const c of channels.values()) c.close()
        channels.clear()
      },
    }
  })
}

// ---- the picture -----------------------------------------------------------------------------------

/** One track's picture: a <video> filling `el`, its `srcObject` a stream of the one track the half
 *  keeps by id (`tracks`) — ONE class behind the fullscreen View's instance and the host node's half.
 *  The fit is CSS `object-fit`, the mirror a CSS transform; `resize` comes from the element (its
 *  first frame's size, every change after). An element taken out of the page pauses: shown again,
 *  it plays on. */
class RtcPicture {
  readonly el: HTMLElement
  private readonly video: HTMLVideoElement
  private readonly shown: IntersectionObserver | null
  private width = 0
  private height = 0

  constructor(doc: Document, private readonly events: { resize(payload: { width: number, height: number }): void }, private fit: ObjectFit, private mirror: boolean) {
    this.el = doc.createElement("div")
    this.el.style.background = "#000"
    this.el.style.overflow = "hidden"
    const video = this.video = doc.createElement("video")
    video.autoplay = true
    video.muted = true      // the audio of a call plays through the connection, never through the picture
    video.playsInline = true
    video.setAttribute("playsinline", "")
    video.style.cssText = "position:absolute;inset:0;width:100%;height:100%"
    this.el.appendChild(video)
    this.apply()
    const sized = (): void => {
      if (!video.videoWidth || (video.videoWidth === this.width && video.videoHeight === this.height)) return
      this.width = video.videoWidth
      this.height = video.videoHeight
      this.events.resize({ width: this.width, height: this.height })
    }
    video.addEventListener("loadedmetadata", sized)
    video.addEventListener("resize", sized)
    this.shown = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && video.paused && video.srcObject) this.play()
    })
    this.shown?.observe(video)
  }

  private apply(): void {
    this.video.style.objectFit = this.fit
    this.video.style.transform = this.mirror ? "scaleX(-1)" : ""
  }

  private play(): void {
    this.video.play().catch(() => { /* autoplay policy — the muted picture shows once playing is allowed */ })
  }

  /** Draw the track `trackId` (null = black). An id the half does not know: "notFound". */
  show(trackId: string | null): void {
    if (trackId === null) { this.video.srcObject = null; return }
    const track = tracks.get(trackId)
    if (!track) throw new RtcVideoError("notFound")
    this.video.srcObject = new MediaStream([track])
    this.play()
  }

  setObjectFit(fit: ObjectFit): void { this.fit = fit; this.apply() }
  setMirror(mirror: boolean): void { this.mirror = mirror; this.apply() }

  destroy(): void {
    this.shown?.disconnect()
    this.video.srcObject = null
    this.el.remove()
  }
}

const makeVideo = (host: PluginHost): void => {
  registerRtcVideo(host, (params, events, doc): RtcVideoPlugin => {
    const picture = new RtcPicture(doc, events, params.objectFit ?? "cover", params.mirror ?? false)
    try { picture.show(params.trackId ?? null) } catch { /* a track that is gone: black */ }
    return {
      el: picture.el,
      setTrack: (trackId) => { picture.show(trackId) },
      setObjectFit: (f) => { picture.setObjectFit(f) },
      setMirror: (m) => { picture.setMirror(m) },
      destroy: () => { picture.destroy() },
    }
  })

  // The node: its props are LIVE, each write applied as it lands — a `trackId` the half does not
  // know draws black (the prop has no promise to reject; `setTrack` rejects "notFound").
  registerUIRTCVideoNode(host, (events, doc): UIRTCVideoNodeHalf => {
    const picture = new RtcPicture(doc, events, "cover", false)
    return {
      el: picture.el,
      setTrackId: (trackId) => { try { picture.show(trackId ?? null) } catch { picture.show(null) } },
      setTrack: (trackId) => { picture.show(trackId) },
      setObjectFit: (fit) => { picture.setObjectFit(fit ?? "cover") },
      setMirror: (mirror) => { picture.setMirror(mirror ?? false) },
      destroy: () => { picture.destroy() },
    }
  })
}

/** Register the halves where the browser can serve them: WebRTC exists in secure contexts (https /
 *  localhost) only — elsewhere the plugin stays unsupported, like a shell without it. */
export const register = (host: PluginHost): void => {
  if (typeof navigator === "undefined" || typeof RTCPeerConnection === "undefined" || typeof navigator.mediaDevices?.getUserMedia !== "function") return
  makeMedia(host)
  makePeerConnection(host)
  makeVideo(host)
}
