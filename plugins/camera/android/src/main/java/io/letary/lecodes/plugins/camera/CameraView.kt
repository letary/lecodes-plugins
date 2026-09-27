//
//  CameraView.kt — lecodes-plugins/camera
//
//  Camera2 SurfaceView with an aspect-fill layout override, JPEG still capture, and
//  facing-mode switching. Permission must already be granted before the view opens
//  (the SDK's prepare path handles the prompt).
//

package io.letary.lecodes.plugins.camera

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import kotlin.math.roundToInt

enum class CameraFacingMode { FRONT, BACK }

@SuppressLint("ViewConstructor")
class CameraView(
    context: Context,
    private var facingMode: CameraFacingMode = CameraFacingMode.BACK
) : SurfaceView(context), SurfaceHolder.Callback {

    // region Private fields

    private val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager

    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var imageReader: ImageReader? = null

    private var backgroundThread: HandlerThread? = null
    private var backgroundHandler: Handler? = null

    private var currentSurface: Surface? = null
    private var photoCallback: ((ByteArray?) -> Unit)? = null

    // endregion

    // region Capture size

    private val captureWidth = 1920
    private val captureHeight = 1080

    // endregion

    // region Init

    init {
        holder.addCallback(this)
        holder.setFixedSize(captureWidth, captureHeight)
    }

    // endregion

    // region Layout

    override fun layout(l: Int, t: Int, r: Int, b: Int) {
        val viewW = r - l
        val viewH = b - t
        if (viewW == 0 || viewH == 0) { super.layout(l, t, r, b); return }

        val previewW = if (viewW < viewH) captureHeight else captureWidth
        val previewH = if (viewW < viewH) captureWidth else captureHeight

        val scale = maxOf(viewW.toFloat() / previewW, viewH.toFloat() / previewH)

        val scaledW = (previewW * scale).roundToInt()
        val scaledH = (previewH * scale).roundToInt()

        val offsetX = (scaledW - viewW) / 2
        val offsetY = (scaledH - viewH) / 2

        super.layout(l - offsetX, t - offsetY, l - offsetX + scaledW, t - offsetY + scaledH)
    }

    // endregion

    // region SurfaceHolder.Callback

    override fun surfaceCreated(holder: SurfaceHolder) {
        startBackgroundThread()
        currentSurface = holder.surface
        openCamera(holder.surface)
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        closeCamera()
        stopBackgroundThread()
        currentSurface = null
    }

    // endregion

    // region Public API

    fun cameraSetFacingMode(mode: CameraFacingMode) {
        if (facingMode == mode) return
        facingMode = mode
        val surface = currentSurface ?: return
        closeCamera()
        openCamera(surface)
    }

    fun takePhoto(callback: (ByteArray?) -> Unit) {
        val session = captureSession ?: run { callback(null); return }
        val reader = imageReader ?: run { callback(null); return }

        photoCallback = callback

        reader.setOnImageAvailableListener({ r ->
            val image = r.acquireLatestImage() ?: run {
                val cb = photoCallback; photoCallback = null; cb?.invoke(null)
                return@setOnImageAvailableListener
            }
            image.use {
                val buffer = it.planes[0].buffer
                val bytes = ByteArray(buffer.remaining()).also { b -> buffer.get(b) }
                val cb = photoCallback
                photoCallback = null
                cb?.invoke(bytes)
            }
        }, backgroundHandler)

        try {
            val captureRequest = cameraDevice!!
                .createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                    addTarget(reader.surface)
                    set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                    set(CaptureRequest.JPEG_ORIENTATION, getJpegOrientation())
                }.build()
            session.capture(captureRequest, null, backgroundHandler)
        } catch (e: Exception) {
            photoCallback = null
            callback(null)
        }
    }

    // endregion

    // region Camera open / close

    private fun openCamera(previewSurface: Surface) {
        val cameraId = getCameraId(facingMode) ?: return
        imageReader = ImageReader.newInstance(captureWidth, captureHeight, ImageFormat.JPEG, 1)
        try {
            cameraManager.openCamera(cameraId, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    cameraDevice = camera
                    startPreview(previewSurface)
                }
                override fun onDisconnected(camera: CameraDevice) { camera.close(); cameraDevice = null }
                override fun onError(camera: CameraDevice, error: Int) { camera.close(); cameraDevice = null }
            }, backgroundHandler)
        } catch (e: SecurityException) {
            // Permission must be granted before using CameraView
        }
    }

    private fun startPreview(previewSurface: Surface) {
        val device = cameraDevice ?: return
        val reader = imageReader ?: return

        val previewRequest = device
            .createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                addTarget(previewSurface)
            }.build()

        @Suppress("DEPRECATION")
        device.createCaptureSession(
            listOf(previewSurface, reader.surface),
            object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(session: CameraCaptureSession) {
                    captureSession = session
                    session.setRepeatingRequest(previewRequest, null, backgroundHandler)
                }
                override fun onConfigureFailed(session: CameraCaptureSession) {}
            },
            backgroundHandler
        )
    }

    private fun closeCamera() {
        captureSession?.close(); captureSession = null
        cameraDevice?.close();   cameraDevice = null
        imageReader?.close();    imageReader = null
    }

    // endregion

    // region Helpers

    private fun getCameraId(mode: CameraFacingMode): String? {
        val facing = if (mode == CameraFacingMode.FRONT)
            CameraCharacteristics.LENS_FACING_FRONT
        else
            CameraCharacteristics.LENS_FACING_BACK
        return cameraManager.cameraIdList.firstOrNull { id ->
            cameraManager.getCameraCharacteristics(id)
                .get(CameraCharacteristics.LENS_FACING) == facing
        }
    }

    @Suppress("DEPRECATION")
    private fun getDisplayRotationDegrees(): Int {
        val rotation = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            display?.rotation
        } else {
            (context.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager)
                .defaultDisplay.rotation
        } ?: Surface.ROTATION_0

        return when (rotation) {
            Surface.ROTATION_0   -> 0
            Surface.ROTATION_90  -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else                 -> 0
        }
    }

    private fun getJpegOrientation(): Int {
        val cameraId = getCameraId(facingMode) ?: return 0
        val sensorOrientation = cameraManager.getCameraCharacteristics(cameraId)
            .get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0

        val displayRotationDegrees = getDisplayRotationDegrees()

        return if (facingMode == CameraFacingMode.FRONT) {
            // Front camera is mirrored, so the display rotation is added
            (sensorOrientation + displayRotationDegrees + 360) % 360
        } else {
            (sensorOrientation - displayRotationDegrees + 360) % 360
        }
    }

    private fun startBackgroundThread() {
        backgroundThread = HandlerThread("CameraBackground").also { it.start() }
        backgroundHandler = Handler(backgroundThread!!.looper)
    }

    private fun stopBackgroundThread() {
        backgroundThread?.quitSafely()
        try { backgroundThread?.join() } catch (e: InterruptedException) { e.printStackTrace() }
        backgroundThread = null
        backgroundHandler = null
    }

    // endregion
}
