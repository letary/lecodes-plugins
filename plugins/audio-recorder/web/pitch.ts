// The note detector of audio-recorder: YIN (de Cheveigné & Kawahara, 2002) over one window of
// samples. ONE algorithm in three languages — this file, android/…/PitchDetector.kt and
// ios/PitchDetector.swift are the same steps with the same constants; change them together.
//
//   the window   `size` samples ≈ 46 ms (2047 at 44.1 kHz): the lag runs to one period of the
//                lowest note (60 Hz), the rest is what the difference is summed over
//   the range    60–1500 Hz: a voice, a guitar, most instruments (a bass's low strings are below)
//   no note      the window is quiet (peak under 0.01, −40 dBFS) or nothing in it repeats well
//                enough (no dip of the normalized difference under 0.15): frequency 0
//   clarity      1 − the normalized difference at the lag that was picked (or at its lowest point
//                when no note was found): 1 = perfectly periodic

const LOWEST_HZ = 60
const HIGHEST_HZ = 1500
const WINDOW_SECONDS = 0.0464
const THRESHOLD = 0.15
const SILENCE = 0.01

export interface Pitch { frequency: number, clarity: number }

export interface PitchDetector {
  /** How many samples `detect` reads. */
  readonly size: number
  /** The note in `samples[offset … offset + size)`, −1..1. */
  detect(samples: Float32Array, offset?: number): Pitch
}

export const createPitchDetector = (sampleRate: number): PitchDetector => {
  const tauMax = Math.floor(sampleRate / LOWEST_HZ)
  const tauMin = Math.max(2, Math.floor(sampleRate / HIGHEST_HZ))
  const size = Math.max(Math.ceil(sampleRate * WINDOW_SECONDS), 2 * tauMax)
  const span = size - tauMax                      // what the difference is summed over
  const cmnd = new Float32Array(tauMax + 1)       // the cumulative mean normalized difference

  return {
    size,
    detect(x: Float32Array, offset = 0): Pitch {
      let peak = 0
      for (let i = 0; i < size; i++) { const a = Math.abs(x[offset + i]!); if (a > peak) peak = a }
      if (peak < SILENCE) return { frequency: 0, clarity: 0 }

      cmnd[0] = 1
      let running = 0
      for (let tau = 1; tau <= tauMax; tau++) {
        let sum = 0
        for (let j = 0; j < span; j++) { const d = x[offset + j]! - x[offset + j + tau]!; sum += d * d }
        running += sum
        cmnd[tau] = running > 0 ? sum * tau / running : 1
      }

      // The first dip under the threshold, followed down to its bottom: the shortest period that
      // repeats — a longer one (an octave below) would dip as deep.
      let tau = -1
      for (let t = tauMin; t <= tauMax; t++) {
        if (cmnd[t]! < THRESHOLD) {
          while (t + 1 <= tauMax && cmnd[t + 1]! < cmnd[t]!) t++
          tau = t
          break
        }
      }
      if (tau < 0 || tau >= tauMax) {             // nothing repeats, or the period runs out of the range
        let lowest = 1
        for (let t = tauMin; t <= tauMax; t++) if (cmnd[t]! < lowest) lowest = cmnd[t]!
        return { frequency: 0, clarity: Math.min(1, Math.max(0, 1 - lowest)) }
      }

      // The bottom between the samples: a parabola through the dip and its neighbours.
      const a = cmnd[tau - 1]!, b = cmnd[tau]!, c = cmnd[tau + 1]!
      const bend = a - 2 * b + c
      const shift = bend > 0 ? (a - c) / (2 * bend) : 0
      return { frequency: sampleRate / (tau + shift), clarity: Math.min(1, Math.max(0, 1 - b)) }
    },
  }
}
