//
//  BackgroundAudioService.kt — lecodes-plugins/background-audio
//
//  Where the record plays: an ExoPlayer behind a media3 MediaSession, in a MediaSessionService. The
//  service is media3's whole answer to "play with the screen off": it goes to the foreground while
//  the player plays (the process is kept), posts the media notification from the record's title,
//  and takes the notification's and a headset's buttons — none of which needs the app's code, which
//  does not run in the background. The player answers the rest itself: the audio focus (a call
//  pauses it), headphones pulled out, the wake lock.
//

package io.letary.lecodes.plugins.backgroundaudio

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

class BackgroundAudioService : MediaSessionService() {

    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val player = ExoPlayer.Builder(this)
            // A spoken record: another app's short sound (a navigation prompt) pauses it instead of
            // talking over it. `true`: the player asks for the audio focus and follows its loss.
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        val builder = MediaSession.Builder(this, player)
        // A tap on the notification brings the app back.
        packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
            builder.setSessionActivity(PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        }
        session = builder.build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    // The app was swiped away: nobody is left to show the record or to stop it.
    override fun onTaskRemoved(rootIntent: Intent?) {
        session?.player?.let { player ->
            player.stop()
            player.clearMediaItems()
        }
        stopSelf()
    }

    override fun onDestroy() {
        session?.let {
            it.player.release()
            it.release()
        }
        session = null
        super.onDestroy()
    }
}
