# Architecture decision 001 — additive native Android application

Status: implementation direction after full brief read and baseline inspection; legacy source audit still being completed.

Kotlin owns BLE, phone SensorEvent acquisition, lifecycle, encrypted storage, permissions and user-directed export. A bundled WebView displays evidence and reusable analytics through a narrow data contract. This replaces the older AI2-first preference only for the new app; existing projects stay unchanged.

The first milestone is foreground-only recording: explicit consent and placement; connect and verify BLE; record the 123-second protocol with native phone timestamps; stop on interruption; persist privately; inspect quality and export the record. Acquisition correctness precedes clinical inference. An interruption yields a partial session, not a normal completion. Cross-device synchronization remains unvalidated.

Legacy assets must pass executable-source, dependency and model checks before packaging. The repository's V6 README is older than some bundled files. A file named `v6_gait.js` appears to contain model JSON, so importing filenames blindly is unsafe. The original files remain preserved; audited extraction/adaptation belongs in new assets only.

Offline companion will use an Android-compatible local runtime with user-selected, licensed model assets and clear hardware requirements. Runtime/model feasibility is a separate gate. Until real inference is integrated and run, UI must say unavailable; deterministic explanations may remain usable. No cloud AI endpoint or user API key.

Cloud Android build: pinned Kotlin/AGP/Gradle/JDK on a standard GitHub public Linux runner, restricted to this branch/repository. Artifact retention/storage must be verified independently of runner pricing. The user's public-push permission is required before remote execution. Existing local SDK presence does not authorize a local APK build under the cloud requirement.

Security: bundled origin, blocked remote requests, no arbitrary JavaScript bridge, no Internet permission, AES-GCM/Keystore storage, disabled backups, explicit export/deletion. No private records in tests or CI. Research evidence is versioned separately from generated prose.
