//
//  QRMath.kt — lecodes-plugins/ar
//
//  The pose math of the QR tracker (QRTracker.kt): the twins of the WebXR arm's web/pose.ts —
//  column-major 4×4 matrices (ARCore's `Pose.toMatrix` and the gl facade's: element (row r,
//  column c) at [c * 4 + r]), unit quaternions (x y z w), poses in metres — plus the projection of a
//  point of the camera into its picture through the picture's intrinsics. Nothing of ARCore: doubles
//  in, doubles out.
//

package io.letary.lecodes.plugins.ar

import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/** A rigid pose: where (metres) and turned how (a unit quaternion) — the contract's `Pose` by shape. */
internal class RigidPose(
    val x: Double, val y: Double, val z: Double,
    val qx: Double, val qy: Double, val qz: Double, val qw: Double,
)

/** The intrinsics of a picture of `width` × `height` px as ARCore reports them (`imageIntrinsics`:
 *  pixel corners at integers, cx ≈ width / 2) — what the detector's plane call takes as it is. */
internal class Intrinsics(val fx: Double, val fy: Double, val cx: Double, val cy: Double, val width: Int, val height: Int) {
    /** The same camera at another picture size (the intrinsics scale with the pixels in ARCore's
     *  convention). */
    fun scaled(toWidth: Int, toHeight: Int): Intrinsics {
        if (toWidth == width && toHeight == height) return this
        val sx = toWidth.toDouble() / width
        val sy = toHeight.toDouble() / height
        return Intrinsics(fx * sx, fy * sy, cx * sx, cy * sy, toWidth, toHeight)
    }
}

internal object QRMath {
    private const val DEG = 180.0 / Math.PI

    /** A pose as a column-major 4×4 world matrix, into `out` (floats: the gl facade's). */
    fun compose(p: RigidPose, out: FloatArray) {
        val m = composeD(p)
        for (i in 0 until 16) out[i] = m[i].toFloat()
    }

