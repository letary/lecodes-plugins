//
//  LeCodesCameraPlugin.kt — lecodes-plugins/camera
//
//  The "camera" view: the contract's CameraViewPlugin (CameraView.gen.kt reads the calls off the
//  wire) over CameraView, the preview itself. WHEN and WITH WHAT to open it is app (TS) code.
//

package io.letary.lecodes.plugins.camera

import android.content.Context
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.services.PluginFile
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve

object LeCodesCameraPlugin {

    const val PLUGIN_ID = "camera"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        CameraViewChannel.register(engine) { params, _ -> Camera(appContext, params) }
    }
}

private fun Facing?.mode() = if (this == Facing.FRONT) CameraFacingMode.FRONT else CameraFacingMode.BACK

private class Camera(context: Context, params: CameraParams) : CameraViewPlugin {
    private val camera = CameraView(context, params.facingMode.mode())

    override val view: android.view.View get() = camera

    override fun takePhoto(reply: Reply<PluginFile, CameraViewCode>) {
        camera.takePhoto { bytes ->
            if (bytes == null) reply.reject(CameraViewCode.FAILED)
            else reply.resolve(PluginFile(bytes, "image.jpg"))
        }
    }

    override fun setFacingMode(mode: Facing, reply: Reply<Unit, CameraViewCode>) {
        camera.cameraSetFacingMode(mode.mode())
        reply.resolve()
    }
}
