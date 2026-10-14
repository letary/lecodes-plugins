// The turn of the camera on the back of a device, from what its sensors say, in the scene's world (Y
// up, −Z ahead). Two sources:
//   - `devicemotion`: the gyroscope (`rotationRate`, degrees a second about the device's axes) and the
//     accelerometer with gravity (`accelerationIncludingGravity`), fused by a Mahony filter — the
//     gyroscope turns the estimate, gravity pulls its tilt back true. No compass: the heading only
//     ever moves as the device turns, it never jumps;
//   - `deviceorientation` (alpha about Z, beta about X', gamma about Y'', degrees): the browser's own
//     fused angles, where there is no `devicemotion` with a gyroscope.
// The device's frame: x to the right of the screen, y to its top, z out of it at the viewer. The
// earth's: x east, y north, z up. A quaternion is [x, y, z, w]; `a ⊗ b` turns by b, then by a.
//
// Imports nothing: a part of the plugin's web half (./ar.ts).

export type Quat = [x: number, y: number, z: number, w: number]
export type Vec3 = [x: number, y: number, z: number]

const RAD = Math.PI / 180

export const multiply = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]

const normalize = (q: Quat): Quat => {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

/** A turn by `angle` radians about a unit axis. */
export const aboutAxis = (axis: Vec3, angle: number): Quat => {
  const s = Math.sin(angle / 2)
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]
}

/** Where a vector points after the turn. */
export const turned = (q: Quat, v: Vec3): Vec3 => {
  const [x, y, z, w] = q
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0])
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ]
}

/** The device's turn (device → earth) from a `deviceorientation` event: Z by alpha, then X' by beta,
 *  then Y'' by gamma, in degrees. */
export const fromAngles = (alpha: number, beta: number, gamma: number): Quat =>
  multiply(multiply(aboutAxis([0, 0, 1], alpha * RAD), aboutAxis([1, 0, 0], beta * RAD)), aboutAxis([0, 1, 0], gamma * RAD))

/** Up (the earth's Z) as the device sees it, by its turn. */
export const upOf = (q: Quat): Vec3 => {
  const [x, y, z, w] = q
  return [2 * (x * z - w * y), 2 * (w * x + y * z), w * w - x * x - y * y + z * z]
}

/** The turn that takes the unit vector `from` onto `to`. */
const between = (from: Vec3, to: Vec3): Quat => {
  const d = from[0] * to[0] + from[1] * to[1] + from[2] * to[2]
  if (d < -0.999999) return [1, 0, 0, 0]   // opposite: half a turn about any perpendicular (X here)
  const c: Vec3 = [from[1] * to[2] - from[2] * to[1], from[2] * to[0] - from[0] * to[2], from[0] * to[1] - from[1] * to[0]]
  return normalize([c[0], c[1], c[2], 1 + d])
}

/**
 * Mahony's filter (6 axes: a gyroscope and an accelerometer): `q` is the device's turn, device →
 * earth. `update` integrates the gyroscope and corrects the tilt by the angle between the measured up
 * (the accelerometer, at rest) and the estimated one; nothing corrects the heading, so it drifts
 * slowly and never jumps.
 */
export class Mahony {
  q: Quat = [0, 0, 0, 1]
  private seeded = false
  private ix = 0
  private iy = 0
  private iz = 0

  constructor(private readonly kp = 1, private readonly ki = 0.05) {}

  get ready(): boolean { return this.seeded }

  /** Start from a known turn (a `deviceorientation`'s), or from the measured up alone. */
  seed(q: Quat): void {
    this.q = normalize(q)
    this.seeded = true
  }

