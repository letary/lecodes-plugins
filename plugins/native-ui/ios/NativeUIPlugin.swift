//
//  NativeUIPlugin.swift — lecodes-plugins/native-ui
//
//  The platform's own controls as host nodes (contract.d.ts): the registration of each, a control
//  per file. A control is registered only where the system has it — elsewhere its kind is not
//  registered, `supported` answers false and the app draws its own.
//

import UIKit
import LeCodes

public enum LeCodesNativeUIPlugin {

    public static let pluginId = "native-ui"

    public static func register(in engine: LeCodesEngine) {
        // The tab bar (GlassTabBar.swift): the glass bar is what the node is for.
        if #available(iOS 26, *) {
            GlassTabBarNodeGlue.register(in: engine) { events in GlassTabBar(events) }
        }
    }
}
