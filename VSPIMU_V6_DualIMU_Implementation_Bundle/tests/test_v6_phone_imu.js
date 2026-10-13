'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function createHarness(opts = {}) {
  const nodes = new Map();
  const setText = (id, value, extra = {}) => {
    const node = { id, textContent: '', className: '', value: '', checked: false, disabled: false, dataset: {}, style: {}, listeners: {}, ...extra,
      addEventListener(type, fn) { this.listeners[type] = fn; },
      remove() {}, click() { if (this.listeners.click) this.listeners.click(); }
    };
    nodes.set(id, node); return node;
  };
  ['phoneCaptureOptIn','phonePocketSelect','phonePlacementDetail','phonePlacementDetailWrap','profileCode','phoneImuStatus','phoneImuDetail','phonePocketSummary','phoneAccCount','phoneGyroCount','shankRawCount','phoneAccRate','phoneGyroRate','shankQualityText','phoneQualityText','syncQualityText','phoneBaselineText','phoneExportStatus','exportShankCsv','exportPhoneAccCsv','exportPhoneGyroCsv','exportEventsCsv','exportSummaryCsv','exportSyncCsv','exportSummaryJson','dualImuReportBtn','clearPhoneBaselineBtn','annotateTurnBtn','annotatePauseBtn','annotateSymptomBtn','dualImuReportOverlay','dualImuReportFrame'].forEach(id => setText(id));
  nodes.get('phonePocketSelect').value = opts.pocket || 'left_front_pocket';
  nodes.get('phonePlacementDetail').value = opts.placementNote || '';
  nodes.get('phoneCaptureOptIn').checked = opts.phoneOptIn !== false;
  nodes.get('profileCode').value = opts.profileCode || 'P-001';
  const sentMessages = [];
  const local = new Map();
  const localStorage = { getItem(k) { return local.has(k) ? local.get(k) : null; }, setItem(k,v) { local.set(k,String(v)); }, removeItem(k) { local.delete(k); } };
  let perfNow = 500;
  let wallNow = Date.now();
  class FakeDate extends Date { static now() { return wallNow; } }
  const doc = {
    getElementById(id) { return nodes.get(id) || null; },
    createElement(tag) { return { tagName: tag.toUpperCase(), style: {}, click() {}, remove() {}, set innerHTML(v) { this._html=v; }, get innerHTML(){return this._html||'';}, firstElementChild: {} }; },
    body: { appendChild(){}, removeChild(){} }
  };
  const coreState = { running:false, finalizationReady:true, finalizationInProgress:false, finalEvents:[], fc:[], finalStepCount:0 };
  let lastOpenedHtml = null;
  const coreApi = {
    __testCalls: { received: 0, started: 0, stopped: 0 },
    receiveShortsCsv() { this.__testCalls.received++; },
    start() { this.__testCalls.started++; coreState.running = true; coreState.finalizationReady = false; },
    stop() { this.__testCalls.stopped++; coreState.running = false; coreState.finalizationReady = true; },
    state() { return { ...coreState }; },
    openPreparedReport(html, filename, snapshot) { lastOpenedHtml = html; return true; },
    prepareReport() {
      const html = '<!doctype html><html><body><h1>Original VSPIMU report</h1></body></html>';
      this.openPreparedReport(html, 'VSPIMU_Report_Test', this.state());
      return { filename: 'VSPIMU_Report_Test', html };
    }
  };
  const win = {
    document: doc,
    localStorage,
    screen: { orientation: { type: 'landscape-primary' } },
    AppInventor: { setWebViewString(text) { try { sentMessages.push(JSON.parse(text)); } catch { sentMessages.push(text); } } },
    VSPIMU: coreApi,
    performance: { now: () => perfNow },
    setInterval(fn) { return { fn }; }, clearInterval() {},
    setTimeout(fn) { return { fn }; }, clearTimeout() {},
    console,
    URL: { createObjectURL() { return 'blob:mock'; }, revokeObjectURL() {} },
    Blob
  };
  const context = { window: win, document: doc, performance: win.performance, Date: FakeDate, Math, Number, String, Boolean, Array, Object, JSON, Map, Set, RegExp, Error, TypeError, parseInt, parseFloat, isFinite, console, Blob, URL: win.URL, setTimeout: win.setTimeout, clearTimeout: win.clearTimeout };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../assets/v6_phone_imu.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'v6_phone_imu.js', timeout: 5000 });
  return {
    api: win.VSPIMUPhoneIMU, coreApi, coreState, nodes, sentMessages, localStorage, local,
    getOpenedHtml: () => lastOpenedHtml,
    setClock(wall, perf) { wallNow = wall; perfNow = perf; },
    now() { return { wallNow, perfNow }; },
    advance(ms) { wallNow += ms; perfNow += ms; }
  };
}

