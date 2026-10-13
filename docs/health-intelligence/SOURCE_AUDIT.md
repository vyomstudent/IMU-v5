# Baseline signal and package audit

Audit date: 2026-10-13. Read-only inspection of preserved bundles at baseline `7b3d271f196b2425a65f5294c1d74dba039dfaf1`; only this engineering record and LEGACY_INTEGRATION.md were added by the signal auditor. No AI2 file, firmware, model, or baseline JavaScript was changed or extracted. Paths below are repository-relative; line numbers refer to the baseline files.

## Critical package defect

`VSPIMU_V6_DualIMU_Implementation_Bundle/assets/v6_gait.js` is **TensorFlow graph-model JSON, not executable JavaScript**. It begins `{"format": "graph-model"...` and Node's JavaScript parser reports `SyntaxError Unexpected token ':'`. Its bytes exactly equal both `assets/v6_gait.js` and `assets/model.json` inside `VSPIMU_v6_1 (1).aia`. Thus the archive does not recover an executable V6 gait engine. Loading the supplied HTML cannot establish the expected `window.VSPIMU` core from this file.

The loose assets also omit `tf.min.js`, `model.json`, and `group1-shard1of1.bin`. The HTML references TensorFlow and gait scripts at lines 250 onward. These three runtime/model files do exist in the AIA. The usable executable reference is `VSPIMU_V5_8_12_PARITY_REPORT_FIXED_FINAL/v5_gait.js`; this is a recovery source, not proof of V6.1.3 parity.

**No V6.1.3 implementation or 20-test suite was recovered from the audited bundle.** The loose phone module declares version `6.0.0` and algorithm `VSPIMU-phone-shank-summary-0.3.0` (lines 17–18). The AIA phone module, HTML, report intelligence and viewer equal the loose counterparts after CRLF/LF normalization. Its screen identifies the app as VSPIMU v6. The mission brief's 20/20 claim cannot be attached to these files; the present executable regression suite has 19 tests.

## Reproducible SHA-256 inventory

| Source | Bytes | SHA-256 |
|---|---:|---|
| AIA archive `VSPIMU_v6_1 (1).aia` | archive | `310FD34EFBEF01FA326014C7383DAB705F614F3E9F7CA22E14DDEB9A9179220C` |
| Loose `assets/v6_gait.js`; AIA `assets/v6_gait.js`; AIA `assets/model.json` | 117510 each | `C0941CCB1947A686A23CF4EE12A6572389464693EF492A5D500211A29038CB9A` |
| AIA `assets/group1-shard1of1.bin` | 29660 | `DD1525252798DA12F13ACF724E74335FBE68F6F927CF0F8E821E4ADD7B8A5381` |
| AIA `assets/tf.min.js` | 1469843 | `300DFAE273D20B4046F46A06D735688F03675A807561E9BCB5F664EB2F3D2831` |
| Loose `assets/v6_phone_imu.js` | 92159 | `D342434C3B9258140B5A062D9149E626998BED80A3F70AE63B5DBEEB674838BF` |
| AIA `assets/v6_phone_imu.js` | 90748 | `525CB6FDB1F3AF5FA27196E028D0453379B36E894EE2423C39AF5BC28793E5C2` |
| Loose `assets/v6_report_intelligence.js` | 46959 | `B765B2397733617B17AC20F99CB6161EE8CD2B8A41B45AF6D13EF792C8C235BD` |
| AIA `assets/v6_report_intelligence.js` | 46307 | `9E38177C2A6854479EC26CB2BE2957BC0383F94D4A1CCDE73EE0082BAE4CC57A` |
| Loose `assets/v6_report_viewer_FINAL.js` | 5284 | `FB7A6703120735DCBFEE18E2611E5875CF135ADE2A0480BF972738645D8142AE` |
| AIA `assets/v6_report_viewer_FINAL.js` | 5226 | `5C33744ABF0EE82A6093AAD6C529897DE85AEEFA943165331C4588503D3EA047` |
| Loose `assets/vspimu_v6_single.html` | 26424 | `618A601A25E5054060D2927956D8FF3F12202643670152FCC355FB9B0D953EC0` |
| AIA `assets/vspimu_v6_single.html` | 26168 | `6EF5589A42AA8BF6C08A2294FCA5DF05BCE87E0AA5FA680B66D9D8B995D641D1` |
| AIA `src/appinventor/ai_vyom_student/VSPIMU_v6_1/Screen1.bky` | 40351 | `1C79F2A4468A518EAF35F4B06D9F309212E0662E2427B6977B17778DF283E2C5` |
| AIA corresponding `Screen1.scm` | 1973 | `0FB0177E4CFF54B6FB9777AF8D56DA304DC87EDD2E7DBFF33BD984E4F022AD80` |
| `VSPIMU_V5_8_12_PARITY_REPORT_FIXED_FINAL/v5_gait.js` | executable | `7D1A0CE39CA45CC38FF64D416650A4B10A9B0CE6B8946A329CD3E3485707911E` |
| `VSPIMU_V5_8_FINAL_PACKAGE/v5_gait.js` | different executable | `6897719E66576602E1397C7B6EDEA4F3F5774B289923E8B0190992FB077B632C` |

