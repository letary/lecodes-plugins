package dev.tinyrtc

/**
 * The one error type of the half. The core's status codes map onto these cases and never surface
 * as numbers; an argument the API does not take (a precondition the app broke) is [Failed] too.
 * Calling off the main thread is not an RtcError: it is a bug of the caller (IllegalStateException).
 */
sealed class RtcError(message: String) : Exception(message) {
    /** A permission is missing (asking for it is the app's business). */
    class Denied(message: String = "permission denied") : RtcError(message)

    /** No such device, track or channel. */
    class NotFound(message: String = "not found") : RtcError(message)

    class Failed(message: String) : RtcError(message)

    /** The object was closed / stopped. */
    class Closed(message: String = "closed") : RtcError(message)
}

/** The same case, told otherwise. */
internal fun RtcError.withMessage(message: String): RtcError = when (this) {
    is RtcError.Denied -> RtcError.Denied(message)
    is RtcError.NotFound -> RtcError.NotFound(message)
    is RtcError.Failed -> RtcError.Failed(message)
    is RtcError.Closed -> RtcError.Closed(message)
}
