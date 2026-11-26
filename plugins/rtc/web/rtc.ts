// rtc on the web: the browser's own WebRTC held to the profile (Opus; H.264 Constrained Baseline,
// packetization-mode 1; data channels) and to tinyrtc's conventions, so that a tab calls a phone:
//
//   - every connection's lines are audio, video (both sendrecv), then the data section, made with
//     the first description: the offering side adds the two transceivers and the hidden control
//     channel ("tinyrtc") before its first offer; the answering side takes the lines of the offer
//     (and sets them sendrecv). Sending a track, stopping it, opening a channel is never a new
//     offer; createOffer(true) is the ICE restart. Codec preferences hold both lines to the profile:
//     a browser without H.264 Constrained Baseline (to send and to receive) or Opus fails the first
//     description with "failed";
//   - the control channel carries what each side sends: "video:0" / "video:1" / "audio:0" /
//     "audio:1", said when this side stops / starts sending a kind (setTrack(kind, null), a track
//     disabled, stopped or ended, and back), said again when the channel opens. What the other side
//     says raises `remoteMedia`; a peer that never says anything (another browser on old code, a
//     media server) is read from what arrives instead, as tinyrtc reads one: the received track's
//     unmute and mute, and — Chrome fires no mute when a sender stops — a kind that brought no frame
//     / packet for QUIET_AFTER_MS (polled from the stats while connected, until the peer first
//     speaks). Neither the channel nor its messages reach the app;
//   - descriptions are SDP text and candidates `candidate:` lines, both ways. A local candidate is
//     the bundle transport's (the first line's — what the browser gathers for the other lines dies
//     with the bundle); a remote one is added to the first line of the remote description (every
//     line is bundled), so the app passes no mid; one added before the remote description waits for
//     it; a line the browser cannot read is skipped, as the native halves skip one;
//   - `relayOnly` is tinyrtc's rule, both halves of it. This device's addresses are stripped from
//     what the app is handed (the candidate lines, the connection addresses and ports — an ICE
//     restart's description too) and no `iceCandidate` is raised. And the other side's are never
//     checked: of the candidates the app passes — `addIceCandidate`, or a=candidate lines inside a
//     remote description, which are taken out before the browser sees it — only `typ relay` ones
//     reach the browser (a host, srflx, prflx or mDNS one is dropped), so the browser checks the
//     relay alone, from its own host candidates, and the other side never hears from this device's
//     address. What the browser cannot be told: to ignore a check from an address it was not given
//     (it would answer one, as a peer-reflexive candidate) — none comes, as no one is given an
//     address of this device; the STUN servers of `iceServers` still see it (they are asked);
//   - a disabled local track is NOT SENT (the sender's track is replaced by none, so the other side
//     gets no black frames and its track goes muted), the device stays open; a camera switched by
//     applyConstraints is a new browser track under the same id: every sender and picture follows;
//   - the received audio PLAYS through an <audio> of its own per connection (the browser renders a
//     received track only through a media element); setRemoteAudioMuted mutes it. A page the user has
//     not touched yet may refuse to play it: it plays at the next tap or key;
//   - the picture — the fullscreen view's and the host node's (`UIRTCVideoNode`, Web Lite's
//     `hostnode` feature) — is one class, a <video> of the one track, following the track of its id.
//
// The channel is the contract's (../contract.d.ts): rtc.gen.ts is generated from it, this file
// implements its RtcMediaPlugin, RtcConnectionPlugin, RtcVideoPlugin and UIRTCVideoNodeHalf.

import {
  RtcConnectionError, RtcMediaError, RtcVideoError, registerRtcConnection, registerRtcMedia, registerRtcVideo, registerUIRTCVideoNode,
  type AudioConstraints, type ConnectionState, type ConnectionStats, type DataChannelInit, type DeviceInfo, type FacingMode,
  type MediaConstraints, type MediaKind, type ObjectFit, type PluginHost, type RtcConnectionEvents, type RtcConnectionGetRemoteTracksResult,
  type RtcConnectionParams, type RtcConnectionPlugin, type RtcMediaPlugin, type RtcVideoPlugin, type TrackInfo, type TrackSettings,
  type UIRTCVideoNodeHalf, type VideoConstraints,
} from "./rtc.gen"

/** tinyrtc's control channel: what puts the data line into the first offer, and what each side
 *  says it sends. Never the app's. */
const CONTROL = "tinyrtc"
/** The ceiling of a video track until the app sets one (the contract's default). */
const DEFAULT_MAX_BITRATE = 1_500_000
/** A path lost for this long asks for an ICE restart (tinyrtc's RESTART_AFTER). */
const RESTART_AFTER_MS = 2000
/** A peer that does not tell what it sends: a kind that brought nothing for this long is taken as
 *  stopped (Chrome fires `unmute` when a received track's media starts, but no `mute` when it stops),
 *  looked at this often. Longer than any gap of a live stream: a low frame rate, Opus's packets. */
const QUIET_AFTER_MS = 1000
const QUIET_POLL_MS = 500

// ---- the registry: what a picture draws, by the ids on the wire -----------------------------------

/** What an id draws: the browser track behind it NOW — a camera swapped under a local track's id,
 *  a connection's received track once its line exists. Pictures watch it. */
interface Source {
  current(): MediaStreamTrack | null
  readonly watchers: Set<() => void>
}
const sources = new Map<string, Source>()
const changed = (source: Source): void => { for (const watcher of [...source.watchers]) watcher() }

