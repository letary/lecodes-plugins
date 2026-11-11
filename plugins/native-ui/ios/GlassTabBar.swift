//
//  GlassTabBar.swift — lecodes-plugins/native-ui
//
//  The host node "tabbar" (contract.d.ts; the glue is GlassTabBarNode.gen.swift): a standalone
//  UITabBar — on iOS 26 the Liquid Glass capsule with the sliding selection, the press growth and the
//  glass under the marker, all UIKit's own. The app keeps the control (UIGlassTabBarNode: the tabs,
//  the selection, the badges); this half only translates. The core's holder (UINodeHost) lays the
//  instance's view out as the node's box and paints the box over it.
//
//  The rules (moved from the core's hand-written tab bar node, docs/plans/glass-tabbar-plan.md):
//   - Registered on iOS 26+ only: the glass bar is what the node is for. Elsewhere the kind is not
//     registered, `supported` answers false and the app draws its own bar.
//   - `items` is the whole list, written again for any change (a badge too): one UITabBarItem per tab
//     id, kept across writes — the title, the badge (empty = none: `badgeValue = ""` shows an empty
//     badge) and the icon change in place, the bar's item list is set again only when the tabs or
//     their order changed. The icon is an image's wire spelling, drawn into 25×25 pt at the screen
//     scale (ImageSources, the renderer's reading of image sources) as a TEMPLATE image: UIKit
//     tints tab icons itself. An icon that lands after a later one was asked for is dropped.
//   - `selected` (a tab id) is the app's write: it sets selectedItem silently, and leaves the item
//     already shown alone (the app writes the selection back after every tap it takes; re-setting it
//     would cut the selection animation short). The user's tap (UITabBarDelegate) emits `select` with
//     the id and the index, only when it changes the selection the bar shows.
//   - The colors are the node's STYLES, resolved by the core (var(), theme changes): `tintColor` is
//     the selected item's, `color` the others' (unselectedItemTintColor); none = UIKit's defaults.
//   - The box: the instance's view is a plain box (TabBarBox) holding the bar, because a standalone
//     UITabBar lays its capsule (the platter) out ABOVE a fixed 21 pt it keeps at its bottom for the
//     home-indicator gap (iOS 26.5, measured: platter height = bar height − 21 at any height, whatever
//     safeAreaInsets say). So the bar is `platterGap` taller than the box, its top at the box's top:
//     the capsule fills the box's height and the gap hangs under it, transparent and outside the box
//     for hit-testing (UIView drops a point outside its bounds). Across, UIKit keeps the platter at
//     least 21 pt inside each edge (two tabs: a capsule of 188 pt, centred) — the bar's own layout.
//   - The size (`measure: true`): the width given (UIKit's natural width — what `sizeThatFits`
//     answers, the screen's — when unconstrained) × the natural capsule height, from the bar's own
//     answer (`sizeThatFits` − the gap: 62 pt on iOS 26.5; below it the label runs into the icon).
//   - The system draws its glass: the node's background and backdrop are the holder's box paint
//     (none by default); `overflow` stays `visible` (the default) so the capsule's press growth and
//     shadow can leave the box.
//

import UIKit
import LeCodes

/// One tab bar of the app.
final class GlassTabBar: GlassTabBarNodeInstance {
    /// What a standalone UITabBar keeps under its platter (iOS 26.5, measured).
    static let platterGap: CGFloat = 21
    static let iconSize = CGSize(width: 25, height: 25)

    private let box = TabBarBox()
    var view: UIView { box }
    private var bar: TabBarView { box.bar }
    private let events: GlassTabBarNodeEvents
    /// The item of each tab id, kept across `items` writes.
    private var tabs: [String: Tab] = [:]
    /// The tabs in the bar's order.
    private var order: [Tab] = []
    /// The selection the bar shows: the app's last `selected`, or the user's tap since.
    private var selectedId: String?

