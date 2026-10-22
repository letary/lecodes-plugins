//
//  QRTracker.kt — lecodes-plugins/ar
//
//  The QR targets of an ARCore session (`StartOptions.codes` / `setCodes`, ARCoreSession drives this):
//  a printed QR code of known text and size, found in the camera's picture and kept in the room by an
//  anchor of the session. The port of the WebXR arm's tracker — web/qrAnchor.ts, whose header is the
//  spec of the state machine (the cadence, the windows, the replace rule, the glide, the log); what is
//  ARCore's here is below.
//
//  Who knows what. The camera's pose is ARCore's. The detector — qr-anchor's JNI face
//  (io.letary.qranchor.QrAnchor over libqr_anchor_jni.so; the plugin's binaries/README.md names its
//  commit) — knows nothing of the room: from the grey picture, its intrinsics and the targets it
//  finds the symbol and its pose in the camera, `matrix_gl` (the marker's frame in the GL camera: the
//  symbol's centre, X along its top edge, Y out of it, Z towards its bottom, metres — the contract's
//  frame of a code's entity). So
//
//    M = camera.pose (of the frame the picture is of) × matrix_gl      (column-major, GL axes)
//
//  is the code in the session's world. The picture is the SENSOR's, in its own orientation: its pose
//  is `camera.pose`, never `displayOrientedPose` (the scene camera's, ARCoreSession.frame).
//
//  The capture is taken on the GL thread inside frame(): the frame's CPU image (`acquireCameraImage`,
//  YUV_420_888 — plane 0, the luma, is the grey picture; 640×480 on most devices with the default
//  CameraConfig), copied into a direct buffer of the tracker and closed at once (ARCore holds few of
//  them), with that frame's `camera.pose` and `camera.imageIntrinsics` (the CPU image's, handed over
//  as ARCore reports them: the plane call moves them to the detector's pixel centres itself). An image
//  ARCore does not have yet (NotYetAvailable, DeadlineExceeded, ResourceExhausted — a few frames after
//  a resume, now and then while it runs) skips the capture, said nowhere. The detector runs on its own
//  thread (a handle is not thread-safe: every call on it there), one picture out at a time; its result
//  comes back through a queue the next frame() drains first. No capture while the camera is not
//  TRACKING (the web's `emulatedPosition`: its pose is not the picture's). Both phases at factor 1, no
//  full-res pass: the picture is already the size the web shrinks its captures to.
//
//  The anchor: `session.createAnchor` at M — synchronous, so there is no "asked / next" wait of the
//  web: the first observation makes it and puts the entity at M at once (`image { tracked: true }`); a
//  replacement makes the new one, detaches the old, and the entity glides from where it was shown.
//  Each frame an anchor TRACKING drives its entity. PAUSED (ARCore lost the camera's tracking): not
//  driven, kept; paused LOST_FRAMES frames in a row = the web's "lost (its anchor is not tracked)",
//  `tracked: false` once and sought again — tracked again first = regained. STOPPED = lost, detached.
//  These anchors are the tracker's own, never the session's `anchors` (the app's `anchor()`;
//  `release()` never touches one). "images" mode is the same: ARCore tracks the world in it too.
//
//  Not ported: the web's depth scale (web/depthScale.ts) — it makes up for intrinsics derived from a
//  projection matrix; these are the camera's own. The log keeps `t` and the rms: a bias would show
//  there (docs/plans/qr-anchor-native-plan.md).
//
//  The device log is the web's (`Log.i`, "[ar] qr …"), as the iOS half words it: the depth scale's
//  parts gone, `worker` → `detector` (its thread's ms), no "the picture after … frames" (the capture is
//  the frame's own: 0) — the summary says the GL thread's copy ms instead. An accepted observation (at
//  most 2 lines a second per code: side, rms, inliers, t, the result's latency in frames, the
//  detector's ms), a replacement's delta, an observation kept out (at most once in 2 s), a loss and a
//  regain, the first capture's size and intrinsics, every 5 s while seeking or holding how many
//  captures found what. A detector that does not load or refuses (the library missing for this ABI, a
//  layout of another version) is said once, and this session tracks no codes.
//

package io.letary.lecodes.plugins.ar

import android.graphics.ImageFormat
import android.media.Image
import android.os.SystemClock
import android.util.Log
import com.google.ar.core.Anchor
import com.google.ar.core.Camera
import com.google.ar.core.Frame
import com.google.ar.core.Session
import com.google.ar.core.exceptions.DeadlineExceededException
import com.google.ar.core.exceptions.NotYetAvailableException
import com.google.ar.core.exceptions.ResourceExhaustedException
import io.letary.lecodes.scene.GL
import io.letary.qranchor.QrAnchor
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.DoubleBuffer
import java.util.Locale
import java.util.Queue
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import com.google.ar.core.Pose as ArPose
import com.google.ar.core.TrackingState as ArTracking

internal class QRTracker(private val gl: GL, private val events: AREvents) {

    private enum class Phase(val word: String) { SEEKING("seeking"), HOLDING("holding") }

    /** What an observation of a held code does to its anchor (web/qrAnchor.ts's ReplaceVerdict). */
    enum class Verdict { BAD, MOVE, REPLACE, KEPT, NEAR }