/** A track of the devices, by the half's own id (a switched camera is another browser track). */
class LocalTrack implements Source {
  readonly watchers = new Set<() => void>()
  enabled = true
  maxBitrate = DEFAULT_MAX_BITRATE
  gone = false
  constructor(readonly id: string, readonly kind: MediaKind, public track: MediaStreamTrack, public video: VideoConstraints) {}
  current(): MediaStreamTrack | null { return this.gone ? null : this.track }
  /** Sent: enabled and not ended. */
  get live(): boolean { return !this.gone && this.enabled }
}
const locals = new Map<string, LocalTrack>()
/** Every open connection: what a change of a local track is told to. */
const connections = new Set<Session>()
let nextId = 1

const localInfo = (local: LocalTrack): TrackInfo => ({ id: local.id, kind: local.kind, label: local.track.label, enabled: local.enabled })

/** A local track is no more (stopped by the app, ended by the OS, its session closed). */
const forget = (local: LocalTrack): void => {
  if (local.gone) return
  local.gone = true
  locals.delete(local.id)
  sources.delete(local.id)
  local.track.stop()
  for (const connection of connections) connection.localGone(local)
  changed(local)
}

// ---- media ----------------------------------------------------------------------------------------

const mediaCode = (e: unknown): RtcMediaError => {
  const name = e instanceof DOMException ? e.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return new RtcMediaError("denied")
  if (name === "NotFoundError" || name === "OverconstrainedError") return new RtcMediaError("notFound")
  return new RtcMediaError("failed")
}

const audioConstraints = (c: AudioConstraints): MediaTrackConstraints | true => {
  const out: MediaTrackConstraints = {}
  if (c.echoCancellation !== undefined) out.echoCancellation = c.echoCancellation
  if (c.noiseSuppression !== undefined) out.noiseSuppression = c.noiseSuppression
  if (c.autoGainControl !== undefined) out.autoGainControl = c.autoGainControl
  return Object.keys(out).length ? out : true
}

/** The browser's constraints of a camera: the contract's defaults (the front one, 1280×720, 30 fps);
 *  `exact` for a switch, which must not land on the camera it leaves. */
const videoConstraints = (c: VideoConstraints, exact: boolean): MediaTrackConstraints => {
  const out: MediaTrackConstraints = {
    width: { ideal: c.width ?? 1280 }, height: { ideal: c.height ?? 720 }, frameRate: { ideal: c.frameRate ?? 30 },
  }
  if (c.deviceId) out.deviceId = { exact: c.deviceId }
  else out.facingMode = exact && c.facingMode ? { exact: c.facingMode } : c.facingMode ?? "user"
  return out
}

const cameraTrack = async (constraints: MediaTrackConstraints): Promise<MediaStreamTrack> => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: constraints })
  const track = stream.getVideoTracks()[0]
  if (!track) throw new RtcMediaError("failed")
  return track
}

