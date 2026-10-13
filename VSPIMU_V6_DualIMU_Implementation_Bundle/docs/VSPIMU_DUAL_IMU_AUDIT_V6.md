# VSPIMU V6 dual-IMU integration — source audit

**Audit date:** 12 October 2026  
**Scope:** code present in the current working container/library and the existing public VSPIMU repository; no repository files were modified.

## 1. Existing system retained

The supplied V6 HTML uses the following assets in order:

1. `tf.min.js`
2. `v6_gait.js`
3. `v6_report_viewer_FINAL.js`
4. `v6_report_intelligence.js`
5. New optional `v6_phone_imu.js`

The new module is loaded last so it can wrap the existing public `window.VSPIMU` API after the engine and viewer initialize. It wraps `receiveShortsCsv`, `start`, `stop`, `openPreparedReport` (when exposed), and `prepareReport` defensively. It does not replace the core detector, TCN inference, Wavelet support, AFO support, Inertia pipeline, original app UI, BLE logic, or the existing report viewer. A separate optional dual-IMU data report is provided if the current report viewer uses a different internal DOM structure.

The actual current MIT App Inventor `.aia` project and the complete V6 JavaScript dependency set were not mounted in the working container. The complete current block workspace could therefore not be byte-for-byte inspected or merged into a new `.aia`. The block guide supplies the required changes while keeping the working BLE blocks intact. This is not presented as a fully merged or hardware-verified `.aia`.

## 2. Existing BLE contract

| Item | Existing value preserved |
|---|---|
| BLE device name | `GAIT-V5-C3` |
| Service UUID | `7b8a0001-4f2a-4a2e-9e51-1d9b6d8d5001` |
| Raw data UUID | `7b8a0002-4f2a-4a2e-9e51-1d9b6d8d5001` |
| Command UUID | `7b8a0003-4f2a-4a2e-9e51-1d9b6d8d5001` |
| Raw notify | 12 records × 8 signed 16-bit words = 192 bytes |
| Record layout | `[sequenceLow, sequenceHigh, axRaw, ayRaw, azRaw, gxRaw, gyRaw, gzRaw]` |
| Wearable configuration | LSM6DSO, 208 Hz configured ODR, ±4 g, ±2000 dps |
| Phone raw-data conversion | Existing JavaScript performs conversion from raw counts after BLE reception |

The dual-IMU module listens to the same ShortsReceived path; it never changes the binary record or the original receiver call. Shank export values are captured as received and labeled as raw LSB. A sequence-derived timestamp is nominal, based on the configured 208 Hz ODR; it is not a measurement from a shared hardware clock.

## 3. Phone sensor interface chosen

The phone stream is acquired by native MIT App Inventor `AccelerometerSensor` and `GyroscopeSensor` components and forwarded to the WebViewer in batches of roughly 100 ms. This is less fragile than depending on `DeviceMotionEvent` support in a particular Android WebView. It uses an explicit typed record contract:

- Accelerometer: `['acc', callbackWallMs, 0, x_m_s2, y_m_s2, z_m_s2]`
- Gyroscope: `['gyro', callbackWallMs, nativeTimestampNs, x_deg_s, y_deg_s, z_deg_s]`

The callback timestamp is the time taken by `ClockPhoneFlush.SystemTime` in the AI2 callback. It is not the Android hardware acquisition timestamp. The gyroscope event API includes its native event timestamp in nanoseconds. AI2 callback rate and Android sensor rate vary; the module estimates the observed rate from timestamps and does not promise a fixed phone ODR. No body-axis or anatomical calibration is claimed.

## 4. Timestamp and synchronization strategy

- Shank source sequence is preserved as an unsigned 32-bit count reconstructed from its two 16-bit words.
- Shank time is sequence-relative at the configured 208 Hz ODR. BLE callback/packet receive time is stored separately.
- Phone callback wall time and WebView receipt monotonic time are retained separately.
- Gyroscope's native `SensorEvent.timestamp` is retained when present, and used for interval/rate quality only when complete for that stream. If timestamps are mixed/missing, the module uses callback timestamps consistently for the entire gyro stream's rate calculation.
- A linear fit between shank sequence time and packet-receipt time estimates a *relative receive timeline* and reports fit diagnostics. Its intercept contains unknown BLE + App Inventor dispatch delay, so it is not true acquisition-time synchronization.
- A 500-ms binned correlation between shank gyro-magnitude variability and phone acceleration-magnitude variability can provide an exploratory activity-envelope match. The possible lag is not applied to the raw data. A 250-ms half-bin is only nominal bin quantization, not a validated uncertainty bound; end-to-end sync uncertainty remains explicitly unquantified.
- Source streams stay separate. No common sample index, interpolation across long gaps, or forced timestamp correction is applied.

