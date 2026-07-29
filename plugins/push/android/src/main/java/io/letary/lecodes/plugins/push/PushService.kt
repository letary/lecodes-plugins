//
//  PushService.kt — lecodes-plugins/push
//
//  Per-session adapter for the "push" service (registerService — docs/push-plan.md). Method
//  dispatch only; all state lives in PushManager. getStatus deliberately works without a
//  project identity and never prompts — the SDK's Push.addEventListener pokes the session
//  open with it to establish the event pipe ("message"/"tap" ride Services.Channel.emit).
//

package io.letary.lecodes.plugins.push

import io.letary.lecodes.utils.Services

class PushService(private val channel: Services.Channel) {

    init {
        PushManager.addSession(channel)
    }

    fun instance() = Services.Instance(
        onCall = { call ->
            when (call.method) {
                "getStatus" -> call.resolve(PushManager.getStatus())
                "register" -> PushManager.register(
                    call,
                    call.args.optJSONObject(0)?.optString("user")?.takeIf { it.isNotEmpty() },
                )
                "unregister" -> PushManager.unregister(call)
                "getLaunch" -> call.resolve(PushManager.getLaunch())
                else -> call.reject("push: unknown method \"${call.method}\"")
            }
        },
        onClose = { PushManager.removeSession(channel) },
    )
}