    private class Slew(val from: RigidPose) { var frame = 0 }

    private class Code(val target: QRTarget) {
        /** The anchor that drives the entity, its pose in the last frame it was tracked, whether it
         *  was tracked then, and the frames in a row it has been PAUSED. */
        var anchor: Anchor? = null
        var anchorPose: RigidPose? = null
        var anchorTracked = false
        var pausedFrames = 0
        /** The pose the entity was last given. */
        var shown: RigidPose? = null
        /** What the `image` event said last. */
        var tracked = false
        /** A replacement's glide: from where it was shown, frames so far. */
        var slew: Slew? = null
        /** The last observation's corners (TL TR BR BL, x y px) in a picture of this size: the window
         *  when the anchor does not project. */
        var corners: DoubleArray? = null
        var cornersWidth = 0
        var cornersHeight = 0
        /** The last observation's side, px of its picture. */
        var side = 0.0
        /** Holding captures without this code, in a row. */
        var misses = 0
        /** The largest side of the observations taken since the anchor was made (px: every picture of
         *  a session is the CPU image, one size). */
        var bestSide = 0.0
        var loggedAt = NEVER
        var keptLoggedAt = NEVER
        var anchorWarnedAt = NEVER
    }

    /** A picture out: taken in frame `askedAt` (the CPU image is the frame's own: no wait for it), its
     *  capture `copyMs` of the GL thread; `stale` once the codes changed meanwhile (its observations
     *  name the old list). */
    private class Picture(
        val seq: Int, val generation: Int, val phase: Phase,
        /** Plane 0, `stride` bytes a row, `width` × `height`: the tracker's buffer, untouched while out. */
        val plane: ByteBuffer, val stride: Int, val width: Int, val height: Int,
        /** ARCore's intrinsics for this picture's size, and the camera's world matrix (`camera.pose`). */
        val k: Intrinsics, val camera: DoubleArray,
        /** The frame's timestamp, ns: which camera image this is. */
        val timestamp: Long,
        /** [target, x0, y0, x1, y1] windows in this picture's px. */
        val hints: List<IntArray>,
        val askedAt: Int, val copyMs: Double,
    ) { var stale = false }

    /** The detector thread's word, drained by frame(). */
    private sealed class Heard(val generation: Int) {
        class Loaded(generation: Int, val version: String, val ms: Double) : Heard(generation)
        class Failed(generation: Int, val why: String) : Heard(generation)
        class Result(generation: Int, val seq: Int, val observations: DoubleArray, val processMs: Double) : Heard(generation)
    }

    /** The periodic summary: the results of `phase`'s captures since `since` (0: not counting). */
    private class Summary {
        var phase = Phase.SEEKING
        var since = 0L
        var captures = 0
        var found = 0
        var copyMs = 0.0
        var resultFrames = 0
        var detectorMs = 0.0
        fun restart(at: Long) {
            since = at
            captures = 0; found = 0; copyMs = 0.0; resultFrames = 0; detectorMs = 0.0
        }
    }

    private var codes: List<Code> = emptyList()
    /** Moves at each `clear`: a result of before is not wanted. */
    private var generation = 0
    /** The detector's sessions were asked for (with the first code). */
    private var made = false
    /** This session's detector failed: no codes until the session's end. */
    private var failed = false
    private var detector = Detector()
    private val heard: Queue<Heard> = ConcurrentLinkedQueue()
    private var pending: Picture? = null
    private var seq = 0
    /** The frames so far (the latencies are counted in them). */
    private var frames = 0
    private var sinceCapture = 0
    private var lastViewer: RigidPose? = null
    /** The first capture of the session was described. */
    private var described = false
    /** The copy of plane 0 a picture carries: made again after a `clear` (a picture of before may
     *  still be read on the detector's thread). */
    private var plane: ByteBuffer? = null
    private var captureWarnedAt = NEVER
    private val summary = Summary()
    private val m = FloatArray(16)
    private val inCamera = DoubleArray(3)
    private val inPicture = DoubleArray(2)

    // ── the session's calls (the GL thread) ──────────────────────────────────

    /** The session's codes (a start's, a setCodes'): the set replaces the one before — a code no
     *  longer listed loses its anchor (`tracked: false` once if it was tracked), a new one seeks. A
     *  code is the same when its entity, text and size are. The first code makes the detector. */
    fun set(targets: List<QRTarget>) {
        val taken = HashSet<Code>()
        val next = targets.map { t ->
            (codes.firstOrNull { c -> c !in taken && c.target.entity == t.entity && c.target.text == t.text && c.target.size == t.size } ?: Code(t))
                .also { taken.add(it) }
        }
        for (c in codes) if (c !in taken) drop(c, true)
        val changed = next.size != codes.size || next.indices.any { next[it] !== codes[it] }
        codes = next
        if (changed && made) {
            pending?.stale = true
            val d = detector
            val mine = generation
            val json = targetsJson()
            val count = codes.size
            worker.execute { d.retarget(json, count)?.let { heard.add(Heard.Failed(mine, it)) } }
        }
        if (!made && !failed && codes.isNotEmpty()) {
            made = true
            val d = detector
            val mine = generation
            val json = targetsJson()
            val count = codes.size
            worker.execute { d.open(json, count, mine, heard) }
        }
    }

