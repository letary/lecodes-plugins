//
//  RtcConnectionSession.kt — lecodes-plugins/rtc
//
//  One session of the "rtcConnection" service = one tinyrtc connection (one peer), made with the
//  session's params and closed with the session. The connection is made on the session's FIRST
//  call, not when the session opens (a session must open cheaply, and a tinyrtc connection starts
//  the call's audio the moment it exists); its two received tracks go into the registry with it as
//  "rN.audio" / "rN.video" (the prefix taken when the session opened) and are forgotten when the
//  session closes. The data channels are kept here by the session's own integer ids (1, 2, ...): a
//  channel the other side opened arrives already open and is announced with `dataChannelOpen` like
//  one of ours.
//
//  Calls arrive on the main thread, tinyrtc's events too; the `suspend` calls run in the session's
//  scope (SessionCalls). close() rejects what is in flight, closes the connection — tinyrtc sends no
//  event of it or of its channels after that — and forgets the received tracks (a picture showing
//  one goes black). tinyrtc's errors map onto the contract's codes: closed, notFound, failed.
//

package io.letary.lecodes.plugins.rtc

import dev.tinyrtc.DataChannelOptions
import dev.tinyrtc.LocalTrack
import dev.tinyrtc.RtcConfiguration
import dev.tinyrtc.RtcConnectionState
import dev.tinyrtc.RtcError
import dev.tinyrtc.RtcStats
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
import dev.tinyrtc.IceServer as TinyIceServer
import dev.tinyrtc.RtcConnection as TinyConnection
import dev.tinyrtc.RtcDataChannel as TinyDataChannel

