# VSPIMU V6 dual-IMU — installation and field-test guide

This patch is designed for the existing working MIT App Inventor application. It is not a replacement for the full app project. Before touching the current project, export/download an `.aia` backup from MIT App Inventor.

## A. Install the V6 assets without destroying the working version

1. In MIT App Inventor, export a backup of the current project (`Projects → Export selected project (.aia) to my computer`). Keep this backup unchanged.
2. Add the new HTML asset `vspimu_v6_single.html` and the supplied `v6_phone_imu.js`. Update `WebViewer1.HomeUrl` to `http://localhost/vspimu_v6_single.html` after confirming the app's existing localhost asset server serves that filename.
3. Copy the exact bytes of the currently installed core files under V6 names, then upload those copies as new assets. Use the migration map in `README.md`: `v5_gait.js` → `v6_gait.js`; `v5_report_viewer_V5_9_FINAL.js` → `v6_report_viewer_FINAL.js`; `v5_report_intelligence.js` → `v6_report_intelligence.js`. Do not edit the JavaScript content as part of the rename.
4. Keep `tf.min.js`, `model.json`, its model shards, and existing Inertia/ONNX runtime assets under their current exact names. Do not remove old assets until the new V6 page loads the model, connects to BLE and displays the existing report.
5. Verify the V6 HTML loads these scripts in order: `tf.min.js`, `v6_gait.js`, `v6_report_viewer_FINAL.js`, `v6_report_intelligence.js`, `v6_phone_imu.js`. Do not create duplicate entries for the same V6 filenames.

## B. Add the native App Inventor components and blocks

Open `MIT_APP_INVENTOR_DUAL_IMU_BLOCKS_V6.txt` and implement it carefully. It covers the four added components, batch queue, sensor callbacks, WebView control messages, export handshake, lifecycle boundary and preservation of the existing Start/Stop BLE blocks.

The added components are optional. If the phone does not have a gyroscope, or an event stream does not work, shank-only operation must continue. Do not rename the existing BLE services or alter the 192-byte packet layout.

## C. Foreground sensor test before walking

1. Place the wearable securely on the lower/distal tibia. The sensor centre must stay about 4–5 cm above the medial malleolus on the anterior/anteromedial tibia, with the same axis orientation as usual.
2. Place the phone in the declared **front trouser pocket**. Select left or right correctly. Keep it in that pocket throughout the assessment; the phone is not treated as a rigid pelvis sensor.
3. Open the app in the foreground. Wait until the current VSPIMU model/system status is ready and BLE is connected to `GAIT-V5-C3` (the legacy BLE identifier is intentionally unchanged for compatibility).
4. Check the optional phone capture box and select the actual pocket. To run the original shank-only workflow, leave the phone box unchecked.
5. Start with the existing app Start control. Follow the existing 123-second on-screen protocol exactly. Its initial 8-second `STAND_1` phase instructs the user to stand still; the add-on reports movement features from this phase without calling it a calibration or pass/fail test.
6. If fall risk is possible, use the person's usual walking aid, a clear level path and appropriate supervision. Do not attempt a test that is unsafe. Stop immediately if needed; incomplete sessions remain marked incomplete.
7. Stop using the existing Stop control. Wait until both the original VSPIMU finalization and the phone capture quality status are complete before exporting. The phone data-quality view is allowed to show “insufficient” when data are limited.
8. Review per-sensor rates, gaps, sequence continuity, clipping proxy and the synchronization status. An `OBSERVED` status only means the implemented checks did not flag a problem; it is not a clinical accuracy claim.

## D. Exports

Once finalization is complete, export each stream separately as needed:

- **Wearable raw CSV**: original signed integer LSM6DSO counts, sequence numbers and BLE packet receipt times (receipt time is not acquisition time).
- **Phone acceleration CSV**: m/s² device-frame axes and callback wall timestamps. It does not contain native hardware event timestamps because the AI2 accelerometer event does not expose them.
- **Phone gyroscope CSV**: degrees/second axes, callback wall time, native event timestamp in nanoseconds where supplied, and receipt time.
- **Events / annotations CSV**: current-engine IC/FC candidate events when exposed by the current VSPIMU API, plus manual annotations. Event labels are not ground truth.
- **Metrics / quality CSV** and **synchronization CSV**: methods and known limitations in columns.
- **Summary JSON**: structured summary with algorithm/schema versions, source status, baseline comparison and quality labels.

In MIT App Inventor, exports are written through the File component and then presented through Android Sharing. File names are unique per export; do not rename or overwrite source recordings. Export must not be interrupted before the share sheet appears. If a write fails, the module must report failure, not success.

## E. Local within-person baseline

The pseudonymous profile field is optional. Use a non-identifying code, not a name, phone number or medical identifier. The local history stores only compact metric summaries, not raw sensor samples or patient details. At least five previous quality-eligible sessions with the same pseudonymous profile, phone placement, protocol and module version are needed before medians can be compared. That is a descriptive trend, not a medical alert. Clearing the profile history is irreversible within the app; export any research data first if needed.

## F. Expected failure behaviour

- Phone capture unchecked or placement not declared: existing shank capture proceeds; phone data rows remain empty.
- Phone accelerometer unavailable: gyroscope can still be retained if available.
- Phone gyroscope unavailable: accelerometer can still be retained if available.
- Both phone sensors unavailable: shank-only capture/report remains possible.
- BLE gap/disconnect: the sequence gap is flagged; missing wearable samples cannot be reconstructed. Start a new session after reconnection rather than silently splicing a restarted sequence into a clean session.
- App background/screen-off: this is not an all-day/background-monitoring implementation. Keep the app foreground during the assessment. If callback gaps occur, the report should flag them.
- Clock change: the phone wall-to-WebView monotonic offset is monitored. A discontinuity of at least 250 ms suppresses cross-sensor envelope comparison instead of automatically rewriting raw timestamps.
- Memory/duration cap: session is marked truncated/incomplete and is not eligible for automatic baseline enrollment.
- Native App Inventor queue overflow: the queue is bounded at 500 sensor-event rows. Dropped events are reported as a lifecycle interruption so affected phone-stream quality becomes `REVIEW`; the data are not silently treated as complete.

## G. Hardware acceptance test checklist

Use a fresh session and record the exact phone model, Android version, AI2 build, component availability, and date/time. Keep this record with the exported files.

- [ ] App connects to `GAIT-V5-C3` and current raw shank graphs still update.
- [ ] Phone opt-in off: original shank workflow still runs.
- [ ] Phone opt-in on, left pocket: acceleration/gyro sample counts increase while the app is foregrounded.
- [ ] Serial/AI2 UI shows no new BLE protocol error.
- [ ] Initial stand phase: both streams are recorded (if sensors available).
- [ ] Walk, stop, normal turn, phone repositioning within pocket (only as a deliberate QC trial), and a short stationary period produce plausible changes in signals.
- [ ] Stop disables native sensors and ends the phone capture tail; raw-stream exports unlock after that tail finalizes. The original VSPIMU report retains its existing gait-engine finalization gate.
- [ ] Repeatedly export two different streams and verify unique filenames and non-empty CSV headers/data.
- [ ] Test accelerometer-only and gyro-only modes where feasible, or use the code's synthetic unit tests for partial-sensor paths if the device cannot selectively disable a sensor.
- [ ] Force a BLE disconnect only on a controlled test; confirm the incomplete/gap result is not presented as a clean completed assessment.
- [ ] Compare separate streams in Python/Colab. Do not compute cross-sensor event timing without accounting for timing limits documented in each file.