    /** The session's frame (after the update and the app's anchors, before the render): the
     *  detector's results applied, the anchors drive their entities, a capture taken when one is due. */
    fun frame(session: Session, frame: Frame) {
        frames++
        drain(session)
        if (codes.isEmpty()) return
        drive()
        // a detector that failed: the anchors made before still drive, nothing more is sought
        if (failed) return
        val camera = frame.camera
        if (camera.trackingState != ArTracking.TRACKING) { lastViewer = null; return }
        val viewer = camera.pose
        val slow = slowly(viewer)
        sinceCapture++
        val phases = codes.map { phaseOf(it) }
        // sought: not held, or held and missed by the window for a while (its anchor kept)
        val seeking = codes.indices.any { phases[it] == Phase.SEEKING || codes[it].misses >= MISSES_TO_SEEK }
        val holding = Phase.HOLDING in phases
        if (seeking || holding) {
            val now = SystemClock.uptimeMillis()
            val phase = if (seeking) Phase.SEEKING else Phase.HOLDING
            if (summary.since == 0L || summary.phase != phase) {
                summary.phase = phase
                summary.restart(now)
            } else if (now - summary.since >= SEEK_LOG_PERIOD) {
                val n = summary.captures
                val again = if (codes.any { it.misses >= MISSES_TO_SEEK }) ", sought again after $MISSES_TO_SEEK misses" else ""
                Log.i(TAG, "[ar] qr: ${phase.word} — $n captures in ${f((now - summary.since) / 1000.0, 0)} s, ${summary.found} with a code, " +
                    "the copy ${mean(summary.copyMs, n, 2)} ms, the result after ${mean(summary.resultFrames.toDouble(), n, 1)} frames, " +
                    "detector ${mean(summary.detectorMs, n, 1)} ms mean$again")
                summary.restart(now)
            }
        } else summary.since = 0L
        if (pending != null || !made) return
        val due: Boolean
        var k: Intrinsics? = null
        var pose: DoubleArray? = null
        if (seeking) due = sinceCapture >= SEEK_EVERY
        else if (sinceCapture >= HOLD_EVERY && slow) {
            // a held code inside the picture, the camera steady: a blurred picture gives a worse pose
            // than the anchor has
            val known = intrinsicsOf(camera)
            val at = matrixOf(viewer)
            k = known
            pose = at
            due = known != null && codes.indices.any { i -> phases[i] == Phase.HOLDING && codes[i].anchorPose?.let { inside(it, at, known) } == true }
        } else due = false
        if (!due) return
        sinceCapture = 0
        capture(frame, camera, if (seeking) Phase.SEEKING else Phase.HOLDING, k, pose ?: matrixOf(viewer))
    }

    /** The session's end: every code and anchor gone, the detector's sessions freed (on its thread,
     *  after what is queued there). No `image` event: the session it was of is over. */
    fun clear() {
        generation++
        for (c in codes) drop(c, false)
        codes = emptyList()
        if (made) {
            val d = detector
            worker.execute { d.close() }
        }
        detector = Detector()
        made = false
        failed = false
        pending = null
        heard.clear()
        sinceCapture = 0
        lastViewer = null
        described = false
        plane = null
        summary.restart(0L)
    }

    // ── the state machine (web/qrAnchor.ts) ──────────────────────────────────

    private fun phaseOf(c: Code) = if (c.anchor != null && c.anchorTracked) Phase.HOLDING else Phase.SEEKING

    private fun say(c: Code, tracked: Boolean, why: String) {
        if (c.tracked == tracked) return
        c.tracked = tracked
        Log.i(TAG, "[ar] qr ${c.target.text}: $why")
        events.image(c.target.entity, tracked, listOf(c.target.size, c.target.size))
    }

    /** A code let go: its anchor detached, said untracked once if it was tracked. */
    private fun drop(c: Code, sayIt: Boolean) {
        c.anchor?.detach()
        c.anchor = null
        c.anchorPose = null
        c.anchorTracked = false
        c.slew = null
        if (sayIt) say(c, false, "no longer a target")
    }

    /** The anchors of this frame drive their entities; one paused for long or stopped loses its code. */
    private fun drive() {
        for (c in codes) {
            val anchor = c.anchor ?: continue
            when (anchor.trackingState) {
                ArTracking.TRACKING -> {
                    c.pausedFrames = 0
                    c.anchorTracked = true
                    val at = poseOf(anchor.pose)
                    c.anchorPose = at
                    var shown = at
                    c.slew?.let { s ->
                        s.frame++
                        shown = QRMath.interpolate(s.from, at, min(1.0, s.frame.toDouble() / SLEW_FRAMES))
                        if (s.frame >= SLEW_FRAMES) c.slew = null
                    }
                    c.shown = shown
                    QRMath.compose(shown, m)
                    gl.setMatrix(c.target.entity, m)
                    say(c, true, "regained (its anchor is tracked again)")
                }
                ArTracking.STOPPED -> {
                    // ARCore gave it up for good: a new one is made when the code is found again
                    anchor.detach()
                    c.anchor = null
                    c.anchorPose = null
                    c.anchorTracked = false
                    c.slew = null
                    say(c, false, "lost (its anchor stopped)")
                }
                else -> {
                    // PAUSED: ARCore lost the camera's tracking, the anchor may come back — not driven
                    // meanwhile (the entity stays where it was shown), lost after a while
                    if (c.anchorTracked && ++c.pausedFrames >= LOST_FRAMES) {
                        c.anchorTracked = false
                        say(c, false, "lost (its anchor is not tracked)")
                    }
                }
            }
        }
    }

