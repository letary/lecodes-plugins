package dev.tinyrtc

import android.content.Context
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.hardware.display.DisplayManager
import android.util.AttributeSet
import android.view.Surface
import android.view.TextureView
import android.widget.FrameLayout
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max
import kotlin.math.min

/**
 * The picture of one track: a remote one (decoded here, by a hardware decoder of this view's own)
 * or a local one (the camera's preview). A FrameLayout holding a TextureView: an ordinary view in
 * the app's layout (it moves, clips, overlaps and animates like any other), and its transform
 * matrix carries what the picture needs — the rotation that travels with the frames, [mirror],
 * [objectFit] — with no GL pass and no copy. A new TextureView is made for each track shown, so a
 * surface is never handed from one producer to the next while the first still draws into it.
 */
class RtcVideoView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : FrameLayout(context, attrs) {
    enum class ObjectFit { COVER, CONTAIN }

    var track: VideoTrack? = null
        set(value) {
            Core.checkMain("track")
            if (field === value) return
            field = value
            bind(value)
        }

    var objectFit: ObjectFit = ObjectFit.COVER
        set(value) {
            field = value
            updateTransform()
        }

    /** Shown horizontally flipped (what a selfie preview usually wants). */
    var mirror: Boolean = false
        set(value) {
            field = value
            updateTransform()
        }

    /** Main thread: the picture's size as shown (upright, after rotation) changed. */
    var onResize: ((width: Int, height: Int) -> Unit)? = null

    /** Upright size of the picture shown; 0 before the first frame. */
    var videoWidth: Int = 0
        private set
    var videoHeight: Int = 0
        private set

    /** The decoder's numbers (zeros for a local track). */
    val diagnostics: VideoViewDiagnostics
        get() = (binding as? RemoteBinding)?.decoder?.diagnostics()
            ?: VideoViewDiagnostics(0, 0, 0, 0, 0, 0, 0, 0, 0, "")

    /** Frames the TextureView took (local or remote). */
    val framesShown: Long get() = binding?.shown?.get() ?: 0

    private var binding: Binding? = null
    private val displays = context.getSystemService(DisplayManager::class.java)
    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) = updateTransform()
    }

    init {
        clipChildren = true
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        displays.registerDisplayListener(displayListener, Core.main)
        updateTransform()
    }

    override fun onDetachedFromWindow() {
        displays.unregisterDisplayListener(displayListener)
        super.onDetachedFromWindow()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        updateTransform()
    }

    private fun bind(next: VideoTrack?) {
        binding?.let { old ->
            old.unbind()
            removeView(old.texture)
        }
        binding = null
        videoWidth = 0
        videoHeight = 0
        val b = when (next) {
            is RemoteVideoTrack -> RemoteBinding(next)
            is LocalVideoTrack -> LocalBinding(next)
            null -> return
        }
        binding = b
        addView(b.texture, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    /** The content as the TextureView stretches it over its bounds, and what to do with it. */
    private class Geometry(val width: Int, val height: Int, val rotation: Int, val flip: Boolean)

    private fun updateTransform() {
        val b = binding ?: return
        val g = b.geometry() ?: return
        val vw = b.texture.width.toFloat()
        val vh = b.texture.height.toFloat()
        if (vw <= 0f || vh <= 0f || g.width <= 0 || g.height <= 0) return
        val cx = vw / 2
        val cy = vh / 2
        val quarter = g.rotation % 180 != 0
        val shownW = (if (quarter) g.height else g.width).toFloat()
        val shownH = (if (quarter) g.width else g.height).toFloat()
        val scale = if (objectFit == ObjectFit.CONTAIN) min(vw / shownW, vh / shownH) else max(vw / shownW, vh / shownH)
        val m = Matrix()
        m.setScale(g.width / vw, g.height / vh, cx, cy) // undo the stretch: the content at its own size, centred
        if (g.flip) m.postScale(-1f, 1f, cx, cy)
        m.postRotate(g.rotation.toFloat(), cx, cy)
        m.postScale(scale, scale, cx, cy)
        if (mirror) m.postScale(-1f, 1f, cx, cy)
        b.texture.setTransform(m)
        b.texture.invalidate()
        val w = shownW.toInt()
        val h = shownH.toInt()
        if (w != videoWidth || h != videoHeight) {
            videoWidth = w
            videoHeight = h
            onResize?.invoke(w, h)
        }
    }

    private fun displayDegrees(): Int = when (display?.rotation) {
        Surface.ROTATION_90 -> 90
        Surface.ROTATION_180 -> 180
        Surface.ROTATION_270 -> 270
        else -> 0
    }

    private abstract inner class Binding : TextureView.SurfaceTextureListener {
        val texture = TextureView(context).also { it.surfaceTextureListener = this }
        val shown = AtomicLong()
        private var surface: SurfaceTexture? = null

        abstract fun geometry(): Geometry?

        /** The texture is there: give it to the producer. */
        abstract fun start(texture: SurfaceTexture)

        /** The producer lets go of the texture and releases it once nothing draws into it. */
        abstract fun stop(texture: SurfaceTexture)

        override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
            surface = st
            start(st)
            updateTransform()
        }

        override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) = updateTransform()

        /** false: the texture is released by its producer, after it stopped drawing. */
        override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
            if (surface === st) {
                surface = null
                stop(st)
            }
            return false
        }

        override fun onSurfaceTextureUpdated(st: SurfaceTexture) {
            shown.incrementAndGet()
        }

        fun unbind() {
            surface?.let {
                surface = null
                stop(it)
            }
        }
    }

    private inner class RemoteBinding(private val remote: RemoteVideoTrack) : Binding(), VideoDecoder.Events {
        var decoder: VideoDecoder? = null
        private var width = 0
        private var height = 0
        private var rotation = 0

        override fun geometry() = Geometry(width, height, rotation, flip = false)

        override fun start(texture: SurfaceTexture) {
            decoder = VideoDecoder(remote, texture, this)
        }

        override fun stop(texture: SurfaceTexture) {
            val d = decoder
            decoder = null
            if (d != null) d.release { texture.release() } else texture.release()
        }

        override fun onSize(width: Int, height: Int) {
            Core.main.post {
                this.width = width
                this.height = height
                if (binding === this) updateTransform()
            }
        }

        override fun onRotation(degrees: Int) {
            Core.main.post {
                rotation = degrees
                if (binding === this) updateTransform()
            }
        }
    }

    private inner class LocalBinding(private val local: LocalVideoTrack) : Binding() {
        private var preview: PreviewGeometry? = null

        /**
         * The camera already turns the preview upright for the display's natural orientation (and
         * mirrors a front camera): what is left is the display's own rotation, and undoing that
         * mirror, so that [mirror] means the same for a local and a remote picture.
         */
        override fun geometry(): Geometry? {
            val p = preview ?: return null
            val swap = p.sensorOrientation % 180 != 0
            return Geometry(
                width = if (swap) p.height else p.width,
                height = if (swap) p.width else p.height,
                rotation = (360 - displayDegrees()) % 360,
                flip = p.facing == Facing.USER,
            )
        }

        override fun start(texture: SurfaceTexture) {
            local.pipe.attachPreview(texture) { geometry ->
                Core.main.post {
                    preview = geometry
                    if (binding === this) updateTransform()
                }
            }
        }

        override fun stop(texture: SurfaceTexture) = local.pipe.detachPreview(texture)
    }
}
