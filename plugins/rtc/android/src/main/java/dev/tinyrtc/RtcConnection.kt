package dev.tinyrtc

import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class RtcConnectionState { NEW, CONNECTING, CONNECTED, DISCONNECTED, FAILED, CLOSED }

data class IceServer(val url: String, val username: String? = null, val credential: String? = null)

data class RtcConfiguration(
    /** "stun:host:port" (anything else is ignored: there is no TURN). */
    val iceServers: List<IceServer> = emptyList(),
    /**
     * Never reveal an address of this device: the only path is a relay's candidate the app adds
     * (`typ relay`: the media server's), whatever else it adds. No candidate of its own is put into
     * a description (an ICE restart's too) or raised as an event; of the other side's candidates —
     * [RtcConnection.addIceCandidate], or inside its description — only `typ relay` ones are taken,
     * and a datagram from any other address is dropped, so the other side never hears from this
     * device's address. Without a relay candidate it never connects; an ICE restart needs a new
     * relay reservation. The STUN servers of [iceServers] still see the address (they are asked).
     */
    val relayOnly: Boolean = false,
)

data class DataChannelOptions(
    val ordered: Boolean = true,
    /** At most one of the two (both: [RtcError.Failed]); both null = reliable. */
    val maxRetransmits: Int? = null,
    val maxPacketLifeTimeMs: Int? = null,
)

/** The numbers of a connection: one fixed set, what a call screen and a bug report need. */
data class RtcStats(
    val state: RtcConnectionState,
    val relayed: Boolean,
    val rttMs: Int,
    val sendEstimateBps: Long,
    val audioSendBps: Long,
    val audioRecvBps: Long,
    val videoSendBps: Long,
    val videoRecvBps: Long,
    /** Received: the share lost, 0..1, over the last seconds. */
    val audioLoss: Float,
    val videoLoss: Float,
    /** The delay the sound is played with. */
    val audioJitterBufferMs: Int,
    val videoRecvFps: Int,
    val videoNacksSent: Long,
    val videoKeyframesRequested: Long,
    val bytesSent: Long,
    val bytesReceived: Long,
)

/**
 * One peer (a core connection). Signaling is the app's: [createOffer] / [acceptOffer] /
 * [acceptAnswer], and the candidates of [onIceCandidate] / [addIceCandidate]. Main thread; the
 * `suspend` calls wait on the core on a worker thread.
 */
class RtcConnection internal constructor(private val engine: RtcEngine, config: RtcConfiguration) {
    private val key = Registry.add(this)

    /** Written on the lane only; 0 before creation and after close. */
    @Volatile
    private var handle = 0L
    @Volatile
    private var createFailed = false

    var state: RtcConnectionState = RtcConnectionState.NEW
        private set
    var isClosed: Boolean = false
        private set

    val remoteAudio = RemoteAudioTrack(this)
    val remoteVideo = RemoteVideoTrack(this)

    var onState: ((RtcConnectionState) -> Unit)? = null
    /** A local candidate found after the description was made: for the other side, through the app's signaling. */
    var onIceCandidate: ((String) -> Unit)? = null
    /** The path is gone: the offering side should [createOffer] with iceRestart = true. */
    var onIceRestartNeeded: (() -> Unit)? = null
    /** The other side started / stopped sending a kind. */
    var onRemoteMedia: ((MediaKind, Boolean) -> Unit)? = null
    /** A channel the other side opened (already open). */
    var onDataChannel: ((RtcDataChannel) -> Unit)? = null

    internal var audioTrack: LocalAudioTrack? = null
        private set
    internal var videoTrack: LocalVideoTrack? = null
        private set
    // what the core was told
    private var toldAudio = false
    private var toldVideo: CameraPipeline? = null
    internal val sendsMicrophone get() = toldAudio

    private val channels = HashMap<Int, RtcDataChannel>()
    /** Own channels being opened: their id is not known until channelOpen returns. */
    private var opening = 0
    private val held = ArrayList<ChannelEvent>()
    /**
     * Channels this side closed, or gave up while opening (a cancelled createDataChannel), until the
     * core says they are closed: what it still says of them is nobody's — and never a channel of the
     * other side (the core's ids are not reused).
     */
    private val closedHere = HashSet<Int>()