    /** An anchor of the session at `pose`; null (said at most once in 2 s per code) when ARCore makes
     *  none — not tracking at this moment: the entity stays where it was put, the code seeks again. */
    private fun anchorAt(session: Session, c: Code, pose: RigidPose): Anchor? = try {
        session.createAnchor(ArPose(
            floatArrayOf(pose.x.toFloat(), pose.y.toFloat(), pose.z.toFloat()),
            floatArrayOf(pose.qx.toFloat(), pose.qy.toFloat(), pose.qz.toFloat(), pose.qw.toFloat()),
        ))
    } catch (e: Exception) {
        val now = SystemClock.uptimeMillis()
        if (now - c.anchorWarnedAt >= KEPT_LOG_PERIOD) {
            c.anchorWarnedAt = now
            Log.w(TAG, "[ar] qr ${c.target.text}: the session made no anchor (${e.message ?: e}): it stays where it was put")
        }
        null
    }

    /** An observation of `c` (the record at `at` of `o`) in picture `p`: M = the picture's camera ×
     *  matrix_gl. */
    private fun observed(session: Session, c: Code, o: DoubleArray, at: Int, p: Picture, processMs: Double, resultFrames: Int) {
        val side = o[at + OUT_SIDE]
        val rms = o[at + OUT_RMS]
        val inliers = o[at + OUT_INLIERS].toInt()
        val now = SystemClock.uptimeMillis()
        c.misses = 0
        if (inliers < MIN_INLIERS) {
            if (now - c.keptLoggedAt >= KEPT_LOG_PERIOD) {
                c.keptLoggedAt = now
                Log.i(TAG, "[ar] qr ${c.target.text}: ignored ($inliers points < $MIN_INLIERS; side ${f(side, 0)} px of ${p.width}, rms ${f(rms, 2)} px)")
            }
            return
        }
        val world = QRMath.multiply(p.camera, o, at + OUT_MATRIX)
        val pose = QRMath.poseOf(world)
        c.corners = o.copyOfRange(at + OUT_CORNERS, at + OUT_CORNERS + 8)
        c.cornersWidth = p.width
        c.cornersHeight = p.height
        c.side = side
        if (now - c.loggedAt >= LOG_PERIOD) {
            c.loggedAt = now
            val t = at + OUT_MATRIX + 12
            Log.i(TAG, "[ar] qr ${c.target.text}: side ${f(side, 0)} px of ${p.width}, rms ${f(rms, 2)} px, inliers $inliers, " +
                "t=(${f(o[t], 3)} ${f(o[t + 1], 3)} ${f(o[t + 2], 3)}) m, the result after $resultFrames frames, detector ${f(processMs, 1)} ms")
        }
        if (phaseOf(c) == Phase.SEEKING) {
            // found (or found again, its anchor lost): put there at once, an anchor made there
            c.anchor?.detach()
            c.anchor = null
            c.anchorPose = null
            c.anchorTracked = false
            c.slew = null
            c.shown = pose
            c.bestSide = side
            for (i in 0 until 16) m[i] = world[i].toFloat()
            gl.setMatrix(c.target.entity, m)
            say(c, true, "found at (${f(pose.x, 3)} ${f(pose.y, 3)} ${f(pose.z, 3)}) m")
            val anchor = anchorAt(session, c, pose) ?: return
            c.anchor = anchor
            c.anchorPose = pose
            c.anchorTracked = anchor.trackingState == ArTracking.TRACKING
            c.pausedFrames = 0
            return
        }
        // holding: the observation against the anchor
        val held = c.anchorPose ?: return
        val dm = QRMath.distance(pose, held)
        val dd = QRMath.angle(pose, held)
        val verdict = replaceVerdict(dm, dd, side, rms, inliers, c.bestSide)
        val delta = "Δ ${f(dm * 1000, 1)} mm, ${f(dd, 2)}°"
        when (verdict) {
            Verdict.NEAR -> c.bestSide = max(c.bestSide, side)
            Verdict.KEPT -> if (now - c.keptLoggedAt >= KEPT_LOG_PERIOD) {
                c.keptLoggedAt = now
                Log.i(TAG, "[ar] qr ${c.target.text}: kept (side ${f(side, 0)} < $SIDE_RATIO × ${f(c.bestSide, 0)} px), $delta (rms ${f(rms, 2)} px)")
            }
            Verdict.REPLACE, Verdict.MOVE -> {
                Log.i(TAG, "[ar] qr ${c.target.text}: anchor replaced${if (verdict == Verdict.MOVE) " (a large Δ)" else ""}, $delta " +
                    "(side ${f(side, 0)} px, best ${f(c.bestSide, 0)}, rms ${f(rms, 2)} px)")
                c.bestSide = side
                val next = anchorAt(session, c, pose) ?: return
                c.anchor?.detach()
                c.anchor = next
                c.pausedFrames = 0
                // from where it is shown to the new anchor: the next drive() glides it there
                c.slew = c.shown?.let { Slew(it) }
            }
            Verdict.BAD -> {}
        }
    }

