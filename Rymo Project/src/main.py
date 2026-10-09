#!/usr/bin/env python3
"""
main.py
=======

Recording workflow:

1. Enter participant information.
2. Connect/warm up BLE sensors.
3. Ask participant to stand still and confirm readiness.
4. Allow a 15-second static standing/stabilization period.
5. Ask participant to confirm readiness to walk.
6. 3-2-1 countdown.
7. Start recording and dynamic walking calibration.
8. Automatically record for 15 seconds.
9. Stop and flush the CSV files automatically.

The existing BLE/Docker data collection pipeline is kept unchanged.
"""

from __future__ import annotations

import asyncio
import argparse
import logging
from pathlib import Path

import yaml

# ---- project classes -------------------------------------------------------
from calibration_main import IMUCalibrator
from data_collector import TrialDataLogger
# ---------------------------------------------------------------------------

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

_BLE_WARMUP_LOGGER: TrialDataLogger | None = None

# Keep the experimental timing consistent.
STATIC_STANDING_SECONDS = 15
WALKING_RECORDING_SECONDS = 15
COUNTDOWN_SECONDS = 3


# ────────────────────────────────────────────────────────────────────────────
# Participant information
# ────────────────────────────────────────────────────────────────────────────

def prompt_subject_info(subject_name: str) -> dict:
    """Prompt for participant metrics and return them as a dict."""

    log.info("Entering participant details (leave blank to skip a field)…")

    def _num(prompt: str):
        raw = input(prompt).strip()
        return float(raw) if raw else None

    height = _num("Height (cm): ")
    weight = _num("Weight (kg): ")

    thigh_len = _num("Thigh segment length (cm): ")
    shank_len = _num("Shank segment length (cm): ")
    foot_len = _num("Foot segment length (cm): ")

    return {
        "subject_name": subject_name,
        "height_cm": height,
        "weight_kg": weight,
        "segment_lengths_cm": {
            "thigh": thigh_len,
            "shank": shank_len,
            "foot": foot_len,
        },
    }


def load_or_prompt_subject_info() -> tuple[dict, Path]:
    """Load existing subject YAML or create it once."""

    subject_name = input("Participant name (no spaces): ").strip()

    if not subject_name:
        raise ValueError("Participant name cannot be empty.")

    root = Path("data") / subject_name
    info_path = root / "subject_info.yml"

    if info_path.exists():
        subj = yaml.safe_load(info_path.read_text()) or {}
        log.info("Loaded existing subject info for '%s'.", subject_name)
    else:
        root.mkdir(parents=True, exist_ok=True)
        subj = prompt_subject_info(subject_name)
        info_path.write_text(yaml.dump(subj, sort_keys=False))
        log.info("Saved new subject info to %s", info_path)

    return subj, root


# ────────────────────────────────────────────────────────────────────────────
# BLE
# ────────────────────────────────────────────────────────────────────────────

async def run_calibration(root: Path):
    """Keep the original explicit calibration mode available."""

    global _BLE_WARMUP_LOGGER

    calib = IMUCalibrator(packet_source=_BLE_WARMUP_LOGGER)

    await calib.initialize()

    try:
        await calib.run_calibration_sequence(rotation_matrices_dict=str(root))
    finally:
        await calib.shutdown()


async def warmup_ble_connection(root: Path) -> None:
    """Connect to BLE before asking the participant to start."""

    global _BLE_WARMUP_LOGGER

    log.info("Warming up BLE sensors before recording...")

    warmup = TrialDataLogger(
        root_dir=str(root),
        enable_ble=True,
        capture_only=False,
    )

    try:
        await warmup.connect_ble_only()
        _BLE_WARMUP_LOGGER = warmup
        log.info("BLE warmup complete.")
    except Exception as exc:
        log.warning("BLE warmup failed: %s", exc)


# ────────────────────────────────────────────────────────────────────────────
# Small user-interface helpers
# ────────────────────────────────────────────────────────────────────────────

def ask_yes_no(message: str) -> bool:
    """Keep asking until the user enters y or n."""

    while True:
        answer = input(f"{message} (y/n): ").strip().lower()

        if answer in ("y", "yes"):
            return True

        if answer in ("n", "no"):
            return False

        print("Please enter y or n.")


async def countdown(seconds: int) -> None:
    """Display a simple countdown."""

    for remaining in range(seconds, 0, -1):
        print(f"\nStarting in {remaining}...")
        await asyncio.sleep(1)

    print("\n🔴 RECORDING STARTED")


