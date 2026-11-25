//
//  PitchDetector.swift — lecodes-plugins/audio-recorder
//
//  The note detector: YIN (de Cheveigné & Kawahara, 2002) over one window of samples. ONE
//  algorithm in three languages — web/pitch.ts (where its notes are),
//  android/…/PitchDetector.kt and this file are the same steps with the same constants; change
//  them together.
//

import Foundation

final class PitchDetector {

    private static let lowestHz = 60.0
    private static let highestHz = 1500.0
    private static let windowSeconds = 0.0464
    private static let threshold: Float = 0.15
    private static let silence: Float = 0.01

    private let sampleRate: Double
    private let tauMax: Int
    private let tauMin: Int
    /// How many samples `detect` reads.
    let size: Int
    /// What the difference is summed over.
    private let span: Int
    /// The cumulative mean normalized difference.
    private var cmnd: [Float]

    init(sampleRate: Double) {
        self.sampleRate = sampleRate
        tauMax = Int(sampleRate / PitchDetector.lowestHz)
        tauMin = max(2, Int(sampleRate / PitchDetector.highestHz))
        size = max(Int((sampleRate * PitchDetector.windowSeconds).rounded(.up)), 2 * tauMax)
        span = size - tauMax
        cmnd = [Float](repeating: 0, count: tauMax + 1)
    }

    /// The note in the first `size` samples of `samples`, −1…1: Hz (0 = no clear note) and how
    /// periodic the sound is, 0…1.
    func detect(_ samples: [Float]) -> (frequency: Double, clarity: Double) {
        guard samples.count >= size else { return (0, 0) }
        let tauMax = self.tauMax, tauMin = self.tauMin, size = self.size, span = self.span
        let sampleRate = self.sampleRate
        return samples.withUnsafeBufferPointer { x in
            cmnd.withUnsafeMutableBufferPointer { cmnd in
                var peak: Float = 0
                for i in 0..<size { let a = abs(x[i]); if a > peak { peak = a } }
                if peak < PitchDetector.silence { return (0, 0) }

                cmnd[0] = 1
                var running = 0.0
                for tau in 1...tauMax {
                    var sum = 0.0
                    for j in 0..<span { let d = Double(x[j] - x[j + tau]); sum += d * d }
                    running += sum
                    cmnd[tau] = running > 0 ? Float(sum * Double(tau) / running) : 1
                }

                // The first dip under the threshold, followed down to its bottom: the shortest
                // period that repeats — a longer one (an octave below) would dip as deep.
                var tau = -1
                var t = tauMin
                while t <= tauMax {
                    if cmnd[t] < PitchDetector.threshold {
                        while t + 1 <= tauMax && cmnd[t + 1] < cmnd[t] { t += 1 }
                        tau = t
                        break
                    }
                    t += 1
                }
                if tau < 0 || tau >= tauMax {       // nothing repeats, or the period runs out of the range
                    var lowest: Float = 1
                    for i in tauMin...tauMax where cmnd[i] < lowest { lowest = cmnd[i] }
                    return (0, min(1, max(0, 1 - Double(lowest))))
                }

                // The bottom between the samples: a parabola through the dip and its neighbours.
                let a = Double(cmnd[tau - 1]), b = Double(cmnd[tau]), c = Double(cmnd[tau + 1])
                let bend = a - 2 * b + c
                let shift = bend > 0 ? (a - c) / (2 * bend) : 0
                return (sampleRate / (Double(tau) + shift), min(1, max(0, 1 - b)))
            }
        }
    }
}
