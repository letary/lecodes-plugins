//
//  PitchDetector.swift — lecodes-plugins/audio-recorder
//
//  The note detector: YIN (de Cheveigné & Kawahara, 2002) over one window of samples. ONE
//  algorithm in three languages — web/pitch.ts (where its notes are),
//  android/…/PitchDetector.kt and this file are the same steps with the same constants; change
//  them together.
//

import Foundation

/// The band the detector listens through: 55 Hz – 2 kHz, two Butterworth biquads over the STREAM
/// of samples (it keeps its state: every sample goes through, in order). Why: web/pitch.ts, "the filter".
final class PitchFilter {
    private var high: Biquad
    private var low: Biquad

    init(sampleRate: Double) {
        high = Biquad(sampleRate, 55, highPass: true)
        low = Biquad(sampleRate, 2000, highPass: false)
    }

    func step(_ x: Float) -> Float { Float(low.step(high.step(Double(x)))) }

    /// An RBJ biquad, Q = 1/√2, direct form I.
    private struct Biquad {
        let b0: Double, b1: Double, a1: Double, a2: Double
        var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0

        init(_ sampleRate: Double, _ hz: Double, highPass: Bool) {
            let w = 2 * Double.pi * hz / sampleRate
            let c = cos(w)
            let alpha = sin(w) / (2 * 0.5.squareRoot())
            let a0 = 1 + alpha
            b0 = (highPass ? (1 + c) / 2 : (1 - c) / 2) / a0
            b1 = (highPass ? -(1 + c) : 1 - c) / a0
            a1 = -2 * c / a0
            a2 = (1 - alpha) / a0
        }

        mutating func step(_ x: Double) -> Double {
            let y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2
            x2 = x1; x1 = x
            y2 = y1; y1 = y
            return y
        }
    }
}

final class PitchDetector {

    private static let lowestHz = 60.0
    private static let highestHz = 1500.0
    private static let windowSeconds = 0.0464
    private static let threshold: Float = 0.15
    private static let silence: Float = 0.001

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
