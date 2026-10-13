// webrtc — real-time audio, video and data between peers, over libwebrtc on iOS and Android and
// the browser's own stack on the web. The wire is the W3C API, cut at the objects: a peer
// connection is a SESSION of the "rtcPeerConnection" service (its params are the configuration,
// the SDK's close() is RTCPeerConnection.close()), the media devices are the "rtcMedia" service,
// and a track is drawn by the "rtcVideo" view. Tracks, senders, transceivers and data channels
// live in the host; what crosses is an id the host allocated. A remote track (the `track` event)
// is a track like any other: the view shows it, another connection can forward it.
//
// Signaling is NOT here: the app carries the descriptions and the candidates over its own
// channel (a WebSocket). The halves are dumb on purpose — no room, no call, no server — so that a
// client of an SFU (mediasoup-client, LiveKit's) can run in the app's bundle over this wire.
//
// The app-facing API (sdk/) is the browser's: RTCPeerConnection, MediaStream, MediaStreamTrack,
// RTCDataChannel, mediaDevices.getUserMedia(), plus RTCVideoView for the picture.

import type { Json, Service, View, f64, i32 } from "lecodes-sdk/plugin"

// ---- media ----------------------------------------------------------------------------------------

export type MediaKind = "audio" | "video"
/** The browser's facingMode values: "user" is the front camera, "environment" the back one. */
export type FacingMode = "user" | "environment"
export type DeviceKind = "audioinput" | "audiooutput" | "videoinput"
/** Where the call's audio plays on a phone. */
export type AudioOutput = "earpiece" | "speaker"

export interface AudioConstraints {
  /** A device of enumerateDevices(); the default input when absent. */
  deviceId?: string
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
  frameRate?: f64
}

/** What to capture: a kind present = wanted (the wrapper turns the browser's `audio: true` into `{}`). */
export interface MediaConstraints {
  audio?: AudioConstraints
  video?: VideoConstraints
}

export interface TrackInfo {
  /** The host's id of the track — what every call names it by. */
  id: string
  kind: MediaKind
  /** The device's name for a local track, the remote msid for a received one. */
  label: string
  enabled: boolean
  /** A received track the sender has muted (no media is arriving). Default false. */
  muted?: boolean
}

export interface StreamInfo {
  id: string
  tracks: TrackInfo[]
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
  frameRate?: f64
}

export interface RtcMediaParams {}

export interface RtcMediaEvents {
  /** A device was plugged in or removed (a headset, a camera). */
  deviceChange: void
  /** A local track ended on its own: the OS took the device (a call came in, the camera was claimed). */
  trackEnded: { trackId: string }
}

/** The devices: capture, the device list, the audio route. One session for the app. */
export interface RtcMedia extends Service<"rtcMedia", RtcMediaParams, RtcMediaEvents> {
  /** Capture: prompts for the permissions it needs, resolves with a stream of the new tracks.
   *  @rejects denied notFound failed */
  getUserMedia(constraints: MediaConstraints): Promise<StreamInfo>
  /** The devices the host can capture with (labels need a granted permission on the web). */
  enumerateDevices(): Promise<DeviceInfo[]>
  /** A disabled track sends silence / black frames and stays in every connection. @rejects notFound */
  setTrackEnabled(trackId: string, enabled: boolean): Promise<void>
  /** Re-aim a local video track: the other camera, another size or rate. The track and its id
   *  stay; every connection keeps sending it. @rejects notFound failed */
  applyConstraints(trackId: string, constraints: VideoConstraints): Promise<void>
  /** @rejects notFound */
  getTrackSettings(trackId: string): Promise<TrackSettings>
  /** End a track: the device is released once no track of it is left, every sender of it goes
   *  quiet, the id is forgotten. A no-op for an unknown id. */
  stopTrack(trackId: string): Promise<void>
  /** Route the audio of the call: the earpiece (the default while a wired or Bluetooth headset is
   *  not connected) or the loudspeaker. A no-op on the web. */
  setAudioOutput(output: AudioOutput): Promise<void>
}

// ---- the peer connection --------------------------------------------------------------------------

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

