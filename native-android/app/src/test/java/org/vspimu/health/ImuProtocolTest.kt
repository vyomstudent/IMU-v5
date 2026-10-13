package org.vspimu.health

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32

class ImuProtocolTest {
    private fun record(sequence: Long, vararg axes: Int): ByteArray = ByteBuffer.allocate(16)
        .order(ByteOrder.LITTLE_ENDIAN).apply {
            putInt(sequence.toInt())
            axes.forEach { putShort(it.toShort()) }
        }.array()

    @Test fun signedAxesAndUnsignedSequenceArePreserved() {
        val sample = ImuProtocol.decode(record(0xffff8001L, -32768, -1, 32767, 0, 1, -2)).single()
        assertEquals(0xffff8001L, sample.sequence)
        assertEquals(-32768, sample.ax)
        assertEquals(-1, sample.ay)
        assertEquals(32767, sample.az)
        assertEquals(0, sample.gx)
        assertEquals(1, sample.gy)
        assertEquals(-2, sample.gz)
    }
    @Test fun fullAndFinalPartialPacketsDecodeWithoutPadding() {
        val full = (0L..11L).flatMap { record(it, 1, 2, 3, 4, 5, 6).toList() }.toByteArray()
        assertEquals(192, full.size)
        assertEquals((0L..11L).toList(), ImuProtocol.decode(full).map { it.sequence })
        assertEquals(1, ImuProtocol.decode(record(12, 0, 0, 0, 0, 0, 0)).size)
    }
    @Test fun malformedPacketIsRejectedAsAWhole() {
        listOf(0, 1, 15, 17, 191, 193, 208).forEach { size ->
            try { ImuProtocol.decode(ByteArray(size)); fail("Accepted $size bytes") }
            catch (_: IllegalArgumentException) { /* expected */ }
        }
    }
    @Test fun legacyScalingAndNominalTimeAreExplicit() {
        val sample = ImuProtocol.decode(record(208, 8192, 0, 0, 100, 0, 0)).single()
        assertEquals(9.80665, sample.axMps2, 1e-12)
        assertEquals(Math.toRadians(7.0), sample.gxRadPerSecond, 1e-12)
        assertEquals(1.0, sample.nominalTimeSeconds, 0.0)
    }
    @Test fun trackerKeepsGapsDuplicateAndBackwardsSeparate() {
        val tracker = ImuProtocol.SequenceTracker()
        assertEquals(3L, tracker.observe(3).missing)
        assertEquals(0L, tracker.observe(4).missing)
        assertEquals(2L, tracker.observe(7).missing)
        assertTrue(tracker.observe(7).duplicate)
        assertTrue(tracker.observe(6).backwards)
        assertEquals(0L, tracker.observe(8).missing)
        tracker.reset()
        assertEquals(0L, tracker.observe(0).missing)
    }
    @Test fun trackerAcceptsUint32WrapWithoutInventingBillionsOfMissingSamples() {
        val tracker = ImuProtocol.SequenceTracker()
        tracker.observe(0xffffffffL)
        assertEquals(0L, tracker.observe(0).missing)
        assertEquals(0L, tracker.observe(1).missing)
    }
    @Test fun byteLayoutMatchesV5ParityCrcGoldenVector() {
        // CRC bytes are uint32 sequence followed by six int16, all LE: 16 bytes total.
        val bytes = record(0x12345678, -1, 0x1234, -32768, 32767, 1, -2)
        assertEquals("78563412ffff34120080ff7f0100feff", bytes.joinToString("") { "%02x".format(it.toInt() and 255) })
        val crc = CRC32().apply { update(bytes) }
        assertEquals(0x4d51577cL, crc.value)
    }
    @Test fun commandsHaveNoNewlineAndUseUtf8() {
        assertArrayEquals("START".toByteArray(Charsets.UTF_8), ImuProtocol.Command.START.bytes())
        assertArrayEquals("STOP".toByteArray(Charsets.UTF_8), ImuProtocol.Command.STOP.bytes())
        assertArrayEquals("PING".toByteArray(Charsets.UTF_8), ImuProtocol.Command.PING.bytes())
    }
}
