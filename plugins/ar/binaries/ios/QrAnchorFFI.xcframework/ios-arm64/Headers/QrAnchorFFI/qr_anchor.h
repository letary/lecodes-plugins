/*
 * qr_anchor.h — C ABI of qr-anchor (crates/qr-anchor-ffi). Hand-written (cbindgen was not
 * available when it was made); keep it in step with crates/qr-anchor-ffi/src/lib.rs — every
 * declaration here is a #[no_mangle] function there, with the same argument types.
 *
 * Detects a QR code of known printed size in a grey camera frame (qra_process) or a camera's luma
 * plane (qra_process_plane: any row stride, downsampled inside) and returns its metric 6-DoF
 * pose relative to the camera, given the camera intrinsics.
 *
 * THE MARKER FRAME: origin at the symbol's centre; +X along its top edge towards the right; +Y out
 * of the plaque towards the viewer; +Z towards its bottom edge; metres, right-handed.
 *
 * OUTPUT: QRA_OUTPUT_STRIDE (28) doubles per observation, records back to back, target order:
 *   [0]      target index (into the list given to qra_set_targets)
 *   [1]      apparent side of the symbol, px
 *   [2]      RMS reprojection error of the inliers, px
 *   [3]      inlier count
 *   [4..20)  matrix_gl: the marker's frame in the GL camera frame (x right, y up, -z forward),
 *            column-major 4x4 = diag(1,-1,-1,1) * [R t; 0 1] with X_cam = R X_marker + t in the
 *            OpenCV camera frame (x right, y down, +z forward)
 *   [20..28) the symbol's corners TL, TR, BR, BL (QR orientation) as x, y px
 *
 * A handle is not thread-safe: one per camera stream, used from one thread at a time.
 */
#ifndef QR_ANCHOR_H
#define QR_ANCHOR_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define QRA_OUTPUT_STRIDE 28
#define QRA_OUTPUT_LAYOUT_VERSION 1

/* Offsets inside one output record. */
#define QRA_OUT_TARGET 0
#define QRA_OUT_SIDE_PX 1
#define QRA_OUT_RMS_PX 2
#define QRA_OUT_INLIERS 3
#define QRA_OUT_MATRIX_GL 4
#define QRA_OUT_CORNERS 20

typedef struct QraAnchor QraAnchor;

/* A new session from the config JSON (NULL or "" = defaults; an object merged over the
 * defaults, e.g. {"search_first": true, "min_init_side_px": 40}). NULL on an invalid config. */
QraAnchor *qra_new(const char *config_json);

/* Free a session (NULL is a no-op). */
void qra_free(QraAnchor *h);

/* Replace the targets: [{"text": "<payload, UTF-8>", "size": <metres>}, ...] (size = printed
 * side of the modules without the quiet zone). Returns the target count, or -1 (qra_last_error
 * says why; the previous targets stay). */
int32_t qra_set_targets(QraAnchor *h, const char *targets_json);

/* A detection window for one target (frame px — of the downsampled frame for qra_process_plane:
 * columns x0..x1, rows y0..y1, ends exclusive; clamped to the frame), for the next qra_process /
 * qra_process_plane only. 0, or -1 for an unknown target. */
int32_t qra_set_hint(QraAnchor *h, uint32_t target, int32_t x0, int32_t y0, int32_t x1, int32_t y1);

/* Find the targets in one frame: gray = width * height bytes of 8-bit luminance, row-major, no
 * row padding; fx, fy, cx, cy = intrinsics in px of this frame (y down, pixel centres at integer
 * coordinates). Writes min(count, out_len / 28) records into out (NULL with out_len 0 is fine)
 * and returns count, the observations found (at most the target count, so an out of
 * targets * 28 doubles always fits); -1 for a NULL handle. Bad frames / intrinsics give 0. */
int32_t qra_process(QraAnchor *h, const uint8_t *gray, uint32_t width, uint32_t height,
                    double fx, double fy, double cx, double cy, double *out, size_t out_len);

/* One frame from a camera plane: plane = 8-bit luma rows of `stride` bytes (>= width), width x
 * height px ((height - 1) * stride + width readable bytes; e.g. plane 0 of ARKit's capturedImage
 * at its bytesPerRow, plane 0 of ARCore's YUV_420_888 CPU image at its rowStride), downsampled by
 * `factor` (1, 2 or 4: a factor x factor box filter into the handle's own buffer, reallocated
 * only when it grows; at 1 the rows are packed there unless stride == width) into a
 * width / factor x height / factor frame (a remainder of rows or columns dropped) before
 * detection. fx, fy, cx, cy = the intrinsics of the FULL plane in the platform's convention
 * (pixel corners at integers: cx ~ width / 2, as ARKit's and ARCore's) — the call moves them to
 * the detector's (pixel centres, - 1/2) and scales them by the factor:
 * fx' = fx / factor, cx' = (cx - 1/2 + 1/2) / factor - 1/2. With factor 2 and full_res != 0 the
 * windowed decodes (the hinted and tracked windows, the whole-frame candidates, the location
 * pass) run on the full plane itself (qr_anchor's Anchor::process_with_full), mapped back to the
 * downsampled frame's px: the sub-pixel corners of a small or tilted code; full_res is ignored
 * at factors 1 and 4. Output and return as qra_process; the corners and the side are in the
 * DOWNSAMPLED frame's px, and so are the qra_set_hint windows. -1 for a NULL handle or an
 * invalid factor / stride (qra_last_error says which); a NULL plane, a zero size or a frame too
 * large for the detector (a side over 16384 px, over 2^24 px in all) gives 0. The hints are
 * consumed by every call on a live handle. No allocation per call once the buffers have grown
 * to the plane's size (after the first frames). */
int32_t qra_process_plane(QraAnchor *h, const uint8_t *plane, uint32_t stride, uint32_t width,
                          uint32_t height, uint32_t factor, int full_res,
                          double fx, double fy, double cx, double cy, double *out, size_t out_len);

/* Forget the per-target history (the re-acquire side gate, the tracked windows). 0, or -1. */
int32_t qra_reset(QraAnchor *h);

/* The last error of this handle (empty when none), valid until the next call on it. */
const char *qra_last_error(const QraAnchor *h);

/* QRA_OUTPUT_LAYOUT_VERSION and QRA_OUTPUT_STRIDE of the built library. */
uint32_t qra_output_layout_version(void);
uint32_t qra_output_stride(void);

/* The library version, a static string. */
const char *qra_version(void);

#ifdef __cplusplus
}
#endif

#endif /* QR_ANCHOR_H */
