"""
Stride length / stride height helpers shared by src/data_collector.py
(realtime) and stride_length_height.py (offline), so both use the same maths.

Two methods (select with stride_method: "hs" | "zupt")

  "hs"   HS -> HS (the original data_collector method, report section 8.3/8.4)
         length : forward-backward sigmoid velocity blend, |XY end point|
         height : linear velocity + height drift removal, max z
         Assumes zero foot velocity at heel strike (not exactly true).

  "zupt" mid-stance -> mid-stance (zero-velocity update)
         mid-stance = lowest |gyro| between HS and TO.  Foot flat at both
         ends -> v = 0 and z = 0 there, linear drift removal in between.
         Physically the better method, BUT it needs a correct orientation
         and unclipped acc/gyro.  With the current RYMO data (gyro ~8-10x
         under-scaled and clipped at ~0.6, quaternion rate saturating at
         ~6 rad/s, acc clipped at +-2g) the foot is not truly still at
         "mid-stance" and gravity leaks during swing, so it is not better
         yet.  Switch to it once the sensor range/scale is fixed.

Both methods still show negative foot heights (~-10 cm) on the current data;
that is the sensor problem above, not the integration method.
"""
from __future__ import annotations

from collections import deque

import numpy as np

G = 9.80665
BURST_DT_S = 0.010      # packets closer than this belong to one BLE burst
MAX_GAP_S = 0.30        # gaps longer than this are real data gaps

# accelerometer scale estimator
STILL_WIN = 15          # samples
STILL_MAX_GYRO = 0.05   # rad/s, every sample in the window
STILL_MAX_ACC_STD = 0.15
SCALE_ALPHA = 0.2       # EMA weight of a new still window
ACC_NORM_VALID = (6.0, 20.0)

# stride validity (shared by realtime summary and offline script)
STRIDE_TIME_VALID_S = (0.6, 2.5)
LENGTH_VALID_M = (0.2, 2.5)
HEIGHT_VALID_M = (0.0, 0.5)
# HS -> HS method: if forward-only and backward-only integration end up
# pointing more than this far apart, the sigmoid blend cancels out and the
# stride length is meaningless (seen as 0.06-0.13 m strides).
FB_MAX_ANGLE_DEG = 120.0


def integrate(t: np.ndarray, sig: np.ndarray) -> np.ndarray:
    """Trapezoidal cumulative integral starting at 0 (1-D or (N, k))."""
    sig = np.asarray(sig, dtype=float)
    out = np.zeros_like(sig)
    dt = np.diff(np.asarray(t, dtype=float))
    if sig.ndim == 1:
        out[1:] = np.cumsum(0.5 * (sig[1:] + sig[:-1]) * dt)
    else:
        out[1:] = np.cumsum(0.5 * (sig[1:] + sig[:-1]) * dt[:, None], axis=0)
    return out


def respace_bursts(t: np.ndarray) -> np.ndarray:
    """
    BLE packets arrive in bursts with almost identical arrival times although
    the sensor sampled them over the previous interval.  Spread each burst
    evenly over (previous burst time, this burst time].  Long gaps stay gaps.
    """
    t = np.asarray(t, dtype=float)
    if len(t) < 3:
        return t.copy()
    nominal_dt = (t[-1] - t[0]) / (len(t) - 1)
    starts = np.r_[0, np.flatnonzero(np.diff(t) > BURST_DT_S) + 1]
    ends = np.r_[starts[1:], len(t)]
    out = t.copy()
    for k, (s, e) in enumerate(zip(starts, ends)):
        n = e - s
        if k == 0 or n == 1:
            continue
        span = t[s] - t[starts[k - 1]]
        if span > MAX_GAP_S:
            span = n * nominal_dt
        out[s:e] = t[s] - span + span * np.arange(1, n + 1) / n
    return np.maximum.accumulate(out)


def mid_stance_index(t: np.ndarray, gyro_norm: np.ndarray, hs_time: float, to_time: float):
    """Index of the quietest sample (3-point smoothed |gyro|) in [HS, TO]."""
    idx = np.flatnonzero((t >= hs_time) & (t <= to_time))
    if len(idx) == 0:
        return None
    g = np.asarray(gyro_norm, dtype=float)[idx]
    if len(g) >= 3:
        g = np.convolve(np.pad(g, 1, mode="edge"), np.ones(3) / 3, mode="valid")
    return int(idx[int(np.argmin(g))])


