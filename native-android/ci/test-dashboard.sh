#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root. Test filenames are owned by the UI specialist.
shopt -s nullglob
tests=(native-android/tests/*.test.js native-android/tests/*.test.cjs native-android/tests/*.test.mjs)
if ((${#tests[@]})); then
  node --test "${tests[@]}"
else
  message='Dashboard JS tests absent: no JavaScript test success is claimed.'
  echo "$message"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "$message" >> "$GITHUB_STEP_SUMMARY"
  fi
fi
