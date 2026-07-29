//
//  CameraPlugin.kt — lecodes-plugins/camera
//
//  The "camera" registerView plugin: WHEN and WITH WHAT to open it is app (TS) code —
//  the SDK's CameraView() wrapper rides the generic NativeView channel, no per-plugin
//  bridge methods.
//

package io.letary.lecodes.plugins.camera

import android.content.Context
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.utils.FetchBuffers
import io.letary.lecodes.utils.NativeViews
import org.json.JSONObject

object CameraPlugin {

    const val PLUGIN_ID = "camera"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        engine.registerView("camera") { params, _ ->
            val facing = if (params.optString("facingMode") == "front") CameraFacingMode.FRONT else CameraFacingMode.BACK
            val view = CameraView(appContext, facing)
            NativeViews.Instance(view, onCall = { call ->
                when (call.method) {
                    "setFacingMode" -> {
                        val mode = if (call.args.optString(0) == "front") CameraFacingMode.FRONT else CameraFacingMode.BACK
                        view.cameraSetFacingMode(mode)
                        call.resolve()
                    }
                    "takePhoto" -> view.takePhoto { bytes ->
                        if (bytes == null) {
                            call.reject("Failed to take photo")
                        } else {
                            val systemId = FetchBuffers.add(bytes)
                            call.resolve(JSONObject()
                                .put("systemId", systemId)
                                .put("name", "image.jpg")
                                .put("size", bytes.size))
                        }
                    }
                    else -> call.reject("Unknown method: ${call.method}")
                }
            })
        }
    }
}
