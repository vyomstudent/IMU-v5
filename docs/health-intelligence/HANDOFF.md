# Compact handoff — 2026-10-13

## Current objective and constraints
Prioritize a compilable foreground Kotlin dual-IMU MVP and a cloud-built debug APK. Branch `codex/vspimu-health-intelligence`; baseline `7b3d271f196b2425a65f5294c1d74dba039dfaf1`. Feature-branch pushes, standard free public Ubuntu CI and one-day debug artifacts are now authorized; no main edit, merge or other publication. Zero billing, no API keys, no local Android toolchain installation or APK builds. Full user-supplied mission brief read; newer Kotlin/cloud directives supersede older AI2 preferences.

## Completed findings — do not repeat audit
- Repository cloned. Original bundles/firmware/AI2 untouched.
- V6 loose and AIA `v6_gait.js` contain graph-model JSON, not executable JS; AIA cannot recover the engine. V5 executable source exists but requires a separate adapted copy and safety review. Details: SOURCE_AUDIT.md / LEGACY_INTEGRATION.md.
- AIA holds TensorFlow runtime/model weights missing from loose assets. V6.1.3/20-test update not recovered; current phone module is 6.0.0.
- Executed baseline checks: 19/19 synthetic phone tests, HTML structure pass (120 IDs), V5 syntax pass; misnamed V6 gait syntax fails as expected. No model, Android, hardware or clinical validation.
- BLE: advertised name GAIT-V5-C3, UUID suffixes 0001 service /0002 raw /0003 commands /0004 optional analytics. No service-only scan filter. Raw LE records 8 int16 words, unsigned seq + six raw axes; 192-byte max notifications; MTU >=195; START/STOP/PING. Native phone units SI, hardware monotonic timestamps retained.
- AGENTS.md, eight reusable specialist instructions, architecture, contracts and backlog created.
- Pinned Gradle/Android CI draft created: Kotlin2.1.21/AGP8.7.2/Gradle8.9/JDK17/API35/min26. Standard Ubuntu public runner with exact repository/branch guard. Artifact upload gated off pending storage allowance and permission. No cloud run or APK yet.
- Native ImuProtocol/PhoneSensors/BleClient and eight JUnit protocol tests implemented. Lead added MainActivity consent/placement, runtime permissions, initial-data/silence timeout, 123s clock, interruption, encrypted save/load, JSON export and deletion. Dashboard implemented; seven focused Node tests pass. JUnit/Android compilation not yet executed.
- Independent QA identified a stale history-load race and protocol clock including storage preparation; lead repaired both and documented acquisition-onset uncertainty. Exact physical-phone checklist in PHONE_TESTS.md (not run).

## Next implementation
1. Finish focused static verification and save a reviewable local commit/diff.
2. Request permission for public feature-branch push and zero-cost cloud run. Never main. Build failures repaired from real logs. Artifact delivery requires verified free storage. Branch push can upload after both variables are explicitly approved; no default-branch workflow installation required.
5. After acquisition milestone: audited gait reuse, structured safety/questions, real optional offline model runtime and physical benchmarks. Do not fabricate AI inference or clinical metrics.

## Device targets
Vivo Y29 (RAM unknown), Galaxy M31; baseline 6 GB, optimize 8 GB, explore 4 GB fallback. Quantized 0.5B–1.5B Qwen/Gemma candidates require measured peak RAM, startup, tokens/s, heat and battery. Optional models, independent acquisition/report/safety; no cloud AI.

## Efficiency policy (latest user override)
Default new tasks GPT-6.1 Sol/medium. High only for difficult integration; Astra/high only exceptional scientific/security failures. At most two concurrent subagents. Narrow disjoint tasks, concise handoffs, no repeated audits/research or successful tests. Lead model changes cannot be set by the subagent launcher; report only actual accepted subagent configurations.

## Unresolved blockers
- Feature branch pushed as 9d7f1db; cloud run 38444344382 in progress. Repair from actual logs only.
- Owner verified zero-spend blocking and no current usage. Public repository inventory: zero artifacts before push. Runtime guard rechecks sizes and caps total at 100 MiB before one-day uploads.
- No APK exists; all phone, on-device inference and clinical tests remain unexecuted.
- Newer V6.1.3 local bundle absent. Do not hold acquisition implementation for it.
