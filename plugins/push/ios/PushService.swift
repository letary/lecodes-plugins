//
//  PushService.swift — lecodes-plugins/push
//
//  The per-session "push" service adapter (docs/push-plan.md; the Geolocation recipe
//  applied to notifications):
//    call getStatus()        → { permission: "granted"|"denied"|"prompt", registered } — never prompts
//    call register({user?})  → { address }; OS permission prompt on first use;
//                              rejects "denied" / "unavailable"
//    call unregister()       → removes the registration (backend + local)
//    call getLaunch()        → the notification payload that cold-started this world, or null
//    event "message"         → payload arrived while this app was foregrounded (banner suppressed)
//    event "tap"             → payload tapped while this world was alive (warm)
//
//  Sessions open cheaply (no prompt, no I/O — the channel contract); every call resolves
//  the CURRENT world's identity at call time.
//

import Foundation
import LeCodesSDK

public final class PushService: ServiceInstance {

    let channel: ServiceChannel
    private weak var engine: LeCodesEngine?

    public init(_ channel: ServiceChannel, _ engine: LeCodesEngine?) {
        self.channel = channel
        self.engine = engine
        PushManager.shared.attach(self)
    }

    public func call(_ method: String, _ args: [Any], _ settle: ChannelSettle) {
        let uuid = engine?.currentProjectUuid
        switch method {
        case "getStatus":
            // Works without an identity (permission is host-wide; registered = false) so the
            // SDK's listener-pipe poke never rejects.
            PushManager.shared.getStatus(uuid, settle)
        case "register":
            PushManager.shared.register(uuid, args.first as? [String: Any], settle)
        case "unregister":
            PushManager.shared.unregister(uuid, settle)
        case "getLaunch":
            PushManager.shared.getLaunch(uuid, settle)
        default:
            settle.reject("Unknown method: \(method)")
        }
    }

    public func close() {
        PushManager.shared.detach(self)
    }
}