## Implemented versus absent

The following algorithm evidence is in the executable **V5 parity reference**, not the mislabeled V6 JSON:

- Wavelet confirmation is implemented at `v5_gait.js:979–1014`: localized cosine/Gaussian correlation, absolute normalized coefficient, tested over a frequency grid on acceleration and gyro magnitudes. This is a concrete heuristic confirmation score, not a calibrated event probability.
- TCN execution exists at `1240–1260` and model loading at `2676–2700`; input is 400 × 6, 200 Hz after nominal 208-Hz conversion, standardized using baseline-walk statistics. Two-output semantic order is FC then IC (`2121`). AIA model metadata lists `final_contact,initial_contact`; signature is float input `[batch,time,6]` with two `[batch,time,1]` outputs and 129 weight entries in one shard. This establishes structural compatibility only; no inference/weight provenance validation was executed.
- Retrospective candidate scan and TCN corroboration exist at `1263–1279`. Live counting does not wait for TCN (comment at `1115`). Neither TCN agreement nor a normalized wavelet score is ground truth.
- `updateAFO` at `1028–1046` is an anchor-driven smoothed inverse interval (0.82/0.18 blend), phase advance and reset. It is not evidence of a independently validated adaptive-oscillator implementation from a specific paper. At `1060–1082`, contralateral steps are counted/predicted at midpoints under a walking gate. These must remain inferred steps, never bilateral measurements.
- Phone capture/quality, raw shank mirror, summaries, descriptive baseline comparison and exports exist in `v6_phone_imu.js`; native transport remains an integration responsibility. Sensor absence and lifecycle interruption are represented. Buffer limits are 40,000 shank samples, 30,000 per phone sensor, 180 s (`19–23`). V5 raw history is 30,000 samples (`78`), only about 144 s at 208 Hz; avoid silently reusing it for longer assessments.
- V6 report intelligence explicitly labels observations, availability, unsupported claims and exploratory analysis (`v6_report_intelligence.js:185–253,346–365,395–398`). V5 report still includes disease-oriented screening and uncalibrated confidence terminology (`v5_gait.js:1585,1727,1753,1794`). Do not expose the legacy report directly as the new clinical interpretation.
- No Inertia-1 implementation dependency was identified in the reviewed V5/phone/report source. Do not import unrelated model packages to repair the missing engine.

## Executed checks and limits

From repository root, with bundled runtimes:

```powershell
& 'C:/Users/samir/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' VSPIMU_V6_DualIMU_Implementation_Bundle/tests/test_v6_phone_imu.js
& 'C:/Users/samir/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' VSPIMU_V6_DualIMU_Implementation_Bundle/tests/test_v6_dual_imu_static.py
```

Observed: **19/19 phone-module synthetic tests pass**; structural test passes with 120 unique DOM IDs. Node `vm.Script` syntax inspection passes V5 and fails supplied V6 gait JSON. AIA inspected with read-only ZIP streams and SHA-256; no archive writes.

The phone tests use a mocked core. The browser smoke test explicitly replaces TensorFlow, gait engine, report viewer and report intelligence (`tests/test_v6_dual_imu_browser_smoke.py:1–6,23–44`); it was not rerun here and cannot demonstrate actual inference. Structural tests check script order, not existence, JavaScript type or model loading. No Android build, BLE hardware, native sensor test, full TCN execution or clinical validation was performed by this audit.