function rawPacket(sequence) {
  const lo = sequence & 0xffff;
  const hi = (sequence >>> 16) & 0xffff;
  const phase = sequence / 208;
  const values = [lo, hi,
    Math.round(500 * Math.sin(phase * 6)),
    Math.round(400 * Math.cos(phase * 5)),
    8000 + Math.round(500 * Math.sin(phase * 3)),
    Math.round(1000 * Math.sin(phase * 6)),
    Math.round(900 * Math.cos(phase * 5)),
    Math.round(300 * Math.sin(phase * 4))];
  return values;
}
function rawCsvForRange(from, to) {
  const values = [];
  for (let i = from; i < to; i++) values.push(...rawPacket(i));
  return values.join(',');
}
function test(name, fn) {
  try { fn(); console.log(`PASS — ${name}`); return true; }
  catch (e) { console.error(`FAIL — ${name}\n${e.stack || e}`); return false; }
}

let failures = 0;
let totalTests = 0;
function run(name, fn) { totalTests++; if (!test(name, fn)) failures++; }

run('module installs and wraps existing VSPIMU methods without replacing core object', () => {
  const h = createHarness();
  assert.ok(h.api);
  assert.equal(h.coreApi.__phoneImuWrapped, true);
  assert.equal(typeof h.coreApi.receiveShortsCsv, 'function');
  assert.equal(typeof h.coreApi.start, 'function');
  assert.equal(typeof h.coreApi.stop, 'function');
});

run('opt-in start signals native components while opt-out preserves shank-only mode', () => {
  const h = createHarness();
  h.coreApi.start();
  assert.equal(h.api._test.state.phoneRequested, true);
  assert.equal(h.sentMessages.at(-1).type, 'phone_imu_control');
  assert.equal(h.sentMessages.at(-1).command, 'START');
  const off = createHarness({ phoneOptIn:false });
  off.coreApi.start();
  assert.equal(off.api._test.state.phoneRequested, false);
  assert.equal(off.sentMessages.at(-1).command, 'STOP');
});

run('raw BLE sample structure is captured without changing the existing receiver path', () => {
  const h = createHarness(); h.coreApi.start();
  h.setClock(h.now().wallNow + 100, h.now().perfNow + 100);
  h.coreApi.receiveShortsCsv(rawCsvForRange(0, 24));
  assert.equal(h.coreApi.__testCalls.received, 1);
  assert.equal(h.api._test.state.shank.length, 24);
  assert.equal(h.api._test.state.shank[23].seq, 23);
});

run('shank sequence discontinuities and malformed rows are detected, not silently re-aligned', () => {
  const h = createHarness(); h.coreApi.start();
  const malformed = rawPacket(1); malformed[4] = NaN;
  h.coreApi.receiveShortsCsv([...rawPacket(0), ...malformed, ...rawPacket(2)].join(','));
  const st = h.api._test.state;
  assert.equal(st.shank.length, 2);
  assert.equal(st.shankInvalidRows, 1);
  assert.equal(st.shankGapSlots, 1);
});

