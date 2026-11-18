//
//  TorchService.kt — lecodes-plugins/torch
//
//  One session of the "torch" service: the contract's TorchPlugin (Torch.gen.kt reads the calls off
//  the wire) over CameraManager's torch mode — the back camera's flash, else the first camera that
//  has one. No permission: setTorchMode / turnOnTorchWithStrengthLevel work without CAMERA.
//
//  Brightness is Android 13+ (API 33) and only where FLASH_INFO_STRENGTH_MAXIMUM_LEVEL > 1: a level
//  is rounded to the flash's strength steps and the state reports the step it took. Elsewhere the
//  torch lights at its one brightness and reports 1.
//
//  Android has no getter for the torch's mode — the camera service tells it through a TorchCallback,
//  which answers at once when it is registered: the session registers one at its first call and
//  answers state() / toggle() once the first report is in (0.5 s at most). A camera that holds the
//  flash makes it "unavailable" there: off for the app; set() then rejects BUSY.
//
//  Calls and the TorchCallback both run on the main thread (its handler), and so does the state.
//

package io.letary.lecodes.plugins.torch

import android.content.Context
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.letary.lecodes.services.Reply
import kotlin.math.abs
import kotlin.math.roundToInt

/** The flash a session drives: its camera, and its strength levels (Android 13+; 1 = on or off). */
internal class Flash(val id: String, val maxLevel: Int, val defaultLevel: Int) {
    val dimmable get() = maxLevel > 1
}

/** One session of the app's `Torch`. */
class TorchService(private val context: Context, private val events: TorchEvents) : TorchPlugin {
    private val main = Handler(Looper.getMainLooper())
    private val manager: CameraManager? by lazy { context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager }
    private val flash: Flash? by lazy { findFlash() }

    /** The camera service's last report (null until its first, a few ms after registering). */
    private var lit: Boolean? = null
    /** The strength the flash is at, when Android 13+ said so. */
    private var strength: Int? = null
    /** The level this session last lit the torch at (null: the default): what toggle() lights again. */
    private var lastLevel: Double? = null
    private var lastSent: TorchState? = null
    private val waiting = mutableListOf<() -> Unit>()
    private var callback: CameraManager.TorchCallback? = null

