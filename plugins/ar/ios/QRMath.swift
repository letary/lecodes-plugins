//
//  QRMath.swift — lecodes-plugins/ar
//
//  The pose math of the QR targets (QRTracker.swift): the twins of web/pose.ts in simd, in doubles
//  (the detector's matrix_gl is f64; a float only where a matrix goes to the engine or to ARKit).
//  Column-major 4×4 matrices — the detector's, ARKit's and the gl facade's — unit quaternions,
//  poses in metres.
//

import simd

/// A rigid pose: where (metres) and turned how.
struct QRPose {
    var position: simd_double3
    var rotation: simd_quatd

    /// The pose of a rigid column-major 4×4 matrix (its columns normalized: a float matrix of ARKit's
    /// carries a little scale noise).
    init(_ m: simd_double4x4) {
        position = simd_double3(m.columns.3.x, m.columns.3.y, m.columns.3.z)
        let r = simd_double3x3(simd_normalize(simd_double3(m.columns.0.x, m.columns.0.y, m.columns.0.z)),
                               simd_normalize(simd_double3(m.columns.1.x, m.columns.1.y, m.columns.1.z)),
                               simd_normalize(simd_double3(m.columns.2.x, m.columns.2.y, m.columns.2.z)))
        rotation = simd_quatd(r).normalized
    }

    init(_ m: simd_float4x4) { self.init(QRMath.double(m)) }

    /// The pose as a column-major 4×4 world matrix.
    var matrix: simd_double4x4 {
        var m = simd_double4x4(rotation)
        m.columns.3 = simd_double4(position, 1)
        return m
    }
}

/// A picture's intrinsics, px of the full plane in ARKit's convention (pixel corners at integers,
/// y down: cx ≈ width / 2).
struct QRIntrinsics {
    let fx: Double, fy: Double, cx: Double, cy: Double
}

enum QRMath {

    static let degrees = 180 / Double.pi

    static func double(_ m: simd_float4x4) -> simd_double4x4 {
        simd_double4x4(columns: (simd_double4(m.columns.0), simd_double4(m.columns.1),
                                 simd_double4(m.columns.2), simd_double4(m.columns.3)))
    }

    static func float(_ m: simd_double4x4) -> simd_float4x4 {
        simd_float4x4(columns: (simd_float4(m.columns.0), simd_float4(m.columns.1),
                                simd_float4(m.columns.2), simd_float4(m.columns.3)))
    }

    /// 16 doubles of a column-major 4×4 (the detector's matrix_gl) from `start` on.
    static func matrix(_ values: [Double], at start: Int) -> simd_double4x4 {
        func column(_ c: Int) -> simd_double4 {
            let i = start + c * 4
            return simd_double4(values[i], values[i + 1], values[i + 2], values[i + 3])
        }
        return simd_double4x4(columns: (column(0), column(1), column(2), column(3)))
    }

    /// Metres between two points.
    static func distance(_ a: simd_double3, _ b: simd_double3) -> Double { simd_distance(a, b) }

    /// Degrees between two turns (0 … 180): the angle of the rotation from one to the other.
    static func angle(_ a: simd_quatd, _ b: simd_quatd) -> Double {
        2 * acos(min(1, abs(simd_dot(a.vector, b.vector)))) * degrees
    }

    /// The pose `t` of the way from `a` to `b`: the position along the line, the turn along the
    /// shorter arc.
    static func interpolate(_ a: QRPose, _ b: QRPose, _ t: Double) -> QRPose {
        var p = a
        p.position = a.position + (b.position - a.position) * t
        p.rotation = simd_slerp(a.rotation, b.rotation, t).normalized
        return p
    }

    /// A point of the world in the camera of `inverseCamera` (the inverse of the camera's pose: GL
    /// axes, x right, y up, −z ahead) projected through the intrinsics into the full plane's pixels
    /// (x right, y DOWN, ARKit's convention); nil when it is behind the camera.
    static func project(_ world: simd_double3, _ inverseCamera: simd_double4x4, _ k: QRIntrinsics) -> simd_double2? {
        let p = inverseCamera * simd_double4(world, 1)
        let z = -p.z
        guard z > 1e-6 else { return nil }
        return simd_double2(k.fx * p.x / z + k.cx, k.fy * -p.y / z + k.cy)
    }
}
