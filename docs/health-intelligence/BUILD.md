# Android build and delivery

## Status and scope

The build definition is prepared locally. No Android SDK was installed on the
user's PC, no cloud build was dispatched, and no APK exists merely because these
files exist. Public source push, workflow installation, dispatch, release and
publication require the user's permission. Private health records, the Downloads
brief and research data must never be uploaded as CI inputs or artifacts.

## Pinned build choices

| Component | Choice |
| --- | --- |
| Kotlin Android plugin | 2.1.21 |
| Android Gradle plugin | 8.7.2 |
| Gradle | 8.9, installed by CI; no local wrapper required |
| Java runtime and compilation target | Temurin JDK 17 / JVM 17 |
| Android SDK / build tools | compile and target 35 / 35.0.0 |
| Minimum Android API | 26 |
| Package | org.vspimu.health |
| WebView asset loader | androidx.webkit:webkit:1.12.1 |
| JVM tests | junit:junit:4.13.2 |

JDK 17 selects the supported major release; its security patch is supplied by
setup-java and recorded in the action log. Hosted Ubuntu image and Android command
line tools also receive updates. This is a pinned dependency/build stack, not a
bit-for-bit reproducible runner image. Action commits are pinned to verified full
SHAs. Read-only `git ls-remote` against their official repositories verified these
pins on 2026-10-13; no remote mutation was performed.

Kotlin's [compatibility table](https://kotlinlang.org/docs/gradle-configure-project.html)
supports Kotlin 2.1.21 with Gradle 8.9 and AGP 8.7.2. Android's
[AGP 8.7 compatibility notes](https://developer.android.com/build/releases/agp-8-7-0-release-notes)
require Gradle 8.9 and JDK 17 and support API 35.

## Authorized cloud checks

`.github/workflows/android-apk.yml` listens only to relevant pushes on
`codex/vspimu-health-intelligence`, plus an optional manual dispatch. Its job guard
requires the exact `vyomstudent/IMU-v5` repository, a public event repository and
that branch before allocating the standard `ubuntu-24.04` runner. It has read-only
repository permissions, a 25-minute timeout, no persistent dependency cache and
no dependency graph submission. No larger runners or paid services are used.

After permission to push the reviewed source and workflow, the push performs:

```text
bash native-android/ci/test-dashboard.sh
gradle --no-daemon --console=plain testDebugUnitTest lintDebug assembleDebug
```

The Gradle command runs inside `native-android`. Dashboard discovery runs Node's
test runner on `native-android/tests/*.test.js`, `.test.cjs` and `.test.mjs`. When
none exist it explicitly reports their absence. CI uses runner-provided Node;
record its version when investigating any test-runtime discrepancy.

Passing these checks establishes JVM test, lint and debug assembly evidence only.
It does not establish BLE hardware behavior, Android runtime permission handling,
emulator behavior, sensor validity, LLM execution or clinical validation. Review
logs and source commit before claiming a successful Android build.

## Zero-billing boundary and downloadable APK

GitHub documents standard public-repository runners as
[free and unlimited](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Larger runners are always charged. GitHub's
[billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
separately describes shared artifact/Packages storage allowances (500 MB on Free),
hourly accrual and charges above allowances. A public runner alone is insufficient
evidence to guarantee that storing an APK cannot incur a charge. Logs and job
summaries do not consume the artifact allowance.

Therefore upload is disabled by default. A successful
default run checks and hashes the APK, then the ephemeral runner removes it. It
does **not** provide a downloadable APK or satisfy the final APK delivery target.

Before an artifact-producing run:

1. Obtain user authorization for the required public repository changes and run.
2. Verify owner-level available Actions/Packages storage and a zero-spend blocking
   budget or absence of a payment method. Do not activate billing, change plans or
   raise paid allowances. Include all account repositories in the storage check.
3. Obtain explicit authorization to set repository variable
   `VSPIMU_ARTIFACT_ALLOWANCE_VERIFIED=true` after that verification. This variable
   is an attestation, not a live quota meter; recheck before each upload.
4. With permission, set `VSPIMU_APK_UPLOAD_APPROVED=true` for an artifact-producing
   feature-branch push, then disable it after retrieval. No default-branch change
   is required. Alternatively manual `upload_apk=true` works only once a workflow
   is already present on the default branch; do not modify main for this purpose.
   [Manual dispatch restrictions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch).
5. Push the authorized feature-branch commit. Both upload approval and the verified
   allowance are required. APK and synthetic test/lint reports use one-day retention.
   No health records are uploaded. Minimum supported retention is one day, not zero.
6. Download the artifact ZIP from the successful run, extract `app-debug.apk`,
   compare its SHA-256 with the job summary, and preserve the exact commit, run URL
   and logs with the delivered APK. Download before its one-day expiration.

Do not label final APK delivery complete until the APK is downloaded and verified.
An artifact quota error is a delivery failure even when compilation succeeded.
One-day retention limits storage duration; it does not independently prove zero
cost. See the official [upload-artifact limits](https://github.com/actions/upload-artifact).

The debug APK is for authorized testing. No release signing key or store publish
credentials are configured. Phone installation and physical validation need a
separate test record.