def hs_stride(t: np.ndarray, acc_lin_world: np.ndarray, sigmoid_k: float = 10.0):
    """
    Original data_collector method on an HS -> HS segment.
    Returns (stride_length_m, stride_height_m, min_height_m, position (N,3)).
    """
    t = np.asarray(t, dtype=float)
    a = np.asarray(acc_lin_world, dtype=float)
    if len(t) < 3 or t[-1] - t[0] <= 0:
        return np.nan, np.nan, np.nan, np.zeros((len(t), 3))
    tau = (t - t[0]) / (t[-1] - t[0])
    vel_fwd = integrate(t, a[:, :2])
    vel_bwd = integrate(t[::-1], a[::-1, :2])[::-1]
    w = 1.0 / (1.0 + np.exp(-sigmoid_k * (tau - 0.5)))
    pos_xy = integrate(t, (1.0 - w)[:, None] * vel_fwd + w[:, None] * vel_bwd)
    vz = integrate(t, a[:, 2])
    vz -= tau * vz[-1]
    z = integrate(t, vz)
    z -= tau * z[-1]
    pos = np.column_stack([pos_xy - pos_xy[:1], z])
    return float(np.linalg.norm(pos[-1, :2])), float(np.max(z)), float(np.min(z)), pos


def fb_disagreement_deg(t: np.ndarray, acc_lin_world: np.ndarray) -> float:
    """
    Angle between the forward-only and backward-only integrated horizontal
    displacement of an HS -> HS stride.  Near 0 = both agree on the walking
    direction; > FB_MAX_ANGLE_DEG = they point opposite ways, the blend
    cancels and the stride length cannot be trusted.
    """
    t = np.asarray(t, dtype=float)
    a = np.asarray(acc_lin_world, dtype=float)[:, :2]
    if len(t) < 3 or t[-1] - t[0] <= 0:
        return float("nan")
    p_fwd = integrate(t, integrate(t, a))[-1]
    p_bwd = integrate(t, integrate(t[::-1], a[::-1])[::-1])[-1]
    n_f, n_b = np.linalg.norm(p_fwd), np.linalg.norm(p_bwd)
    if n_f < 1e-6 or n_b < 1e-6:
        return float("nan")
    return float(np.degrees(np.arccos(np.clip(p_fwd @ p_bwd / (n_f * n_b), -1.0, 1.0))))


def stride_invalid_reasons(stride_time: float, length: float, height: float,
                           fb_angle: float = float("nan")) -> list:
    """Why a stride should not be used (empty list = valid)."""
    reasons = []
    if not (np.isfinite(stride_time) and STRIDE_TIME_VALID_S[0] <= stride_time <= STRIDE_TIME_VALID_S[1]):
        reasons.append("stride time")
    if np.isfinite(fb_angle) and fb_angle > FB_MAX_ANGLE_DEG:
        reasons.append(f"integration inconsistent (fwd/bwd {fb_angle:.0f} deg apart)")
    if not (np.isfinite(length) and LENGTH_VALID_M[0] <= length <= LENGTH_VALID_M[1]):
        reasons.append("length out of range")
    if not (np.isfinite(height) and HEIGHT_VALID_M[0] <= height <= HEIGHT_VALID_M[1]):
        reasons.append("height out of range")
    return reasons


def zupt_stride(t: np.ndarray, acc_lin_world: np.ndarray):
    """
    Integrate gravity-free world acceleration between two mid-stances.
    Returns (stride_length_m, stride_height_m, min_height_m, position (N,3)).
    """
    t = np.asarray(t, dtype=float)
    a = np.asarray(acc_lin_world, dtype=float)
    if len(t) < 3 or t[-1] - t[0] <= 0:
        return np.nan, np.nan, np.nan, np.zeros((len(t), 3))
    tau = (t - t[0]) / (t[-1] - t[0])
    vel = integrate(t, a)
    vel -= tau[:, None] * vel[-1]          # ZUPT: v = 0 at both mid-stances
    pos = integrate(t, vel)
    pos[:, 2] -= tau * pos[-1, 2]          # foot flat on the same floor at both ends
    return (float(np.linalg.norm(pos[-1, :2])), float(np.max(pos[:, 2])),
            float(np.min(pos[:, 2])), pos)


class AccScaleEstimator:
    """
    The RYMO accelerometer does not read 9.81 at rest (~13 m/s^2 seen).
    Whenever the sensor is still (low gyro, steady |acc|) the mean |acc| is
    tracked and scale = g / |acc_still| is returned.  1.0 until the first
    still window has been seen.
    """

    def __init__(self) -> None:
        self.acc_norm: float | None = None
        self._acc = deque(maxlen=STILL_WIN)
        self._gyr = deque(maxlen=STILL_WIN)

    def reset(self) -> None:
        self.acc_norm = None
        self._acc.clear()
        self._gyr.clear()

    @property
    def scale(self) -> float:
        return G / self.acc_norm if self.acc_norm else 1.0

    def update(self, acc: np.ndarray, gyro: np.ndarray) -> float:
        self._acc.append(float(np.linalg.norm(acc)))
        self._gyr.append(float(np.linalg.norm(gyro)))
        if len(self._acc) == STILL_WIN and max(self._gyr) < STILL_MAX_GYRO \
                and np.std(self._acc) < STILL_MAX_ACC_STD:
            m = float(np.mean(self._acc))
            if ACC_NORM_VALID[0] <= m <= ACC_NORM_VALID[1]:
                self.acc_norm = m if self.acc_norm is None else \
                    (1 - SCALE_ALPHA) * self.acc_norm + SCALE_ALPHA * m
        return self.scale