const makeMedia = (host: PluginHost): void => {
  registerRtcMedia(host, (_params, events): RtcMediaPlugin => {
    /** The tracks this session opened: its close stops them. */
    const mine = new Set<LocalTrack>()
    const onDeviceChange = (): void => events.deviceChange()
    navigator.mediaDevices.addEventListener?.("devicechange", onDeviceChange)

    /** The OS ending the browser track that is the local track's NOW (a swapped-out one is ours). */
    const watch = (local: LocalTrack, track: MediaStreamTrack): void => {
      track.addEventListener("ended", () => {
        if (local.track !== track || local.gone) return
        forget(local)
        events.trackEnded({ trackId: local.id })
      })
    }
    const local = (trackId: string, kind?: MediaKind): LocalTrack => {
      const found = locals.get(trackId)
      if (!found || (kind && found.kind !== kind)) throw new RtcMediaError("notFound")
      return found
    }
    /** Another camera under the same id: every sender and every picture follows. */
    const swap = (track: LocalTrack, fresh: MediaStreamTrack, video: VideoConstraints): void => {
      const old = track.track
      track.track = fresh
      track.video = video
      fresh.enabled = track.enabled
      watch(track, fresh)
      if (old !== fresh) old.stop()
      for (const connection of connections) connection.localChanged(track)
      changed(track)
    }

    return {
      async getUserMedia(constraints: MediaConstraints): Promise<TrackInfo[]> {
        const wanted: MediaStreamConstraints = {}
        if (constraints.audio) wanted.audio = audioConstraints(constraints.audio)
        if (constraints.video) wanted.video = videoConstraints(constraints.video, false)
        let stream: MediaStream
        try { stream = await navigator.mediaDevices.getUserMedia(wanted) } catch (e) { throw mediaCode(e) }
        const out: TrackInfo[] = []
        for (const track of [...stream.getAudioTracks(), ...stream.getVideoTracks()]) {
          const kind = track.kind as MediaKind
          const video: VideoConstraints = kind === "video" ? { facingMode: "user", ...constraints.video } : {}
          const made = new LocalTrack(`local-${nextId++}`, kind, track, video)
          locals.set(made.id, made)
          sources.set(made.id, made)
          mine.add(made)
          watch(made, track)
          out.push(localInfo(made))
        }
        return out
      },
      async enumerateDevices(): Promise<DeviceInfo[]> {
        const devices = await navigator.mediaDevices.enumerateDevices()
        return devices.filter((d) => d.kind === "audioinput" || d.kind === "audiooutput" || d.kind === "videoinput").map((d) => {
          const info: DeviceInfo = { deviceId: d.deviceId, kind: d.kind, label: d.label }
          const facing = d.kind === "videoinput" ? (d as InputDeviceInfo).getCapabilities?.()?.facingMode?.[0] : undefined
          if (facing === "user" || facing === "environment") info.facing = facing
          return info
        })
      },
      setTrackEnabled(trackId, enabled) {
        const track = local(trackId)
        track.enabled = enabled
        track.track.enabled = enabled
        for (const connection of connections) connection.localChanged(track)
      },
      async applyConstraints(trackId, constraints) {
        const track = local(trackId, "video")
        const video: VideoConstraints = { ...track.video, ...constraints }
        if (constraints.deviceId) delete video.facingMode
        else if (constraints.facingMode) delete video.deviceId
        const switching = (constraints.deviceId !== undefined && constraints.deviceId !== track.track.getSettings().deviceId)
          || (constraints.facingMode !== undefined && constraints.deviceId === undefined && constraints.facingMode !== (track.video.facingMode ?? "user"))
        if (!switching) {
          try { await track.track.applyConstraints(videoConstraints(video, false)) } catch { throw new RtcMediaError("failed") }
          track.video = video
          return
        }
        let fresh: MediaStreamTrack | null = null
        try { fresh = await cameraTrack(videoConstraints(video, true)) } catch { /* a phone opens one camera at a time */ }
        if (!fresh) {
          track.track.stop()
          try { fresh = await cameraTrack(videoConstraints(video, true)) } catch {
            // give the camera it left back, under the same id
            try { swap(track, await cameraTrack(videoConstraints(track.video, false)), track.video) } catch { forget(track); events.trackEnded({ trackId }) }
            throw new RtcMediaError("failed")
          }
        }
        swap(track, fresh, video)
      },
      getTrackSettings(trackId) {
        const track = local(trackId)
        const s = track.track.getSettings()
        const out: TrackSettings = {}
        if (s.deviceId) out.deviceId = s.deviceId
        const facing = (s.facingMode as FacingMode | undefined) ?? (track.kind === "video" ? track.video.facingMode : undefined)
        if (facing === "user" || facing === "environment") out.facingMode = facing
        if (s.width) out.width = Math.round(s.width)
        if (s.height) out.height = Math.round(s.height)
        if (s.frameRate) out.frameRate = Math.round(s.frameRate)
        return out
      },
      setMaxVideoBitrate(trackId, bitrate) {
        const track = local(trackId, "video")
        track.maxBitrate = bitrate
        for (const connection of connections) connection.localChanged(track)
      },
      stopTrack(trackId) {
        const track = locals.get(trackId)
        if (track) forget(track)
      },
      setAudioOutput() { /* the browser routes its own audio */ },
      close() {
        navigator.mediaDevices.removeEventListener?.("devicechange", onDeviceChange)
        for (const track of mine) forget(track)
        mine.clear()
      },
    }
  })
}

// ---- a connection ---------------------------------------------------------------------------------

/** The codecs of the profile, as this browser has them: H.264 Constrained Baseline packetization-mode
 *  1 (42e01f first, the profile's level) with RTX, and Opus. "failed" without one of them. */
const profileCodecs = (): { audio: RTCRtpCodec[], video: RTCRtpCodec[], rtx: RTCRtpCodec[] } => {
  const receive = (kind: string): RTCRtpCodec[] => (typeof RTCRtpReceiver !== "undefined" && RTCRtpReceiver.getCapabilities?.(kind)?.codecs) || []
  const send = (kind: string): RTCRtpCodec[] => (typeof RTCRtpSender !== "undefined" && RTCRtpSender.getCapabilities?.(kind)?.codecs) || []
  const fmtp = (c: RTCRtpCodec): string => c.sdpFmtpLine ?? ""
  const h264 = (c: RTCRtpCodec): boolean => c.mimeType.toLowerCase() === "video/h264" && /packetization-mode=1/.test(fmtp(c)) && /profile-level-id=42e0/i.test(fmtp(c))
  const video = receive("video").filter(h264)
  const audio = receive("audio").filter((c) => c.mimeType.toLowerCase() === "audio/opus")
  if (!video.length || !send("video").some(h264) || !audio.length) throw new RtcConnectionError("failed")
  const level = (c: RTCRtpCodec): number => /profile-level-id=42e01f/i.test(fmtp(c)) ? 0 : 1
  video.sort((a, b) => level(a) - level(b))
  return { audio, video, rtx: receive("video").filter((c) => c.mimeType.toLowerCase() === "video/rtx") }
}

const preferCodecs = (codecs: ReturnType<typeof profileCodecs>, audio: RTCRtpTransceiver | null, video: RTCRtpTransceiver | null): void => {
  try {
    audio?.setCodecPreferences(codecs.audio)
    if (video) {
      try { video.setCodecPreferences([...codecs.video, ...codecs.rtx]) } catch { video.setCodecPreferences(codecs.video) }
    }
  } catch { throw new RtcConnectionError("failed") }
}

const pcCode = (e: unknown): RtcConnectionError =>
  e instanceof RtcConnectionError ? e
    : new RtcConnectionError(e instanceof DOMException && e.name === "InvalidStateError" && /closed/i.test(e.message) ? "closed" : "failed")

/** What the app is handed of a description under `relayOnly`: no address of this device — no
 *  candidate, the connection lines and the ports the discard ones. */