run('phone accelerometer and gyroscope batches preserve source timestamps and units', () => {
  const h = createHarness(); h.coreApi.start(); h.api.setNativeSensorStatus(true, true, true, true);
  const base = h.now().wallNow;
  const rows = [];
  for (let i = 0; i < 100; i++) {
    const t = base + i * 20; const rad = i / 10;
    rows.push(['acc', t, 0, Math.sin(rad), Math.cos(rad), 9.7]);
    rows.push(['gyro', t, 2_000_000_000 + i * 20_000_000, 3 * Math.sin(rad), 2 * Math.cos(rad), 0.2]);
  }
  const result = h.api.ingestBatch(rows);
  assert.equal(result.accepted, 200);
  assert.equal(h.api._test.state.phoneAcc.length, 100);
  assert.equal(h.api._test.state.phoneGyro.length, 100);
  assert.equal(h.api._test.state.phoneGyro[25].sensor_ts_ns, 2_500_000_000);
  assert.equal(h.api._test.state.phoneAcc[25].time_source, 'AI2_AccelerometerChanged_callback_wall_ms');
});

run('data-quality analysis flags irregular timestamps and reports a measured rate', () => {
  const h = createHarness();
  const rows = Array.from({ length: 100 }, (_, i) => ({ t: i === 50 ? i * 0.02 + 0.2 : i * 0.02 }));
  const q = h.api._test.analyzeTime(rows, r => r.t, { gapFactor: 3 });
  assert.ok(q.medianRateHz > 30 && q.medianRateHz < 60);
  assert.ok(q.gapSegments >= 1);
  assert.equal(q.quality, 'REVIEW');
});

run('bounded capture records truncation at configured sample cap', () => {
  const h = createHarness(); h.coreApi.start();
  const state = h.api._test.state;
  state.shank = Array.from({ length: 40000 }, (_, i) => ({ seq:i, seqUnwrapped:i, ax_raw:0, ay_raw:0, az_raw:0, gx_raw:0, gy_raw:0, gz_raw:0, arrival_perf_ms:500+i*1000/208 }));
  state.shankRawSequenceLast = 39999; state.shankUnwrappedLast = 39999;
  h.coreApi.receiveShortsCsv(rawCsvForRange(40000, 40012));
  assert.equal(state.shank.length, 40000);
  assert.equal(state.shankTruncated, true);
});

run('final session summary distinguishes observed values from unavailable cross-sensor timing', () => {
  const h = createHarness(); h.coreApi.start(); h.api.setNativeSensorStatus(true, true, true, true);
  const base = h.now().wallNow;
  for (let k = 0; k < 30; k++) {
    const t0 = base + k * 500;
    h.setClock(t0, 500 + k * 500);
    const chunk = [];
    for (let j = 0; j < 25; j++) {
      const i = k * 25 + j, t = t0 + j * 20, phase = i / 30;
      chunk.push(['acc', t, 0, Math.sin(phase), Math.cos(phase), 9.8 + 0.1*Math.sin(phase*4)]);
      chunk.push(['gyro', t, 3_000_000_000 + i*20_000_000, 5*Math.sin(phase*2), 3*Math.cos(phase), 0.3]);
    }
    h.api.ingestBatch(chunk);
  }
  for (let p = 0; p < 260; p++) {
    const t = p * 12 / 208;
    h.setClock(base + t*1000, 500 + t*1000 + 35);
    h.coreApi.receiveShortsCsv(rawCsvForRange(p*12, p*12+12));
  }
  h.setClock(base+16000, 16500); h.coreApi.stop(); h.api._test.finalizeSession();
  const s = h.api.getSummary();
  assert.ok(s.shank.sampleCount >= 3000);
  assert.ok(s.phoneAccelerometer.sampleCount >= 700);
  assert.ok(s.phoneGyroscope.sampleCount >= 700);
  assert.ok(['EXPLORATORY_MATCH','AMBIGUOUS','UNAVAILABLE'].includes(s.crossSensor.status));
  assert.ok(s.dataQuality.knownLimitations.some(x => x.includes('SensorEvent.timestamp')));
  assert.ok(s.shank.durationSec > 10 && s.shank.durationSec < 20);
});