    private class ChannelEvent(val type: Int, val id: Int, val b: Int, val bytes: ByteArray?)

    init {
        val urls = config.iceServers.map { it.url.utf8() }.toTypedArray()
        val usernames = config.iceServers.map { it.username?.utf8() }.toTypedArray()
        val credentials = config.iceServers.map { it.credential?.utf8() }.toTypedArray()
        val relayOnly = config.relayOnly
        Core.scope.launch {
            val created = Native.connectionCreate(engine.handle, key, urls, usernames, credentials, relayOnly)
            if (created == 0L) {
                createFailed = true
                Log.e("the core made no connection (no socket?)")
                Core.main.post {
                    if (!isClosed) {
                        state = RtcConnectionState.FAILED
                        onState?.invoke(state)
                    }
                }
            }
            handle = created
        }
    }

    /** The offer (iceRestart = true for the second and later ones). */
    suspend fun createOffer(iceRestart: Boolean = false): String = call("createOffer") { h ->
        val status = IntArray(1)
        val sdp = Native.offer(h, iceRestart, status)
        checkStatus(status[0], "createOffer")
        sdp?.utf8() ?: throw RtcError.Failed("createOffer: no description")
    }

    /** The answering side: takes the offer, returns the answer. */
    suspend fun acceptOffer(sdp: String): String = call("acceptOffer") { h ->
        val status = IntArray(1)
        val answer = Native.acceptOffer(h, sdp.utf8(), status)
        checkStatus(status[0], "acceptOffer")
        answer?.utf8() ?: throw RtcError.Failed("acceptOffer: no description")
    }

    /** The offering side: takes the answer. */
    suspend fun acceptAnswer(sdp: String) = call("acceptAnswer") { h ->
        checkStatus(Native.acceptAnswer(h, sdp.utf8()), "acceptAnswer")
    }

    /**
     * A candidate of the other side (its `candidate:` line), or a relay's (`typ relay`); null = it
     * has no more. Under [RtcConfiguration.relayOnly] a line that is not `typ relay` is ignored.
     */
    fun addIceCandidate(candidate: String?) {
        Core.checkMain("addIceCandidate")
        if (isClosed) throw RtcError.Closed("addIceCandidate: the connection is closed")
        val bytes = candidate?.utf8()
        tell { h ->
            val status = Native.addCandidate(h, bytes)
            if (status != STATUS_OK) Log.w(errorOf(status, "addIceCandidate").message ?: "")
        }
    }

    /**
     * What this connection sends of [kind]: a track, or null for none. Never a renegotiation.
     * [RtcError.Failed] for a track of the other kind.
     */
    fun setTrack(kind: MediaKind, track: LocalTrack?) {
        Core.checkMain("setTrack")
        if (isClosed) throw RtcError.Closed("setTrack: the connection is closed")
        if (track != null && track.kind != kind) {
            throw RtcError.Failed("setTrack: a ${track.kind.name.lowercase()} track given as ${kind.name.lowercase()}")
        }
        if (track != null && track.isStopped) throw RtcError.Closed("setTrack: the track is stopped")
        when (kind) {
            MediaKind.AUDIO -> audioTrack = track as LocalAudioTrack?
            MediaKind.VIDEO -> videoTrack = track as LocalVideoTrack?
        }
        engine.tracksChanged()
    }

