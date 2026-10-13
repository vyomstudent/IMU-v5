/*
 * VSPIMU V6 — optional phone-IMU capture, quality control, cross-sensor summary,
 * safe local summary history, report enrichment, and export bridge.
 *
 * IMPORTANT DATA CONTRACT:
 *   App Inventor supplies batches of rows:
 *   ["acc", callbackWallMs, 0, x_m_s2, y_m_s2, z_m_s2]
 *   ["gyro", callbackWallMs, sensorEventTimestampNs, x_deg_s, y_deg_s, z_deg_s]
 *   AccelerometerSensor's built-in AI2 event does not expose SensorEvent.timestamp;
 *   its recorded time is therefore callback wall time, not acquisition time.
 *   Gyroscope native timestamps are preserved for per-sensor interval/rate checks.
 *   The raw streams remain separate; cross-sensor alignment is explicitly exploratory.
 */
(function (root) {
  'use strict';

  const VERSION = '6.0.0';
  const ALGORITHM_ID = 'VSPIMU-phone-shank-summary-0.3.0';
  const SHANK_HZ_NOMINAL = 208;
  const SHANK_MAX_SAMPLES = 40000;
  const PHONE_MAX_SAMPLES_PER_SENSOR = 30000;
  const MAX_PACKET_ANCHORS = 4000;
  const MAX_SESSION_SECONDS = 180;
  const BASELINE_KEY = 'vspimu.dualimu.summaryHistory.v1';
  const BASELINE_MAX_RECORDS = 300;
  const BASELINE_MIN_PRIOR = 5;
  const MAX_EXPORT_CHARS_PER_CHUNK = 4200;

  const state = {
    active: false,
    closing: false,
    finalized: false,
    coreFinalizationWaitStartedPerfMs: 0,
    coreFinalizationTimedOut: false,
    coreSummaryRefreshed: false,
    phoneAccepting: false,
    phoneRequested: false,
    nativeAccelAvailable: null,
    nativeGyroAvailable: null,
    nativeAccelEnabled: false,
    nativeGyroEnabled: false,
    nativeAccelEverEnabled: false,
    nativeGyroEverEnabled: false,
    sessionId: '',
    startedWallMs: 0,
    startedPerfMs: 0,
    wallToPerfOffsetMs: 0,
    lastObservedWallToPerfOffsetMs: null,
    wallClockDiscontinuities: 0,
    maxWallToPerfOffsetShiftMs: 0,
    stoppedWallMs: 0,
    stoppedPerfMs: 0,
    pocket: 'not_declared',
    placementNote: '',
    profileCode: '',
    phoneLifecycleEvents: [],
    protocol: 'VSPIMU-123S',
    screenOrientation: 'unknown',
    annotations: [],
    shank: [],
    shankAnchors: [],
    shankRawSequenceLast: null,
    shankUnwrappedLast: null,
    shankDuplicateOrBackwards: 0,
    shankGapSlots: 0,
    shankClippedRows: 0,
    shankInvalidRows: 0,
    shankTruncated: false,
    phoneAcc: [],
    phoneGyro: [],
    phoneAccInvalid: 0,
    phoneGyroInvalid: 0,
    phoneAccOutOfRange: 0,
    phoneGyroOutOfRange: 0,
    phoneAccTruncated: false,
    phoneGyroTruncated: false,
    lastAccCallbackWallMs: null,
    lastGyroSensorNs: null,
    lastGyroCallbackWallMs: null,
    phoneAccDuplicates: 0,
    phoneAccBackwards: 0,
    phoneGyroDuplicates: 0,
    phoneGyroBackwards: 0,
    lastStatus: 'Not recording',
    finalSummary: null,
    finalBaselineComparison: null,
    refreshTimer: null,
    tailTimer: null,
    exportState: null,
    reportFrameLoadListener: null,
    lastSummarySaved: false
  };

  const byId = (id) => {
    try { return root.document ? root.document.getElementById(id) : null; }
    catch (_) { return null; }
  };
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);
  const numberOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const median = (values) => {
    const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const mean = (values) => {
    const a = values.filter(Number.isFinite);
    return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  };
  const sd = (values) => {
    const a = values.filter(Number.isFinite);
    if (a.length < 2) return null;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
  };
  const mad = (values) => {
    const m = median(values);
    return m === null ? null : median(values.filter(Number.isFinite).map((v) => Math.abs(v - m)));
  };
  const fmt = (v, digits = 2, suffix = '') => finite(v) ? `${v.toFixed(digits)}${suffix}` : 'Unavailable';
  const esc = (v) => String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const iso = (ms) => {
    try { return new Date(ms).toISOString(); } catch (_) { return ''; }
  };
  const csvCell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvText = (headers, rows) => [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';

  function domText(id, value) {
    const el = byId(id);
    if (el) el.textContent = value === null || value === undefined ? '—' : String(value);
  }
  function domClass(id, cls) {
    const el = byId(id);
    if (el) el.className = cls;
  }
  function selectedPlacement() {
    const el = byId('phonePocketSelect');
    return el && el.value ? el.value : 'not_declared';
  }
  function phoneOptedIn() {
    const el = byId('phoneCaptureOptIn');
    return !!(el && el.checked);
  }
  function readProfileCode() {
    const el = byId('profileCode');
    const raw = el ? String(el.value || '').trim() : '';
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(raw)) return '';
    return raw.toUpperCase();
  }
  function selectedPlacementNote() {
    const el = byId('phonePlacementDetail');
    return el ? String(el.value || '').trim().replace(/\s+/g, ' ').slice(0, 80) : '';
  }
  function makeSessionId() {
    const d = new Date();
    const stamp = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'), '-', String(d.getHours()).padStart(2, '0'), String(d.getMinutes()).padStart(2, '0'), String(d.getSeconds()).padStart(2, '0')].join('');
    const entropy = Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
    return `VSP-${stamp}-${entropy}`;
  }
  function sendToAppInventor(message) {
    try {
      if (root.AppInventor && typeof root.AppInventor.setWebViewString === 'function') {
        root.AppInventor.setWebViewString(JSON.stringify(message));
        return true;
      }
    } catch (e) { console.warn('VSPIMU phone sensor bridge:', e); }
    return false;
  }
  function notifyNative(command, reason) {
    return sendToAppInventor({
      type: 'phone_imu_control',
      command,
      reason: reason || '',
      sessionId: state.sessionId,
      requested: state.phoneRequested,
      pocket: state.pocket,
      placementNote: state.placementNote
    });
  }

  function resetSession() {
    if (state.refreshTimer) root.clearInterval(state.refreshTimer);
    if (state.tailTimer) root.clearTimeout(state.tailTimer);
    state.refreshTimer = null;
    state.tailTimer = null;
    state.active = true;
    state.closing = false;
    state.finalized = false;
    state.coreFinalizationWaitStartedPerfMs = 0;
    state.coreFinalizationTimedOut = false;
    state.coreSummaryRefreshed = false;
    state.phoneAccepting = false;
    state.phoneRequested = false;
    state.nativeAccelAvailable = null;
    state.nativeGyroAvailable = null;
    state.nativeAccelEnabled = false;
    state.nativeGyroEnabled = false;
    state.nativeAccelEverEnabled = false;
    state.nativeGyroEverEnabled = false;
    state.sessionId = makeSessionId();
    state.startedWallMs = Date.now();
    state.startedPerfMs = performance.now();
    // Freeze wall-clock → WebView monotonic mapping at session start.
    // A per-batch remapping would conceal Android wall-clock jumps.
    state.wallToPerfOffsetMs = state.startedWallMs - state.startedPerfMs;
    state.lastObservedWallToPerfOffsetMs = state.wallToPerfOffsetMs;
    state.wallClockDiscontinuities = 0;
    state.maxWallToPerfOffsetShiftMs = 0;
    state.stoppedWallMs = 0;
    state.stoppedPerfMs = 0;
    state.pocket = selectedPlacement();
    state.placementNote = selectedPlacementNote();
    state.profileCode = readProfileCode();
    state.phoneLifecycleEvents = [];
    state.protocol = 'VSPIMU-123S';
    state.screenOrientation = (root.screen && root.screen.orientation && root.screen.orientation.type) || 'unknown';
    state.annotations = [];
    state.shank = [];
    state.shankAnchors = [];
    state.shankRawSequenceLast = null;
    state.shankUnwrappedLast = null;
    state.shankDuplicateOrBackwards = 0;
    state.shankGapSlots = 0;
    state.shankClippedRows = 0;
    state.shankInvalidRows = 0;
    state.shankTruncated = false;
    state.phoneAcc = [];
    state.phoneGyro = [];
    state.phoneAccInvalid = 0;
    state.phoneGyroInvalid = 0;
    state.phoneAccOutOfRange = 0;
    state.phoneGyroOutOfRange = 0;
    state.phoneAccTruncated = false;
    state.phoneGyroTruncated = false;
    state.lastAccCallbackWallMs = null;
    state.lastGyroSensorNs = null;
    state.lastGyroCallbackWallMs = null;
    state.phoneAccDuplicates = 0;
    state.phoneAccBackwards = 0;
    state.phoneGyroDuplicates = 0;
    state.phoneGyroBackwards = 0;
    state.lastStatus = 'Session started; waiting for sensor samples';
    state.finalSummary = null;
    state.finalBaselineComparison = null;
    state.lastSummarySaved = false;

    const hasPocket = ['left_front_pocket', 'right_front_pocket', 'other_declared'].includes(state.pocket);
    const placementComplete = state.pocket !== 'other_declared' || state.placementNote.length >= 3;
    state.phoneRequested = phoneOptedIn() && hasPocket && placementComplete;
    state.phoneAccepting = state.phoneRequested;
    if (phoneOptedIn() && (!hasPocket || !placementComplete)) {
      state.lastStatus = state.pocket === 'other_declared'
        ? 'Phone capture not started: describe the other placement (at least 3 characters) or continue shank-only.'
        : 'Phone capture not started: declare phone placement or continue shank-only.';
    } else if (state.phoneRequested) {
      state.lastStatus = 'Phone capture requested; checking native sensor availability.';
      notifyNative('START', 'assessment_start');
    } else {
      state.lastStatus = 'Shank-only mode; phone capture is disabled.';
      notifyNative('STOP', 'phone_capture_opted_out_or_placement_missing');
    }
    state.refreshTimer = root.setInterval(renderDashboard, 1000);
    renderDashboard();
    return { ok: true, sessionId: state.sessionId, phoneRequested: state.phoneRequested, pocket: state.pocket };
  }

  function endPhoneCapture() {
    if (!state.active || state.closing) return;
    state.closing = true;
    state.phoneAccepting = false;
    state.stoppedWallMs = Date.now();
    state.stoppedPerfMs = performance.now();
    notifyNative('STOP', 'assessment_stop');
    state.lastStatus = 'Phone capture stopped; allowing the wearable raw stream to finish its final packet.';
    renderDashboard();
    // Preserve the same short tail the existing VSPIMU WebView engine uses at STOP.
    state.tailTimer = root.setTimeout(finalizeSession, 1200);
  }

  function setNativeSensorStatus(accAvailable, gyroAvailable, accEnabled, gyroEnabled) {
    state.nativeAccelAvailable = !!accAvailable;
    state.nativeGyroAvailable = !!gyroAvailable;
    state.nativeAccelEnabled = !!accEnabled;
    state.nativeGyroEnabled = !!gyroEnabled;
    state.nativeAccelEverEnabled = state.nativeAccelEverEnabled || !!accEnabled;
    state.nativeGyroEverEnabled = state.nativeGyroEverEnabled || !!gyroEnabled;
    if (state.phoneRequested && !state.nativeAccelAvailable && !state.nativeGyroAvailable) {
      state.lastStatus = 'Phone motion sensors unavailable; shank analysis remains available.';
    } else if (state.phoneRequested && !state.nativeAccelAvailable) {
      state.lastStatus = 'Phone accelerometer unavailable; gyroscope-only phone stream.';
    } else if (state.phoneRequested && !state.nativeGyroAvailable) {
      state.lastStatus = 'Phone gyroscope unavailable; accelerometer-only phone stream.';
    } else if (state.phoneRequested && (state.nativeAccelEnabled || state.nativeGyroEnabled)) {
      state.lastStatus = 'Phone motion sensors enabled in foreground assessment mode.';
    } else if (state.phoneRequested && state.phoneLifecycleEvents.some((e) => /lost_focus|screen_off|background|pause|interruption/i.test(e.type)) && state.active) {
      state.lastStatus = 'Phone capture was interrupted by app lifecycle. Phone-derived features are marked for review; do not resume mid-session.';
    } else if (state.phoneRequested && (state.closing || state.finalized)) {
      state.lastStatus = 'Phone sensors stopped; captured data retained for quality review and export.';
    } else if (state.phoneRequested) {
      state.lastStatus = 'Phone sensors are available; waiting for native capture to enable.';
    }
    renderDashboard();
  }

  function parseNumbersCsv(csv) {
    if (Array.isArray(csv)) return csv.map((v) => Number(v));
    if (typeof csv !== 'string') return [];
    // Do not filter malformed cells: filtering would shift the 8-word packet
    // boundaries and could silently turn later words into false axis values.
    return csv.split(',').map((s) => s.trim() === '' ? NaN : Number(s.trim()));
  }
  function unwrapSequence(raw) {
    raw = raw >>> 0;
    if (state.shankRawSequenceLast === null) {
      state.shankRawSequenceLast = raw;
      state.shankUnwrappedLast = raw;
      return state.shankUnwrappedLast;
    }
    const prevRaw = state.shankRawSequenceLast >>> 0;
    let delta = (raw - prevRaw) >>> 0;
    if (delta > 0x7FFFFFFF) {
      state.shankDuplicateOrBackwards++;
      // Store but do not use a backwards raw seq to advance the unwrapped counter.
      return state.shankUnwrappedLast + (raw < prevRaw ? 0 : raw - prevRaw);
    }
    if (delta === 0) state.shankDuplicateOrBackwards++;
    if (delta > 1) state.shankGapSlots += delta - 1;
    state.shankRawSequenceLast = raw;
    state.shankUnwrappedLast += delta;
    return state.shankUnwrappedLast;
  }
  function captureShankCsv(csv) {
    if (!state.active || state.shankTruncated) return;
    const values = parseNumbersCsv(csv);
    if (values.length % 8 !== 0) {
      state.shankInvalidRows++;
      state.lastStatus = 'Malformed wearable callback length; notification mirror rejected to avoid axis misalignment.';
      return;
    }
    const n = Math.floor(values.length / 8);
    if (!n) return;
    const arrivalPerfMs = performance.now();
    let parsedRows = 0;
    for (let i = 0; i < n; i++) {
      if (state.shank.length >= SHANK_MAX_SAMPLES || (performance.now() - state.startedPerfMs) / 1000 > MAX_SESSION_SECONDS) {
        state.shankTruncated = true;
        state.lastStatus = 'Raw shank buffer reached its configured safe limit; this export is incomplete.';
        break;
      }
      const b = i * 8;
      const packetWords = values.slice(b, b + 8);
      if (packetWords.length !== 8 || packetWords.some((v) => !Number.isFinite(v))) {
        state.shankInvalidRows++;
        continue;
      }
      const lo = (Math.round(values[b]) & 0xFFFF) >>> 0;
      const hi = (Math.round(values[b + 1]) & 0xFFFF) >>> 0;
      const seq = (lo + hi * 65536) >>> 0;
      const raw = values.slice(b + 2, b + 8).map((v) => {
        let x = Math.round(v); x = ((x + 32768) % 65536 + 65536) % 65536 - 32768; return x;
      });
      if (raw.length !== 6 || raw.some((x) => !Number.isFinite(x))) {
        state.shankInvalidRows++;
        continue;
      }
      const seqUnwrapped = unwrapSequence(seq);
      if (raw.some((v) => Math.abs(v) >= 32760)) state.shankClippedRows++;
      state.shank.push({ seq, seqUnwrapped, ax_raw: raw[0], ay_raw: raw[1], az_raw: raw[2], gx_raw: raw[3], gy_raw: raw[4], gz_raw: raw[5], arrival_perf_ms: arrivalPerfMs });
      parsedRows++;
    }
    if (parsedRows && state.shankAnchors.length < MAX_PACKET_ANCHORS) {
      const last = state.shank[state.shank.length - 1];
      if (last) state.shankAnchors.push({ seq: last.seqUnwrapped, arrivalPerfMs });
    }
  }

  function ingestBatch(records) {
    // During the short stop-tail, accept one final queued native batch while
    // rejecting new callbacks after that tail closes.
    if (!state.active || (!state.phoneAccepting && !state.closing) || !Array.isArray(records)) return { accepted: 0, ignored: records && records.length || 0, reason: 'phone capture is not active' };
    let accepted = 0;
    const receiptPerf = performance.now();
    const observedOffset = Date.now() - receiptPerf;
    const previousOffset = state.lastObservedWallToPerfOffsetMs;
    if (previousOffset !== null && Math.abs(observedOffset - previousOffset) >= 250) {
      state.wallClockDiscontinuities++;
    }
    state.lastObservedWallToPerfOffsetMs = observedOffset;
    state.maxWallToPerfOffsetShiftMs = Math.max(
      state.maxWallToPerfOffsetShiftMs,
      Math.abs(observedOffset - state.wallToPerfOffsetMs)
    );
    for (const row of records) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const kind = String(row[0] || '').toLowerCase();
      const wallMs = numberOrNull(row[1]);
      const nativeTs = numberOrNull(row[2]);
      const x = numberOrNull(row[3]);
      const y = numberOrNull(row[4]);
      const z = numberOrNull(row[5]);
      if (wallMs === null || x === null || y === null || z === null) {
        if (kind === 'acc') state.phoneAccInvalid++;
        else if (kind === 'gyro') state.phoneGyroInvalid++;
        continue;
      }
      // Conservative sanity limits, not the advertised range of any specific phone.
      // Values outside these broad physical bounds are rejected and counted, never clipped.
      if (kind === 'acc' && Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 200) {
        state.phoneAccInvalid++;
        state.phoneAccOutOfRange++;
        continue;
      }
      if (kind === 'gyro' && Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 4000) {
        state.phoneGyroInvalid++;
        state.phoneGyroOutOfRange++;
        continue;
      }
      const sessionElapsedMs = wallMs - state.startedWallMs;
      if (sessionElapsedMs > MAX_SESSION_SECONDS * 1000) {
        if (kind === 'acc') state.phoneAccTruncated = true;
        else if (kind === 'gyro') state.phoneGyroTruncated = true;
        state.lastStatus = 'Phone capture reached its configured 180-second safe duration limit; export is marked incomplete.';
        continue;
      }
      if (kind === 'acc') {
        if (state.phoneAcc.length >= PHONE_MAX_SAMPLES_PER_SENSOR) { state.phoneAccTruncated = true; continue; }
        if (state.lastAccCallbackWallMs !== null) {
          if (wallMs === state.lastAccCallbackWallMs) state.phoneAccDuplicates++;
          else if (wallMs < state.lastAccCallbackWallMs) state.phoneAccBackwards++;
        }
        state.lastAccCallbackWallMs = wallMs;
        state.phoneAcc.push({ t_wall_ms: wallMs, t_session_s: (wallMs - state.startedWallMs) / 1000, t_perf_ms: wallMs - state.wallToPerfOffsetMs, x_m_s2: x, y_m_s2: y, z_m_s2: z, receipt_perf_ms: receiptPerf, time_source: 'AI2_AccelerometerChanged_callback_wall_ms', sensor_ts_ns: null, accuracy: null });
        accepted++;
      } else if (kind === 'gyro') {
        if (state.phoneGyro.length >= PHONE_MAX_SAMPLES_PER_SENSOR) { state.phoneGyroTruncated = true; continue; }
        if (nativeTs !== null && nativeTs > 0) {
          if (state.lastGyroSensorNs !== null) {
            if (nativeTs === state.lastGyroSensorNs) state.phoneGyroDuplicates++;
            else if (nativeTs < state.lastGyroSensorNs) state.phoneGyroBackwards++;
          }
          state.lastGyroSensorNs = nativeTs;
        }
        if (state.lastGyroCallbackWallMs !== null && wallMs < state.lastGyroCallbackWallMs) state.phoneGyroBackwards++;
        state.lastGyroCallbackWallMs = wallMs;
        state.phoneGyro.push({ t_wall_ms: wallMs, t_session_s: (wallMs - state.startedWallMs) / 1000, t_perf_ms: wallMs - state.wallToPerfOffsetMs, x_dps: x, y_dps: y, z_dps: z, receipt_perf_ms: receiptPerf, time_source: nativeTs !== null && nativeTs > 0 ? 'Android_SensorEvent_timestamp_ns_plus_callback_wall_ms' : 'AI2_GyroscopeChanged_callback_wall_ms', sensor_ts_ns: nativeTs !== null && nativeTs > 0 ? nativeTs : null, accuracy: null });
        accepted++;
      }
    }
    if (accepted) renderDashboard();
    return { accepted, accSamples: state.phoneAcc.length, gyroSamples: state.phoneGyro.length };
  }

  function analyzeTime(rows, timestampGetter, options = {}) {
    const timestamps = [];
    let duplicates = 0, backwards = 0;
    let last = null;
    for (const row of rows) {
      const t = timestampGetter(row);
      if (!finite(t)) continue;
      timestamps.push(t);
      if (last !== null) {
        if (t === last) duplicates++;
        else if (t < last) backwards++;
      }
      last = t;
    }
    const dts = [];
    for (let i = 1; i < timestamps.length; i++) if (timestamps[i] > timestamps[i - 1]) dts.push(timestamps[i] - timestamps[i - 1]);
    const dt = median(dts);
    const intervalMad = mad(dts);
    const intervalCvRobust = dt && intervalMad !== null ? 1.4826 * intervalMad / dt : null;
    let gapSegments = 0, estimatedMissing = 0;
    const gapFactor = options.gapFactor || 3.0;
    if (dt) {
      for (const d of dts) {
        if (d > dt * gapFactor && d > (options.minimumGap || 0)) {
          gapSegments++;
          estimatedMissing += Math.max(1, Math.round(d / dt) - 1);
        }
      }
    }
    let minT = Infinity, maxT = -Infinity;
    for (const t of timestamps) { if (t < minT) minT = t; if (t > maxT) maxT = t; }
    const duration = timestamps.length > 1 ? maxT - minT : 0;
    const estimatedMissingPct = timestamps.length + estimatedMissing > 0 ? 100 * estimatedMissing / (timestamps.length + estimatedMissing) : null;
    return { sampleCount: rows.length, timedSamples: timestamps.length, duration, medianInterval: dt, medianRateHz: dt ? 1 / dt : null, intervalMad, intervalCvRobust, duplicates, backwards, gapSegments, estimatedMissingCallbacks: estimatedMissing, estimatedMissingPct, expectedByMedian: dt && duration > 0 ? Math.max(1, Math.round(duration / dt) + 1) : null, quality: timestamps.length < 20 || duration < 1 ? 'INSUFFICIENT' : (gapSegments || duplicates || backwards || (intervalCvRobust !== null && intervalCvRobust > 0.25) ? 'REVIEW' : 'OBSERVED') };
  }
  function variance3(rows, names) {
    if (!rows.length) return null;
    const axes = names.map((key) => rows.map((r) => Number(r[key])).filter(Number.isFinite));
    if (axes.some((a) => a.length < 2)) return null;
    const means = axes.map(mean);
    const vars = axes.map((a, axisIndex) => a.reduce((s, v) => s + (v - means[axisIndex]) ** 2, 0) / a.length);
    // The centered vector RMS is a sensor-observed movement-variability summary, not a posture/angle estimate.
    return Math.sqrt(vars.reduce((s, v) => s + v, 0));
  }
  function axisSummary(rows, names) {
    const result = {};
    names.forEach((name) => {
      const a = rows.map((r) => Number(r[name])).filter(Number.isFinite);
      let minValue = Infinity, maxValue = -Infinity;
      for (const v of a) { if (v < minValue) minValue = v; if (v > maxValue) maxValue = v; }
      result[name] = { mean: mean(a), sd: sd(a), min: a.length ? minValue : null, max: a.length ? maxValue : null };
    });
    return result;
  }
  function shankSummary() {
    const rows = state.shank;
    const first = rows.length ? rows[0].seqUnwrapped : null;
    const last = rows.length ? rows[rows.length - 1].seqUnwrapped : null;
    for (const row of rows) row.t_s = first !== null ? (row.seqUnwrapped - first) / SHANK_HZ_NOMINAL : null;
    const expected = first !== null && last !== null && last >= first ? last - first + 1 : rows.length;
    const firstSeq = first;
    const accMps = rows.map((r) => ({ ax: r.ax_raw * 0.0001220703125 * 9.80665, ay: r.ay_raw * 0.0001220703125 * 9.80665, az: r.az_raw * 0.0001220703125 * 9.80665 }));
    const gyros = rows.map((r) => ({ gx: r.gx_raw * 0.07, gy: r.gy_raw * 0.07, gz: r.gz_raw * 0.07 }));
    const accNames = ['ax', 'ay', 'az'];
    const gyroNames = ['gx', 'gy', 'gz'];
    const continuity = expected > 0 ? 100 * Math.min(rows.length, expected) / expected : null;
    const seqDts = [];
    for (let i = 1; i < rows.length; i++) if (rows[i].seqUnwrapped > rows[i - 1].seqUnwrapped) seqDts.push(rows[i].seqUnwrapped - rows[i - 1].seqUnwrapped);
    const receivedRateOverNominalSequenceDurationHz = rows.length > 1 && last > first ? (rows.length - 1) / ((last - first) / SHANK_HZ_NOMINAL) : null;
    const packetFit = fitPacketClock();
    return {
      sensor: 'LSM6DSO lower-distal tibia', sampleCount: rows.length,
      firstSequence: first, lastSequence: last, expectedSequenceSlots: expected,
      sequenceGapSlots: state.shankGapSlots, duplicateOrBackwardsRows: state.shankDuplicateOrBackwards,
      continuityPct: continuity, configuredOdrHz: SHANK_HZ_NOMINAL,
      receivedRateOverNominalSequenceDurationHz,
      durationSec: rows.length > 1 ? (last - first) / SHANK_HZ_NOMINAL : 0,
      clippedRows: state.shankClippedRows, invalidRows: state.shankInvalidRows, truncated: state.shankTruncated,
      accelerometerAxisStats_m_s2: axisSummary(accMps, accNames), gyroscopeAxisStats_deg_s: axisSummary(gyros, gyroNames),
      accelCenteredVectorRms_m_s2: variance3(accMps, accNames), gyroCenteredVectorRms_deg_s: variance3(gyros, gyroNames),
      timestampSource: 'ESP32 sample sequence / configured 208-Hz ODR; not a shared hardware clock',
      packetClockFit: packetFit,
      quality: rows.length < 100 ? 'INSUFFICIENT' : (state.shankGapSlots || state.shankDuplicateOrBackwards || state.shankClippedRows || state.shankTruncated ? 'REVIEW' : 'OBSERVED')
    };
  }
  function fitPacketClock() {
    const a = state.shankAnchors.filter((p) => finite(p.seq) && finite(p.arrivalPerfMs));
    if (a.length < 8) return { usable: false, reason: 'Fewer than eight raw packet receive anchors; timing fit withheld.', anchorCount: a.length, sampleIntervalFitMs: null, interceptPerfMs: null, r2: null, residualMadMs: null };
    const x = a.map((p) => p.seq / SHANK_HZ_NOMINAL * 1000);
    const y = a.map((p) => p.arrivalPerfMs);
    const mx = mean(x), my = mean(y);
    let num = 0, den = 0;
    for (let i = 0; i < x.length; i++) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; }
    if (!(den > 0) || (Math.max(...x) - Math.min(...x)) < 2000) return { usable: false, reason: 'Packet anchors span less than two seconds; timing fit withheld.', anchorCount: a.length, sampleIntervalFitMs: null, interceptPerfMs: null, r2: null, residualMadMs: null };
    const slope = num / den;
    const intercept = my - slope * mx;
    const pred = x.map((v) => intercept + slope * v);
    const residuals = y.map((v, i) => v - pred[i]);
    const ssRes = residuals.reduce((s, v) => s + v * v, 0);
    const ssTot = y.reduce((s, v) => s + (v - my) ** 2, 0);
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
    const residualMadMs = mad(residuals);
    const slopePlausible = slope >= 0.95 && slope <= 1.05;
    const fitQuality = r2 !== null && r2 >= 0.95 && residualMadMs !== null && residualMadMs <= 100;
    const usable = slopePlausible && fitQuality;
    return { usable, anchorCount: a.length, relativeClockScale: slope, interceptPerfMs: intercept, r2, residualMadMs, minimumUncertaintyMs: null,
      reason: usable ? 'Fit passed engineering quality gates; subsequent matching remains exploratory.' : 'Packet timing fit failed minimum slope/R²/residual gates; cross-sensor alignment withheld.',
      interpretation: 'Packet-receipt regression estimates relative transport timing, not sensor acquisition time. Intercept includes unknown BLE/dispatch delay. This is not a validated synchronization error bound.' };
  }
  function phoneSummary(kind, rows, names, timeGetter) {
    const tq = analyzeTime(rows, timeGetter, { gapFactor: 3.0 });
    const axisStats = axisSummary(rows, names);
    const centeredRms = variance3(rows, names);
    let minT = Infinity, maxT = -Infinity, timedCount = 0;
    for (const row of rows) {
      const t = timeGetter(row);
      if (!finite(t)) continue;
      timedCount++;
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    const durationSec = timedCount > 1 ? maxT - minT : 0;
    return {
      sensor: kind === 'acc' ? 'Android phone accelerometer' : 'Android phone gyroscope',
      sampleCount: rows.length, durationSec, observedMedianRateHz: tq.medianRateHz,
      intervalMedianSec: tq.medianInterval, robustIntervalCV: tq.intervalCvRobust,
      duplicateTimestamps: tq.duplicates,
      timestampReversals: tq.backwards,
      gapIntervals: tq.gapSegments, estimatedMissingCallbacksRelativeToMedian: tq.estimatedMissingCallbacks,
      estimatedMissingPctRelativeToObservedMedianInterval: tq.estimatedMissingPct,
      axisStats: axisStats, centeredVectorRms: centeredRms,
      nativeTimestampAvailable: kind === 'gyro' && rows.some((r) => finite(r.sensor_ts_ns)),
      timestampDefinition: kind === 'acc' ? 'AI2 AccelerationChanged callback wall time in milliseconds; built-in component exposes no SensorEvent.timestamp.' : 'Native SensorEvent timestamp retained for interval/rate analysis; callback wall time separately retained for coarse session comparisons.',
      clipping: 'Built-in AI2 sensor components do not expose sensor full-scale/clipping status; clipping cannot be confirmed from API metadata.',
      quality: (kind === 'acc' ? state.phoneAccTruncated : state.phoneGyroTruncated)
        ? 'INCOMPLETE_TRUNCATED'
        : (rows.length < 20 || durationSec < 1 ? 'INSUFFICIENT'
          : (state.phoneLifecycleEvents.some((e) => /lost_focus|screen_off|background|pause|interruption/i.test(e.type)) || tq.gapSegments || tq.duplicates || tq.backwards || (tq.intervalCvRobust !== null && tq.intervalCvRobust > 0.25) || (kind === 'acc' && state.phoneAccInvalid) || (kind === 'gyro' && state.phoneGyroInvalid) ? 'REVIEW' : 'OBSERVED')),
      truncated: kind === 'acc' ? state.phoneAccTruncated : state.phoneGyroTruncated,
      invalidSamples: kind === 'acc' ? state.phoneAccInvalid : state.phoneGyroInvalid,
      outOfRangeRejectedSamples: kind === 'acc' ? state.phoneAccOutOfRange : state.phoneGyroOutOfRange,
      timingBasis: kind === 'acc' ? 'callback_wall_ms' : 'SensorEvent.timestamp_ns_for_rate; callback_wall_ms_for_coarse_alignment'
    };
  }
  function binFeature(samples, binMs, timeKey, valuesFn) {
    const bins = new Map();
    for (const row of samples) {
      const t = timeKey(row);
      if (!finite(t)) continue;
      const k = Math.floor(t / binMs);
      if (!bins.has(k)) bins.set(k, []);
      const v = valuesFn(row);
      if (finite(v)) bins.get(k).push(v);
    }
    const out = new Map();
    for (const [k, arr] of bins.entries()) if (arr.length >= 2) out.set(k, sd(arr));
    return out;
  }
  function pearson(a, b) {
    if (a.length < 8 || a.length !== b.length) return null;
    const ma = mean(a), mb = mean(b);
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < a.length; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
    return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null;
  }
  function crossSensorSummary() {
    const acc = state.phoneAcc;
    const shank = state.shank;
    if (state.wallClockDiscontinuities > 0) return {
      status: 'UNAVAILABLE', reason: 'Android wall-clock discontinuity detected during the session; coarse phone ↔ WebView monotonic mapping is not trustworthy.',
      activityEnvelopeCorrelation: null, lagCorrectionSec: null, synchronizationUncertaintyMs: null,
      binResolutionMs: 500, nominalBinQuantizationMs: 250, wallClockDiscontinuities: state.wallClockDiscontinuities,
      caveat: 'Original phone timestamps are retained. No automatic clock repair or timestamp rewrite is performed.'
    };
    if (acc.length < 100 || shank.length < 200) return {
      status: 'UNAVAILABLE', reason: 'Insufficient simultaneous data for exploratory envelope comparison.',
      activityEnvelopeCorrelation: null, lagCorrectionSec: null, synchronizationUncertaintyMs: null, binResolutionMs: 500, nominalBinQuantizationMs: 250,
      caveat: 'Raw streams are retained separately; no timestamps are rewritten.'
    };
    const phoneFeature = binFeature(acc, 500, (r) => r.t_perf_ms, (r) => Math.sqrt(r.x_m_s2 ** 2 + r.y_m_s2 ** 2 + r.z_m_s2 ** 2));
    const fit = fitPacketClock();
    if (!fit.usable) return { status: 'UNAVAILABLE', reason: 'BLE receive anchors insufficient for a coarse shank timeline.', activityEnvelopeCorrelation: null, lagCorrectionSec: null, synchronizationUncertaintyMs: null };
    const shankAsPerf = shank.map((r) => ({
      ...r,
      t_perf_ms: fit.interceptPerfMs + (r.seqUnwrapped / SHANK_HZ_NOMINAL) * 1000 * (finite(fit.relativeClockScale) ? fit.relativeClockScale : 1)
    }));
    const shankFeature = binFeature(shankAsPerf, 500, (r) => r.t_perf_ms, (r) => Math.sqrt((r.gx_raw * 0.07) ** 2 + (r.gy_raw * 0.07) ** 2 + (r.gz_raw * 0.07) ** 2));
    const shifts = [];
    // This is a movement-envelope similarity check, not a physiological event synchronizer.
    for (let lag = -8; lag <= 8; lag++) {
      const phoneVals = [], shankVals = [];
      for (const [k, p] of phoneFeature.entries()) {
        const q = shankFeature.get(k + lag);
        if (finite(p) && finite(q)) { phoneVals.push(p); shankVals.push(q); }
      }
      const corr = pearson(phoneVals, shankVals);
      if (corr !== null) shifts.push({ lagBins: lag, lagSec: lag * 0.5, correlation: corr, nBins: phoneVals.length });
    }
    shifts.sort((a, b) => b.correlation - a.correlation);
    if (!shifts.length) return { status: 'AMBIGUOUS', reason: 'Insufficient overlap or signal variability.', activityEnvelopeCorrelation: null, lagCorrectionSec: null, synchronizationUncertaintyMs: null };
    const best = shifts[0];
    const secondDistinct = shifts.find((s) => Math.abs(s.lagBins - best.lagBins) > 1);
    const unique = !secondDistinct || best.correlation - secondDistinct.correlation >= 0.05;
    const useful = best.correlation >= 0.35 && best.nBins >= 10 && unique;
    return {
      status: useful ? 'EXPLORATORY_MATCH' : 'AMBIGUOUS',
      reason: useful ? 'An activity-envelope match exists; it is not a validated sensor-clock synchronization or gait-event match.' : 'Activity envelopes do not identify one distinct offset reliably; cross-sensor event timing should not be fused.',
      activityEnvelopeCorrelation: best.correlation,
      lagCorrectionSec: useful ? best.lagSec : null,
      matchedBins: best.nBins,
      bestLagCandidates: shifts.slice(0, 4).map((s) => ({ lagSec: s.lagSec, correlation: s.correlation, nBins: s.nBins })),
      synchronizationUncertaintyMs: null,
      binResolutionMs: 500,
      nominalBinQuantizationMs: 250,
      uncertaintyNote: 'No validated end-to-end clock-synchronization uncertainty bound is available. A 500-ms comparison bin has 250-ms half-bin quantization only; transport and callback jitter add unquantified error.',
      clockFit: fit,
      caveat: 'The phone is in a pocket and the shank is on the distal tibia; the signals are at different anatomy sites. A similar activity envelope may reflect shared movement, not exact event simultaneity. This estimate never alters source timestamps.'
    };
  }
  function currentCoreSnapshot() {
    try {
      const api = root.VSPIMU;
      if (api && typeof api.state === 'function') return api.state();
    } catch (_) { /* Not all V6 engine builds expose state(). */ }
    return null;
  }
  function annotationsAndCoreEvents() {
    const events = state.annotations.map((a) => ({ ...a, source: 'manual_user_annotation', timeBase: a.timeBase || 'WebView_monotonic_elapsed_since_phone_module_start', groundTruth: false }));
    for (const e of state.phoneLifecycleEvents) events.push({ ...e, confidence: null, groundTruth: false });
    const s = currentCoreSnapshot();
    if (s && Array.isArray(s.finalEvents)) {
      for (const e of s.finalEvents) if (e && finite(Number(e.t))) events.push({ t_session_s: Number(e.t), type: e.type || 'IC_candidate', confidence: e.p !== undefined && finite(Number(e.p)) ? Number(e.p) : null, source: e.src || 'VSPIMU existing event detector', timeBase: 'existing_VSPIMU_core_event_clock_origin_not_independently_mapped', groundTruth: false });
    }
    if (s && Array.isArray(s.fc)) {
      for (const e of s.fc) if (e && finite(Number(e.t))) events.push({ t_session_s: Number(e.t), type: 'FC_candidate', confidence: e.p !== undefined && finite(Number(e.p)) ? Number(e.p) : null, source: e.src || 'VSPIMU existing event detector', timeBase: 'existing_VSPIMU_core_event_clock_origin_not_independently_mapped', groundTruth: false });
    }
    return events.sort((a, b) => (Number(a.t_session_s) || 0) - (Number(b.t_session_s) || 0));
  }
  function firstStandSegmentSummary() {
    // Existing VSPIMU standardized journey begins with STAND_1: stand still for 8 s.
    // This is an observational feature window only; it never returns a clinical pass/fail.
    const shankRows = state.shank.filter((r) => finite(r.t_s) && r.t_s >= 0 && r.t_s <= 8.0);
    const accRows = state.phoneAcc.filter((r) => finite(r.t_session_s) && r.t_session_s >= 0 && r.t_session_s <= 8.0);
    const gyroRows = state.phoneGyro.filter((r) => finite(r.t_session_s) && r.t_session_s >= 0 && r.t_session_s <= 8.0);
    const shankAcc = shankRows.map((r) => ({ ax:r.ax_raw*0.0001220703125*9.80665, ay:r.ay_raw*0.0001220703125*9.80665, az:r.az_raw*0.0001220703125*9.80665 }));
    const shankGyro = shankRows.map((r) => ({ gx:r.gx_raw*0.07, gy:r.gy_raw*0.07, gz:r.gz_raw*0.07 }));
    const accQuality = accRows.length >= 20 ? 'MEASURED' : 'INSUFFICIENT';
    const gyroQuality = gyroRows.length >= 20 ? 'MEASURED' : 'INSUFFICIENT';
    return {
      protocolPhase: 'STAND_1', requestedWindowSec: 8, timeBase: 'Each stream uses its own local time zero; cross-sensor offset is not applied.',
      instruction: 'Existing protocol first phase instructs the user to stand still; movement features describe recorded samples and do not prove the person was stationary.',
      shankSampleCount: shankRows.length, phoneAccelerometerSampleCount: accRows.length, phoneGyroscopeSampleCount: gyroRows.length,
      shankAccelCenteredRms_m_s2: variance3(shankAcc, ['ax','ay','az']),
      shankGyroCenteredRms_deg_s: variance3(shankGyro, ['gx','gy','gz']),
      phoneAccelCenteredRms_m_s2: variance3(accRows, ['x_m_s2','y_m_s2','z_m_s2']),
      phoneGyroCenteredRms_deg_s: variance3(gyroRows, ['x_dps','y_dps','z_dps']),
      shankQuality: shankRows.length >= 100 ? 'MEASURED' : 'INSUFFICIENT',
      phoneAccelerometerQuality: accQuality, phoneGyroscopeQuality: gyroQuality,
      clinicalPassFail: false
    };
  }
  function buildSummary() {
    const shank = shankSummary();
    const initialStandSegment = firstStandSegmentSummary();
    const phoneAcc = phoneSummary('acc', state.phoneAcc, ['x_m_s2', 'y_m_s2', 'z_m_s2'], (r) => finite(r.t_wall_ms) ? r.t_wall_ms / 1000 : NaN);
    const gyroNativeTimestampComplete = state.phoneGyro.length > 0 && state.phoneGyro.every((r) => finite(r.sensor_ts_ns) && r.sensor_ts_ns > 0);
    const phoneGyro = phoneSummary('gyro', state.phoneGyro, ['x_dps', 'y_dps', 'z_dps'], gyroNativeTimestampComplete
      ? (r) => r.sensor_ts_ns / 1e9
      : (r) => finite(r.t_wall_ms) ? r.t_wall_ms / 1000 : NaN);
    phoneGyro.nativeTimestampComplete = gyroNativeTimestampComplete;
    const cross = crossSensorSummary();
    const elapsed = Math.max(0, ((state.stoppedPerfMs || performance.now()) - state.startedPerfMs) / 1000);
    const eventList = annotationsAndCoreEvents();
    const baselineEligible = !!(state.profileCode && state.phoneRequested && state.phoneAcc.length >= 100 && phoneAcc.durationSec >= 10 && phoneAcc.quality === 'OBSERVED' && shank.sampleCount >= 500 && shank.continuityPct !== null && shank.continuityPct >= 95 && shank.quality === 'OBSERVED' && !state.wallClockDiscontinuities && !state.phoneLifecycleEvents.some((e) => /lost_focus|screen_off|background|pause|interruption/i.test(e.type)) && !shank.truncated && !state.phoneAccTruncated && !state.phoneGyroTruncated);
    return {
      schema: 'vspimu.dualimu.session-summary.v1', algorithmVersion: ALGORITHM_ID, moduleVersion: VERSION,
      sessionId: state.sessionId, startedAt: iso(state.startedWallMs), stoppedAt: state.stoppedWallMs ? iso(state.stoppedWallMs) : null,
      elapsedDurationSec: elapsed, protocol: state.protocol, phonePlacement: state.pocket,
      phonePlacementDetail: state.placementNote || null,
      profileCode: state.profileCode || null, phoneCaptureRequested: state.phoneRequested,
      coreAnalysis: { finalizationReady: coreReportReady(), running: currentCoreSnapshot()?.running === true, finalizationInProgress: currentCoreSnapshot()?.finalizationInProgress === true },
      phoneLifecycle: { events: state.phoneLifecycleEvents.slice(), interrupted: state.phoneLifecycleEvents.some((e) => /lost_focus|screen_off|background|pause|interruption/i.test(e.type)), scope: 'Foreground assessment only; continuous background monitoring is not implemented.' },
      screenOrientationAtStart: state.screenOrientation,
      clockDiagnostics: { wallClockDiscontinuities: state.wallClockDiscontinuities, maxWallToPerfOffsetShiftMs: state.maxWallToPerfOffsetShiftMs, mapping: 'Wall-to-WebView monotonic offset fixed at session start; cross-sensor comparison withheld after a >=250 ms offset jump.' },
      coordinateAndCalibration: 'Phone x/y/z are Android device-frame component values; no anatomical orientation calibration is claimed. Shank axes are sensor-frame axes; mounting orientation must remain consistent.',
      shankPlacement: 'Lower/distal tibia; sensor centre approximately 4–5 cm above the medial malleolus on the anterior/anteromedial tibia, securely mounted with repeatable axis orientation (project fixed placement).',
      nativeSensorStatus: {
        accelerometerAvailable: state.nativeAccelAvailable,
        gyroscopeAvailable: state.nativeGyroAvailable,
        accelerometerEnabledDuringSession: state.nativeAccelEverEnabled,
        gyroscopeEnabledDuringSession: state.nativeGyroEverEnabled,
        accelerometerEnabledAtSummary: state.nativeAccelEnabled,
        gyroscopeEnabledAtSummary: state.nativeGyroEnabled
      },
      shank, phoneAccelerometer: phoneAcc, phoneGyroscope: phoneGyro,
      initialStandSegment, crossSensor: cross, events: eventList,
      dataQuality: {
        shank: shank.quality, phoneAccelerometer: phoneAcc.quality, phoneGyroscope: phoneGyro.quality,
        synchronization: cross.status,
        notMeasured: ['body segment angles', 'bilateral asymmetry', 'foot clearance in mm', 'walking speed/distance', 'ground reaction force', 'joint torque/load', 'clinical fall risk'],
        knownLimitations: [
          'The app-level accelerometer component does not expose Android SensorEvent.timestamp; its timestamp is callback wall time.',
          'Built-in phone sensor components do not expose sensor accuracy or hardware clipping flags. Extremely implausible values are rejected with conservative sanity limits, not repaired.',
          'A wall-clock ↔ WebView monotonic offset jump of at least 250 ms invalidates coarse cross-sensor mapping; raw timestamps remain unchanged.',
          'BLE raw receive time differs from ESP32 sample-acquisition time. Sequence numbers define nominal shank-relative time; receive regression retains an unknown transport delay.',
          'The phone position is declared by the user and can move within the pocket; it is not a rigid pelvis sensor.',
          'No movement metric in this report is ground truth or a diagnosis.'
        ]
      },
      baseline: { eligible: baselineEligible, comparison: state.finalBaselineComparison || null },
      rawExport: { shankRows: state.shank.length, phoneAccelerometerRows: state.phoneAcc.length, phoneGyroscopeRows: state.phoneGyro.length, shankTruncated: state.shankTruncated, phoneAccelerometerTruncated: state.phoneAccTruncated, phoneGyroscopeTruncated: state.phoneGyroTruncated }
    };
  }
  function getHistory() {
    try {
      const raw = root.localStorage && root.localStorage.getItem(BASELINE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(-BASELINE_MAX_RECORDS) : [];
    } catch (e) { console.warn('VSPIMU local summary history unavailable:', e); return []; }
  }
  function compareBaseline(summary) {
    if (!summary.baseline.eligible || !state.profileCode) return { eligible: false, reason: 'No valid pseudonymous profile code or session does not meet baseline quality requirements.' };
    const hist = getHistory().filter((r) => r && r.sessionId !== summary.sessionId && r.profileCode === state.profileCode && r.phonePlacement === state.pocket && (r.phonePlacementDetail || '') === (summary.phonePlacementDetail || '') && r.protocol === state.protocol && r.algorithmVersion === ALGORITHM_ID && r.qualityEligible);
    const values = {
      shankAccelCenteredRms_m_s2: summary.shank.accelCenteredVectorRms_m_s2,
      shankGyroCenteredRms_deg_s: summary.shank.gyroCenteredVectorRms_deg_s,
      phoneAccelCenteredRms_m_s2: summary.phoneAccelerometer.centeredVectorRms,
      phoneGyroCenteredRms_deg_s: summary.phoneGyroscope.centeredVectorRms
    };
    const metrics = {};
    for (const [key, value] of Object.entries(values)) {
      const prior = hist.map((r) => r.metrics && r.metrics[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
      const med = median(prior), m = mad(prior);
      metrics[key] = { current: value, baselineMedian: prior.length >= BASELINE_MIN_PRIOR ? med : null, baselineN: prior.length, absoluteChange: value !== null && med !== null ? value - med : null, percentChange: value !== null && med !== null && med !== 0 ? 100 * (value - med) / Math.abs(med) : null, robustDeviation: value !== null && med !== null && m !== null && m > 1e-9 ? (value - med) / (1.4826 * m) : null, status: prior.length >= BASELINE_MIN_PRIOR && value !== null && med !== null ? 'DESCRIPTIVE_COMPARISON' : 'BUILDING_BASELINE' };
    }
    return { eligible: true, profileCode: state.profileCode, comparablePriorSessions: hist.length, minimumPriorSessions: BASELINE_MIN_PRIOR, metrics, note: hist.length >= BASELINE_MIN_PRIOR ? 'Descriptive within-person comparison only; not a medical alert. Check protocol, pocket, device attachment, walking aid and contextual changes before interpreting.' : `Baseline is provisional: at least ${BASELINE_MIN_PRIOR} previous eligible sessions with the same profile, pocket and protocol are required.` };
  }
  function saveLongitudinalSummary(summary) {
    if (!summary.baseline.eligible || !state.profileCode) return;
    const h = getHistory();
    const s = summary;
    const record = {
      sessionId: s.sessionId, startedAt: s.startedAt, profileCode: state.profileCode,
      phonePlacement: state.pocket, phonePlacementDetail: state.placementNote || '', protocol: state.protocol, algorithmVersion: ALGORITHM_ID,
      qualityEligible: true,
      metrics: {
        shankAccelCenteredRms_m_s2: s.shank.accelCenteredVectorRms_m_s2,
        shankGyroCenteredRms_deg_s: s.shank.gyroCenteredVectorRms_deg_s,
        phoneAccelCenteredRms_m_s2: s.phoneAccelerometer.centeredVectorRms,
        phoneGyroCenteredRms_deg_s: s.phoneGyroscope.centeredVectorRms
      }
    };
    // Only compact feature summaries are stored. Names, age, sex, notes and raw samples are excluded.
    const next = h.filter((r) => r.sessionId !== record.sessionId);
    next.push(record);
    try {
      if (root.localStorage) {
        root.localStorage.setItem(BASELINE_KEY, JSON.stringify(next.slice(-BASELINE_MAX_RECORDS)));
        state.lastSummarySaved = true;
      }
    } catch (e) { state.lastStatus = 'Local baseline history unavailable; current session data remain in memory.'; }
  }
  function refreshFinalSummaryWhenCoreReady() {
    if (!state.finalized || !coreReportReady()) return false;
    const summary = buildSummary();
    state.finalBaselineComparison = compareBaseline(summary);
    summary.baseline.comparison = state.finalBaselineComparison;
    state.finalSummary = summary;
    state.coreSummaryRefreshed = true;
    state.coreFinalizationTimedOut = false;
    saveLongitudinalSummary(summary);
    if (state.refreshTimer) root.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    state.lastStatus = 'Sensor capture and existing VSPIMU analysis are both finalized. Review data quality before interpreting results.';
    renderDashboard();
    return true;
  }

  function finalizeSession() {
    if (state.finalized) return;
    state.active = false;
    state.closing = false;
    state.finalized = true;
    state.phoneAccepting = false;
    state.coreFinalizationWaitStartedPerfMs = performance.now();
    state.coreFinalizationTimedOut = false;
    state.coreSummaryRefreshed = false;
    if (state.tailTimer) root.clearTimeout(state.tailTimer);
    state.tailTimer = null;
    if (state.refreshTimer) root.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    const summary = buildSummary();
    state.finalBaselineComparison = compareBaseline(summary);
    summary.baseline.comparison = state.finalBaselineComparison;
    state.finalSummary = summary;
    saveLongitudinalSummary(summary);
    if (coreReportReady()) {
      refreshFinalSummaryWhenCoreReady();
    } else {
      state.lastStatus = 'Phone/wearable raw capture is complete; existing gait analysis is still finalizing. Raw exports and the partial dual-IMU report remain available.';
      state.refreshTimer = root.setInterval(monitorCoreFinalization, 1000);
      renderDashboard();
    }
  }

  function getSummary() {
    if (state.finalized && !state.coreSummaryRefreshed && coreReportReady()) refreshFinalSummaryWhenCoreReady();
    if (state.finalSummary) return state.finalSummary;
    const s = buildSummary();
    s.baseline.comparison = state.finalBaselineComparison;
    return s;
  }
  function shankCsv() {
    const firstSeq = state.shank.length ? state.shank[0].seqUnwrapped : null;
    const rows = state.shank.map((r) => [state.sessionId, r.seq, r.seqUnwrapped, firstSeq === null ? '' : ((r.seqUnwrapped - firstSeq) / SHANK_HZ_NOMINAL).toFixed(6), r.ax_raw, r.ay_raw, r.az_raw, r.gx_raw, r.gy_raw, r.gz_raw, r.arrival_perf_ms.toFixed(3)]);
    return csvText(['session_id','sequence_raw_u32','sequence_unwrapped','shank_relative_time_s_nominal_208Hz','ax_raw_lsb','ay_raw_lsb','az_raw_lsb','gx_raw_lsb','gy_raw_lsb','gz_raw_lsb','ble_packet_receipt_perf_ms_not_acquisition_time'], rows);
  }
  function phoneAccCsv() {
    const rows = state.phoneAcc.map((r) => [state.sessionId, iso(r.t_wall_ms), r.t_wall_ms, r.t_session_s.toFixed(6), r.t_perf_ms.toFixed(3), r.x_m_s2, r.y_m_s2, r.z_m_s2, r.receipt_perf_ms.toFixed(3), r.time_source, state.pocket]);
    return csvText(['session_id','callback_wall_iso','callback_wall_ms','session_relative_callback_time_s','page_monotonic_time_estimate_ms','ax_m_s2','ay_m_s2','az_m_s2','js_batch_receipt_perf_ms','timestamp_source','phone_placement'], rows);
  }
  function phoneGyroCsv() {
    const rows = state.phoneGyro.map((r) => [state.sessionId, iso(r.t_wall_ms), r.t_wall_ms, r.sensor_ts_ns, r.t_session_s.toFixed(6), r.t_perf_ms.toFixed(3), r.x_dps, r.y_dps, r.z_dps, r.receipt_perf_ms.toFixed(3), r.time_source, state.pocket]);
    return csvText(['session_id','callback_wall_iso','callback_wall_ms','android_sensor_event_timestamp_ns_or_blank','session_relative_callback_time_s','page_monotonic_time_estimate_ms','gx_deg_s','gy_deg_s','gz_deg_s','js_batch_receipt_perf_ms','timestamp_source','phone_placement'], rows);
  }
  function eventsCsv() {
    const events = annotationsAndCoreEvents();
    // Do not imply phone annotations and core gait events share a synchronized zero.
    return csvText(['session_id','source_time_s','time_base','event_type','confidence_if_available','source','ground_truth'], events.map((e) => [state.sessionId, e.t_session_s, e.timeBase || 'unknown_time_base', e.type, e.confidence, e.source, false]));
  }
  function summaryCsv() {
    const s = getSummary();
    const rows = [];
    function add(path, value, unit, source, quality, interpretation) { rows.push([s.sessionId, path, value === null || value === undefined ? '' : value, unit, source, quality, interpretation || '']); }
    add('duration', s.elapsedDurationSec, 's', 'session timer', 'observed', 'Elapsed assessment duration');
    add('phone_placement', s.phonePlacement, 'category', 'user declared', 'metadata', 'Not inferred from sensors');
    add('shank.sample_count', s.shank.sampleCount, 'samples', 'BLE raw sequence', s.shank.quality, 'Raw shank samples received by the phone');
    add('shank.continuity', s.shank.continuityPct, '%', 'sequence range', s.shank.quality, 'Sequence continuity cannot identify whether a gap came from sensor read miss or BLE loss');
    add('shank.gyro_centered_vector_rms', s.shank.gyroCenteredVectorRms_deg_s, 'deg/s', 'LSM6DSO raw gyroscope', s.shank.quality, 'Centered vector RMS; movement feature, not a clinical score');
    add('shank.accel_centered_vector_rms', s.shank.accelCenteredVectorRms_m_s2, 'm/s^2', 'LSM6DSO raw accelerometer', s.shank.quality, 'Centered vector RMS; placement and gravity orientation affect it');
    add('phone_acc.sample_count', s.phoneAccelerometer.sampleCount, 'samples', 'MIT AI2 AccelerometerSensor', s.phoneAccelerometer.quality, s.phoneAccelerometer.timestampDefinition);
    add('phone_acc.observed_median_rate', s.phoneAccelerometer.observedMedianRateHz, 'Hz', 'callback wall-time intervals', s.phoneAccelerometer.quality, 'Approximate callback rate; not a guaranteed hardware sample rate');
    add('phone_acc.gap_intervals', s.phoneAccelerometer.gapIntervals, 'intervals', 'callback timestamps', s.phoneAccelerometer.quality, 'Long intervals relative to observed median; estimated omissions are not a true missing percentage');
    add('phone_acc.invalid_samples', s.phoneAccelerometer.invalidSamples, 'samples', 'phone accelerometer range/validity checks', s.phoneAccelerometer.quality, 'Out-of-range values are rejected; no clipping correction/interpolation is applied');
    add('phone_gyro.invalid_samples', s.phoneGyroscope.invalidSamples, 'samples', 'phone gyroscope range/validity checks', s.phoneGyroscope.quality, 'Out-of-range values are rejected; no clipping correction/interpolation is applied');
    add('phone_acc.centered_vector_rms', s.phoneAccelerometer.centeredVectorRms, 'm/s^2', 'phone accelerometer', s.phoneAccelerometer.quality, 'Gross movement-variability feature; not pelvic acceleration after anatomical calibration');
    add('phone_gyro.sample_count', s.phoneGyroscope.sampleCount, 'samples', 'MIT AI2 GyroscopeSensor', s.phoneGyroscope.quality, '');
    add('phone_gyro.native_median_rate', s.phoneGyroscope.observedMedianRateHz, 'Hz', 'native SensorEvent timestamp when available', s.phoneGyroscope.quality, 'Observed median interval; Android rate limits and hardware vary');
    add('phone_gyro.centered_vector_rms', s.phoneGyroscope.centeredVectorRms, 'deg/s', 'phone gyroscope', s.phoneGyroscope.quality, 'Gross angular-motion variability; not trunk angle');
    add('cross_sensor.status', s.crossSensor.status, 'category', 'coarse movement-envelope comparison', s.crossSensor.status, s.crossSensor.reason || '');
    add('cross_sensor.envelope_correlation', s.crossSensor.activityEnvelopeCorrelation, 'r', '0.5-s bins', s.crossSensor.status, 'Exploratory correlation; not accuracy or clinical confidence');
    add('cross_sensor.lag_correction', s.crossSensor.lagCorrectionSec, 's', 'activity-envelope alignment', s.crossSensor.status, 'Not applied to source timestamps');
    if (s.baseline.comparison && s.baseline.comparison.metrics) {
      for (const [key, v] of Object.entries(s.baseline.comparison.metrics)) {
        add(`baseline.${key}.current`, v.current, 'feature unit per metric', 'current session', v.status, 'Descriptive only');
        add(`baseline.${key}.median`, v.baselineMedian, 'feature unit per metric', 'prior comparable sessions', v.status, `${v.baselineN} previous sessions`);
        add(`baseline.${key}.percent_change`, v.percentChange, '%', 'current vs within-person median', v.status, 'Only compared for the same pseudonymous profile, pocket, protocol and algorithm version');
      }
    }
    return csvText(['session_id','metric','value','unit','source','quality_status','interpretation_limit'], rows);
  }
  function syncCsv() {
    const s = getSummary();
    const c = s.crossSensor || {};
    const fit = c.clockFit || s.shank.packetClockFit || {};
    const rows = [
      ['phone_placement', s.phonePlacement, 'metadata', 'user declared; do not infer anatomical attachment'],
      ['shank_nominal_odr_hz', s.shank.configuredOdrHz, 'sequence', 'configured ODR; sequence time is nominal'],
      ['shank_first_sequence', s.shank.firstSequence, 'sequence', 'source sequence'],
      ['shank_last_sequence', s.shank.lastSequence, 'sequence', 'source sequence'],
      ['shank_sequence_gap_slots', s.shank.sequenceGapSlots, 'sequence', 'Cannot identify whether sensor read miss or BLE data loss caused a gap'],
      ['packet_anchor_count', fit.anchorCount, 'BLE receive', 'Packet receipt is not sensor acquisition time'],
      ['packet_clock_relative_scale', fit.relativeClockScale, 'ratio', 'Arrival-time slope against nominal sequence time; not a true sensor-clock drift measurement'],
      ['packet_clock_fit_intercept_perf_ms', fit.interceptPerfMs, 'regression', 'Includes unknown BLE/dispatch delay'],
      ['packet_clock_fit_r2', fit.r2, 'regression', 'Relative transport-fit diagnostic only'],
      ['packet_clock_fit_residual_mad_ms', fit.residualMadMs, 'regression', 'Packet notification timing jitter indicator'],
      ['validated_end_to_end_sync_uncertainty_ms', '', 'not quantified', 'No validated end-to-end synchronization uncertainty bound'],
      ['activity_envelope_match_status', c.status, 'exploratory', c.reason || ''],
      ['activity_envelope_correlation', c.activityEnvelopeCorrelation, 'Pearson r', 'Different body sites and signal channels; correlation does not imply an exact event match'],
      ['candidate_lag_correction_s', c.lagCorrectionSec, 's', 'Reported only; never used to rewrite raw timestamps'],
      ['activity_envelope_bin_resolution_ms', c.binResolutionMs, 'ms', 'Feature comparison resolution; not true sync uncertainty'],
      ['nominal_half_bin_quantization_ms', c.nominalBinQuantizationMs, 'ms', 'Only bin quantization; excludes unknown transport/callback jitter'],
      ['validated_end_to_end_sync_uncertainty_ms', c.synchronizationUncertaintyMs, 'ms', 'Not quantified by this integration; leave blank'],
      ['phone_acc_timestamp_source', s.phoneAccelerometer.timestampDefinition, 'API limitation', 'callback time not SensorEvent timestamp'],
      ['phone_gyro_timestamp_source', s.phoneGyroscope.timestampDefinition, 'API capability', 'native sensor timestamp kept for rate checks']
    ];
    return csvText(['session_id','synchronization_item','value','method','limitation'], rows.map((r) => [s.sessionId, ...r]));
  }
  function exportSummaryJson() {
    return JSON.stringify({ summary: getSummary(), annotations: state.annotations, dataPolicy: { rawRowsInLocalStorage: false, storedHistoryFields: 'pseudonymous profile code + compact metrics only', noCloudUpload: true } }, null, 2) + '\n';
  }
  function safeFileBase(value) { return String(value || 'session').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'session'; }
  function fallbackBlobDownload(filename, content, mime) {
    try {
      const blob = new Blob([content], { type: mime || 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = root.document.createElement('a');
      a.href = url; a.download = filename; a.style.display = 'none';
      root.document.body.appendChild(a); a.click(); a.remove();
      root.setTimeout(() => URL.revokeObjectURL(url), 5000);
      return true;
    } catch (e) { console.error('VSPIMU blob export failed', e); return false; }
  }
  function sendExportMessage(msg) { return sendToAppInventor(msg); }
  function clearExportTimeout() {
    const e = state.exportState;
    if (e && e.timeoutTimer) root.clearTimeout(e.timeoutTimer);
    if (e) e.timeoutTimer = null;
  }
  function armExportTimeout() {
    const e = state.exportState;
    if (!e) return;
    clearExportTimeout();
    e.timeoutTimer = root.setTimeout(() => {
      const current = state.exportState;
      if (current !== e) return;
      const name = current.filename;
      state.exportState = null;
      domText('phoneExportStatus', `Export timed out while writing ${name}. No success was assumed; check the File component blocks and retry.`);
    }, 15000);
  }
  function startChunkedExport(filename, content, mime) {
    const chunks = [];
    for (let i = 0; i < content.length; i += MAX_EXPORT_CHARS_PER_CHUNK) chunks.push(content.slice(i, i + MAX_EXPORT_CHARS_PER_CHUNK));
    if (!chunks.length) chunks.push('');
    const exportId = `${state.sessionId || makeSessionId()}-${Math.floor(Math.random() * 0xFFFFFF).toString(16)}`;
    state.exportState = { exportId, filename, mime, chunks, nextIndex: 0, waiting: 'begin', startedAt: Date.now(), timeoutTimer: null };
    const ok = sendExportMessage({ type: 'phone_imu_export_begin', exportId, filename, mime, totalChunks: chunks.length, totalChars: content.length, sessionId: state.sessionId });
    if (!ok) { state.exportState = null; return false; }
    armExportTimeout();
    domText('phoneExportStatus', `Preparing ${filename} for app-private storage…`);
    return true;
  }
  function ackExportBegin(exportId) {
    const e = state.exportState;
    if (!e || e.exportId !== exportId || e.waiting !== 'begin') return false;
    clearExportTimeout();
    e.waiting = 'chunk'; e.nextIndex = 0;
    return sendNextExportChunk();
  }
  function sendNextExportChunk() {
    const e = state.exportState;
    if (!e || e.waiting !== 'chunk') return false;
    if (e.nextIndex >= e.chunks.length) {
      e.waiting = 'complete';
      const sent = sendExportMessage({ type: 'phone_imu_export_done', exportId: e.exportId, filename: e.filename, totalChunks: e.chunks.length, totalChars: e.chunks.reduce((s, c) => s + c.length, 0) });
      if (!sent) { ackExportComplete(e.exportId, false, 'could not send completion message'); return false; }
      armExportTimeout();
      domText('phoneExportStatus', `Verifying ${e.filename} in app storage…`);
      return true;
    }
    const i = e.nextIndex;
    const ok = sendExportMessage({ type: 'phone_imu_export_chunk', exportId: e.exportId, filename: e.filename, index: i, totalChunks: e.chunks.length, text: e.chunks[i] });
    if (ok) { e.waiting = 'ack_chunk'; armExportTimeout(); }
    return ok;
  }
  function ackExportChunk(exportId, index) {
    const e = state.exportState;
    if (!e || e.exportId !== exportId || e.waiting !== 'ack_chunk' || Number(index) !== e.nextIndex) return false;
    clearExportTimeout();
    e.nextIndex++;
    e.waiting = 'chunk';
    return sendNextExportChunk();
  }
  function ackExportComplete(exportId, success, detail) {
    const e = state.exportState;
    if (!e || e.exportId !== exportId) return false;
    clearExportTimeout();
    domText('phoneExportStatus', success ? `${e.filename} saved by the App Inventor File component. It remains in app-specific storage until you share/copy it.` : `Export failed: ${detail || 'file write failed'}`);
    state.exportState = null;
    return true;
  }
  function coreReportReady() {
    const core = currentCoreSnapshot();
    if (!core) return true;
    const notRunning = core.running !== true;
    const notFinalizing = core.finalizationInProgress !== true;
    if (typeof core.finalizationReady === 'boolean') return core.finalizationReady && notRunning && notFinalizing;
    return notRunning && notFinalizing;
  }
  function monitorCoreFinalization() {
    if (!state.finalized) return;
    if (coreReportReady()) {
      refreshFinalSummaryWhenCoreReady();
      return;
    }
    const waitedMs = Math.max(0, performance.now() - (state.coreFinalizationWaitStartedPerfMs || performance.now()));
    if (waitedMs >= 120000 && !state.coreFinalizationTimedOut) {
      state.coreFinalizationTimedOut = true;
      state.lastStatus = 'The existing gait engine has not reported finalization after 120 seconds. Sensor data remain exportable; event/engine outputs may be partial. The dual-IMU report marks this condition.';
      if (state.refreshTimer) root.clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    renderDashboard();
  }
  function exportFile(kind) {
    if (!state.finalized) {
      domText('phoneExportStatus', 'Stop the assessment and wait for sensor capture to finalize before exporting.');
      return false;
    }
    const s = getSummary();
    let name = '', content = '', mime = 'text/csv;charset=utf-8';
    switch (kind) {
      case 'shank': name = 'shank_raw.csv'; content = shankCsv(); break;
      case 'phone_acc': name = 'phone_accelerometer.csv'; content = phoneAccCsv(); break;
      case 'phone_gyro': name = 'phone_gyroscope.csv'; content = phoneGyroCsv(); break;
      case 'events': name = 'movement_events_and_annotations.csv'; content = eventsCsv(); break;
      case 'summary': name = 'session_quality_and_metrics.csv'; content = summaryCsv(); break;
      case 'sync': name = 'synchronization_diagnostics.csv'; content = syncCsv(); break;
      case 'json': name = 'session_summary.json'; content = exportSummaryJson(); mime = 'application/json;charset=utf-8'; break;
      default: domText('phoneExportStatus', 'Unknown export type.'); return false;
    }
    // Every export click gets its own collision-resistant name, even within one session.
    const exportNonce = `${Date.now()}_${Math.floor(Math.random() * 0xFFFFF).toString(16)}`;
    const filename = `${safeFileBase(s.sessionId)}_${exportNonce}_${name}`;
    // In AI2 WebViewer, export through App Inventor File/Sharing blocks; browser Blob is a fallback only.
    if (root.AppInventor && typeof root.AppInventor.setWebViewString === 'function') {
      return startChunkedExport(filename, content, mime);
    }
    const ok = fallbackBlobDownload(filename, content, mime);
    domText('phoneExportStatus', ok ? `Download requested: ${filename}` : 'This host does not support file export.');
    return ok;
  }

  function renderBaselineText(summary) {
    const b = summary.baseline.comparison;
    if (!b || !b.eligible) return 'Baseline: not created. Enter a 3–32 character pseudonymous profile code and collect comparable high-quality sessions.';
    if (b.comparablePriorSessions < b.minimumPriorSessions) return `Baseline is provisional (${b.comparablePriorSessions}/${b.minimumPriorSessions} prior eligible sessions). No alert is generated.`;
    const parts = [];
    for (const [key, m] of Object.entries(b.metrics || {})) {
      if (finite(m.percentChange)) parts.push(`${key}: ${m.percentChange >= 0 ? '+' : ''}${m.percentChange.toFixed(1)}% vs own median (n=${m.baselineN})`);
    }
    return parts.length ? `Within-person descriptive comparison: ${parts.join(' • ')}. Not a medical alert.` : b.note;
  }
  function quickRate(rows, getter, maxRows = 160) {
    if (!rows || rows.length < 5) return null;
    const start = Math.max(0, rows.length - maxRows);
    const values = [];
    for (let i = start; i < rows.length; i++) {
      const t = getter(rows[i]);
      if (finite(t)) values.push(t);
    }
    const dts = [];
    for (let i = 1; i < values.length; i++) if (values[i] > values[i - 1]) dts.push(values[i] - values[i - 1]);
    const dt = median(dts);
    return dt && dt > 0 ? 1 / dt : null;
  }
  function quickPreview() {
    const shankRows = state.shank.length;
    const first = shankRows ? state.shank[0].seqUnwrapped : null;
    const last = shankRows ? state.shank[shankRows - 1].seqUnwrapped : null;
    const slots = first !== null && last !== null && last >= first ? last - first + 1 : shankRows;
    const continuityPct = slots > 0 ? 100 * Math.min(shankRows, slots) / slots : null;
    return {
      shank: {
        quality: state.finalized ? 'UNAVAILABLE' : 'IN SESSION — EVALUATED AT STOP',
        continuityPct,
        sequenceGapSlots: state.shankGapSlots
      },
      phoneAccelerometer: { quality: 'IN SESSION — EVALUATED AT STOP' },
      phoneGyroscope: { quality: 'IN SESSION — EVALUATED AT STOP' },
      crossSensor: { status: 'PENDING', reason: 'Cross-sensor analysis runs after capture stops.' },
      baseline: { comparison: null }
    };
  }
  function renderDashboard() {
    if (!byId('phoneImuStatus')) return;
    domText('phoneImuStatus', state.closing ? 'FINALIZING SENSOR CAPTURE' : (state.finalized ? (state.coreFinalizationTimedOut ? 'PARTIAL SESSION' : 'SESSION CAPTURE COMPLETE') : (state.active ? 'RECORDING' : 'READY')));
    domClass('phoneImuStatus', state.closing ? 'value warn' : (state.finalized ? (state.coreFinalizationTimedOut ? 'value warn' : 'value ok') : (state.active ? 'value blue' : 'value')));
    domText('phoneImuDetail', `${state.lastStatus} • ${state.sessionId || 'No session yet'}`);
    domText('phonePocketSummary', ({ left_front_pocket: 'Left front pocket', right_front_pocket: 'Right front pocket', other_declared: 'Other declared placement', not_declared: 'Not declared' })[state.pocket] || state.pocket);
    domText('phoneAccCount', `${state.phoneAcc.length}${state.phoneAccTruncated ? ' (CAP REACHED)' : ''}`);
    domText('phoneGyroCount', `${state.phoneGyro.length}${state.phoneGyroTruncated ? ' (CAP REACHED)' : ''}`);
    domText('shankRawCount', `${state.shank.length}${state.shankTruncated ? ' (CAP REACHED)' : ''}`);
    const q = state.finalSummary || quickPreview();
    const accRate = state.finalSummary ? q.phoneAccelerometer.observedMedianRateHz : quickRate(state.phoneAcc, (r) => r.t_wall_ms / 1000);
    const gyroRate = state.finalSummary ? q.phoneGyroscope.observedMedianRateHz : quickRate(state.phoneGyro, (r) => finite(r.sensor_ts_ns) ? r.sensor_ts_ns / 1e9 : r.t_wall_ms / 1000);
    domText('phoneAccRate', fmt(accRate, 1, ' Hz'));
    domText('phoneGyroRate', fmt(gyroRate, 1, ' Hz'));
    const contText = q.shank.continuityPct === null ? 'continuity unavailable' : q.shank.continuityPct.toFixed(2) + '% sequence continuity';
    domText('shankQualityText', `${q.shank.quality} • ${contText} • ${q.shank.sequenceGapSlots} missing sequence slots`);
    domText('phoneQualityText', `Accelerometer: ${q.phoneAccelerometer.quality}; gyroscope: ${q.phoneGyroscope.quality}. Full gap/interval analysis after STOP. AI2 accelerometer uses callback timestamps.`);
    domText('syncQualityText', `${q.crossSensor.status}: ${q.crossSensor.reason || 'No synchronization estimate yet.'}${finite(q.crossSensor.activityEnvelopeCorrelation) ? ` (r=${q.crossSensor.activityEnvelopeCorrelation.toFixed(2)})` : ''}`);
    domText('phoneBaselineText', state.finalSummary ? renderBaselineText(q) : 'Baseline and trend comparison are evaluated after STOP; no live medical alert is generated.');
    const expBtnIds = ['exportShankCsv','exportPhoneAccCsv','exportPhoneGyroCsv','exportEventsCsv','exportSummaryCsv','exportSyncCsv','exportSummaryJson'];
    const enabled = !!(state.finalized && (state.shank.length || state.phoneAcc.length || state.phoneGyro.length));
    for (const id of expBtnIds) { const el = byId(id); if (el) el.disabled = !enabled; }
    const baselineBtn = byId('clearPhoneBaselineBtn');
    if (baselineBtn) baselineBtn.disabled = !readProfileCode();
    const reportBtn = byId('dualImuReportBtn');
    if (reportBtn) reportBtn.disabled = !state.finalized;
    for (const id of ['annotateTurnBtn','annotatePauseBtn','annotateSymptomBtn']) {
      const el = byId(id); if (el) el.disabled = !state.active || state.closing;
    }
  }

  function reportSectionHtml(summary) {
    const s = summary;
    const rows = [
      ['Wearable shank samples', s.shank.sampleCount, 'samples', s.shank.quality],
      ['Shank sequence continuity', finite(s.shank.continuityPct) ? s.shank.continuityPct.toFixed(2) : 'Unavailable', '%', s.shank.quality],
      ['Shank missing sequence slots', s.shank.sequenceGapSlots, 'slots', s.shank.quality],
      ['Shank near-full-scale raw rows', s.shank.clippedRows, 'rows near int16 limits; proxy', s.shank.quality],
      ['Phone accelerometer samples', s.phoneAccelerometer.sampleCount, 'samples', s.phoneAccelerometer.quality],
      ['Phone accelerometer observed callback rate', fmt(s.phoneAccelerometer.observedMedianRateHz, 2), 'Hz (approx.)', s.phoneAccelerometer.quality],
      ['Phone accelerometer long intervals', s.phoneAccelerometer.gapIntervals, 'intervals > 3× observed median', s.phoneAccelerometer.quality],
      ['Phone acceleration missing-callback estimate', fmt(s.phoneAccelerometer.estimatedMissingPctRelativeToObservedMedianInterval, 1, '%'), 'heuristic; not true loss percentage', s.phoneAccelerometer.quality],
      ['Phone acceleration timestamp reversals / duplicates', `${s.phoneAccelerometer.timestampReversals} / ${s.phoneAccelerometer.duplicateTimestamps}`, 'callback clock checks', s.phoneAccelerometer.quality],
      ['Phone gyroscope samples', s.phoneGyroscope.sampleCount, 'samples', s.phoneGyroscope.quality],
      ['Phone acceleration invalid callbacks', s.phoneAccelerometer.invalidSamples, 'callbacks', s.phoneAccelerometer.quality],
      ['Phone gyro invalid callbacks', s.phoneGyroscope.invalidSamples, 'callbacks', s.phoneGyroscope.quality],
      ['Phone gyroscope observed median rate', fmt(s.phoneGyroscope.observedMedianRateHz, 2), 'Hz', s.phoneGyroscope.quality],
      ['Phone gyroscope long intervals', s.phoneGyroscope.gapIntervals, 'intervals > 3× observed median', s.phoneGyroscope.quality],
      ['Phone gyro missing-callback estimate', fmt(s.phoneGyroscope.estimatedMissingPctRelativeToObservedMedianInterval, 1, '%'), 'heuristic; not true loss percentage', s.phoneGyroscope.quality],
      ['Phone gyroscope timestamp reversals / duplicates', `${s.phoneGyroscope.timestampReversals} / ${s.phoneGyroscope.duplicateTimestamps}`, 'timestamp checks', s.phoneGyroscope.quality],
      ['Phone placement', s.phonePlacement, 'user-declared metadata', 'METADATA'],
      ['Wearable placement', s.shankPlacement, 'project mounting specification', 'METADATA'],
      ['Cross-sensor activity-envelope match', s.crossSensor.status, 'category', s.crossSensor.status],
      ['Cross-sensor envelope correlation', fmt(s.crossSensor.activityEnvelopeCorrelation, 3), 'r; exploratory only', s.crossSensor.status],
      ['Potential activity-envelope lag', fmt(s.crossSensor.lagCorrectionSec, 3), 's; exploratory candidate, not applied', s.crossSensor.status],
      ['Envelope comparison bin resolution', fmt(s.crossSensor.binResolutionMs, 0), 'ms per bin; not a sync confidence bound', s.crossSensor.status],
      ['Shank accel centered vector RMS', fmt(s.shank.accelCenteredVectorRms_m_s2, 3), 'm/s²', s.shank.quality],
      ['Shank gyro centered vector RMS', fmt(s.shank.gyroCenteredVectorRms_deg_s, 2), 'deg/s', s.shank.quality],
      ['Initial instructed stand segment shank accel RMS', fmt(s.initialStandSegment.shankAccelCenteredRms_m_s2, 3), 'm/s²; first 8 s descriptive window', s.initialStandSegment.shankQuality],
      ['Initial instructed stand segment phone accel RMS', fmt(s.initialStandSegment.phoneAccelCenteredRms_m_s2, 3), 'm/s²; first 8 s descriptive window', s.initialStandSegment.phoneAccelerometerQuality],
      ['Initial instructed stand segment phone gyro RMS', fmt(s.initialStandSegment.phoneGyroCenteredRms_deg_s, 2), 'deg/s; first 8 s descriptive window', s.initialStandSegment.phoneGyroscopeQuality],
      ['Phone accel centered vector RMS', fmt(s.phoneAccelerometer.centeredVectorRms, 3), 'm/s²', s.phoneAccelerometer.quality],
      ['Phone gyro centered vector RMS', fmt(s.phoneGyroscope.centeredVectorRms, 2), 'deg/s', s.phoneGyroscope.quality]
    ];
    const tr = rows.map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`).join('');
    const lim = s.dataQuality.knownLimitations.map((x) => `<li>${esc(x)}</li>`).join('');
    const b = s.baseline.comparison;
    let baselineTable = '<p>No eligible within-person comparison was generated for this session.</p>';
    if (b && b.eligible) {
      const bRows = Object.entries(b.metrics || {}).map(([k, m]) => `<tr><td>${esc(k)}</td><td>${esc(fmt(m.current, 3))}</td><td>${esc(fmt(m.baselineMedian, 3))}</td><td>${esc(fmt(m.percentChange, 1, '%'))}</td><td>${esc(m.baselineN)}</td></tr>`).join('');
      baselineTable = `<p>${esc(b.note || '')}</p><table><thead><tr><th>Feature</th><th>Current</th><th>Prior median</th><th>Change</th><th>Prior n</th></tr></thead><tbody>${bRows}</tbody></table>`;
    }
    return `<section id="vspimu-dual-imu-report" style="margin:18px 0;padding:16px;border:1px solid #b7c6d7;border-radius:10px;color:#172033;background:#fff;font:12px/1.45 system-ui,-apple-system,Segoe UI,Arial"><h2>Dual-IMU data quality and movement summary</h2><p><b>Session:</b> ${esc(s.sessionId)} · <b>Start:</b> ${esc(s.startedAt)} · <b>Phone placement:</b> ${esc(s.phonePlacement)}${s.phonePlacementDetail ? ' — ' + esc(s.phonePlacementDetail) : ''} · <b>Protocol:</b> ${esc(s.protocol)}</p><p>This section reports sensor observations and descriptive movement features. It is not a diagnosis, validated fall-risk estimate, gait-event ground truth, or anatomical kinematic measurement.</p><p><b>Existing gait engine status:</b> ${s.coreAnalysis && s.coreAnalysis.finalizationReady ? 'finalization reported ready' : 'not confirmed ready when this summary was built'}${s.coreAnalysis && s.coreAnalysis.running ? '; still running' : ''}${s.coreAnalysis && s.coreAnalysis.finalizationInProgress ? '; finalization in progress' : ''}. If engine completion is pending, its event rows may be incomplete; raw sensor exports remain available.</p>${s.phoneLifecycle && s.phoneLifecycle.interrupted ? '<p><b>Phone capture interruption:</b> App lifecycle interruption(s) were recorded. Phone-derived features must be reviewed as potentially incomplete.</p>' : ''}<table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left;border-bottom:1px solid #9aa8b7;padding:5px">Measurement</th><th style="text-align:left;border-bottom:1px solid #9aa8b7;padding:5px">Value</th><th style="text-align:left;border-bottom:1px solid #9aa8b7;padding:5px">Unit / meaning</th><th style="text-align:left;border-bottom:1px solid #9aa8b7;padding:5px">Quality</th></tr></thead><tbody>${tr}</tbody></table><h3>Initial instructed stand segment (first 8 s per stream)</h3><p>Each sensor's first eight seconds use its own local time origin; these windows are not asserted to be synchronized. Wearable ${esc(s.initialStandSegment.shankSampleCount)} samples (${esc(s.initialStandSegment.shankQuality)}); phone acceleration ${esc(s.initialStandSegment.phoneAccelerometerSampleCount)} samples (${esc(s.initialStandSegment.phoneAccelerometerQuality)}); phone gyroscope ${esc(s.initialStandSegment.phoneGyroscopeSampleCount)} samples (${esc(s.initialStandSegment.phoneGyroscopeQuality)}). Centered movement RMS: shank acceleration ${esc(fmt(s.initialStandSegment.shankAccelCenteredRms_m_s2,3))} m/s², phone acceleration ${esc(fmt(s.initialStandSegment.phoneAccelCenteredRms_m_s2,3))} m/s², phone gyro ${esc(fmt(s.initialStandSegment.phoneGyroCenteredRms_deg_s,2))} deg/s. This is a descriptive window only, not a calibration or stationary pass/fail.</p><h3>Within-person comparison</h3>${baselineTable}<h3>Synchronization and limitations</h3><p>${esc(s.crossSensor.reason || 'Cross-sensor comparison unavailable.')}</p><p>${esc(s.crossSensor.caveat || 'Raw timestamps are preserved separately; this module does not force alignment.')}</p><ul>${lim}</ul><p><b>Unsupported from this configuration alone:</b> bilateral asymmetry, absolute walking speed or distance, foot clearance in millimetres, joint angles/forces/torques, muscle strength, and clinical diagnosis/prediction. Event candidates are algorithmic estimates, not reference labels.</p><p><b>Data retention:</b> raw sample rows remain in the active page memory until cleared/reloaded/exported. Optional local baseline history stores only a pseudonymous profile code and compact features; raw samples and patient name/notes are not stored in that history. Nothing is uploaded to a cloud service by this module.</p></section>`;
  }
  function injectIntoReportDocument(doc, summary) {
    if (!doc || !doc.body || doc.getElementById('vspimu-dual-imu-report')) return false;
    const holder = doc.createElement('div');
    holder.innerHTML = reportSectionHtml(summary);
    doc.body.appendChild(holder.firstElementChild);
    return true;
  }
  function tryInjectReportFrame(summary) {
    const frame = byId('dualImuReportFrame');
    if (!frame) return false;
    try {
      if (frame.contentDocument && frame.contentDocument.readyState !== 'loading') return injectIntoReportDocument(frame.contentDocument, summary);
    } catch (_) { /* The report may have switched to a cross-origin viewer. */ }
    return false;
  }
  function enrichReportResult(result, summary) {
    if (!result || typeof result.html !== 'string' || result.html.includes('id="vspimu-dual-imu-report"')) return false;
    const section = reportSectionHtml(summary);
    const i = result.html.toLowerCase().lastIndexOf('</body>');
    result.html = i >= 0 ? result.html.slice(0, i) + section + result.html.slice(i) : result.html + section;
    return true;
  }
  function showSensorReport() {
    const s = getSummary();
    const frame = byId('dualImuReportFrame');
    const overlay = byId('dualImuReportOverlay');
    if (!frame || !overlay) {
      domText('phoneImuDetail', 'Report viewer elements are not present. Data exports remain available.');
      return false;
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VSPIMU dual-IMU data report</title><style>body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Arial;color:#172033;padding:18px;margin:0}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border-bottom:1px solid #d4dce5;padding:7px;text-align:left;vertical-align:top}h1{font-size:22px}h2{margin-top:24px}@media(max-width:600px){body{padding:10px}table{font-size:11px}}</style></head><body><h1>VSPIMU — Dual-IMU Session Data Report</h1><p>Partial report is allowed when one stream is unavailable. Values below are based only on samples captured by the current page.</p>${reportSectionHtml(s)}</body></html>`;
    frame.srcdoc = html;
    overlay.style.display = 'flex';
    return true;
  }

  function annotate(type) {
    if (!state.active || state.closing) {
      domText('phoneImuDetail', 'Start a session before recording task annotations.');
      return false;
    }
    const nowPerf = performance.now();
    const annotation = { t_session_s: (nowPerf - state.startedPerfMs) / 1000, wall_time: iso(Date.now()), type, note: '', source: 'manual_user_annotation', timeBase: 'WebView_monotonic_elapsed_since_phone_module_start' };
    state.annotations.push(annotation);
    state.lastStatus = `Recorded manual annotation: ${type}`;
    renderDashboard();
    return true;
  }
  function recordLifecycleEvent(type) {
    const safeType = String(type || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'unknown_lifecycle_event';
    if (!state.active && !state.finalized) return false;
    const nowPerf = performance.now();
    const event = { type: safeType, t_session_s: Math.max(0, (nowPerf - state.startedPerfMs) / 1000), wall_time: iso(Date.now()), source: 'app_lifecycle', timeBase: 'WebView_monotonic_elapsed_since_phone_module_start' };
    state.phoneLifecycleEvents.push(event);
    if (state.active && !state.closing) state.lastStatus = `Phone/app lifecycle event recorded: ${safeType}; affected intervals remain flagged for review.`;
    renderDashboard();
    return true;
  }
  function clearHistoryForCurrentProfile() {
    const code = readProfileCode();
    if (!code) { domText('phoneExportStatus', 'Enter a valid pseudonymous profile code (3–32 letters, digits, _ or -) first.'); return false; }
    const remaining = getHistory().filter((r) => r.profileCode !== code);
    try { if (root.localStorage) root.localStorage.setItem(BASELINE_KEY, JSON.stringify(remaining)); }
    catch (e) { domText('phoneExportStatus', 'Could not clear local baseline history in this WebView.'); return false; }
    domText('phoneBaselineText', `Local summary history for ${code} cleared. Raw session rows were not stored there.`);
    return true;
  }
  function updatePlacementNoteVisibility() {
    const wrap = byId('phonePlacementDetailWrap');
    if (wrap) wrap.style.display = selectedPlacement() === 'other_declared' ? 'block' : 'none';
  }
  function wireUi() {
    updatePlacementNoteVisibility();
    const actionMap = {
      exportShankCsv: 'shank', exportPhoneAccCsv: 'phone_acc', exportPhoneGyroCsv: 'phone_gyro',
      exportEventsCsv: 'events', exportSummaryCsv: 'summary', exportSyncCsv: 'sync', exportSummaryJson: 'json'
    };
    for (const [id, kind] of Object.entries(actionMap)) {
      const el = byId(id);
      if (el && !el.dataset.phoneImuBound) { el.dataset.phoneImuBound = '1'; el.addEventListener('click', () => exportFile(kind)); }
    }
    const reportBtn = byId('dualImuReportBtn');
    if (reportBtn && !reportBtn.dataset.phoneImuBound) { reportBtn.dataset.phoneImuBound = '1'; reportBtn.addEventListener('click', showSensorReport); }
    const clearBtn = byId('clearPhoneBaselineBtn');
    if (clearBtn && !clearBtn.dataset.phoneImuBound) { clearBtn.dataset.phoneImuBound = '1'; clearBtn.addEventListener('click', clearHistoryForCurrentProfile); }
    for (const [id, type] of [['annotateTurnBtn','turn_candidate'], ['annotatePauseBtn','pause_or_stop'], ['annotateSymptomBtn','user_reported_issue']]) {
      const el = byId(id);
      if (el && !el.dataset.phoneImuBound) { el.dataset.phoneImuBound = '1'; el.addEventListener('click', () => annotate(type)); }
    }
    const check = byId('phoneCaptureOptIn');
    const pocket = byId('phonePocketSelect');
    const placementDetail = byId('phonePlacementDetail');
    for (const el of [check, pocket, placementDetail]) if (el && !el.dataset.phoneImuBound) {
      el.dataset.phoneImuBound = '1';
      el.addEventListener('change', () => {
        updatePlacementNoteVisibility();
        if (!state.active) return;
        state.lastStatus = 'Phone capture configuration changed; changes apply to the next session. Current session placement remains fixed.';
        renderDashboard();
      });
    }
  }

  function wrapApi() {
    const api = root.VSPIMU;
    if (!api || api.__phoneImuWrapped) return false;
    api.__phoneImuWrapped = true;
    if (typeof api.receiveShortsCsv === 'function') {
      const originalReceive = api.receiveShortsCsv;
      api.receiveShortsCsv = function (csv) {
        try { captureShankCsv(csv); } catch (e) { console.warn('VSPIMU shank capture add-on failed safely:', e); }
        return originalReceive.apply(this, arguments);
      };
    }
    if (typeof api.start === 'function') {
      const originalStart = api.start;
      api.start = function () {
        try { resetSession(); } catch (e) { console.warn('VSPIMU phone-IMU session start failed safely:', e); }
        return originalStart.apply(this, arguments);
      };
    }
    if (typeof api.stop === 'function') {
      const originalStop = api.stop;
      api.stop = function () {
        try { endPhoneCapture(); } catch (e) { console.warn('VSPIMU phone-IMU stop failed safely:', e); }
        return originalStop.apply(this, arguments);
      };
    }
    // Intercept the existing report-viewer handoff so the dual-IMU section is
    // present before the current viewer renders it. Do not replace the viewer.
    if (typeof api.openPreparedReport === 'function') {
      const originalOpen = api.openPreparedReport;
      api.openPreparedReport = function (html, filename, snapshot) {
        try {
          if (typeof html === 'string' && !html.includes('id=\"vspimu-dual-imu-report\"')) {
            const section = reportSectionHtml(getSummary());
            const i = html.toLowerCase().lastIndexOf('</body>');
            html = i >= 0 ? html.slice(0, i) + section + html.slice(i) : html + section;
          }
        } catch (e) { console.warn('VSPIMU dual-IMU report handoff failed safely:', e); }
        return originalOpen.call(this, html, filename, snapshot);
      };
    }
    if (typeof api.prepareReport === 'function') {
      const originalPrepare = api.prepareReport;
      api.prepareReport = function () {
        let result;
        try { result = originalPrepare.apply(this, arguments); }
        catch (e) { throw e; }
        try {
          const summary = getSummary();
          enrichReportResult(result, summary);
          root.setTimeout(() => tryInjectReportFrame(summary), 100);
        } catch (e) { console.warn('VSPIMU report add-on could not enrich report; original report remains intact:', e); }
        return result;
      };
    }
    return true;
  }

  const api = {
    version: VERSION,
    algorithmVersion: ALGORITHM_ID,
    beginSession: resetSession,
    stopSession: endPhoneCapture,
    setNativeSensorStatus,
    ingestBatch,
    annotate,
    recordLifecycleEvent,
    getSummary,
    exportFile,
    ackExportBegin,
    ackExportChunk,
    ackExportComplete,
    clearHistoryForCurrentProfile,
    showSensorReport,
    _test: {
      state,
      analyzeTime,
      shankSummary,
      phoneSummary,
      crossSensorSummary,
      reportSectionHtml,
      csvCell,
      compareBaseline,
      resetSession,
      finalizeSession,
      captureShankCsv,
      buildSummary,
      firstStandSegmentSummary,
      phoneAccCsv,
      phoneGyroCsv,
      shankCsv,
      eventsCsv,
      summaryCsv,
      syncCsv,
      ingestBatch,
      monitorCoreFinalization,
      refreshFinalSummaryWhenCoreReady,
      coreReportReady,
      unwrapSequence
    }
  };
  root.VSPIMUPhoneIMU = api;
  wireUi();
  wrapApi();
  renderDashboard();
})(window);