run('baseline comparison requires five prior quality-eligible comparable sessions and remains descriptive', () => {
  const h = createHarness(); h.coreApi.start(); h.api.setNativeSensorStatus(true, true, true, true);
  const st = h.api._test.state;
  st.profileCode = 'P-TEST'; st.pocket = 'left_front_pocket';
  const summary = h.api._test.buildSummary();
  summary.baseline.eligible = true;
  const key = 'vspimu.dualimu.summaryHistory.v1';
  const metrics = { shankAccelCenteredRms_m_s2:1, shankGyroCenteredRms_deg_s:2, phoneAccelCenteredRms_m_s2:3, phoneGyroCenteredRms_deg_s:4 };
  h.localStorage.setItem(key, JSON.stringify(Array.from({length:5},(_,i)=>({sessionId:'prior'+i,profileCode:'P-TEST',phonePlacement:'left_front_pocket',protocol:'VSPIMU-123S',algorithmVersion:'VSPIMU-phone-shank-summary-0.3.0',qualityEligible:true,metrics}))));
  const b = h.api._test.compareBaseline(summary);
  assert.equal(b.comparablePriorSessions, 5);
  assert.match(b.note, /not a medical alert/i);
});

run('chunked export follows begin → acknowledged chunks → done handshake', () => {
  const h = createHarness(); h.coreApi.start(); h.api.setNativeSensorStatus(true, true, true, true);
  const st = h.api._test.state; st.active = false; st.finalized = true; st.stoppedPerfMs = st.startedPerfMs + 1000;
  h.coreState.running = false; h.coreState.finalizationReady = true;
  st.phoneAcc.push(...Array.from({length:20},(_,i)=>({t_wall_ms:Date.now()+i*20,t_session_s:i*.02,t_perf_ms:500+i*20,x_m_s2:i,y_m_s2:0,z_m_s2:9.8,receipt_perf_ms:500,time_source:'test',sensor_ts_ns:null,accuracy:null})));
  assert.equal(h.api.exportFile('summary'), true);
  let msg = h.sentMessages.at(-1); assert.equal(msg.type, 'phone_imu_export_begin');
  assert.equal(h.api.ackExportBegin(msg.exportId), true);
  msg = h.sentMessages.at(-1); assert.equal(msg.type, 'phone_imu_export_chunk');
  assert.equal(msg.index, 0);
  assert.equal(h.api.ackExportChunk(msg.exportId, 0), true);
  msg = h.sentMessages.at(-1); assert.equal(msg.type, 'phone_imu_export_done');
  assert.equal(h.api.ackExportComplete(msg.exportId, true, 'ok'), true);
});

run('alternate phone placements require a declared description and keep that metadata', () => {
  const missing = createHarness({ pocket: 'other_declared', placementNote: '' });
  missing.coreApi.start();
  assert.equal(missing.api._test.state.phoneRequested, false);
  const stated = createHarness({ pocket: 'other_declared', placementNote: 'fixed waist pouch' });
  stated.coreApi.start();
  assert.equal(stated.api._test.state.phoneRequested, true);
  assert.equal(stated.api._test.state.placementNote, 'fixed waist pouch');
  assert.equal(stated.sentMessages.at(-1).placementNote, 'fixed waist pouch');
});