export type IceTransportPolicy = "all" | "relay"
export type BundlePolicy = "balanced" | "max-compat" | "max-bundle"

/** The RTCConfiguration — the params of a session, and what setConfiguration takes. */
export interface RtcConfiguration {
  iceServers?: IceServer[]
  /** Default "all". */
  iceTransportPolicy?: IceTransportPolicy
  /** Default "balanced". */
  bundlePolicy?: BundlePolicy
  /** Default 0. */
  iceCandidatePoolSize?: i32
}

export type SdpType = "offer" | "answer" | "pranswer" | "rollback"

export interface SessionDescription {
  type: SdpType
  sdp: string
}

export interface IceCandidate {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: i32 | null
  usernameFragment?: string
}

export interface OfferOptions {
  iceRestart?: boolean
  offerToReceiveAudio?: boolean
  offerToReceiveVideo?: boolean
}

export type SignalingState = "stable" | "have-local-offer" | "have-remote-offer" | "have-local-pranswer" | "have-remote-pranswer" | "closed"
export type IceGatheringState = "new" | "gathering" | "complete"
export type IceConnectionState = "new" | "checking" | "connected" | "completed" | "failed" | "disconnected" | "closed"
export type PeerConnectionState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed"
export type TransceiverDirection = "sendrecv" | "sendonly" | "recvonly" | "inactive" | "stopped"

/** One encoding of a sender (a simulcast layer when there are several, each with a `rid`). */
export interface Encoding {
  rid?: string
  /** Default true. */
  active?: boolean
  /** Bits per second. */
  maxBitrate?: i32
  maxFramerate?: f64
  /** 2 = half the width and the height. */
  scaleResolutionDownBy?: f64
}

export interface SenderParameters {
  encodings: Encoding[]
}

export interface TransceiverInit {
  /** Default "sendrecv". */
  direction?: TransceiverDirection
  /** A local track to send from the start. */
  trackId?: string
  streamIds?: string[]
  /** The simulcast layers (an SFU client's): one encoding each, with a rid. */
  sendEncodings?: Encoding[]
}

export interface SenderInfo {
  id: string
  trackId: string | null
}

export interface TransceiverInfo {
  id: string
  mid: string | null
  direction: TransceiverDirection
  currentDirection: TransceiverDirection | null
  sender: SenderInfo
  /** The receiver's track exists from the start (before any media arrives). */
  receiverTrack: TrackInfo
  stopped: boolean
}

export interface DataChannelInit {
  /** Default true. */
  ordered?: boolean
  maxPacketLifeTime?: i32
  maxRetransmits?: i32
  /** Default "". */
  protocol?: string
  /** Default false. */
  negotiated?: boolean
  /** The SCTP stream id of a negotiated channel. */
  id?: i32
}

export type DataChannelState = "connecting" | "open" | "closing" | "closed"

export interface DataChannelInfo {
  /** The host's id of the channel — what every call names it by. */
  id: string
  label: string
  ordered: boolean
  maxPacketLifeTime: i32 | null
  maxRetransmits: i32 | null
  protocol: string
  negotiated: boolean
  /** The SCTP stream id; null until the transport assigned one. */
  streamId: i32 | null
  readyState: DataChannelState
}

export interface RtcPeerConnectionEvents {
  negotiationNeeded: void
  /** A local candidate for the other side; null = the gathering of this round is complete. */
  iceCandidate: { candidate: IceCandidate | null }
  signalingStateChange: { state: SignalingState }
  iceGatheringStateChange: { state: IceGatheringState }
  iceConnectionStateChange: { state: IceConnectionState }
  connectionStateChange: { state: PeerConnectionState }
  /** A remote track arrived: the receiver's track of `transceiverId`, in the streams the other
   *  side put it in. */
  track: { track: TrackInfo, streamIds: string[], transceiverId: string }
  /** A received track went mute (nothing arrives) or came back. */
  trackMute: { trackId: string, muted: boolean }
  /** A received track ended: the other side removed it, or the connection closed. */
  trackEnded: { trackId: string }
  /** The other side opened a data channel. */
  dataChannel: DataChannelInfo
  dataChannelStateChange: { id: string, state: DataChannelState }
  /** One message: `text` for a string, `binary` for bytes — exactly one of the two. */
  dataChannelMessage: { id: string, text?: string, binary?: Uint8Array }
  dataChannelError: { id: string, message: string }
  /** The buffered amount fell to the threshold or under it. */
  dataChannelBufferedAmountLow: { id: string }
}