internal class RtcConnectionSession(
    private val shared: RtcShared,
    params: RtcConnectionParams,
    private val events: RtcConnectionEvents,
) : RtcConnectionPlugin {

    private val tracks get() = shared.tracks
    private val calls = SessionCalls(RtcConnectionCode.CLOSED, ::connectionCode)

    /** One tinyrtc server per url (the contract groups urls; tinyrtc takes one each). */
    private val configuration = RtcConfiguration(
        iceServers = params.iceServers.orEmpty().flatMap { server -> server.urls.map { TinyIceServer(url = it) } },
        relayOnly = params.relayOnly ?: false,
    )

    private val prefix = tracks.connectionPrefix()
    private val audioId = "$prefix.audio"
    private val videoId = "$prefix.video"

    private var made: TinyConnection? = null
    private val channels = HashMap<Int, TinyDataChannel>()
    private var nextChannel = 1

    /** The connection, made on the first call that needs it, its events wired and its received
     *  tracks registered. Inside a call of [calls] only (they refuse once the session closed). */
    private fun connection(): TinyConnection {
        made?.let { return it }
        val c = shared.rtc().connect(configuration)
        made = c
        c.onState = { state -> events.stateChange(state.wire()) }
        c.onIceCandidate = { line -> events.iceCandidate(line) }
        c.onIceRestartNeeded = { events.iceRestartNeeded() }
        c.onRemoteMedia = { kind, active -> events.remoteMedia(kind.wire(), active) }
        c.onDataChannel = { channel -> events.dataChannelOpen(adopt(channel), channel.label) }
        tracks.add(RtcTracks.RemoteAudio(audioId, c.remoteAudio))
        tracks.add(RtcTracks.RemoteVideo(videoId, c.remoteVideo))
        return c
    }

    override fun close() {
        calls.close()
        val c = made ?: return
        made = null
        // The pictures let go of the received video (its decoders) before the connection goes.
        tracks.forget(audioId)
        tracks.forget(videoId)
        for (channel in channels.values) unwire(channel)
        channels.clear()
        c.onState = null
        c.onIceCandidate = null
        c.onIceRestartNeeded = null
        c.onRemoteMedia = null
        c.onDataChannel = null
        c.close()
    }

    // ---- signaling ----------------------------------------------------------------------------

    override fun createOffer(iceRestart: Boolean?, reply: Reply<String, RtcConnectionCode>) =
        calls.launch(reply) { connection().createOffer(iceRestart ?: false) }

    override fun acceptOffer(offer: String, reply: Reply<String, RtcConnectionCode>) =
        calls.launch(reply) { connection().acceptOffer(offer) }

    override fun acceptAnswer(answer: String, reply: Reply<Unit, RtcConnectionCode>) =
        calls.launch(reply) { connection().acceptAnswer(answer) }

    /** "" = the other side has no more (tinyrtc's null). A line the core refuses is only logged by tinyrtc. */
    override fun addIceCandidate(candidate: String, reply: Reply<Unit, RtcConnectionCode>) =
        calls.now(reply) { connection().addIceCandidate(candidate.ifEmpty { null }) }

    // ---- media --------------------------------------------------------------------------------

    override fun setTrack(kind: MediaKind, trackId: String?, reply: Reply<Unit, RtcConnectionCode>) {
        val track: LocalTrack? = if (trackId == null) null else {
            // Checked here: tinyrtc require()s the kind (an IllegalArgumentException, no code).
            val found: LocalTrack? = when (val entry = tracks.local(trackId)) {
                is RtcTracks.LocalAudio -> entry.track.takeIf { kind == MediaKind.AUDIO }
                is RtcTracks.LocalVideo -> entry.track.takeIf { kind == MediaKind.VIDEO }
                else -> null
            }
            if (found == null || found.isStopped) return reply.reject(RtcConnectionCode.NOT_FOUND)
            found
        }
        calls.now(reply) { connection().setTrack(kind.tiny(), track) }
    }

    override fun getRemoteTracks(reply: Reply<RtcConnectionGetRemoteTracksResult, RtcConnectionCode>) = calls.now(reply) {
        val c = connection()
        RtcConnectionGetRemoteTracksResult(
            audio = TrackInfo(id = audioId, kind = MediaKind.AUDIO, label = "", enabled = true, muted = !c.remoteAudio.isActive),
            video = TrackInfo(id = videoId, kind = MediaKind.VIDEO, label = "", enabled = true, muted = !c.remoteVideo.isActive),
        )
    }

    override fun setRemoteAudioMuted(muted: Boolean, reply: Reply<Unit, RtcConnectionCode>) =
        calls.now(reply) { connection().remoteAudio.isMuted = muted }

    /** Before the connection is made: its numbers are all zero — a poll does not make it. */
    override fun getStats(reply: Reply<ConnectionStats, RtcConnectionCode>) {
        if (made == null && !calls.isClosed) return reply.resolve(NOTHING_YET)
        calls.launch(reply) { connection().stats().wire() }
    }

    // ---- data channels ------------------------------------------------------------------------

    override fun createDataChannel(label: String, options: DataChannelInit?, reply: Reply<Int, RtcConnectionCode>) {
        // tinyrtc require()s at most one of the two (an IllegalArgumentException, no code).
        if (options?.maxRetransmits != null && options.maxPacketLifeTime != null) return reply.reject(RtcConnectionCode.FAILED)
        val init = DataChannelOptions(
            ordered = options?.ordered ?: true,
            maxRetransmits = options?.maxRetransmits,
            maxPacketLifeTimeMs = options?.maxPacketLifeTime,
        )
        // adopt() runs in the same main-thread turn as the open's return: tinyrtc holds the channel's
        // first events until then, so its listeners are set before any of them.
        calls.launch(reply) { adopt(connection().createDataChannel(label, init)) }
    }

    override fun sendText(channelId: Int, text: String, reply: Reply<Unit, RtcConnectionCode>) {
        val channel = channels[channelId] ?: return reply.reject(RtcConnectionCode.NOT_FOUND)
        calls.now(reply) { channel.send(text) }
    }

    override fun sendBinary(channelId: Int, data: ByteArray, reply: Reply<Unit, RtcConnectionCode>) {
        val channel = channels[channelId] ?: return reply.reject(RtcConnectionCode.NOT_FOUND)
        calls.now(reply) { channel.send(data) }
    }

    override fun getBufferedAmount(channelId: Int, reply: Reply<Double, RtcConnectionCode>) {
        val channel = channels[channelId] ?: return reply.reject(RtcConnectionCode.NOT_FOUND)
        calls.launch(reply) { channel.bufferedAmount().toDouble() }
    }

    override fun setBufferedAmountLowThreshold(channelId: Int, threshold: Double, reply: Reply<Unit, RtcConnectionCode>) {
        val channel = channels[channelId] ?: return reply.reject(RtcConnectionCode.NOT_FOUND)
        calls.now(reply) { channel.bufferedAmountLowThreshold = threshold.toLong().coerceAtLeast(0) }
    }

    /** Ours to close. tinyrtc raises nothing on the closing side; the contract says both sides
     *  get dataChannelClose, so it is raised here. */
    override fun closeDataChannel(channelId: Int, reply: Reply<Unit, RtcConnectionCode>) {
        channels.remove(channelId)?.let { channel ->
            unwire(channel)
            channel.close()
            events.dataChannelClose(channelId)
        }
        reply.resolve()
    }

    /** A channel takes the session's next id; its events become the contract's. */
    private fun adopt(channel: TinyDataChannel): Int {
        val id = nextChannel++
        channels[id] = channel
        channel.onOpen = { events.dataChannelOpen(id, channel.label) }
        channel.onMessage = { message ->
            if (message.isBinary) events.dataChannelMessage(id, binary = message.data)
            else events.dataChannelMessage(id, text = message.text)
        }
        channel.onBufferedAmountLow = { events.dataChannelBufferedAmountLow(id) }
        channel.onClose = {
            channels.remove(id)
            events.dataChannelClose(id)
        }
        return id
    }

    private fun unwire(channel: TinyDataChannel) {
        channel.onOpen = null
        channel.onMessage = null
        channel.onBufferedAmountLow = null
        channel.onClose = null
    }
}

