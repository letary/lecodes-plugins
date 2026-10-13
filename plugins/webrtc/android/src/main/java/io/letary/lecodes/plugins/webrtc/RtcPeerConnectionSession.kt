//
//  RtcPeerConnectionSession.kt — lecodes-plugins/webrtc
//
//  One session of the "rtcPeerConnection" service = one PeerConnection, made with the session's
//  params (the configuration) and closed with the session. The senders, the transceivers and the
//  data channels are kept here by the id the wire names them with; a received track goes into
//  RtcEngine's registry, where a view or another connection finds it.
//
//  Threading: the calls arrive on the main thread, libwebrtc's observers on its own threads; the
//  tables are concurrent, the replies and the events go from any thread.
//

package io.letary.lecodes.plugins.webrtc

import android.content.Context
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
import org.webrtc.AddIceObserver
import org.webrtc.DataChannel
import org.webrtc.IceCandidate as RtcIceCandidate
import org.webrtc.MediaConstraints as RtcMediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.RTCStatsReport
import org.webrtc.RtpParameters
import org.webrtc.RtpReceiver
import org.webrtc.RtpSender
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription as RtcSessionDescription
import java.math.BigInteger
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

class RtcPeerConnectionSession(
    context: Context,
    configuration: RtcConfiguration,
    private val events: RtcPeerConnectionEvents,
) : RtcPeerConnectionPlugin {

    private val pc: PeerConnection
    private val senders = ConcurrentHashMap<String, RtpSender>()
    private val senderIds = ConcurrentHashMap<RtpSender, String>()
    private val transceivers = ConcurrentHashMap<String, RtpTransceiver>()
    private val transceiverIds = ConcurrentHashMap<RtpTransceiver, String>()
    private val channels = ConcurrentHashMap<String, RtcDataChannel>()
    /** The received tracks' registry ids by libwebrtc's track id (unique within a connection). */
    private val received = ConcurrentHashMap<String, String>()
    private val closed = AtomicBoolean(false)

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val openChannels = channels.values.toList()
        channels.clear()
        val tracks = received.values.toList()
        received.clear()
        pc.close()
        openChannels.forEach { it.channel.close() }
        tracks.forEach { id ->
            RtcEngine.remove(id)
            events.trackEnded(id)
        }
        pc.dispose()
    }

    // ── the configuration ────────────────────────────────────────────────────

    private fun rtcConfiguration(c: RtcConfiguration): PeerConnection.RTCConfiguration {
        val servers = (c.iceServers ?: emptyList()).map { s ->
            PeerConnection.IceServer.builder(s.urls).apply {
                if (s.username != null) setUsername(s.username)
                if (s.credential != null) setPassword(s.credential)
            }.createIceServer()
        }
        return PeerConnection.RTCConfiguration(servers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            iceTransportsType = when (c.iceTransportPolicy ?: IceTransportPolicy.ALL) {
                IceTransportPolicy.ALL -> PeerConnection.IceTransportsType.ALL
                IceTransportPolicy.RELAY -> PeerConnection.IceTransportsType.RELAY
            }
            bundlePolicy = when (c.bundlePolicy ?: BundlePolicy.BALANCED) {
                BundlePolicy.BALANCED -> PeerConnection.BundlePolicy.BALANCED
                BundlePolicy.MAX_COMPAT -> PeerConnection.BundlePolicy.MAXCOMPAT
                BundlePolicy.MAX_BUNDLE -> PeerConnection.BundlePolicy.MAXBUNDLE
            }
            iceCandidatePoolSize = c.iceCandidatePoolSize ?: 0
        }
    }

    // ── ids ──────────────────────────────────────────────────────────────────

    private fun idOf(sender: RtpSender): String = senderIds.getOrPut(sender) {
        RtcEngine.allocate("sender").also { senders[it] = sender }
    }

    private fun idOf(transceiver: RtpTransceiver): String = transceiverIds.getOrPut(transceiver) {
        RtcEngine.allocate("transceiver").also { transceivers[it] = transceiver }
    }

    /** The registry entry of a received track, made when first seen. */
    private fun receivedTrack(track: MediaStreamTrack): RtcTrack {
        received[track.id()]?.let { id -> RtcEngine.track(id)?.let { return it } }
        val id = received.getOrPut(track.id()) { RtcEngine.allocate(if (track.kind() == MediaStreamTrack.VIDEO_TRACK_KIND) "rvideo" else "raudio") }
        val entry = RtcTrack(id, track, remote = true, label = track.id())
        RtcEngine.add(entry)
        return entry
    }

    private fun senderInfo(sender: RtpSender): SenderInfo {
        val track = sender.track()
        val trackId = track?.let { RtcEngine.trackId(it) ?: received[it.id()] }
        return SenderInfo(idOf(sender), trackId)
    }

    private fun transceiverInfo(t: RtpTransceiver): TransceiverInfo {
        val receiverTrack = t.receiver.track()?.let { receivedTrack(it).info }
            ?: TrackInfo(id = "", kind = if (t.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO) MediaKind.VIDEO else MediaKind.AUDIO, label = "", enabled = false)
        return TransceiverInfo(
            id = idOf(t), mid = t.mid, direction = direction(t.direction), currentDirection = t.currentDirection?.let { direction(it) },
            sender = senderInfo(t.sender), receiverTrack = receiverTrack, stopped = t.isStopped,
        )
    }

    private fun direction(d: RtpTransceiver.RtpTransceiverDirection): TransceiverDirection = when (d) {
        RtpTransceiver.RtpTransceiverDirection.SEND_RECV -> TransceiverDirection.SENDRECV
        RtpTransceiver.RtpTransceiverDirection.SEND_ONLY -> TransceiverDirection.SENDONLY
        RtpTransceiver.RtpTransceiverDirection.RECV_ONLY -> TransceiverDirection.RECVONLY
        RtpTransceiver.RtpTransceiverDirection.INACTIVE -> TransceiverDirection.INACTIVE
        RtpTransceiver.RtpTransceiverDirection.STOPPED -> TransceiverDirection.STOPPED
    }

    private fun direction(d: TransceiverDirection): RtpTransceiver.RtpTransceiverDirection = when (d) {
        TransceiverDirection.SENDRECV -> RtpTransceiver.RtpTransceiverDirection.SEND_RECV
        TransceiverDirection.SENDONLY -> RtpTransceiver.RtpTransceiverDirection.SEND_ONLY
        TransceiverDirection.RECVONLY -> RtpTransceiver.RtpTransceiverDirection.RECV_ONLY
        TransceiverDirection.INACTIVE -> RtpTransceiver.RtpTransceiverDirection.INACTIVE
        TransceiverDirection.STOPPED -> RtpTransceiver.RtpTransceiverDirection.STOPPED
    }

    private fun sdp(d: SessionDescription) = RtcSessionDescription(
        when (d.type) {
            SdpType.OFFER -> RtcSessionDescription.Type.OFFER
            SdpType.ANSWER -> RtcSessionDescription.Type.ANSWER
            SdpType.PRANSWER -> RtcSessionDescription.Type.PRANSWER
            SdpType.ROLLBACK -> RtcSessionDescription.Type.ROLLBACK
        }, d.sdp,
    )

    private fun description(d: RtcSessionDescription) = SessionDescription(
        when (d.type) {
            RtcSessionDescription.Type.OFFER -> SdpType.OFFER
            RtcSessionDescription.Type.ANSWER -> SdpType.ANSWER
            RtcSessionDescription.Type.PRANSWER -> SdpType.PRANSWER
            RtcSessionDescription.Type.ROLLBACK -> SdpType.ROLLBACK
            else -> SdpType.OFFER
        }, d.description,
    )

    private fun <V> open(reply: Reply<V, RtcPeerConnectionCode>): Boolean {
        if (closed.get()) reply.reject(RtcPeerConnectionCode.CLOSED)
        return !closed.get()
    }

    /** An SdpObserver of one call: `onCreate` for the created description, `onSet` for a set. */
    private fun sdpObserver(onCreate: ((RtcSessionDescription) -> Unit)? = null, onSet: (() -> Unit)? = null, onFail: () -> Unit) = object : SdpObserver {
        override fun onCreateSuccess(sdp: RtcSessionDescription) { onCreate?.invoke(sdp) }
        override fun onSetSuccess() { onSet?.invoke() }
        override fun onCreateFailure(error: String?) = onFail()
        override fun onSetFailure(error: String?) = onFail()
    }

    // ── negotiation ──────────────────────────────────────────────────────────

    override fun createOffer(options: OfferOptions?, reply: Reply<SessionDescription, RtcPeerConnectionCode>) {
        if (!open(reply)) return
        val constraints = RtcMediaConstraints().apply {
            options?.offerToReceiveAudio?.let { mandatory.add(RtcMediaConstraints.KeyValuePair("OfferToReceiveAudio", it.toString())) }
            options?.offerToReceiveVideo?.let { mandatory.add(RtcMediaConstraints.KeyValuePair("OfferToReceiveVideo", it.toString())) }
            if (options?.iceRestart == true) mandatory.add(RtcMediaConstraints.KeyValuePair("IceRestart", "true"))
        }
        pc.createOffer(sdpObserver(onCreate = { reply.resolve(description(it)) }, onFail = { reply.reject(RtcPeerConnectionCode.FAILED) }), constraints)
    }

    override fun createAnswer(reply: Reply<SessionDescription, RtcPeerConnectionCode>) {
        if (!open(reply)) return
        pc.createAnswer(sdpObserver(onCreate = { reply.resolve(description(it)) }, onFail = { reply.reject(RtcPeerConnectionCode.FAILED) }), RtcMediaConstraints())
    }

    override fun setLocalDescription(description: SessionDescription?, reply: Reply<SessionDescription, RtcPeerConnectionCode>) {
        if (!open(reply)) return
        val observer = sdpObserver(
            onSet = { pc.localDescription?.let { reply.resolve(description(it)) } ?: reply.reject(RtcPeerConnectionCode.FAILED) },
            onFail = { reply.reject(RtcPeerConnectionCode.FAILED) },
        )
        if (description != null) pc.setLocalDescription(observer, sdp(description)) else pc.setLocalDescription(observer)
    }

    override fun setRemoteDescription(description: SessionDescription, reply: Reply<Unit, RtcPeerConnectionCode>) {
        if (!open(reply)) return
        pc.setRemoteDescription(sdpObserver(onSet = { reply.resolve() }, onFail = { reply.reject(RtcPeerConnectionCode.FAILED) }), sdp(description))
    }

    override fun addIceCandidate(candidate: IceCandidate?, reply: Reply<Unit, RtcPeerConnectionCode>) {
        if (!open(reply)) return
        if (candidate == null || candidate.candidate.isEmpty()) return reply.resolve()   // the end of the remote candidates
        val ice = RtcIceCandidate(candidate.sdpMid, candidate.sdpMLineIndex ?: 0, candidate.candidate)
        pc.addIceCandidate(ice, object : AddIceObserver {
            override fun onAddSuccess() = reply.resolve()
            override fun onAddFailure(error: String?) = reply.reject(RtcPeerConnectionCode.FAILED)
        })
    }

    override fun restartIce(reply: Reply<Unit, RtcPeerConnectionCode>) {
        pc.restartIce()
        reply.resolve()
    }

    override fun setConfiguration(configuration: RtcConfiguration, reply: Reply<Unit, RtcPeerConnectionCode>) {
        if (pc.setConfiguration(rtcConfiguration(configuration))) reply.resolve() else reply.reject(RtcPeerConnectionCode.FAILED)
    }

    // ── the tracks ───────────────────────────────────────────────────────────

    override fun addTrack(trackId: String, streamIds: List<String>?, reply: Reply<SenderInfo, RtcPeerConnectionCode>) {
        if (!open(reply)) return
        val track = RtcEngine.track(trackId) ?: return reply.reject(RtcPeerConnectionCode.NOT_FOUND)
        val ids = if (streamIds.isNullOrEmpty()) listOf(RtcEngine.allocate("stream")) else streamIds
        val sender = try { pc.addTrack(track.track, ids) } catch (e: Exception) { null } ?: return reply.reject(RtcPeerConnectionCode.FAILED)
        reply.resolve(senderInfo(sender))
    }

    override fun removeTrack(senderId: String, reply: Reply<Unit, RtcPeerConnectionCode>) {
        if (!open(reply)) return
        val sender = senders[senderId] ?: return reply.reject(RtcPeerConnectionCode.NOT_FOUND)
        pc.removeTrack(sender)
        reply.resolve()
    }

    override fun replaceTrack(senderId: String, trackId: String?, reply: Reply<Unit, RtcPeerConnectionCode>) {
        if (!open(reply)) return
        val sender = senders[senderId] ?: return reply.reject(RtcPeerConnectionCode.NOT_FOUND)
        val track = if (trackId == null) null else RtcEngine.track(trackId)?.track ?: return reply.reject(RtcPeerConnectionCode.NOT_FOUND)
        if (sender.setTrack(track, false)) reply.resolve() else reply.reject(RtcPeerConnectionCode.FAILED)
    }

    override fun getSenderParameters(senderId: String, reply: Reply<SenderParameters, RtcPeerConnectionCode>) {
        val sender = senders[senderId] ?: return reply.reject(RtcPeerConnectionCode.NOT_FOUND)
        val encodings = sender.parameters.encodings.map { e ->
            Encoding(rid = e.rid, active = e.active, maxBitrate = e.maxBitrateBps, maxFramerate = e.maxFramerate?.toDouble(), scaleResolutionDownBy = e.scaleResolutionDownBy)
        }
        reply.resolve(SenderParameters(encodings))
    }

    override fun setSenderParameters(senderId: String, parameters: SenderParameters, reply: Reply<Unit, RtcPeerConnectionCode>) {
        val sender = senders[senderId] ?: return reply.reject(RtcPeerConnectionCode.NOT_FOUND)
        val current = sender.parameters
        // The encodings are matched by position (by rid when both have one): what the app says wins.
        current.encodings.forEachIndexed { i, encoding ->
            val wanted = parameters.encodings.firstOrNull { it.rid != null && it.rid == encoding.rid } ?: parameters.encodings.getOrNull(i) ?: return@forEachIndexed
            wanted.active?.let { encoding.active = it }
            wanted.maxBitrate?.let { encoding.maxBitrateBps = it }
            wanted.maxFramerate?.let { encoding.maxFramerate = it.toInt() }
            wanted.scaleResolutionDownBy?.let { encoding.scaleResolutionDownBy = it }
        }
        if (sender.setParameters(current)) reply.resolve() else reply.reject(RtcPeerConnectionCode.FAILED)
    }

    override fun addTransceiver(kind: MediaKind, options: TransceiverInit?, reply: Reply<TransceiverInfo, RtcPeerConnectionCode>) {
        if (!open(reply)) return
        val direction = options?.direction?.let { direction(it) } ?: RtpTransceiver.RtpTransceiverDirection.SEND_RECV
        val encodings = (options?.sendEncodings ?: emptyList()).map { e ->
            RtpParameters.Encoding(e.rid, e.active ?: true, e.scaleResolutionDownBy).apply {
                e.maxBitrate?.let { maxBitrateBps = it }
                e.maxFramerate?.let { maxFramerate = it.toInt() }
            }
        }
        val init = RtpTransceiver.RtpTransceiverInit(direction, options?.streamIds ?: emptyList(), encodings)
        val transceiver = try {
            if (options?.trackId != null) {
                val track = RtcEngine.track(options.trackId) ?: return reply.reject(RtcPeerConnectionCode.NOT_FOUND)
                pc.addTransceiver(track.track, init)
            } else {
                pc.addTransceiver(if (kind == MediaKind.VIDEO) MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO else MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO, init)
            }
        } catch (e: Exception) { null } ?: return reply.reject(RtcPeerConnectionCode.FAILED)
        reply.resolve(transceiverInfo(transceiver))
    }

    override fun getTransceivers(reply: Reply<List<TransceiverInfo>, RtcPeerConnectionCode>) {
        reply.resolve(pc.transceivers.map { transceiverInfo(it) })
    }

    override fun setTransceiverDirection(transceiverId: String, direction: TransceiverDirection, reply: Reply<Unit, RtcPeerConnectionCode>) {
        val transceiver = transceivers[transceiverId] ?: return reply.reject(RtcPeerConnectionCode.NOT_FOUND)
        try {
            transceiver.direction = direction(direction)
            reply.resolve()
        } catch (e: Exception) {
            reply.reject(RtcPeerConnectionCode.FAILED)
        }
    }

    override fun stopTransceiver(transceiverId: String, reply: Reply<Unit, RtcPeerConnectionCode>) {
        val transceiver = transceivers[transceiverId] ?: return reply.reject(RtcPeerConnectionCode.NOT_FOUND)
        transceiver.stopStandard()
        reply.resolve()
    }

    // ── stats ────────────────────────────────────────────────────────────────

    override fun getStats(trackId: String?, reply: Reply<Any, RtcPeerConnectionCode>) {
        val done = { report: RTCStatsReport ->
            val out = HashMap<String, Any>()
            for ((id, stats) in report.statsMap) {
                val entry = HashMap<String, Any?>()
                entry["id"] = stats.id
                entry["type"] = stats.type
                entry["timestamp"] = stats.timestampUs / 1000.0
                for ((key, value) in stats.members) entry[key] = statsValue(value)
                out[id] = entry
            }
            reply.resolve(out)
        }
        val track = trackId?.let { RtcEngine.track(it) }
        if (track == null) return pc.getStats(done)
        val sender = pc.senders.firstOrNull { it.track()?.id() == track.track.id() }
        if (sender != null) return pc.getStats(sender, done)
        val receiver = pc.receivers.firstOrNull { it.track()?.id() == track.track.id() }
        if (receiver != null) return pc.getStats(receiver, done)
        pc.getStats(done)
    }

    /** A stats member as the wire carries it: libwebrtc's BigInteger, Long, arrays and maps become numbers, lists and maps. */
    private fun statsValue(v: Any?): Any? = when (v) {
        null -> null
        is BigInteger -> v.toDouble()
        is Long -> v.toDouble()
        is Array<*> -> v.map { statsValue(it) }
        is Map<*, *> -> v.entries.associate { (k, item) -> k.toString() to statsValue(item) }
        else -> v
    }

    // ── data channels ────────────────────────────────────────────────────────

    override fun createDataChannel(label: String, options: DataChannelInit?, reply: Reply<DataChannelInfo, RtcPeerConnectionCode>) {
        if (!open(reply)) return
        val init = DataChannel.Init().apply {
            options?.ordered?.let { ordered = it }
            options?.maxPacketLifeTime?.let { maxRetransmitTimeMs = it }
            options?.maxRetransmits?.let { maxRetransmits = it }
            options?.protocol?.let { protocol = it }
            options?.negotiated?.let { negotiated = it }
            options?.id?.let { id = it }
        }
        val channel = pc.createDataChannel(label, init) ?: return reply.reject(RtcPeerConnectionCode.FAILED)
        val handle = watch(channel, init.ordered, options?.maxPacketLifeTime, options?.maxRetransmits, init.protocol, init.negotiated)
        reply.resolve(handle.info)
    }

    private fun watch(channel: DataChannel, ordered: Boolean, maxPacketLifeTime: Int?, maxRetransmits: Int?, protocol: String, negotiated: Boolean): RtcDataChannel {
        val id = RtcEngine.allocate("channel")
        val handle = RtcDataChannel(id, channel, ordered, maxPacketLifeTime, maxRetransmits, protocol, negotiated, events) { channels.remove(id) }
        channels[id] = handle
        return handle
    }

    override fun sendText(channelId: String, text: String, reply: Reply<Unit, RtcPeerConnectionCode>) {
        val handle = channels[channelId] ?: return reply.reject(RtcPeerConnectionCode.NOT_FOUND)
        if (handle.channel.state() != DataChannel.State.OPEN || !handle.channel.send(DataChannel.Buffer(ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8)), false))) {
            return reply.reject(RtcPeerConnectionCode.CLOSED)
        }
        reply.resolve()
    }

    override fun sendBinary(channelId: String, data: ByteArray, reply: Reply<Unit, RtcPeerConnectionCode>) {
        val handle = channels[channelId] ?: return reply.reject(RtcPeerConnectionCode.NOT_FOUND)
        if (handle.channel.state() != DataChannel.State.OPEN || !handle.channel.send(DataChannel.Buffer(ByteBuffer.wrap(data), true))) {
            return reply.reject(RtcPeerConnectionCode.CLOSED)
        }
        reply.resolve()
    }

    override fun getBufferedAmount(channelId: String, reply: Reply<Double, RtcPeerConnectionCode>) {
        val handle = channels[channelId] ?: return reply.reject(RtcPeerConnectionCode.NOT_FOUND)
        reply.resolve(handle.channel.bufferedAmount().toDouble())
    }

    override fun setBufferedAmountLowThreshold(channelId: String, threshold: Double, reply: Reply<Unit, RtcPeerConnectionCode>) {
        val handle = channels[channelId] ?: return reply.reject(RtcPeerConnectionCode.NOT_FOUND)
        handle.threshold = threshold.toLong().coerceAtLeast(0)
        reply.resolve()
    }

    override fun closeDataChannel(channelId: String, reply: Reply<Unit, RtcPeerConnectionCode>) {
        channels[channelId]?.channel?.close()
        reply.resolve()
    }

    // ── PeerConnection.Observer (libwebrtc's threads) ────────────────────────

    private val observer = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) {
            events.signalingStateChange(when (state) {
                PeerConnection.SignalingState.STABLE -> SignalingState.STABLE
                PeerConnection.SignalingState.HAVE_LOCAL_OFFER -> SignalingState.HAVE_LOCAL_OFFER
                PeerConnection.SignalingState.HAVE_LOCAL_PRANSWER -> SignalingState.HAVE_LOCAL_PRANSWER
                PeerConnection.SignalingState.HAVE_REMOTE_OFFER -> SignalingState.HAVE_REMOTE_OFFER
                PeerConnection.SignalingState.HAVE_REMOTE_PRANSWER -> SignalingState.HAVE_REMOTE_PRANSWER
                PeerConnection.SignalingState.CLOSED -> SignalingState.CLOSED
            })
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            events.iceConnectionStateChange(when (state) {
                PeerConnection.IceConnectionState.NEW -> IceConnectionState.NEW
                PeerConnection.IceConnectionState.CHECKING -> IceConnectionState.CHECKING
                PeerConnection.IceConnectionState.CONNECTED -> IceConnectionState.CONNECTED
                PeerConnection.IceConnectionState.COMPLETED -> IceConnectionState.COMPLETED
                PeerConnection.IceConnectionState.FAILED -> IceConnectionState.FAILED
                PeerConnection.IceConnectionState.DISCONNECTED -> IceConnectionState.DISCONNECTED
                PeerConnection.IceConnectionState.CLOSED -> IceConnectionState.CLOSED
            })
        }

        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            events.connectionStateChange(when (state) {
                PeerConnection.PeerConnectionState.NEW -> PeerConnectionState.NEW
                PeerConnection.PeerConnectionState.CONNECTING -> PeerConnectionState.CONNECTING
                PeerConnection.PeerConnectionState.CONNECTED -> PeerConnectionState.CONNECTED
                PeerConnection.PeerConnectionState.DISCONNECTED -> PeerConnectionState.DISCONNECTED
                PeerConnection.PeerConnectionState.FAILED -> PeerConnectionState.FAILED
                PeerConnection.PeerConnectionState.CLOSED -> PeerConnectionState.CLOSED
            })
        }

        override fun onIceConnectionReceivingChange(receiving: Boolean) {}

        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
            val mapped = when (state) {
                PeerConnection.IceGatheringState.NEW -> IceGatheringState.NEW
                PeerConnection.IceGatheringState.GATHERING -> IceGatheringState.GATHERING
                PeerConnection.IceGatheringState.COMPLETE -> IceGatheringState.COMPLETE
            }
            events.iceGatheringStateChange(mapped)
            if (mapped == IceGatheringState.COMPLETE) events.iceCandidate(null)
        }

        override fun onIceCandidate(candidate: RtcIceCandidate) {
            events.iceCandidate(IceCandidate(candidate.sdp, candidate.sdpMid, candidate.sdpMLineIndex))
        }

        override fun onIceCandidatesRemoved(candidates: Array<out RtcIceCandidate>?) {}
        override fun onAddStream(stream: MediaStream?) {}
        override fun onRemoveStream(stream: MediaStream?) {}

        override fun onDataChannel(channel: DataChannel) {
            val handle = watch(channel, ordered = true, maxPacketLifeTime = null, maxRetransmits = null, protocol = "", negotiated = false)
            events.dataChannel(handle.info)
        }

        override fun onRenegotiationNeeded() = events.negotiationNeeded()

        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
            val track = receiver.track() ?: return
            val entry = receivedTrack(track)
            val transceiver = pc.transceivers.firstOrNull { it.receiver.id() == receiver.id() }
            events.track(entry.info, streams.map { it.id }, transceiver?.let { idOf(it) } ?: "")
        }

        override fun onRemoveTrack(receiver: RtpReceiver) {
            val track = receiver.track() ?: return
            val id = received.remove(track.id()) ?: return
            RtcEngine.remove(id)
            events.trackEnded(id)
        }
    }

    // The observer is declared above so that it exists when the connection is made (Kotlin
    // initialises in textual order).
    init {
        pc = RtcEngine.factory(context).createPeerConnection(rtcConfiguration(configuration), observer)
            ?: throw IllegalStateException("libwebrtc made no peer connection")
    }
}

