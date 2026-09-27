//
//  PushService.swift — lecodes-plugins/push
//
//  One session of the "push" service: the calls go to PushManager with the identity of the world
//  that makes them, the events come back through this session while it is open. The channel is
//  Push.gen.swift, generated from contract.d.ts.
//

import Foundation
import LeCodes

public final class PushService: PushPlugin {

    let events: PushEvents
    private weak var engine: LeCodesEngine?

    init(_ events: PushEvents, _ engine: LeCodesEngine?) {
        self.events = events
        self.engine = engine
        PushManager.shared.attach(self)
    }

    // Permission is host-wide and `registered` is false without an identity, so getStatus works in
    // an unattributed world too: the SDK's listener-pipe poke never rejects.
    public func getStatus(_ reply: Reply<PushStatus, PushCode>) {
        PushManager.shared.getStatus(engine?.currentProjectUuid, reply)
    }

    public func register(_ options: PushRegisterOptions?, _ reply: Reply<PushRegistration, PushCode>) {
        PushManager.shared.register(engine?.currentProjectUuid, options, reply)
    }

    public func unregister(_ reply: Reply<Void, PushCode>) {
        PushManager.shared.unregister(engine?.currentProjectUuid, reply)
    }

    public func getLaunch(_ reply: Reply<PushPayload?, PushCode>) {
        PushManager.shared.getLaunch(engine?.currentProjectUuid, reply)
    }

    public func close() {
        PushManager.shared.detach(self)
    }
}
