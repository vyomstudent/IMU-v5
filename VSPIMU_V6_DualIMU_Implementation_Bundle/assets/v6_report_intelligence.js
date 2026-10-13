/* VSPIMU Report Intelligence v1.0
 * Add after v5_report_viewer_V5_8_FINAL.js in VSPIMU_V5_8_FINAL.html.
 * Purpose: evidence ledger, report-quality gates, non-diagnostic interpretation,
 * and opt-in device-local longitudinal summaries. This does not change sensors,
 * BLE packets, model weights, event thresholds, or the underlying TCN inference.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) {
    root.VSPIMUReportIntelligence = api;
    api.install(root);
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const VERSION = '1.0.0';
  const HISTORY_KEY = 'vspimu_report_history_v1';
  const PROFILE_KEY = 'vspimu_report_profile_key_v1';
  const MAX_HISTORY = 60;
  const RAW_HZ = 208;
  const ACC_G_PER_LSB = 0.0001220703125;
  const GYRO_DPS_PER_LSB = 0.07;
  const ACC_CLIP_G = 3.8;
  const GYRO_CLIP_DPS = 1900;
  const EXPECTED_PROTOCOL_SEC = 123;
  const MODEL_TAG = 'VSPIMU_V5.8_single_shank_TCN';

  const num = (v) => (v !== null && v !== '' && Number.isFinite(Number(v))) ? Number(v) : NaN;
  const finite = Number.isFinite;
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmt = (v, d = 2, suffix = '') => finite(num(v)) ? `${num(v).toFixed(d)}${suffix}` : 'Not available';
  const pct = (v, d = 1) => finite(num(v)) ? `${num(v).toFixed(d)}%` : 'Not available';

  function freshTelemetry() {
    return {
      active: false, sampleCount: 0, malformedRows: 0, sequenceGapEvents: 0,
      missingSequenceSlots: 0, duplicateOrOutOfOrder: 0, firstSeq: null, lastSeq: null,
      clippedRows: 0, accelClippedRows: 0, gyroClippedRows: 0,
      clippedByAxis: [0, 0, 0, 0, 0, 0], maxAbsPhysical: [0, 0, 0, 0, 0, 0],
      sumPhysical: [0, 0, 0, 0, 0, 0], sumSqPhysical: [0, 0, 0, 0, 0, 0],
      lastPhysical: null, motionEvidenceRows: 0,
      sessionKey: '', startedAt: null, endedAt: null
    };
  }

  function parseShortRows(csv) {
    // The bridge is expected to provide a CSV row containing integer int16 values.
    // Quoted numeric cells are accepted defensively. No non-numeric field is inferred.
    const tokens = String(csv == null ? '' : csv).trim().split(',').map(x => {
      const t = x.trim().replace(/^['"]|['"]$/g, '');
      return t === '' ? NaN : Number(t);
    });
    return tokens;
  }

  function observeRawCsv(telemetry, csv) {
    const values = parseShortRows(csv);
    if (!values.length) return;
    const completeValues = Math.floor(values.length / 8) * 8;
    if (values.length % 8) telemetry.malformedRows += 1;
    for (let b = 0; b < completeValues; b += 8) {
      const fields = values.slice(b, b + 8);
      if (fields.some(v => !finite(v))) { telemetry.malformedRows += 1; continue; }
      const lo = Math.round(fields[0]) & 0xFFFF;
      const hi = Math.round(fields[1]) & 0xFFFF;
      const seq = (lo + hi * 65536) >>> 0;
      const previousSeq = telemetry.lastSeq;
      if (telemetry.firstSeq === null) telemetry.firstSeq = seq;
      if (telemetry.lastSeq !== null) {
        const expected = (telemetry.lastSeq + 1) >>> 0;
        if (seq !== expected) {
          const delta = (seq - expected) >>> 0;
          if (delta > 0 && delta < 0x80000000) {
            telemetry.sequenceGapEvents += 1;
            telemetry.missingSequenceSlots += delta;
          } else {
            telemetry.duplicateOrOutOfOrder += 1;
          }
        }
      }
      telemetry.lastSeq = seq;
      telemetry.sampleCount += 1;
      let anyClip = false, anyAccelClip = false, anyGyroClip = false;
      const physicalValues = new Array(6);
      for (let c = 0; c < 6; c++) {
        const raw = Math.round(fields[c + 2]);
        const physical = raw * (c < 3 ? ACC_G_PER_LSB : GYRO_DPS_PER_LSB);
        physicalValues[c] = physical;
        telemetry.sumPhysical[c] += physical;
        telemetry.sumSqPhysical[c] += physical * physical;
        telemetry.maxAbsPhysical[c] = Math.max(telemetry.maxAbsPhysical[c], Math.abs(physical));
        const clipped = c < 3 ? Math.abs(physical) >= ACC_CLIP_G : Math.abs(physical) >= GYRO_CLIP_DPS;
        if (clipped) {
          telemetry.clippedByAxis[c] += 1;
          anyClip = true;
          if (c < 3) anyAccelClip = true; else anyGyroClip = true;
        }
      }
      if (anyClip) telemetry.clippedRows += 1;
      if (anyAccelClip) telemetry.accelClippedRows += 1;
      if (anyGyroClip) telemetry.gyroClippedRows += 1;

      // Gross signal-liveness check: count adjacent, sequence-contiguous samples
      // with meaningful sensor-frame changes. This is not an activity classifier.
      if (previousSeq !== null && seq === ((previousSeq + 1) >>> 0) && telemetry.lastPhysical) {
        let accDeltaSq = 0, gyroDeltaSq = 0;
        for (let c = 0; c < 3; c++) {
          const delta = physicalValues[c] - telemetry.lastPhysical[c];
          accDeltaSq += delta * delta;
        }
        for (let c = 3; c < 6; c++) {
          const delta = physicalValues[c] - telemetry.lastPhysical[c];
          gyroDeltaSq += delta * delta;
        }
        if (Math.sqrt(gyroDeltaSq) >= 2.0 || Math.sqrt(accDeltaSq) >= 0.02) telemetry.motionEvidenceRows += 1;
      }
      telemetry.lastPhysical = physicalValues;
    }
  }

  function readLocalHistory(storage) {
    try {
      const raw = storage && storage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(x => x && x.schema === 1 && x.metrics && typeof x.savedAt === 'string').slice(-MAX_HISTORY);
    } catch (_) { return []; }
  }

  function normalizeProfileKey(value) {
    const key = String(value == null ? '' : value).trim();
    // Require an explicit pseudonymous prefix so common names are not accepted
    // accidentally as identifiers. Recommended pattern: P-001, P-OLDERADULT-01.
    return /^P[-_][A-Za-z0-9_-]{2,29}$/i.test(key) ? key.toUpperCase() : '';
  }

  function readLocalProfile(storage) {
    try { return normalizeProfileKey(storage && storage.getItem(PROFILE_KEY)); }
    catch (_) { return ''; }
  }

  function median(values) {
    const a = values.map(Number).filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return NaN;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function assess(snapshot, telemetry) {
    const s = snapshot || {};
    const screen = s.screening || {};
    const m = s.metrics || screen.metrics || {};
    const q = screen.quality || {};
    const p = s.protocol || {};
    const steps = s.steps || {};
    const parity = s.parity || {};
    const t = telemetry || freshTelemetry();
    const duration = num(screen.duration);
    const received = num(t.sampleCount);
    const span = (t.firstSeq !== null && t.lastSeq !== null) ? (((t.lastSeq - t.firstSeq) >>> 0) + 1) : NaN;
    const completeness = finite(span) && span > 0 ? Math.max(0, Math.min(1, received / span)) : NaN;
    const expectedSamples = finite(duration) && duration >= 0 ? Math.max(1, Math.round(duration * RAW_HZ)) : NaN;
    const sampleCoverage = finite(expectedSamples) ? Math.max(0, Math.min(1, received / expectedSamples)) : NaN;
    const motionEvidencePct = received > 1 && finite(num(t.motionEvidenceRows))
      ? 100 * Math.max(0, num(t.motionEvidenceRows)) / (received - 1) : NaN;
    const axisStats = Array.from({length: 6}, (_, c) => {
      const sum = num(t.sumPhysical && t.sumPhysical[c]);
      const sumSq = num(t.sumSqPhysical && t.sumSqPhysical[c]);
      if (!received || !finite(sum) || !finite(sumSq)) return {mean: NaN, std: NaN};
      const mean = sum / received;
      return {mean, std: Math.sqrt(Math.max(0, sumSq / received - mean * mean))};
    });
    const reasons = [];
    const notes = [];

    if (!received) reasons.push('No raw sensor samples were observed by the report-quality monitor.');
    if (received > 1 && !finite(motionEvidencePct)) reasons.push('Raw motion-signal plausibility could not be calculated from adjacent samples.');
    else if (received > 1 && motionEvidencePct < 1.0) reasons.push(`Only ${motionEvidencePct.toFixed(2)}% of adjacent sequence-contiguous samples exceeded the gross motion-change guard (gyro delta ≥2 °/s or acceleration delta ≥0.02 g). Verify sensor attachment and that the instructed walking actually occurred. This is an engineering signal-liveness check, not an activity or clinical classifier.`);
    if (num(t.malformedRows) > 0) reasons.push(`${t.malformedRows} malformed or partial raw BLE row(s) were observed.`);
    if (num(t.sequenceGapEvents) > 0) reasons.push(`${t.sequenceGapEvents} raw-sequence discontinuity event(s), ${t.missingSequenceSlots} missing sequence slot(s). This may reflect sensor read misses, packet loss, or both.`);
    if (num(t.duplicateOrOutOfOrder) > 0) reasons.push(`${t.duplicateOrOutOfOrder} duplicate/out-of-order sequence sample(s) were observed.`);
    if (num(t.clippedRows) > 0) reasons.push(`${t.clippedRows} sample row(s) reached the configured near-full-scale clipping guard (${ACC_CLIP_G} g or ${GYRO_CLIP_DPS} °/s).`);
    if (s.modelReady !== true) reasons.push('The phone-side model was not marked ready in the captured state.');
    if (s.warmupDone !== true) reasons.push('The walking-baseline normalization did not report completion.');
    if (steps.ready !== true) reasons.push('Full-session retrospective reconciliation was not marked complete.');
    if (p.complete !== true) reasons.push('The standardized 123-second protocol is incomplete or was not recorded as complete.');
    if (!finite(duration)) reasons.push('Session duration is unavailable; coverage relative to the planned recording cannot be checked.');
    else if (duration < EXPECTED_PROTOCOL_SEC * 0.90) reasons.push(`Recorded duration (${duration.toFixed(1)} s) is below 90% of the ${EXPECTED_PROTOCOL_SEC} s protocol.`);
    if (!finite(num(m.walkingExposureSec))) reasons.push('Classified walking exposure is unavailable; gait-rate interpretation cannot be quality-checked.');
    else if (num(m.walkingExposureSec) < 30) reasons.push('Less than 30 s of walking exposure was classified; cadence/variability conclusions are limited.');
    if (!finite(num(m.strideSampleCount))) reasons.push('The number of robust stride intervals is unavailable; stride variability cannot be quality-checked.');
    else if (num(m.strideSampleCount) < 8) reasons.push(`Only ${num(m.strideSampleCount)} robust stride interval(s) contributed to variability estimates; this is too few for stable personal characterization.`);
    const coreMetrics = [
      ['final step estimate', m.finalStepCount], ['cadence estimate', m.cadence],
      ['stride time', m.stride], ['stride-time variability (CV)', m.cv]
    ];
    for (const [label, value] of coreMetrics) {
      if (!finite(num(value))) reasons.push(`Core metric unavailable: ${label}.`);
    }
    const eventCadenceAvailable = finite(num(m.eventCadence)) && num(m.eventCadence) > 0;
    const spectralCadenceAvailable = finite(num(m.spectralCadence)) && num(m.spectralCadence) > 0;
    if (eventCadenceAvailable && spectralCadenceAvailable) {
      const disagreement = Math.abs(num(m.eventCadence) - num(m.spectralCadence)) / num(m.eventCadence);
      if (disagreement > 0.20) reasons.push(`Event-derived and spectral cadence disagree by ${(100 * disagreement).toFixed(1)}%; do not treat the fused cadence as independently confirmed.`);
    } else {
      reasons.push('Independent event-derived and spectral cadence cross-check is incomplete; fused cadence is not independently corroborated.');
    }
    if (parity.verdict === 'FAIL') reasons.push('ESP32↔phone computational parity failed. This is an implementation-consistency issue, not a ground-truth accuracy result.');
    else if (parity.verdict === 'WARN') reasons.push('ESP32↔phone parity returned WARN; inspect numeric discrepancies before using the device/phone results interchangeably. This limits implementation consistency, not a claim of biological accuracy.');
    if (parity.verdict === 'PASS') notes.push('ESP32↔phone parity PASS means the checked implementations agree within their defined contract; it does not establish clinical or ground-truth accuracy.');
    else if (parity.verdict !== 'FAIL' && parity.verdict !== 'WARN') notes.push('No final ESP32↔phone parity verdict was available. The current session may still be inspected as phone-side exploratory data, but implementation agreement was not established.');
    if (!finite(completeness)) reasons.push('Raw sequence-span coverage could not be calculated from the observed first/last sample sequence.');
    else if (completeness < 0.995) reasons.push(`Phone-observed raw rows cover ${(100 * completeness).toFixed(2)}% of the sequence span.`);
    if (!finite(sampleCoverage)) reasons.push('Nominal sample coverage cannot be calculated because session duration or sample count is unavailable.');
    else if (sampleCoverage < 0.90) reasons.push(`Only ${(100 * sampleCoverage).toFixed(1)}% of the nominal 208 Hz samples expected for this duration were observed; cadence and timing summaries may be biased.`);

    const fatal = !received || s.modelReady !== true || s.warmupDone !== true || steps.ready !== true;
    const limited = reasons.length > 0;
    const grade = fatal ? 'NOT READY / NOT INTERPRETABLE' : limited ? 'LIMITED — REVIEW DATA QUALITY' : 'ADEQUATE FOR EXPLORATORY IMU ANALYSIS';
    const gradeCode = fatal ? 'NOT_READY' : limited ? 'LIMITED' : 'EXPLORATORY';

    const observationLimits = [
      'This one shank-mounted IMU measures local segment acceleration and angular velocity. It does not measure cardiovascular strain, HRV, sleep, infection, dehydration, pain, medication exposure, or systemic fatigue.',
      'Millimetre-level foot clearance / foot-drop is not directly measured by this sensor configuration. It requires an independently validated kinematic method and calibration; numerical vertical displacement should not be inferred from raw acceleration alone.',
      'Knee and hip angles/range of motion are not directly observable from one shank sensor. A multi-segment setup and validated kinematic model are needed.',
      'A freeze-index-like spectral ratio or 4–12 Hz oscillation is a signal feature, not a diagnosis of freezing of gait, tremor disorder, neurological agitation, or circulatory pooling.',
      'A single session cannot establish prospective fall risk, causation, medication efficacy, or a multi-week decline, and must not issue a ‘high fall risk today’ or walking-aid instruction. These require repeated comparable recordings, clinical/outcome labels, and independent validation.'
    ];

    const eventCadence = num(m.eventCadence), spectralCadence = num(m.spectralCadence);
    const agreementPct = finite(eventCadence) && finite(spectralCadence) && eventCadence > 0
      ? 100 * Math.abs(eventCadence - spectralCadence) / eventCadence : NaN;
    return {
      version: VERSION, grade, gradeCode, reasons, notes, observationLimits,
      sampleCount: received, expectedSampleCount: expectedSamples, sampleCoverage, sequenceSpan: span, sequenceCompleteness: completeness,
      motionEvidenceRows: num(t.motionEvidenceRows) || 0, motionEvidencePct,
      axisStats,
      sequenceGapEvents: num(t.sequenceGapEvents) || 0, missingSequenceSlots: num(t.missingSequenceSlots) || 0,
      malformedRows: num(t.malformedRows) || 0, duplicateOrOutOfOrder: num(t.duplicateOrOutOfOrder) || 0,
      clippedRows: num(t.clippedRows) || 0, accelClippedRows: num(t.accelClippedRows) || 0,
      maxAbsPhysical: Array.isArray(t.maxAbsPhysical) ? t.maxAbsPhysical.slice(0, 6).map(v => num(v)) : [],
      gyroClippedRows: num(t.gyroClippedRows) || 0, durationSec: duration,
      robustStrideIntervals: num(m.strideSampleCount), walkingExposureSec: num(m.walkingExposureSec),
      eventCadenceSpm: eventCadence, spectralCadenceSpm: spectralCadence, cadenceDisagreementPct: agreementPct,
      modelReady: s.modelReady === true, warmupDone: s.warmupDone === true,
      retrospectiveReady: steps.ready === true, protocolComplete: p.complete === true,
      parityVerdict: parity.verdict || 'NOT AVAILABLE', dataAdequateClaim: screen.dataAdequate === true,
      modelTag: MODEL_TAG
    };
  }

  function recordForHistory(snapshot, diagnostics, now, profileCode) {
    const s = snapshot || {}, screen = s.screening || {}, m = s.metrics || screen.metrics || {};
    const d = diagnostics || {};
    return {
      schema: 1, savedAt: (now instanceof Date ? now : new Date()).toISOString(),
      modelTag: MODEL_TAG, protocolSec: EXPECTED_PROTOCOL_SEC, gradeCode: d.gradeCode || 'LIMITED',
      profileKey: normalizeProfileKey(profileCode),
      metrics: {
        cadenceSpm: num(m.cadence), strideSec: num(m.stride), strideCvPct: num(m.cv),
        stancePct: num(m.stancePct), swingPct: num(m.swingPct), stepCount: num(m.finalStepCount),
        walkingExposureSec: num(m.walkingExposureSec), strideIntervals: num(m.strideSampleCount),
        icCount: num(m.icCount), fcCount: num(m.fcCount)
      },
      quality: {
        sampleCount: num(d.sampleCount), sequenceGapEvents: num(d.sequenceGapEvents),
        missingSequenceSlots: num(d.missingSequenceSlots), clippedRows: num(d.clippedRows),
        protocolComplete: d.protocolComplete === true
      }
      // Intentionally no patient name, age, sex, notes, raw samples, or free text.
    };
  }

  function historyComparison(snapshot, diagnostics, history, profileCode) {
    const s = snapshot || {}, screen = s.screening || {}, m = s.metrics || screen.metrics || {};
    const d = diagnostics || {};
    const profileKey = normalizeProfileKey(profileCode);
    const eligible = (history || []).filter(r => r && r.schema === 1 && r.profileKey === profileKey && profileKey && r.modelTag === MODEL_TAG &&
      r.protocolSec === EXPECTED_PROTOCOL_SEC && r.gradeCode === 'EXPLORATORY' &&
      r.quality && r.quality.sequenceGapEvents === 0 && r.quality.clippedRows === 0 &&
      r.quality.protocolComplete === true && r.metrics);
    const recent = eligible.slice(-8);
    const current = {
      cadenceSpm: num(m.cadence), strideSec: num(m.stride), strideCvPct: num(m.cv),
      stancePct: num(m.stancePct), swingPct: num(m.swingPct), stepCount: num(m.finalStepCount)
    };
    const rows = [
      ['Cadence', 'cadenceSpm', 'steps/min', 1],
      ['Stride time', 'strideSec', 's', 3],
      ['Stride-time variability (CV)', 'strideCvPct', '%', 1],
      ['Stance fraction', 'stancePct', '%', 1],
      ['Swing fraction', 'swingPct', '%', 1]
    ];
    return {
      count: recent.length,
      rows: rows.map(([label, key, unit, digits]) => {
        const base = median(recent.map(r => num(r.metrics && r.metrics[key])).filter(finite));
        const value = current[key];
        const delta = finite(base) && finite(value) ? value - base : NaN;
        const relativePct = finite(base) && Math.abs(base) > 1e-9 && finite(delta) ? 100 * delta / Math.abs(base) : NaN;
        return { label, key, unit, digits, baseline: base, current: value, delta, relativePct };
      }),
      eligibleBaselineSessions: recent.length, profileCode: profileKey,
      ready: !!profileKey && recent.length >= 3 && d.gradeCode === 'EXPLORATORY' && current.cadenceSpm > 0
    };
  }

  function historyHtml(comp) {
    if (!comp || !comp.profileCode) return `<p class="small">Enter a stable pseudonymous profile code above (for example, P-001). Do not use the patient's name, phone number, email, or other identifying details. Trend history is isolated by this code.</p>`;
    if (comp.count === 0) return `<p class="small">No saved comparable sessions are available for profile ${esc(comp.profileCode)} on this device. Save eligible recordings using the same profile code; at least three prior comparable sessions are required before a baseline is displayed.</p>`;
    if (!comp.ready) return `<p class="small">${comp.count} comparable prior session(s) found. A descriptive within-person baseline requires at least three eligible prior sessions and a current session passing the exploratory-quality gates.</p>`;
    const rows = comp.rows.map(r => `<tr><td>${esc(r.label)}</td><td>${esc(fmt(r.baseline, r.digits, r.unit === 'steps/min' ? ' steps/min' : ` ${r.unit}`))}</td><td>${esc(fmt(r.current, r.digits, r.unit === 'steps/min' ? ' steps/min' : ` ${r.unit}`))}</td><td>${finite(r.delta) ? `${r.delta > 0 ? '+' : ''}${r.delta.toFixed(r.digits)} ${r.unit}` : 'Not available'}</td><td>${finite(r.relativePct) ? `${r.relativePct > 0 ? '+' : ''}${r.relativePct.toFixed(1)}%` : 'Not available'}</td></tr>`).join('');
    return `<p>Descriptive baseline: median of the last ${comp.count} eligible saved sessions recorded with the same VSPIMU model/protocol tag. These are within-person comparisons, not validated abnormality thresholds.</p><table><thead><tr><th>Measure</th><th>Prior baseline</th><th>Current</th><th>Difference</th><th>Relative change</th></tr></thead><tbody>${rows}</tbody></table><p class="small">Do not interpret a change alone as a fall warning or cause. Check walking speed/instructions, footwear, surface, sensor placement, medication/activity context, symptoms, and repeatability. Trends become clinically meaningful only after outcome-based validation.</p>`;
  }

  function buildLedgerHtml(d, comp, storageAvailable, profileCode) {
    const statusRows = [
      ['Raw rows observed / nominal expected', `${d.sampleCount} / ${finite(d.expectedSampleCount) ? d.expectedSampleCount : 'unknown'} (${finite(d.sampleCoverage) ? pct(d.sampleCoverage * 100, 1) : 'coverage unavailable'})`, 'Compared with nominal 208 Hz sampling over the reported duration; gaps can be due to sensor reads and/or transport.'],
      ['Sequence continuity', `${d.sequenceGapEvents} discontinuities; ${d.missingSequenceSlots} missing slots`, 'A discontinuity alone does not distinguish an IMU read failure from radio/bridge loss.'],
      ['Malformed / duplicate rows', `${d.malformedRows} / ${d.duplicateOrOutOfOrder}`, 'These should be zero for a clean session.'],
      ['Near-full-scale samples', `${d.clippedRows} rows (${d.accelClippedRows} accel / ${d.gyroClippedRows} gyro)`, 'Rows at or above 3.8 g or 1900 °/s are flagged as clipping risk, not sensor-confirmed hard clipping.'],
      ['Peak absolute acceleration', d.maxAbsPhysical.length >= 3 ? `Ax ${fmt(d.maxAbsPhysical[0], 3, ' g')} / Ay ${fmt(d.maxAbsPhysical[1], 3, ' g')} / Az ${fmt(d.maxAbsPhysical[2], 3, ' g')}` : 'Not available', 'Recorded physical-unit extrema computed from received raw integer samples; this is not calibrated earth-frame acceleration.'],
      ['Peak absolute angular velocity', d.maxAbsPhysical.length >= 6 ? `Gx ${fmt(d.maxAbsPhysical[3], 1, ' °/s')} / Gy ${fmt(d.maxAbsPhysical[4], 1, ' °/s')} / Gz ${fmt(d.maxAbsPhysical[5], 1, ' °/s')}` : 'Not available', 'Recorded physical-unit extrema computed from received raw integer samples.'],
      ['Sensor-axis mean ± SD', d.axisStats && d.axisStats.length >= 6 ? `A: X ${fmt(d.axisStats[0].mean, 3)} ± ${fmt(d.axisStats[0].std, 3)} g; Y ${fmt(d.axisStats[1].mean, 3)} ± ${fmt(d.axisStats[1].std, 3)} g; Z ${fmt(d.axisStats[2].mean, 3)} ± ${fmt(d.axisStats[2].std, 3)} g. G: X ${fmt(d.axisStats[3].mean, 1)} ± ${fmt(d.axisStats[3].std, 1)} °/s; Y ${fmt(d.axisStats[4].mean, 1)} ± ${fmt(d.axisStats[4].std, 1)} °/s; Z ${fmt(d.axisStats[5].mean, 1)} ± ${fmt(d.axisStats[5].std, 1)} °/s.` : 'Not available', 'Descriptive sensor-frame statistics. Acceleration includes gravity; these values depend on sensor placement/orientation and are not earth-frame kinematics.'],
      ['Gross motion-signal plausibility', finite(d.motionEvidencePct) ? `${d.motionEvidenceRows} adjacent sample(s) (${d.motionEvidencePct.toFixed(2)}%) exceeded the change guard` : 'Not available', 'Guard: gyro-vector change ≥2 °/s or acceleration-vector change ≥0.02 g between contiguous raw samples. It detects gross flat/stale streams only; it is not a validated activity classifier.'],
      ['Standardized protocol', d.protocolComplete ? 'Recorded complete' : 'Incomplete / unknown', 'A phase timer ending does not prove the participant followed the instruction.'],
      ['Model / normalization', `${d.modelReady ? 'model ready' : 'model not ready'} / ${d.warmupDone ? 'baseline complete' : 'baseline incomplete'}`, 'Availability is not a guarantee that outputs are calibrated or accurate.'],
      ['Retrospective processing', d.retrospectiveReady ? 'complete' : 'not complete', 'Final event and metric reconciliation reported by the app.'],
      ['Robust stride intervals', finite(d.robustStrideIntervals) ? String(d.robustStrideIntervals) : 'Not available', 'A small number of intervals makes variability statistics unstable.'],
      ['Walking exposure', finite(d.walkingExposureSec) ? `${d.walkingExposureSec.toFixed(1)} s` : 'Not available', 'Activity state is heuristic; protocol phases and actual behavior can differ.'],
      ['Event vs spectral cadence', finite(d.eventCadenceSpm) && finite(d.spectralCadenceSpm) ? `${d.eventCadenceSpm.toFixed(1)} vs ${d.spectralCadenceSpm.toFixed(1)} steps/min (${d.cadenceDisagreementPct.toFixed(1)}% difference)` : 'Both estimates not available', 'Agreement is an internal plausibility check, not independent validation.'],
      ['ESP32 ↔ phone parity', esc(d.parityVerdict), 'Computational agreement does not measure error against Vicon or force plates.'],
      ['Data sequence span coverage', finite(d.sequenceCompleteness) ? pct(d.sequenceCompleteness * 100, 2) : 'Not available', 'Derived from raw sequence slots observed by this monitor.']
    ];
    const table = statusRows.map(r => `<tr><td>${esc(r[0])}</td><td><b>${esc(r[1])}</b><div class="small">${esc(r[2])}</div></td></tr>`).join('');
    const reasons = d.reasons.length ? `<ul>${d.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>No configured technical-quality warning was triggered by the fields available to this report monitor. That is not proof of clinical validity.</p>';
    const notes = d.notes.length ? `<ul>${d.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
    const limits = d.observationLimits.map(x => `<li>${esc(x)}</li>`).join('');
    const saveText = storageAvailable ? 'Save anonymized summary on this device' : 'Local summary storage unavailable';
    const saveDisabled = storageAvailable ? '' : 'disabled';
    return `<section id="vspimuEvidenceLedger" class="summary" style="margin:12px 0;background:#f8fafc;border-color:#94a3b8;color:#172033">
      <h2 style="margin-top:0">Evidence ledger & measurement reliability</h2>
      <p><b>${esc(d.grade)}</b></p>
      <p class="small"><b>Meaning:</b> this grade describes completeness and internal consistency only. It is not a probability, diagnostic confidence, fall-risk category, or claim of clinical accuracy. The 1% raw motion-change guard is a basic engineering sanity check, not a calibrated activity or clinical threshold. All numerical thresholds and activity/spectral heuristics remain exploratory until externally validated.</p>
      <table><thead><tr><th>Evidence item</th><th>Observed result and interpretation</th></tr></thead><tbody>${table}</tbody></table>
      <h3>Quality limitations / reasons for caution</h3>${reasons}${notes}
      <h3>What the current shank IMU can support</h3>
      <table><thead><tr><th>Observation</th><th>Evidence status</th><th>Interpretation allowed</th></tr></thead><tbody>
      <tr><td>IC/FC event timing, stride intervals and cadence</td><td>Model/signal-derived</td><td>Report numerical values and interval counts; accuracy remains pending independent event labels.</td></tr>
      <tr><td>Stride-time variation</td><td>Descriptive statistic</td><td>Interpret only when enough valid intervals contribute; one short segment is not a reliable person-level baseline.</td></tr>
      <tr><td>Shank movement intensity and frequency components</td><td>Sensor-observed features</td><td>Describe amplitude and spectral content. Do not assign a cause such as tremor disorder, pain, agitation or freezing.</td></tr>
      <tr><td>Walking / stillness / transition and protocol adherence</td><td>Heuristic / instructed task</td><td>Use as context with uncertainty; do not equate a scheduled phase with verified human behavior.</td></tr>
      <tr><td>Change over days or weeks</td><td>Available after comparable sessions</td><td>Show within-person differences only after adequate history; thresholds for clinically meaningful change remain unvalidated.</td></tr>
      </tbody></table>
      <h3>What this configuration cannot establish</h3><ul>${limits}</ul>
      <h3>Within-person trend (optional, device-local)</h3><p class="small">Trend history is opt-in. Enter a stable pseudonymous profile code (for example, P-001) to prevent different people's recordings being mixed. Do not use a patient's name, phone number, email, or other directly identifying value. Only this code plus derived gait summary values and measurement-quality metadata are stored; no demographics, free-text notes, or raw IMU samples are saved. History remains in this WebView's local storage until cleared or app data is removed; persistence depends on WebView settings.</p>
      <label for="vspimuProfileCode" class="small"><b>Local profile code</b></label><input id="vspimuProfileCode" type="text" maxlength="32" autocomplete="off" spellcheck="false" placeholder="e.g. P-001 (pseudonymous study code)" value="${esc(profileCode || '')}" style="display:block;max-width:260px;width:100%;margin:5px 0 10px;padding:7px;border:1px solid #94a3b8;border-radius:5px">
      <div id="vspimuHistorySummary">${historyHtml(comp)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button type="button" data-vspimu-history-save ${saveDisabled}>${saveText}</button><button type="button" data-vspimu-history-clear ${saveDisabled}>Clear local trend history</button><span id="vspimuHistoryMessage" class="small" aria-live="polite"></span></div>
      <p class="small">Algorithm tag: ${MODEL_TAG}; report-intelligence module ${VERSION}. For Vicon / force-plate validation, evaluate event precision/recall/F1, false events per minute, signed timing bias, median absolute timing error, step-count error and cadence error on subject-independent held-out sessions.</p>
    </section>`;
  }

  function enhanceReportHtml(html, snapshot, diagnostics, comp, storageAvailable, profileCode, win) {
    if (!win || !win.DOMParser || !win.document) return html;
    const doc = new win.DOMParser().parseFromString(String(html || ''), 'text/html');
    if (doc.getElementById('vspimuEvidenceLedger')) return '<!doctype html>\n' + doc.documentElement.outerHTML;

    // Remove the apparent clinical risk verdict. The legacy thresholds have not
    // been validated as a classifier and must not imply a diagnosis or risk score.
    const oldSummary = doc.querySelector('.summary');
    if (oldSummary) {
      oldSummary.className = 'summary';
      const lead = oldSummary.querySelector('.muted');
      const verdict = oldSummary.querySelector('b');
      if (lead) lead.textContent = 'IMU-derived observation summary — not a clinical risk score';
      if (verdict) verdict.textContent = diagnostics.grade;
      const detail = oldSummary.querySelector('div[style*="margin-top"]');
      if (detail) detail.textContent = 'Interpret objective measurements with signal quality, task adherence, personal baseline and clinical context. Fixed heuristic flags are exploratory and are not validated disease or fall-risk classifications.';
    }

    const replaceLabel = (from, to) => {
      for (const el of Array.from(doc.querySelectorAll('.muted, h2, h3, th, td'))) {
        if (el.children.length === 0 && el.textContent.trim() === from) el.textContent = to;
      }
    };
    replaceLabel('Parkinsonism-pattern screen', 'Gait-feature heuristic (not a disease screen)');
    replaceLabel('Freezing-of-gait screen', 'Freeze-index-like spectral feature (research only)');
    replaceLabel('Tremor screen', '4–12 Hz angular-velocity oscillation feature');
    replaceLabel('TCN confidence', 'TCN output score (not calibrated; shown on % scale)');
    replaceLabel('Event confidence', 'Event-model score (not calibrated; shown on % scale)');
    replaceLabel('TCN validator coverage', 'TCN corroboration coverage');
    replaceLabel('TCN-validated anchors', 'TCN-corroborated anchors');
    replaceLabel('Features contributing to the gait-pattern screen', 'Features crossing current exploratory thresholds (not validated as disease classifiers)');

    // Explain legacy unvalidated classifications where they appear in text.
    for (const el of Array.from(doc.querySelectorAll('p, div, span, b, strong'))) {
      if (el.children.length > 0) continue;
      const txt = el.textContent || '';
      if (txt.includes('MULTIPLE GAIT-PATTERN FLAGS')) {
        el.textContent = 'Multiple exploratory gait-feature thresholds crossed (not a disease classification).';
      }
      if (txt.includes('ONE GAIT-PATTERN FLAG')) {
        el.textContent = 'One exploratory gait-feature threshold crossed (not a disease classification).';
      }
      if (txt.includes('NO STRONG COMPOSITE FLAG')) {
        el.textContent = 'No combination of current exploratory feature thresholds crossed; this does not establish normal gait.';
      }
      if (txt.includes('BELOW REFERENCE')) {
        el.textContent = 'Below a published cadence context band; not a diagnostic threshold.';
      }
      if (txt.includes('ABOVE REFERENCE')) {
        el.textContent = 'Above a published cadence context band; not a diagnostic threshold.';
      }
      if (txt.includes('WITHIN REFERENCE')) {
        el.textContent = 'Within a published cadence context band; this does not establish normal gait.';
      }
      if (txt.trim() === 'WITHIN META-ANALYSIS WINDOW') {
        el.textContent = 'Within a published comparison window; not a validated normality threshold.';
      }
      if (txt.trim() === 'HIGH') {
        el.textContent = 'Above the current exploratory comparison bound; not a diagnosis.';
      }
      if (txt.trim() === 'LOW') {
        el.textContent = 'Below the current exploratory comparison bound; not evidence of disease or health.';
      }
      if (txt.includes('POSSIBLE FREEZE-LIKE SPECTRAL EPISODES')) {
        el.textContent = 'Freeze-index-like spectral threshold crossed in this recording (research feature; not a freezing-of-gait determination).';
      }
      if (txt.includes('NO PERSISTENT FREEZE-LIKE SPECTRAL EPISODES FLAGGED')) {
        el.textContent = 'No freeze-index-like spectral threshold crossing was registered in this recording; this does not exclude freezing of gait.';
      }
      if (txt.includes('OSCILLATION IN 4–12 Hz BAND OBSERVED')) {
        el.textContent = 'A 4–12 Hz angular-velocity spectral component was observed; its source and clinical significance are undetermined.';
      }
      if (txt.includes('NO PROMINENT 4–12 Hz GYRO OSCILLATION CLASSIFIED')) {
        el.textContent = 'No prominent 4–12 Hz angular-velocity component was classified by the current heuristic; this does not exclude tremor.';
      }
    }

    const qualityParagraphs = Array.from(doc.querySelectorAll('p')).filter(el => /BLE packet gaps|recent-window saturation samples/i.test(el.textContent || ''));
    for (const p of qualityParagraphs) {
      p.textContent = `Session-wide raw-stream monitor: ${diagnostics.sequenceGapEvents} sequence discontinuity event(s), ${diagnostics.missingSequenceSlots} missing sequence slot(s), ${diagnostics.clippedRows} near-full-scale sample row(s), ${diagnostics.malformedRows} malformed row(s). See Evidence ledger for limitations.`;
    }

    const firstH2 = doc.querySelector('h2');
    if (firstH2) {
      const wrapper = doc.createElement('div');
      wrapper.innerHTML = buildLedgerHtml(diagnostics, comp, storageAvailable, profileCode);
      firstH2.parentNode.insertBefore(wrapper.firstElementChild, firstH2);
    } else {
      const wrapper = doc.createElement('div'); wrapper.innerHTML = buildLedgerHtml(diagnostics, comp, storageAvailable, profileCode);
      doc.body.appendChild(wrapper.firstElementChild);
    }
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  }

  function neutralizeRenderedLabels(win) {
    if (!win || !win.document || !win.document.createTreeWalker) return;
    const roots = [
      win.document.getElementById('vspimu58ReportContent'),
      win.document.getElementById('vspimu58CoreReportDoc')
    ].filter(Boolean);
    const replacements = [
      [/V5\.8 step-count validation summary/gi, 'Step-count reconciliation evidence (not ground-truth validation)'],
      [/TCN-validated events/gi, 'TCN-corroborated events'],
      [/TCN-validated anchors/gi, 'TCN-corroborated anchors'],
      [/TCN validator coverage/gi, 'TCN corroboration coverage'],
      [/TCN validation coverage/gi, 'TCN corroboration coverage'],
      [/validated event confidence/gi, 'uncalibrated event-model score (shown on % scale)'],
      [/validated IC-event cadence/gi, 'accepted IC-event cadence'],
      [/validated IC cadence \+ spectral cross-check/gi, 'accepted IC-event cadence + spectral consistency check']
    ];
    for (const root of roots) {
      const walker = win.document.createTreeWalker(root, win.NodeFilter ? win.NodeFilter.SHOW_TEXT : 4);
      let node;
      while ((node = walker.nextNode())) {
        let value = node.nodeValue;
        for (const [pattern, replacement] of replacements) value = value.replace(pattern, replacement);
        if (value !== node.nodeValue) node.nodeValue = value;
      }
    }
  }

  function install(win) {
    if (!win || !win.VSPIMU || win.VSPIMU.__reportIntelligenceInstalled) return false;
    const api = win.VSPIMU;
    if (typeof api.state !== 'function' || typeof api.receiveShortsCsv !== 'function') return false;
    const originalState = api.state.bind(api);
    const originalReceive = api.receiveShortsCsv.bind(api);
    const originalStart = typeof api.start === 'function' ? api.start.bind(api) : null;
    const originalStop = typeof api.stop === 'function' ? api.stop.bind(api) : null;
    const originalReset = typeof api.reset === 'function' ? api.reset.bind(api) : null;
    const originalPrepare = typeof api.prepareReport === 'function' ? api.prepareReport.bind(api) : null;
    const originalOpen = typeof api.openPreparedReport === 'function' ? api.openPreparedReport.bind(api) : null;
    let telemetry = freshTelemetry();
    let lastSnapshot = null;
    let lastDiagnostics = null;

    const storage = (() => { try { const x = win.localStorage; const k = '__vspimu_report_test__'; x.setItem(k, '1'); x.removeItem(k); return x; } catch (_) { return null; } })();
    const storageAvailable = !!storage;

    api.receiveShortsCsv = function (csv) {
      if (telemetry.active) observeRawCsv(telemetry, csv);
      return originalReceive(csv);
    };
    if (originalStart) api.start = function () {
      telemetry = freshTelemetry();
      telemetry.active = true;
      telemetry.startedAt = new Date().toISOString();
      telemetry.sessionKey = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      return originalStart();
    };
    if (originalStop) api.stop = function () {
      // Keep observing during the app's STOP raw-tail capture period.
      telemetry.endedAt = new Date().toISOString();
      return originalStop();
    };
    if (originalReset) api.reset = function () {
      telemetry.active = false;
      return originalReset();
    };

    api.state = function () {
      const s = originalState();
      const diagnostics = assess(s, telemetry);
      lastSnapshot = s;
      lastDiagnostics = diagnostics;
      return Object.assign({}, s, { reportIntelligence: Object.assign({}, diagnostics, { telemetry: JSON.parse(JSON.stringify(telemetry)) }) });
    };

    if (originalPrepare) api.prepareReport = function () {
      telemetry.active = false;
      return originalPrepare();
    };

    if (originalOpen) api.openPreparedReport = function (html, filename, snapshot) {
      try {
        const snap = snapshot || api.state();
        const diag = assess(snap, (snap.reportIntelligence && snap.reportIntelligence.telemetry) || telemetry);
        const history = storage ? readLocalHistory(storage) : [];
        const profileCode = storage ? readLocalProfile(storage) : '';
        const comp = historyComparison(snap, diag, history, profileCode);
        const enhanced = enhanceReportHtml(html, snap, diag, comp, storageAvailable, profileCode, win);
        lastSnapshot = snap;
        lastDiagnostics = diag;
        const opened = originalOpen(enhanced, filename, snap);
        // The legacy viewer adds a step-count summary after receiving this HTML.
        // Rewrite its ambiguous use of “validation” only after it has rendered.
        neutralizeRenderedLabels(win);
        return opened;
      } catch (e) {
        if (win.console && win.console.error) win.console.error('VSPIMU report intelligence enhancement failed', e);
        return originalOpen(html, filename, snapshot);
      }
    };

    function reportSnapshot() {
      if (lastSnapshot) return lastSnapshot;
      return api.state();
    }
    win.document.addEventListener('change', function (event) {
      const target = event.target;
      if (!target || target.id !== 'vspimuProfileCode') return;
      const code = normalizeProfileKey(target.value);
      const message = win.document.getElementById('vspimuHistoryMessage');
      if (!storage) { if (message) message.textContent = 'Local storage is unavailable in this WebView.'; return; }
      if (!code) {
        if (message) message.textContent = 'Use a pseudonymous code such as P-001 (starts with P- or P_; do not enter a name or contact details).';
        return;
      }
      try {
        storage.setItem(PROFILE_KEY, code);
        const history = readLocalHistory(storage);
        const snap = reportSnapshot();
        const diag = lastDiagnostics || assess(snap, telemetry);
        const comp = historyComparison(snap, diag, history, code);
        const section = win.document.getElementById('vspimuHistorySummary');
        if (section) section.innerHTML = historyHtml(comp);
        if (message) message.textContent = `Trend profile set to ${code}. Only records saved under this code will be compared.`;
      } catch (e) {
        if (message) message.textContent = `Could not select profile: ${e && e.message ? e.message : String(e)}`;
      }
    });

    win.document.addEventListener('click', function (event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-vspimu-history-save], [data-vspimu-history-clear]') : null;
      if (!target) return;
      const message = win.document.getElementById('vspimuHistoryMessage');
      if (!storage) { if (message) message.textContent = 'Local storage is unavailable in this WebView.'; return; }
      try {
        if (target.hasAttribute('data-vspimu-history-save')) {
          const snap = reportSnapshot();
          const diag = lastDiagnostics || assess(snap, telemetry);
          if (diag.gradeCode !== 'EXPLORATORY') {
            if (message) message.textContent = 'Not saved: this session did not pass the exploratory quality gates.';
            return;
          }
          const input = win.document.getElementById('vspimuProfileCode');
          const profileKey = normalizeProfileKey(input && input.value);
          if (!profileKey) {
            if (message) message.textContent = 'Not saved: enter a pseudonymous code such as P-001 (starts with P- or P_). Do not use the patient’s name or contact details.';
            return;
          }
          storage.setItem(PROFILE_KEY, profileKey);
          const history = readLocalHistory(storage);
          const rec = recordForHistory(snap, diag, new Date(), profileKey);
          // Avoid repeated taps creating duplicated records for the same report.
          const fingerprint = [rec.savedAt.slice(0, 16), rec.metrics.cadenceSpm, rec.metrics.strideSec, rec.quality.sampleCount].join('|');
          if (!history.some(x => x.fingerprint === fingerprint)) {
            rec.fingerprint = fingerprint;
            history.push(rec);
            storage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-MAX_HISTORY)));
          }
          target.textContent = 'Summary saved on this device';
          if (message) message.textContent = 'Only derived gait metrics and quality metadata were saved; no patient identifiers or raw data.';
        } else {
          if (typeof win.confirm === 'function' && !win.confirm('Clear all VSPIMU locally saved gait summary history from this WebView?')) return;
          storage.removeItem(HISTORY_KEY);
          storage.removeItem(PROFILE_KEY);
          const input = win.document.getElementById('vspimuProfileCode');
          if (input) input.value = '';
          const section = win.document.getElementById('vspimuHistorySummary');
          if (section) section.textContent = 'Local trend history and profile selection cleared.';
          if (message) message.textContent = 'Local trend history and profile selection cleared.';
        }
      } catch (e) {
        if (message) message.textContent = `Action failed: ${e && e.message ? e.message : String(e)}`;
      }
    });

    api.__reportIntelligenceInstalled = true;
    api.reportIntelligence = {
      version: VERSION,
      diagnostics: () => lastDiagnostics ? JSON.parse(JSON.stringify(lastDiagnostics)) : assess(api.state(), telemetry),
      telemetry: () => JSON.parse(JSON.stringify(telemetry)),
      assess,
      historyComparison
    };
    return true;
  }

  return {
    VERSION, HISTORY_KEY, PROFILE_KEY, MAX_HISTORY, assess, observeRawCsv, freshTelemetry, normalizeProfileKey,
    historyComparison, recordForHistory, parseShortRows, install, buildLedgerHtml, neutralizeRenderedLabels
  };
});
