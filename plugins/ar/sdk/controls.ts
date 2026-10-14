// AR object-placement controls — the classic "drop a model in the room and manipulate it" gesture
// recipe: ONE finger drags the target over what the session finds under the finger (`hitTest`: a
// plane), and where it finds nothing — the web, which finds no surfaces, or before one is known —
// across the ground plane, relative to where the camera looks; TWO fingers pinch to scale and twist
// to rotate (yaw). Lives on ARScene (`scene.addControls`) because it orchestrates the scene's camera,
// its hit test and touch input against a target node; it's built entirely on the public API, so
// it's a convenience, not a primitive.

import { Quat, Vec2, Vec3, type Node, type Scene, type TouchStartEvent } from "lecodes-sdk/plugin"
import type { HitTarget } from "../contract"

export type ControlsOptions = {
  /** Smallest uniform scale the pinch gesture allows (default 0.08). */
  minScale?: number
  /** Largest uniform scale the pinch gesture allows (default 2). */
  maxScale?: number
  /** One-finger drag moves the target over the surfaces under the finger (default true). */
  pan?: boolean
  /** Two-finger pinch scales the target (default true). */
  pinch?: boolean
  /** Two-finger twist rotates the target around its Y axis (default true). */
  twist?: boolean
}

/** Returned by `addControls` — call `remove()` to detach the gesture listeners. */
export type ControlsHandle = { remove(): void }

/** The scene the controls work on: ARScene's hit test, a Scene's camera and touches. */
type PlacingScene = Scene & {
  hitTest(x: number, y: number, target?: HitTarget): Promise<{ pose: { position: Vec3 } }[]>
}

type ActiveTouch = { pointerId: number, x: number, y: number }

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export const attachControls = (scene: PlacingScene, target: Node, options: ControlsOptions = {}): ControlsHandle => {
  const minScale = options.minScale ?? 0.08
  const maxScale = options.maxScale ?? 2
  const pan = options.pan ?? true
  const pinch = options.pinch ?? true
  const twist = options.twist ?? true

  const active: ActiveTouch[] = []
  let removed = false

  // --- one finger: the hit test is a call to the session, so ONE is in flight at a time; the moves
  // that come meanwhile add up and go with the next ---
  let pending: { x: number, y: number, dx: number, dy: number } | null = null
  let asking = false

  /** The target onto a point of the world, its height and turn kept by the surface's. */
  const placeAt = (world: Vec3): void => {
    const w = target.worldMatrix.toArray()
    w[12] = world.x; w[13] = world.y; w[14] = world.z
    target.worldMatrix = w
  }

  /** Nothing under the finger: across the ground plane, relative to where the camera looks. */
  const slide = (dx: number, dy: number): void => {
    let dir = scene.camera.forward
    const parent = target.parent
    if (parent) dir = dir.rotate(parent.quaternion.invert()) // into the parent's local frame
    dir = dir.withY(0)
    const k = Math.hypot(dir.x, dir.z)
    const screen = Math.max(...scene.camera.displaySize)
    if (k > 1e-4 && screen > 0) {
      const dist = target.worldPosition.distanceTo(scene.camera.worldPosition)
      const right = new Vec3(-dir.z, 0, dir.x).scale(dx / k / screen * dist)
      const fwd = dir.scale(-dy / k / screen * dist)
      const move = right.add(fwd)
      const p = target.position
      target.position = new Vec3(p.x + move.x, p.y, p.z + move.z) // keep height fixed
    }
  }

  const ask = (): void => {
    const drag = pending
    if (!drag || asking) return
    pending = null
    asking = true
    scene.hitTest(drag.x, drag.y, "planes").catch(() => []).then((hits) => {
      asking = false
      if (removed) return
      const hit = hits[0]
      if (hit) placeAt(hit.pose.position)
      else slide(drag.dx, drag.dy)
      ask()
    })
  }

  const drag = (x: number, y: number, dx: number, dy: number): void => {
    if (pending) { pending.x = x; pending.y = y; pending.dx += dx; pending.dy += dy }
    else pending = { x, y, dx, dy }
    ask()
  }

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
          drag(m.clientX, m.clientY, m.deltaX, m.deltaY)
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
  return {
    remove() {
      removed = true
      pending = null
      scene.removeEventListener("touchstart", onTouchStart)
      active.length = 0
    },
  }
}