    /**
     * A channel of ours, opened in-band: usable once [RtcDataChannel.onOpen] fired.
     * [RtcError.Failed] when both maxRetransmits and maxPacketLifeTimeMs are given. A cancelled
     * caller leaves no channel behind: one the core opened meanwhile is closed again.
     */
    suspend fun createDataChannel(label: String, options: DataChannelOptions = DataChannelOptions()): RtcDataChannel {
        Core.checkMain("createDataChannel")
        if (options.maxRetransmits != null && options.maxPacketLifeTimeMs != null) {
            throw RtcError.Failed("createDataChannel: at most one of maxRetransmits and maxPacketLifeTimeMs")
        }
        if (isClosed) throw RtcError.Closed("createDataChannel: the connection is closed")
        opening++
        try {
            val id = madeOn(Core.lane, make = {
                val h = liveHandle("createDataChannel")
                val result = Native.channelOpen(
                    h, label.utf8(), !options.ordered, options.maxRetransmits ?: -1, options.maxPacketLifeTimeMs ?: -1,
                )
                if (result < 0) throw errorOf(result.toInt(), "createDataChannel")
                result.toInt()
            }, undo = { id ->
                // Nobody waits for it any more (main, before the held events are replayed).
                closedHere += id
                tell { Native.channelClose(it, id) }
            })
            // Closed meanwhile: the core's connection, and the channel with it, are gone.
            if (isClosed) throw RtcError.Closed("createDataChannel: the connection is closed")
            return RtcDataChannel(this, id, label, open = false).also { channels[id] = it }
        } finally {
            opening--
            // Events of unknown channels waited for this: after the caller's code that follows
            // (which sets the channel's listeners) has run.
            if (opening == 0 && held.isNotEmpty()) Core.main.post { replayHeld() }
        }
    }

    suspend fun stats(): RtcStats = call("stats") { h ->
        val v = DoubleArray(16)
        checkStatus(Native.stats(h, v), "stats")
        RtcStats(
            state = stateOf(v[0].toInt()),
            relayed = v[1] != 0.0,
            rttMs = v[2].toInt(),
            sendEstimateBps = v[3].toLong(),
            audioSendBps = v[4].toLong(),
            audioRecvBps = v[5].toLong(),
            videoSendBps = v[6].toLong(),
            videoRecvBps = v[7].toLong(),
            audioLoss = v[8].toFloat(),
            videoLoss = v[9].toFloat(),
            audioJitterBufferMs = v[10].toInt(),
            videoRecvFps = v[11].toInt(),
            videoNacksSent = v[12].toLong(),
            videoKeyframesRequested = v[13].toLong(),
            bytesSent = v[14].toLong(),
            bytesReceived = v[15].toLong(),
        )
    }

    /** Closes (the other side sees it at once). Idempotent; no event of this connection or its channels arrives after it returns. */
    fun close() {
        Core.checkMain("close")
        if (isClosed) return
        isClosed = true
        state = RtcConnectionState.CLOSED
        Registry.remove(key)
        for (channel in channels.values) channel.connectionClosed()
        channels.clear()
        held.clear()
        closedHere.clear()
        audioTrack = null
        videoTrack = null
        toldAudio = false
        toldVideo?.let { it.takers-- }
        toldVideo = null
        engine.tracksChanged()
        Core.scope.launch { destroy() }
    }

    /** Dropped without close(): the same, minus the events nobody can receive. */
    protected fun finalize() {
        if (isClosed) return
        Registry.remove(key)
        Core.scope.launch { destroy() }
        Core.main.post { engine.tracksChanged() }
    }

    // ---- internal ----

    /** The lane. */
    private fun destroy() {
        val h = handle
        handle = 0L
        if (h != 0L) Native.connectionDestroy(h)
    }

    /**
     * A SYNC call of the core, on the lane. A cancelled caller stops waiting; what the call did in
     * the core (an offer made, an answer taken) stays done — the calls that make something to
     * undo use [madeOn] instead.
     */
    internal suspend fun <T> call(what: String, block: (Long) -> T): T {
        Core.checkMain(what)
        if (isClosed) throw RtcError.Closed("$what: the connection is closed")
        return withContext(Core.lane) { block(liveHandle(what)) }
    }

    /** The lane: the core's connection, or why there is none. */
    private fun liveHandle(what: String): Long {
        val h = handle
        if (h == 0L) {
            throw if (createFailed) RtcError.Failed("$what: the connection could not be created")
            else RtcError.Closed("$what: the connection is closed")
        }
        return h
    }

