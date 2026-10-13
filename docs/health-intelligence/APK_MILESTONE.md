# Verified cloud APK — 0.1.0 acquisition MVP

Source commit: `8e67862ea8c67086f329a1f6bc31c4e096f659c8`.
Branch: `codex/vspimu-health-intelligence`.
Successful run: https://github.com/vyomstudent/IMU-v5/actions/runs/38445387199
APK artifact: https://github.com/vyomstudent/IMU-v5/actions/runs/38445387199/artifacts/11837784443
Synthetic test/lint reports: https://github.com/vyomstudent/IMU-v5/actions/runs/38445387199/artifacts/11836879816

## Actual results
- Kotlin compilation: passed.
- JVM protocol tests: 8 passed, 0 failures, 0 errors.
- JavaScript dashboard tests: 7 passed, 0 failures.
- Android lint: passed, 0 errors, 9 warnings. Lint remained enabled; no baseline or suppression was introduced to hide the errors.
- Debug APK assembly: passed.
- APK signature verification: passed (v2 signature, one signer).
- Package metadata: `org.vspimu.health`, version 0.1.0/code1, min API26, target API35, launch activity MainActivity.
- Downloaded artifact ZIP verified against its SHA-256; extracted APK hash/size matches the cloud log.
- APK size: **1,319,011 bytes** (1.32 MB decimal, 1.26 MiB).
- APK SHA-256: `fe762c989cce355a4c299a2a1949a0cecf24f4b5cfdd447c3d1239813c44288e`.
- ZIP SHA-256: `ebb80877e2733e49b15f634cd524613239afbf72e103081b6dbdcbe361d0b7fc`.

Cloud artifacts total **1,348,132 bytes** (APK ZIP 1,319,151 + report ZIP 28,981).
The budget guard observed zero prior retained artifacts and reserved overhead inside
the 100 MiB cap. One-day retention: APK expires **14 October 2026, 23:48:35 IST**.
Owner verified account-wide zero-spend blocking; no billing settings were changed.

## Errors repaired from actual cloud evidence
1. Descriptor write compared its typed result with raw 0. API33+ now uses BluetoothStatusCodes.SUCCESS; old Boolean call retained.
2. Command write had the same typed-result error. Fixed the same way.
3. Fine location lacked a matching coarse declaration. Both are declared/requested only through API30; API31+ uses Bluetooth permissions.
4. Actual backup warning addressed with explicit Android12+ cloud-backup/device-transfer exclusions; backups also disabled on older Android.

First run 38444344382 compiled/tests/assembled but failed lint (3 errors). Second
run 38444924766 exposed the complete report and confirmed one remaining permission
error. Third run passed all required checks and uploads. No local Android build or
tool installation occurred; main and reference files remain unchanged.

## Remaining boundaries
No emulator or physical installation, BLE acquisition, sensor callback timing,
encrypted-device restore/export/delete, model inference or clinical validation
has been performed. This is the acquisition MVP; legacy gait integration and a
real local LLM remain separate backlog items. Nine nonblocking warnings cover
target/dependency currency, SDK-conditional permission attribute, bundled
JavaScript review, missing launcher icon and English text localization.

## Minimal phone test (repeat on Vivo Y29 and Galaxy M31)
1. Download/extract the artifact and open app-debug.apk in Files. Allow that install
   source temporarily if asked, then revoke it after installation. Do not disable
   Play Protect. Android8/API26 or later is required. Report installer errors exactly.
2. Enable Bluetooth; Android11 or older also needs Location enabled for BLE scan.
   Open VSPIMU Health, grant the requested permission, Find wearable, confirm your
   GAIT-V5-C3 and wait for Ready. Start with consent unchecked: no recording begins.
3. Select actual leg/pocket, enable phone capture and consent. Start a disposable
   assessment. Counts should increase for shank and each available phone sensor.
   Stand still for the initial 8s, then use your established safe assessment protocol.
   At about123s expect COMPLETE and Session saved privately if uninterrupted.
4. Reopen the saved session, export JSON to a local folder, verify counts/placement
   match. Delete private records and confirm history empties; manually remove the
   exported copy separately. In another disposable session press Home: expect PARTIAL.
5. Report phone OS/API, install result, visible status, duration, counts/gaps and any
   error class. Keep raw exports/health information local. Full fault cases and
   privacy-preserving log instructions are in PHONE_TESTS.md.
