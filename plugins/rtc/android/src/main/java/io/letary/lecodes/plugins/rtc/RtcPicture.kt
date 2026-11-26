//
//  RtcPicture.kt — lecodes-plugins/rtc
//
//  The ONE picture class behind both surfaces of the contract's RtcVideoMethods: a black container
//  the host sizes, holding one tinyrtc RtcVideoView (a TextureView per track shown, the rotation,
//  the fit and the mirror carried by its transform; a received track decoded by that view's own
//  hardware decoder, a local one shown as the camera's preview). Two thin instances wrap it:
//   - the VIEW "rtcVideo" (RtcVideoViewInstance): the fullscreen picture the app pushes or opens;
//     its params are read at creation, the calls change them after;
//   - the HOST NODE "rtcVideo" (RtcVideoNodeInstance): the picture as a box of a screen's layout,
//     laid out and painted by the core's holder (UINodeHost); its props `trackId`, `objectFit`,
//     `mirror` are LIVE, each write doing what the method of its name does.
//
//  A track is named by its registry id (RtcTracks): a local camera's or a connection's received
//  video. An audio id or an unknown one draws black — the method rejects with `notFound`, a prop
//  logs it once. When the id shown is forgotten (the track stopped, its connection closed), the
//  picture goes black by itself. `resize` is tinyrtc's onResize: the picture's upright size, first
//  when its geometry is known, then on every change.
//

package io.letary.lecodes.plugins.rtc

import android.content.Context
import android.graphics.Color
import android.util.Log
import android.view.View
import android.widget.FrameLayout
import io.letary.lecodes.services.PluginCode
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
import dev.tinyrtc.RtcVideoView as TinyVideoView

internal class RtcPicture(
    context: Context,
    private val tracks: RtcTracks,
    /** The surface's `resize` event. */
    resize: (width: Int, height: Int) -> Unit,
) : RtcTracks.Watcher {

    val container: FrameLayout = FrameLayout(context).apply { setBackgroundColor(Color.BLACK) }
    private val video = TinyVideoView(context)
    private var shown: String? = null

    init {
        video.onResize = resize
        container.addView(video, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        tracks.watch(this)
    }

    /** Draw [trackId]; null = black. False (and black) when no video track has that id. */
    fun show(trackId: String?): Boolean {
        val track = trackId?.let { tracks.video(it) }
        shown = if (track != null) trackId else null
        video.track = track
        return trackId == null || track != null
    }

    fun applyFit(fit: ObjectFit) {
        video.objectFit = when (fit) {
            ObjectFit.COVER -> TinyVideoView.ObjectFit.COVER
            ObjectFit.CONTAIN -> TinyVideoView.ObjectFit.CONTAIN
        }
    }

    fun applyMirror(mirror: Boolean) {
        video.mirror = mirror
    }

    override fun forgotten(id: String) {
        if (id == shown) show(null)
    }

    /** The surface goes: the view lets go of its track (a decoder, or the camera's preview output). */
    fun destroy() {
        tracks.unwatch(this)
        video.onResize = null
        show(null)
    }

    // ---- RtcVideoMethods, generic over the surface's code -------------------------------------

    fun <C : PluginCode> setTrack(trackId: String?, reply: Reply<Unit, C>, notFound: C) {
        if (show(trackId)) reply.resolve() else reply.reject(notFound)
    }

    fun <C : PluginCode> setObjectFit(fit: ObjectFit, reply: Reply<Unit, C>) {
        applyFit(fit)
        reply.resolve()
    }

    fun <C : PluginCode> setMirror(mirror: Boolean, reply: Reply<Unit, C>) {
        applyMirror(mirror)
        reply.resolve()
    }
}

// ---- the View ---------------------------------------------------------------------------------

/** The view "rtcVideo": a picture made from the View's params. */
internal class RtcVideoViewInstance(shared: RtcShared, params: RtcVideoParams, events: RtcVideoEvents) : RtcVideoPlugin {
    private val picture = RtcPicture(shared.context, shared.tracks, events::resize)

    init {
        picture.applyFit(params.objectFit ?: ObjectFit.COVER)
        picture.applyMirror(params.mirror ?: false)
        if (!picture.show(params.trackId)) Log.w(TAG, "RTCVideoView: no video track \"${params.trackId}\" — the view shows black")
    }

    override val view: View get() = picture.container

    override fun setTrack(trackId: String?, reply: Reply<Unit, RtcVideoCode>) = picture.setTrack(trackId, reply, RtcVideoCode.NOT_FOUND)
    override fun setObjectFit(fit: ObjectFit, reply: Reply<Unit, RtcVideoCode>) = picture.setObjectFit(fit, reply)
    override fun setMirror(mirror: Boolean, reply: Reply<Unit, RtcVideoCode>) = picture.setMirror(mirror, reply)

    override fun destroy() = picture.destroy()
}

// ---- the host node ----------------------------------------------------------------------------

/** The host node "rtcVideo": a picture as the node's box, its props applied as they come. */
internal class RtcVideoNodeInstance(shared: RtcShared, events: UIRTCVideoNodeEvents) : UIRTCVideoNodeInstance {
    private val picture = RtcPicture(shared.context, shared.tracks, events::resize)

    /** The ids a `trackId` prop named that no video track had — logged once each. */
    private val missing = HashSet<String>()

    override val view: View get() = picture.container

    override fun setTrackId(value: String?) {
        if (!picture.show(value) && value != null && missing.add(value)) {
            Log.w(TAG, "UIRTCVideoNode: no video track \"$value\" — the node shows black")
        }
    }

    override fun setObjectFit(value: ObjectFit?) = picture.applyFit(value ?: ObjectFit.COVER)
    override fun setMirror(value: Boolean?) = picture.applyMirror(value ?: false)

    override fun setTrack(trackId: String?, reply: Reply<Unit, UIRTCVideoNodeCode>) = picture.setTrack(trackId, reply, UIRTCVideoNodeCode.NOT_FOUND)
    override fun setObjectFit(fit: ObjectFit, reply: Reply<Unit, UIRTCVideoNodeCode>) = picture.setObjectFit(fit, reply)
    override fun setMirror(mirror: Boolean, reply: Reply<Unit, UIRTCVideoNodeCode>) = picture.setMirror(mirror, reply)

    /** The node released. */
    override fun destroy() = picture.destroy()
}

private const val TAG = "LeCodes"
