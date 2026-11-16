//
//  BiometricsService.kt — lecodes-plugins/biometrics
//
//  One session of the "biometrics" service: the contract's BiometricsPlugin (Biometrics.gen.kt reads
//  the calls off the wire) over androidx.biometric's BiometricPrompt. The host's activity is a
//  FragmentActivity (LecodesEngine.getActivity), which is what that prompt is hosted in: it brings
//  the API 23-27 fingerprint dialog, the passcode where Android 9 / 10 have none of their own, and
//  BiometricManager's answers on every level — the framework's prompt alone starts at API 28.
//
//  The strength is BIOMETRIC_STRONG (Class 3: the fingerprint, a secure face sensor) — a gate in
//  front of what an app keeps. With allowPasscode it is STRONG | DEVICE_CREDENTIAL, except on
//  Android 9 and 10, which take the device credential only beside a WEAK biometric (the library's
//  supported combinations; a STRONG one throws there): the passcode is the weaker of the two anyway.
//  A prompt that allows the device credential has no negative button (the library refuses one);
//  without it the button is the system's "Cancel".
//
//  Calls and the prompt's callbacks run on the main thread (the prompt's executor), so is the state.
//  One prompt at a time: a call while one is up rejects BUSY. The prompt closing without a
//  confirmation is not a failure — the call resolves with false.
//

package io.letary.lecodes.plugins.biometrics

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.services.Reply
import java.lang.ref.WeakReference