    /** A pose as a column-major 4×4 world matrix. */
    fun composeD(p: RigidPose): DoubleArray {
        val x = p.qx; val y = p.qy; val z = p.qz; val w = p.qw
        return doubleArrayOf(
            1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 0.0,
            2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 0.0,
            2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y), 0.0,
            p.x, p.y, p.z, 1.0,
        )
    }

    /** `a × b`, both column-major 4×4 (`b` the 16 doubles of `bs` from `bAt`): what `b` maps into its
     *  space, `a` maps on. The code in the session's world is `multiply(cameraPose, matrix_gl)`:
     *  matrix_gl = the marker in the GL camera, the camera's pose = the camera in the world. */
    fun multiply(a: DoubleArray, bs: DoubleArray, bAt: Int = 0): DoubleArray {
        val out = DoubleArray(16)
        for (c in 0 until 4) {
            for (r in 0 until 4) {
                out[c * 4 + r] = a[r] * bs[bAt + c * 4] + a[4 + r] * bs[bAt + c * 4 + 1] +
                    a[8 + r] * bs[bAt + c * 4 + 2] + a[12 + r] * bs[bAt + c * 4 + 3]
            }
        }
        return out
    }

    /** The rotation of a column-major 4×4 rigid matrix (its upper-left 3×3) as a unit quaternion
     *  [x y z w] — Shepperd's: the largest of w, x, y, z taken from the diagonal first, the others
     *  from it (no division by a small number). */
    fun quatFromMatrix(m: DoubleArray): DoubleArray {
        val r00 = m[0]; val r10 = m[1]; val r20 = m[2]
        val r01 = m[4]; val r11 = m[5]; val r21 = m[6]
        val r02 = m[8]; val r12 = m[9]; val r22 = m[10]
        val trace = r00 + r11 + r22
        val x: Double; val y: Double; val z: Double; val w: Double
        if (trace > 0) {
            val s = sqrt(trace + 1) * 2
            w = s / 4; x = (r21 - r12) / s; y = (r02 - r20) / s; z = (r10 - r01) / s
        } else if (r00 > r11 && r00 > r22) {
            val s = sqrt(1 + r00 - r11 - r22) * 2
            w = (r21 - r12) / s; x = s / 4; y = (r01 + r10) / s; z = (r02 + r20) / s
        } else if (r11 > r22) {
            val s = sqrt(1 + r11 - r00 - r22) * 2
            w = (r02 - r20) / s; x = (r01 + r10) / s; y = s / 4; z = (r12 + r21) / s
        } else {
            val s = sqrt(1 + r22 - r00 - r11) * 2
            w = (r10 - r01) / s; x = (r02 + r20) / s; y = (r12 + r21) / s; z = s / 4
        }
        val n = sqrt(x * x + y * y + z * z + w * w).takeIf { it > 0 } ?: 1.0
        return doubleArrayOf(x / n, y / n, z / n, w / n)
    }

    /** A rigid column-major 4×4 matrix as a pose. */
    fun poseOf(m: DoubleArray): RigidPose {
        val q = quatFromMatrix(m)
        return RigidPose(m[12], m[13], m[14], q[0], q[1], q[2], q[3])
    }

    /** Metres between two poses' positions. */
    fun distance(a: RigidPose, b: RigidPose): Double {
        val dx = a.x - b.x; val dy = a.y - b.y; val dz = a.z - b.z
        return sqrt(dx * dx + dy * dy + dz * dz)
    }

    /** Degrees between two poses' turns (0 … 180): the angle of the rotation from one to the other. */
    fun angle(a: RigidPose, b: RigidPose): Double {
        val dot = min(1.0, abs(a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw))
        return 2 * acos(dot) * DEG
    }

    /** The pose `t` of the way from `a` to `b` (0 = a, 1 = b): the position along the line, the turn
     *  along the shorter arc (slerp). */
    fun interpolate(a: RigidPose, b: RigidPose, t: Double): RigidPose {
        var dot = a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw
        // the shorter arc: q and −q are the same turn
        val s = if (dot < 0) -1.0 else 1.0
        dot *= s
        val ka: Double
        val kb: Double
        if (dot > 0.9995) {
            // nearly the same: a straight line, normalized below
            ka = 1 - t; kb = t * s
        } else {
            val theta = acos(dot)
            val sinTheta = sin(theta)
            ka = sin((1 - t) * theta) / sinTheta
            kb = (sin(t * theta) / sinTheta) * s
        }
        val x = ka * a.qx + kb * b.qx
        val y = ka * a.qy + kb * b.qy
        val z = ka * a.qz + kb * b.qz
        val w = ka * a.qw + kb * b.qw
        val n = sqrt(x * x + y * y + z * z + w * w).takeIf { it > 0 } ?: 1.0
        return RigidPose(
            a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t,
            x / n, y / n, z / n, w / n,
        )
    }

    /** A point of the world (`wx wy wz`) in the camera whose rigid world matrix is `camera` (GL axes:
     *  x right, y up, −z ahead), into `out` [x y z]: the matrix's inverse applied, Rᵀ (p − t). */
    fun toCamera(camera: DoubleArray, wx: Double, wy: Double, wz: Double, out: DoubleArray) {
        val dx = wx - camera[12]; val dy = wy - camera[13]; val dz = wz - camera[14]
        out[0] = camera[0] * dx + camera[1] * dy + camera[2] * dz
        out[1] = camera[4] * dx + camera[5] * dy + camera[6] * dz
        out[2] = camera[8] * dx + camera[9] * dy + camera[10] * dz
    }

    /** A point of the camera (GL axes, `p` [x y z]) in its picture's px, into `out` [x y]: x right, y
     *  DOWN, pixel CENTRES at integers — the detector's convention, the one its corners and its hint
     *  windows are in (ARCore's intrinsics are the pixel corners': ½ off). False when the point is
     *  not in front of the camera. */
    fun project(p: DoubleArray, k: Intrinsics, out: DoubleArray): Boolean {
        val depth = -p[2]   // the OpenCV camera's z: ahead
        if (!(depth > 1e-6)) return false
        out[0] = k.fx * p[0] / depth + k.cx - 0.5
        out[1] = k.fy * -p[1] / depth + k.cy - 0.5
        return true
    }
}