    /** What the detector's thread said: loaded, failed, or a picture's result. */
    private fun drain(session: Session) {
        while (true) {
            val message = heard.poll() ?: return
            if (message.generation != generation) continue
            when (message) {
                is Heard.Loaded -> Log.i(TAG, "[ar] qr: qr-anchor ${message.version}, its detectors made in ${f(message.ms, 0)} ms")
                is Heard.Failed -> lost(message.why)
                is Heard.Result -> result(session, message)
            }
        }
    }

    private fun result(session: Session, r: Heard.Result) {
        val p = pending ?: return
        if (r.seq != p.seq) return
        pending = null
        val o = r.observations
        val n = o.size / STRIDE
        val resultFrames = frames - p.askedAt
        if (summary.since != 0L && p.phase == summary.phase) {
            summary.captures++
            summary.copyMs += p.copyMs
            summary.resultFrames += resultFrames
            summary.detectorMs += r.processMs
            if (n > 0) summary.found++
        }
        if (p.stale) return
        if (p.phase == Phase.HOLDING) {
            val seen = HashSet<Int>()
            for (k in 0 until n) seen.add(o[k * STRIDE + OUT_TARGET].toInt())
            codes.forEachIndexed { i, c -> if (i !in seen && phaseOf(c) == Phase.HOLDING) c.misses++ }
        }
        for (k in 0 until n) {
            val c = codes.getOrNull(o[k * STRIDE + OUT_TARGET].toInt()) ?: continue
            observed(session, c, o, k * STRIDE, p, r.processMs, resultFrames)
        }
    }

    /** The detector failed: said once, no QR codes this session (the anchors made stay). */
    private fun lost(why: String) {
        if (failed) return
        failed = true
        pending = null
        Log.w(TAG, "[ar] the QR detector failed ($why): QR codes are not tracked")
    }

    // ── the capture (the GL thread) ──────────────────────────────────────────

    /** This frame's CPU image to the detector, with the windows of the held codes in its px. */
    private fun capture(frame: Frame, camera: Camera, phase: Phase, known: Intrinsics?, pose: DoubleArray) {
        val t0 = System.nanoTime()
        val image = try { frame.acquireCameraImage() } catch (e: NotYetAvailableException) {
            return
        } catch (e: DeadlineExceededException) {
            return
        } catch (e: ResourceExhaustedException) {
            return
        } catch (e: Exception) {
            warnCapture(e.message ?: e.toString())
            return
        }
        val copied = try { copyLuma(image) } catch (e: Exception) {
            warnCapture(e.message ?: e.toString())
            null
        } finally {
            image.close()
        }
        if (copied == null || failed) return
        val copyMs = (System.nanoTime() - t0) / 1e6
        val buffer = copied.buffer
        val stride = copied.stride
        val width = copied.width
        val height = copied.height
        val reported = known ?: intrinsicsOf(camera) ?: return warnCapture("the camera gave no intrinsics")
        val k = reported.scaled(width, height)
        if (!described) {
            described = true
            // the image's timestamp should be the frame's: the pose M uses is that frame's
            val scaled = if (k !== reported) ", scaled from ${reported.width}×${reported.height}" else ""
            val dt = copied.imageTimestamp - frame.timestamp
            val stamp = if (dt == 0L) "the frame's" else "${f(dt / 1e6, 1)} ms off the frame's"
            Log.i(TAG, "[ar] qr: the capture is ${width}×${height} luma (plane 0, $stride bytes a row; seeking ${width / FACTOR} px / holding ${width / FACTOR} px), " +
                "fx ${f(k.fx, 1)} fy ${f(k.fy, 1)} cx ${f(k.cx, 1)} cy ${f(k.cy, 1)} px (ARCore's$scaled), its timestamp $stamp")
        }
        val hints = ArrayList<IntArray>()
        codes.forEachIndexed { i, c -> if (phaseOf(c) == Phase.HOLDING) hintOf(i, c, pose, k)?.let { hints.add(it) } }
        val p = Picture(++seq, generation, phase, buffer, stride, width, height, k, pose, frame.timestamp, hints, frames, copyMs)
        pending = p
        val d = detector
        worker.execute { d.process(p, heard) }
    }

    /** A copy of plane 0: the buffer, its row stride, its size, the image's own timestamp (ns) — read
     *  while the image is open (nothing of a closed one may be). */
    private class Copied(val buffer: ByteBuffer, val stride: Int, val width: Int, val height: Int, val imageTimestamp: Long)

