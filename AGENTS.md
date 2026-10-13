# VSPIMU Health Intelligence engineering rules

## Authority and baseline
- User's current Kotlin/cloud/zero-billing instructions supersede the older AI2 preferences in the comprehensive brief.
- Full brief read on 2026-10-13 from the user-supplied Downloads file. Do not upload that document or private records.
- Baseline: `7b3d271f196b2425a65f5294c1d74dba039dfaf1`. Work only on `codex/vspimu-health-intelligence`.
- Preserve all existing firmware, AI2 projects, reference bundles and research data byte-for-byte. Add implementation under `native-android/`, engineering records under `docs/health-intelligence/`, and CI under `.github/workflows/`.
- No Inertia-1. No API keys, remote inference, telemetry, paid runners, trials, billing activation, or sensitive-data uploads.
- No push, public repository mutation, merge, release or publication without the user's permission. Cloud builds require an authorized remote branch and verified free infrastructure. Do not install Android tooling on the user's PC.

## Coordination
- Lead owns architecture, contracts, integration, MainActivity and acceptance evidence. Eight specialist roles are defined in `agent-instructions/`.
- Assign one writer per module before edits. Shared checkout is allowed only with disjoint file ownership. Do not overwrite another agent's work or create competing branches in this shared checkout.
- Use actual subagents when beneficial; the user limits concurrency to two subagents. Default new work to GPT-6.1 Sol/medium; high only for difficult integration and Astra/high only exceptional scientific/security problems. Only claim models actually accepted by the launcher. No separate API calls. Preserve findings in HANDOFF.md; no repeated completed audits.
- Every handoff lists files, decisions, executed tests, unresolved failures and dependencies.

## Scientific and product boundaries
- Keep raw acquisition, quality, candidate metrics, interpretation, safety rules and AI presentation separate.
- Native phone timestamps are monotonic acquisition times; shank sequence time is nominal 208 Hz. BLE receipt time is transport evidence, not synchronized acquisition time.
- Keep shank and phone streams separate; record placement, missing sensors, interruptions, gaps, algorithm versions and uncertainty.
- No diagnostic claims, validated fall prediction, bilateral asymmetry, exact joint angles, speed/distance or foot clearance without suitable validation.
- Model unavailability must be explicit. A scripted fallback must never be described as LLM inference.
- Consent precedes recording and memory; export is a user action; deletion must be available. Health records stay private and encrypted.

## Verification
- Distinguish static checks, synthetic tests, JVM tests, Android builds, emulator tests, physical tests and clinical validation.
- Preserve logs and exact commands. No success claims for unexecuted builds or absent APKs.
- Review BLE operation serialization, permission denial, disconnects, lifecycle interruption, secure WebView origin and exported data.
