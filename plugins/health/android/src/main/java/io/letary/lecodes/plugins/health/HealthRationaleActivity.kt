//
//  HealthRationaleActivity.kt — lecodes-plugins/health
//
//  The privacy screen Health Connect opens from its permission sheet ("why does this app ask?"):
//  ACTION_SHOW_PERMISSIONS_RATIONALE on Android 9-13, VIEW_PERMISSION_USAGE / HEALTH_PERMISSIONS
//  through the activity-alias on Android 14+ (the plugin's AndroidManifest). Health Connect shows no
//  sheet for an app without one.
//
//  The policy is the APP's: with the string lecodes_health_privacy_policy_url set (the app's
//  res/values) this opens it in the browser and closes; without one it shows what the plugin reads
//  (lecodes_health_rationale). A plain Activity on a theme of the platform's own — no AppCompat
//  theme of the app's is needed, nothing of the engine runs here.
//

package io.letary.lecodes.plugins.health

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView

class HealthRationaleActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = getString(R.string.lecodes_health_privacy_policy_url).trim()
        if (url.isNotEmpty() && open(url)) {
            finish()
            return
        }

        val pad = (24 * resources.displayMetrics.density).toInt()
        val text = TextView(this).apply {
            text = getString(R.string.lecodes_health_rationale, applicationInfo.loadLabel(packageManager))
            textSize = 16f
            setPadding(pad, pad, pad, pad)
        }
        // Edge to edge from target 35: the system bars' insets as the scroll view's padding.
        setContentView(ScrollView(this).apply {
            fitsSystemWindows = true
            addView(text)
        })
    }

    private fun open(url: String): Boolean = try {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        true
    } catch (e: Exception) {
        false   // no browser, a URL nothing opens: the text instead
    }
}
