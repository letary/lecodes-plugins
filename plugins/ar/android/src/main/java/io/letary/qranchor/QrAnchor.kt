//
//  QrAnchor.kt — lecodes-plugins/ar
//
//  The Kotlin face of libqr_anchor_jni.so (src/main/jniLibs/<abi>/), the JNI crate of the qr-anchor
//  repo (crates/qr-anchor-jni over the C ABI of crates/qr-anchor-ffi): the metric pose of a QR code of
//  known printed size from a grey camera plane and the camera's intrinsics. The library is prebuilt,
//  never edited here — where it comes from, its commit and its hashes: ../../../../../../../binaries/README.md
//  (the plugin's binaries/README.md). The class is the library's, not the plugin's: generic, named
//  after qr-anchor; this half's tracker (QRTracker.kt) is its one user.
//
//  The semantics are the C ABI's (qr_anchor.h, `qra_*`, the binaries' iOS headers carry it): a handle
//  is a detector session, NOT thread-safe — every call on it from one thread. No call throws: an
//  error is a return value (-1, `lastError` says why; `create` gives 0). The buffers are DIRECT
//  ByteBuffers, read from their base address (the position is ignored): `plane` holds at least
//  (height − 1) · stride + width bytes, `out` holds native-order doubles, at least targets × 28 × 8
//  bytes (an allocateDirect buffer is 8-byte aligned).
//

package io.letary.qranchor

import java.nio.ByteBuffer

class QrAnchor private constructor() {
    companion object {
        init { System.loadLibrary("qr_anchor_jni") }

        /** A detector session from the config JSON ("" = the defaults; an object merged over them,
         *  `{"search_first": true, "min_init_side_px": 40}`): its handle, 0 on an invalid config. */
        @JvmStatic external fun create(configJson: String): Long

        /** The session freed (0 is a no-op). */
        @JvmStatic external fun free(handle: Long)

        /** The targets, `[{"text": "<payload>", "size": <metres>}, …]` (size = the printed side of the
         *  modules, no quiet zone): their count, or -1 (the targets before stay). */
        @JvmStatic external fun setTargets(handle: Long, targetsJson: String): Int

        /** A detection window for one target (px of the — downsampled — frame: columns x0..x1, rows
         *  y0..y1, the ends exclusive), for the next processPlane only. 0, or -1 for an unknown target. */
        @JvmStatic external fun setHint(handle: Long, target: Int, x0: Int, y0: Int, x1: Int, y1: Int): Int

        /** One frame from a camera plane (qra_process_plane): `plane` = 8-bit luma rows of `stride`
         *  bytes, `width` × `height` px, downsampled by `factor` (1, 2 or 4) before detection — with
         *  `fullRes` at factor 2 the windowed decodes run on the full plane; fx fy cx cy = the FULL
         *  plane's intrinsics in the platform's convention (pixel corners at integers: cx ≈ width / 2),
         *  converted and scaled inside. Writes 28 doubles per observation into `out` (layout 1: the
         *  target, side px, rms px, inliers, matrix_gl, the corners TL TR BR BL — the side and the
         *  corners in the downsampled frame's px) and returns the count; 0 = nothing found or a bad
         *  plane, -1 = a bad handle / factor / stride. */
        @JvmStatic external fun processPlane(
            handle: Long, plane: ByteBuffer, stride: Int, width: Int, height: Int,
            factor: Int, fullRes: Boolean, fx: Double, fy: Double, cx: Double, cy: Double,
            out: ByteBuffer,
        ): Int

        /** The per-target history forgotten (the re-acquire gate, the tracked windows). 0, or -1. */
        @JvmStatic external fun reset(handle: Long): Int

        /** The handle's last error, "" when none. */
        @JvmStatic external fun lastError(handle: Long): String

        /** The output's layout (1) and its stride in doubles (28) as built: a reader checks both. */
        @JvmStatic external fun outputLayoutVersion(): Int
        @JvmStatic external fun outputStride(): Int

        /** The library's version. */
        @JvmStatic external fun version(): String
    }
}
