// rtc — real-time audio, video and data between peers: calls between LeCodes apps, and with a
// browser. On iOS and Android it is tinyrtc (a small stack of its own: about 2 MB, where libwebrtc
// is about 10), on the web the browser's own WebRTC held to the same profile. ONE profile, never
// negotiated: Opus, H.264 Constrained Baseline through the phone's hardware codec, data channels.
// Every connection holds all three from its first offer, so nothing a call does later — a camera
// turned on, a channel opened — is a new offer; the only second offer is an ICE restart.
//
// The wire is cut at three objects: the devices are the "rtcMedia" service (capture, the device
// list, the audio route), a peer is a SESSION of the "rtcConnection" service (a group call is a
// session per other participant), and a track is drawn on two surfaces with one set of methods
// (RtcVideoMethods): the fullscreen VIEW "rtcVideo" (`RTCVideoView`: its own layer, `Router.push`,
// widgets over it) and the HOST NODE "rtcVideo" (`UIRTCVideoNode`: a box in a screen's layout) —
// on every platform one picture class under two thin instances. Tracks and data channels live in
// the host; what crosses is an id the host allocated.
//
// Signaling is NOT here: the app carries three kinds of text — an offer, an answer, candidates —
// over its own channel (a WebSocket, a channel of the backend). A call that finds no direct path
// crosses a relay that forwards bytes it cannot read: the app's backend reserves it on a tinyrtc
// media server and hands each side the relay's candidate (`addIceCandidate`); there is no TURN.
//
// The app-facing API (sdk/): RtcMedia, RtcTrack, RtcConnection, RtcDataChannel, plus
// UIRTCVideoNode / RTCVideoView for the picture.

import type { Service, UIHostNode, View, f64, i32 } from "lecodes-sdk/plugin"

// ---- media ----------------------------------------------------------------------------------------

export type MediaKind = "audio" | "video"
/** "user" is the front camera, "environment" the back one. */
export type FacingMode = "user" | "environment"
export type DeviceKind = "audioinput" | "audiooutput" | "videoinput"
/** Where the call's audio plays on a phone. */
export type AudioOutput = "earpiece" | "speaker"

/** The microphone always goes through the system's voice processing; the three flags can switch
 *  parts of it off on the web and on Android (iOS has one unit: all or nothing, always on). */
export interface AudioConstraints {
  /** Default true. */
  echoCancellation?: boolean
  /** Default true. */
  noiseSuppression?: boolean
  /** Default true. */
  autoGainControl?: boolean
}

export interface VideoConstraints {
  /** A device of enumerateDevices(); wins over facingMode. */
  deviceId?: string
  /** Default "user". */
  facingMode?: FacingMode
  /** The capture size wanted; the host picks the closest format the camera has. Default 1280×720. */
  width?: i32
  height?: i32
  /** Default 30. */
  frameRate?: i32
}

/** What to capture: a kind present = wanted (the wrapper turns `audio: true` into `{}`). */
export interface MediaConstraints {
  audio?: AudioConstraints
  video?: VideoConstraints
}

export interface TrackInfo {
  /** The host's id of the track — what every call names it by. */
  id: string
  kind: MediaKind
  /** The device's name for a local track; "" for a received one. */
  label: string
  enabled: boolean
  /** A received track whose sender is not sending (its camera is off, its microphone muted).
   *  Default false. */
  muted?: boolean
}

export interface DeviceInfo {
  deviceId: string
  kind: DeviceKind
  label: string
  /** A camera's side, when the platform tells. */
  facing?: FacingMode
}

/** What a local video track captures with, after the constraints were applied. */
export interface TrackSettings {
  deviceId?: string
  facingMode?: FacingMode
  width?: i32
  height?: i32
  frameRate?: i32
}

export interface RtcMediaParams {}

export interface RtcMediaEvents {
  /** A device was plugged in or removed (a headset, a camera). */
  deviceChange: void
  /** A local track ended on its own: the OS took the device and did not give it back. */
  trackEnded: { trackId: string }
}

