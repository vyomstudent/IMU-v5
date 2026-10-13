package org.vspimu.health

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.*
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import kotlin.math.sqrt

/** Foreground assessment controller. No remote service, JavaScript bridge or automatic sharing. */
class MainActivity : Activity(), BleClient.Listener, PhoneSensors.Listener {
    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var ble: BleClient
    private lateinit var sensors: PhoneSensors
    private lateinit var store: SessionStore
    private lateinit var page: WebView
    private lateinit var statusText: TextView
    private lateinit var consent: CheckBox
    private lateinit var phoneOptIn: CheckBox
    private lateinit var leg: Spinner
    private lateinit var pocket: Spinner
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private var pageReady = false
    private var active = false
    private var starting = false
    private var saving = false
    private var deleting = false
    private var destroyed = false
    private var currentId = ""
    private var originNs = 0L
    private var startedUtc = ""
    private var lastShankNs = 0L
    private var stoppedElapsed = 0.0
    private var sessionStatus = "READY"
    private var placement = "Not recorded"
    private var interrupted = false
    private var stopReason = ""
    private var missing = 0L
    private var duplicates = 0
    private var backwards = 0
    private var malformed = 0
    private var clipped = 0
    private val sequences = ImuProtocol.SequenceTracker()
    private var shank = JSONArray()
    private var acc = JSONArray()
    private var gyro = JSONArray()
    private var recent = JSONArray()
    private var events = JSONArray()
    private var latestJson: String? = null
    private var exportJson: String? = null
    private var loadedSnapshot: JSONObject? = null
    private var sensorStatus: PhoneSensors.Status? = null
    private var sessionPhoneEnabled = false
    private var wearableLeg = ""
    private var phonePocket = ""
    private var loadGeneration = 0L
    private var startDispatchNs = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = SessionStore(this)
        ble = BleClient(this, this)
        sensors = PhoneSensors(this, this)
        sensorStatus = sensors.status()
        buildScreen()
        io.execute {
            val unfinished = store.hasActive()
            runOnUiThread {
                if (unfinished) message("Previous assessment was interrupted. Its live samples were not saved; repeat when ready.")
            }
        }
        handler.post(tick)
    }

    private fun buildScreen() {
        val scroll = ScrollView(this)
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(18), dp(16), dp(24))
            setBackgroundColor(Color.WHITE)
        }
        scroll.addView(body)
        setContentView(scroll)
        scroll.setOnApplyWindowInsetsListener { view, insets ->
            view.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom)
            insets
        }
        body.addView(TextView(this).apply { text = "VSPIMU Health"; textSize = 28f; setTextColor(Color.rgb(18, 40, 63)) })
        body.addView(TextView(this).apply {
            text = "123-second mobility recording: stand still for 8 seconds, then follow your usual assessment instructions. Stop if uncomfortable. Movement observations need clinical review."
            textSize = 18f
        })
        consent = CheckBox(this).apply { text = "I agree to record motion data privately on this phone."; textSize = 18f }
        body.addView(consent)
        phoneOptIn = CheckBox(this).apply { text = "Include phone motion sensors"; isChecked = true; textSize = 18f }
        body.addView(phoneOptIn)
        body.addView(label("Wearable leg"))
        leg = selector(arrayOf("Left leg", "Right leg")); body.addView(leg)
        body.addView(label("Phone placement"))
        pocket = selector(arrayOf("Left front pocket", "Right front pocket")); body.addView(pocket)
        statusText = label("Ready. Connect the wearable to begin."); body.addView(statusText)
        body.addView(button("Find wearable") { requestScan() })
        body.addView(button("Disconnect wearable") { if (active || starting) finishSession("user_disconnect", true); ble.disconnect() })
        startButton = button("Start 123-second assessment") { startAssessment() }; body.addView(startButton)
        stopButton = button("Stop assessment") { finishSession("user_stop", false) }; body.addView(stopButton)
        body.addView(button("Open saved session") { showHistory() })
        body.addView(button("Export session JSON") { exportSession() })
        body.addView(button("Delete all saved sessions") { confirmDelete() })
        page = WebView(this)
        page.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            blockNetworkLoads = true
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            textZoom = 110
        }
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        page.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.toString() != PAGE_URL
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                if (request.url.scheme == "https" && request.url.host == "appassets.androidplatform.net") {
                    loader.shouldInterceptRequest(request.url)?.let { return it }
                }
                return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }
            override fun onPageFinished(view: WebView, url: String) { pageReady = url == PAGE_URL; render() }
        }
        body.addView(page, LinearLayout.LayoutParams(-1, dp(620)))
        page.loadUrl(PAGE_URL)
        updateControls()
    }

    private fun label(value: String) = TextView(this).apply { text = value; textSize = 18f; setPadding(0, dp(8), 0, dp(8)) }
    private fun selector(values: Array<String>) = Spinner(this).apply {
        adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, values)
        minimumHeight = dp(52)
    }
    private fun button(value: String, action: () -> Unit) = Button(this).apply {
        text = value; textSize = 18f; minimumHeight = dp(52); setOnClickListener { action() }
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun message(value: String) { if (!destroyed) statusText.text = value }
    private fun permissions(): Array<String> = if (Build.VERSION.SDK_INT >= 31)
        arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)

    private fun requestScan() {
        if (active || starting || saving || deleting) { message("Stop and save the current assessment first."); return }
        val missingPermissions = permissions().filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missingPermissions.isNotEmpty()) requestPermissions(missingPermissions.toTypedArray(), PERMISSIONS)
        else ble.startScan()
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERMISSIONS) {
            if (this.permissions().all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) ble.startScan()
            else message("Bluetooth permission denied. No assessment has started.")
        }
    }
    override fun onDevice(device: BleClient.Device) {
        if (active || starting || destroyed) return
        ble.stopScan()
        AlertDialog.Builder(this).setTitle("Connect wearable?")
            .setMessage("${device.name}\nSignal ${device.rssi} dBm\nChoose your wearable; Bluetooth name alone does not verify its identity.")
            .setPositiveButton("Connect") { _, _ -> ble.connect(device.address) }
            .setNegativeButton("Cancel", null).show()
    }
    override fun onState(state: BleClient.State, detail: String) {
        message(detail)
        if ((active || starting) && state in setOf(BleClient.State.DISCONNECTED, BleClient.State.ERROR, BleClient.State.CLOSED))
            finishSession("wearable_disconnected", true)
        updateControls()
    }
    override fun onError(message: String) {
        this.message(message)
        if (active || starting) {
            interrupted = true
            events.put(JSONObject().put("kind", "error").put("text", message))
        }
    }
    override fun onMalformed(bytes: Int, reason: String) {
        if (active || starting) { malformed++; events.put(JSONObject().put("kind", "malformed_packet").put("text", "$bytes bytes: $reason")) }
    }
    override fun onStatus(status: PhoneSensors.Status) { sensorStatus = status }

    private fun startAssessment() {
        if (active || starting || saving || deleting) return
        if (!consent.isChecked) { message("Recording requires your consent."); return }
        if (ble.state != BleClient.State.READY) { message("Connect the wearable and wait until it is ready."); return }
        currentId = "session_${UUID.randomUUID()}"
        loadGeneration++
        originNs = SystemClock.elapsedRealtimeNanos(); startedUtc = Instant.now().toString()
        shank = JSONArray(); acc = JSONArray(); gyro = JSONArray(); recent = JSONArray(); events = JSONArray()
        missing = 0; duplicates = 0; backwards = 0; malformed = 0; clipped = 0; sequences.reset()
        interrupted = false; stopReason = ""; stoppedElapsed = 0.0; lastShankNs = 0
        loadedSnapshot = null; latestJson = null
        sessionPhoneEnabled = phoneOptIn.isChecked
        wearableLeg = if (leg.selectedItemPosition == 0) "left" else "right"
        phonePocket = if (pocket.selectedItemPosition == 0) "left_front_pocket" else "right_front_pocket"
        val relationship = if (leg.selectedItemPosition == pocket.selectedItemPosition) "same leg" else "opposite leg"
        placement = "$wearableLeg distal tibia; $phonePocket ($relationship)"
        starting = true; sessionStatus = "STARTING"; updateControls()
        val session = currentId
        val marker = JSONObject().put("sessionId", session).put("startedUtc", startedUtc).put("status", "INTERRUPTED_IF_NOT_FINALIZED").toString()
        io.execute {
            try {
                store.save("active", marker)
                runOnUiThread {
                    if (!starting || currentId != session || destroyed) return@runOnUiThread
                    // Preparation time is not part of the assessment protocol.
                    originNs = SystemClock.elapsedRealtimeNanos()
                    startDispatchNs = originNs
                    startedUtc = Instant.now().toString()
                    ble.command(ImuProtocol.Command.START) { ok, detail ->
                        if (currentId != session || !starting) return@command
                        if (!ok) { finishSession("start_transport_failed", true); message(detail); return@command }
                        starting = false; active = true; sessionStatus = "RECORDING"
                        if (sessionPhoneEnabled) sensors.start()
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        events.put(JSONObject().put("kind", "transport").put("text", "START write completed; firmware acquisition is confirmed only by arriving raw samples."))
                        message("Recording. Wearable data confirmation pending."); updateControls()
                    }
                }
            } catch (e: Exception) {
                runOnUiThread { if (currentId == session) { starting = false; sessionStatus = "SAVE FAILED"; message("Private storage unavailable: ${e.javaClass.simpleName}. No recording started."); updateControls() } }
            }
        }
    }

    override fun onSamples(samples: List<ImuProtocol.ShankSample>, receiptNs: Long) {
        if (!active && !starting) return
        lastShankNs = receiptNs
        for (sample in samples) {
            if (shank.length() >= MAX_SHANK) { finishSession("shank_storage_cap", true); return }
            val delta = sequences.observe(sample.sequence)
            missing += delta.missing
            if (delta.duplicate) duplicates++
            if (delta.backwards) backwards++
            if (listOf(sample.ax,sample.ay,sample.az,sample.gx,sample.gy,sample.gz).any { kotlin.math.abs(it) >= 32760 }) clipped++
            shank.put(JSONArray().put(sample.sequence).put(receiptNs.toString())
                .put(sample.ax).put(sample.ay).put(sample.az).put(sample.gx).put(sample.gy).put(sample.gz))
        }
    }
    override fun onSample(sample: PhoneSensors.PhoneSample) {
        if (!active) return
        val rows = if (sample.kind == PhoneSensors.Kind.ACCELEROMETER) acc else gyro
        if (rows.length() >= MAX_PHONE) { finishSession("phone_storage_cap", true); return }
        rows.put(JSONArray().put(sample.timestampNs.toString()).put(sample.receiptNs.toString()).put(sample.accuracy).put(sample.x).put(sample.y).put(sample.z))
        if (sample.kind == PhoneSensors.Kind.ACCELEROMETER && rows.length() % 10 == 0) {
            recent.put(JSONObject().put("t", (sample.timestampNs - originNs) / 1e9)
                .put("accMagnitude", sqrt(sample.x*sample.x+sample.y*sample.y+sample.z*sample.z)))
            if (recent.length() > 120) recent.remove(0)
        }
    }

    private val tick = object : Runnable {
        override fun run() {
            if (destroyed) return
            if (active) {
                val now = SystemClock.elapsedRealtimeNanos()
                if (elapsed() >= 123.0) finishSession("protocol_complete", false)
                else if (lastShankNs == 0L && elapsed() > 5.0) finishSession("no_wearable_data", true)
                else if (lastShankNs > 0 && now - lastShankNs > 3_000_000_000L) finishSession("wearable_data_silence", true)
            }
            render(); handler.postDelayed(this, 1000)
        }
    }
    private fun elapsed(): Double = if (active || starting) (SystemClock.elapsedRealtimeNanos() - originNs) / 1e9 else stoppedElapsed

    private fun finishSession(reason: String, partial: Boolean) {
        if (!active && !starting) return
        stoppedElapsed = (SystemClock.elapsedRealtimeNanos() - originNs) / 1e9
        active = false; starting = false; interrupted = interrupted || partial; stopReason = reason
        sensors.stop(); window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        sessionStatus = if (interrupted || reason != "protocol_complete") "PARTIAL" else "COMPLETE"
        events.put(JSONObject().put("kind", "stop").put("text", reason))
        saving = true; updateControls(); render()
        val session = currentId
        if (ble.state == BleClient.State.READY) ble.command(ImuProtocol.Command.STOP) { ok, detail ->
            if (session == currentId) {
                events.put(JSONObject().put("kind", "stop_transport").put("text", if (ok) "STOP ATT write completed; no firmware ACK exists." else "STOP unconfirmed: $detail"))
                persistSession(session)
            }
        } else { events.put(JSONObject().put("kind", "stop_transport").put("text", "STOP unconfirmed; connection unavailable.")); persistSession(session) }
    }

    private fun snapshot(): JSONObject {
        loadedSnapshot?.let { return it }
        return JSONObject().put("schemaVersion", 1).put("sessionId", currentId).put("status", sessionStatus)
            .put("elapsedSeconds", elapsed()).put("placement", placement)
            .put("counts", JSONObject().put("shank",shank.length()).put("acc",acc.length()).put("gyro",gyro.length()))
            .put("quality", JSONObject().put("gaps",missing).put("duplicates",duplicates).put("backwards",backwards)
                .put("malformed",malformed).put("nearLimitRows",clipped).put("interrupted",interrupted))
            .put("recent",recent).put("events",events)
            .put("recentUnits",JSONObject().put("accMagnitude","m/s²").put("gyroMagnitude","rad/s"))
            .put("modelStatus","Offline language model not installed; AI inference is unavailable in this acquisition MVP.")
            .put("limitations",JSONArray(listOf("Wearable time is nominal sequence/208 Hz. Phone timestamps are native monotonic acquisition times.",
                "BLE receipt timestamps include transport delay. Cross-device synchronization uncertainty is not validated.",
                "Signal magnitudes and quality counts are engineering observations; no gait, diagnosis or fall-risk result is inferred.",
                if (sessionPhoneEnabled) "Phone accelerometer and gyroscope availability varies by device." else "Phone capture was not selected.",
                "Only finalized sessions are saved. Process death before finalization can lose live samples.")))
    }
    private fun persistSession(session: String) {
        val document = JSONObject().put("schemaVersion",1).put("sessionId",session).put("startedUtc",startedUtc)
            .put("originElapsedRealtimeNs",originNs.toString()).put("stopReason",stopReason).put("appVersion","0.1.0")
            .put("startCommandDispatchElapsedNs",startDispatchNs.toString())
            .put("startTimingDefinition","Assessment clock starts at START command dispatch. Firmware acquisition onset and phone registration occur later; onset uncertainty is unvalidated.")
            .put("wearableLeg",wearableLeg).put("phonePocket",phonePocket).put("phoneCaptureConsent",sessionPhoneEnabled)
            .put("sensorAvailability", JSONObject().put("accelerometer",sensorStatus?.accAvailable == true).put("gyroscope",sensorStatus?.gyroAvailable == true))
            .put("snapshot",snapshot()).put("shankColumns",JSONArray(listOf("sequence","packetReceiptElapsedNs","axRaw","ayRaw","azRaw","gxRaw","gyRaw","gzRaw")))
            .put("phoneColumns",JSONArray(listOf("sensorTimestampNs","receiptElapsedNs","accuracy","x","y","z")))
            .put("phoneUnits",JSONObject().put("accelerometer","m/s²").put("gyroscope","rad/s"))
            .put("shankRaw",shank).put("phoneAccelerometer",acc).put("phoneGyroscope",gyro)
        io.execute {
            try {
                val json = document.toString()
                store.save(session,json); store.clearActive(); store.prune()
                runOnUiThread { if (currentId == session) { latestJson = json; saving = false; message("Session saved privately. ${sessionStatus.lowercase()} — $stopReason"); updateControls() } }
            } catch (e: Exception) { runOnUiThread { saving = false; message("Session save failed: ${e.javaClass.simpleName}. Keep this screen open and export if possible."); latestJson = document.toString(); updateControls() } }
        }
    }

    private fun render() {
        if (!pageReady || destroyed) return
        // Encode the entire JSON as a JS string; never interpolate user text into executable source.
        val encoded = JSONObject.quote(snapshot().toString()).replace("\u2028","\\u2028").replace("\u2029","\\u2029")
        page.evaluateJavascript("window.VspimuUi && window.VspimuUi.render(JSON.parse($encoded));",null)
    }
    private fun updateControls() {
        if (!::startButton.isInitialized) return
        startButton.isEnabled = !active && !starting && !saving && !deleting && ble.state == BleClient.State.READY
        stopButton.isEnabled = active || starting
        consent.isEnabled = !active && !starting && !saving
        phoneOptIn.isEnabled = consent.isEnabled; leg.isEnabled = consent.isEnabled; pocket.isEnabled = consent.isEnabled
    }
    private fun showHistory() {
        if (active || starting || saving || deleting) { message("Stop and save first."); return }
        io.execute {
            val ids = store.ids()
            runOnUiThread {
                if (destroyed) return@runOnUiThread
                if (ids.isEmpty()) { message("No saved sessions."); return@runOnUiThread }
                AlertDialog.Builder(this).setTitle("Saved private sessions").setItems(ids.toTypedArray()) { _, index -> loadSession(ids[index]) }.show()
            }
        }
    }
    private fun loadSession(id: String) {
        if (active || starting || saving || deleting) return
        val generation = ++loadGeneration
        io.execute {
            try {
                val json = store.read(id); val document = JSONObject(json)
                runOnUiThread { if (!active && !starting && !saving && !deleting && !destroyed && generation == loadGeneration) {
                    latestJson = json; loadedSnapshot = document.getJSONObject("snapshot"); currentId = id; message("Opened saved session."); render()
                } }
            } catch (e: Exception) { runOnUiThread { message("Cannot open record: ${e.javaClass.simpleName}. No data assumed.") } }
        }
    }
    private fun exportSession() {
        if (active || starting || saving || deleting) { message("Stop and save before exporting."); return }
        val json = latestJson ?: run { message("Record or open a saved session first."); return }
        exportJson = json
        startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE); type="application/json"
            putExtra(Intent.EXTRA_TITLE,"VSPIMU_${currentId}.json")
        }, EXPORT)
    }
    @Deprecated("Activity result used to keep the MVP dependency footprint small")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode,resultCode,data)
        if (requestCode != EXPORT) return
        val json = exportJson; exportJson = null
        val uri: Uri = data?.data ?: return
        if (resultCode != RESULT_OK || json == null) return
        io.execute {
            try {
                contentResolver.openOutputStream(uri,"wt")?.use { it.write(json.toByteArray(Charsets.UTF_8)) }
                    ?: error("No output stream")
                runOnUiThread { message("Export saved to the location you selected. That exported copy is outside private app storage.") }
            } catch (e: Exception) { runOnUiThread { message("Export failed: ${e.javaClass.simpleName}. No success assumed.") } }
        }
    }
    private fun confirmDelete() {
        if (active || starting || saving || deleting) { message("Stop and save first."); return }
        AlertDialog.Builder(this).setTitle("Delete private records?").setMessage("This deletes all app records and their encryption key. Copies you exported remain at their chosen locations.")
            .setNegativeButton("Cancel",null).setPositiveButton("Delete") { _, _ ->
                deleting = true; updateControls()
                loadGeneration++
                io.execute {
                    try { store.deleteAll(); runOnUiThread {
                        latestJson = null; exportJson = null; loadedSnapshot = null; currentId = ""; sessionStatus = "READY"
                        shank=JSONArray(); acc=JSONArray(); gyro=JSONArray(); recent=JSONArray(); events=JSONArray()
                        missing=0; duplicates=0; backwards=0; malformed=0; clipped=0; interrupted=false
                        stoppedElapsed=0.0; placement="Not recorded"; sessionPhoneEnabled=false
                        deleting=false; message("Private records deleted."); updateControls(); render()
                    } } catch (e: Exception) { runOnUiThread { deleting=false; message("Deletion incomplete: ${e.javaClass.simpleName}"); updateControls() } }
                }
            }.show()
    }
    override fun onStop() {
        if (active || starting) finishSession("app_left_foreground",true)
        ble.stopScan()
        super.onStop()
    }
    override fun onDestroy() {
        if (active || starting) finishSession("activity_destroyed",true)
        destroyed=true; handler.removeCallbacks(tick); sensors.close(); ble.close(); page.destroy(); io.shutdown()
        super.onDestroy()
    }
    companion object {
        private const val PAGE_URL="https://appassets.androidplatform.net/assets/index.html"
        private const val PERMISSIONS=10
        private const val EXPORT=11
        private const val MAX_SHANK=40_000
        private const val MAX_PHONE=30_000
    }
}
