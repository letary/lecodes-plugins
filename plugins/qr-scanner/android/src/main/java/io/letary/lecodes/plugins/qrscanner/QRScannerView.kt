//
//  QRScannerView.kt — lecodes-plugins/qr-scanner
//
//  Camera2 SurfaceView feeding luma frames to the quirc decoder (libs/quirc-release.aar).
//  onData fires on every payload change (null when the code leaves the frame for ~10
//  frames); onOpen fires once on the first frame — used only by the viewer's legacy
//  _creatorUtils.openScanner promise, the plugin registration passes a no-op.
//

package io.letary.lecodes.plugins.qrscanner

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.annotation.RequiresPermission
import com.example.quirc.QuircNative
import kotlin.math.roundToInt

@SuppressLint("ViewConstructor")
class QRScannerView(context: Context, val onOpen: () -> Unit, val onData: (data: String?) -> Unit):
    SurfaceView(context), SurfaceHolder.Callback {

    private val cameraManager: CameraManager =
        context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var backgroundThread: HandlerThread? = null
    private var backgroundHandler: Handler? = null
    private lateinit var imageReader: ImageReader

    private var previewWidth = 0
    private var previewHeight = 0
    private var quircObj = 0L
    private val TAG = "QRScannerView"

    init {
        holder.addCallback(this)
        holder.setFixedSize(1280, 720)
        previewWidth = 720
        previewHeight = 1280

        quircObj = QuircNative.nativeInit()
    }
    private var lastResult: String? = null
    private var completeSended = false
    private var framesWithoutData = 0

    @RequiresPermission(Manifest.permission.CAMERA)
    override fun surfaceCreated(holder: SurfaceHolder) {
        startBackgroundThread()

        imageReader = ImageReader.newInstance(1280, 720, ImageFormat.YUV_420_888, 2)
        imageReader.setOnImageAvailableListener({

            if (!completeSended) {
                onOpen()
                completeSended = true
            }

            val result = imageReader.acquireLatestImage() ?: return@setOnImageAvailableListener
            val plane = result.planes[0]
            val buffer = plane.buffer
            val rowStride = plane.rowStride
            val height = result.height

            val yData = ByteArray(plane.rowStride * result.height)

            var offset = 0
            for (row in 0 until result.height) {
                buffer.position(row * rowStride)
                buffer.get(yData, offset, result.width)
                offset += result.width
            }
            result.close()

            val qrResult = QuircNative.nativeScan(quircObj, yData, rowStride, height)

            if (qrResult != null) {
                framesWithoutData = 0
                if (lastResult != qrResult.payload) {
                    onData(qrResult.payload)
                    lastResult = qrResult.payload
                }
            } else if (lastResult != null) {
                framesWithoutData++
                if (framesWithoutData > 10) {
                    onData(null)
                    lastResult = null
                }
            }
        }, backgroundHandler)

        openCamera(holder.surface)
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        // Session restart on size change is not needed for the fixed-size preview
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        closeCamera()
        stopBackgroundThread()
    }

    @RequiresPermission(Manifest.permission.CAMERA)
    private fun openCamera(surface: Surface) {
        try {
            val cameraId = cameraManager.cameraIdList.firstOrNull { id ->
                val chars = cameraManager.getCameraCharacteristics(id)
                val facing = chars.get(CameraCharacteristics.LENS_FACING)
                facing == CameraCharacteristics.LENS_FACING_BACK
            } ?: cameraManager.cameraIdList.first()

            cameraManager.openCamera(cameraId, object : CameraDevice.StateCallback() {
                override fun onOpened(device: CameraDevice) {
                    cameraDevice = device
                    startPreview(surface)
                }

                override fun onDisconnected(device: CameraDevice) {
                    device.close()
                    cameraDevice = null
                }

                override fun onError(device: CameraDevice, error: Int) {
                    Log.e(TAG, "Camera error: $error")
                    device.close()
                    cameraDevice = null
                }
            }, backgroundHandler)
        } catch (e: CameraAccessException) {
            e.printStackTrace()
        }
    }

    private fun startPreview(surface: Surface) {
        try {
            val previewRequestBuilder = cameraDevice!!.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
            previewRequestBuilder.addTarget(surface)
            previewRequestBuilder.addTarget(imageReader.surface)
            previewRequestBuilder.set(
                CaptureRequest.CONTROL_SCENE_MODE,
                CameraMetadata.CONTROL_SCENE_MODE_BARCODE
            )
            val request = previewRequestBuilder.build()

            cameraDevice?.createCaptureSession(listOf(surface, imageReader.surface),
                object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        captureSession = session
                        try {
                            captureSession?.setRepeatingRequest(request, null, backgroundHandler)
                        } catch (e: CameraAccessException) {
                            e.printStackTrace()
                        }
                    }

                    override fun onConfigureFailed(session: CameraCaptureSession) {
                        Log.e(TAG, "Preview config failed")
                    }
                }, backgroundHandler
            )
        } catch (e: CameraAccessException) {
            e.printStackTrace()
        }
    }

    private fun closeCamera() {
        captureSession?.close()
        captureSession = null
        cameraDevice?.close()
        cameraDevice = null
    }

    private fun startBackgroundThread() {
        backgroundThread = HandlerThread("CameraBackground").also { it.start() }
        backgroundHandler = Handler(backgroundThread!!.looper)
    }

    private fun stopBackgroundThread() {
        backgroundThread?.quitSafely()
        try {
            backgroundThread?.join()
            backgroundThread = null
            backgroundHandler = null
        } catch (e: InterruptedException) {
            e.printStackTrace()
        }
    }

    override fun layout(l: Int, t: Int, r: Int, b: Int) {
        if (previewWidth == 0 || previewHeight == 0) {
            super.layout(l, t, r, b)
            return
        }

        val viewW = r - l
        val viewH = b - t

        // Aspect-fill: scale so the preview covers the whole container (no letterboxing)
        val scaleX = maxOf(viewW, viewH).toFloat() / maxOf(previewWidth, previewHeight).toFloat()
        val scaleY = minOf(viewW, viewH).toFloat() / minOf(previewWidth, previewHeight).toFloat()
        val scale = maxOf(scaleX, scaleY)

        val scaledW = (if (viewW > viewH) { previewHeight } else { previewWidth } * scale).roundToInt()
        val scaledH = (if (viewW > viewH) { previewWidth } else { previewHeight } * scale).roundToInt()

        // Half the overflow on each side, so the preview center matches the container center
        val offsetX = (scaledW - viewW) / 2
        val offsetY = (scaledH - viewH) / 2

        val newLeft = l - offsetX
        val newTop = t - offsetY
        val newRight = newLeft + scaledW
        val newBottom = newTop + scaledH

        // super.layout takes parent-relative coordinates — negative/oversized values are fine
        super.layout(newLeft, newTop, newRight, newBottom)
    }

}