    init(_ events: GlassTabBarNodeEvents) {
        self.events = events
        bar.onSelect = { [weak self] item in self?.userSelected(item) }
    }

    func set(items list: [TabItem]) {
        var kept: [String: Tab] = [:]
        var next: [Tab] = []
        for item in list where kept[item.id] == nil {   // an id twice: its first
            let tab = tabs[item.id] ?? Tab(id: item.id)
            tab.update(item, index: next.count)
            kept[item.id] = tab
            next.append(tab)
        }
        for (id, gone) in tabs where kept[id] == nil { gone.cancel() }
        tabs = kept
        let items = next.map(\.item)
        if !items.elementsEqual(bar.items ?? [], by: ===) { bar.setItems(items, animated: false) }
        order = next
        applySelection()
    }

    func set(selected: String) {
        selectedId = selected
        applySelection()
    }

    func setStyle(tintColor: UIColor?) { bar.tintColor = tintColor }
    func setStyle(color: UIColor?) { bar.unselectedItemTintColor = color }

    func measure(_ c: HostNodeConstraints) -> CGSize {
        let natural = bar.sizeThatFits(CGSize(width: c.width ?? 0, height: 0))
        return CGSize(width: c.width ?? natural.width, height: max(0, natural.height - GlassTabBar.platterGap))
    }

    func destroy() {
        for tab in order { tab.cancel() }
        bar.onSelect = nil
    }

    /// Silent: a programmatic selectedItem calls no delegate. The item already shown is left alone.
    private func applySelection() {
        let target = selectedId.flatMap { tabs[$0]?.item }
        if bar.selectedItem !== target { bar.selectedItem = target }
    }

    /// The user tapped `item` (TabBarView, the delegate).
    private func userSelected(_ item: UITabBarItem) {
        guard let index = order.firstIndex(where: { $0.item === item }) else { return }
        let id = order[index].id
        guard id != selectedId else { return }
        selectedId = id
        events.select(id: id, index: Int32(index))
    }
}

/// A tab's item and its icon's load.
private final class Tab {
    let id: String
    let item = UITabBarItem()
    /// The icon's spelling asked for last.
    private var icon: String?
    private var request: ImageSources.Request?

    init(id: String) { self.id = id }

    func update(_ tab: TabItem, index: Int) {
        item.tag = index
        if item.title != tab.label { item.title = tab.label }
        let badge = (tab.badge?.isEmpty ?? true) ? nil : tab.badge
        if item.badgeValue != badge { item.badgeValue = badge }
        if tab.icon != icon { setIcon(tab.icon) }
    }

    private func setIcon(_ src: String?) {
        request?.cancel()
        request = nil
        icon = src
        guard let src else { item.image = nil; return }
        request = ImageSources.image(src, fitting: GlassTabBar.iconSize) { [weak self] image in
            guard let self, self.icon == src else { return }
            self.request = nil
            self.item.image = image?.withRenderingMode(.alwaysTemplate)
        }
    }

    func cancel() {
        request?.cancel()
        request = nil
    }
}

/// The instance's view: the UITabBar inside it, `platterGap` taller than the box (the header's rule).
final class TabBarBox: UIView {
    let bar = TabBarView()

    init() {
        super.init(frame: .zero)
        clipsToBounds = false
        addSubview(bar)
    }
    @available(*, unavailable) required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        bar.frame = CGRect(x: 0, y: 0, width: bounds.width, height: bounds.height + GlassTabBar.platterGap)
    }
}

/// The bar, its own delegate: the tap is forwarded to the instance.
final class TabBarView: UITabBar, UITabBarDelegate {
    var onSelect: ((UITabBarItem) -> Void)?

    init() {
        super.init(frame: .zero)
        delegate = self
        clipsToBounds = false
    }
    @available(*, unavailable) required init?(coder: NSCoder) { nil }

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) { onSelect?(item) }
}
