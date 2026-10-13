package org.vspimu.health

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.util.ArrayDeque

/** All GATT operations and listener callbacks are serialized on the main looper.
 * The activity owns runtime permission prompts, consent, session timing, and lifecycle stops.
 * A successful command callback means ATT write completion, not firmware acquisition ACK.
 */
@SuppressLint("MissingPermission")
class BleClient(context: Context, private val listener: Listener) {
    enum class State { IDLE, SCANNING, CONNECTING, DISCOVERING, NEGOTIATING_MTU, SUBSCRIBING, READY, DISCONNECTED, ERROR, CLOSED }
    data class Device(val address: String, val name: String, val rssi: Int)
    interface Listener {
        fun onDevice(device: Device)
        fun onState(state: State, detail: String)
        fun onSamples(samples: List<ImuProtocol.ShankSample>, receiptNs: Long)
        fun onError(message: String)
        fun onMalformed(bytes: Int, reason: String) {}
    }
    private data class CommandRequest(val command: ImuProtocol.Command, val completion: (Boolean, String) -> Unit)
    private enum class Operation { CONNECT, DISCOVER, MTU, CCCD, COMMAND }
    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val adapter: BluetoothAdapter? = (appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
    private var scanner: BluetoothLeScanner? = null
    private var scanCallback: ScanCallback? = null
    private var scanTimeout: Runnable? = null
    private val found = linkedSetOf<String>()
    private var gatt: BluetoothGatt? = null
    private var data: BluetoothGattCharacteristic? = null
    private var commandCharacteristic: BluetoothGattCharacteristic? = null
    private var pending: Operation? = null
    private var operationTimeout: Runnable? = null
    private val commands = ArrayDeque<CommandRequest>()
    private var activeCommand: CommandRequest? = null
    private var closed = false
    var state: State = State.IDLE
        private set

    fun startScan() = onMain {
        if (closed) { listener.onError("BLE client is closed"); return@onMain }
        if (gatt != null) { listener.onError("Disconnect before scanning again"); return@onMain }
        stopScanInternal()
        if (!hasScanPermission() || !hasConnectPermission()) {
            fail("Bluetooth scan/connect permission is missing"); return@onMain
        }
        try {
            if (adapter?.isEnabled != true) { fail("Bluetooth is unavailable or disabled"); return@onMain }
            val currentScanner = adapter.bluetoothLeScanner
            if (currentScanner == null) { fail("BLE scanner is unavailable"); return@onMain }
            found.clear()
            val callback = object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult) = onMain {
                    if (scanCallback !== this) return@onMain
                    val advertisedName = result.scanRecord?.deviceName
                    val advertisesService = result.scanRecord?.serviceUuids?.any { it.uuid == ImuProtocol.SERVICE_UUID } == true
                    // V6 firmware advertises a name, but does not add its service UUID to advertising.
                    if (advertisedName != ImuProtocol.DEVICE_NAME && !advertisesService) return@onMain
                    try {
                        val address = result.device.address
                        if (found.add(address)) listener.onDevice(Device(address, advertisedName ?: ImuProtocol.DEVICE_NAME, result.rssi))
                    } catch (_: SecurityException) { fail("Bluetooth permission was revoked during scan") }
                }
                override fun onBatchScanResults(results: MutableList<ScanResult>) {
                    results.forEach { onScanResult(0, it) }
                }
                override fun onScanFailed(errorCode: Int) = onMain {
                    if (scanCallback === this) fail("BLE scan failed (code $errorCode)")
                }
            }
            scanner = currentScanner
            scanCallback = callback
            changeState(State.SCANNING, "Select the wearable from discovered devices")
            currentScanner.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), callback)
            scanTimeout = Runnable {
                stopScanInternal()
                if (state == State.SCANNING) changeState(State.IDLE, if (found.isEmpty()) "No matching wearable found; retry scan" else "Scan complete; select a wearable")
            }.also { main.postDelayed(it, SCAN_TIMEOUT_MS) }
        } catch (_: SecurityException) { fail("Bluetooth scan permission was denied") }
        catch (e: RuntimeException) { fail("Unable to scan: ${e.javaClass.simpleName}") }
    }

    fun stopScan() = onMain {
        stopScanInternal()
        if (state == State.SCANNING) changeState(State.IDLE, "Scan stopped")
    }

    fun connect(address: String) = onMain {
        if (closed) { listener.onError("BLE client is closed"); return@onMain }
        if (!BluetoothAdapter.checkBluetoothAddress(address)) { fail("Invalid BLE device address"); return@onMain }
        if (!hasConnectPermission()) { fail("Bluetooth connect permission is missing"); return@onMain }
        stopScanInternal()
        releaseGatt("Connection replaced")
        try {
            if (adapter?.isEnabled != true) { fail("Bluetooth is unavailable or disabled"); return@onMain }
            changeState(State.CONNECTING, "Connecting to selected wearable")
            armTimeout(Operation.CONNECT)
            gatt = adapter.getRemoteDevice(address).connectGatt(appContext, false, callback, android.bluetooth.BluetoothDevice.TRANSPORT_LE)
            if (gatt == null) fail("Android could not create a BLE connection")
        } catch (_: SecurityException) { fail("Bluetooth connect permission was denied") }
        catch (e: RuntimeException) { fail("Unable to connect: ${e.javaClass.simpleName}") }
    }

    fun command(command: ImuProtocol.Command, completion: (Boolean, String) -> Unit) = onMain {
        if (closed || state != State.READY || gatt == null) {
            completion(false, "Wearable is not ready"); return@onMain
        }
        if (commands.size >= MAX_QUEUED_COMMANDS) { completion(false, "Command queue is full"); return@onMain }
        commands.add(CommandRequest(command, completion))
        writeNextCommand()
    }

    fun disconnect() = onMain {
        stopScanInternal()
        releaseGatt("Disconnected")
        if (!closed) changeState(State.DISCONNECTED, "Disconnected")
    }
    fun close() = onMain {
        stopScanInternal()
        releaseGatt("BLE client closed")
        closed = true
        changeState(State.CLOSED, "BLE client closed")
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(current: BluetoothGatt, status: Int, newState: Int) = onMain {
            if (gatt !== current) return@onMain
            if (status != BluetoothGatt.GATT_SUCCESS) { fail("BLE connection failed (status $status)"); return@onMain }
            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                releaseGatt("Wearable disconnected")
                changeState(State.DISCONNECTED, "Wearable disconnected; recording must be interrupted")
                return@onMain
            }
            if (newState != BluetoothProfile.STATE_CONNECTED || pending != Operation.CONNECT) return@onMain
            clearTimeout()
            changeState(State.DISCOVERING, "Checking wearable services")
            armTimeout(Operation.DISCOVER)
            try { if (!current.discoverServices()) fail("Service discovery could not start") }
            catch (_: SecurityException) { fail("Bluetooth permission revoked during discovery") }
            catch (e: RuntimeException) { fail("Service discovery failed: ${e.javaClass.simpleName}") }
        }

        override fun onServicesDiscovered(current: BluetoothGatt, status: Int) = onMain {
            if (gatt !== current || pending != Operation.DISCOVER) return@onMain
            if (status != BluetoothGatt.GATT_SUCCESS) { fail("Service discovery failed (status $status)"); return@onMain }
            clearTimeout()
            val service = current.getService(ImuProtocol.SERVICE_UUID)
            data = service?.getCharacteristic(ImuProtocol.DATA_UUID)
            commandCharacteristic = service?.getCharacteristic(ImuProtocol.COMMAND_UUID)
            if (data == null || commandCharacteristic == null ||
                data!!.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY == 0 ||
                commandCharacteristic!!.properties and BluetoothGattCharacteristic.PROPERTY_WRITE == 0 ||
                data!!.getDescriptor(ImuProtocol.CCCD_UUID) == null) {
                fail("Wearable lacks required raw/command/notification services"); return@onMain
            }
            changeState(State.NEGOTIATING_MTU, "Requesting packet size for complete raw records")
            armTimeout(Operation.MTU)
            try { if (!current.requestMtu(ImuProtocol.REQUESTED_MTU)) fail("MTU negotiation could not start") }
            catch (_: SecurityException) { fail("Bluetooth permission revoked during MTU negotiation") }
            catch (e: RuntimeException) { fail("MTU negotiation failed: ${e.javaClass.simpleName}") }
        }

        override fun onMtuChanged(current: BluetoothGatt, mtu: Int, status: Int) = onMain {
            if (gatt !== current || pending != Operation.MTU) return@onMain
            if (status != BluetoothGatt.GATT_SUCCESS || mtu < ImuProtocol.MIN_MTU) {
                fail("Wearable needs MTU >=${ImuProtocol.MIN_MTU}; negotiated $mtu (status $status)"); return@onMain
            }
            clearTimeout()
            changeState(State.SUBSCRIBING, "Enabling raw data notifications")
            armTimeout(Operation.CCCD)
            try {
                if (!current.setCharacteristicNotification(data!!, true)) { fail("Local notification registration failed"); return@onMain }
                val descriptor = data!!.getDescriptor(ImuProtocol.CCCD_UUID)
                val accepted = if (Build.VERSION.SDK_INT >= 33)
                    current.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == 0
                else {
                    @Suppress("DEPRECATION")
                    descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    current.writeDescriptor(descriptor)
                }
                if (!accepted) fail("Notification subscription write could not start")
            } catch (_: SecurityException) { fail("Bluetooth permission revoked during notification registration") }
            catch (e: RuntimeException) { fail("Notification registration failed: ${e.javaClass.simpleName}") }
        }

        override fun onDescriptorWrite(current: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) = onMain {
            if (gatt !== current || pending != Operation.CCCD || descriptor.uuid != ImuProtocol.CCCD_UUID ||
                descriptor.characteristic.uuid != ImuProtocol.DATA_UUID) return@onMain
            if (status != BluetoothGatt.GATT_SUCCESS) { fail("Notification subscription failed (status $status)"); return@onMain }
            clearTimeout()
            changeState(State.READY, "Wearable ready; acquisition has not started")
        }

        @Deprecated("Used on Android before API 33")
        override fun onCharacteristicChanged(current: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT >= 33) return
            @Suppress("DEPRECATION")
            receive(current, characteristic, characteristic.value?.copyOf() ?: byteArrayOf(), SystemClock.elapsedRealtimeNanos())
        }
        override fun onCharacteristicChanged(current: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            receive(current, characteristic, value.copyOf(), SystemClock.elapsedRealtimeNanos())
        }

        override fun onCharacteristicWrite(current: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) = onMain {
            if (gatt !== current || pending != Operation.COMMAND || characteristic.uuid != ImuProtocol.COMMAND_UUID) return@onMain
            if (status != BluetoothGatt.GATT_SUCCESS) { fail("Command write failed (status $status)"); return@onMain }
            val completed = activeCommand
            activeCommand = null
            clearTimeout()
            completed?.completion?.invoke(true, "${completed.command} transport write completed; firmware does not acknowledge acquisition")
            writeNextCommand()
        }
    }

    private fun receive(current: BluetoothGatt, characteristic: BluetoothGattCharacteristic, bytes: ByteArray, receiptNs: Long) = onMain {
        if (gatt !== current || state != State.READY || characteristic.uuid != ImuProtocol.DATA_UUID) return@onMain
        val samples = try { ImuProtocol.decode(bytes) }
        catch (e: IllegalArgumentException) {
            listener.onMalformed(bytes.size, e.message ?: "Malformed raw notification")
            return@onMain
        }
        listener.onSamples(samples, receiptNs)
    }

    private fun writeNextCommand() {
        if (pending != null || activeCommand != null || commands.isEmpty() || state != State.READY) return
        val current = gatt ?: return
        val characteristic = commandCharacteristic ?: return
        activeCommand = commands.removeFirst()
        armTimeout(Operation.COMMAND)
        try {
            val accepted = if (Build.VERSION.SDK_INT >= 33)
                current.writeCharacteristic(characteristic, activeCommand!!.command.bytes(), BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == 0
            else {
                characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                @Suppress("DEPRECATION")
                characteristic.value = activeCommand!!.command.bytes()
                @Suppress("DEPRECATION")
                current.writeCharacteristic(characteristic)
            }
            if (!accepted) fail("Command write could not start")
        } catch (_: SecurityException) { fail("Bluetooth permission revoked during command write") }
        catch (e: RuntimeException) { fail("Command write failed: ${e.javaClass.simpleName}") }
    }

    private fun armTimeout(operation: Operation) {
        clearTimeout()
        pending = operation
        operationTimeout = Runnable { fail("BLE ${operation.name.lowercase()} timed out") }.also { main.postDelayed(it, OPERATION_TIMEOUT_MS) }
    }
    private fun clearTimeout() {
        operationTimeout?.let { main.removeCallbacks(it) }
        operationTimeout = null
        pending = null
    }
    private fun stopScanInternal() {
        scanTimeout?.let { main.removeCallbacks(it) }
        scanTimeout = null
        val callback = scanCallback
        scanCallback = null
        try { if (callback != null) scanner?.stopScan(callback) }
        catch (_: SecurityException) { listener.onError("Bluetooth permission revoked while stopping scan") }
        catch (_: RuntimeException) { listener.onError("Android could not stop the BLE scan") }
        scanner = null
    }
    private fun releaseGatt(reason: String) {
        clearTimeout()
        val current = gatt
        gatt = null // Ignore late callbacks before disconnect/close.
        data = null
        commandCharacteristic = null
        val callbacks = mutableListOf<CommandRequest>()
        activeCommand?.let { callbacks.add(it) }
        activeCommand = null
        while (commands.isNotEmpty()) callbacks.add(commands.removeFirst())
        try { current?.disconnect() } catch (_: SecurityException) { /* Close still attempted below. */ }
        catch (_: RuntimeException) { /* Already invalidated. */ }
        try { current?.close() } catch (_: SecurityException) { /* Permission revoked. */ }
        catch (_: RuntimeException) { /* Already invalidated. */ }
        callbacks.forEach { it.completion(false, reason) }
    }
    private fun fail(reason: String) {
        stopScanInternal()
        releaseGatt(reason)
        changeState(State.ERROR, reason)
        listener.onError(reason)
    }
    private fun changeState(next: State, detail: String) { state = next; listener.onState(next, detail) }
    private fun hasConnectPermission() = Build.VERSION.SDK_INT < 31 || appContext.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
    private fun hasScanPermission() = appContext.checkSelfPermission(if (Build.VERSION.SDK_INT >= 31) Manifest.permission.BLUETOOTH_SCAN else Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    private fun onMain(action: () -> Unit) {
        if (Looper.myLooper() == main.looper) action() else main.post { action() }
    }
    companion object {
        private const val OPERATION_TIMEOUT_MS = 12_000L
        private const val SCAN_TIMEOUT_MS = 15_000L
        private const val MAX_QUEUED_COMMANDS = 8
    }
}