const hideAddresses = (sdp: string): string => sdp.split(/\r\n/)
  .filter((line) => !line.startsWith("a=candidate") && !line.startsWith("a=end-of-candidates"))
  .map((line) => line.startsWith("c=IN ") ? "c=IN IP4 0.0.0.0"
    : line.startsWith("a=rtcp:") ? "a=rtcp:9 IN IP4 0.0.0.0"
    : line.startsWith("m=") ? line.replace(/^(m=\S+) \d+/, "$1 9")
    : line)
  .join("\r\n")

/** The type of a `candidate:` line (with or without `a=`): "host", "srflx", "prflx", "relay"; null
 *  for what is not one. */
const candidateType = (line: string): string | null => {
  const words = line.trim().replace(/^a=/, "").split(/\s+/)
  return words[0]?.startsWith("candidate:") && words[6] === "typ" ? words[7] ?? null : null
}

/** What a `relayOnly` connection lets the browser see of a remote description: no candidate of the
 *  other side but a relay's. */
const relayCandidatesOnly = (sdp: string): string => sdp.split(/\r?\n/)
  .filter((line) => !line.startsWith("a=candidate") || candidateType(line) === "relay")
  .join("\r\n")

/** The mid of a description's first line: the bundle, where a remote candidate goes. */
const firstMid = (sdp: string): string | null => /^a=mid:(\S+)/m.exec(sdp)?.[1] ?? null

const stateOf = (pc: RTCPeerConnection): ConnectionState => {
  const s = pc.connectionState
  if (s) return s
  const ice = pc.iceConnectionState
  return ice === "checking" ? "connecting" : ice === "completed" ? "connected" : (ice as ConnectionState)
}

/** A received track of a connection: the browser track of its line once the line exists. */
class RemoteSource implements Source {
  readonly watchers = new Set<() => void>()
  transceiver: RTCRtpTransceiver | null = null
  gone = false
  constructor(readonly id: string, readonly kind: MediaKind) {}
  current(): MediaStreamTrack | null { return this.gone ? null : this.transceiver?.receiver.track ?? null }
}

/** One sample of the browser's counters, for the rates of the next getStats. */
type Sample = { at: number, bytes: number, lost: number, received: number, delay: number, emitted: number, frames: number }

let nextSession = 1

class Session implements RtcConnectionPlugin {
  private readonly pc: RTCPeerConnection
  private readonly hidden: boolean
  private readonly remote: { audio: RemoteSource, video: RemoteSource }
  private readonly wanted: { audio: LocalTrack | null, video: LocalTrack | null } = { audio: null, video: null }
  /** What this side sends now, and what the other side was last told of it (null: not since the
   *  control channel opened). */
  private readonly sending = { audio: false, video: false }
  private told: { audio: boolean | null, video: boolean | null } = { audio: null, video: null }
  private readonly remoteActive = { audio: false, video: false }
  /** The other side says what it sends: its word replaces the guess from the tracks. */
  private remoteTells = false
  /** The guess while it does not: what each kind brought last (video frames, audio packets), when. */
  private quietTimer: ReturnType<typeof setInterval> | null = null
  private readonly heard = { audio: { count: -1, at: 0 }, video: { count: -1, at: 0 } }
  private control: RTCDataChannel | null = null
  private readonly channels = new Map<number, RTCDataChannel>()
  /** Channels asked for before the data line existed: made with the first description. */
  private readonly queued = new Map<number, { label: string, init: RTCDataChannelInit, threshold: number }>()
  private nextChannel = 1
  /** The lines exist (the first offer made, or the first offer taken). */
  private described = false
  private pendingCandidates: string[] = []
  private state: ConnectionState = "new"
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartAsked = false
  private audio: HTMLAudioElement | null = null
  private audioMuted = false
  private samples = new Map<string, Sample>()
  /** The report's clock when the connection connected: a stream first seen later counts from it. */
  private connectedAt: number | null = null
  private closed = false

  constructor(params: RtcConnectionParams, private readonly events: RtcConnectionEvents) {
    const n = nextSession++
    this.hidden = params.relayOnly ?? false
    this.pc = new RTCPeerConnection({ iceServers: (params.iceServers ?? []).map((s) => ({ urls: s.urls })) })
    this.remote = { audio: new RemoteSource(`remote-${n}-audio`, "audio"), video: new RemoteSource(`remote-${n}-video`, "video") }
    sources.set(this.remote.audio.id, this.remote.audio)
    sources.set(this.remote.video.id, this.remote.video)
    connections.add(this)
    this.pc.addEventListener("icecandidate", (e) => {
      const c = e.candidate
      // the end of the candidates is no line; the lines past the first die with the bundle
      if (!c || !c.candidate || this.hidden || this.closed || (c.sdpMLineIndex ?? 0) !== 0) return
      events.iceCandidate({ candidate: c.candidate })
    })
    this.pc.addEventListener("connectionstatechange", () => this.settle())
    this.pc.addEventListener("iceconnectionstatechange", () => this.settle())
    this.pc.addEventListener("datachannel", (e) => this.adopt(e.channel))
  }

  // -- signaling

