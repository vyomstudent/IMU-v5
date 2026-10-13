# Android build and delivery

## Status and scope

The owner authorized feature-branch pushes, routine repairs and standard free
Ubuntu cloud checks. The first authorized run is
https://github.com/vyomstudent/IMU-v5/actions/runs/38444344382 . No Android tooling
was installed or APK built on the user's PC. Main, merge, release and other
publication remain prohibited. Private health records, the Downloads
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

The owner has verified zero-spend blocking for Actions and Packages, no existing
metered usage, and authorized one-day debug APK uploads within the free allowance.
Read-only public API inspection found zero repository artifacts before the first
push. No billing setting or spending budget was changed by the agent.

The runtime guard `native-android/ci/check-artifact-budget.py` checks all accessible
repository artifact pages and sums unexpired storage. It requires a base APK of
at most 40 MiB, synthetic reports at most 10 MiB, and a conservative combined
retained-plus-planned limit of 100 MiB including archive overhead. This leaves
headroom inside the 500 MB included allowance; it does not measure other account
repositories or Packages. Owner verification and enforced zero-spend blocking
remain the account-wide safeguard. If inventory fails, limits are exceeded or
GitHub rejects storage, upload stops. Never bypass this check or alter billing.

Both APK and synthetic report uploads depend on the successful budget step. Each
artifact is retained for one day. The branch push trigger builds and uploads;
no workflow installation or change on main is necessary. Manual dispatch remains
optional and subject to GitHub's default-branch workflow requirement.

After a successful run, download its artifact ZIP, extract `app-debug.apk`, and
match the APK SHA-256 against the cloud job log. Preserve source SHA, run URL,
size and checksum. Do not label delivery complete merely because assembly passed.
Physical phone validation is separate. Logs and job summaries remain available
without persistent artifact storage.

The debug APK is for authorized testing. No release signing key or store publish
credentials are configured. Phone installation and physical validation need a
separate test record.
