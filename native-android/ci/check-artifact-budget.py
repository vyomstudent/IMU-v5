"""Fail closed before upload; owner verified zero-spend blocking and unused allowance.

Only synthetic reports and the base debug APK are eligible. This checks repository
artifacts, not account-wide Packages usage; the owner's account verification remains
required. Never change billing or retry a quota rejection by bypassing this guard.
"""
import json
import os
from pathlib import Path
import urllib.request

repo = os.environ.get("GITHUB_REPOSITORY")
assert repo == "vyomstudent/IMU-v5", "Unexpected repository"
assert os.environ.get("GITHUB_REF") == "refs/heads/codex/vspimu-health-intelligence", "Unexpected branch"
apk = Path("native-android/app/build/outputs/apk/debug/app-debug.apk")
assert apk.is_file() and 0 < apk.stat().st_size <= 40 * 1024**2, "Missing or oversized base APK"
existing = 0
for page in range(1, 11):
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/actions/artifacts?per_page=100&page={page}",
        headers={"Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
                 "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    rows = payload["artifacts"]
    existing += sum(row["size_in_bytes"] for row in rows if not row["expired"])
    if len(rows) < 100:
        break
else:
    raise RuntimeError("Artifact inventory exceeds bounded inspection; upload blocked")
report_roots = [Path("native-android/app/build/reports/tests"), Path("native-android/app/build/test-results")]
reports = sum(p.stat().st_size for root in report_roots for p in root.rglob("*") if p.is_file())
reports += sum(p.stat().st_size for p in Path("native-android/app/build/reports").glob("lint-results-debug.*") if p.is_file())
assert reports <= 10 * 1024**2, "Test report upload exceeds reserved storage"
planned = apk.stat().st_size + reports + 1024**2  # Conservative archive overhead reserve.
assert existing + planned <= 100 * 1024**2, "Repository artifact budget exceeded; upload blocked"
print(f"Artifact budget passed: retained={existing} bytes, APK={apk.stat().st_size} bytes, reports={reports} bytes; cap=100 MiB.")
with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
    output.write("allowed=true\n")
