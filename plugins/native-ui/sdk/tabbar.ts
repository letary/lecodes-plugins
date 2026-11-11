// UIGlassTabBarNode — the platform's tab bar as a node of the layout: on iOS 26+ the system Liquid
// Glass bar (the capsule, the sliding selection, the press growth), drawn by UIKit. The app keeps the
// state — the tabs, the selection, the badges — and the host only translates (contract.d.ts: the
// host node "tabbar").
//
// Hand-written over the generated element (native-ui.gen.ts) for the app's shape of it: the tabs as
// `defs` (the `defineTabs` shape, a label and an optional icon — the icon's wire spelling is made
// here), `badge(id, v)` and `select(id)` rewriting the props, `onSelect` with the id and the index,
// and the theme's tab colors as the default `tintColor` / `color`. Its height is the bar's own: the
// host measures it.

import { TAB_ACTIVE_COLOR, TAB_INACTIVE_COLOR, imageSrcWire, toSrc, type HostNodeElement, type ImageSource } from "lecodes-sdk/plugin"
import type { TabItem } from "../contract"
import { GlassTabBarNode, type GlassTabBarNodeStyle } from "./native-ui.gen"

/** One tab: its label and an optional icon (`assetIcon("lucide:…")`, an image URL / asset). */
export interface UIGlassTab { label: string, icon?: ImageSource }

export type UIGlassTabBarNodeStyle = GlassTabBarNodeStyle

/**
 * The platform's own tab bar as a node. Keys are tab ids, in tab order:
 *
 * ```ts
 * const bar = UIGlassTabBarNode({
 *   home:    { label: "Home",    icon: assetIcon("lucide:house") },
 *   profile: { label: "Profile", icon: assetIcon("lucide:user") },
 * }).style({ position: "absolute", left: 16, right: 16, bottom: 24 })
 *   .onSelect((id, index) => pager.select(index))
 * ```
 *
 * Only the bar: placing it, the content inset under it (read its box: `onLayout`) and what a tab
 * shows are the app's. Branch on `UIGlassTabBarNode.supported`: where it is `false` (everywhere but
 * iOS 26+ today) the node is an empty box — draw your own bar there. The box takes the layout keys;
 * its height is the bar's own (the host measures it), its width the box's. The system draws its glass,
 * so `backgroundColor` and the backdrop are not painted on it. Colors: `tintColor` (the selected tab;
 * default the theme's `accent`) and `color` (the others; default `textMuted`).
 */
export interface UIGlassTabBarNode extends HostNodeElement<GlassTabBarNodeStyle> {
  /** The selected tab id — the first key until a tap or `select()`. */
  readonly selected: string
  /** Select a tab from code: the bar follows, `onSelect` does not fire. An unknown id warns. */
  select(id: string): this
  /** Fires when the user taps another tab: its id and index. */
  onSelect(callback: (id: string, index: number) => void): this
  /** A tab's badge: a number / a string = the text badge, `true` = a dot; `false` / `null` / `0` /
   *  `""` clears. An unknown id warns. */
  badge(id: string, value: number | string | boolean | null): this
}

/** Empty / absent = no badge; `true` is the dot. */
const badgeText = (value: number | string | boolean | null | undefined): string | undefined =>
  value === null || value === undefined || value === false || value === 0 || value === "" ? undefined
  : value === true ? "•" : String(value)

const item = (id: string, def: UIGlassTab): TabItem => {
  const icon = def.icon != null ? imageSrcWire(toSrc(def.icon)) : null
  return icon !== null ? { id, label: def.label, icon } : { id, label: def.label }
}

class GlassTabBarElement extends GlassTabBarNode {
  private readonly _ids: string[]

  constructor(tabs: Record<string, UIGlassTab>) {
    const ids = Object.keys(tabs)
    super({ items: ids.map(id => item(id, tabs[id])), selected: ids[0] ?? "" })
    this._ids = ids
    if (ids.length === 0) console.warn("UIGlassTabBarNode: no tabs declared")
    this.style({ alignSelf: "stretch", tintColor: TAB_ACTIVE_COLOR, color: TAB_INACTIVE_COLOR })
    // The user's tap: the selection follows before the app's listeners hear it. Written back, so
    // the prop is what the bar shows (the host leaves a selection it shows alone).
    super.onSelect(({ id }) => { this.selected = id })
  }

  select(id: string): this {
    if (!this._ids.includes(id)) {
      console.warn(`UIGlassTabBarNode.select: unknown tab "${id}"`)
      return this
    }
    if (id !== this.selected) this.selected = id
    return this
  }

  // The app's listener takes the payload spread (the interface's shape); the parameter type is
  // widened only for the generated signature it replaces.
  override onSelect(callback: ((id: string, index: number) => void) | ((payload: { id: string, index: number }) => void)): this {
    const cb = callback as (id: string, index: number) => void
    return super.onSelect(({ id, index }) => cb(id, index))
  }

  badge(id: string, value: number | string | boolean | null): this {
    const items = this.items ?? []
    const at = items.findIndex(t => t.id === id)
    if (at < 0) {
      console.warn(`UIGlassTabBarNode.badge: unknown tab "${id}"`)
      return this
    }
    const text = badgeText(value)
    if (items[at].badge === text) return this
    const { badge: _, ...rest } = items[at]
    const next = items.slice()
    next[at] = text === undefined ? rest : { ...rest, badge: text }
    this.items = next
    return this
  }
}

/**
 * Create the system tab bar — see {@link UIGlassTabBarNode}. Keys are tab ids in tab order; each tab
 * has a `label` and an optional `icon`. Default style `alignSelf: "stretch"`, `tintColor` / `color`
 * from the theme's `accent` / `textMuted`.
 */
// PURE IIFE so an app that never builds a tab bar tree-shakes the whole plugin away.
export const UIGlassTabBarNode: {
  (tabs: Record<string, UIGlassTab>): UIGlassTabBarNode
  /** Does this host draw the system tab bar (iOS 26+ today)? Read at run time, on every access. */
  readonly supported: boolean
} = /*#__PURE__*/ (() => {
  const factory = (tabs: Record<string, UIGlassTab>): UIGlassTabBarNode =>
    new GlassTabBarElement(tabs) as unknown as UIGlassTabBarNode
  Object.defineProperty(factory, "supported", { get: (): boolean => GlassTabBarNode.supported })
  return factory as any
})()