private fun RtcConnectionState.wire(): ConnectionState = when (this) {
    RtcConnectionState.NEW -> ConnectionState.NEW
    RtcConnectionState.CONNECTING -> ConnectionState.CONNECTING
    RtcConnectionState.CONNECTED -> ConnectionState.CONNECTED
    RtcConnectionState.DISCONNECTED -> ConnectionState.DISCONNECTED
    RtcConnectionState.FAILED -> ConnectionState.FAILED
    RtcConnectionState.CLOSED -> ConnectionState.CLOSED
}

private val NOTHING_YET = ConnectionStats(
    state = ConnectionState.NEW, rttMs = 0, sendEstimate = 0, audioSendBitrate = 0, audioRecvBitrate = 0,
    videoSendBitrate = 0, videoRecvBitrate = 0, audioLoss = 0.0, videoLoss = 0.0, audioJitterBufferMs = 0,
    videoRecvFps = 0, bytesSent = 0.0, bytesReceived = 0.0,
)

private fun Long.clampToInt(): Int = coerceIn(Int.MIN_VALUE.toLong(), Int.MAX_VALUE.toLong()).toInt()

private fun RtcStats.wire() = ConnectionStats(
    state = state.wire(),
    rttMs = rttMs,
    sendEstimate = sendEstimateBps.clampToInt(),
    audioSendBitrate = audioSendBps.clampToInt(),
    audioRecvBitrate = audioRecvBps.clampToInt(),
    videoSendBitrate = videoSendBps.clampToInt(),
    videoRecvBitrate = videoRecvBps.clampToInt(),
    audioLoss = audioLoss.toDouble(),
    videoLoss = videoLoss.toDouble(),
    audioJitterBufferMs = audioJitterBufferMs,
    videoRecvFps = videoRecvFps,
    bytesSent = bytesSent.toDouble(),
    bytesReceived = bytesReceived.toDouble(),
)

private fun connectionCode(e: RtcError): RtcConnectionCode = when (e) {
    is RtcError.Closed -> RtcConnectionCode.CLOSED
    is RtcError.NotFound -> RtcConnectionCode.NOT_FOUND
    is RtcError.Failed, is RtcError.Denied -> RtcConnectionCode.FAILED
}
