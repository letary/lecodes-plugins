// The depth scale of the ar plugin's QR targets (./qrAnchor.ts): a self-calibration by parallax.
//
// The detector solves a code's pose from the camera's intrinsics, derived from the view's projection
// (qr-anchor's Intrinsics::from_gl_projection). When those are a few percent off — the focal of the
// camera's picture larger than the projection says (autofocus "breathing" at close range, the camera
// image's field of view not exactly the view's) — the fit is still right at the viewpoint it was
// taken from, but every solved translation is short by ONE factor: its direction right, its length
// not. The first phone run (Xiaomi 11T Pro, a 3 cm code at 25–45 cm) showed it: the square covered
// the symbol where it was found and sat ~2 cm closer than the code once the camera moved.
//
// The factor is seen through the camera's own motion (ARCore's poses, metres). Observation i: the
// camera's rotation R_i and position p_i in the session's space (the picture's view matrix) and the
// code's centre in the camera c_i (the translation of matrix_gl). With u_i = R_i c_i the true centre
// is X = p_i + a · u_i for one scalar a and one point X; least squares over the observations kept:
//
//   a = − Σ (u_i − ū)·(p_i − p̄) / Σ |u_i − ū|²,   X = p̄ + a ū,   residual = RMS |a u_i + p_i − X|
//
// Without parallax a is not seen (the camera in one place: every u_i the same), so a fit asks for a
// baseline — the camera positions at least 4 cm apart — and a spread of the u_i (their RMS about ū at
// least 1 cm: the noise of c_i sits in the regressor, which biases a low by about σ² / spread², ~1 %
// at 1 mm of noise and this gate). `createDepthScale` is the per-code state: a window of the last 24
// observations, a fit per observation (a clamped to 0.8 … 1.25), taken when its residual is at most
// 8 mm, and the applied scale moving a quarter of the way to each estimate taken (never a jump).
//
// Imports nothing, so a test runs it as it is (hosts/web-lite/tests/arDepthScale.test.ts).

export type V3 = { x: number, y: number, z: number }

/** One observation: the camera's position `p` and the code's centre in the camera turned into the
 *  session's axes, `u` = R c (both metres, the session's space). */
export type DepthObservation = { p: V3, u: V3 }

export const DEPTH_SCALE = {
  /** the observations a code keeps: the last ones */
  window: 24,
  /** the fewest a fit is made of */
  minObservations: 6,
  /** the largest distance between two camera positions, at least (m) */
  minBaseline: 0.04,
  /** the RMS of |u_i − ū|, at least (m) */
  minSpread: 0.01,
  /** a is clamped to this */
  min: 0.8,
  max: 1.25,
  /** a fit is taken when its residual is at most this (m) */
  maxResidual: 0.008,
  /** the applied scale moves this part of the way to each estimate taken after the first (the first
   *  one applies in full) */
  step: 0.25,
}
export type DepthScaleGates = typeof DEPTH_SCALE

/** The observation of a picture: its view matrix (column-major 4×4, the camera in the session's
 *  space) and the code's centre in the camera (matrix_gl's translation, GL axes). */
export const depthObservation = (view: ArrayLike<number>, c: V3): DepthObservation => ({
  p: { x: view[12]!, y: view[13]!, z: view[14]! },
  u: {
    x: view[0]! * c.x + view[4]! * c.y + view[8]! * c.z,
    y: view[1]! * c.x + view[5]! * c.y + view[9]! * c.z,
    z: view[2]! * c.x + view[6]! * c.y + view[10]! * c.z,
  },
})

/** A fit: `scale` = a (clamped), `unclamped` = the least squares' own, `point` = X, `residual` =
 *  the RMS of |a u_i + p_i − X| (m), `baseline` = the largest |p_i − p_j| (m), `spread` = the RMS of
 *  |u_i − ū| (m), `n` = the observations. */
export type DepthFit = { scale: number, unclamped: number, point: V3, residual: number, baseline: number, spread: number, n: number }

/** The least squares of a and X over `obs`; null when they do not show a: fewer than
 *  `minObservations`, a baseline under `minBaseline`, a spread under `minSpread`. */
export const fitDepthScale = (obs: readonly DepthObservation[], gates: DepthScaleGates = DEPTH_SCALE): DepthFit | null => {
  const n = obs.length
  if (n < Math.max(2, gates.minObservations)) return null
  let baseline = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = obs[i]!.p, b = obs[j]!.p
      baseline = Math.max(baseline, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z))
    }
  }
  if (!(baseline >= gates.minBaseline)) return null
  let px = 0, py = 0, pz = 0, ux = 0, uy = 0, uz = 0
  for (const { p, u } of obs) {
    px += p.x; py += p.y; pz += p.z
    ux += u.x; uy += u.y; uz += u.z
  }
  px /= n; py /= n; pz /= n
  ux /= n; uy /= n; uz /= n
  let up = 0, uu = 0
  for (const { p, u } of obs) {
    const dux = u.x - ux, duy = u.y - uy, duz = u.z - uz
    up += dux * (p.x - px) + duy * (p.y - py) + duz * (p.z - pz)
    uu += dux * dux + duy * duy + duz * duz
  }
  const spread = Math.sqrt(uu / n)
  if (!(spread >= gates.minSpread)) return null
  const unclamped = -up / uu
  const a = Math.min(gates.max, Math.max(gates.min, unclamped))
  const point = { x: px + a * ux, y: py + a * uy, z: pz + a * uz }
  let r2 = 0
  for (const { p, u } of obs) {
    const ex = a * u.x + p.x - point.x, ey = a * u.y + p.y - point.y, ez = a * u.z + p.z - point.z
    r2 += ex * ex + ey * ey + ez * ez
  }
  return { scale: a, unclamped, point, residual: Math.sqrt(r2 / n), baseline, spread, n }
}

/** What one observation did: the window's fit (null: not enough parallax yet), and whether it was
 *  taken (its residual within the gate). */
export type DepthStep = { fit: DepthFit | null, taken: boolean }

/** A code's depth scale: its window, the last estimate taken, the scale applied now (1 until the
 *  first estimate is taken). */
export const createDepthScale = (gates: DepthScaleGates = DEPTH_SCALE) => {
  const window: DepthObservation[] = []
  let scale = 1
  let estimate: number | null = null
  return {
    /** The scale to apply to a solved translation now. */
    get scale() { return scale },
    /** The last estimate taken, null before the first. */
    get estimate() { return estimate },
    /** An observation in (the raw one: its c not scaled): the window refit, the scale moved a
     *  `step` of the way to the estimate when it is taken; otherwise the scale stays. */
    add(o: DepthObservation): DepthStep {
      window.push(o)
      if (window.length > gates.window) window.splice(0, window.length - gates.window)
      const fit = fitDepthScale(window, gates)
      if (!fit || !(fit.residual <= gates.maxResidual)) return { fit, taken: false }
      // the first estimate taken applies in full (the scale was a guess of 1 until now: a code
      // placed at the wrong depth is better moved at once); the next ones move `step` of the way
      scale += (estimate === null ? 1 : gates.step) * (fit.scale - scale)
      estimate = fit.scale
      return { fit, taken: true }
    },
    reset() {
      window.length = 0
      scale = 1
      estimate = null
    },
  }
}

export type DepthScale = ReturnType<typeof createDepthScale>