    /** A call that does not wait, in order with every other, on the lane. Any thread. */
    internal fun tell(block: (Long) -> Unit) {
        Core.scope.launch {
            val h = handle
            if (h != 0L) block(h)
        }
    }

    /** Main: tells the core what this connection sends now. */
    internal fun syncSends() {
        if (isClosed) return
        val audio = audioTrack?.let { it.isEnabled && !it.isStopped } == true
        if (audio != toldAudio) {
            toldAudio = audio
            tell { Native.sendAudio(it, audio) }
        }
        val video = videoTrack?.takeIf { it.isEnabled && !it.isStopped }?.pipe
        if (video !== toldVideo) {
            toldVideo?.let { it.takers-- }
            video?.let { it.takers++ }
            toldVideo = video
            // The source is destroyed on the lane only after every connection was told to let it go.
            tell { h -> Native.sendVideo(h, video?.source ?: 0L) }
        }
    }

    /** A core thread: copy is done; video goes to the views' decoders, the rest to main. */
    internal fun onCoreEvent(type: Int, a: Int, b: Int, c: Long, bytes: ByteArray?) {
        if (type == Native.EVENT_VIDEO_FRAME) {
            if (bytes != null) remoteVideo.onFrame(bytes, a and 0x10000 != 0, a and 0xffff, c)
            return
        }
        Core.main.post { if (!isClosed) onEvent(type, a, b, bytes) }
    }

    private fun onEvent(type: Int, a: Int, b: Int, bytes: ByteArray?) {
        when (type) {
            Native.EVENT_STATE -> {
                val next = stateOf(a)
                if (next != state) {
                    state = next
                    onState?.invoke(next)
                }
            }
            Native.EVENT_LOCAL_CANDIDATE -> bytes?.let { onIceCandidate?.invoke(it.utf8()) }
            Native.EVENT_ICE_RESTART_NEEDED -> onIceRestartNeeded?.invoke()
            Native.EVENT_REMOTE_MEDIA -> {
                val kind = if (a == 0) MediaKind.AUDIO else MediaKind.VIDEO
                val active = b != 0
                if (kind == MediaKind.AUDIO) remoteAudio.isActive = active else remoteVideo.isActive = active
                onRemoteMedia?.invoke(kind, active)
            }
            Native.EVENT_CHANNEL_OPEN, Native.EVENT_CHANNEL_MESSAGE,
            Native.EVENT_CHANNEL_BUFFERED_LOW, Native.EVENT_CHANNEL_CLOSED -> {
                val event = ChannelEvent(type, a, b, bytes)
                // An id not known yet may be one of ours whose open has not returned: wait for it,
                // and keep the order behind what already waits.
                if (held.isNotEmpty() || (opening > 0 && channels[a] == null)) held += event else deliver(event)
            }
        }
    }

    private fun replayHeld() {
        if (opening > 0 || isClosed) return
        val events = held.toList()
        held.clear()
        events.forEach(::deliver)
    }

    private fun deliver(event: ChannelEvent) {
        if (event.id in closedHere) {
            if (event.type == Native.EVENT_CHANNEL_CLOSED) closedHere -= event.id
            return
        }
        val channel = channels[event.id]
        when (event.type) {
            Native.EVENT_CHANNEL_OPEN -> {
                if (channel != null) {
                    channel.opened()
                } else {
                    val remote = RtcDataChannel(this, event.id, event.bytes?.utf8() ?: "", open = true)
                    channels[event.id] = remote
                    onDataChannel?.invoke(remote)
                }
            }
            Native.EVENT_CHANNEL_MESSAGE -> channel?.received(event.bytes ?: ByteArray(0), event.b != 0)
            Native.EVENT_CHANNEL_BUFFERED_LOW -> channel?.bufferedLow()
            Native.EVENT_CHANNEL_CLOSED -> {
                channels.remove(event.id)
                channel?.closedByPeer()
            }
        }
    }

    internal fun channelClosedLocally(id: Int) {
        channels.remove(id)
        closedHere += id
    }

    private fun stateOf(value: Int) = RtcConnectionState.entries.getOrElse(value) { RtcConnectionState.FAILED }
}