    /** Plane 0 of a YUV_420_888 image (the luma: the grey picture) into the tracker's direct buffer,
     *  the rows at their row stride — the plane's own buffer is laid out so, copied as it is. Null
     *  when the image is not one the detector reads (said once: no codes this session). */
    private fun copyLuma(image: Image): Copied? {
        if (image.format != ImageFormat.YUV_420_888) {
            lost("the camera image is not YUV_420_888 (format ${image.format})")
            return null
        }
        val y = image.planes[0]
        if (y.pixelStride != 1) {
            lost("the camera image's luma has a pixel stride of ${y.pixelStride}")
            return null
        }
        val width = image.width
        val height = image.height
        val stride = y.rowStride
        val src = y.buffer
        val need = (height - 1).toLong() * stride + width
        if (width <= 0 || height <= 0 || stride < width || src.remaining() < need) {
            warnCapture("the luma plane holds ${src.remaining()} bytes for $width×$height at a row stride of $stride")
            return null
        }
        val size = min(src.remaining().toLong(), height.toLong() * stride).toInt()
        val buffer = plane?.takeIf { it.capacity() >= size } ?: ByteBuffer.allocateDirect(size).also { plane = it }
        buffer.clear()
        val from = src.duplicate()
        from.limit(from.position() + size)
        buffer.put(from)
        return Copied(buffer, stride, width, height, image.timestamp)
    }

    /** A capture that failed for another reason than "not yet": at most once in 2 s. */
    private fun warnCapture(why: String) {
        val now = SystemClock.uptimeMillis()
        if (now - captureWarnedAt < KEPT_LOG_PERIOD) return
        captureWarnedAt = now
        Log.w(TAG, "[ar] qr: the capture failed ($why)")
    }

    /** The window of held code `c` (index `i`) in a picture of camera `pose`: where it IS — its
     *  anchor's corners projected through the picture's camera (the camera moved since the code was
     *  last seen: where it was seen is stale); where it was last seen when the anchor does not
     *  project. × HINT_MARGIN of its side around. */
    private fun hintOf(i: Int, c: Code, pose: DoubleArray, k: Intrinsics): IntArray? {
        var x0 = Double.POSITIVE_INFINITY
        var y0 = Double.POSITIVE_INFINITY
        var x1 = Double.NEGATIVE_INFINITY
        var y1 = Double.NEGATIVE_INFINITY
        var side = 0.0
        var projected = false
        val held = c.anchorPose
        if (held != null) {
            val a = QRMath.composeD(held)
            val h = c.target.size / 2
            projected = true
            for (corner in 0 until 4) {
                // the corner in the world: the anchor's X along the top edge, Z towards the bottom
                val ax = if (corner == 0 || corner == 3) -h else h
                val az = if (corner < 2) -h else h
                QRMath.toCamera(pose, a[0] * ax + a[8] * az + a[12], a[1] * ax + a[9] * az + a[13], a[2] * ax + a[10] * az + a[14], inCamera)
                if (!QRMath.project(inCamera, k, inPicture)) { projected = false; break }
                x0 = min(x0, inPicture[0]); x1 = max(x1, inPicture[0])
                y0 = min(y0, inPicture[1]); y1 = max(y1, inPicture[1])
            }
            if (projected) side = max(x1 - x0, y1 - y0)
        }
        if (!projected) {
            val corners = c.corners ?: return null
            val sx = k.width.toDouble() / c.cornersWidth
            val sy = k.height.toDouble() / c.cornersHeight
            x0 = Double.POSITIVE_INFINITY; y0 = Double.POSITIVE_INFINITY
            x1 = Double.NEGATIVE_INFINITY; y1 = Double.NEGATIVE_INFINITY
            for (n in 0 until 4) {
                val x = corners[2 * n] * sx
                val y = corners[2 * n + 1] * sy
                x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
            }
            side = c.side * max(sx, sy)
        }
        val margin = HINT_MARGIN * side
        return intArrayOf(i, floor(x0 - margin).toInt(), floor(y0 - margin).toInt(), ceil(x1 + margin).toInt(), ceil(y1 + margin).toInt())
    }

    /** Does a held code's centre fall inside the picture of camera `pose`: in front of it and
     *  INSET_MARGIN of the picture's size within its edges (a code half out of the picture is not read). */
    private fun inside(at: RigidPose, pose: DoubleArray, k: Intrinsics): Boolean {
        QRMath.toCamera(pose, at.x, at.y, at.z, inCamera)
        if (!QRMath.project(inCamera, k, inPicture)) return false
        val mx = INSET_MARGIN * k.width
        val my = INSET_MARGIN * k.height
        return inPicture[0] >= mx && inPicture[0] <= k.width - mx && inPicture[1] >= my && inPicture[1] <= k.height - my
    }

    /** Is this frame's camera moving slowly (since the last frame)? */
    private fun slowly(viewer: ArPose): Boolean {
        val now = poseOf(viewer)
        val last = lastViewer
        lastViewer = now
        return last != null && QRMath.distance(now, last) < SLOW_METRES && QRMath.angle(now, last) < SLOW_DEGREES
    }

    private fun intrinsicsOf(camera: Camera): Intrinsics? = try {
        val k = camera.imageIntrinsics
        val focal = k.focalLength
        val principal = k.principalPoint
        val size = k.imageDimensions
        if (size[0] > 0 && size[1] > 0 && focal[0] > 0f && focal[1] > 0f) {
            Intrinsics(focal[0].toDouble(), focal[1].toDouble(), principal[0].toDouble(), principal[1].toDouble(), size[0], size[1])
        } else null
    } catch (e: Exception) {
        null
    }

    private fun matrixOf(pose: ArPose): DoubleArray {
        val f = FloatArray(16)
        pose.toMatrix(f, 0)
        return DoubleArray(16) { f[it].toDouble() }
    }

