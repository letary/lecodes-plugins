//
//  PitchDetector.kt — lecodes-plugins/audio-recorder
//
//  The note detector: YIN (de Cheveigné & Kawahara, 2002) over one window of samples. ONE
//  algorithm in three languages — web/pitch.ts (where its notes are), this file and
//  ios/PitchDetector.swift are the same steps with the same constants; change them together.
//

package io.letary.lecodes.plugins.audiorecorder

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max

internal class PitchDetector(private val sampleRate: Int) {

    private val tauMax = sampleRate / LOWEST_HZ
    private val tauMin = max(2, sampleRate / HIGHEST_HZ)

    /** How many samples `detect` reads. */
    val size = max(ceil(sampleRate * WINDOW_SECONDS).toInt(), 2 * tauMax)

    /** What the difference is summed over. */
    private val span = size - tauMax

    /** The cumulative mean normalized difference. */
    private val cmnd = FloatArray(tauMax + 1)

    /** What the last `detect` found: Hz (0 = no clear note) and how periodic the sound is, 0..1. */
    var frequency = 0.0
        private set
    var clarity = 0.0
        private set

    /** The note in `x[0 until size]`, −1..1. */
    fun detect(x: FloatArray) {
        frequency = 0.0
        clarity = 0.0
        var peak = 0f
        for (i in 0 until size) { val a = abs(x[i]); if (a > peak) peak = a }
        if (peak < SILENCE) return

        cmnd[0] = 1f
        var running = 0.0
        for (tau in 1..tauMax) {
            var sum = 0.0
            for (j in 0 until span) { val d = x[j] - x[j + tau]; sum += d * d }
            running += sum
            cmnd[tau] = if (running > 0) (sum * tau / running).toFloat() else 1f
        }

        // The first dip under the threshold, followed down to its bottom: the shortest period that
        // repeats — a longer one (an octave below) would dip as deep.
        var tau = -1
        var t = tauMin
        while (t <= tauMax) {
            if (cmnd[t] < THRESHOLD) {
                while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++
                tau = t
                break
            }
            t++
        }
        if (tau < 0 || tau >= tauMax) {             // nothing repeats, or the period runs out of the range
            var lowest = 1f
            for (i in tauMin..tauMax) if (cmnd[i] < lowest) lowest = cmnd[i]
            clarity = (1.0 - lowest).coerceIn(0.0, 1.0)
            return
        }

        // The bottom between the samples: a parabola through the dip and its neighbours.
        val a = cmnd[tau - 1].toDouble()
        val b = cmnd[tau].toDouble()
        val c = cmnd[tau + 1].toDouble()
        val bend = a - 2 * b + c
        val shift = if (bend > 0) (a - c) / (2 * bend) else 0.0
        frequency = sampleRate / (tau + shift)
        clarity = (1.0 - b).coerceIn(0.0, 1.0)
    }

    private companion object {
        const val LOWEST_HZ = 60
        const val HIGHEST_HZ = 1500
        const val WINDOW_SECONDS = 0.0464
        const val THRESHOLD = 0.15f
        const val SILENCE = 0.01f
    }
}
