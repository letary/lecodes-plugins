// tabbar — the system tab bar as a HOST NODE (docs/plans/host-node-plan.md in core): a node of the
// layout the host draws with the platform's control — on iOS 26+ a standalone UITabBar, the Liquid
// Glass capsule with its sliding selection, the press growth and the glass under the marker, all
// UIKit's own. The app keeps the state (the tabs, the selection, the badges: the wrapper in sdk/);
// the host only translates. No children: the tabs are one prop.

import type { UIHostNode, i32 } from "lecodes-sdk/plugin"

/** One tab of the bar. */
export interface TabItem {
  /** What `selected` names and `select` reports. */
  id: string
  label: string
  /** The icon in an image's wire spelling — `svg:<markup>`, `id:<bufferId>`, a url (the contract
   *  has no image type: the wrapper spells the app's `ImageSource`). Drawn as a template image the
   *  bar tints. Absent = no icon. */
  icon?: string
  /** The badge's text, "•" for a dot. Absent = none. */
  badge?: string
}

export interface TabBarProps {
  /** The tabs, in order. */
  items: TabItem[]
  /** The id of the selected tab. Writing it reports nothing. */
  selected: string
}

export interface TabBarEvents {
  /** The user tapped another tab than the selected one: its id and index. */
  select: { id: string, index: i32 }
}

/** The platform's tab bar. Its box is laid out like any node's; its height is the bar's own (the
 *  host measures it); the system draws its glass, so `backgroundColor` and the backdrop are not
 *  painted. Colors: `tintColor` = the selected tab, `color` = the others. */
export interface GlassTabBar extends UIHostNode<"tabbar", TabBarProps, TabBarEvents> {
  styles: "tintColor" | "color"
  measure: true
}