/** The devices: capture, the device list, the audio route. One session for the app. */
export interface RtcMedia extends Service<"rtcMedia", RtcMediaParams, RtcMediaEvents> {
  /** Capture: prompts for the permissions it needs, resolves with the new tracks — the microphone
   *  first when both were asked for. @rejects denied notFound failed */
  getUserMedia(constraints: MediaConstraints): Promise<TrackInfo[]>
  /** The devices the host can capture with (labels need a granted permission on the web). */
  enumerateDevices(): Promise<DeviceInfo[]>
  /** A disabled track is not sent: the other side learns it (`remoteMedia`, inactive) and shows
   *  what it likes instead. The device stays open; the track stays in every connection.
   *  @rejects notFound */
  setTrackEnabled(trackId: string, enabled: boolean): Promise<void>
  /** Re-aim a local video track: the other camera, another size or rate. The track and its id
   *  stay; every connection keeps sending it. @rejects notFound failed */
  applyConstraints(trackId: string, constraints: VideoConstraints): Promise<void>
  /** @rejects notFound */
  getTrackSettings(trackId: string): Promise<TrackSettings>
  /** The most a local video track may take, bits per second (default 1 500 000). It is encoded
   *  once for every connection that sends it, so the ceiling is the track's; the size and the rate
   *  under it follow the network by themselves. @rejects notFound */
  setMaxVideoBitrate(trackId: string, bitrate: i32): Promise<void>
  /** End a track: the device is released, every connection stops sending it, the id is
   *  forgotten. A no-op for an unknown id. */
  stopTrack(trackId: string): Promise<void>
  /** Route the audio of the call: the earpiece (or a headset when one is connected) or the
   *  loudspeaker. A no-op on the web. */
  setAudioOutput(output: AudioOutput): Promise<void>
}

// ---- a connection ---------------------------------------------------------------------------------

export interface IceServer {
  /** "stun:host:port". The reflexive address a STUN server sees is offered as a candidate. */
  urls: string[]
}

export interface RtcConnectionParams {
  iceServers?: IceServer[]
  /** Never reveal an address of this device: no candidate of its own is put into a description
   *  or raised as `iceCandidate`, so the only path is through a candidate the app adds — the
   *  relay's. Default false. */
  relayOnly?: boolean
}

/** One state, where the browser has four. */
export type ConnectionState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed"

export interface DataChannelInit {
  /** Default true. */
  ordered?: boolean
  /** At most one of the two; neither = reliable. */
  maxRetransmits?: i32
  maxPacketLifeTime?: i32
}

/** What a call screen and a bug report need — a fixed shape, not the browser's report. */
export interface ConnectionStats {
  state: ConnectionState
  rttMs: i32
  /** What the network is believed to carry, bits per second. */
  sendEstimate: i32
  audioSendBitrate: i32
  audioRecvBitrate: i32
  videoSendBitrate: i32
  videoRecvBitrate: i32
  /** Received: the share lost over the last seconds, 0..1. */
  audioLoss: f64
  videoLoss: f64
  /** The delay the sound is played with. */
  audioJitterBufferMs: i32
  videoRecvFps: i32
  bytesSent: f64
  bytesReceived: f64
}

export interface RtcConnectionEvents {
  stateChange: { state: ConnectionState }
  /** A local candidate for the other side (the `candidate:` line). */
  iceCandidate: { candidate: string }
  /** The network changed under the call: the side that made the offer calls `createOffer(true)`. */
  iceRestartNeeded: void
  /** The other side started or stopped sending a kind (its camera went on / off). */
  remoteMedia: { kind: MediaKind, active: boolean }
  /** A channel opened — one of ours, or one the other side made. */
  dataChannelOpen: { id: i32, label: string }
  /** `text` for a string, `binary` for bytes — exactly one of the two. */
  dataChannelMessage: { id: i32, text?: string, binary?: Uint8Array }
  dataChannelBufferedAmountLow: { id: i32 }
  dataChannelClose: { id: i32 }
}

