# VSPIMU V6 — optional dual-IMU integration patch

This package adds optional Android phone accelerometer and gyroscope capture to the existing VSPIMU HTML/WebView workflow. The lower-tibia LSM6DSO stream and existing gait engine remain authoritative for the current single-shank pipeline; the phone is a separate sensor stream, not a rigid pelvis tracker.

## Files

- `assets/vspimu_v6_single.html` — patched HTML asset with phone opt-in, declared placement, capture quality, annotations, dual-IMU report and export controls. Keep the active App Inventor asset name and HomeUrl; if currently `vspimu_v6_single.html`, retain that name.
- `assets/v6_phone_imu.js` — additive `window.VSPIMU` wrapper and dual-IMU capture/QC/report/export module, release version 6.0.0 (algorithm id remains 0.3.0 because the calculation itself was not changed).
- `app_inventor/MIT_APP_INVENTOR_DUAL_IMU_BLOCKS_V6.txt` — exact native component and block additions, including the acknowledged chunk export handshake.
- `docs/` — source audit, metric catalog, test report, installation guide and research roadmap.
- `tests/` — synthetic Node tests, structural HTML checks and an optional Chromium smoke test.

## Install safely

1. Export an untouched `.aia` backup from MIT App Inventor. Keep it untouched for rollback.
2. Add `assets/vspimu_v6_single.html` as a **new** HTML asset, rather than overwriting the current working HTML at first.
3. Add `assets/v6_phone_imu.js` as a new asset.
4. Copy the current core asset contents byte-for-byte to the new V6 filenames in the table below. Keep the original assets too until V6 is verified. Keep `tf.min.js`, `model.json`, all model shards, and any existing Inertia/runtime assets under their exact names.
5. Set `WebViewer1.HomeUrl` to `http://localhost/vspimu_v6_single.html` using the same local asset-serving scheme as the current app.
6. Merge the block additions in `app_inventor/MIT_APP_INVENTOR_DUAL_IMU_BLOCKS_V6.txt` into a backup copy. The actual `.aia` was not available to modify in place.
7. Test shank-only operation first, then phone sensors, then a supervised assessment.

## Test status

Verified here: module/test syntax checks, **19/19 synthetic Node regression tests**, a static HTML structure/script-order audit, and a Chromium smoke test with real patched HTML + mock core. These do not substitute for physical Android/App Inventor/BLE testing. The current deployed `.aia`, full working core JS/runtime assets, phone sensor callbacks and File/Sharing component must still be tested on the target device. See `docs/VSPIMU_DUAL_IMU_TEST_REPORT_V6.md`.

## Key scientific boundaries

- The AI2 accelerometer component event has callback wall time, not the native Android acquisition timestamp; AI2 gyroscope events can supply native nanosecond timestamps. Official component documentation: https://ai2.appinventor.mit.edu/reference/components/sensors.html
- Android sensor timestamps are intended to use the elapsed-realtime monotonic time base, but the current AI2 accel callback does not expose that timestamp. Android reference: https://developer.android.com/reference/android/hardware/SensorEvent
- A packet-receipt regression estimates relative transport timing and includes unknown BLE/App Inventor delay. There is no validated cross-sensor timing uncertainty bound.
- The phone is declared as a pocket placement, not assumed to be a rigid pelvis tracker. This patch does not claim bilateral asymmetry, absolute walking speed/distance, millimetre foot clearance, anatomical joint angles/load, definitive freezing of gait, diagnosis or fall-risk prediction.
- Phone capture is foreground assessment only. All raw streams remain separate, are bounded, and are exportable. No cloud service is added.


## V6 release naming and compatibility

All project-owned UI, app asset, add-on module, documentation, test and firmware filenames in this release are labelled V6. The phone module release version is `6.0.0`. The internal algorithm id remains `VSPIMU-phone-shank-summary-0.3.0` because this is a release rename, not a change to the feature calculations; this avoids invalidating comparable baseline records unnecessarily.

### Rename existing JavaScript assets without changing their contents

The original full `.aia` and its deployed core JS source files were not present as a complete set in this working package, so the V6 release includes the **asset migration map**, not guessed replacements for those files. Before using the V6 HTML, copy/download the actual files from your current working MIT App Inventor project's Assets and re-add the same bytes under these new names:

| Current asset name | V6 asset name |
|---|---|
| `v5_gait.js` | `v6_gait.js` |
| `v5_report_viewer_V5_9_FINAL.js` | `v6_report_viewer_FINAL.js` |
| `v5_report_intelligence.js` | `v6_report_intelligence.js` |
| `tf.min.js` | keep `tf.min.js` |
| `model.json` and all its matching weight shards | keep their current exact names |

Do not edit the core JS source while copying it under a new name. Keep original assets in the project until the V6 page opens, the TCN/model loads, BLE works, and the report is confirmed. If the three required V6 core JS copies do not exist in Assets, the HTML will be unable to load those dependencies.

The BLE advertised name deliberately remains `GAIT-V5-C3`, and its service/data/command UUIDs are unchanged so the currently installed firmware and BLE blocks remain compatible. This transport identifier is not the product's UI version. Changing it would be a separate firmware + App Inventor migration.

The V6 HTML asset is `vspimu_v6_single.html`; set `WebViewer1.HomeUrl` to `http://localhost/vspimu_v6_single.html` after that exact asset has been uploaded and served by the existing localhost asset setup. Keep a backup of the working `.aia` and do not delete the old assets until physical-device validation passes.
