//
//  RtcVideoView.kt — lecodes-plugins/webrtc
//
//  The ONE video class behind both surfaces of the picture (contract.d.ts), the Kotlin twin of
//  RtcVideoView.swift: one video track, local or received, drawn by libwebrtc's SurfaceViewRenderer
//  (a media overlay, so it stacks with the app's views) into a black container the host sizes. Two
//  thin instances wrap it:
//   - the VIEW "rtcVideo" (RtcVideoViewInstance): the fullscreen picture the app pushes or opens;
//     its params are read at creation, the calls change them after;
//   - the HOST NODE "rtcVideo" (RtcVideoNodeInstance): the picture as a box of a screen's layout,
//     laid out and painted by the core's holder (UINodeHost); its props `trackId`, `objectFit`,
//     `mirror` are LIVE, each write applied as it comes (none needs the others).
//
//  The calls are the contract's RtcVideoMethods, one set for both surfaces: generic over the
//  surface's generated code enum, whose code it is handed. The `resize` event goes through the
//  surface's generated events class (a callback here).
//

package io.letary.lecodes.plugins.webrtc

import android.content.Context
import android.graphics.Color
import android.util.Log
import android.view.View
import android.widget.FrameLayout
import io.letary.lecodes.services.PluginCode
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

internal class RtcVideoView<C : PluginCode>(
    context: Context,
    params: RtcVideoParams,
    /** The surface's `resize` event: the picture's size, rotated as shown. */
    private val resize: (width: Int, height: Int) -> Unit,
    /** The surface's `notFound` code. */
    private val notFound: C,
) {

    val container = FrameLayout(context).apply { setBackgroundColor(Color.BLACK) }
    private val renderer = SurfaceViewRenderer(context)
    private var track: VideoTrack? = null
    private var shown: String? = null

    init {
        renderer.init(RtcEngine.eglBase.eglBaseContext, object : RendererCommon.RendererEvents {
            override fun onFirstFrameRendered() {}
            override fun onFrameResolutionChanged(videoWidth: Int, videoHeight: Int, rotation: Int) {
                val rotated = rotation == 90 || rotation == 270
                resize(if (rotated) videoHeight else videoWidth, if (rotated) videoWidth else videoHeight)
            }
        })
        renderer.setEnableHardwareScaler(true)
        renderer.setZOrderMediaOverlay(true)
        container.addView(renderer, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        applyFit(params.objectFit ?: ObjectFit.COVER)
        renderer.setMirror(params.mirror ?: false)
        params.trackId?.let { show(it) }
    }

    /** Draw `trackId` (null = black); false when no track of that id is known. */
    fun show(trackId: String?): Boolean {
        // The wrapper may have been disposed by libwebrtc meanwhile (a received track's): the sink
        // is native, so the registry's current wrapper removes it; a dead one is let go.
        track?.let { old -> runCatching { old.removeSink(renderer) }.onFailure { shown?.let { id -> (RtcEngine.track(id)?.track as? VideoTrack)?.let { t -> runCatching { t.removeSink(renderer) } } } } }
        track = null
        shown = trackId
        if (trackId == null) { renderer.clearImage(); return true }
        val found = RtcEngine.track(trackId)?.track as? VideoTrack ?: return false
        track = found
        found.addSink(renderer)
        return true
    }

    fun applyFit(fit: ObjectFit) {
        renderer.setScalingType(if (fit == ObjectFit.COVER) RendererCommon.ScalingType.SCALE_ASPECT_FILL else RendererCommon.ScalingType.SCALE_ASPECT_FIT)
    }

    fun applyMirror(mirror: Boolean) = renderer.setMirror(mirror)

    // ── RtcVideoMethods (main thread) ────────────────────────────────────────

    fun setTrack(trackId: String?, reply: Reply<Unit, C>) {
        if (show(trackId)) reply.resolve() else reply.reject(notFound)
    }

    fun setObjectFit(fit: ObjectFit, reply: Reply<Unit, C>) {
        applyFit(fit)
        reply.resolve()
    }

    fun setMirror(mirror: Boolean, reply: Reply<Unit, C>) {
        applyMirror(mirror)
        reply.resolve()
    }

    fun destroy() {
        show(null)
        renderer.release()
    }
}

// ── the View ────────────────────────────────────────────────────────────────

/** The view "rtcVideo": an RtcVideoView made from the View's params, its container the View's. */
internal class RtcVideoViewInstance(context: Context, params: RtcVideoParams, events: RtcVideoEvents) : RtcVideoPlugin {
    private val video = RtcVideoView(context, params, events::resize, RtcVideoCode.NOT_FOUND)

    override val view: View get() = video.container

    override fun setTrack(trackId: String?, reply: Reply<Unit, RtcVideoCode>) = video.setTrack(trackId, reply)
    override fun setObjectFit(fit: ObjectFit, reply: Reply<Unit, RtcVideoCode>) = video.setObjectFit(fit, reply)
    override fun setMirror(mirror: Boolean, reply: Reply<Unit, RtcVideoCode>) = video.setMirror(mirror, reply)

    override fun destroy() = video.destroy()
}

// ── the host node ───────────────────────────────────────────────────────────

/** The host node "rtcVideo": an RtcVideoView as the node's box, its props applied as they come. */
internal class RtcVideoNodeInstance(context: Context, events: UIRTCVideoNodeEvents) : UIRTCVideoNodeInstance {
    private val video = RtcVideoView(context, RtcVideoParams(), events::resize, UIRTCVideoNodeCode.NOT_FOUND)
    /** The track ids no track was known for — logged once each. */
    private val missing = mutableSetOf<String>()

    override val view: View get() = video.container

    override fun setTrackId(value: String?) {
        if (!video.show(value) && value != null && missing.add(value)) {
            Log.w("LeCodes", "UIRTCVideoNode: no track \"$value\" — the node shows black")
        }
    }
    override fun setObjectFit(value: ObjectFit?) = video.applyFit(value ?: ObjectFit.COVER)
    override fun setMirror(value: Boolean?) = video.applyMirror(value ?: false)

    override fun setTrack(trackId: String?, reply: Reply<Unit, UIRTCVideoNodeCode>) = video.setTrack(trackId, reply)
    override fun setObjectFit(fit: ObjectFit, reply: Reply<Unit, UIRTCVideoNodeCode>) = video.setObjectFit(fit, reply)
    override fun setMirror(mirror: Boolean, reply: Reply<Unit, UIRTCVideoNodeCode>) = video.setMirror(mirror, reply)

    /** The node released: the track lets go of the renderer, the renderer its EGL surface. */
    override fun destroy() = video.destroy()
}
