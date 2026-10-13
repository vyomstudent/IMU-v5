package org.vspimu.health

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock

/** Foreground-only acquisition. Controller must call stop on pause/interruption. */
class PhoneSensors(context: Context, private val listener: Listener) : SensorEventListener {
    enum class Kind { ACCELEROMETER, GYROSCOPE }
    data class PhoneSample(
        val kind: Kind, val timestampNs: Long, val receiptNs: Long, val accuracy: Int,
        val x: Double, val y: Double, val z: Double
    )
    data class Status(
        val accAvailable: Boolean, val gyroAvailable: Boolean,
        val accEnabled: Boolean, val gyroEnabled: Boolean
    )
    interface Listener {
        fun onSample(sample: PhoneSample)
        fun onStatus(status: Status)
        fun onError(message: String)
    }

    private val main = Handler(Looper.getMainLooper())
    private val manager = context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private val acc = manager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val gyro = manager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    private var accEnabled = false
    private var gyroEnabled = false
    private var closed = false
    private var accepting = false
    private var startedNs = 0L

    fun status(): Status = Status(acc != null, gyro != null, accEnabled, gyroEnabled)

    /** Request 100 Hz without high-rate permission; measured rate may differ on each handset. */
    fun start() = onMain {
        if (closed) { listener.onError("Phone sensors are closed"); return@onMain }
        stopInternal()
        startedNs = SystemClock.elapsedRealtimeNanos()
        try {
            accEnabled = acc?.let { manager?.registerListener(this, it, 10_000, 0, main) } == true
            gyroEnabled = gyro?.let { manager?.registerListener(this, it, 10_000, 0, main) } == true
            accepting = accEnabled || gyroEnabled
            listener.onStatus(status())
            if (!accepting) listener.onError("No phone motion sensors could be registered")
            else if ((acc != null && !accEnabled) || (gyro != null && !gyroEnabled))
                listener.onError("One phone motion sensor could not be registered; recording is partial")
        } catch (e: RuntimeException) {
            stopInternal()
            listener.onStatus(status())
            listener.onError("Phone sensor registration failed: ${e.javaClass.simpleName}")
        }
    }

    fun stop() = onMain { stopInternal(); listener.onStatus(status()) }
    fun close() = onMain { stopInternal(); closed = true; listener.onStatus(status()) }
    private fun stopInternal() {
        accepting = false
        manager?.unregisterListener(this)
        accEnabled = false
        gyroEnabled = false
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (!accepting || closed) return
        if (event.timestamp < startedNs) return // Do not admit queued events from an earlier session.
        val receipt = SystemClock.elapsedRealtimeNanos()
        val kind = when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> if (accEnabled) Kind.ACCELEROMETER else return
            Sensor.TYPE_GYROSCOPE -> if (gyroEnabled) Kind.GYROSCOPE else return
            else -> return
        }
        if (event.timestamp <= 0 || event.values.size < 3 || event.values.take(3).any { !it.isFinite() }) {
            listener.onError("Invalid phone sensor event discarded")
            return
        }
        // Android supplies m/s² including gravity, and rad/s. Do not normalize or rotate raw data.
        listener.onSample(PhoneSample(kind, event.timestamp, receipt, event.accuracy,
            event.values[0].toDouble(), event.values[1].toDouble(), event.values[2].toDouble()))
    }
    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    private fun onMain(action: () -> Unit) {
        if (Looper.myLooper() == main.looper) action() else main.post { action() }
    }
}
