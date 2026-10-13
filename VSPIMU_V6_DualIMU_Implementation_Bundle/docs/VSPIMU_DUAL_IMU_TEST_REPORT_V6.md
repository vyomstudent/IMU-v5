# VSPIMU V6 dual-IMU add-on — test report

**Build:** module release `6.0.0`; stable algorithm id `VSPIMU-phone-shank-summary-0.3.0`  
**Test date:** 12 October 2026  
**Test scope:** additive phone-sensor capture/QC/export/report module and patched HTML shell. The original VSPIMU core, Android sensors, BLE radio, and physical `.aia` project were not available for physical end-to-end testing.

## Executed results

| Test group | Result | What it verifies |
|---|---|---|
| JavaScript syntax (`node --check`) | PASS | Add-on and Node regression test file parse successfully. |
| Synthetic Node regression suite | **19/19 PASS** | API wrapping, opt-in/shank-only mode, raw packet mirroring, malformed/gapped rows, phone stream timestamps/rates, buffer limits, summary/QC, baseline eligibility, acknowledged export sequence, placement metadata, lifecycle interruption, finalization pending, provenance, report enrichment, implausible values, wall-clock jumps, and partial sensor failure, plus CSV headers/raw-value/time-source provenance. |
| HTML structural audit | PASS | 120 unique IDs; all new sensor/export/report IDs occur once; script order remains original runtime → gait engine → current report viewer → report-intelligence add-on → phone-IMU add-on. |
| Chromium browser smoke using patched HTML shell | PASS | Actual patched HTML DOM and add-on with a mocked existing VSPIMU core: phone controls, placement disclosure, separate sample retention, native-control messages, stop tail/finalization, and report-section handoff. No browser console/page errors. |
| Existing shank BLE contract static audit | PASS | No UUID or 192-byte packet modifications in this additive patch; raw receive call is wrapped and then forwarded to the original handler. |

Commands from the bundle root:

```bash
node --check assets/v6_phone_imu.js
node --check tests/test_v6_phone_imu.js
node tests/test_v6_phone_imu.js
python tests/test_v6_dual_imu_static.py
python tests/test_v6_dual_imu_browser_smoke.py
```

The Python Chromium test requires `playwright` and Chromium. It substitutes a **mock** VSPIMU core and mock viewer dependencies while loading the real patched HTML and add-on source. It does not execute the deployed `v6_gait.js`, report viewer, TensorFlow.js weights, or Android hardware.

## Test meaning and unresolved checks

- Synthetic tests confirm software contracts under controlled fixtures. They do not prove actual Android callback timing, measurement accuracy, or clinical performance.
- Browser smoke confirms the HTML DOM/add-on path with a mock core. It does not prove compatibility against the user's exact deployed `v6_gait.js`, report-viewer JS, model/weight assets, or App Inventor runtime.
- Native MIT App Inventor blocks have not been imported/compiled in the user's actual `.aia` project. File/Sharing export must be confirmed on the target AI2 and Android versions.
- Physical simultaneous BLE + accelerometer + gyroscope capture, OS pause/screen-off, reconnection, battery use, and emitted CSV bytes remain **not tested**.
- No Vicon, force-plate, pressure-insole, or annotated clinical recordings were used. No gait-event accuracy, freezing-of-gait sensitivity, fall-risk prediction, or clinical validity result is claimed.

## Repeatable device acceptance

1. Back up the current `.aia`; add the HTML asset and `v6_phone_imu.js` as documented. Do not replace the core gait/model assets.
2. With phone capture unchecked, run the previous shank-only workflow and compare results against the prior app build.
3. Enable phone capture, declare the correct pocket, and run a short stationary session in foreground. Confirm phone acceleration and gyro counts advance independently and rates are measured, not assumed.
4. Run a supervised safe standardized assessment with the wearable fixed 4–5 cm above the medial malleolus and the phone remaining in the declared pocket. Do not run an unsafe walk test.
5. Verify Stop disables phone sensors, core finalization completes, the dual-IMU report remains distinct from the existing report, and all CSV/JSON exports contain the documented schema.
6. Repeat with one phone sensor unavailable, phone capture disabled, a brief BLE disconnection, an intentionally short session, and a lifecycle interruption. The affected stream/report must be marked partial or `REVIEW`; do not silently splice sequence resets into a clean session.
7. Inspect CSV timestamps and source fields: wearable sequence-derived time is nominal at 208 Hz; wearable packet receipt is not sample-acquisition time; phone accelerometer time is AI2 callback wall time; phone gyro native timestamps are retained when present. Never report an unsupported millisecond-level synchronization bound.

Do not describe VSPIMU as validated on older adults or a clinical device until the independent reference study and required regulatory/clinical review have been completed.
