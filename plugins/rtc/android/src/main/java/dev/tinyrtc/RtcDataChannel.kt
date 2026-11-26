package dev.tinyrtc

/**
 * One data channel of a connection, opened in-band (no renegotiation). Main thread; events
 * arrive there.
 */
class RtcDataChannel internal constructor(
    private val connection: RtcConnection,
    internal val id: Int,
    val label: String,
    open: Boolean,
) {
    enum class State { CONNECTING, OPEN, CLOSED }

    class Message(val data: ByteArray, val isBinary: Boolean) {
        val text: String get() = data.utf8()
    }

    var state: State = if (open) State.OPEN else State.CONNECTING
        private set

    var onOpen: (() -> Unit)? = null
    var onMessage: ((Message) -> Unit)? = null
    var onBufferedAmountLow: (() -> Unit)? = null
    /** The other side closed it (or the connection went). Not after [close]. */
    var onClose: (() -> Unit)? = null

    /** onBufferedAmountLow fires when the queue drains to this many bytes. [RtcError.Failed] for a negative one. */
    var bufferedAmountLowThreshold: Long = 0
        set(value) {
            Core.checkMain("bufferedAmountLowThreshold")
            if (value < 0) throw RtcError.Failed("bufferedAmountLowThreshold: $value bytes: it cannot be negative")
            field = value
            if (state != State.CLOSED) connection.tell { Native.channelSetBufferedLow(it, id, value) }
        }

    fun send(text: String) = send(text.utf8(), binary = false)

    fun send(bytes: ByteArray) = send(bytes.copyOf(), binary = true)

    /** Bytes queued and not yet sent. */
    suspend fun bufferedAmount(): Long {
        if (state == State.CLOSED) return 0
        return connection.call("bufferedAmount") { h ->
            val result = Native.channelBuffered(h, id)
            if (result < 0) throw errorOf(result.toInt(), "bufferedAmount")
            result
        }
    }

    /** Idempotent; no event of the channel arrives after it returns. */
    fun close() {
        Core.checkMain("close")
        if (state == State.CLOSED) return
        state = State.CLOSED
        connection.channelClosedLocally(id)
        connection.tell { Native.channelClose(it, id) }
    }

    /**
     * Queued at once; the core takes it on the lane (tinyrtc_channel_send waits for the
     * connection's thread, so it is never called on the main thread).
     */
    private fun send(data: ByteArray, binary: Boolean) {
        Core.checkMain("send")
        when (state) {
            State.CONNECTING -> throw RtcError.Failed("send: the channel $label is not open yet")
            State.CLOSED -> throw RtcError.Closed("send: the channel $label is closed")
            State.OPEN -> {}
        }
        connection.tell { h ->
            val status = Native.channelSend(h, id, data, binary)
            if (status != STATUS_OK) Log.w("channel $label: ${errorOf(status, "send").message}")
        }
    }

    // ---- from the connection (main) ----

    internal fun opened() {
        if (state != State.CONNECTING) return
        state = State.OPEN
        onOpen?.invoke()
    }

    internal fun received(data: ByteArray, binary: Boolean) {
        if (state != State.CLOSED) onMessage?.invoke(Message(data, binary))
    }

    internal fun bufferedLow() {
        if (state != State.CLOSED) onBufferedAmountLow?.invoke()
    }

    internal fun closedByPeer() {
        if (state == State.CLOSED) return
        state = State.CLOSED
        onClose?.invoke()
    }

    /** The app closed the connection: closed, without an event. */
    internal fun connectionClosed() {
        state = State.CLOSED
    }
}
