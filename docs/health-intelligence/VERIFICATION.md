# Verification record — acquisition milestone

**Updated:** Cloud build, 8 JVM tests, 7 JS tests, lint (0 errors/9 warnings), APK
assembly/signature, artifact upload and downloaded hash verification now pass for
`8e67862ea8c67086f329a1f6bc31c4e096f659c8`. See APK_MILESTONE.md for actual evidence.
The table below records the earlier pre-cloud state; its NOT RUN build rows are
superseded by that milestone. Physical/model/clinical tests remain NOT RUN.

Implementation commit: `dfca509e344108e939c24cd3073a474d45a33dbc` on `codex/vspimu-health-intelligence`.

| Check | Result | Scope |
|---|---|---|
| Existing `tests/test_v6_phone_imu.js` | 19 passed | Synthetic legacy add-on only |
| Existing V6 static HTML check | Passed, 120 unique IDs | HTML structure only |
| V5 executable JS syntax | Passed | Parse only, no TCN inference |
| Misnamed V6 gait JS syntax | Failed as expected | File is graph-model JSON; preserved |
| `node --test native-android/tests/dashboard.test.js` | 7 passed | Invalid/partial evidence, numeric limits, bounded text, safe DOM rendering |
| Independent raw golden bytes / CRC32 | Passed, `4d51577c` | Protocol layout only |
| Manifest XML / privacy flags | Passed | No INTERNET, backup off, cleartext off |
| Original tracked files | Unchanged | All implementation files are additive |
| Staged whitespace check | Passed | `git diff --cached --check` before commit |
| Narrow independent integration review | Three findings repaired | History generation race, preparation clock, declared magnitude units |
| Eight authored protocol JUnit tests | NOT RUN | Cloud build required |
| Kotlin/Android compilation and lint | NOT RUN | Awaiting public feature-branch push permission |
| APK generation / installation | NOT RUN | No APK exists |
| Physical BLE/phone, encrypted restore, export/delete | NOT RUN | PHONE_TESTS.md defines exact cases |
| Local LLM inference / RAM / battery | NOT IMPLEMENTED / NOT RUN | Acquisition remains independent |
| Clinical or reference-ground-truth accuracy | NOT VALIDATED | No clinical measurements claimed |

No Android SDK/toolchain was installed and no local APK build was run. No remote push,
workflow run, release or artifact upload occurred. No API billing, credentials or private
records were introduced. Model controls were actually accepted for subagent launches;
the lead cannot change its selected model through that interface. Latest routing is
Sol/medium and at most two concurrent subagents.

After cloud authorization, replace NOT RUN only using the actual run URL, source SHA,
test results, lint output and APK hash. A successful build does not establish physical
or clinical validity.
