package org.vspimu.health

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID

/** V6 raw transport only. Analytics UUID is deliberately never decoded as raw data. */
object ImuProtocol {
    const val DEVICE_NAME = "GAIT-V5-C3"
    val SERVICE_UUID: UUID = UUID.fromString("7b8a0001-4f2a-4a2e-9e51-1d9b6d8d5001")
    val DATA_UUID: UUID = UUID.fromString("7b8a0002-4f2a-4a2e-9e51-1d9b6d8d5001")
    val COMMAND_UUID: UUID = UUID.fromString("7b8a0003-4f2a-4a2e-9e51-1d9b6d8d5001")
    val ANALYTICS_UUID: UUID = UUID.fromString("7b8a0004-4f2a-4a2e-9e51-1d9b6d8d5001")
    val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    const val RECORD_BYTES = 16
    const val MAX_PACKET_BYTES = 192
    const val NOMINAL_HZ = 208
    const val MIN_MTU = 195
    const val REQUESTED_MTU = 247
    // Legacy reference scaling retained exactly; values remain estimates of physical units.
    const val ACC_G_PER_COUNT = 0.0001220703125
    const val STANDARD_GRAVITY = 9.80665
    const val GYRO_DEG_PER_SECOND_PER_COUNT = 0.07

    enum class Command { START, STOP, PING;
        fun bytes(): ByteArray = name.toByteArray(Charsets.UTF_8)
    }

    data class ShankSample(
        val sequence: Long,
        val ax: Int, val ay: Int, val az: Int,
        val gx: Int, val gy: Int, val gz: Int
    ) {
        /** Sequence-derived elapsed time, not an Android acquisition timestamp. */
        val nominalTimeSeconds: Double get() = sequence.toDouble() / NOMINAL_HZ
        val axMps2: Double get() = ax * ACC_G_PER_COUNT * STANDARD_GRAVITY
        val ayMps2: Double get() = ay * ACC_G_PER_COUNT * STANDARD_GRAVITY
        val azMps2: Double get() = az * ACC_G_PER_COUNT * STANDARD_GRAVITY
        val gxRadPerSecond: Double get() = Math.toRadians(gx * GYRO_DEG_PER_SECOND_PER_COUNT)
        val gyRadPerSecond: Double get() = Math.toRadians(gy * GYRO_DEG_PER_SECOND_PER_COUNT)
        val gzRadPerSecond: Double get() = Math.toRadians(gz * GYRO_DEG_PER_SECOND_PER_COUNT)
    }

    /** Reject the whole malformed notification; never invent records by padding/truncating. */
    fun decode(payload: ByteArray): List<ShankSample> {
        require(payload.isNotEmpty() && payload.size <= MAX_PACKET_BYTES && payload.size % RECORD_BYTES == 0) {
            "Raw notification must contain 1..12 complete 16-byte records; got ${payload.size} bytes"
        }
        val buffer = ByteBuffer.wrap(payload).order(ByteOrder.LITTLE_ENDIAN)
        return List(payload.size / RECORD_BYTES) {
            val low = buffer.short.toInt() and 0xffff
            val high = buffer.short.toInt() and 0xffff
            ShankSample((high.toLong() shl 16) or low.toLong(),
                buffer.short.toInt(), buffer.short.toInt(), buffer.short.toInt(),
                buffer.short.toInt(), buffer.short.toInt(), buffer.short.toInt())
        }
    }

    /** Reset at each session START. Duplicates/reversed packets cannot move the high watermark. */
    class SequenceTracker {
        private var last: Long? = null
        data class Delta(val missing: Long = 0, val duplicate: Boolean = false, val backwards: Boolean = false)
        fun reset() { last = null }
        fun observe(sequence: Long): Delta {
            require(sequence in 0..0xffffffffL)
            val previous = last
            if (previous == null) {
                last = sequence
                return Delta(missing = sequence) // Sequence starts at zero; initial loss is evidence too.
            }
            val advance = (sequence - previous) and 0xffffffffL
            if (advance == 0L) return Delta(duplicate = true)
            if (advance >= 0x80000000L) return Delta(backwards = true)
            last = sequence
            return Delta(missing = advance - 1)
        }
    }
}