    /** The back camera's flash, else the first camera that has one; null where none does. */
    private fun findFlash(): Flash? {
        val manager = manager ?: return null
        var found: Flash? = null
        try {
            for (id in manager.cameraIdList) {
                val c = manager.getCameraCharacteristics(id)
                if (c.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) != true) continue
                var max = 1
                var default = 1
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    max = c.get(CameraCharacteristics.FLASH_INFO_STRENGTH_MAXIMUM_LEVEL) ?: 1
                    default = c.get(CameraCharacteristics.FLASH_INFO_STRENGTH_DEFAULT_LEVEL) ?: max
                }
                val flash = Flash(id, max.coerceAtLeast(1), default.coerceIn(1, max.coerceAtLeast(1)))
                if (c.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK) return flash
                if (found == null) found = flash
            }
        } catch (e: CameraAccessException) {
        } catch (e: SecurityException) {
        } catch (e: IllegalArgumentException) {
        }
        return found
    }

    // ---- what the camera service says ----

    /** Register the TorchCallback once: it reports the flash's mode at once, then every change. */
    private fun track(flash: Flash) {
        if (callback != null) return
        val cb = object : CameraManager.TorchCallback() {
            override fun onTorchModeChanged(cameraId: String, enabled: Boolean) {
                if (cameraId != flash.id) return
                lit = enabled
                if (!enabled) strength = null
                settled()
            }

            override fun onTorchModeUnavailable(cameraId: String) {
                if (cameraId != flash.id) return
                lit = false   // the camera holds it: it is off for the app
                settled()
            }

            override fun onTorchStrengthLevelChanged(cameraId: String, newStrengthLevel: Int) {
                if (cameraId != flash.id) return
                strength = newStrengthLevel
                settled()
            }
        }
        callback = cb
        try {
            manager?.registerTorchCallback(cb, main)
        } catch (e: Exception) {
            lit = false
        }
        // A camera service that never answers must not hang a call.
        main.postDelayed({ if (lit == null) { lit = false; settled() } }, 500)
    }

    private fun settled() {
        val calls = waiting.toList()
        waiting.clear()
        calls.forEach { it() }
        send()
    }

    /** Run `then` once the flash's mode is known. */
    private fun whenKnown(flash: Flash, then: () -> Unit) {
        track(flash)
        if (lit != null) then() else waiting.add(then)
    }

    private fun current(flash: Flash): TorchState {
        if (lit != true) return TorchState(false, 0.0)
        if (!flash.dimmable) return TorchState(true, 1.0)
        var level = strength
        if (level == null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            level = try { manager?.getTorchStrengthLevel(flash.id) } catch (e: Exception) { null }
        }
        return TorchState(true, (level ?: flash.defaultLevel).toDouble() / flash.maxLevel)
    }

    private fun send() {
        val flash = flash ?: return
        if (!events.changeObserved || lit == null) return
        val state = current(flash)
        val last = lastSent
        if (last != null && last.on == state.on && abs(last.level - state.level) < 0.001) return
        lastSent = state
        events.change(state)
    }

    // ---- the calls ----

    override fun info(reply: Reply<TorchInfo, TorchCode>) {
        val flash = flash
        reply.resolve(TorchInfo(available = flash != null, dimmable = flash?.dimmable == true))
    }

    override fun state(reply: Reply<TorchState, TorchCode>) {
        val flash = flash ?: return reply.resolve(TorchState(false, 0.0))
        whenKnown(flash) { reply.resolve(current(flash)) }
    }

    override fun set(on: Boolean, level: Double?, reply: Reply<TorchState, TorchCode>) {
        val wanted = level?.coerceAtMost(1.0)
        light(on && (wanted == null || wanted > 0.0), wanted, reply)
    }

    override fun toggle(reply: Reply<TorchState, TorchCode>) {
        val flash = flash ?: return reply.reject(TorchCode.UNAVAILABLE)
        whenKnown(flash) { light(lit != true, lastLevel, reply) }
    }

    /** Light the flash at `level` (null: its default strength), or turn it off. */
    private fun light(on: Boolean, level: Double?, reply: Reply<TorchState, TorchCode>) {
        val flash = flash ?: return reply.reject(TorchCode.UNAVAILABLE)
        val manager = manager ?: return reply.reject(TorchCode.UNAVAILABLE)
        track(flash)
        try {
            if (!on) {
                manager.setTorchMode(flash.id, false)
                return reply.resolve(TorchState(false, 0.0))
            }
            var step = flash.defaultLevel
            if (level != null && flash.dimmable && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                step = (level * flash.maxLevel).roundToInt().coerceIn(1, flash.maxLevel)
                manager.turnOnTorchWithStrengthLevel(flash.id, step)
            } else {
                manager.setTorchMode(flash.id, true)
            }
            lastLevel = level
            reply.resolve(TorchState(true, if (flash.dimmable) step.toDouble() / flash.maxLevel else 1.0))
        } catch (e: CameraAccessException) {
            reply.reject(when (e.reason) {
                CameraAccessException.CAMERA_IN_USE, CameraAccessException.MAX_CAMERAS_IN_USE -> TorchCode.BUSY
                CameraAccessException.CAMERA_DISABLED, CameraAccessException.CAMERA_DISCONNECTED -> TorchCode.UNAVAILABLE
                else -> TorchCode.FAILED
            })
        } catch (e: Exception) {
            reply.reject(TorchCode.FAILED)
        }
    }

    // ---- the change event ----

    override fun changeObserved(observed: Boolean) {
        if (!observed) { lastSent = null; return }
        val flash = flash ?: return
        track(flash)
    }

    override fun close() {
        main.removeCallbacksAndMessages(null)
        callback?.let { cb -> try { manager?.unregisterTorchCallback(cb) } catch (e: Exception) {} }
        callback = null
        waiting.clear()
    }
}
