package dev.tinyrtc

import java.nio.ByteBuffer

/**
 * The little of H.264 the half reads: where the parameter sets are in an Annex B access unit, and
 * the picture size an SPS declares (to configure a decoder). Nothing is rewritten.
 */
internal object H264 {
    const val SPS = 7
    const val PPS = 8
    private const val SLICE = 1
    private const val IDR = 5

    val START_CODE = byteArrayOf(0, 0, 0, 1)

    /**
     * Encoder side: the access unit (Annex B, in a MediaCodec buffer) holds an SPS and a PPS
     * before its first slice. Stops at the first slice: the scan costs a few bytes.
     */
    fun hasParameterSets(buffer: ByteBuffer, offset: Int, length: Int): Boolean {
        var sps = false
        var pps = false
        var zeros = 0
        var i = offset
        val end = offset + length
        while (i < end) {
            val v = buffer.get(i).toInt() and 0xff
            if (v == 0) {
                zeros++
            } else {
                if (v == 1 && zeros >= 2 && i + 1 < end) {
                    when (buffer.get(i + 1).toInt() and 0x1f) {
                        SPS -> sps = true
                        PPS -> pps = true
                        SLICE, IDR -> return sps && pps
                    }
                    if (sps && pps) return true
                }
                zeros = 0
            }
            i++
        }
        return sps && pps
    }

    /**
     * Decoder side: the first SPS and PPS of an access unit as the shim frames it (a start code
     * before every NAL unit, none inside one), without their start codes.
     */
    fun parameterSets(au: ByteArray): Pair<ByteArray?, ByteArray?> {
        var sps: ByteArray? = null
        var pps: ByteArray? = null
        var start = nextUnit(au, 0)
        while (start in 0 until au.size) {
            val next = nextUnit(au, start)
            val end = if (next < 0) au.size else next - 3 // the 00 00 01 of the next unit; its leading zero is trimmed below
            var last = end
            while (last > start && au[last - 1].toInt() == 0) last--
            when (au[start].toInt() and 0x1f) {
                SPS -> if (sps == null) sps = au.copyOfRange(start, last)
                PPS -> if (pps == null) pps = au.copyOfRange(start, last)
                SLICE, IDR -> return sps to pps
            }
            if (next < 0) break
            start = next
        }
        return sps to pps
    }

    /** The index right after the next 00 00 01 at or after [from], or -1. */
    private fun nextUnit(au: ByteArray, from: Int): Int {
        var zeros = 0
        var i = from
        while (i < au.size) {
            val v = au[i].toInt()
            if (v == 0) {
                zeros++
            } else {
                if (v == 1 && zeros >= 2) return i + 1
                zeros = 0
            }
            i++
        }
        return -1
    }

    /** The picture an SPS (a NAL unit, header byte first) declares, after cropping; null if it does not parse. */
    fun spsSize(sps: ByteArray): Pair<Int, Int>? = try {
        val r = Bits(unescape(sps, 1))
        val profile = r.u(8)
        r.u(8) // constraint flags
        r.u(8) // level
        r.ue() // seq_parameter_set_id
        var chroma = 1
        if (profile in HIGH_PROFILES) {
            chroma = r.ue()
            if (chroma == 3) r.u(1) // separate_colour_plane_flag
            r.ue() // bit_depth_luma_minus8
            r.ue() // bit_depth_chroma_minus8
            r.u(1) // qpprime_y_zero_transform_bypass_flag
            if (r.u(1) == 1) { // seq_scaling_matrix_present_flag
                for (i in 0 until if (chroma != 3) 8 else 12) {
                    if (r.u(1) == 1) skipScalingList(r, if (i < 6) 16 else 64)
                }
            }
        }
        r.ue() // log2_max_frame_num_minus4
        when (r.ue()) { // pic_order_cnt_type
            0 -> r.ue()
            1 -> {
                r.u(1)
                r.se()
                r.se()
                repeat(r.ue()) { r.se() }
            }
        }
        r.ue() // max_num_ref_frames
        r.u(1) // gaps_in_frame_num_value_allowed_flag
        val widthMbs = r.ue() + 1
        val heightUnits = r.ue() + 1
        val frameMbsOnly = r.u(1)
        if (frameMbsOnly == 0) r.u(1) // mb_adaptive_frame_field_flag
        r.u(1) // direct_8x8_inference_flag
        var width = widthMbs * 16
        var height = (2 - frameMbsOnly) * heightUnits * 16
        if (r.u(1) == 1) { // frame_cropping_flag
            val left = r.ue()
            val right = r.ue()
            val top = r.ue()
            val bottom = r.ue()
            val unitX = if (chroma == 1 || chroma == 2) 2 else 1
            val unitY = (if (chroma == 1) 2 else 1) * (2 - frameMbsOnly)
            width -= unitX * (left + right)
            height -= unitY * (top + bottom)
        }
        if (width > 0 && height > 0) width to height else null
    } catch (e: RuntimeException) {
        null
    }

    private val HIGH_PROFILES = setOf(100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135)

    private fun skipScalingList(r: Bits, size: Int) {
        var last = 8
        var next = 8
        repeat(size) {
            if (next != 0) next = (last + r.se() + 256) % 256
            if (next != 0) last = next
        }
    }

    /** The RBSP of a NAL unit from [from]: the emulation prevention bytes (00 00 03) removed. */
    private fun unescape(nal: ByteArray, from: Int): ByteArray {
        val out = ByteArray(nal.size)
        var n = 0
        var zeros = 0
        for (i in from until nal.size) {
            val v = nal[i].toInt() and 0xff
            if (zeros >= 2 && v == 3) {
                zeros = 0
                continue
            }
            out[n++] = nal[i]
            zeros = if (v == 0) zeros + 1 else 0
        }
        return out.copyOf(n)
    }

    private class Bits(private val data: ByteArray) {
        private var at = 0

        fun bit(): Int {
            val byte = at ushr 3
            if (byte >= data.size) throw IndexOutOfBoundsException("SPS too short")
            val bit = (data[byte].toInt() shr (7 - (at and 7))) and 1
            at++
            return bit
        }

        fun u(n: Int): Int {
            var v = 0
            repeat(n) { v = (v shl 1) or bit() }
            return v
        }

        fun ue(): Int {
            var zeros = 0
            while (bit() == 0) {
                if (++zeros > 30) throw IllegalStateException("bad exp-Golomb code")
            }
            return (1 shl zeros) - 1 + u(zeros)
        }

        fun se(): Int {
            val k = ue()
            return if (k and 1 == 1) (k + 1) / 2 else -(k / 2)
        }
    }
}