  async createOffer(iceRestart?: boolean): Promise<string> {
    this.guard()
    if (!this.described) {
      const codecs = profileCodecs()   // before any line: a browser without the profile adds none
      const audio = this.pc.addTransceiver("audio", { direction: "sendrecv" })
      const video = this.pc.addTransceiver("video", { direction: "sendrecv" })
      preferCodecs(codecs, audio, video)
      this.watchControl(this.pc.createDataChannel(CONTROL))
      this.linesMade(audio, video)
    }
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer(iceRestart ? { iceRestart: true } : {}))
    } catch (e) { throw pcCode(e) }
    this.guard()
    return this.shown(this.pc.localDescription!.sdp)
  }

  async acceptOffer(offer: string): Promise<string> {
    this.guard()
    const codecs = this.described ? null : profileCodecs()
    try { await this.pc.setRemoteDescription({ type: "offer", sdp: this.taken(offer) }) } catch (e) { throw pcCode(e) }
    this.guard()
    if (codecs && !this.described) {
      const lines = this.pc.getTransceivers()
      const audio = lines.find((t) => t.receiver.track.kind === "audio") ?? null
      const video = lines.find((t) => t.receiver.track.kind === "video") ?? null
      for (const t of [audio, video]) if (t) t.direction = "sendrecv"
      preferCodecs(codecs, audio, video)
      this.linesMade(audio, video)
    }
    await this.addPendingCandidates()
    try {
      await this.pc.setLocalDescription(await this.pc.createAnswer())
    } catch (e) { throw pcCode(e) }
    this.guard()
    this.applyBitrate()
    return this.shown(this.pc.localDescription!.sdp)
  }

  async acceptAnswer(answer: string): Promise<void> {
    this.guard()
    try { await this.pc.setRemoteDescription({ type: "answer", sdp: this.taken(answer) }) } catch (e) { throw pcCode(e) }
    await this.addPendingCandidates()
    this.applyBitrate()
  }

  async addIceCandidate(line: string): Promise<void> {
    this.guard()
    const candidate = line.trim().replace(/^a=/, "")
    if (!candidate.startsWith("candidate:")) return
    // relay only: no candidate of the other side but a relay's ever reaches the browser
    if (this.hidden && candidateType(candidate) !== "relay") return
    if (!this.pc.remoteDescription) { this.pendingCandidates.push(candidate); return }
    await this.addNow(candidate)
  }

  // -- media

  async setTrack(kind: MediaKind, trackId: string | null): Promise<void> {
    this.guard()
    let track: LocalTrack | null = null
    if (trackId !== null) {
      track = locals.get(trackId) ?? null
      if (!track) throw new RtcConnectionError("notFound")
      if (track.kind !== kind) throw new RtcConnectionError("failed")
    }
    this.wanted[kind] = track
    try { await this.send(kind) } catch { throw new RtcConnectionError("failed") }
  }

  getRemoteTracks(): RtcConnectionGetRemoteTracksResult {
    const info = (source: RemoteSource): TrackInfo => ({ id: source.id, kind: source.kind, label: "", enabled: true, muted: !this.remoteActive[source.kind] })
    return { audio: info(this.remote.audio), video: info(this.remote.video) }
  }

  setRemoteAudioMuted(muted: boolean): void {
    this.audioMuted = muted
    if (this.audio) this.audio.muted = muted
  }

  async getStats(): Promise<ConnectionStats> {
    this.guard()
    let report: RTCStatsReport
    try { report = await this.pc.getStats() } catch (e) { throw pcCode(e) }
    return this.statsOf(report)
  }

  // -- data channels

  createDataChannel(label: string, options: DataChannelInit = {}): number {
    this.guard()
    if (label === CONTROL || (options.maxRetransmits !== undefined && options.maxPacketLifeTime !== undefined)) throw new RtcConnectionError("failed")
    const init: RTCDataChannelInit = { ordered: options.ordered ?? true }
    if (options.maxRetransmits !== undefined) init.maxRetransmits = options.maxRetransmits
    if (options.maxPacketLifeTime !== undefined) init.maxPacketLifeTime = options.maxPacketLifeTime
    const id = this.nextChannel++
    if (this.described) this.openChannel(id, label, init, 0)
    else this.queued.set(id, { label, init, threshold: 0 })
    return id
  }

  sendText(channelId: number, text: string): void { this.channelToSend(channelId).send(text) }
  sendBinary(channelId: number, data: Uint8Array): void { this.channelToSend(channelId).send(data as Uint8Array<ArrayBuffer>) }

  getBufferedAmount(channelId: number): number {
    const c = this.channels.get(channelId)
    if (c) return c.bufferedAmount
    if (this.queued.has(channelId)) return 0
    throw new RtcConnectionError("notFound")
  }
  setBufferedAmountLowThreshold(channelId: number, threshold: number): void {
    const c = this.channels.get(channelId)
    const q = this.queued.get(channelId)
    if (c) c.bufferedAmountLowThreshold = threshold
    else if (q) q.threshold = threshold
    else throw new RtcConnectionError("notFound")
  }
  closeDataChannel(channelId: number): void {
    const c = this.channels.get(channelId)
    if (c) { c.close(); return }
    if (this.queued.delete(channelId)) this.events.dataChannelClose({ id: channelId })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    connections.delete(this)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.stopGuessing()
    for (const c of this.channels.values()) c.close()
    this.channels.clear()
    this.queued.clear()
    this.control?.close()
    this.pc.close()
    if (this.audio) { this.audio.srcObject = null; this.audio.remove(); this.audio = null }
    for (const source of [this.remote.audio, this.remote.video]) {
      source.gone = true
      sources.delete(source.id)
      changed(source)
    }
  }

  // -- what rtcMedia tells every connection

  /** A local track changed (enabled, its camera, its ceiling): a line that sends it follows. */
  localChanged(track: LocalTrack): void {
    for (const kind of ["audio", "video"] as const) if (this.wanted[kind] === track) this.send(kind).catch(() => {})
  }
  /** A local track is gone: what sent it sends nothing. */
  localGone(track: LocalTrack): void {
    for (const kind of ["audio", "video"] as const) {
      if (this.wanted[kind] !== track) continue
      this.wanted[kind] = null
      this.send(kind).catch(() => {})
    }
  }

  // -- inside

  private guard(): void { if (this.closed) throw new RtcConnectionError("closed") }

  private shown(sdp: string): string { return this.hidden ? hideAddresses(sdp) : sdp }
  /** What the browser is given of a remote description: relay only, no candidate but a relay's. */
  private taken(sdp: string): string { return this.hidden ? relayCandidatesOnly(sdp) : sdp }

  /** The lines exist: the received tracks are theirs, the wanted tracks go out, the channels asked
   *  for meanwhile are made, the received audio plays. */
  private linesMade(audio: RTCRtpTransceiver | null, video: RTCRtpTransceiver | null): void {
    this.described = true
    this.remote.audio.transceiver = audio
    this.remote.video.transceiver = video
    for (const [kind, t] of [["audio", audio], ["video", video]] as const) {
      if (!t) continue
      const track = t.receiver.track
      track.addEventListener("unmute", () => { if (!this.remoteTells) this.setRemote(kind, true) })
      track.addEventListener("mute", () => { if (!this.remoteTells) this.setRemote(kind, false) })
    }
    changed(this.remote.audio)
    changed(this.remote.video)
    for (const kind of ["audio", "video"] as const) this.send(kind).catch(() => {})
    for (const [id, q] of this.queued) this.openChannel(id, q.label, q.init, q.threshold)
    this.queued.clear()
    this.playAudio()
  }

  /** Put what the app wants of `kind` on its line — a disabled or ended track is none — and tell
   *  the other side when that changed what this side sends. */
  private async send(kind: MediaKind): Promise<void> {
    const t = kind === "audio" ? this.remote.audio.transceiver : this.remote.video.transceiver
    const wanted = this.wanted[kind]
    const track = wanted && wanted.live ? wanted.track : null
    this.tell(kind, track !== null)
    if (!t || this.closed) return
    if (t.sender.track !== track) await t.sender.replaceTrack(track)
    if (kind === "video") this.applyBitrate()
  }

  /** The ceiling of the video line: its track's. Before the first description the line may have no
   *  encoding yet — applied again after each one. */
  private applyBitrate(): void {
    const sender = this.remote.video.transceiver?.sender
    const track = this.wanted.video
    if (!sender || !track || this.closed) return
    const parameters = sender.getParameters()
    const encoding = parameters.encodings?.[0]
    if (!encoding || encoding.maxBitrate === track.maxBitrate) return
    encoding.maxBitrate = track.maxBitrate
    sender.setParameters(parameters).catch(() => {})
  }

  private tell(kind: MediaKind, on: boolean): void {
    this.sending[kind] = on
    const control = this.control
    if (this.told[kind] === on || !control || control.readyState !== "open") return
    try {
      control.send(`${kind}:${on ? 1 : 0}`)
      this.told[kind] = on
    } catch { /* closing: nothing more to say */ }
  }

  private watchControl(c: RTCDataChannel): void {
    this.control = c
    c.binaryType = "arraybuffer"
    const opened = (): void => {
      // whatever was said before it opened was not heard: say it again
      this.told = { audio: null, video: null }
      this.tell("audio", this.sending.audio)
      this.tell("video", this.sending.video)
    }
    if (c.readyState === "open") opened()
    else c.addEventListener("open", opened)
    c.addEventListener("message", (e) => {
      const text = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)
      const said = /^(audio|video):([01])$/.exec(text)
      if (!said) return
      this.remoteTells = true
      this.stopGuessing()
      this.setRemote(said[1] as MediaKind, said[2] === "1")
    })
  }

  /** While the other side has said nothing: what arrives says what it sends. A kind whose count
   *  grew is active, one that brought nothing for QUIET_AFTER_MS is not. */
  private guess(): void {
    if (this.quietTimer || this.remoteTells || this.closed) return
    this.quietTimer = setInterval(() => {
      this.pc.getStats().then((report) => {
        if (this.remoteTells || this.closed) return
        const now = performance.now()
        report.forEach((s: any) => {
          if (s.type !== "inbound-rtp" || (s.kind !== "audio" && s.kind !== "video")) return
          const kind = s.kind as MediaKind
          const heard = this.heard[kind]
          // frames, not packets, for video: padding probes the line while no picture is sent
          const count: number = (kind === "video" ? s.framesReceived ?? s.framesDecoded : s.packetsReceived) ?? 0
          if (count > heard.count) {
            const grew = heard.count >= 0
            heard.count = count
            heard.at = now
            if (grew) this.setRemote(kind, true)
          } else if (now - heard.at > QUIET_AFTER_MS) {
            this.setRemote(kind, false)
          }
        })
      }, () => {})
    }, QUIET_POLL_MS)
  }

  private stopGuessing(): void {
    if (this.quietTimer) clearInterval(this.quietTimer)
    this.quietTimer = null
  }

  private setRemote(kind: MediaKind, active: boolean): void {
    if (this.remoteActive[kind] === active || this.closed) return
    this.remoteActive[kind] = active
    this.events.remoteMedia({ kind, active })
  }

  private openChannel(id: number, label: string, init: RTCDataChannelInit, threshold: number): void {
    let c: RTCDataChannel
    try { c = this.pc.createDataChannel(label, init) } catch { this.events.dataChannelClose({ id }); return }
    if (threshold) c.bufferedAmountLowThreshold = threshold
    this.watchChannel(id, c)
  }

  /** A channel the other side opened: the control channel is taken and hidden, any other is the
   *  app's under an id of ours. */
  private adopt(c: RTCDataChannel): void {
    if (this.closed) return
    if (c.label === CONTROL) {
      if (!this.control) this.watchControl(c)
      return
    }
    this.watchChannel(this.nextChannel++, c)
  }

  private watchChannel(id: number, c: RTCDataChannel): void {
    this.channels.set(id, c)
    c.binaryType = "arraybuffer"
    const opened = (): void => { if (!this.closed) this.events.dataChannelOpen({ id, label: c.label }) }
    if (c.readyState === "open") opened()
    else c.addEventListener("open", opened, { once: true })
    c.addEventListener("message", (e) => {
      if (this.closed) return
      const data = e.data
      if (typeof data === "string") this.events.dataChannelMessage({ id, text: data })
      else this.events.dataChannelMessage({ id, binary: new Uint8Array(data as ArrayBuffer) })
    })
    c.addEventListener("bufferedamountlow", () => { if (!this.closed) this.events.dataChannelBufferedAmountLow({ id }) })
    c.addEventListener("close", () => {
      if (this.channels.get(id) !== c) return
      this.channels.delete(id)
      if (!this.closed) this.events.dataChannelClose({ id })
    })
  }

  private channelToSend(id: number): RTCDataChannel {
    const c = this.channels.get(id)
    if (!c) throw new RtcConnectionError(this.queued.has(id) ? "failed" : "notFound")
    if (c.readyState === "connecting") throw new RtcConnectionError("failed")
    if (c.readyState !== "open") throw new RtcConnectionError("closed")
    return c
  }

  private async addPendingCandidates(): Promise<void> {
    const pending = this.pendingCandidates
    this.pendingCandidates = []
    for (const candidate of pending) await this.addNow(candidate)
  }

  private async addNow(candidate: string): Promise<void> {
    const mid = firstMid(this.pc.remoteDescription?.sdp ?? "")
    try {
      await this.pc.addIceCandidate(mid !== null ? { candidate, sdpMid: mid } : { candidate, sdpMLineIndex: 0 })
    } catch { /* a line the browser cannot read: skipped */ }
  }

  /** The one state, and the restart request: a path lost for RESTART_AFTER_MS (or failed) asks the
   *  offering side for an ICE restart, once until it is back. */
  private settle(): void {
    if (this.closed) return
    const state = stateOf(this.pc)
    if (state !== this.state) {
      this.state = state
      this.events.stateChange({ state })
      if (state === "connected") {
        this.sample().catch(() => {})
        this.guess()
      } else {
        this.stopGuessing()
      }
    }
    const ice = this.pc.iceConnectionState
    if (ice === "connected" || ice === "completed") {
      if (this.restartTimer) clearTimeout(this.restartTimer)
      this.restartTimer = null
      this.restartAsked = false
    } else if (ice === "failed") {
      this.askRestart()
    } else if (ice === "disconnected" && !this.restartTimer && !this.restartAsked) {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        const now = this.pc.iceConnectionState
        if (now === "disconnected" || now === "failed") this.askRestart()
      }, RESTART_AFTER_MS)
    }
  }

  private askRestart(): void {
    if (this.restartAsked || this.closed) return
    this.restartAsked = true
    this.events.iceRestartNeeded()
  }

  /** Plays what this connection receives, through an element of its own: the browser renders a
   *  received track only through one. */
  private playAudio(): void {
    const track = this.remote.audio.current()
    if (!track || this.audio || typeof document === "undefined") return
    const el = this.audio = document.createElement("audio")
    el.autoplay = true
    el.hidden = true
    el.muted = this.audioMuted
    el.setAttribute("data-rtc-remote-audio", this.remote.audio.id)
    el.srcObject = new MediaStream([track])
    document.body?.appendChild(el)
    const play = (): void => {
      el.play().catch(() => {
        // the page was not used yet: the next tap or key plays it
        const retry = (): void => {
          document.removeEventListener("pointerdown", retry, true)
          document.removeEventListener("keydown", retry, true)
          if (!this.closed && this.audio === el && el.paused) el.play().catch(() => {})
        }
        document.addEventListener("pointerdown", retry, true)
        document.addEventListener("keydown", retry, true)
      })
    }
    play()
  }

  /** The counters now, kept for the rates of the next call; and the moment to count from. */
  private async sample(): Promise<void> {
    const report = await this.pc.getStats()
    report.forEach((s: any) => { if (this.connectedAt === null && typeof s.timestamp === "number") this.connectedAt = s.timestamp })
    this.statsOf(report)
  }

  /** The browser's report as the contract's shape. The rates and the loss are over the time since
   *  the previous call (or since the connection connected); the jitter buffer is the mean delay of
   *  the samples played in that time. */
  private statsOf(report: RTCStatsReport): ConnectionStats {
    const stats: ConnectionStats = {
      state: this.closed ? "closed" : stateOf(this.pc), rttMs: 0, sendEstimate: 0, audioSendBitrate: 0, audioRecvBitrate: 0,
      videoSendBitrate: 0, videoRecvBitrate: 0, audioLoss: 0, videoLoss: 0, audioJitterBufferMs: 0, videoRecvFps: 0, bytesSent: 0, bytesReceived: 0,
    }
    let pair: any = null
    let transport: any = null
    report.forEach((s: any) => { if (s.type === "transport") transport = s })
    if (transport?.selectedCandidatePairId) pair = report.get(transport.selectedCandidatePairId)
    if (!pair) report.forEach((s: any) => { if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s })
    if (pair) {
      stats.rttMs = Math.round((pair.currentRoundTripTime ?? 0) * 1000)
      stats.sendEstimate = Math.round(pair.availableOutgoingBitrate ?? 0)
    }
    stats.bytesSent = transport?.bytesSent ?? pair?.bytesSent ?? 0
    stats.bytesReceived = transport?.bytesReceived ?? pair?.bytesReceived ?? 0

    // what each stream had at the previous call; one first seen now counts from nothing at the
    // moment the connection connected (its media began after that)
    const delta = (key: string, now: Sample): Sample | null => {
      const before = this.samples.get(key) ?? (this.connectedAt !== null ? { at: this.connectedAt, bytes: 0, lost: 0, received: 0, delay: 0, emitted: 0, frames: 0 } : undefined)
      this.samples.set(key, now)
      return before && now.at > before.at ? before : null
    }
    const bps = (now: Sample, before: Sample | null): number =>
      before ? Math.max(0, Math.round((now.bytes - before.bytes) * 8 / ((now.at - before.at) / 1000))) : 0
    report.forEach((s: any) => {
      if (s.type !== "outbound-rtp" && s.type !== "inbound-rtp") return
      const kind = s.kind ?? s.mediaType
      if (kind !== "audio" && kind !== "video") return
      const now: Sample = {
        at: s.timestamp, bytes: (s.type === "outbound-rtp" ? s.bytesSent : s.bytesReceived) ?? 0, lost: s.packetsLost ?? 0,
        received: s.packetsReceived ?? 0, delay: s.jitterBufferDelay ?? 0, emitted: s.jitterBufferEmittedCount ?? 0, frames: s.framesDecoded ?? 0,
      }
      const before = delta(`${s.type}:${kind}`, now)
      if (s.type === "outbound-rtp") {
        if (kind === "audio") stats.audioSendBitrate += bps(now, before)
        else stats.videoSendBitrate += bps(now, before)
        return
      }
      const lost = before ? now.lost - before.lost : now.lost
      const got = before ? now.received - before.received : now.received
      const loss = lost > 0 && lost + got > 0 ? Math.min(1, lost / (lost + got)) : 0
      if (kind === "audio") {
        stats.audioRecvBitrate += bps(now, before)
        stats.audioLoss = loss
        const emitted = before ? now.emitted - before.emitted : now.emitted
        const delay = before ? now.delay - before.delay : now.delay
        stats.audioJitterBufferMs = emitted > 0 ? Math.round(delay / emitted * 1000) : 0
      } else {
        stats.videoRecvBitrate += bps(now, before)
        stats.videoLoss = loss
        stats.videoRecvFps = typeof s.framesPerSecond === "number" ? Math.round(s.framesPerSecond)
          : before ? Math.round((now.frames - before.frames) / ((now.at - before.at) / 1000)) : 0
      }
    })
    return stats
  }
}

