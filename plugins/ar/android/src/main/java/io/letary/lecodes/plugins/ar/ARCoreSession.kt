//
//  ARCoreSession.kt — lecodes-plugins/ar
//
//  One AR session over ARCore, driving the app's scene through `engine.gl` and nothing else. ARCore
//  writes the camera image into a ring of OES textures of the shared EGL context
//  (`setCameraTextureNames`); each frame (`gl.onFrame`: the GL thread, before the runtime's tick)
//  `session.update()` runs there, the name holding the newest image is bound to the session's external
//  texture, shown as the scene's background through `transformCoordinates2d` (VIEW_NORMALIZED →
//  TEXTURE_NORMALIZED), the display-oriented camera pose becomes the scene camera's matrix and
//  `getProjectionMatrix` its projection, and the entities the app pinned follow their Anchor /
//  AugmentedImage (an image's: a rigid pose, its size the `image` event's `extent`). Planes, tracking
//  and the light go out as the contract's events; plane updates are throttled here (a change over
//  1 cm, at most 10 a second per plane). ARCore keeps an anchor's tracking to itself, so no `anchor`
//  event comes from here.
//
//  The display ARCore is told of (`setDisplayGeometry`: its projection, its crop, its hit test) is the
//  scene view's — `gl.viewport(scene)`, its size in dp (the space the scene's touches arrive in) and the
//  display's turn — read every frame and told again when it changes, in px: ARCore takes whole numbers,
//  and a dp size rounded would bend the aspect. A hit test's dp point is scaled the same way. Before
//  the scene is presented its view has no size (the session starts during the warm render): the frame
//  waits for one.
//
//  Before the first session ARCore may need installing: `start` asks Google Play Services for AR
//  (`requestInstall`), which shows the Play Store's dialog and resumes the activity; the start goes on
//  at that resume. The channel is AR.gen.kt, generated from contract.d.ts; `start` arrives with the
//  camera permission granted. Main thread throughout.
//

package io.letary.lecodes.plugins.ar

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.opengl.GLES30
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import com.google.ar.core.Anchor
import com.google.ar.core.ArCoreApk
import com.google.ar.core.AugmentedImage
import com.google.ar.core.AugmentedImageDatabase
import com.google.ar.core.Camera
import com.google.ar.core.Config
import com.google.ar.core.Coordinates2d
import com.google.ar.core.Frame
import com.google.ar.core.LightEstimate
import com.google.ar.core.Plane
import com.google.ar.core.Session
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.NotYetAvailableException
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException
import com.google.ar.core.exceptions.UnavailableException
import com.google.ar.core.exceptions.UnavailableUserDeclinedInstallationException
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.scene.Entity
import io.letary.lecodes.scene.ExternalTexture
import io.letary.lecodes.scene.Scene3D
import io.letary.lecodes.services.OpenGL
import io.letary.lecodes.services.PluginFile
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.pow
import com.google.ar.core.Pose as ArPose
import com.google.ar.core.TrackingFailureReason as ArFailure
import com.google.ar.core.TrackingState as ArTracking