    /** The detector's targets: the codes in their order (an observation names its code by it). */
    private fun targetsJson(): String = codes.joinToString(",", "[", "]") { c ->
        val size = c.target.size.takeIf { it.isFinite() } ?: 0.0
        "{\"text\":${JSONObject.quote(c.target.text)},\"size\":$size}"
    }

    // ── the detector (its thread only: a handle is not thread-safe) ──────────

    /** Two detector sessions of the same targets, one per phase (qr-anchor takes its parameters
     *  once): SEEKING (a full detection of every picture) and HOLDING (the windows first, the
     *  half-resolution search when they miss — never a full pass). Each keeps its own history (the
     *  re-acquire gate, the last quad as the next window). Touched on [worker] only. */
    private class Detector {
        private var seeking = 0L
        private var holding = 0L
        private var out: ByteBuffer? = null
        private var doubles: DoubleBuffer? = null
        /** The observations `out` holds. */
        private var capacity = 0

        fun open(targets: String, count: Int, generation: Int, into: Queue<Heard>) {
            val t0 = System.nanoTime()
            val why = try {
                val layout = QrAnchor.outputLayoutVersion()
                val stride = QrAnchor.outputStride()
                if (layout != LAYOUT || stride != STRIDE) "its output is layout $layout × $stride, this half reads $LAYOUT × $STRIDE"
                else {
                    seeking = QrAnchor.create(SEEKING_CONFIG)
                    holding = QrAnchor.create(HOLDING_CONFIG)
                    if (seeking == 0L || holding == 0L) "a detector session was not made (its config refused)"
                    else retarget(targets, count)
                }
            } catch (e: LinkageError) {
                // the library is not in the APK for this ABI (an x86_64 emulator), or does not load
                "libqr_anchor_jni did not load: ${e.cause?.message ?: e.message ?: e}"
            }
            if (why != null) {
                close()
                into.add(Heard.Failed(generation, why))
                return
            }
            into.add(Heard.Loaded(generation, QrAnchor.version(), (System.nanoTime() - t0) / 1e6))
        }

        /** Both sessions' targets replaced: null, or why not (the targets before stay). */
        fun retarget(targets: String, count: Int): String? {
            for (h in longArrayOf(seeking, holding)) {
                if (h == 0L) continue
                if (QrAnchor.setTargets(h, targets) < 0) return "the targets were refused (${QrAnchor.lastError(h)})"
            }
            if (count > capacity) {
                // native-order doubles, 8-byte aligned (allocateDirect), an observation per target at most
                val bytes = ByteBuffer.allocateDirect(count * STRIDE * 8).order(ByteOrder.nativeOrder())
                out = bytes
                doubles = bytes.asDoubleBuffer()
                capacity = count
            }
            return null
        }

        fun process(p: Picture, into: Queue<Heard>) {
            val h = if (p.phase == Phase.SEEKING) seeking else holding
            val bytes = out
            val view = doubles
            if (h == 0L || bytes == null || view == null) {
                into.add(Heard.Result(p.generation, p.seq, EMPTY, 0.0))
                return
            }
            val t0 = System.nanoTime()
            for (hint in p.hints) QrAnchor.setHint(h, hint[0], hint[1], hint[2], hint[3], hint[4])
            val k = p.k
            val n = QrAnchor.processPlane(h, p.plane, p.stride, p.width, p.height, FACTOR, FULL_RES, k.fx, k.fy, k.cx, k.cy, bytes)
            if (n < 0) into.add(Heard.Failed(p.generation, "it refused a picture: ${QrAnchor.lastError(h)}"))
            val count = min(max(n, 0), capacity)
            val observations = DoubleArray(count * STRIDE) { view.get(it) }
            into.add(Heard.Result(p.generation, p.seq, observations, (System.nanoTime() - t0) / 1e6))
        }

        /** Both sessions freed (again is a no-op). */
        fun close() {
            if (seeking != 0L) QrAnchor.free(seeking)
            if (holding != 0L) QrAnchor.free(holding)
            seeking = 0L
            holding = 0L
        }
    }

