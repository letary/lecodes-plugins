//
//  PushService.kt — lecodes-plugins/push
//
//  One session of the "push" service: the contract's PushPlugin (Push.gen.kt reads the calls off
//  the wire) over PushManager, where all the state lives. getStatus deliberately works without a
//  project identity and never prompts — the SDK's Push.addEventListener pokes the session open
//  with it to establish the event pipe.
//

package io.letary.lecodes.plugins.push

import io.letary.lecodes.services.Reply

class PushService(private val events: PushEvents) : PushPlugin {

    init {
        PushManager.addSession(events)
    }

    override fun getStatus(reply: Reply<PushStatus, PushCode>) = reply.resolve(PushManager.getStatus())

    override fun register(options: PushRegisterOptions?, reply: Reply<PushRegistration, PushCode>) =
        PushManager.register(reply, options?.user?.takeIf { it.isNotEmpty() })

    override fun unregister(reply: Reply<Unit, PushCode>) = PushManager.unregister(reply)

    override fun getLaunch(reply: Reply<PushPayload?, PushCode>) = reply.resolve(PushManager.getLaunch())

    override fun close() {
        PushManager.removeSession(events)
    }
}