def _robust_scale(values: np.ndarray) -> float:
    """Robust scale estimate using MAD; never uses neighbouring-value copying."""
    x = np.asarray(values, dtype=float)
    x = x[np.isfinite(x)]
    if x.size < 3:
        return 0.05
    med = float(np.median(x))
    mad = float(np.median(np.abs(x - med)))
    return max(1.4826 * mad, 0.02)


def _robust_state(values: np.ndarray, quality: np.ndarray, q: float) -> np.ndarray:
    """
    Huber random-walk state estimate.

    This is a robust measurement model, not neighbour-value reconstruction:
    each cycle keeps its own measurement and its quality controls its weight.
    """
    y = np.asarray(values, dtype=float)
    qual = np.asarray(quality, dtype=float)
    n = len(y)
    out = np.full(n, np.nan, dtype=float)

    good = np.isfinite(y)
    if not np.any(good):
        return out

    med = float(np.median(y[good]))
    scale = _robust_scale(y[good])
    Q = max((q * max(abs(med), scale)) ** 2, (0.005 * scale) ** 2)

    quality_clipped = np.clip(np.where(np.isfinite(qual), qual, 0.1), 0.1, 1.0)
    R = np.where(
        good,
        (scale ** 2) / (0.10 + 0.90 * quality_clipped) + 1e-6,
        1e9,
    )

    first = int(np.flatnonzero(good)[0])
    x = float(y[first])
    P = float(R[first])
    xf = np.zeros(n, dtype=float)
    Pf = np.zeros(n, dtype=float)

    for i in range(n):
        if i:
            P += Q

        if good[i]:
            innovation = float(y[i] - x)
            s = float(np.sqrt(P + R[i]))
            u = abs(innovation) / max(s, 1e-9)

            # Huber down-weighting of an isolated integration outlier.
            huber_w = 1.0 if u <= 2.5 else 2.5 / u
            Ri = R[i] / huber_w
            K = P / (P + Ri)
            x += K * innovation
            P = (1.0 - K) * P

        xf[i] = x
        Pf[i] = P

    # Rauch-Tung-Striebel-style backward pass.
    xs = xf.copy()
    for i in range(n - 2, -1, -1):
        pp = Pf[i] + Q
        C = Pf[i] / max(pp, 1e-12)
        xs[i] = xf[i] + C * (xs[i + 1] - xf[i])

    return xs


def robust_spatial_correction(rows: list) -> None:
    """
    Robustly stabilize per-cycle spatial estimates in-place.

    Compatibility contract:
      - accepts data_collector.realtime_temporal_rows directly
      - does NOT modify HS/TO timestamps
      - does NOT change raw IMU samples
      - does NOT copy a neighbouring cycle's value
      - preserves original spatial measurements in private row keys
      - only replaces finite spatial estimates with a Huber state estimate

    The correction is deliberately spatial-only. Temporal validity flags and
    gait-event timings remain controlled by data_collector.py.
    """
    if not rows:
        return

    length = np.array(
        [r.get("stride_length_m", np.nan) for r in rows], dtype=float
    )
    height = np.array(
        [r.get("stride_height_m", np.nan) for r in rows], dtype=float
    )

    fb = np.array(
        [r.get("fb_angle_deg", np.nan) for r in rows], dtype=float
    )
    valid = np.array(
        [bool(r.get("valid", False)) for r in rows], dtype=bool
    )

    # Keep an explicit in-memory copy of the physical measurement before
    # applying the robust estimator. These are not used as replacement values.
    for i, r in enumerate(rows):
        r["_raw_stride_length_m"] = (
            float(length[i]) if np.isfinite(length[i]) else np.nan
        )
        r["_raw_stride_height_m"] = (
            float(height[i]) if np.isfinite(height[i]) else np.nan
        )

    # Measurement quality is derived only from the cycle's own diagnostics.
    # Valid cycles start at full weight; large forward/backward disagreement
    # lowers confidence. Invalid cycles are never allowed to become valid here.
    quality = np.where(valid, 1.0, 0.2)
    finite_fb = np.isfinite(fb)
    quality[finite_fb] *= np.exp(-np.clip(fb[finite_fb], 0.0, 180.0) / 180.0)
    quality = np.clip(quality, 0.1, 1.0)

    length_est = _robust_state(length, quality, 0.18)
    height_est = _robust_state(height, quality, 0.45)

    for i, r in enumerate(rows):
        if np.isfinite(length_est[i]):
            r["stride_length_m"] = float(length_est[i])
        if np.isfinite(height_est[i]):
            r["stride_height_m"] = float(height_est[i])
        r["spatial_raw_preserved"] = True
        r["spatial_neighbour_reconstruction"] = False