/** One peer: a session, created with its servers, closed by the SDK's close(). */
export interface RtcConnection extends Service<"rtcConnection", RtcConnectionParams, RtcConnectionEvents> {
  // -- signaling
  /** The offering side. `iceRestart` for every offer after the first. @rejects failed closed */
  createOffer(iceRestart?: boolean): Promise<string>
  /** The answering side: takes the offer, resolves with the answer. @rejects failed closed */
  acceptOffer(offer: string): Promise<string>
  /** The offering side: takes the answer. @rejects failed closed */
  acceptAnswer(answer: string): Promise<void>
  /** A candidate of the other side (its `candidate:` line), or a relay's. */
  addIceCandidate(candidate: string): Promise<void>

  // -- media. Both kinds are in every connection from the start: sending or stopping is never a
  // new offer.
  /** Send a local track of rtcMedia (the microphone, the camera); null = stop sending that kind.
   *  @rejects notFound failed closed */
  setTrack(kind: MediaKind, trackId: string | null): Promise<void>
  /** The two tracks this connection receives; they exist from the start (`muted` until the other
   *  side sends). The video one goes to rtcVideo's setTrack; the audio one plays by itself. */
  getRemoteTracks(): Promise<{ audio: TrackInfo, video: TrackInfo }>
  /** Leave this peer's sound out of what is played. */
  setRemoteAudioMuted(muted: boolean): Promise<void>
  /** @rejects closed */
  getStats(): Promise<ConnectionStats>

  // -- data channels: opened in-band, no new offer
  /** Resolves with the channel's id; `dataChannelOpen` says when it can send. @rejects failed closed */
  createDataChannel(label: string, options?: DataChannelInit): Promise<i32>
  /** @rejects notFound failed closed */
  sendText(channelId: i32, text: string): Promise<void>
  /** @rejects notFound failed closed */
  sendBinary(channelId: i32, data: Uint8Array): Promise<void>
  /** Bytes queued and not yet sent. @rejects notFound */
  getBufferedAmount(channelId: i32): Promise<f64>
  /** @rejects notFound */
  setBufferedAmountLowThreshold(channelId: i32, threshold: f64): Promise<void>
  /** A no-op for an unknown id. */
  closeDataChannel(channelId: i32): Promise<void>
}

// ---- the picture ----------------------------------------------------------------------------------

export type ObjectFit = "cover" | "contain"

// The View's params, and the node's props: LIVE there — a write does what the method of its name does.
export interface RtcVideoParams {
  /** The track to draw; none = black. */
  trackId?: string
  /** Default "cover". */
  objectFit?: ObjectFit
  /** Flip horizontally — the front camera's preview. Default false. */
  mirror?: boolean
}

export interface RtcVideoEvents {
  /** The first frame was drawn, and every change of the picture's size after. */
  resize: { width: i32, height: i32 }
}

/** The methods of both surfaces: the View's and the node's, one implementation per platform. */
export interface RtcVideoMethods {
  /** Draw another track; null = black. @rejects notFound */
  setTrack(trackId: string | null): Promise<void>
  setObjectFit(fit: ObjectFit): Promise<void>
  setMirror(mirror: boolean): Promise<void>
}

/** A view drawing one video track, local or remote. */
export interface RtcVideo extends View<"rtcVideo", RtcVideoParams, RtcVideoEvents>, RtcVideoMethods {}

/** One video track, local or remote, as a node of the layout: a box in a screen, sized by its
 *  styles, black where there is no picture; the holder paints the box (radius, border, shadow) over
 *  it. */
export interface UIRTCVideo extends UIHostNode<"rtcVideo", RtcVideoParams, RtcVideoEvents>, RtcVideoMethods {}
