package dev.tinyrtc

/**
 * The one error type of the half. The core's status codes map onto these cases and never surface
 * as numbers.
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
