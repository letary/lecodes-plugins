//
//  RtcTracks.kt — lecodes-plugins/rtc
//
//  The tracks by the id the wire names them with: what crosses is a string the host allocated, the
//  object behind it is tinyrtc's. Two owners put ids here:
//   - the "rtcMedia" session: "audioN" / "videoN", one per track getUserMedia opened, forgotten when
//     stopTrack ends it, when the OS ended it (trackEnded) or when the session closes;
//   - an "rtcConnection" session: "rN.audio" / "rN.video", the two tracks the connection receives,
//     registered when its tinyrtc connection is made and forgotten when the session closes.
//  Every service looks an id up here; an unknown id, or one of the wrong kind or side, is `notFound`
//  to the caller. A picture (RtcPicture) watches the registry: the id it shows forgotten, it goes
//  black.
//
//  Main thread only: the calls arrive there and tinyrtc delivers its events there.
//

package io.letary.lecodes.plugins.rtc

import dev.tinyrtc.CameraOptions
import dev.tinyrtc.Facing
import dev.tinyrtc.LocalAudioTrack
import dev.tinyrtc.LocalVideoTrack
import dev.tinyrtc.RemoteAudioTrack
import dev.tinyrtc.RemoteVideoTrack
import java.util.Collections
import java.util.WeakHashMap
import dev.tinyrtc.MediaKind as TinyKind
import dev.tinyrtc.VideoTrack as TinyVideoTrack

internal class RtcTracks {

    sealed class Entry(val id: String, val kind: MediaKind)

    /** The microphone, as getUserMedia opened it. */
    class LocalAudio(id: String, val track: LocalAudioTrack, val label: String) : Entry(id, MediaKind.AUDIO)

    /** The camera; [options] are the last ones it was opened or re-aimed with — what applyConstraints
     *  merges a partial constraint set over (tinyrtc's `apply` takes the full set). */
    class LocalVideo(id: String, val track: LocalVideoTrack, val label: String, var options: CameraOptions) : Entry(id, MediaKind.VIDEO)

    class RemoteAudio(id: String, val track: RemoteAudioTrack) : Entry(id, MediaKind.AUDIO)

    class RemoteVideo(id: String, val track: RemoteVideoTrack) : Entry(id, MediaKind.VIDEO)

    /** Told when an id is forgotten. Held weakly: a watcher that is dropped stops being told. */
    interface Watcher {
        fun forgotten(id: String)
    }

    private val entries = HashMap<String, Entry>()
    private val watchers: MutableSet<Watcher> = Collections.newSetFromMap(WeakHashMap())
    private var audioCount = 0
    private var videoCount = 0
    private var connectionCount = 0

    /** A new id for a local track: "audio1", "video1", "audio2", ... */
    fun localId(kind: MediaKind): String = when (kind) {
        MediaKind.AUDIO -> "audio${++audioCount}"
        MediaKind.VIDEO -> "video${++videoCount}"
    }

    /** A new connection's prefix: "r1", "r2", ... — its tracks are "<prefix>.audio" / "<prefix>.video". */
    fun connectionPrefix(): String = "r${++connectionCount}"

    fun add(entry: Entry) {
        entries[entry.id] = entry
    }

    /** The entry goes, and every watcher hears of it; null when the id was not here. */
    fun forget(id: String): Entry? {
        val entry = entries.remove(id) ?: return null
        for (watcher in watchers.toList()) watcher.forgotten(id)
        return entry
    }

    /** A track getUserMedia made; null for an unknown id and for a received track. */
    fun local(id: String): Entry? = entries[id]?.takeIf { it is LocalAudio || it is LocalVideo }

    fun localVideo(id: String): LocalVideo? = entries[id] as? LocalVideo

    /** What a picture can show: a local or a received video track; null for an audio or unknown id. */
    fun video(id: String): TinyVideoTrack? = when (val entry = entries[id]) {
        is LocalVideo -> entry.track
        is RemoteVideo -> entry.track
        else -> null
    }

    fun watch(watcher: Watcher) {
        watchers += watcher
    }

    fun unwatch(watcher: Watcher) {
        watchers -= watcher
    }
}

// ---- the wire's enums <-> tinyrtc's ----

internal fun MediaKind.tiny(): TinyKind = when (this) {
    MediaKind.AUDIO -> TinyKind.AUDIO
    MediaKind.VIDEO -> TinyKind.VIDEO
}

internal fun TinyKind.wire(): MediaKind = when (this) {
    TinyKind.AUDIO -> MediaKind.AUDIO
    TinyKind.VIDEO -> MediaKind.VIDEO
}

internal fun FacingMode.tiny(): Facing = when (this) {
    FacingMode.USER -> Facing.USER
    FacingMode.ENVIRONMENT -> Facing.ENVIRONMENT
}

internal fun Facing.wire(): FacingMode = when (this) {
    Facing.USER -> FacingMode.USER
    Facing.ENVIRONMENT -> FacingMode.ENVIRONMENT
}
