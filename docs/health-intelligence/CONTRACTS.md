# Native MVP contracts v1

This contract is the lead-owned integration boundary. Changes require coordinating with consumers.

## Transport
Package: `org.vspimu.health`. BLE name `GAIT-V5-C3`; service/data/command suffixes 0001/0002/0003 in `7b8a0001-4f2a-4a2e-9e51-1d9b6d8d5001`. Preserve optional analytics 0004 separately; do not interpret analytics packets as raw samples.

Raw notifications contain little-endian records of 8 signed int16 words, 16 bytes each, normally 12 records/192 bytes. First two words reconstruct unsigned uint32 sequence; remaining values are raw ax,ay,az,gx,gy,gz. Reject empty/nonmultiple-of-16 packets. Sequence advances at nominal 208 Hz; gaps are retained. Require MTU >=195, successful data CCCD registration and serialized GATT operations before START. UTF-8 commands START, STOP, PING.

## Native records
Native session captures `sessionId`, UTC start, elapsedRealtimeNanos origin, wearable leg, phone pocket, same/opposite relationship, sensor presence, app version, status and stop reason. Phone records store sensor type, acquisition timestamp nanoseconds, receipt timestamp nanoseconds, accuracy, xyz in SI (accelerometer m/s², gyroscope rad/s). Shank records store raw signed words, reconstructed sequence and packet receipt elapsedRealtimeNanos. Never round nanosecond integers through a JavaScript number; serialize as decimal strings when bridging.

## Android modules (one owner each)
- Android specialist: `BleClient.kt`, `ImuProtocol.kt`, `PhoneSensors.kt` and their pure protocol tests. Lead coordinates public APIs before use.
- Lead: `MainActivity.kt`, `SessionStore.kt`, manifest, integration and lifecycle controller.
- Build specialist: root Gradle files, app Gradle file, workflow, CI tooling and build documentation.
- Signal specialist: read-only baseline audit first; future legacy extraction and tests require explicit ownership assignment.
- Frontend specialist: `app/src/main/assets/index.html`, `dashboard.js`, `dashboard.css`, JS tests after bridge contract is agreed.
- AI specialist: `OfflineCompanion.kt`, optional model import/runtime integration and runtime evidence after feasibility review.
- Biomedical specialist: structured evidence/safety/question rules and tests after scope assignment.
- QA specialist: independent review, test scripts and acceptance checklist; no concurrent implementation rewrites.

## MVP UI bridge
Trusted bundled WebView origin only: `https://appassets.androidplatform.net/assets/index.html`. No arbitrary navigation, network resources, remote scripts or bridge exposed to external pages. Native to page: `window.VspimuUi.render(snapshot)` where snapshot is JSON safely serialized (never interpolated raw text). UI is initially a read-only evidence/report view controlled by native buttons; no general native JavaScript interface.

Snapshot v1: `{schemaVersion:1, sessionId, status, elapsedSeconds, placement, counts:{shank,acc,gyro}, quality:{gaps,duplicates,malformed,interrupted}, recent:[{t,accMagnitude,gyroMagnitude}], limitations:[string], events:[{kind,text}], modelStatus}`. All values may be absent only if explicitly labelled unavailable. No simulated values mixed into live recordings. Demo uses a separate labelled snapshot and cannot enter the real baseline.

## Storage and export
App-private AES-GCM records with Android Keystore key; backup disabled. Bounded session duration and counts; interruption recorded. Export via Android document picker only following explicit user action. JSON includes full raw streams and provenance, no device MAC in clinical exports. Save/reload failures are visible and never reported as success. No silent overwrite or auto-share.