run('lifecycle interruption marks phone streams for review and records an annotation', () => {
  const h = createHarness(); h.coreApi.start(); h.api.setNativeSensorStatus(true, true, true, true);
  const base = h.now().wallNow;
  const rows = [];
  for (let i = 0; i < 75; i++) {
    rows.push(['acc', base + i * 20, 0, 0.1 * Math.sin(i), 0.1 * Math.cos(i), 9.7]);
    rows.push(['gyro', base + i * 20, 5_000_000_000 + i * 20_000_000, Math.sin(i), Math.cos(i), 0.1]);
  }
  h.api.ingestBatch(rows);
  assert.equal(h.api.recordLifecycleEvent('screen_lost_focus'), true);
  const s = h.api._test.buildSummary();
  assert.equal(s.phoneLifecycle.interrupted, true);
  assert.equal(s.phoneAccelerometer.quality, 'REVIEW');
  assert.equal(s.phoneGyroscope.quality, 'REVIEW');
});

run('raw export remains available while the existing gait engine finalization is pending', () => {
  const h = createHarness(); h.coreApi.start();
  h.coreApi.receiveShortsCsv(rawCsvForRange(0, 240));
  h.coreApi.stop();
  h.coreState.finalizationReady = false;
  h.api._test.finalizeSession();
  assert.equal(h.api._test.state.finalSummary.coreAnalysis.finalizationReady, false);
  assert.equal(h.api.exportFile('shank'), true);
  let msg = h.sentMessages.at(-1); assert.equal(msg.type, 'phone_imu_export_begin');
  const exportId = msg.exportId;
  h.api.ackExportBegin(exportId);
  let acknowledged = 0;
  while ((msg = h.sentMessages.at(-1)).type === 'phone_imu_export_chunk') {
    assert.equal(msg.exportId, exportId);
    assert.equal(msg.index, acknowledged);
    assert.ok(msg.text.length > 0);
    acknowledged++;
    assert.ok(acknowledged <= 20, 'test export exceeded expected chunk bound');
    h.api.ackExportChunk(exportId, msg.index);
  }
  assert.ok(acknowledged >= 1);
  assert.equal(msg.type, 'phone_imu_export_done');
  assert.equal(msg.totalChunks, acknowledged);
  h.api.ackExportComplete(exportId, true, 'ok');
  h.coreState.finalizationReady = true;
  h.api._test.monitorCoreFinalization();
  assert.equal(h.api._test.state.coreSummaryRefreshed, true);
  assert.equal(h.api.getSummary().coreAnalysis.finalizationReady, true);
});

run('event CSV declares separate timestamp domains instead of pretending streams share zero', () => {
  const h = createHarness(); h.coreApi.start(); h.api.annotate('manual_pause');
  h.coreState.finalEvents = [{ t: 4.2, type: 'IC', p: 0.8, src: 'core test' }];
  const csv = h.api._test.eventsCsv();
  assert.match(csv, /time_base/);
  assert.match(csv, /WebView_monotonic_elapsed_since_phone_module_start/);
  assert.match(csv, /existing_VSPIMU_core_event_clock_origin_not_independently_mapped/);
});

run('raw and phone CSV exports retain documented units, sequence provenance, and native gyro timestamp', () => {
  const h = createHarness(); h.coreApi.start(); h.api.setNativeSensorStatus(true, true, true, true);
  h.coreApi.receiveShortsCsv(rawCsvForRange(0, 2));
  const shankLines = h.api._test.shankCsv().trim().split(/\r?\n/);
  assert.match(shankLines[0], /sequence_raw_u32/);
  assert.match(shankLines[0], /shank_relative_time_s_nominal_208Hz/);
  assert.match(shankLines[0], /receipt_perf_ms_not_acquisition_time/);
  const shankRow = shankLines[1].split(',');
  assert.equal(shankRow[1], '0');
  assert.equal(shankRow[4], String(rawPacket(0)[2]));
  const base = h.now().wallNow;
  h.api.ingestBatch([
    ['acc', base, 0, 1.25, -2.5, 9.8],
    ['gyro', base, 5_000_000_000, 12.5, -25, 0.5]
  ]);
  const accLines = h.api._test.phoneAccCsv().trim().split(/\r?\n/);
  const gyroLines = h.api._test.phoneGyroCsv().trim().split(/\r?\n/);
  assert.match(accLines[0], /ax_m_s2/);
  assert.match(accLines[0], /callback_wall_ms/);
  assert.match(gyroLines[0], /android_sensor_event_timestamp_ns_or_blank/);
  assert.equal(gyroLines[1].split(',')[3], '5000000000');
  assert.equal(accLines[1].split(',')[5], '1.25');
});