class BiometricsService(
    private val engine: LecodesEngine,
    context: Context,
) : BiometricsPlugin {
    private val appContext = context.applicationContext
    private val manager = BiometricManager.from(appContext)

    /** The call whose prompt is up. */
    private var pending: Reply<Boolean, BiometricsCode>? = null

    // ── calls ────────────────────────────────────────────────────────────────

    override fun status(reply: Reply<BiometricStatus, BiometricsCode>) {
        // STATUS_UNKNOWN: Android 10 and below cannot always tell a strong biometric — the prompt may
        // still take one (the library's advice: offer it, handle its errors).
        val available = when (manager.canAuthenticate(BIOMETRIC_STRONG)) {
            BiometricManager.BIOMETRIC_SUCCESS, BiometricManager.BIOMETRIC_STATUS_UNKNOWN -> true
            else -> false
        }
        reply.resolve(BiometricStatus(available = available, kind = kind()))
    }

    override fun authenticate(options: BiometricOptions, reply: Reply<Boolean, BiometricsCode>) {
        if (pending != null) return reply.reject(BiometricsCode.BUSY)
        if (options.reason.isBlank()) return reply.fail("Biometrics.authenticate: a reason is required — the text the system's dialog shows")
        val activity = engine.getActivity() ?: return reply.reject(BiometricsCode.FAILED)
        // The prompt is a fragment: none is added once the activity saved its state (it is in the
        // background) — the library would log that and never call back.
        if (activity.isFinishing || activity.isDestroyed || activity.supportFragmentManager.isStateSaved) {
            return reply.reject(BiometricsCode.FAILED)
        }

        val passcode = options.allowPasscode == true
        val authenticators = authenticators(passcode)
        when (manager.canAuthenticate(authenticators)) {
            BiometricManager.BIOMETRIC_SUCCESS, BiometricManager.BIOMETRIC_STATUS_UNKNOWN -> {}
            // NONE_ENROLLED (no biometric — or with the passcode, no screen lock either), NO_HARDWARE,
            // HW_UNAVAILABLE, SECURITY_UPDATE_REQUIRED, UNSUPPORTED.
            else -> return reply.reject(BiometricsCode.UNAVAILABLE)
        }

        val info = try {
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(options.reason)
                .setAllowedAuthenticators(authenticators)
                // A face is confirmed when it is seen: no extra "Confirm" tap.
                .setConfirmationRequired(false)
                .apply { if (!passcode) setNegativeButtonText(appContext.getString(android.R.string.cancel)) }
                .build()
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "[biometrics] the prompt refused its options: ${e.message}")
            return reply.reject(BiometricsCode.FAILED)
        }

        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                finish(reply) { it.resolve(true) }
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                finish(reply) { answer(it, errorCode, errString) }
            }
            // onAuthenticationFailed: one attempt not recognized — the prompt stays up for the next.
        }
        pending = reply
        host = WeakReference(activity)
        turning = false
        (appContext as Application).registerActivityLifecycleCallbacks(lifecycle)
        try {
            BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback).authenticate(info)
        } catch (e: Exception) {
            Log.w(TAG, "[biometrics] the prompt did not start: ${e.message}")
            finish(reply) { it.reject(BiometricsCode.FAILED) }
        }
    }

    override fun close() {
        val reply = pending ?: return
        finish(reply) { it.resolve(false) }
        // Take the prompt down through the activity it is up in NOW (a turn of the screen moved it
        // there): a prompt made on it finds the prompt's fragment, and its callback — which takes the
        // place of the call's in the activity's ViewModel — hears the ERROR_CANCELED that follows.
        val activity = engine.getActivity() ?: return
        runCatching {
            BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {})
                .cancelAuthentication()
        }
    }

    // ── the answer ───────────────────────────────────────────────────────────

    /** Settle `reply` if it is still the pending one — a prompt's late answer after close() is dropped. */
    private fun finish(reply: Reply<Boolean, BiometricsCode>, settle: (Reply<Boolean, BiometricsCode>) -> Unit) {
        if (pending !== reply) return
        pending = null
        host = null
        turning = false
        (appContext as Application).unregisterActivityLifecycleCallbacks(lifecycle)
        settle(reply)
    }

    private fun answer(reply: Reply<Boolean, BiometricsCode>, errorCode: Int, message: CharSequence) {
        when (errorCode) {
            // Closed without a confirmation: the person (back, outside, the button), the system
            // (the app left the foreground, another prompt), or the sensor's own timeout.
            BiometricPrompt.ERROR_USER_CANCELED,
            BiometricPrompt.ERROR_NEGATIVE_BUTTON,
            BiometricPrompt.ERROR_CANCELED,
            BiometricPrompt.ERROR_TIMEOUT -> reply.resolve(false)
            BiometricPrompt.ERROR_LOCKOUT,
            BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> reply.reject(BiometricsCode.LOCKOUT)
            BiometricPrompt.ERROR_NO_BIOMETRICS,
            BiometricPrompt.ERROR_HW_NOT_PRESENT,
            BiometricPrompt.ERROR_HW_UNAVAILABLE,
            BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL,
            BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED -> reply.reject(BiometricsCode.UNAVAILABLE)
            else -> {
                // UNABLE_TO_PROCESS, NO_SPACE, VENDOR, …
                Log.w(TAG, "[biometrics] authenticate failed: $errorCode $message")
                reply.reject(BiometricsCode.FAILED)
            }
        }
    }

    // ── plumbing ─────────────────────────────────────────────────────────────

    private fun authenticators(passcode: Boolean): Int = when {
        !passcode -> BIOMETRIC_STRONG
        Build.VERSION.SDK_INT == Build.VERSION_CODES.P || Build.VERSION.SDK_INT == Build.VERSION_CODES.Q -> BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        else -> BIOMETRIC_STRONG or DEVICE_CREDENTIAL
    }

    /** A hint for a button's label: Android does not say which sensor its prompt will take, so a kind
     *  only where the device has one kind of sensor. */
    private fun kind(): BiometricKind {
        val pm = appContext.packageManager
        val fingerprint = pm.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)
        val face = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && pm.hasSystemFeature(PackageManager.FEATURE_FACE)
        val iris = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && pm.hasSystemFeature(PackageManager.FEATURE_IRIS)
        return when {
            fingerprint && !face && !iris -> BiometricKind.FINGERPRINT
            face && !fingerprint && !iris -> BiometricKind.FACE
            else -> BiometricKind.UNKNOWN
        }
    }

    /**
     * The activity the prompt is up in. A turn of the screen makes it again: the prompt (a retained
     * fragment) and its callback (the activity's ViewModel) move over to the new one — the next
     * activity created is that one, LeCodes has one. Destroyed for good, it takes the prompt with it
     * and the callback never comes: the call resolves with false, else `busy` would stay.
     */
    private var host: WeakReference<Activity>? = null
    private var turning = false

    private val lifecycle = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
            if (turning) { turning = false; host = WeakReference(activity) }
        }
        override fun onActivityDestroyed(activity: Activity) {
            if (activity !== host?.get()) return
            if (activity.isChangingConfigurations) { turning = true; return }
            pending?.let { reply -> finish(reply) { it.resolve(false) } }
        }
        override fun onActivityStarted(activity: Activity) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivityStopped(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    }

    companion object {
        private const val TAG = "LeCodesBiometrics"
    }
}