  /** `g`: the gyroscope, radians a second about the device's x, y, z; `a`: up as the accelerometer
   *  measures it (at rest, gravity's reaction), any unit; `dt` in seconds. */
  update(g: Vec3, a: Vec3, dt: number): void {
    const n = Math.hypot(a[0], a[1], a[2])
    if (!this.seeded) {
      if (n === 0) return
      // the tilt from gravity, the heading where the device looks now
      this.seed(between([a[0] / n, a[1] / n, a[2] / n], [0, 0, 1]))
      return
    }
    let gx = g[0], gy = g[1], gz = g[2]
    if (n > 0) {
      const ax = a[0] / n, ay = a[1] / n, az = a[2] / n
      const v = upOf(this.q)
      // the error: the measured up × the estimated up
      const ex = ay * v[2] - az * v[1], ey = az * v[0] - ax * v[2], ez = ax * v[1] - ay * v[0]
      if (this.ki > 0) {
        this.ix += this.ki * ex * dt
        this.iy += this.ki * ey * dt
        this.iz += this.ki * ez * dt
        gx += this.ix; gy += this.iy; gz += this.iz
      }
      gx += this.kp * ex; gy += this.kp * ey; gz += this.kp * ez
    }
    // q̇ = ½ q ⊗ (ω, 0)
    const hx = 0.5 * dt * gx, hy = 0.5 * dt * gy, hz = 0.5 * dt * gz
    const [x, y, z, w] = this.q
    this.q = normalize([
      x + w * hx + y * hz - z * hy,
      y + w * hy - x * hz + z * hx,
      z + w * hz + x * hy - y * hx,
      w - x * hx - y * hy - z * hz,
    ])
  }
}

// The earth (x east, y north, z up) in the scene's world (x, y up, −z ahead): −90° about X.
const EARTH: Quat = aboutAxis([1, 0, 0], -Math.PI / 2)

/** The camera's turn in the scene from the device's (device → earth) and how the page is turned on
 *  the screen (`screen.orientation.angle`): the back camera's frame is the device's, turned about
 *  its view axis with the page. */
export const cameraTurn = (device: Quat, screenAngle: number): Quat =>
  multiply(multiply(EARTH, device), aboutAxis([0, 0, 1], -screenAngle * RAD))

/** The turn about the scene's Y that brings where the camera looks (or, looking straight down or up,
 *  where its top points) to −Z: what a session's world begins with, as ARKit's and ARCore's do. */
export const headingZero = (camera: Quat): Quat => {
  let [fx, , fz] = turned(camera, [0, 0, -1])
  if (Math.hypot(fx, fz) < 0.3) [fx, , fz] = turned(camera, [0, 1, 0])
  return aboutAxis([0, 1, 0], -Math.atan2(-fx, -fz))
}

/** A turn as a column-major 4×4 matrix (no translation). */
export const matrixOf = (q: Quat): number[] => {
  const [x, y, z, w] = q
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 0,
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 0,
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ]
}

/** The vertical angle of view (degrees) of a camera's picture that COVERS a box: the picture is
 *  `videoWidth` × `videoHeight` with `longFov` degrees along its longer side, and is cut to the
 *  box's proportions. */
export const coveredFov = (videoWidth: number, videoHeight: number, boxWidth: number, boxHeight: number, longFov: number): number => {
  const focal = Math.max(videoWidth, videoHeight) / 2 / Math.tan((longFov * RAD) / 2)
  const scale = Math.max(boxWidth / videoWidth, boxHeight / videoHeight)
  return (2 * Math.atan(boxHeight / scale / 2 / focal)) / RAD
}

/** A perspective projection (column-major, OpenGL clip conventions). */
export const perspective = (fovY: number, aspect: number, near: number, far: number): number[] => {
  const f = 1 / Math.tan((fovY * RAD) / 2)
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]
}

/** The rows [a b tx; c d ty] of the map from the box's normalized point to the picture's, for a
 *  picture that covers the box (cut at the sides or at the top and bottom, centred). */
export const coverUV = (videoWidth: number, videoHeight: number, boxWidth: number, boxHeight: number): number[] => {
  const scale = Math.max(boxWidth / videoWidth, boxHeight / videoHeight)
  const sx = boxWidth / (videoWidth * scale), sy = boxHeight / (videoHeight * scale)
  return [sx, 0, (1 - sx) / 2, 0, sy, (1 - sy) / 2]
}