class ARCoreSession(
    private val engine: LecodesEngine,
    private val context: Context,
    params: ARParams,
    private val events: AREvents,
) : ARPlugin {

    private val scene: Scene3D? = params.scene
    private val camera: Entity? = params.camera
    private val gl = engine.gl
    private val main = Handler(Looper.getMainLooper())

    /** A start that waits: for ARCore's availability, its install, the first frame whose camera image
     *  can be read (`since`: the first frame that carried one, uptime ms). */
    private class Starting(val options: StartOptions?, val reply: Reply<Unit, ARCode>) { var since = 0L }
    private var starting: Starting? = null
    private var installRequested = false

    private var session: Session? = null
    private var mode = ARMode.WORLD
    private var texture: ExternalTexture? = null
    private var names = IntArray(0)
    private var cancelFrame: (() -> Unit)? = null
    /** The frame of the last `update()`: valid until the next one, which is what hitTest reads. */
    private var latest: Frame? = null
    /** captureFrame()s waiting for a camera image ARCore hands over (capture()), each with the frames
     *  it has waited. */
    private class Capture(val reply: Reply<PluginFile, ARCode>) { var frames = 0 }
    private val captures = ArrayList<Capture>()
    private var uv: FloatArray? = null
    /** The display ARCore was last told of: the viewport's turn and its size in px. */
    private var geometry = Triple(-1, 0, 0)
    private var lifecycle: Lifecycle? = null
    private var resumed = false

    private var tracking: Pair<TrackingState, TrackingReason?>? = null
    /** Image targets by their name in the database (the entity id), and what was last said of each. */
    private val images = HashMap<String, Entity>()
    private class ImageSent(val tracked: Boolean, val ex: Float, val ez: Float, val at: Long)
    private val imagesSent = HashMap<Int, ImageSent>()
    private val anchors = HashMap<Int, Pair<Entity, Anchor>>()

    private class PlaneSent(val id: Double, val type: PlaneType, val pose: Pose, val cx: Float, val cy: Float, val cz: Float, val ex: Float, val ez: Float, val at: Long)
    private val planes = HashMap<Plane, PlaneSent>()
    private var nextPlane = 1.0
    private var lightAt = 0L

    private val m = FloatArray(16)

    // ── the calls ────────────────────────────────────────────────────────────

    override fun start(options: StartOptions?, reply: Reply<Unit, ARCode>) {
        if (session != null || starting != null) return reply.reject(ARCode.BUSY)
        if (scene == null || camera == null) {
            Log.w(TAG, "[ar] start: the session has no scene or camera to drive (ARScene opens it with both)")
            return reply.reject(ARCode.FAILED)
        }
        // no 3D engine (the `core` / `2d` variants): nothing to draw the camera into — said before ARCore
        // is asked for (an install dialog for nothing)
        texture = gl.createExternalTexture() ?: run {
            Log.w(TAG, "[ar] this host has no 3D engine: there is nothing to draw the camera into")
            return reply.reject(ARCode.UNAVAILABLE)
        }
        val wait = Starting(options, reply)
        starting = wait
        ArCoreApk.getInstance().checkAvailabilityAsync(context) { availability ->
            if (starting !== wait) return@checkAvailabilityAsync
            if (!availability.isSupported) failStart(ARCode.UNAVAILABLE, "ARCore is not supported on this device ($availability)")
            else install()
        }
    }

    override fun stop(reply: Reply<Unit, ARCode>) {
        end()
        reply.resolve()
    }

    override fun hitTest(x: Double, y: Double, target: HitTarget?, reply: Reply<List<HitResult>, ARCode>) {
        val frame = latest ?: return reply.reject(ARCode.NOT_RUNNING)
        if (mode != ARMode.WORLD) return reply.resolve(emptyList())
        val eye = frame.camera.pose
        val hits = ArrayList<HitResult>()
        // the point is in the scene view's touch space (dp); ARCore's display geometry is in px
        // (displayGeometry): scaled by the same density
        val px = density
        val result = try { frame.hitTest((x * px).toFloat(), (y * px).toFloat()) } catch (e: Exception) { emptyList() }
        for (hit in result) {
            val plane = hit.trackable as? Plane
            val onPlane = plane != null && plane.subsumedBy == null && plane.isPoseInPolygon(hit.hitPose)
            when (target ?: HitTarget.ANY) {
                HitTarget.PLANES -> if (!onPlane) continue
                HitTarget.ESTIMATED -> if (onPlane) continue
                HitTarget.ANY -> {}
            }
            val p = hit.hitPose
            val distance = hypot(hypot((p.tx() - eye.tx()).toDouble(), (p.ty() - eye.ty()).toDouble()), (p.tz() - eye.tz()).toDouble())
            hits.add(HitResult(pose = poseOf(p), type = if (onPlane) HitResultType.PLANE else HitResultType.ESTIMATED,
                plane = if (onPlane) plane?.let { planes[it]?.id } else null, distance = distance))
        }
        hits.sortBy { it.distance }
        reply.resolve(hits)
    }

    override fun anchor(entity: Entity, pose: Pose, reply: Reply<Unit, ARCode>) {
        val s = session ?: return reply.reject(ARCode.NOT_RUNNING)
        anchors.remove(entity.id)?.second?.detach()
        val anchor = try { s.createAnchor(arPoseOf(pose)) } catch (e: Exception) {
            Log.w(TAG, "[ar] anchor: ${e.message ?: e}")
            return reply.reject(ARCode.NOT_RUNNING)
        }
        anchors[entity.id] = entity to anchor
        anchor.pose.toMatrix(m, 0)
        gl.setMatrix(entity, m)
        reply.resolve()
    }

    override fun release(entity: Entity, reply: Reply<Unit, ARCode>) {
        anchors.remove(entity.id)?.second?.detach()
        reply.resolve()
    }

    override fun captureFrame(reply: Reply<PluginFile, ARCode>) {
        val frame = latest ?: return reply.reject(ARCode.NOT_RUNNING)
        captures.add(Capture(reply))
        // the latest frame's image when ARCore hands it over, else the frames that follow serve it
        // (frame() → capture(); none while the activity is paused — the wait goes on at its resume);
        // one that comes while others wait joins them
        if (captures.size == 1 && resumed) capture(frame)
    }

    override fun close() = end()

    // ── ARCore: available, installed, a session ─────────────────────────────

    private fun install() {
        val activity = engine.getActivity() ?: return failStart(ARCode.FAILED, "no activity to ask for ARCore in")
        watch(activity.lifecycle)
        try {
            when (ArCoreApk.getInstance().requestInstall(activity, !installRequested)) {
                ArCoreApk.InstallStatus.INSTALLED -> {
                    installRequested = false
                    open()
                }
                // the Play Store's dialog is up: the activity resumes after it, and install() runs again
                ArCoreApk.InstallStatus.INSTALL_REQUESTED -> installRequested = true
                else -> failStart(ARCode.FAILED, "ARCore did not install")
            }
        } catch (e: UnavailableUserDeclinedInstallationException) {
            failStart(ARCode.UNAVAILABLE, "ARCore was not installed (declined)")
        } catch (e: UnavailableDeviceNotCompatibleException) {
            failStart(ARCode.UNAVAILABLE, "this device is not compatible with ARCore")
        } catch (e: Exception) {
            failStart(ARCode.FAILED, "ARCore did not install: ${e.message ?: e}")
        }
    }

    private fun open() {
        val wait = starting ?: return
        val options = wait.options
        val s = try { Session(context) } catch (e: UnavailableException) {
            return failStart(ARCode.UNAVAILABLE, "ARCore: ${e.message ?: e}")
        } catch (e: Exception) {
            return failStart(ARCode.FAILED, "ARCore: ${e.message ?: e}")
        }
        mode = options?.mode ?: ARMode.WORLD
        val config = Config(s).apply {
            updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
            focusMode = if (options?.autoFocus != false) Config.FocusMode.AUTO else Config.FocusMode.FIXED
            planeFindingMode = if (mode == ARMode.IMAGES) Config.PlaneFindingMode.DISABLED else when (options?.planes ?: PlaneDetection.HORIZONTAL) {
                PlaneDetection.HORIZONTAL -> Config.PlaneFindingMode.HORIZONTAL
                PlaneDetection.VERTICAL -> Config.PlaneFindingMode.VERTICAL
                PlaneDetection.BOTH -> Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL
                PlaneDetection.NONE -> Config.PlaneFindingMode.DISABLED
            }
            lightEstimationMode = if (options?.lightEstimation == true) Config.LightEstimationMode.AMBIENT_INTENSITY else Config.LightEstimationMode.DISABLED
            instantPlacementMode = Config.InstantPlacementMode.DISABLED
            cloudAnchorMode = Config.CloudAnchorMode.DISABLED
        }
        if (options?.worldAlignment == WorldAlignment.GRAVITY_AND_HEADING) {
            Log.w(TAG, "[ar] worldAlignment \"gravityAndHeading\": ARCore aligns by gravity only")
        }
        val targets = options?.images.orEmpty()
        if (targets.isNotEmpty()) {
            val database = AugmentedImageDatabase(s)
            for (target in targets) {
                val bitmap = BitmapFactory.decodeByteArray(target.image.data, 0, target.image.data.size)
                if (bitmap == null) { Log.w(TAG, "[ar] an image target did not decode — left out"); continue }
                try {
                    database.addImage(target.entity.id.toString(), bitmap, target.physicalWidth.toFloat())
                    images[target.entity.id.toString()] = target.entity
                } catch (e: Exception) {
                    Log.w(TAG, "[ar] an image target was refused (${e.message ?: e}) — left out")
                }
            }
            config.augmentedImageDatabase = database
        }
        try {
            s.configure(config)
            // the ring ARCore writes the camera image into: OES names of the shared context
            OpenGL.createEglContext()
            names = IntArray(4) { OpenGL.createExternalTextureId() }
            s.setCameraTextureNames(names)
            s.resume()
        } catch (e: CameraNotAvailableException) {
            s.close()
            return failStart(ARCode.FAILED, "the camera is not available")
        } catch (e: Exception) {
            s.close()
            return failStart(ARCode.FAILED, "ARCore: ${e.message ?: e}")
        }
        session = s
        resumed = true
        cancelFrame = gl.onFrame { frame() }
    }

    // ── each frame (gl.onFrame: the GL thread, before the runtime's tick) ──────

    private fun frame() {
        val s = session ?: return
        // a turn of the screen makes the activity again (the engine and its scene stay, LecodesEngine.
        // attach): the old one's pause paused the session, the new one's resume is what resumes it —
        // watching a lifecycle that is resumed already resumes the session at once
        engine.getActivity()?.let { watch(it.lifecycle) }
        if (!resumed) return
        val scene = scene ?: return
        val texture = texture ?: return
        // the scene is not presented while the session starts (the warm render, then the start's
        // first frame): ARCore runs and the start resolves, the picture is fitted from the frame
        // after the view has a size
        val fitted = displayGeometry(s, scene)
        val frame = try { s.update() } catch (e: CameraNotAvailableException) {
            fail(ARErrorCode.CAMERA, "the camera is not available")
            return
        } catch (e: Exception) {
            return
        }
        latest = frame
        if (captures.isNotEmpty()) capture(frame)
        if (frame.timestamp == 0L) return   // no camera image yet
        val cam = frame.camera
        if (fitted) {
            texture.importTexture(frame.cameraTextureName)
            if (uv == null || frame.hasDisplayGeometryChanged()) {
                val shown = uvOf(frame)
                uv = shown
                gl.setBackground(scene, texture, shown)
            }
            texture.update()
            cam.displayOrientedPose.toMatrix(m, 0)
            gl.setCameraMatrix(scene, m)
            cam.getProjectionMatrix(m, 0, NEAR, FAR)
            gl.setProjection(scene, m, NEAR, FAR)
        }

        report(cam)
        val wait = starting
        if (wait != null && readable(wait, frame)) {
            // the first frame whose camera image can be read: tracking was the session's first event,
            // the start resolves now — a captureFrame() from here on has an image to read
            starting = null
            wait.reply.resolve()
        }
        if (mode == ARMode.WORLD) planes(frame)
        if (images.isNotEmpty()) images(frame)
        for ((entity, anchor) in anchors.values) {
            if (anchor.trackingState != ArTracking.TRACKING) continue
            anchor.pose.toMatrix(m, 0)
            gl.setMatrix(entity, m)
        }
        frame.lightEstimate.takeIf { it.state == LightEstimate.State.VALID }?.let { light(it) }
    }

    private fun report(cam: Camera) {
        val now: Pair<TrackingState, TrackingReason?> = when (cam.trackingState) {
            ArTracking.TRACKING -> TrackingState.NORMAL to null
            ArTracking.STOPPED -> TrackingState.NOT_AVAILABLE to null
            else -> TrackingState.LIMITED to when (cam.trackingFailureReason) {
                ArFailure.NONE, ArFailure.BAD_STATE -> TrackingReason.INITIALIZING
                ArFailure.EXCESSIVE_MOTION -> TrackingReason.EXCESSIVE_MOTION
                ArFailure.INSUFFICIENT_FEATURES, ArFailure.INSUFFICIENT_LIGHT -> TrackingReason.INSUFFICIENT_FEATURES
                else -> null
            }
        }
        if (now == tracking) return
        tracking = now
        events.tracking(now.first, now.second)
    }

    /** A plane is sent when it is new, when it moved or grew by a centimetre since it was last sent
     *  and a tenth of a second has passed, and when it is gone (or merged into another). */
    private fun planes(frame: Frame) {
        val time = SystemClock.uptimeMillis()
        for (plane in frame.getUpdatedTrackables(Plane::class.java)) {
            val sent = planes[plane]
            val absorbed = plane.subsumedBy
            if (plane.trackingState == ArTracking.STOPPED || absorbed != null) {
                if (sent == null) continue
                planes.remove(plane)
                events.plane(PlaneChange.REMOVED, sent.id, sent.type, sent.pose, listOf(sent.ex.toDouble(), sent.ez.toDouble()), emptyList(),
                    absorbed?.let { planes[it]?.id })
                continue
            }
            if (plane.trackingState != ArTracking.TRACKING) continue
            val center = plane.centerPose
            val ex = plane.extentX
            val ez = plane.extentZ
            if (sent != null) {
                val moved = hypot(hypot((center.tx() - sent.cx).toDouble(), (center.ty() - sent.cy).toDouble()), (center.tz() - sent.cz).toDouble()) >= 0.01 ||
                    abs(ex - sent.ex) >= 0.01f || abs(ez - sent.ez) >= 0.01f
                if (!moved || time - sent.at < 100) continue
            }
            val type = if (plane.type == Plane.Type.VERTICAL) PlaneType.VERTICAL else PlaneType.HORIZONTAL
            val pose = poseOf(center)
            val buffer = plane.polygon
            val polygon = ArrayList<Double>(buffer.remaining())
            while (buffer.hasRemaining()) polygon.add(buffer.get().toDouble())
            val id = sent?.id ?: nextPlane++
            planes[plane] = PlaneSent(id, type, pose, center.tx(), center.ty(), center.tz(), ex, ez, time)
            events.plane(if (sent == null) PlaneChange.ADDED else PlaneChange.UPDATED, id, type, pose, listOf(ex.toDouble(), ez.toDouble()), polygon)
        }
    }

    /** An image target: while ARCore tracks it fully its entity is on the image — a rigid pose
     *  (`centerPose`: its centre, Y out of it, no scale) — and its size is ARCore's estimate
     *  (`extentX` × `extentZ`). Said when it is found or lost, and while tracked when the size moved
     *  by a millimetre since it was last said and a tenth of a second has passed. */
    private fun images(frame: Frame) {
        val time = SystemClock.uptimeMillis()
        for (image in frame.getUpdatedTrackables(AugmentedImage::class.java)) {
            val entity = images[image.name] ?: continue
            val tracked = image.trackingState == ArTracking.TRACKING && image.trackingMethod == AugmentedImage.TrackingMethod.FULL_TRACKING
            if (tracked) {
                image.centerPose.toMatrix(m, 0)
                gl.setMatrix(entity, m)
            }
            val sent = imagesSent[entity.id]
            val ex = if (tracked || sent == null) image.extentX else sent.ex
            val ez = if (tracked || sent == null) image.extentZ else sent.ez
            if (sent == null && !tracked) continue   // never seen: nothing to say
            if (sent != null && sent.tracked == tracked) {
                val moved = abs(ex - sent.ex) >= 0.001f || abs(ez - sent.ez) >= 0.001f
                if (!tracked || !moved || time - sent.at < 100) continue
            }
            imagesSent[entity.id] = ImageSent(tracked, ex, ez, time)
            events.image(entity, tracked, listOf(ex.toDouble(), ez.toDouble()))
        }
    }

    /** ARCore's ambient intensity → the contract's (1000 = neutral, a mid-grey picture), its colour
     *  correction → a temperature (McCamy over the white it describes). At most 10 a second. */
    private fun light(estimate: LightEstimate) {
        val time = SystemClock.uptimeMillis()
        if (time - lightAt < 100) return
        lightAt = time
        val rgba = FloatArray(4)
        estimate.getColorCorrection(rgba, 0)
        events.light(estimate.pixelIntensity * 2000.0, temperatureOf(rgba[0], rgba[1], rgba[2]))
    }

    // ── plumbing ─────────────────────────────────────────────────────────────

    /** ARCore's projection, its crop and its hit test are for the display it is told of: the scene
     *  view's (its dp size in px, its turn), told again when it changed — before the update, which
     *  applies it (and says so: `hasDisplayGeometryChanged`). False while the view has no size. */
    private fun displayGeometry(s: Session, scene: Scene3D): Boolean {
        val view = gl.viewport(scene)
        val px = density
        val width = Math.round(view.width * px)
        val height = Math.round(view.height * px)
        if (width <= 0 || height <= 0) return false
        val now = Triple(view.rotation, width, height)
        if (now != geometry) {
            geometry = now
            s.setDisplayGeometry(surfaceRotation(view.rotation), width, height)
        }
        return true
    }

    /** Whether the start may resolve on `frame` (a timestamped one): its camera image can be read.
     *  ARCore's CPU image lags its texture for a few frames after a resume — `acquireCameraImage`
     *  throws NotYetAvailableException there (seen on a Xiaomi: the first captureFrame after the start
     *  refused, one half a second later fine) — so the frame alone is not enough. Bounded: a device
     *  whose image stays unreadable still starts after IMAGE_WAIT_MS (its captures wait, then fail)
     *  rather than hang `open()`; another failure is not waited for — waiting does not cure it. */
    private fun readable(wait: Starting, frame: Frame): Boolean {
        val now = SystemClock.uptimeMillis()
        if (wait.since == 0L) wait.since = now
        try {
            frame.acquireCameraImage().close()
            return true
        } catch (e: NotYetAvailableException) {
            if (now - wait.since < IMAGE_WAIT_MS) return false
            Log.w(TAG, "[ar] the camera image is not readable after ${IMAGE_WAIT_MS} ms: the start resolves without it (captureFrame may fail)")
            return true
        } catch (e: Exception) {
            return true
        }
    }

    /** Serve the waiting captureFrame()s from `frame`'s camera image. ARCore's CPU image lags its
     *  texture: `acquireCameraImage` throws NotYetAvailableException for the first frames after a resume
     *  and, its docs say, for a few frames at a time while the session runs — the next frame would serve
     *  the capture, so it waits for it (frame() calls this each frame while one waits), at most
     *  CAPTURE_WAIT_FRAMES; then it is refused "failed": the camera gave no image. Another exception
     *  refuses at once — waiting does not cure it. The captures that wait together get ONE image, copied
     *  and encoded once (each its own File): each asked for the latest camera image, and the one that
     *  comes is the latest for all of them. */
    private fun capture(frame: Frame) {
        val copied = try {
            // a frame with no timestamp has no camera image yet: none to hand over either. The YUV
            // image is ARCore's until closed: copied out here, encoded off the main thread
            if (frame.timestamp == 0L) null
            else frame.acquireCameraImage().use { image -> Triple(nv21Of(image), image.width, image.height) }
        } catch (e: NotYetAvailableException) {
            null
        } catch (e: Exception) {
            Log.w(TAG, "[ar] captureFrame: ${e.message ?: e}")
            for (reply in takeCaptures()) reply.reject(ARCode.FAILED)
            return
        }
        if (copied == null) {
            for (c in captures) c.frames++
            val over = captures.filter { it.frames >= CAPTURE_WAIT_FRAMES }
            if (over.isEmpty()) return
            captures.removeAll(over)
            Log.w(TAG, "[ar] captureFrame: the camera gave no image in $CAPTURE_WAIT_FRAMES frames")
            for (c in over) c.reply.reject(ARCode.FAILED)
            return
        }
        val (nv21, width, height) = copied
        val replies = takeCaptures()
        val turn = uprightDegrees()
        encoder.execute {
            val jpeg = try { jpegOf(nv21, width, height, turn) } catch (e: Exception) { null }
            for (reply in replies) if (jpeg != null) reply.resolve(PluginFile(jpeg, "frame.jpg")) else reply.reject(ARCode.FAILED)
        }
    }

    /** The waiting captures' replies, the wait emptied first (a reply settled may reach the app, whose
     *  next captureFrame() then starts a wait of its own). */
    private fun takeCaptures(): List<Reply<PluginFile, ARCode>> {
        val replies = captures.map { it.reply }
        captures.clear()
        return replies
    }

    /** Device px per dp: the number the host divides the scene's touches by (its UI density), so a
     *  viewport size or a touch point times it is the view's px. */
    private val density: Float get() = context.resources.displayMetrics.density

    /** The background's rows [a b tx; c d ty]: where the view's corners land in the texture. */
    private fun uvOf(frame: Frame): FloatArray {
        val corners = floatArrayOf(0f, 0f, 1f, 0f, 0f, 1f)
        val out = FloatArray(6)
        frame.transformCoordinates2d(Coordinates2d.VIEW_NORMALIZED, corners, Coordinates2d.TEXTURE_NORMALIZED, out)
        return floatArrayOf(out[2] - out[0], out[4] - out[0], out[0], out[3] - out[1], out[5] - out[1], out[1])
    }

    /** How far the sensor's image turns to stand as the screen does (the back camera). */
    private fun uprightDegrees(): Int {
        val s = session ?: return 0
        val sensor = try {
            (context.getSystemService(Context.CAMERA_SERVICE) as CameraManager)
                .getCameraCharacteristics(s.cameraConfig.cameraId).get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
        } catch (e: Exception) { 90 }
        val display = scene?.let { gl.viewport(it).rotation } ?: 0
        return (sensor - display + 360) % 360
    }

    /** Keep up with the activity: ARCore lets the camera go while it is paused, and an install
     *  dialog returns through its resume. */
    private fun watch(next: Lifecycle) {
        if (lifecycle === next) return
        lifecycle?.removeObserver(observer)
        lifecycle = next
        next.addObserver(observer)
    }

    private val observer = object : DefaultLifecycleObserver {
        override fun onResume(owner: LifecycleOwner) {
            if (starting != null && installRequested && session == null) { install(); return }
            val s = session ?: return
            try {
                s.resume()
                resumed = true
            } catch (e: CameraNotAvailableException) {
                fail(ARErrorCode.CAMERA, "the camera is not available")
            }
        }

        override fun onPause(owner: LifecycleOwner) {
            if (session == null) return
            resumed = false
            session?.pause()
        }
    }

    private fun failStart(code: ARCode, message: String) {
        Log.w(TAG, "[ar] $message")
        val wait = starting
        starting = null
        end()
        wait?.reply?.reject(code)
    }

    /** The session failed once running: over, and the app is told. */
    private fun fail(code: ARErrorCode, message: String) {
        val wait = starting
        if (wait != null) return failStart(if (code == ARErrorCode.UNAVAILABLE) ARCode.UNAVAILABLE else ARCode.FAILED, message)
        Log.w(TAG, "[ar] $message")
        end()
        events.error(code, message)
    }

    /** Over: the camera let go, the scene back to its own projection and no background. */
    private fun end() {
        cancelFrame?.invoke()
        cancelFrame = null
        lifecycle?.removeObserver(observer)
        lifecycle = null
        starting?.let { wait ->
            starting = null
            wait.reply.reject(ARCode.FAILED)
        }
        // a capture still waiting for its image: the session it waited on is over
        for (reply in takeCaptures()) reply.reject(ARCode.NOT_RUNNING)
        installRequested = false
        for ((_, anchor) in anchors.values) anchor.detach()
        anchors.clear()
        session?.let { s ->
            s.pause()
            s.close()
        }
        session = null
        resumed = false
        latest = null
        scene?.let { sc ->
            gl.setBackground(sc, null)
            gl.clearProjection(sc)
        }
        texture?.close()
        texture = null
        deleteNames()
        uv = null
        geometry = Triple(-1, 0, 0)
        tracking = null
        images.clear()
        imagesSent.clear()
        planes.clear()
    }

    private fun deleteNames() {
        if (names.isEmpty()) return
        GLES30.glDeleteTextures(names.size, names, 0)
        names = IntArray(0)
    }

    companion object {
        private const val TAG = "LeCodes"
        private const val NEAR = 0.01f
        private const val FAR = 1000f
        /** How long a start waits for a readable camera image after the first frame that carried one. */
        private const val IMAGE_WAIT_MS = 2000L
        /** How many frames a captureFrame() waits for a camera image ARCore hands over (the latest one
         *  included): half a second at 60 fps, where the phone measured 6 frames after a resume. */
        private const val CAPTURE_WAIT_FRAMES = 30
        /** captureFrame's JPEG encoder: off the GL thread. */
        private val encoder = Executors.newSingleThreadExecutor()

        /** The viewport's turn (degrees) as the `Surface.ROTATION_*` ARCore takes. */
        private fun surfaceRotation(degrees: Int): Int = when (degrees) {
            90 -> Surface.ROTATION_90
            180 -> Surface.ROTATION_180
            270 -> Surface.ROTATION_270
            else -> Surface.ROTATION_0
        }

        private fun poseOf(p: ArPose): Pose {
            val q = p.rotationQuaternion
            return Pose(Vec3(p.tx().toDouble(), p.ty().toDouble(), p.tz().toDouble()), Quat(q[0].toDouble(), q[1].toDouble(), q[2].toDouble(), q[3].toDouble()))
        }

        private fun arPoseOf(p: Pose): ArPose = ArPose(
            floatArrayOf(p.position.x.toFloat(), p.position.y.toFloat(), p.position.z.toFloat()),
            floatArrayOf(p.rotation.x.toFloat(), p.rotation.y.toFloat(), p.rotation.z.toFloat(), p.rotation.w.toFloat()),
        )

        /** An NV21 camera image as a JPEG, turned `turn` degrees (the sensor's image is landscape:
         *  turned to stand as the screen does). */
        private fun jpegOf(nv21: ByteArray, width: Int, height: Int, turn: Int): ByteArray {
            val out = ByteArrayOutputStream()
            YuvImage(nv21, ImageFormat.NV21, width, height, null).compressToJpeg(Rect(0, 0, width, height), 90, out)
            val jpeg = out.toByteArray()
            if (turn == 0) return jpeg
            val bitmap = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
            val turned = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(turn.toFloat()) }, true)
            val again = ByteArrayOutputStream()
            turned.compress(Bitmap.CompressFormat.JPEG, 90, again)
            turned.recycle()
            bitmap.recycle()
            return again.toByteArray()
        }

        /** A YUV_420_888 image as NV21 (Y, then V/U interleaved), whatever its strides. */
        private fun nv21Of(image: android.media.Image): ByteArray {
            val w = image.width
            val h = image.height
            val out = ByteArray(w * h * 3 / 2)
            val (yPlane, uPlane, vPlane) = image.planes
            var at = 0
            val y = yPlane.buffer
            for (row in 0 until h) {
                for (col in 0 until w) out[at++] = y.get(row * yPlane.rowStride + col * yPlane.pixelStride)
            }
            val u = uPlane.buffer
            val v = vPlane.buffer
            for (row in 0 until h / 2) {
                for (col in 0 until w / 2) {
                    out[at++] = v.get(row * vPlane.rowStride + col * vPlane.pixelStride)
                    out[at++] = u.get(row * uPlane.rowStride + col * uPlane.pixelStride)
                }
            }
            return out
        }

        /** The colour temperature of the white a colour correction describes (linear sRGB → xy →
         *  McCamy's formula); the neutral (1, 1, 1) is D65's 6500 K. */
        private fun temperatureOf(r: Float, g: Float, b: Float): Double {
            val x = 0.4124 * r + 0.3576 * g + 0.1805 * b
            val y = 0.2126 * r + 0.7152 * g + 0.0722 * b
            val z = 0.0193 * r + 0.1192 * g + 0.9505 * b
            val sum = x + y + z
            if (sum <= 0.0) return 6500.0
            val n = (x / sum - 0.3320) / (0.1858 - y / sum)
            return (449.0 * n.pow(3) + 3525.0 * n.pow(2) + 6823.3 * n + 5520.33).coerceIn(1000.0, 40000.0)
        }
    }
}