run('existing report handoff receives appended dual-IMU section and original content remains', () => {
  const h = createHarness(); h.coreApi.start();
  h.api.setNativeSensorStatus(false, false, false, false);
  h.coreState.running = false; h.coreState.finalizationReady = true;
  h.api._test.finalizeSession();
  const result = h.coreApi.prepareReport();
  assert.ok(h.getOpenedHtml().includes('id="vspimu-dual-imu-report"'));
  assert.ok(h.getOpenedHtml().includes('Original VSPIMU report'));
  assert.ok(result.html.includes('id="vspimu-dual-imu-report"'));
});


run('implausible phone sensor values are rejected and counted, never clipped into plausible data', () => {
  const h = createHarness(); h.coreApi.start(); h.api.setNativeSensorStatus(true, true, true, true);
  const base = h.now().wallNow;
  h.api.ingestBatch([
    ['acc', base, 0, 1000, 0, 9.8],
    ['gyro', base, 5_000_000_000, 0, 0, 0],
    ['gyro', base + 20, 5_020_000_000, 5001, 0, 0]
  ]);
  assert.equal(h.api._test.state.phoneAcc.length, 0);
  assert.equal(h.api._test.state.phoneGyro.length, 1);
  assert.equal(h.api._test.state.phoneAccOutOfRange, 1);
  assert.equal(h.api._test.state.phoneGyroOutOfRange, 1);
});

run('wall-clock discontinuity disables cross-sensor comparison rather than applying silent correction', () => {
  const h = createHarness(); h.coreApi.start(); h.api.setNativeSensorStatus(true, true, true, true);
  h.coreApi.receiveShortsCsv(rawCsvForRange(0, 240));
  const base = h.now();
  const rows = [];
  for (let i = 0; i < 100; i++) {
    rows.push(['acc', base.wallNow + i * 20, 0, Math.sin(i), Math.cos(i), 9.8]);
    rows.push(['gyro', base.wallNow + i * 20, 5_000_000_000 + i * 20_000_000, Math.sin(i), Math.cos(i), 0.1]);
  }
  h.api.ingestBatch(rows);
  h.setClock(base.wallNow + 2000, base.perfNow);
  h.api.ingestBatch([['acc', base.wallNow + 2020, 0, 0, 0, 9.8]]);
  const c = h.api._test.crossSensorSummary();
  assert.equal(h.api._test.state.wallClockDiscontinuities > 0, true);
  assert.equal(c.status, 'UNAVAILABLE');
  assert.equal(c.lagCorrectionSec, null);
});

run('partial sensor failure leaves shank-only capture and report available', () => {
  const h = createHarness({ phoneOptIn:false }); h.coreApi.start();
  h.coreApi.receiveShortsCsv(rawCsvForRange(0, 24));
  h.coreApi.stop(); h.api._test.finalizeSession();
  const s = h.api.getSummary();
  assert.equal(s.phoneAccelerometer.sampleCount, 0);
  assert.equal(s.phoneGyroscope.sampleCount, 0);
  assert.equal(s.shank.sampleCount, 24);
  assert.equal(s.phoneCaptureRequested, false);
});

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : 'TEST FAILURES'}: ${totalTests - failures}/${totalTests}`);
process.exitCode = failures ? 1 : 0;
