// AR object-placement controls — the classic "drop a model in the room and manipulate it" gesture
// recipe: ONE finger drags the target across the ground plane at its own height, by the finger's
// move and relative to where the camera looks — the model never jumps to the finger, and no session
// call is in the loop, so it behaves the same on every host (the web too). Not under the finger on
// purpose: the finger's ray onto the floor (a hit test, or the plane at the target's height) is
// metres per point near the horizon, and there the target flies off at the slightest move. TWO
// fingers pinch to scale and twist to rotate (yaw). Lives on ARScene (`scene.addControls`) because it
// orchestrates the scene's camera and touch input against a target node; it's built entirely on the
// public API, so it's a convenience, not a primitive.

import { Quat, Vec2, Vec3, type Node, type Scene, type TouchStartEvent } from "lecodes-sdk/plugin"

export type ControlsOptions = {
  /** Smallest uniform scale the pinch gesture allows (default 0.08). */
  minScale?: number
  /** Largest uniform scale the pinch gesture allows (default 2). */
  maxScale?: number
  /** One-finger drag moves the target across the ground plane, at its height (default true). */
  pan?: boolean
  /** Two-finger pinch scales the target (default true). */
  pinch?: boolean
  /** Two-finger twist rotates the target around its Y axis (default true). */
  twist?: boolean
}

/** Returned by `addControls` — call `remove()` to detach the gesture listeners. */
export type ControlsHandle = { remove(): void }

type ActiveTouch = { pointerId: number, x: number, y: number }

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export const attachControls = (scene: Scene, target: Node, options: ControlsOptions = {}): ControlsHandle => {
  const minScale = options.minScale ?? 0.08
  const maxScale = options.maxScale ?? 2
  const pan = options.pan ?? true
  const pinch = options.pinch ?? true
  const twist = options.twist ?? true

  const active: ActiveTouch[] = []

  const onTouchStart = (e: TouchStartEvent<Node | null>): void => {
    const touch: ActiveTouch = { pointerId: e.pointerId, x: e.clientX, y: e.clientY }
    active.push(touch)
    e.track({
      onMove(m) {
        if (active.length === 2) {
          // --- two-finger: pinch-scale + twist-rotate about the gesture axis ---
          const other = active.find((t) => t !== touch)
          if (other) {
            const axis = new Vec2(other.x - touch.x, other.y - touch.y)
            const span = axis.length()
            if (span > 1e-3) {
              const dir = axis.scale(1 / span)
              const delta = new Vec2(m.deltaX, m.deltaY)
              if (pinch) {
                const along = -dir.dot(delta) // movement along the pinch axis
                target.scale = clamp(target.scale.x * (span + along) / span, minScale * 0.4, maxScale * 1.5)
              }
              if (twist) {
                const tangent = dir.perp().dot(delta) // movement across the axis
                target.quaternion = target.quaternion.mul(Quat.fromAxisAngle(Vec3.up, Math.atan2(tangent, span)))
              }
            }
          }
        } else if (active.length === 1 && pan) {
          // --- one-finger: drag across the ground plane, relative to where the camera looks ---
          let dir = scene.camera.forward
          const parent = target.parent
          if (parent) dir = dir.rotate(parent.quaternion.invert()) // into the parent's local frame
          dir = dir.withY(0)
          const k = Math.hypot(dir.x, dir.z)
          // the move's delta over the view's size: both logical units (a scene touch's, displaySize's), so
          // a drag across the view slides the target by its distance from the camera on every host
          const screen = Math.max(...scene.camera.displaySize)
          if (k > 1e-4 && screen > 0) {
            const dist = target.worldPosition.distanceTo(scene.camera.worldPosition)
            const right = new Vec3(-dir.z, 0, dir.x).scale(m.deltaX / k / screen * dist)
            const fwd = dir.scale(-m.deltaY / k / screen * dist)
            const move = right.add(fwd)
            const p = target.position
            target.position = new Vec3(p.x + move.x, p.y, p.z + move.z) // keep height fixed
          }
        }
        touch.x = m.clientX
        touch.y = m.clientY
      },
      onEnd() {
        const i = active.indexOf(touch)
        if (i >= 0) active.splice(i, 1)
      },
    })
  }

  scene.addEventListener("touchstart", onTouchStart)
  return { remove() { scene.removeEventListener("touchstart", onTouchStart); active.length = 0 } }
}