/** One data channel of a session: its observer turned into the contract's events. */
class RtcDataChannel(
    val id: String,
    val channel: DataChannel,
    private val ordered: Boolean,
    private val maxPacketLifeTime: Int?,
    private val maxRetransmits: Int?,
    private val protocol: String,
    private val negotiated: Boolean,
    private val events: RtcPeerConnectionEvents,
    private val onClosed: () -> Unit,
) {
    @Volatile var threshold = 0L
    private var lastAmount = 0L

    init {
        channel.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {
                // libwebrtc reports the change; the browser's event fires when the amount falls to the threshold.
                val now = channel.bufferedAmount()
                if (lastAmount > threshold && now <= threshold) events.dataChannelBufferedAmountLow(id)
                lastAmount = now
            }
            override fun onStateChange() {
                val state = state()
                events.dataChannelStateChange(id, state)
                if (state == DataChannelState.CLOSED) { onClosed(); channel.unregisterObserver(); channel.dispose() }
            }
            override fun onMessage(buffer: DataChannel.Buffer) {
                val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
                if (buffer.binary) events.dataChannelMessage(id, binary = bytes)
                else events.dataChannelMessage(id, text = String(bytes, Charsets.UTF_8))
            }
        })
    }

    private fun state(): DataChannelState = when (channel.state()) {
        DataChannel.State.CONNECTING -> DataChannelState.CONNECTING
        DataChannel.State.OPEN -> DataChannelState.OPEN
        DataChannel.State.CLOSING -> DataChannelState.CLOSING
        DataChannel.State.CLOSED -> DataChannelState.CLOSED
    }

    val info: DataChannelInfo
        get() = DataChannelInfo(
            id = id, label = channel.label(), ordered = ordered, maxPacketLifeTime = maxPacketLifeTime, maxRetransmits = maxRetransmits,
            protocol = protocol, negotiated = negotiated, streamId = channel.id().takeIf { it >= 0 }, readyState = state(),
        )
}