const makeConnection = (host: PluginHost): void => {
  registerRtcConnection(host, (params, events): RtcConnectionPlugin => new Session(params, events))
}

// ---- the picture ----------------------------------------------------------------------------------

/** One track's picture: a <video> filling `el`, its `srcObject` the browser track of the id it shows
 *  — followed as it changes (a switched camera, a connection's line made) — ONE class behind the
 *  fullscreen View's instance and the host node's half. The fit is CSS `object-fit`, the mirror a
 *  CSS transform; `resize` comes from the element (its first frame's size, every change after). An
 *  element taken out of the page pauses: shown again, it plays on. */
class RtcPicture {
  readonly el: HTMLElement
  private readonly video: HTMLVideoElement
  private readonly shown: IntersectionObserver | null
  private source: Source | null = null
  private readonly follow = (): void => this.attach()
  private width = 0
  private height = 0

  constructor(doc: Document, private readonly events: { resize(payload: { width: number, height: number }): void }, private fit: ObjectFit, private mirror: boolean) {
    this.el = doc.createElement("div")
    this.el.style.background = "#000"
    this.el.style.overflow = "hidden"
    const video = this.video = doc.createElement("video")
    video.autoplay = true
    video.muted = true      // a call's audio plays through its connection, never through a picture
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

  private attach(): void {
    const track = this.source?.current() ?? null
    const now = (this.video.srcObject as MediaStream | null)?.getTracks()[0] ?? null
    if (now === track) return
    this.video.srcObject = track ? new MediaStream([track]) : null
    if (track) this.play()
  }

  /** Draw the track `trackId` (null = black). An id the half does not know: "notFound". */
  show(trackId: string | null): void {
    const source = trackId === null ? null : sources.get(trackId)
    if (source === undefined) throw new RtcVideoError("notFound")
    this.source?.watchers.delete(this.follow)
    this.source = source
    source?.watchers.add(this.follow)
    this.attach()
  }

  setObjectFit(fit: ObjectFit): void { this.fit = fit; this.apply() }
  setMirror(mirror: boolean): void { this.mirror = mirror; this.apply() }

  destroy(): void {
    this.shown?.disconnect()
    this.source?.watchers.delete(this.follow)
    this.source = null
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
      setObjectFit: (fit) => { picture.setObjectFit(fit) },
      setMirror: (mirror) => { picture.setMirror(mirror) },
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
  makeConnection(host)
  makeVideo(host)
}