async def static_standing_phase() -> None:
    """
    Static standing/stabilization period.

    This phase intentionally does not write walking-trial rows.
    It gives the participant/sensor a stable standing period before walking.
    """

    print("\n" + "=" * 60)
    print("STATIC STANDING / SENSOR STABILIZATION")
    print("=" * 60)
    print("Stand still with both feet in the required position.")
    print(f"Static phase: {STATIC_STANDING_SECONDS} seconds")
    print("=" * 60)

    for remaining in range(STATIC_STANDING_SECONDS, 0, -1):
        print(f"\rStanding still... {remaining:02d} s remaining", end="", flush=True)
        await asyncio.sleep(1)

    print("\n✓ Static standing phase complete.")


# ────────────────────────────────────────────────────────────────────────────
# Recording workflow
# ────────────────────────────────────────────────────────────────────────────

async def run_recording(
    root: Path,
    logger: TrialDataLogger | None = None,
    simulate_chunk_hex: str | None = None,
    simulate_repeat: int = 1,
    simulate_device: str = "both",
):
    """
    New recording workflow:

        Ready to stand?
            ↓
        15 s standing
            ↓
        Ready to walk?
            ↓
        3-2-1
            ↓
        15 s recording

    The existing TrialDataLogger handles CSV writing and flushing.
    """

    if logger is None:
        logger = TrialDataLogger(
            root_dir=str(root),
            enable_ble=(simulate_chunk_hex is None),
        )

    # Start the writer/processing system. BLE is already connected when the
    # normal warmup path is used.
    await logger.start()

    try:
        print("\n" + "=" * 60)
        print("GAIT DATA COLLECTION")
        print("=" * 60)

        # ---------------------------------------------------------------
        # STEP 1 — Standing still
        # ---------------------------------------------------------------
        ready_standing = ask_yes_no(
            "Ready to start standing still?"
        )

        if not ready_standing:
            print("\nRecording cancelled before the trial started.")
            return

        await static_standing_phase()

        # ---------------------------------------------------------------
        # STEP 2 — Walking readiness
        # ---------------------------------------------------------------
        ready_walk = ask_yes_no(
            "Ready to walk?"
        )

        if not ready_walk:
            print("\nWalking trial cancelled.")
            return

        # ---------------------------------------------------------------
        # STEP 3 — Countdown
        # ---------------------------------------------------------------
        await countdown(COUNTDOWN_SECONDS)

        # ---------------------------------------------------------------
        # STEP 4 — Actual walking recording
        # ---------------------------------------------------------------
        #
        # TrialDataLogger._handle_start():
        #   - resets trial state
        #   - starts recording
        #   - starts its calibration timer
        #
        # data_collector.py now uses 15 seconds for this dynamic
        # walking calibration period.
        #
        await logger._handle_start()

        print(
            f"\nWalking + dynamic calibration recording: "
            f"{WALKING_RECORDING_SECONDS} seconds"
        )

        for remaining in range(WALKING_RECORDING_SECONDS, 0, -1):
            print(
                f"\rWalking... {remaining:02d} s remaining",
                end="",
                flush=True,
            )
            await asyncio.sleep(1)

        print("\n")

        # ---------------------------------------------------------------
        # STEP 5 — Automatic stop + CSV flush
        # ---------------------------------------------------------------
        await logger._handle_stop()

        print("\n" + "=" * 60)
        print("✓ 15-SECOND WALKING TRIAL COMPLETE")
        print("✓ CSV DATA FLUSHED")
        print("=" * 60)

    finally:
        # Disconnect BLE and stop the logger cleanly.
        await logger.stop()
        log.info("Recording session ended.")


# ────────────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--simulate-chunk-hex",
        default=None,
        help="Hex string for a synthetic BLE chunk.",
    )

    parser.add_argument(
        "--simulate-repeat",
        type=int,
        default=1,
        help="How many times to inject the synthetic chunk.",
    )

    parser.add_argument(
        "--simulate-device",
        default="both",
        help="Target device: left, right, left/foot, right/foot, or both.",
    )

    args = parser.parse_args()

    _, root = load_or_prompt_subject_info()

    # Connect BLE first so the participant does not have to wait after
    # answering the readiness questions.
    await warmup_ble_connection(root)

    choice = input(
        "\nCalibrate (c) or Record data (r)? "
    ).strip().lower()

    if choice.startswith("c"):
        await run_calibration(root)

    elif choice.startswith("r"):
        if _BLE_WARMUP_LOGGER is None and args.simulate_chunk_hex is None:
            log.error("BLE connection is not available. Cannot start recording.")
            return

        await run_recording(
            root,
            logger=_BLE_WARMUP_LOGGER,
            simulate_chunk_hex=args.simulate_chunk_hex,
            simulate_repeat=args.simulate_repeat,
            simulate_device=args.simulate_device,
        )

    elif choice.startswith("p"):
        log.info("Prediction mode not yet implemented.")

    else:
        log.error("Invalid choice – exiting.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Interrupted – goodbye!")
