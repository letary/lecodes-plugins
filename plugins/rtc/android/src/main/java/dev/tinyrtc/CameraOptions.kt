package dev.tinyrtc

enum class Facing { USER, ENVIRONMENT }

/**
 * What [RtcEngine.openCamera] / [LocalVideoTrack.apply] ask for. The half picks the closest format
 * the camera has. `width` × `height` is the picture as the sensor gives it (landscape, long side
 * first); 720 × 1280 means the same as 1280 × 720 — rotation is sent, not baked in.
 */
data class CameraOptions(
    val deviceId: String? = null,
    val facing: Facing = Facing.USER,
    val width: Int = 1280,
    val height: Int = 720,
    val frameRate: Int = 30,
)

/** What the camera actually runs at. */
data class VideoSettings(
    val deviceId: String,
    val facing: Facing,
    val width: Int,
    val height: Int,
    val frameRate: Int,
)

/** A device [RtcEngine.devices] lists. */
data class RtcDevice(
    val id: String,
    val kind: Kind,
    val label: String,
    /** Cameras only. */
    val facing: Facing? = null,
) {
    enum class Kind { CAMERA, MICROPHONE, AUDIO_OUTPUT }
}