    companion object {
        private const val TAG = "LeCodes"

        /** The detector's gates (qr-anchor's `Params`, its README; web/qrAnchor.ts's CONFIG): the
         *  smallest apparent side of a code's first observation (px of the picture), … once it was
         *  observed in this session, the largest RMS reprojection error of the inliers. */
        private const val MIN_INIT_SIDE_PX = 40
        private const val MIN_REACQUIRE_SIDE_PX = 20
        private const val MAX_RMS_PX = 0.6
        private const val GATES = "\"min_init_side_px\":$MIN_INIT_SIDE_PX,\"min_reacquire_side_px\":$MIN_REACQUIRE_SIDE_PX,\"max_rms_px\":$MAX_RMS_PX"
        private const val SEEKING_CONFIG = "{$GATES,\"search_first\":false}"
        // the window first (the anchor projected into the picture); when it misses, the half-resolution
        // search only (cheap, sees a large code) — never a full pass: a code missed MISSES_TO_SEEK times
        // in a row is sought again by the seeking session, its anchor kept
        private const val HOLDING_CONFIG = "{$GATES,\"search_first\":true,\"full_detect_interval\":1000000}"
        /** The plane's downsampling, both phases: the CPU image is 640×480 already (the web's captures
         *  are 480 / 960 wide). The full-res windows are factor 2's only. */
        private const val FACTOR = 1
        private const val FULL_RES = false
        /** Holding captures without the code, in a row, after which it is sought again (its anchor kept). */
        private const val MISSES_TO_SEEK = 6
        /** Points of an observation, at least: fewer = the pose's tilt may be the flipped one of a small
         *  planar marker (9 points gave a 75° flip on the phone). */
        private const val MIN_INLIERS = 16
        /** … for a "move" (a large Δ) to replace the anchor: a flip must not pass as a move. */
        private const val MOVE_INLIERS = 24
        /** Frames between captures: seeking, holding (at most: the camera steady, a held code inside). */
        private const val SEEK_EVERY = 2
        private const val HOLD_EVERY = 15
        /** The camera "moves slowly" between two frames: under these. */
        private const val SLOW_METRES = 0.02
        private const val SLOW_DEGREES = 2.0
        /** An observation this far off its anchor's pose replaces the anchor, when seen large enough. */
        private const val REPLACE_METRES = 0.01
        private const val REPLACE_DEGREES = 1.0
        /** … and this far off, whatever its side. */
        private const val MOVE_METRES = 0.03
        private const val MOVE_DEGREES = 5.0
        /** "Large enough": at least this × the code's largest side since its anchor was made. */
        private const val SIDE_RATIO = 0.8
        /** Frames a replaced anchor's entity glides over. */
        private const val SLEW_FRAMES = 10
        /** Frames in a row an anchor may be PAUSED before its code is lost: a hiccup of the camera's
         *  tracking pauses every anchor for a frame or two, and an `image` event pair for it is noise. */
        private const val LOST_FRAMES = 10
        /** The window around a held code's corners, × its side. */
        private const val HINT_MARGIN = 0.5
        /** A held code's centre this far (× the picture's size) inside the picture's edges, for a
         *  holding capture. */
        private const val INSET_MARGIN = 0.05
        /** The observation log: at most a line in this per code (ms). */
        private const val LOG_PERIOD = 500L
        /** An observation kept out (an anchor not made, a capture failed) is said at most once in this,
         *  per code (ms). */
        private const val KEPT_LOG_PERIOD = 2000L
        /** The seeking / holding summary's period, ms. */
        private const val SEEK_LOG_PERIOD = 5000L
        /** The output of qr-anchor (layout 1, checked at load): 28 f64 per observation — the target,
         *  the side px, the rms px, the inliers, matrix_gl (16), the corners TL TR BR BL (8). */
        private const val LAYOUT = 1
        private const val STRIDE = 28
        private const val OUT_TARGET = 0
        private const val OUT_SIDE = 1
        private const val OUT_RMS = 2
        private const val OUT_INLIERS = 3
        private const val OUT_MATRIX = 4
        private const val OUT_CORNERS = 20
        private const val NEVER = Long.MIN_VALUE / 2
        private val EMPTY = DoubleArray(0)

        /** The detector's thread: one for every session (a session's two handles live on it; one picture
         *  out at a time). */
        private val worker = Executors.newSingleThreadExecutor { body -> Thread(body, "lecodes-qr-anchor").apply { isDaemon = true } }

        /** What an observation of a held code does to its anchor (`metres` / `degrees` off its pose,
         *  its apparent side and `bestSide` in px of one picture size, its rms in px) — the web's rule:
         *  - BAD: over the rms gate — ignored;
         *  - MOVE: more than 3 cm or 5° off (a real move, or a wrong first fix) — it replaces the
         *    anchor, unless it has few points or is seen small (a flipped tilt): KEPT;
         *  - REPLACE: more than 1 cm or 1° off and seen at least 0.8 × bestSide — it replaces the anchor;
         *  - KEPT: more than 1 cm or 1° off and seen smaller — the anchor stays (a small picture's tilt
         *    is noise);
         *  - NEAR: within 1 cm and 1° — the anchor stands. */
        internal fun replaceVerdict(metres: Double, degrees: Double, side: Double, rms: Double, inliers: Int?, bestSide: Double, maxRms: Double = MAX_RMS_PX): Verdict {
            if (!(rms <= maxRms)) return Verdict.BAD
            if (metres > MOVE_METRES || degrees > MOVE_DEGREES) {
                // a large Δ at few points or a small side is a flipped tilt, not a move
                if (inliers != null && (inliers < MOVE_INLIERS || side < SIDE_RATIO * bestSide)) return Verdict.KEPT
                return Verdict.MOVE
            }
            if (metres <= REPLACE_METRES && degrees <= REPLACE_DEGREES) return Verdict.NEAR
            return if (side >= SIDE_RATIO * bestSide) Verdict.REPLACE else Verdict.KEPT
        }

        private fun poseOf(p: ArPose) = RigidPose(
            p.tx().toDouble(), p.ty().toDouble(), p.tz().toDouble(),
            p.qx().toDouble(), p.qy().toDouble(), p.qz().toDouble(), p.qw().toDouble(),
        )

        private fun f(v: Double, digits: Int): String = String.format(Locale.ROOT, "%.${digits}f", v)

        private fun mean(sum: Double, n: Int, digits: Int): String = f(if (n > 0) sum / n else 0.0, digits)
    }
}