## 5. Quality checks and bounded capture

The new module assesses:

- Shank sequence gaps, duplicates/backwards sequence rows, malformed rows, near-int16-limit rows, capture truncation and sample count.
- Per-phone-stream observed median interval/rate, robust interval variability (MAD-scaled), duplicate/backwards timestamps, long gaps (>3× observed median interval), an explicitly heuristic missing-callback estimate relative to that median, invalid callbacks and storage truncation.
- Whether a stream has enough samples/time to produce a descriptive summary.
- Coarse activity-envelope comparability without claiming true gait-event alignment.
- Export row counts, timestamp sources and limitations.

The WebView capture buffers are bounded: 40,000 shank records, 30,000 per phone sensor, and a 180-second maximum capture window. The companion App Inventor block guide also bounds its temporary native sensor queue at 500 rows and flags overflow as an interrupted/reviewable session. Truncation is flagged; a truncated session is not considered eligible for automatic within-person baseline enrollment.

The current AI2 accelerometer API does not expose native sensor-event timestamps or hardware clipping status; gyro accuracy metadata is also not supplied by the event signature. These are recorded as unavailable, not fabricated.

## 6. Existing report and new outputs

The existing report handoff is extended before rendering when `VSPIMU.openPreparedReport` is exposed. The module also appends the section to the returned report result where possible. A separate “Open dual-IMU data report” view is independent of the original report viewer; this is the fallback if its DOM differs from expected.

Export types:

- shank raw CSV
- phone accelerometer CSV
- phone gyroscope CSV
- gait candidate events and user annotations CSV
- session metrics and quality CSV
- synchronization diagnostics CSV
- session summary JSON

In a WebView with the App Inventor bridge, export uses a one-chunk-at-a-time acknowledged File/Sharing handshake, avoiding a giant one-shot WebViewString payload. Raw-stream export is enabled after the phone add-on finalizes its capture tail, even if the existing VSPIMU engine is still finalizing; in that case the event/engine rows are explicitly marked potentially partial. The original doctor-shareable gait report still follows its existing core-engine readiness gate. File names contain the unique session id plus a per-export nonce to avoid overwriting prior exports.

## 7. Local baseline / privacy

Only a compact summary is stored in local WebView `localStorage`, and only when the user supplies a pseudonymous code, chooses a placement, opts into phone capture, and the session is long/high-quality enough. It stores no names, age, sex, notes, or raw samples. A descriptive comparison requires five previous quality-eligible sessions with the same profile code, phone placement, protocol and algorithm version. It does not produce a medical alert. LocalStorage availability is not guaranteed and failure does not invalidate the active session/export.

## 8. Claims intentionally not made

This configuration does not measure bilateral asymmetry, absolute walking speed/distance, millimetre foot clearance, knee/hip/ankle anatomical angles, ground-reaction forces, joint torque/load, muscle strength, edema, or clinical fall risk. It does not diagnose Parkinson's disease or confirm a freezing-of-gait episode. Candidate event labels from the pre-existing gait engine remain estimates. TUG, sit-to-stand and other future tasks are not added to the existing protocol by this patch.

## 9. Verification boundaries

Module release version: `6.0.0`. The stable algorithm id remains `VSPIMU-phone-shank-summary-0.3.0` because the algorithm was not altered by this release rename.

Verified in this session:

- JavaScript parses under Node.js.
- Synthetic Node regression tests exercise start/stop wrapping, optional opt-out, raw BLE parsing, phone sample capture, malformed rows/gap detection, timestamp quality, buffer caps, summary generation, baseline comparison policy, export acknowledgement flow, report enrichment and one-sensor-unavailable behavior.
- The updated HTML has each new UI id exactly once, no duplicate ids, and loads the new module after existing engine/viewer/report assets.

Not verified without the actual Android device/current `.aia`/complete deployed assets:

- Android sensor callback rate on the user's phone.
- Actual BLE + phone simultaneous live capture and lifecycle transitions.
- Native App Inventor block compilation, File/Sharing behavior on the target AI2 build, and real exported CSV bytes.
- End-to-end report viewer compatibility on the user's exact V6 viewer build.
- Clinical validity or agreement against Vicon/force plates.
