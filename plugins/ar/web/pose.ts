// The pose math of the ar plugin's WebXR arm (./webxr.ts, ./qrAnchor.ts): column-major 4×4 matrices
// (WebXR's and the gl facade's: element (row r, column c) at [c * 4 + r]), unit quaternions, poses in
// metres. Imports nothing — not even the channel's types (a pose here is the contract's `Pose` by
// shape) — so a test runs it as it is (hosts/web-lite/tests/arPose.test.ts).

export type V3 = { x: number, y: number, z: number }
export type Q = { x: number, y: number, z: number, w: number }
/** A rigid pose: where (metres) and turned how — the contract's `Pose`. */
export type PoseLike = { position: V3, rotation: Q }

const DEG = 180 / Math.PI

/** A pose as a column-major 4×4 world matrix. */
export const compose = ({ position: p, rotation: q }: PoseLike): number[] => {
  const { x, y, z, w } = q
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 0,
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 0,
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y), 0,
    p.x, p.y, p.z, 1,
  ]
}

/** The inverse of a column-major 4×4 matrix; null when it has none. */
export const invert = (m: ArrayLike<number>): number[] | null => {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = Array.from(m)
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det) return null
  const d = 1 / det
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ]
}

/** `a × b`, both column-major 4×4: what `b` maps into its space, `a` maps on (b first, then a).
 *  out[c·4 + r] = Σₖ a[k·4 + r] · b[c·4 + k]. The marker in the session's space is
 *  `multiply(view.transform.matrix, matrix_gl)`: matrix_gl = the marker in the GL camera, the view's
 *  transform = the camera in the space. */
export const multiply = (a: ArrayLike<number>, b: ArrayLike<number>): number[] => {
  const out = new Array<number>(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!
    }
  }
  return out
}

/** The rotation of a column-major 4×4 rigid matrix (its upper-left 3×3) as a unit quaternion —
 *  Shepperd's: the largest of w, x, y, z taken from the diagonal first, the others from it (no
 *  division by a small number). */
export const quatFromMatrix = (m: ArrayLike<number>): Q => {
  const r00 = m[0]!, r10 = m[1]!, r20 = m[2]!
  const r01 = m[4]!, r11 = m[5]!, r21 = m[6]!
  const r02 = m[8]!, r12 = m[9]!, r22 = m[10]!
  const trace = r00 + r11 + r22
  let x: number, y: number, z: number, w: number
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    w = s / 4; x = (r21 - r12) / s; y = (r02 - r20) / s; z = (r10 - r01) / s
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2
    w = (r21 - r12) / s; x = s / 4; y = (r01 + r10) / s; z = (r02 + r20) / s
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2
    w = (r02 - r20) / s; x = (r01 + r10) / s; y = s / 4; z = (r12 + r21) / s
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2
    w = (r10 - r01) / s; x = (r02 + r20) / s; y = (r12 + r21) / s; z = s / 4
  }
  const n = Math.hypot(x, y, z, w) || 1
  return { x: x / n, y: y / n, z: z / n, w: w / n }
}

/** A rigid column-major 4×4 matrix as a pose. */
export const poseOf = (m: ArrayLike<number>): PoseLike => ({
  position: { x: m[12]!, y: m[13]!, z: m[14]! },
  rotation: quatFromMatrix(m),
})

/** Metres between two points. */
export const distance = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Degrees between two turns (0 … 180): the angle of the rotation from one to the other. */
export const angle = (a: Q, b: Q): number => {
  const dot = Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w))
  return 2 * Math.acos(dot) * DEG
}

/** The turn `t` of the way from `a` to `b` (0 = a, 1 = b) along the shorter arc. */
export const slerp = (a: Q, b: Q, t: number): Q => {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  // the shorter arc: q and −q are the same turn
  const s = dot < 0 ? -1 : 1
  dot *= s
  let ka: number, kb: number
  if (dot > 0.9995) {
    // nearly the same: a straight line, normalized below
    ka = 1 - t; kb = t * s
  } else {
    const theta = Math.acos(dot), sin = Math.sin(theta)
    ka = Math.sin((1 - t) * theta) / sin
    kb = (Math.sin(t * theta) / sin) * s
  }
  const x = ka * a.x + kb * b.x, y = ka * a.y + kb * b.y, z = ka * a.z + kb * b.z, w = ka * a.w + kb * b.w
  const n = Math.hypot(x, y, z, w) || 1
  return { x: x / n, y: y / n, z: z / n, w: w / n }
}

/** The pose `t` of the way from `a` to `b`: the position along the line, the turn along the arc. */
export const interpolate = (a: PoseLike, b: PoseLike, t: number): PoseLike => ({
  position: {
    x: a.position.x + (b.position.x - a.position.x) * t,
    y: a.position.y + (b.position.y - a.position.y) * t,
    z: a.position.z + (b.position.z - a.position.z) * t,
  },
  rotation: slerp(a.rotation, b.rotation, t),
})

/** Does `point` (in the view's space) fall inside the view: in front of the camera and within its
 *  picture — `projection` × `inverseView` × point in clip space, |x|, |y| ≤ w, w > 0.
 *  `inverseView` = the inverse of the view's pose (view.transform.inverse.matrix). */
export const projectsInside = (point: V3, projection: ArrayLike<number>, inverseView: ArrayLike<number>): boolean => {
  const v = inverseView, p = projection
  // the point in the camera
  const cx = v[0]! * point.x + v[4]! * point.y + v[8]! * point.z + v[12]!
  const cy = v[1]! * point.x + v[5]! * point.y + v[9]! * point.z + v[13]!
  const cz = v[2]! * point.x + v[6]! * point.y + v[10]! * point.z + v[14]!
  const cw = v[3]! * point.x + v[7]! * point.y + v[11]! * point.z + v[15]!
  // and in clip space
  const x = p[0]! * cx + p[4]! * cy + p[8]! * cz + p[12]! * cw
  const y = p[1]! * cx + p[5]! * cy + p[9]! * cz + p[13]! * cw
  const w = p[3]! * cx + p[7]! * cy + p[11]! * cz + p[15]! * cw
  return w > 0 && Math.abs(x) <= w && Math.abs(y) <= w
}
