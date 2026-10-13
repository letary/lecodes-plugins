//
//  RtcVideoView.kt — lecodes-plugins/webrtc
//
//  The "rtcVideo" view: one video track, local or received, drawn by libwebrtc's SurfaceViewRenderer
//  (a media overlay, so it stacks with the app's views). The host sizes the container; the renderer
//  fills it.
//

package io.letary.lecodes.plugins.webrtc

import android.content.Context
import android.graphics.Color
import android.view.View
import android.widget.FrameLayout
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

class RtcVideoView(context: Context, params: RtcVideoParams, private val events: RtcVideoEvents) : RtcVideoPlugin {

    private val container = FrameLayout(context).apply { setBackgroundColor(Color.BLACK) }
    private val renderer = SurfaceViewRenderer(context)
    private var track: VideoTrack? = null

    override val view: View get() = container

    init {
        renderer.init(RtcEngine.eglBase.eglBaseContext, object : RendererCommon.RendererEvents {
            override fun onFirstFrameRendered() {}
            override fun onFrameResolutionChanged(videoWidth: Int, videoHeight: Int, rotation: Int) {
                val rotated = rotation == 90 || rotation == 270
                events.resize(if (rotated) videoHeight else videoWidth, if (rotated) videoWidth else videoHeight)
            }
        })
        renderer.setEnableHardwareScaler(true)
        renderer.setZOrderMediaOverlay(true)
        container.addView(renderer, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        applyFit(params.objectFit ?: ObjectFit.COVER)
        renderer.setMirror(params.mirror ?: false)
        params.trackId?.let { show(it) }
    }

    private fun show(trackId: String?): Boolean {
        track?.removeSink(renderer)
        track = null
        if (trackId == null) { renderer.clearImage(); return true }
        val found = RtcEngine.track(trackId)?.track as? VideoTrack ?: return false
        track = found
        found.addSink(renderer)
        return true
    }

    private fun applyFit(fit: ObjectFit) {
        renderer.setScalingType(if (fit == ObjectFit.COVER) RendererCommon.ScalingType.SCALE_ASPECT_FILL else RendererCommon.ScalingType.SCALE_ASPECT_FIT)
    }

    // ── the calls (main thread) ──────────────────────────────────────────────

    override fun setTrack(trackId: String?, reply: Reply<Unit, RtcVideoCode>) {
        if (show(trackId)) reply.resolve() else reply.reject(RtcVideoCode.NOT_FOUND)
    }

    override fun setObjectFit(fit: ObjectFit, reply: Reply<Unit, RtcVideoCode>) {
        applyFit(fit)
        reply.resolve()
    }

    override fun setMirror(mirror: Boolean, reply: Reply<Unit, RtcVideoCode>) {
        renderer.setMirror(mirror)
        reply.resolve()
    }

    override fun destroy() {
        show(null)
        renderer.release()
    }
}
