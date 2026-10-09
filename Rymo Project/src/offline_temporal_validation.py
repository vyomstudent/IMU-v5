import sys
import numpy as np
import pandas as pd

from realtime_batch_from_treadmill import (
    compute_rt_thresholds_from_reference,
    run_rt_fixed_events,
)

FS = 60.0


def compute_temporal_parameters(csv_path: str):

    df = pd.read_csv(csv_path)

    gyro = df["gyr_y"].to_numpy(dtype=float)
    gyro = df["gyr_y"].to_numpy(dtype=float)
    timestamps = df["timestamp"].to_numpy(dtype=float)

    CALIBRATION_SECONDS = 10
    calib_samples = int(CALIBRATION_SECONDS * FS)

    # First 10 s used only for threshold computation
    calib_gyro = gyro[:calib_samples]

    right_thr, _ = compute_rt_thresholds_from_reference(
        calib_gyro,
        calib_gyro,
        FS
    )
    print("\n===== OFFLINE THRESHOLDS =====")
    print(right_thr)

    # Remove calibration section from event detection
    gyro = gyro[calib_samples:]
    timestamps = timestamps[calib_samples:]

    # Remove calibration section from event detection
    gyro = gyro[calib_samples:]
    timestamps = timestamps[calib_samples:]

    result = run_rt_fixed_events(
        gyro,
        fs=FS,
        hs_thr=right_thr["hs_thr"],
        to_thr=right_thr["to_thr"],
        to_prev_min=right_thr["to_prev_min"],
        to_prev_max=right_thr["to_prev_max"],
    )

    hs_idx, to_idx = run_rt_fixed_events(
    gyro,
    fs=FS,
    hs_thr=right_thr["hs_thr"],
    to_thr=right_thr["to_thr"],
    to_prev_min=right_thr["to_prev_min"],
    to_prev_max=right_thr["to_prev_max"],
)

    hs_idx = np.asarray(hs_idx)
    to_idx = np.asarray(to_idx)

    hs_times = timestamps[hs_idx]
    to_times = timestamps[to_idx]

    print("\n===== OFFLINE EVENTS =====")
    print("HS events:", len(hs_times))
    print("TO events:", len(to_times))

    stride_times = np.diff(hs_times)

    stance_times = []
    for hs, to in zip(hs_times, to_times):
        if to > hs:
            stance_times.append(to - hs)

    swing_times = []
    for i in range(
        min(
            len(to_times),
            len(hs_times) - 1
        )
    ):
        swing_times.append(
            hs_times[i + 1] - to_times[i]
        )

    stance_times = np.asarray(stance_times)
    swing_times = np.asarray(swing_times)

    print("\n===== OFFLINE TEMPORAL PARAMETERS =====")

    print(
        "Mean Stride Time:",
        float(np.mean(stride_times)),
        "s"
    )

    print(
        "Cadence:",
        float(120.0 / np.mean(stride_times)),
        "steps/min"
    )

    print(
        "Mean Stance Time:",
        float(np.mean(stance_times)),
        "s"
    )

    print(
        "Mean Swing Time:",
        float(np.mean(swing_times)),
        "s"
    )

    n = min(
        len(stride_times),
        len(stance_times),
        len(swing_times)
    )

    rows = []

    n = min(
        len(stride_times),
        len(stance_times),
        len(swing_times)
    )

    for i in range(n):
        rows.append({
            "cycle": i + 1,
            "hs_time": hs_times[i],
            "to_time": to_times[i],
            "next_hs_time": hs_times[i + 1],
            "stride_time_s": stride_times[i],
            "stance_time_s": stance_times[i],
            "swing_time_s": swing_times[i]
        })

    rows.append({
        "cycle": "MEAN",
        "hs_time": "",
        "to_time": "",
        "next_hs_time": "",
        "stride_time_s": np.mean(stride_times),
        "stance_time_s": np.mean(stance_times),
        "swing_time_s": np.mean(swing_times)
    })

    rows.append({
        "cycle": "CADENCE",
        "hs_time": "",
        "to_time": "",
        "next_hs_time": "",
        "stride_time_s": 120.0 / np.mean(stride_times),
        "stance_time_s": "",
        "swing_time_s": ""
    })

    temporal_df = pd.DataFrame(rows)

    output_csv = csv_path.replace(
        ".csv",
        "_offline_temporal.csv"
    )

    temporal_df.to_csv(
        output_csv,
        index=False
    )

    print(
        "\nSaved:",
        output_csv
    )


if __name__ == "__main__":

    if len(sys.argv) != 2:
        print(
            "Usage: python offline_temporal_validation.py <trial_csv>"
        )
        sys.exit(1)

    compute_temporal_parameters(
        sys.argv[1]
    )