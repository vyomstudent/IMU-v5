# Kotlin / WebView integration of preserved signal assets

This is a recovery and integration plan, not a claim that the V6.1.3 pipeline has been recovered. Follow lead-owned CONTRACTS.md. Implement acquisition, explicit quality and raw export first; make legacy gait inference an optional, separately verified module. Do not edit AI2, firmware or original reference files.

## BLE boundary (must preserve)

Source: `VSPIMU_V6_DualIMU_Implementation_Bundle/firmware/VSPIMU_V6_ESP32C3_RAW_ONLY.ino:16–31,46–75,247–291,483–489`.

- Device `GAIT-V5-C3`. Service `7b8a0001-4f2a-4a2e-9e51-1d9b6d8d5001`; raw `...0002...`; command `...0003...`; optional analytics `...0004...` is discoverable but deliberately unused in raw-only firmware.
- One sample = eight little-endian int16 words: sequence low, sequence high, ax, ay, az, gx, gy, gz. Reconstruct unsigned sequence as `(lo & 65535) + ((hi & 65535) * 65536)`. Normal notification is twelve samples/192 bytes; stop flush may be a shorter nonempty multiple of 16 bytes. Reject malformed lengths rather than shift word boundaries.
- Command strings are UTF-8 START, STOP, PING. Sequence restarts at zero on START and advances on nominal 208-Hz timeline. Require data subscription and MTU >=195 before START. Preserve packet receipt monotonic timestamp separately; it is not sample acquisition time. No second wearable is implied by dual IMU: the second stream is the phone.
- V5 `receiveShortsCsv` (`v5_gait.js:2649–2662`) scales accel by `0.0001220703125` to g and gyro by `0.07` to degrees/s. Preserve raw integers and label exact conversion. Do not apply the scale twice. The accelerometer's nominal sensitivity/calibration should be independently checked before claiming calibrated physical accuracy.

## Existing JavaScript API

V5 core exports `window.VSPIMU` and legacy alias `window.IMU` (`2704–2814`): `receiveShortsCsv(csv)`, `receiveEspAnalyticsCsv(csv)`, `bleConnected()`, `start()`, `stop()`, `reset()`, `prepareReport()`, `updatePatient()`, `state()`.

`receiveShortsCsv` accepts comma-separated signed integer words, eight per sample, **not** physical-unit rows. Native decoder must validate before passing it: V5 floors incomplete rows (`2651`) and normalizes arbitrary values modulo int16; this receiver is not a trustworthy validation boundary. V5 start resets the reference state; stop accepts a 900 ms tail before retrospective reconciliation (`296`, stop method after `2735`). It cannot be assumed synchronous. `state()` exposes `steps.ready`, not a top-level ready flag; adapters must match actual shape.

Phone addon exports `window.VSPIMUPhoneIMU` (`v6_phone_imu.js:1364–1407`): `beginSession`, `stopSession`, `setNativeSensorStatus(accAvailable,gyroAvailable,accEnabled,gyroEnabled)`, `ingestBatch(records)`, `annotate`, `recordLifecycleEvent`, `getSummary`, export/ack APIs, history deletion and report display. It wraps core receive/start/stop/report methods at `1308–1359`; do not invoke both wrapper and explicit lifecycle entry point or duplicate data/reset sessions.

The existing phone row is `[kind, callbackWallMs, nativeTimestampNs, x, y, z]` (`388–456`). `kind` is `acc` or `gyro`. Acceleration is m/s² and gyro is **degrees/s**. The old code deliberately labels accelerometer times as AI2 wall-clock callbacks and discards hardware timestamp for acc; gyro native timestamp is parsed as JavaScript Number. It computes relative phone times from callback wall time. Therefore **do not feed Kotlin SI gyro rad/s or high-precision native timestamps directly into this API**.

Native authoritative records must retain acquisition and receipt nanoseconds as Long and export them as decimal strings; phone gyro remains rad/s in that record. A future analytics adapter can convert rad/s × 180/π and use relative seconds from a monotonic origin for computations, while retaining original strings. Rewrite timing-sensitive phone analysis in a new module to use acquisition time for both sensors; carrying over old AI2 timestamp labels would misrepresent provenance. The new native frontend render API in CONTRACTS.md takes precedence over AppInventor messaging/export handshakes.

## Safe recovery sequence

1. Retain SOURCE_AUDIT.md hashes. Keep absent/disabled gait model explicit in the MVP. Existing mocks do not justify claiming gait analytics readiness.
2. When implementation ownership is assigned, copy the executable V5 parity reference into a new `native-android` legacy-analysis namespace, never overwrite V6 `v6_gait.js`. Recover only model.json, its shard and TensorFlow runtime from the AIA into that new namespace using exact allowlisted entry names; verify hashes. Preserve third-party notices and establish model licence/provenance before distribution; model metadata alone is not licence evidence.
3. Change only the new copy's model URL from hardcoded `http://localhost/model.json` (`v5_gait.js:2686`) to the trusted packaged `https://appassets.androidplatform.net/assets/.../model.json` origin. Load runtime locally. Deny network/navigation and do not enable an unrestricted native bridge. Test actual TensorFlow CPU and WebView backend behavior, model outputs and tensor disposal before claiming offline inference.
4. Decouple the V5 DOM rendering/report/parity behavior from numerical outputs, or run it on a dedicated trusted legacy page with an explicit adapter. It expects many DOM IDs and auto-loads model/starts a dashboard timer; blindly importing it into the new dashboard risks errors and stale state. Raw-only firmware produces no parity analytics; disable parity expectations in the new adapter and suppress misleading ESP/phone parity claims.
5. Expose a typed result containing availability, algorithm/model hashes, observed same-shank candidates, inferred opposite-step count, TCN scores, wavelet scores, event arrays, quality and finalization state. Prevent legacy disease screening from becoming a new evidence-engine diagnosis. Treat stance/swing events, freeze/tremor indicators and event scores as research estimates pending independent validation.
6. Integrate phone and shank through separate authoritative records. Never align sequence-derived shank times to native sensor acquisition simply because receipt timestamps are close. Correlation/lag can be exploratory but cannot establish synchronized event ground truth or bilateral asymmetry from pocket motion.

## Required verification before enabling legacy output

- Executable/type checks for every script; complete offline asset manifest and hashes; model and weight integrity; full model load and one real inference, not mocked TensorFlow.
- Golden-output tests on documented input and normalization, FC/IC output ordering, dimensions, gap handling, duplicate/backward sequence, rollover, clipping and calibration failure; avoid interpolation over unacceptable gaps.
- End-to-end short/192-byte notifications, stop tail, command serialization, disconnect, lifecycle pause, session restart, consent opt-out, absent phone sensor, timestamp precision and SI conversion.
- Assert finalization availability on actual `steps.ready`; reports must remain unavailable/pending if inference fails, and raw export must still work.
- Compare copied algorithm outputs against frozen V5 reference before any intentional algorithm change; then test on held-out reference labels with subject separation. Hardware/clinical validity remains a distinct gate.

Unresolved dependency: latest actual V6.1.3 patched assets and 20-test suite were not present in the inspected sources. Do not invent or rename the recovered V5 pipeline as that version. Recovery can proceed in the new native package under a distinct version while retaining this limitation.
