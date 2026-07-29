//
//  LePushMessagingService.kt — lecodes-plugins/push
//
//  FCM entry point (docs/push-plan.md, Android host). The backend sends DATA-ONLY messages
//  (buildFcmBody) precisely so this host renders the notification itself — on one
//  NotificationChannel per LeCodes app (id = projectUuid, named after the project), which gives
//  users native per-app mute; that channel granularity is the design's replacement for the
//  removed in-viewer consent sheet. Declared in this module's AndroidManifest.xml — the AGP
//  manifest merger registers it in the consuming app.
//

package io.letary.lecodes.plugins.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class LePushMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        PushManager.ensureContext(applicationContext)
        val payload = PushManager.payloadFromData(message.data) ?: return
        // Foregrounded same-project world: banner suppressed, "message" event instead (iOS
        // willPresent). Everything else — background, killed, or another project on screen —
        // shows the system notification.
        if (PushManager.onMessage(payload)) return
        showNotification(payload)
    }

    override fun onNewToken(token: String) {
        PushManager.ensureContext(applicationContext)
        PushManager.onNewToken(token)
    }

    private fun showNotification(payload: org.json.JSONObject) {
        val projectUuid = payload.optString("projectUuid")
        val channelName = payload.optString("projectName").ifEmpty { "LeCodes app" }

        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // Re-created every message on purpose: createNotificationChannel refreshes the NAME
            // of an existing channel (projects get renamed) but never resurrects user settings —
            // a channel the user muted stays muted.
            manager.createNotificationChannel(
                NotificationChannel(projectUuid, channelName, NotificationManager.IMPORTANCE_HIGH))
        }

        // The tap intent targets the host's launcher activity (resolved at runtime — a vendored
        // plugin cannot name the app's MainActivity class), carrying the same le.codes/qr URI a
        // QR scan produces (so the existing launchUrl machinery routes it) plus the payload
        // extra the host hands to PushPlugin for the "tap"/getLaunch paths. Explicit component →
        // singleTask delivers a warm tap to onNewIntent regardless of the app's intent filters.
        // Unique requestCode per notification keeps PendingIntent extras from merging.
        val requestCode = (SystemClock.elapsedRealtime() and 0x7FFFFFFF).toInt()
        val intent = (packageManager.getLaunchIntentForPackage(packageName) ?: Intent()).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse("https://le.codes/qr/$projectUuid")
            putExtra(PushManager.EXTRA_PAYLOAD, payload.toString())
        }
        val contentIntent = PendingIntent.getActivity(
            this, requestCode, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        // Resolved by NAME, not R class — this source is compiled both as a Gradle module
        // (module R package) and source-vendored into the viewer (app R package). aapt2
        // flattens library resources into the app table, and an app-defined drawable of the
        // same name wins — that is also the host's icon-override hook.
        val smallIcon = resources.getIdentifier("lecodes_push_ic_notification", "drawable", packageName)
            .takeIf { it != 0 } ?: applicationInfo.icon

        val builder = NotificationCompat.Builder(this, projectUuid)
            .setSmallIcon(smallIcon)
            .setContentTitle(payload.optString("title"))
            .setPriority(NotificationCompat.PRIORITY_HIGH)   // pre-26 fallback for the channel importance
            .setAutoCancel(true)
            .setContentIntent(contentIntent)
        payload.optString("body").takeIf { it.isNotEmpty() }?.let { builder.setContentText(it) }
        if (payload.has("badge")) builder.setNumber(payload.optInt("badge"))

        // On 33+ a revoked POST_NOTIFICATIONS makes notify() throw a SecurityException-shaped
        // lint error; the OS would drop it anyway, so skip cleanly.
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED) return
        NotificationManagerCompat.from(this).notify(requestCode, builder.build())
    }
}