/** One RTCPeerConnection: a session, created with its configuration, closed by the SDK's close(). */
export interface RtcPeerConnection extends Service<"rtcPeerConnection", RtcConfiguration, RtcPeerConnectionEvents> {
  /** @rejects failed closed */
  createOffer(options?: OfferOptions): Promise<SessionDescription>
  /** @rejects failed closed */
  createAnswer(): Promise<SessionDescription>
  /** Without a description: the implicit form — an answer when a remote offer is pending, an
   *  offer otherwise. Resolves with the description now in force (the one to signal).
   *  @rejects failed closed */
  setLocalDescription(description?: SessionDescription): Promise<SessionDescription>
  /** @rejects failed closed */
  setRemoteDescription(description: SessionDescription): Promise<void>
  /** Without a candidate: the end of the remote candidates. @rejects failed closed */
  addIceCandidate(candidate?: IceCandidate): Promise<void>
  /** The next offer carries new ICE credentials. */
  restartIce(): Promise<void>
  /** @rejects failed */
  setConfiguration(configuration: RtcConfiguration): Promise<void>
  /** Send a local track, in the streams named (one is made up when none is). @rejects notFound failed closed */
  addTrack(trackId: string, streamIds?: string[]): Promise<SenderInfo>
  /** @rejects notFound closed */
  removeTrack(senderId: string): Promise<void>
  /** Swap what a sender sends without renegotiating; null = send nothing. @rejects notFound failed closed */
  replaceTrack(senderId: string, trackId: string | null): Promise<void>
  /** @rejects notFound */
  getSenderParameters(senderId: string): Promise<SenderParameters>
  /** The encodings' active / bitrate / scale; the layers themselves are set at addTransceiver. @rejects notFound failed */
  setSenderParameters(senderId: string, parameters: SenderParameters): Promise<void>
  /** @rejects notFound failed closed */
  addTransceiver(kind: MediaKind, options?: TransceiverInit): Promise<TransceiverInfo>
  getTransceivers(): Promise<TransceiverInfo[]>
  /** @rejects notFound failed */
  setTransceiverDirection(transceiverId: string, direction: TransceiverDirection): Promise<void>
  /** @rejects notFound */
  stopTransceiver(transceiverId: string): Promise<void>
  /** The RTCStatsReport as an object: the stats id → the stats object (`type`, `timestamp` in ms,
   *  the fields of its type). For one track's senders / receivers when `trackId` is given. */
  getStats(trackId?: string): Promise<Json>
  /** @rejects failed closed */
  createDataChannel(label: string, options?: DataChannelInit): Promise<DataChannelInfo>
  /** @rejects notFound closed */
  sendText(channelId: string, text: string): Promise<void>
  /** @rejects notFound closed */
  sendBinary(channelId: string, data: Uint8Array): Promise<void>
  /** Bytes queued and not yet sent. @rejects notFound */
  getBufferedAmount(channelId: string): Promise<f64>
  /** @rejects notFound */
  setBufferedAmountLowThreshold(channelId: string, threshold: f64): Promise<void>
  /** A no-op for an unknown id. */
  closeDataChannel(channelId: string): Promise<void>
}

// ---- the picture ----------------------------------------------------------------------------------

export type ObjectFit = "cover" | "contain"

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

/** A view drawing one video track, local or remote. */
export interface RtcVideo extends View<"rtcVideo", RtcVideoParams, RtcVideoEvents> {
  /** Draw another track; null = black. @rejects notFound */
  setTrack(trackId: string | null): Promise<void>
  setObjectFit(fit: ObjectFit): Promise<void>
  setMirror(mirror: boolean): Promise<void>
}
