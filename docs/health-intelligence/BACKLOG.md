# Delivery and acceptance board

All work is additive on `codex/vspimu-health-intelligence`. No remote write/build authorized yet.

| Item | Owner | Acceptance | State |
|---|---|---|---|
| Full brief and override reconciliation | Lead | Entire supplied brief read; current overrides recorded | Done |
| V5/V6/AIA audit | Signal + Android | Actual asset types, hashes, runtime dependencies and firmware contracts checked | In progress |
| Native acquisition MVP | Android + Lead | BLE scan/select/MTU/CCCD, START/STOP, raw records, phone hardware timestamps, interruption handling | In progress |
| Encrypted persistence/export | Lead; QA review | Authenticated private records, backup off, user-directed JSON export, deletion | In progress |
| Accessible report | Frontend | Real status/counts/quality, timestamps and limitations; no synthetic live data | Pending |
| Research and innovation | Research | Feasibility matrix, primary evidence and ranked original opportunities | Pending |
| Clinical evidence/questions | Biomedical | Deterministic safety and traceable contextual questions, tested unknown handling | Pending |
| Real offline AI | AI | Licensed model/runtime, import, actual offline generation benchmark, honest unavailable state | Pending feasibility |
| Legacy analytics integration | Signal | Resolve corrupt named asset, source provenance, no Inertia, executable regression tests | Blocked on audit |
| Cloud Android CI | Build | Pinned remote test/lint/APK build, free runner guard and artifact quota gate | In progress |
| QA/security and phone tests | QA | Independent review, failure tests, exact expected outputs/logs | Pending |
| Public branch push/cloud run | User gate | User approval of concrete diff and verified zero-cost execution | Not authorized |
| APK and installation | Build + user | Actual artifact hash/build logs and physical install evidence | Not run |
| Clinical performance | Research + clinician | Independent representative Vicon/force-plate and clinical studies | Not validated |

## Required staged progress
1. Reliable dual-stream capture and honest quality/provenance reports.
2. Audited legacy candidates plus comparable longitudinal observations and contextual questions.
3. Real local companion with bounded evidence retrieval and consent-based memory, benchmarked on target phones.
4. External algorithm validation and clinician-reviewed interpretation before clinical claims.

No plan/document/test success substitutes for an APK or physical/clinical validation. The missing newer V6.1.3 bundle is a tracked source gap, not an assumption that GitHub matches it.
