#!/usr/bin/env python3
"""
imu_pressure_logger_trials_files.py
-----------------------------------
• BLE-UART subscriber for IMU data.
• Logs one row per BLE packet and writes separate per-side trial files.
• Guarantees that the previous trial files are fully flushed before switching.
• Ctrl-C ends the session; any buffered rows are flushed.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import json
import logging
import math
import os
import time
from pathlib import Path
from typing import Dict, Tuple, Any, Union, Optional, List
from typing import Callable, Awaitable

import numpy as np
import pandas as pd
from scipy.signal import butter, lfilter

# Optional XGBoost import for JSON model inference
try:
    import xgboost as xgb  # type: ignore
except Exception:  # pragma: no cover
    xgb = None

# -------- project-specific imports --------
from bleak import BleakScanner
from ble_core import DualBleLogger, NUS_NOTIFY_UUID, NUS_WRITE_UUID
from config_reader.config_reader import read_config
from mqtt_communication_interface.mqtt_client import MqttClientManager
from src.realtime_batch_from_treadmill import compute_rt_thresholds_from_reference
# ------------------------------------------

# -------- configuration --------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
log = logging.getLogger(__name__)
logging.getLogger("bleak").setLevel(logging.WARNING)
logging.getLogger("bleak.backends.bluezdbus").setLevel(logging.WARNING)
logging.getLogger("dbus_fast").setLevel(logging.WARNING)

PACKET_BATCH_SIZE = 200
PACKET_DEFAULT_FS_HZ = 100.0
HS_REFRACTORY_S = 0.30
RT_TO_START_S = 0.50
RT_TO_END_S = 1.40
RT_CUTOFF_HZ = 6.0
RT_FILTER_ORDER = 4
RT_HS_PCT = 0.80
RT_TO_RANGE_FRAC = 0.10
RT_TO_PREV_MAX = 0.0
RT_THRESHOLD_WINDOW_SAMPLES = 120

# sentinel used to tell the writer to flush NOW
FLUSH: object = object()
DEVICE_QUEUE_STOP: object = object()
MQTT_DEBUG_STOP: object = object()

# -------- CSV columns --------
# Packet-based logging: one row per BLE packet, one file per side.
PACKET_COLUMNS = [
    "timestamp",
    "packet_time",
    "packet_index",
    "device_key",
    "side",
    "segment",
    "qw",
    "qx",
    "qy",
    "qz",
    "acc_x",
    "acc_y",
    "acc_z",
    "gyr_x",
    "gyr_y",
    "filtered_gyr_y",
    "gyr_z",
    "calibration_phase"
   ]

# -------- temporal (per-stride) CSV columns --------
TEMPORAL_COLUMNS = [
    "cycle",
    "hs_time",
    "to_time",
    "next_hs_time",
    "stride_time_s",
    "stance_time_s",
    "swing_time_s",
    "cadence_spm",
    "stride_length_m",
    "stride_height_m",
]

# ---------- helper ----------
def prompt_subject_info() -> Dict[str, Any]:
    return {
        "subject_name": input("Enter participant name (no spaces): ").strip(),
        "subject_id":   os.urandom(4).hex(),
    }

def integrate_vector_signal(time_s: np.ndarray, sig: np.ndarray) -> np.ndarray:
    if len(sig) == 0:
        return sig
    if len(sig) == 1:
        return np.zeros_like(sig, dtype=float)
    dt = np.diff(time_s)
    out = np.zeros_like(sig, dtype=float)
    out[1:] = np.cumsum(0.5 * (sig[1:] + sig[:-1]) * dt[:, None], axis=0)
    return out

def integrate_fb_sigmoid_segment(
    time_s: np.ndarray,
    accel_xy: np.ndarray,
    sigmoid_k: float = 64.0,
) -> tuple[np.ndarray, np.ndarray]:
    time_s = np.asarray(time_s, dtype=float)
    accel_xy = np.asarray(accel_xy, dtype=float)
    if len(time_s) == 0:
        empty = np.empty((0, 2), dtype=float)
        return empty, empty

    vel_fwd = integrate_vector_signal(time_s, accel_xy)
    vel_bwd = integrate_vector_signal(time_s[::-1], accel_xy[::-1])[::-1]

    if len(time_s) < 2:
        vel_corr = vel_fwd.copy()
    else:
        duration = float(time_s[-1] - time_s[0])
        tau = np.zeros(len(time_s), dtype=float) if duration < 1e-9 else (time_s - time_s[0]) / duration
        w = 1.0 / (1.0 + np.exp(-sigmoid_k * (tau - 0.5)))
        vel_corr = (1.0 - w)[:, None] * vel_fwd + w[:, None] * vel_bwd

    pos_corr = integrate_vector_signal(time_s, vel_corr)
    pos_corr = pos_corr - pos_corr[:1]
    return vel_corr, pos_corr

class GyroEventDetector:
    """Streaming version of the realtime treadmill FSM for gyro-only events.

    FIX: state-machine timing (refractory period, TO search window) is now
    computed in REAL ELAPSED TIME (using actual packet timestamps), not
    sample counts. The original implementation converted refractory_s /
    to_start_s / to_end_s into sample counts using a fixed configured fs,
    then compared against a simple per-packet counter (self.idx). Real BLE
    arrival is jittery and averages well below the configured fs (~35-40Hz
    observed vs a 60-100Hz config value), so a "0.3s" refractory period
    computed in samples at the wrong fs actually spans a very different
    amount of real time -- this was silently swallowing/mistiming HS/TO
    events (e.g. the 4.5s "stride" in cycle 2 of the log).

    FIX: the Butterworth filter is now periodically re-designed using a
    rolling estimate of the ACTUAL observed sample rate (from packet
    timestamps), rather than trusting the static configured fs. A filter
    designed for the wrong fs has a wrong effective cutoff, which distorts
    the signal the HS/TO thresholds are calibrated against.
    """

    # If the rolling actual-fs estimate drifts from the currently-designed
    # filter's fs by more than this fraction, the filter is redesigned.
    FS_REDESIGN_TOLERANCE = 0.15
    # Minimum real dt (seconds) and maximum real dt to trust a single
    # inter-packet gap when updating the rolling fs estimate -- guards
    # against one huge BLE stall or one near-zero duplicate timestamp
    # corrupting the estimate.
    MIN_TRUSTED_DT_S = 1.0 / 200.0   # faster than 200 Hz is not physically expected
    MAX_TRUSTED_DT_S = 0.5           # gaps longer than this are dropped/logging stalls
    FS_ROLLING_ALPHA = 0.1           # exponential smoothing factor for the fs estimate

    def __init__(
        self,
        fs: float,
        hs_thr: float,
        to_thr: float,
        to_prev_min: float,
        to_prev_max: float,
        hs_pct: float = RT_HS_PCT,
        to_range_frac: float = RT_TO_RANGE_FRAC,
        threshold_window_samples: int = RT_THRESHOLD_WINDOW_SAMPLES,
        refractory_s: float = HS_REFRACTORY_S,
        to_start_s: float = RT_TO_START_S,
        to_end_s: float = RT_TO_END_S,
    ) -> None:
        self.config_hs_thr = float(hs_thr)
        self.config_to_thr = float(to_thr)
        self.config_to_prev_min = float(to_prev_min)
        self.config_to_prev_max = float(to_prev_max)
        self.hs_pct = float(hs_pct)
        self.to_range_frac = float(to_range_frac)
        self.hs_thr = self.config_hs_thr
        self.to_thr = self.config_to_thr
        self.to_prev_min = self.config_to_prev_min
        self.to_prev_max = self.config_to_prev_max
        self.window_min = float("nan")
        self.window_max = float("nan")
        self.threshold_source = "config"

        # Real-time-based windows (seconds), NOT sample counts.
        self.refractory_s = float(refractory_s)
        self.to_start_s = float(to_start_s)
        self.to_end_s = float(to_end_s)

        # Filter design state -- fs here is the INITIAL design point; it
        # gets corrected once real packet timing is observed.
        self.fs = float(fs)
        self._actual_fs_estimate = float(fs)
        self._last_sample_time: float | None = None
        self._rebuild_filter(self.fs)

        self.buf: list[float] = []
        self.time_buf: list[float] = []
        self.state = "HS"
        self.idx = 0

        # Real-time trackers (replace sample-index trackers).
        self.last_hs_time: float = float("-inf")
        self.to_window_start_time: float = float("-inf")
        self.to_window_end_time: float = float("-inf")

    def _rebuild_filter(self, fs: float) -> None:
        """(Re)design the Butterworth filter for a given fs and reset the
        filter state. Called at init and whenever the rolling actual-fs
        estimate drifts too far from the fs the filter was last designed
        for."""
        fs = max(float(fs), 2.0 * RT_CUTOFF_HZ + 1.0)  # keep cutoff below Nyquist
        self.fs = fs
        self.b, self.a = butter(RT_FILTER_ORDER, RT_CUTOFF_HZ / (fs / 2.0), btype="low")
        self.zi = np.zeros(max(len(self.a), len(self.b)) - 1)

    def _update_fs_estimate(self, sample_time: float) -> None:
        """Update the rolling actual-fs estimate from real inter-packet
        gaps, and redesign the filter if it has drifted too far from the
        fs currently in use."""
        if self._last_sample_time is not None:
            dt = sample_time - self._last_sample_time
            if self.MIN_TRUSTED_DT_S <= dt <= self.MAX_TRUSTED_DT_S:
                instantaneous_fs = 1.0 / dt
                self._actual_fs_estimate = (
                    (1.0 - self.FS_ROLLING_ALPHA) * self._actual_fs_estimate
                    + self.FS_ROLLING_ALPHA * instantaneous_fs
                )
                if abs(self._actual_fs_estimate - self.fs) / self.fs > self.FS_REDESIGN_TOLERANCE:
                    self._rebuild_filter(self._actual_fs_estimate)
        self._last_sample_time = sample_time

    def _update_thresholds(self) -> None:
        self.hs_thr = self.config_hs_thr
        self.to_thr = self.config_to_thr
        self.to_prev_min = self.config_to_prev_min
        self.to_prev_max = self.config_to_prev_max
        self.window_min = float("nan")
        self.window_max = float("nan")
        self.threshold_source = "config"

    def step(self, x: float, sample_time: float) -> tuple[str, float] | None:
        self._update_fs_estimate(sample_time)

        y, self.zi = lfilter(self.b, self.a, [float(x)], zi=self.zi)
        g = float(y[0])
        self.filtered_value = g
        self._update_thresholds()
        self.buf.append(g)
        self.time_buf.append(float(sample_time))
        if len(self.buf) > 10:
            self.buf.pop(0)
            self.time_buf.pop(0)

        event = None
        if len(self.buf) >= 3:
            a, b, c = self.buf[-3], self.buf[-2], self.buf[-1]
            b_time = self.time_buf[-2]
            c_time = self.time_buf[-1]
            if self.state == "HS":
                peak = (a < b) and (b > c)
                # FIX: refractory now checked against REAL elapsed time
                # since the last HS, not a sample-index difference.
                refractory_ok = (b_time - self.last_hs_time) > self.refractory_s
                if peak and (b >= self.hs_thr) and refractory_ok:
                    event = ("HS", b_time)
                    self.last_hs_time = b_time
                    # FIX: TO search window is now a real-time window
                    # measured from the HS timestamp, not a sample-count
                    # offset from a packet index.
                    self.to_window_start_time = b_time + self.to_start_s
                    self.to_window_end_time = b_time + self.to_end_s
                    self.state = "TO"
            elif self.state == "TO":
                inside = self.to_window_start_time <= c_time <= self.to_window_end_time
                prev_in_band = self.to_prev_min <= b <= self.to_prev_max
                crossed_now = prev_in_band and (c < self.to_thr)
                if inside:
                    if crossed_now:
                        event = ("TO", c_time)
                        self.state = "HS"
                elif c_time > self.to_window_end_time:
                    # Missed the TO window in real time -- go back to
                    # looking for the next HS rather than getting stuck.
                    self.state = "HS"

        self.idx += 1
        return event


@dataclass
class MotionState:
    last_packet_time: Optional[float] = None
    last_linear_acc_world: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=float))
    velocity_world: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=float))
    position_world: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=float))
    distance_axis: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=float))
    distance_xy: float = 0.0
    distance_xyz: float = 0.0

    def reset(self) -> None:
        self.last_packet_time = None
        self.last_linear_acc_world.fill(0.0)
        self.velocity_world.fill(0.0)
        self.position_world.fill(0.0)
        self.distance_axis.fill(0.0)
        self.distance_xy = 0.0
        self.distance_xyz = 0.0


@dataclass
class PacketLogEntry:
    csv_path: str
    row: Dict[str, Any]


class TrialDataLogger:
    """
    Queue-based logger with per-trial CSV files, stale-data→NaN ,
    and a race-free “always-have-next-file-ready” workflow.
    """

    # ────────────────────────────────────────────────────────────
    #   init
    # ────────────────────────────────────────────────────────────
    def __init__(self, root_dir: str, enable_ble: bool = True, capture_only: bool = False):
        self.root_dir = root_dir
        os.makedirs(self.root_dir, exist_ok=True)
        self.enable_ble = bool(enable_ble)
        self.capture_only = bool(capture_only)

        self.queue: asyncio.Queue[Union[PacketLogEntry, object]] = asyncio.Queue()

        # trial management
        self.trial_idx = 0
        self.current_csv_paths: Dict[str, str] = {}
        self.recording = False
        self.calibration_done = False
        self.calibration_start_time = None
        self.calibration_duration = 5.0   # Dynamic walking calibration: first 5 s of the 15 s walking trial
        self.gyro_calibration_buffer = []
        self.rt_thresholds = None
        self.hs_events = []
        self.to_events = []
        self.realtime_temporal_rows = []

        # writer-sync event to avoid race on flush
        self.flush_done = asyncio.Event()
        self.flush_done.set()        # nothing to wait for at startup

        # BLE
        self.ble_logger: Optional[DualBleLogger] = None
        if self.enable_ble:
            self.dev_selectors = [os.environ.get("DEV1"), os.environ.get("DEV2")]
            self.device_map = {
                0: os.environ.get("DEV1_SEG", "left/foot"),
                1: os.environ.get("DEV2_SEG", "right/foot"),
            }
        else:
            self.dev_selectors = [None, None]
            self.device_map = {
                0: "left/foot",
                1: "right/foot",
            }
            self.stride_buffers = {}

        self.stride_buffers = {}

        for key in self.device_map.values():
            self.stride_buffers[key] = {
                "t": [],
                "ax": [],
                "ay": [],
                "az": []
            }
        self.device_queues = {
            idx: asyncio.Queue()
            for idx in self.device_map
        }
        self.device_tasks: List[asyncio.Task[Any]] = []
        self.writer_task: Optional[asyncio.Task[Any]] = None
        if self.enable_ble and (not self.dev_selectors[0] or not self.dev_selectors[1]):
            raise RuntimeError("DEV1 and DEV2 environment variables must be set for BLE devices.")

        self.event_thresholds, self.detector_fs = self._load_event_thresholds()
        self.event_processing = self._load_event_processing()
        self.gyro_event_detectors: Dict[str, GyroEventDetector] = {
            key: GyroEventDetector(
                fs=self.detector_fs,
                **self.event_thresholds[key.split("/", 1)[0]],
                hs_pct=self.event_processing["hs_pct"],
                to_range_frac=self.event_processing["to_range_frac"],
                threshold_window_samples=self.event_processing["threshold_window_samples"],
            )
            for key in self.device_map.values()
        }
        self.latest_heel_strike: Dict[str, float] = {}
        self.packet_counts: Dict[str, int] = {
            device_key: 0 for device_key in self.device_map.values()
        }
        self.rate_counts: Dict[str, int] = {"left": 0, "right": 0}
        self.rate_task: Optional[asyncio.Task[Any]] = None
        self.rate_tick: int = 0
        self.mqtt_debug = self._load_mqtt_debug_config()
        self.mqtt_client: Optional[MqttClientManager] = None
        self.mqtt_connection_task: Optional[asyncio.Task[Any]] = None
        self.mqtt_debug_queue: asyncio.Queue[Union[dict[str, Any], object]] = asyncio.Queue(maxsize=512)
        self.mqtt_debug_task: Optional[asyncio.Task[Any]] = None
        self.motion_states: Dict[str, MotionState] = {
            device_key: MotionState() for device_key in self.device_map.values()
        }
        self.packet_listeners: List[Callable[[str, Dict[str, float], float, Optional[Dict[str, Any]]], None]] = []

        # Models (loaded on start)
        self.model_left: Optional[Any] = None
        self.model_right: Optional[Any] = None

        # Create the first blank trial files now that the device map exists.
        if not self.capture_only:
            self._prepare_new_trial_files()

    # ────────────────────────────────────────────────────────────
    #   helpers – file management
    # ────────────────────────────────────────────────────────────
    def _csv_path_for_device_key(self, device_key: str) -> str:
        side = device_key.split("/", 1)[0].lower()
        return os.path.join(self.root_dir, f"trial_{self.trial_idx:03d}_{side}.csv")

    def _reset_rate_counts(self) -> None:
        self.rate_counts["left"] = 0
        self.rate_counts["right"] = 0
        self.rate_tick = 0

    async def _rate_monitor_loop(self) -> None:
        while self.recording:
            await asyncio.sleep(1.0)
            if not self.recording:
                break
            self.rate_tick += 1
            log.info(
                "recording_rate second=%d left_hz=%.2f right_hz=%.2f",
                self.rate_tick,
                float(self.rate_counts.get("left", 0)),
                float(self.rate_counts.get("right", 0)),
            )
            self._reset_rate_counts()

    def _prepare_new_trial_files(self) -> None:
        """Create blank per-side CSVs for the next trial."""
        self.trial_idx += 1
        self.current_csv_paths = {}
        seen_sides: set[str] = set()
        for device_key in self.device_map.values():
            side = device_key.split("/", 1)[0].lower()
            if side in seen_sides:
                continue
            seen_sides.add(side)
            path = self._csv_path_for_device_key(device_key)
            self.current_csv_paths[side] = path
            pd.DataFrame(columns=PACKET_COLUMNS).to_csv(path, index=False)
            log.info("Prepared new trial file %s", os.path.basename(path))
        temporal_path = os.path.join(
                self.root_dir,
                f"trial_{self.trial_idx:03d}_spatio-temporal.csv"
        )
        log.info(
            "Prepared spatio-temporal parameters file %s",
            os.path.basename(temporal_path)
        )

    def _load_mqtt_debug_config(self) -> Dict[str, Any]:
        config_path = Path(__file__).resolve().parents[1] / "config" / "mqtt_config.yml"
        cfg = read_config(config_path)
        enabled = bool(cfg.get("enabled", True))
        broker_ip = str(cfg.get("broker_ip", "127.0.0.1"))
        port = int(cfg.get("port", 1883))
        topic_prefix = str(cfg.get("gait_debug_topic_prefix", "debug/gait")).rstrip("/")
        client_id = str(cfg.get("client_id", "ble-data-collector"))
        return {
            "enabled": enabled,
            "broker_ip": broker_ip,
            "port": port,
            "topic_prefix": topic_prefix,
            "imu_topic_prefix": str(cfg.get("imu_topic_prefix", "imu")).rstrip("/"),
            "client_id": client_id,
            "username": cfg.get("username"),
            "password": cfg.get("password"),
            "ssl_enabled": bool(cfg.get("ssl_enabled", False)),
        }

    def add_packet_listener(
        self,
        callback: Callable[[str, Dict[str, float], float, Optional[Dict[str, Any]]], None],
    ) -> None:
        self.packet_listeners.append(callback)

    def remove_packet_listener(
        self,
        callback: Callable[[str, Dict[str, float], float, Optional[Dict[str, Any]]], None],
    ) -> None:
        try:
            self.packet_listeners.remove(callback)
        except ValueError:
            pass

    async def _start_mqtt_debug_publisher(self) -> None:
        if not self.mqtt_debug.get("enabled", False):
            return
        loop = asyncio.get_running_loop()
        self.mqtt_client = MqttClientManager(logger=log)
        self.mqtt_connection_task = asyncio.create_task(
            self.mqtt_client.make_connection(
                loop=loop,
                host=self.mqtt_debug["broker_ip"],
                port=self.mqtt_debug["port"],
                ssl_enabled=bool(self.mqtt_debug.get("ssl_enabled", False)),
                client_id=str(self.mqtt_debug.get("client_id", "ble-data-collector")),
                username=self.mqtt_debug.get("username"),
                password=self.mqtt_debug.get("password"),
            )
        )
        self.mqtt_debug_task = asyncio.create_task(self._mqtt_debug_publish_loop())
        try:
            await asyncio.wait_for(self.mqtt_client.wait_until_connected(), timeout=5.0)
            log.info(
                "Publishing gait debug stream over MQTT to %s:%s with topic prefix %s",
                self.mqtt_debug["broker_ip"],
                self.mqtt_debug["port"],
                self.mqtt_debug["topic_prefix"],
            )
        except asyncio.TimeoutError:
            log.warning(
                "MQTT broker %s:%s not connected within 5s; continuing BLE startup and publishing when it becomes available.",
                self.mqtt_debug["broker_ip"],
                self.mqtt_debug["port"],
            )
        except Exception:
            log.exception(
                "Failed to initialize MQTT gait debug publisher for %s:%s",
                self.mqtt_debug["broker_ip"],
                self.mqtt_debug["port"],
            )

    async def _stop_mqtt_debug_publisher(self) -> None:
        if self.mqtt_debug_task is not None:
            await self.mqtt_debug_queue.put(MQTT_DEBUG_STOP)
            await self.mqtt_debug_task
            self.mqtt_debug_task = None
        if self.mqtt_client is not None:
            self.mqtt_client.disconnect()
            self.mqtt_client = None
        if self.mqtt_connection_task is not None:
            self.mqtt_connection_task.cancel()
            self.mqtt_connection_task = None

    async def _mqtt_debug_publish_loop(self) -> None:
        while True:
            item = await self.mqtt_debug_queue.get()
            if item is MQTT_DEBUG_STOP:
                break
            if self.mqtt_client is None:
                continue
            try:
                topic = str(item["topic"])
                payload = json.dumps(item["payload"], separators=(",", ":"))
                await self.mqtt_client.publish(topic, payload)
            except Exception:
                log.exception("Failed to publish gait debug MQTT sample")

    @staticmethod
    def _finite_or_none(value: Any) -> Optional[float]:
        try:
            value_f = float(value)
        except (TypeError, ValueError):
            return None
        if not np.isfinite(value_f):
            return None
        return value_f

    def _vector_payload(self, values: np.ndarray) -> Dict[str, Optional[float]]:
        return {
            "x": self._finite_or_none(values[0]),
            "y": self._finite_or_none(values[1]),
            "z": self._finite_or_none(values[2]),
        }

    def _quat_payload(self, quat_wxyz: np.ndarray) -> Dict[str, Optional[float]]:
        return {
            "w": self._finite_or_none(quat_wxyz[0]),
            "x": self._finite_or_none(quat_wxyz[1]),
            "y": self._finite_or_none(quat_wxyz[2]),
            "z": self._finite_or_none(quat_wxyz[3]),
        }

    @staticmethod
    def _normalize_quaternion(quat_wxyz: np.ndarray) -> Optional[np.ndarray]:
        if quat_wxyz.shape != (4,) or not np.all(np.isfinite(quat_wxyz)):
            return None
        norm = float(np.linalg.norm(quat_wxyz))
        if norm <= 1e-9:
            return None
        return quat_wxyz / norm

    @staticmethod
    def _rotation_matrix_from_quaternion(quat_wxyz: np.ndarray) -> np.ndarray:
        w, x, y, z = quat_wxyz
        return np.array(
            [
                [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
                [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
                [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
            ],
            dtype=float,
        )

    def _compute_motion_sample(
        self,
        device_key: str,
        packet_time: float,
        values: Dict[str, float],
    ) -> Optional[Dict[str, Any]]:
        quat_wxyz = np.array(
            [
                values.get("qw", float("nan")),
                values.get("qx", float("nan")),
                values.get("qy", float("nan")),
                values.get("qz", float("nan")),
            ],
            dtype=float,
        )
        raw_acc = np.array(
            [
                values.get("acc_x", float("nan")),
                values.get("acc_y", float("nan")),
                values.get("acc_z", float("nan")),
            ],
            dtype=float,
        )
        raw_gyro = np.array(
            [
                values.get("gyr_x", float("nan")),
                values.get("gyr_y", float("nan")),
                values.get("gyr_z", float("nan")),
            ],
            dtype=float,
        )

        quat_unit = self._normalize_quaternion(quat_wxyz)
        if quat_unit is None or not np.all(np.isfinite(raw_acc)) or not np.all(np.isfinite(raw_gyro)):
            return None

        rotation = self._rotation_matrix_from_quaternion(quat_unit)
        rotated_acc = rotation @ raw_acc
        rotated_gyro = rotation @ raw_gyro
        gravity_world = np.array([0.0, 0.0, 9.80665], dtype=float)
        linear_acc_world = rotated_acc - gravity_world

        state = self.motion_states.setdefault(device_key, MotionState())
        dt = 0.0
        delta_position = np.zeros(3, dtype=float)
        if state.last_packet_time is not None:
            dt = float(packet_time - state.last_packet_time)
            if dt <= 0.0 or dt > 1.0:
                dt = 0.0

        if dt > 0.0:
            velocity_prev = state.velocity_world.copy()
            velocity_new = velocity_prev + 0.5 * (state.last_linear_acc_world + linear_acc_world) * dt
            delta_position = 0.5 * (velocity_prev + velocity_new) * dt
            state.velocity_world = velocity_new
            state.position_world = state.position_world + delta_position
            state.distance_axis = state.distance_axis + np.abs(delta_position)
            state.distance_xy += float(np.linalg.norm(delta_position[:2]))
            state.distance_xyz += float(np.linalg.norm(delta_position))
        else:
            state.velocity_world.fill(0.0)

        state.last_packet_time = float(packet_time)
        state.last_linear_acc_world = linear_acc_world

        return {
            "quat_wxyz": quat_unit,
            "raw_acc": raw_acc,
            "raw_gyro": raw_gyro,
            "rotated_acc_world": rotated_acc,
            "rotated_gyro_world": rotated_gyro,
            "linear_acc_world": linear_acc_world,
            "velocity_world": state.velocity_world.copy(),
            "position_world": state.position_world.copy(),
            "distance_axis": state.distance_axis.copy(),
            "distance_xy": float(state.distance_xy),
            "distance_xyz": float(state.distance_xyz),
            "displacement_xy": float(np.linalg.norm(state.position_world[:2])),
            "displacement_xyz": float(np.linalg.norm(state.position_world)),
            "delta_t_s": dt,
        }

    def _queue_mqtt_debug_sample(
        self,
        device_key: str,
        packet_time: float,
        values: Dict[str, float],
        heel_strike_time: Optional[float],
        toe_off_time: Optional[float],
    ) -> None:
        if self.mqtt_client is None:
            return
        payload = {
            "device_key": device_key,
            "packet_time": packet_time,
            "imu": {
                "quat_w": self._finite_or_none(values.get("qw")),
                "quat_x": self._finite_or_none(values.get("qx")),
                "quat_y": self._finite_or_none(values.get("qy")),
                "quat_z": self._finite_or_none(values.get("qz")),
                "acc_x": self._finite_or_none(values.get("acc_x")),
                "acc_y": self._finite_or_none(values.get("acc_y")),
                "acc_z": self._finite_or_none(values.get("acc_z")),
                "gyr_x": self._finite_or_none(values.get("gyr_x")),
                "gyr_y": self._finite_or_none(values.get("gyr_y")),
                "gyr_z": self._finite_or_none(values.get("gyr_z")),
            },
            "heel_strike_time": self._finite_or_none(heel_strike_time),
            "toe_off_time": self._finite_or_none(toe_off_time),
        }
        topic = f"{self.mqtt_debug['topic_prefix']}/{device_key}"
        try:
            self.mqtt_debug_queue.put_nowait({"topic": topic, "payload": payload})
        except asyncio.QueueFull:
            log.debug("Dropped gait debug sample for %s because the MQTT queue is full", device_key)
  
    def _queue_mqtt_imu_sample(
        self,
        device_key: str,
        packet_time: float,
        values: Dict[str, float],
        motion_sample: Optional[Dict[str, Any]],
    ) -> None:
        if self.mqtt_client is None:
            return
        side, _, segment = device_key.partition("/")
        raw_quat = np.array(
            [
                values.get("qw", float("nan")),
                values.get("qx", float("nan")),
                values.get("qy", float("nan")),
                values.get("qz", float("nan")),
            ],
            dtype=float,
        )
        rotated_acc = np.full(3, np.nan, dtype=float)
        rotated_gyro = np.full(3, np.nan, dtype=float)
        linear_acc = np.full(3, np.nan, dtype=float)
        velocity = np.full(3, np.nan, dtype=float)
        position = np.full(3, np.nan, dtype=float)
        distance_axis = np.full(3, np.nan, dtype=float)
        distance_xy = float("nan")
        distance_xyz = float("nan")
        displacement_xy = float("nan")
        displacement_xyz = float("nan")
        delta_t_s = float("nan")

        if motion_sample is not None:
            rotated_acc = motion_sample["rotated_acc_world"]
            rotated_gyro = motion_sample["rotated_gyro_world"]
            linear_acc = motion_sample["linear_acc_world"]
            velocity = motion_sample["velocity_world"]
            position = motion_sample["position_world"]
            distance_axis = motion_sample["distance_axis"]
            distance_xy = motion_sample["distance_xy"]
            distance_xyz = motion_sample["distance_xyz"]
            displacement_xy = motion_sample["displacement_xy"]
            displacement_xyz = motion_sample["displacement_xyz"]
            delta_t_s = motion_sample["delta_t_s"]

        payload = {
            "device_key": device_key,
            "side": side,
            "segment": segment,
            "packet_time": self._finite_or_none(packet_time),
            "delta_t_s": self._finite_or_none(delta_t_s),
            "raw_imu": {
                "quaternion": self._quat_payload(raw_quat),
                "acceleration_mps2": {
                    "x": self._finite_or_none(values.get("acc_x")),
                    "y": self._finite_or_none(values.get("acc_y")),
                    "z": self._finite_or_none(values.get("acc_z")),
                },
                "gyro_radps": {
                    "x": self._finite_or_none(values.get("gyr_x")),
                    "y": self._finite_or_none(values.get("gyr_y")),
                    "z": self._finite_or_none(values.get("gyr_z")),
                },
            },
            "rotated_imu_world": {
                "acceleration_mps2": self._vector_payload(rotated_acc),
                "gyro_radps": self._vector_payload(rotated_gyro),
            },
            "linear_acceleration_world_mps2": self._vector_payload(linear_acc),
            "velocity_world_mps": self._vector_payload(velocity),
            "position_world_m": self._vector_payload(position),
            "distance_travelled_m": {
                "x": self._finite_or_none(distance_axis[0]),
                "y": self._finite_or_none(distance_axis[1]),
                "z": self._finite_or_none(distance_axis[2]),
                "xy": self._finite_or_none(distance_xy),
                "xyz": self._finite_or_none(distance_xyz),
            },
            "displacement_m": {
                "x": self._finite_or_none(position[0]),
                "y": self._finite_or_none(position[1]),
                "z": self._finite_or_none(position[2]),
                "xy": self._finite_or_none(displacement_xy),
                "xyz": self._finite_or_none(displacement_xyz),
            },
        }
        topic = f"{self.mqtt_debug['imu_topic_prefix']}/{device_key}"
        try:
            self.mqtt_debug_queue.put_nowait({"topic": topic, "payload": payload})
        except asyncio.QueueFull:
            log.debug("Dropped IMU MQTT sample for %s because the MQTT queue is full", device_key)

    # ────────────────────────────────────────────────────────────
    #   BLE handlers
    # ────────────────────────────────────────────────────────────
    def _enqueue_ble_chunk(self, idx: int, data: bytes) -> None:
        queue = self.device_queues.get(idx)
        if queue is None:
            log.warning("Received BLE chunk for unconfigured device index %s.", idx)
            return

        # Timestamp the packet at callback receipt time so the log reflects the
        # actual BLE cadence rather than a synthetic sampler cadence.
        received_time = time.time()
        try:
            queue.put_nowait((data, received_time))
        except asyncio.QueueFull:
            log.warning("Dropped BLE chunk for device index %s because the queue is full.", idx)

    async def _handle_ble_chunk(self, idx: int, data: bytes):
        self._enqueue_ble_chunk(idx, data)

    async def _process_device_queue(self, idx: int, device_key: str):
        queue = self.device_queues[idx]
        while True:
            item = await queue.get()
            if item is DEVICE_QUEUE_STOP:
                break
            if not isinstance(item, tuple) or len(item) != 2:
                continue
            data, packet_time = item
            await self._process_received_packet(device_key, data, packet_time)

    async def _process_received_packet(self, device_key: str, data: bytes, packet_time: float) -> None:
        values = self._parse_ble_values(data)
        if values is None:
            return
        gyro_y = values.get("gyr_y")

        calibration_phase = 0

        if (
            not self.calibration_done
            and self.calibration_start_time is not None
        ):

            calibration_phase = 1

            if gyro_y is not None and np.isfinite(gyro_y):
                self.gyro_calibration_buffer.append(
                    float(gyro_y)
                )

            elapsed = (
                time.time()
                - self.calibration_start_time
            )

            if elapsed >= self.calibration_duration:

                calib = np.array(
                    self.gyro_calibration_buffer,
                    dtype=float
                )

                right_thr, _ = compute_rt_thresholds_from_reference(
                    calib,
                    calib,
                    60.0
                )
                self.rt_thresholds = right_thr

                for key in self.gyro_event_detectors:

                    self.gyro_event_detectors[key] = GyroEventDetector(
                        fs=self.detector_fs,
                        hs_thr=self.rt_thresholds["hs_thr"],
                        to_thr=self.rt_thresholds["to_thr"],
                        to_prev_min=self.rt_thresholds["to_prev_min"],
                        to_prev_max=self.rt_thresholds["to_prev_max"],
                        hs_pct=self.event_processing["hs_pct"],
                        to_range_frac=self.event_processing["to_range_frac"],
                        threshold_window_samples=self.event_processing["threshold_window_samples"],
                    )

                print("Realtime detector updated")

                print(
                    "\nCalibration complete:",
                    len(calib),
                    "samples"
                )

                print(
                    f"hs_thr={right_thr['hs_thr']:.4f}"
                )

                print(
                    f"to_thr={right_thr['to_thr']:.4f}"
                )

                print(
                    f"to_prev_min={right_thr['to_prev_min']:.4f}"
                )

                print(
                    f"to_prev_max={right_thr['to_prev_max']:.4f}"
                )

                self.calibration_done = True
        motion_sample: Optional[Dict[str, Any]] = None
        try:
            motion_sample = self._compute_motion_sample(device_key, packet_time, values)
            if motion_sample is not None:

                lin_acc = motion_sample["linear_acc_world"]

                # FIX: actually populate the per-foot stride buffer (this
                # was previously commented out, so seg_t/seg_ax/seg_ay/seg_az
                # in _process_gyro_heel_strike were ALWAYS empty, which is
                # why Stride_Length/Stride_Height came out as nan on every
                # cycle regardless of the integration code below being
                # uncommented).
                self.stride_buffers[device_key]["t"].append(
                    packet_time
                )
                self.stride_buffers[device_key]["ax"].append(
                    float(lin_acc[0])
                )
                self.stride_buffers[device_key]["ay"].append(
                    float(lin_acc[1])
                )
                self.stride_buffers[device_key]["az"].append(
                    float(lin_acc[2])
                )
        except Exception:
            log.exception("Motion tracking failed for %s at %.3f", device_key, packet_time)
        # HS/TO gait event detection is temporarily disabled.
        if self.recording:
            try:
                self._process_gyro_heel_strike(
                    device_key,
                    values,
                    packet_time
                )
            except Exception:
                log.exception(
                    "Gyro event processing failed for %s at %.3f",
                    device_key,
                    packet_time
                )
        try:
            self._queue_mqtt_imu_sample(device_key, packet_time, values, motion_sample)
        except Exception:
            log.exception("MQTT publish queueing failed for %s at %.3f", device_key, packet_time)

        for callback in list(self.packet_listeners):
            try:
                callback(device_key, values, packet_time, motion_sample)
            except Exception:
                log.exception("Packet listener failed for %s at %.3f", device_key, packet_time)

        if not self.recording:
            return

        side = device_key.split("/", 1)[0].lower()
        if side in self.rate_counts:
            self.rate_counts[side] = self.rate_counts.get(side, 0) + 1

        packet_index = self.packet_counts.get(device_key, 0)
        self.packet_counts[device_key] = packet_index + 1
        values["calibration_phase"] = calibration_phase
        row = self._build_packet_row(
            device_key=device_key,
            packet_index=packet_index,
            packet_time=packet_time,
            values=values,
            motion_sample=motion_sample,
        )
        csv_path = self._csv_path_for_device_key(device_key)
        await self.queue.put(PacketLogEntry(csv_path=csv_path, row=row))

    async def inject_test_chunk(self, device_key: str, data: bytes) -> None:
        """Inject a synthetic BLE packet directly into the packet-processing path."""
        await self._process_received_packet(device_key, data, time.time())

    async def _handle_start(self, *_):
        if self.recording:
            log.info("start_recording received while already recording – ignoring.")
            return
        for state in self.motion_states.values():
            state.reset()
        for device_key in self.packet_counts:
            self.packet_counts[device_key] = 0
        self._reset_rate_counts()
        self.hs_events = []
        self.to_events = []

        self.realtime_temporal_rows = []

        for key in self.stride_buffers:

            self.stride_buffers[key]["t"].clear()
            self.stride_buffers[key]["ax"].clear()
            self.stride_buffers[key]["ay"].clear()
            self.stride_buffers[key]["az"].clear()
        self.calibration_done = False
        self.calibration_start_time = time.time()
        self.gyro_calibration_buffer = []
        self.recording = True
        if self.rate_task is None or self.rate_task.done():
            self.rate_task = asyncio.create_task(self._rate_monitor_loop())
        started_files = ", ".join(
            os.path.basename(path) for path in self.current_csv_paths.values()
        )
        log.info("Recording **started** for %s at t=%.3f", started_files, time.time())
    
    async def _handle_stop(self, *_):
        if not self.recording:
            log.info("stop_recording received but not currently recording.")
            return

        self.recording = False
        if self.rate_task is not None:
            self.rate_task.cancel()
            try:
                await self.rate_task
            except asyncio.CancelledError:
                pass
            self.rate_task = None
        self.flush_done.clear()               # we will wait for writer
        await self.queue.put(FLUSH)           # trigger flush
        await self.flush_done.wait()          # wait until writer finishes

        stopped_files = ", ".join(
            os.path.basename(path) for path in self.current_csv_paths.values()
        )
        log.info("Recording **stopped** for %s", stopped_files)
        print("\n===== Trial Summary =====")
        print("HS events:", len(self.hs_events))
        print("TO events:", len(self.to_events))

        if len(self.realtime_temporal_rows) > 0:

            temporal_df = pd.DataFrame(
                self.realtime_temporal_rows,
                columns=TEMPORAL_COLUMNS,
            )

            mean_stride = temporal_df[
                "stride_time_s"
            ].mean()

            mean_stance = temporal_df[
                "stance_time_s"
            ].mean()

            mean_swing = temporal_df[
                "swing_time_s"
            ].mean()

            mean_cadence = temporal_df[
                "cadence_spm"
            ].mean()

            mean_stride_length = temporal_df[
                "stride_length_m"
            ].mean()

            mean_stride_height = temporal_df[
                "stride_height_m"
            ].mean()

            print(
                f"Mean Stride Time: {mean_stride:.3f} s"
            )

            print(
                f"Mean Stance Time: {mean_stance:.3f} s"
            )

            print(
                f"Mean Swing Time: {mean_swing:.3f} s"
            )

            print(
                f"Mean Cadence: {mean_cadence:.3f} steps/min"
            )

            print(
                f"Mean Stride Length: {mean_stride_length:.3f} m"
            )
            print(
                f"Mean Stride Height: {mean_stride_height:.3f} m"
            )


            # Summary rows, matching the existing trial_XXX_temporal.csv layout:
            # a "MEAN" row for the per-stride durations/length/height, and a
            # separate "CADENCE" row carrying the mean cadence in its own
            # cadence_spm column.
            temporal_df.loc[len(temporal_df)] = {
                "cycle": "MEAN",
                "hs_time": "",
                "to_time": "",
                "next_hs_time": "",
                "stride_time_s": mean_stride,
                "stance_time_s": mean_stance,
                "swing_time_s": mean_swing,
                "cadence_spm": "",
                "stride_length_m": mean_stride_length,
                "stride_height_m": mean_stride_height,
            }

            temporal_df.loc[len(temporal_df)] = {
                "cycle": "CADENCE",
                "hs_time": "",
                "to_time": "",
                "next_hs_time": "",
                "stride_time_s": "",
                "stance_time_s": "",
                "swing_time_s": "",
                "cadence_spm": mean_cadence,
                "stride_length_m": "",
                "stride_height_m": "",
            }

            temporal_path = os.path.join(
                self.root_dir,
                f"trial_{self.trial_idx:03d}_temporal.csv"
            )

            temporal_df.to_csv(
                temporal_path,
                index=False
            )

            log.info(
                "Saved temporal parameters file %s",
                os.path.basename(temporal_path)
            )

            # Additional output files for downstream gait-analysis scripts.
            # Existing trial_XXX_temporal.csv is kept unchanged.
            events_rows = []
            for i in range(max(len(self.hs_events), len(self.to_events))):
                events_rows.append({
                    "event_index": i + 1,
                    "heel_strike_time": self.hs_events[i] if i < len(self.hs_events) else "",
                    "toe_off_time": self.to_events[i] if i < len(self.to_events) else "",
                })

            events_path = os.path.join(
                self.root_dir,
                f"trial_{self.trial_idx:03d}_right_events.csv"
            )
            pd.DataFrame(
                events_rows,
                columns=["event_index", "heel_strike_time", "toe_off_time"],
            ).to_csv(events_path, index=False)

            right_temporal_path = os.path.join(
                self.root_dir,
                f"trial_{self.trial_idx:03d}_right_temporal.csv"
            )
            temporal_df.to_csv(right_temporal_path, index=False)

            log.info(
                "Saved additional gait files: %s, %s",
                os.path.basename(events_path),
                os.path.basename(right_temporal_path),
            )
        else:
            # Still create the additional files when no complete gait cycle
            # was detected, so every trial has the same output structure.
            events_path = os.path.join(
                self.root_dir,
                f"trial_{self.trial_idx:03d}_right_events.csv"
            )
            pd.DataFrame(
                [{
                    "event_index": i + 1,
                    "heel_strike_time": self.hs_events[i] if i < len(self.hs_events) else "",
                    "toe_off_time": self.to_events[i] if i < len(self.to_events) else "",
                } for i in range(max(len(self.hs_events), len(self.to_events)))],
                columns=["event_index", "heel_strike_time", "toe_off_time"],
            ).to_csv(events_path, index=False)

            right_temporal_path = os.path.join(
                self.root_dir,
                f"trial_{self.trial_idx:03d}_right_temporal.csv"
            )
            pd.DataFrame(columns=TEMPORAL_COLUMNS).to_csv(
                right_temporal_path, index=False
            )

            log.info(
                "Saved empty additional gait files: %s, %s",
                os.path.basename(events_path),
                os.path.basename(right_temporal_path),
            )
        # Now it is safe: writer is done, create next blank file
        self._prepare_new_trial_files()

    async def send_ble_command(self, cmd: str) -> None:
        if not self.ble_logger:
            log.warning("BLE logger not initialized; command skipped.")
            return
        try:
            log.info("Sending BLE command: %s", cmd)
            await self.ble_logger.broadcast(cmd.encode("utf-8"))
        except Exception:
            log.exception("Failed to send BLE command: %s", cmd)

    async def _connect_ble_devices(self, send_init_command: bool = True) -> None:
        if not self.enable_ble:
            log.info("BLE disabled: starting packet-logging simulation mode.")
            self.device_tasks = [
                asyncio.create_task(self._process_device_queue(idx, self.device_map[idx]))
                for idx in range(len(self.device_map))
            ]
            return

        log.info("Resolving BLE devices with selectors %s", self.dev_selectors)
        devs = await self._resolve_devices(self.dev_selectors)
        self.ble_logger = DualBleLogger(
            devs,
            notify_uuid=NUS_NOTIFY_UUID,
            write_uuid=NUS_WRITE_UUID,
            adapters=[None, "hci1"],
        )
        log.info("Connecting BLE devices: %s", devs)
        missing_devices = [idx for idx in range(len(devs)) if not self.device_map.get(idx)]
        if missing_devices:
            raise RuntimeError(f"Missing BLE device mapping for indices: {missing_devices}")
        self.device_tasks = [
            asyncio.create_task(self._process_device_queue(idx, self.device_map[idx]))
            for idx in range(len(devs))
        ]
        await self.ble_logger.connect_and_start_notify_chunks(self._enqueue_ble_chunk)
        if send_init_command:
            try:
                await self.ble_logger.broadcast_serial(b"F", delay_s=0.5)
                await asyncio.sleep(4.0)
                log.info("Sent BLE init command 'F' to all devices.")
            except Exception:
                log.warning("Failed to send BLE init command 'F' to one or more devices.")

    # ────────────────────────────────────────────────────────────
    #   async lifecycle
    # ────────────────────────────────────────────────────────────
    async def start(self):
        # await self._start_mqtt_debug_publisher()
        if self.ble_logger is None:
            await self._connect_ble_devices(send_init_command=True)
        else:
            log.info("Reusing existing BLE connection.")

        if not self.capture_only:
            self.writer_task = asyncio.create_task(self._writer())

    async def connect_ble_only(self) -> None:
        """Open BLE, start notifications, and send the init command without starting a logger session."""
        await self._connect_ble_devices(send_init_command=True)

        # Load models for predictions
        # self._load_models()

    async def stop(self):
        log.info("Stopping session …")
        if self.writer_task is not None:
            self.flush_done.clear()
            await self.queue.put(FLUSH)
            await self.flush_done.wait()
            await self.queue.put(None)
            await self.writer_task
            self.writer_task = None
        if self.rate_task is not None:
            self.rate_task.cancel()
            try:
                await self.rate_task
            except asyncio.CancelledError:
                pass
            self.rate_task = None
        try:
            if self.ble_logger is not None:
                await self.ble_logger.stop_notify()
        except Exception:
            log.exception("BLE notify shutdown failed.")
        finally:
            for idx in self.device_queues:
                await self.device_queues[idx].put(DEVICE_QUEUE_STOP)
            if self.device_tasks:
                await asyncio.gather(*self.device_tasks, return_exceptions=True)
                self.device_tasks.clear()
            if self.ble_logger is not None:
                try:
                    await self.ble_logger.disconnect()
                except Exception:
                    log.exception("BLE disconnect failed.")
            await self._stop_mqtt_debug_publisher()
        log.info("Session stopped.")

    # ────────────────────────────────────────────────────────────
    #   coroutines
    # ────────────────────────────────────────────────────────────
    async def _writer(self):
        buffers: Dict[str, List[Dict[str, Any]]] = {}
        while True:
            item = await self.queue.get()
            # termination
            if item is None:
                await self._flush_all(buffers)
                break

            # flush request
            if item is FLUSH:
                await self._flush_all(buffers)
                self.flush_done.set()      # signal "flush finished"
                continue

            if not isinstance(item, PacketLogEntry):
                continue

            buf = buffers.setdefault(item.csv_path, [])
            buf.append(item.row)
            if len(buf) >= PACKET_BATCH_SIZE:
                await self._flush(item.csv_path, buf)
                buf.clear()

    # ────────────────────────────────────────────────────────────
    #   row building & flushing
    # ────────────────────────────────────────────────────────────
    def _build_packet_row(
        self,
        device_key: str,
        packet_index: int,
        packet_time: float,
        values: Dict[str, float],
        motion_sample: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        row: Dict[str, Any] = {
            "timestamp": packet_time,
            "packet_time": packet_time,
            "packet_index": int(packet_index),
            "device_key": device_key,
            "side": device_key.split("/", 1)[0].lower(),
            "segment": device_key.split("/", 1)[1] if "/" in device_key else "",
            "qw": self._finite_or_none(values.get("qw")),
            "qx": self._finite_or_none(values.get("qx")),
            "qy": self._finite_or_none(values.get("qy")),
            "qz": self._finite_or_none(values.get("qz")),
            "acc_x": self._finite_or_none(values.get("acc_x")),
            "acc_y": self._finite_or_none(values.get("acc_y")),
            "acc_z": self._finite_or_none(values.get("acc_z")),
            "gyr_x": self._finite_or_none(values.get("gyr_x")),
            "gyr_y": self._finite_or_none(values.get("gyr_y")),
            "filtered_gyr_y": self._finite_or_none(values.get("filtered_gyr_y")),
            "gyr_z": self._finite_or_none(values.get("gyr_z")),
            "calibration_phase": values.get(
            "calibration_phase",
            0
            ),
            "rotated_acc_x": None,
            "rotated_acc_y": None,
            "rotated_acc_z": None,
            "rotated_gyro_x": None,
            "rotated_gyro_y": None,
            "rotated_gyro_z": None,
            "linear_acc_x": None,
            "linear_acc_y": None,
            "linear_acc_z": None,
            "velocity_x": None,
            "velocity_y": None,
            "velocity_z": None,
            "position_x": None,
            "position_y": None,
            "position_z": None,
            "distance_axis_x": None,
            "distance_axis_y": None,
            "distance_axis_z": None,
            "distance_xy": None,
            "distance_xyz": None,
            "displacement_xy": None,
            "displacement_xyz": None,
            "delta_t_s": None,
            "heel_strike": 0.0,
            "heel_strike_time": None,
            "toe_off": 0.0,
            "toe_off_time": None,
        }

        if motion_sample is not None:
            rotated_acc = motion_sample["rotated_acc_world"]
            rotated_gyro = motion_sample["rotated_gyro_world"]
            linear_acc = motion_sample["linear_acc_world"]
            velocity = motion_sample["velocity_world"]
            position = motion_sample["position_world"]
            distance_axis = motion_sample["distance_axis"]
            row.update(
                {
                    "rotated_acc_x": self._finite_or_none(rotated_acc[0]),
                    "rotated_acc_y": self._finite_or_none(rotated_acc[1]),
                    "rotated_acc_z": self._finite_or_none(rotated_acc[2]),
                    "rotated_gyro_x": self._finite_or_none(rotated_gyro[0]),
                    "rotated_gyro_y": self._finite_or_none(rotated_gyro[1]),
                    "rotated_gyro_z": self._finite_or_none(rotated_gyro[2]),
                    "linear_acc_x": self._finite_or_none(linear_acc[0]),
                    "linear_acc_y": self._finite_or_none(linear_acc[1]),
                    "linear_acc_z": self._finite_or_none(linear_acc[2]),
                    "velocity_x": self._finite_or_none(velocity[0]),
                    "velocity_y": self._finite_or_none(velocity[1]),
                    "velocity_z": self._finite_or_none(velocity[2]),
                    "position_x": self._finite_or_none(position[0]),
                    "position_y": self._finite_or_none(position[1]),
                    "position_z": self._finite_or_none(position[2]),
                    "distance_axis_x": self._finite_or_none(distance_axis[0]),
                    "distance_axis_y": self._finite_or_none(distance_axis[1]),
                    "distance_axis_z": self._finite_or_none(distance_axis[2]),
                    "distance_xy": self._finite_or_none(motion_sample["distance_xy"]),
                    "distance_xyz": self._finite_or_none(motion_sample["distance_xyz"]),
                    "displacement_xy": self._finite_or_none(motion_sample["displacement_xy"]),
                    "displacement_xyz": self._finite_or_none(motion_sample["displacement_xyz"]),
                    "delta_t_s": self._finite_or_none(motion_sample["delta_t_s"]),
                }
            )

        return row

    async def _flush_all(self, buffers: Dict[str, List[Dict[str, Any]]]) -> None:
        for csv_path, rows in list(buffers.items()):
            if rows:
                await self._flush(csv_path, rows)
                rows.clear()

    async def _flush(self, csv_path: str, rows: List[Dict[str, Any]]):
        if not csv_path:
            log.warning("Flush called but no trial file set – discarding rows.")
            return
        df = pd.DataFrame(rows, columns=PACKET_COLUMNS)
        await asyncio.to_thread(
            df.to_csv,
            csv_path,
            mode="a",
            header=False,
            index=False,
            na_rep=""
        )
        log.debug("Flushed %d rows to %s", len(rows), os.path.basename(csv_path))

    # ────────────────────────────────────────────────────────────
    #   inference helpers
    # ────────────────────────────────────────────────────────────
    def _load_models(self) -> None:
        """Load left/right models from models directory (XGBoost JSON)."""
        try:
            base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
            left_path = os.path.join(base_dir, "models", "LeftFz_Tuned.json")
            right_path = os.path.join(base_dir, "models", "RightFz_Tuned.json")

            if xgb is None:
                log.warning("xgboost is not available; GRF predictions will be skipped.")
                self.model_left = None
                self.model_right = None
                return

            self.model_left = xgb.XGBRegressor()
            if not hasattr(self.model_left, "_estimator_type"):
                self.model_left._estimator_type = "regressor"
            self.model_left.load_model(fname=LEFT_MODEL_PATH)
            self.model_right = xgb.XGBRegressor()
            if not hasattr(self.model_right, "_estimator_type"):
                self.model_right._estimator_type = "regressor"
            self.model_right.load_model(fname=RIGHT_MODEL_PATH)
        except Exception:
            log.exception("Failed to load GRF models; predictions disabled.")
            self.model_left = None
            self.model_right = None

    def _build_features_from_row(self, side: str, row: Dict[str, Any]) -> Optional[np.ndarray]:
        """Feature vector [GyroX GyroY GyroZ AccX AccY AccZ P0 P1 P2 P3] from current row."""
        assert side in ("left", "right")
        gx = row.get(f"{side}_foot_gyro_x", np.nan)
        gy = row.get(f"{side}_foot_gyro_y", np.nan)
        gz = row.get(f"{side}_foot_gyro_z", np.nan)
        ax = row.get(f"{side}_foot_acc_x", np.nan)
        ay = row.get(f"{side}_foot_acc_y", np.nan)
        az = row.get(f"{side}_foot_acc_z", np.nan)
        p0 = row.get(f"{side}_insole_p0", np.nan)
        p1 = row.get(f"{side}_insole_p1", np.nan)
        p2 = row.get(f"{side}_insole_p2", np.nan)
        p3 = row.get(f"{side}_insole_p3", np.nan)
        


        # in order p0,p1,p2,p3
        left_min = [759.4327392578125, 760.40380859375  , 758.4012451171875, 757.2743530273438] 
        right_min = [758.346923828125 , 761.5031127929688, 759.589599609375 , 761.798828125]

        right_max = [782.8119507, 812.3920898, 918.4819946, 818.4212036]
        left_max = [776.9824829, 859.6234131, 789.850708, 773.8512573]


        #do min max normalization and go to zero if less than zero
        p0 =  max(0, (p0 - left_min[0]) / (left_max[0] - left_min[0]))
        p1 =  max(0, (p1 - left_min[1]) / (left_max[1] - left_min[1]))
        p2 =  max(0, (p2 - left_min[2]) / (left_max[2] - left_min[2]))
        p3 =  max(0, (p3 - left_min[3]) / (left_max[3] - left_min[3]))

        psum = p0 + p1 + p2 + p3

        fx = [gx, gy, gz, ax, ay, az, p0, p1, p2, p3, psum]

        x = np.array(fx)
        x = x.reshape(1, -1)
        return x

    def _predict(self, booster: Any, features: np.ndarray) -> float:
        if xgb is None:
            raise RuntimeError("xgboost not available")
        dm = xgb.DMatrix(features.reshape(1, -1))
        pred = booster.predict(dm)
        return float(pred.ravel()[0])

    async def _resolve_devices(self, selectors: List[Optional[str]]):
        sels = [s for s in selectors]
        if not sels[0] or not sels[1]:
            raise RuntimeError("DEV1 and DEV2 must be set.")
        discovered = await BleakScanner.discover(timeout=10.0)

        res = []
        for s in sels[-1:]:
            s_l = s.lower()
            chosen = None
            for d in discovered:
                name = (d.name or "").lower()
                addr = getattr(d, "address", None) or getattr(d, "mac_address", None) or ""
                if s_l in name or s_l == addr.lower():
                    chosen = d
                    break
            if chosen is None and (":" in s or len(s) in (12, 17)):
                chosen = await BleakScanner.find_device_by_address(s, timeout=5.0)
            if chosen is None:
                raise RuntimeError(f"Could not resolve BLE device: {s}")
            res.append(chosen)
        return res

    def _parse_ble_values(self, data: bytes) -> Optional[Dict[str, float]]:
        try:
            text = data.decode("utf-8", errors="ignore")
        except Exception:
            return None
        start_brace = text.find("{")
        start_brack = text.find("[")
        if start_brace == -1 and start_brack == -1:
            return None
        if start_brace == -1:
            start = start_brack
        elif start_brack == -1:
            start = start_brace
        else:
            start = min(start_brace, start_brack)
        end = max(text.rfind("}"), text.rfind("]"))
        if end <= start:
            return None
        core = text[start + 1 : end]
        raw_parts = [p.strip() for p in core.replace(";", ",").split(",")]
        vals = self._convert_ble_values(raw_parts)
        if not vals:
            return None
        return {
            "qw": vals[0],
            "qx": vals[1],
            "qy": vals[2],
            "qz": vals[3],
            "acc_x": vals[4],
            "acc_y": vals[5],
            "acc_z": vals[6],
            "gyr_x": vals[7],
            "gyr_y": vals[8],
            "gyr_z": vals[9],
        }

    def _convert_ble_values(self, parts: List[str]) -> Optional[List[float]]:
        out: List[float] = []
        for i in range(10):
            if i >= len(parts):
                out.append(float("nan"))
                continue
            token = parts[i].strip()
            try:
                raw = float(token)
                if i < 4:
                    val = raw - 2.0
                elif 4 <= i <= 6:
                    g_val = (raw - 50000.0) / 16384.0
                    val = g_val * 9.80665
                elif 7 <= i <= 9:
                    dps = (raw - 50000.0) / 131.0
                    val = dps * (math.pi / 180.0)
                else:
                    val = raw
                out.append(float(val))
            except Exception:
                out.append(float("nan"))
        return out

    def _load_event_thresholds(self) -> tuple[Dict[str, Dict[str, float]], float]:
        config_path = Path(self.root_dir) / "event_threshold.yml"
        if not config_path.exists():
            config_path = Path(__file__).resolve().parents[1] / "config" / "event_threshold.yml"
        cfg = read_config(config_path)
        processing_cfg = cfg.get("processing", {})
        fs = float(processing_cfg.get("estimated_fs_hz", PACKET_DEFAULT_FS_HZ))
        thresholds: Dict[str, Dict[str, float]] = {}
        for side in ("left", "right"):
            side_cfg = cfg.get(side)
            if not isinstance(side_cfg, dict):
                raise ValueError(f"Missing '{side}' thresholds in {config_path}")
            required_keys = ("hs_thr", "to_thr", "to_prev_min", "to_prev_max")
            missing = [key for key in required_keys if key not in side_cfg]
            if missing:
                raise ValueError(f"Missing {missing} in '{side}' thresholds from {config_path}")
            thresholds[side] = {
                key: float(side_cfg[key]) for key in required_keys
            }
        return thresholds, fs

    def _load_event_processing(self) -> Dict[str, float]:
        config_path = Path(self.root_dir) / "event_threshold.yml"
        if not config_path.exists():
            config_path = Path(__file__).resolve().parents[1] / "config" / "event_threshold.yml"
        cfg = read_config(config_path)
        processing_cfg = cfg.get("processing", {})
        return {
            "hs_pct": float(processing_cfg.get("hs_pct", RT_HS_PCT)),
            "to_range_frac": float(processing_cfg.get("to_range_frac", RT_TO_RANGE_FRAC)),
            "threshold_window_samples": int(processing_cfg.get("threshold_window_samples", RT_THRESHOLD_WINDOW_SAMPLES)),
        }

    def _process_gyro_heel_strike(self, device_key: str, values: Dict[str, float], packet_time: float) -> None:
        if not self.calibration_done:
            return
        side = device_key.split("/", 1)[0].lower()
        detector = self.gyro_event_detectors.get(device_key)
        gyro_y = values.get("gyr_y")
        gyro_y_float = float(gyro_y) if gyro_y is not None else float("nan")
        heel_strike_time: Optional[float] = None
        toe_off_time: Optional[float] = None

        values["heel_strike"] = 0.0
        values["heel_strike_time"] = float("nan")
        values["toe_off"] = 0.0
        values["toe_off_time"] = float("nan")

        if detector is None:
            log.debug("Skipping gait event detection for %s: detector not configured", device_key)
        elif side not in self.event_thresholds:
            log.debug("Skipping gait event detection for %s: thresholds missing for side %s", device_key, side)
        elif gyro_y is None or not np.isfinite(gyro_y):
            log.debug("Skipping gait event detection for %s: invalid gyro_y=%r", device_key, gyro_y)
        else:
            event = detector.step(gyro_y_float, packet_time)
            values["filtered_gyr_y"] = detector.filtered_value
            if event is None:
                if detector.idx % max(int(detector.fs), 1) == 0:
                    recent = ", ".join(f"{sample:.3f}" for sample in detector.buf[-3:])
                    log.debug(
                        "%s no event after %d samples; state=%s gyro_y=%.3f filtered_recent=[%s] hs_thr=%.3f to_thr=%.3f threshold_source=%s min=%.3f max=%.3f window=[%.3f,%.3f] actual_fs=%.2f",
                        device_key,
                        detector.idx,
                        detector.state,
                        float(gyro_y),
                        recent,
                        detector.hs_thr,
                        detector.to_thr,
                        detector.threshold_source,
                        detector.window_min,
                        detector.window_max,
                        detector.to_window_start_time,
                        detector.to_window_end_time,
                        detector._actual_fs_estimate,
                    )
            else:
                event_name, event_time = event
                if event_name == "HS":
                    heel_strike_time = event_time
                    self.hs_events.append(event_time)

                    if len(self.hs_events) == 1:

                        self.stride_buffers[device_key]["t"].clear()
                        self.stride_buffers[device_key]["ax"].clear()
                        self.stride_buffers[device_key]["ay"].clear()
                        self.stride_buffers[device_key]["az"].clear()
                    # Need two consecutive HS events
                    if len(self.hs_events) >= 2:

                        hs_prev = self.hs_events[-2]
                        hs_curr = self.hs_events[-1]

                        buf = self.stride_buffers[device_key]

                        seg_t = np.asarray(buf["t"])

                        seg_ax = np.asarray(buf["ax"])
                        seg_ay = np.asarray(buf["ay"])
                        seg_az = np.asarray(buf["az"])

                        if len(seg_t) > 5:

                            seg_t = seg_t - seg_t[0]

                            seg_a = np.column_stack(
                                (seg_ax, seg_ay)
                            )

                            log.info(
                                f"Stride buffer samples = {len(seg_t)}"
                            )
                            stride_length = np.nan
                            stride_height = np.nan
                            try:

                                vel_corr, pos_corr = integrate_fb_sigmoid_segment(
                                    seg_t,
                                    seg_a,
                                    sigmoid_k=10.0
                                )

                                stride_length = np.linalg.norm(
                                    pos_corr[-1] - pos_corr[0]
                                )

                                # --------------------------------------------------
                                # REALTIME STRIDE HEIGHT
                                # --------------------------------------------------

                                vel_z = np.zeros_like(seg_az)

                                for i in range(1, len(seg_az)):

                                    dt = seg_t[i] - seg_t[i - 1]

                                    vel_z[i] = (
                                        vel_z[i - 1]
                                        + 0.5 * (seg_az[i] + seg_az[i - 1]) * dt
                                    )

                                duration = seg_t[-1] - seg_t[0]

                                if duration > 0:

                                    tau = (seg_t - seg_t[0]) / duration

                                    vel_z = vel_z - tau * vel_z[-1]

                                    height_z = np.zeros_like(vel_z)

                                    for i in range(1, len(vel_z)):

                                        dt = seg_t[i] - seg_t[i - 1]

                                        height_z[i] = (
                                            height_z[i - 1]
                                            + 0.5 * (vel_z[i] + vel_z[i - 1]) * dt
                                        )

                                    height_z = height_z - tau * height_z[-1]

                                    stride_height = np.max(height_z)

                                else:

                                    stride_height = np.nan

                            except Exception:

                                stride_length = np.nan
                                stride_height = np.nan

                            finally:

                                self.stride_buffers[device_key]["t"].clear()
                                self.stride_buffers[device_key]["ax"].clear()
                                self.stride_buffers[device_key]["ay"].clear()
                                self.stride_buffers[device_key]["az"].clear()

                        else:

                            stride_length = np.nan
                            stride_height = np.nan

                            self.stride_buffers[device_key]["t"].clear()
                            self.stride_buffers[device_key]["ax"].clear()
                            self.stride_buffers[device_key]["ay"].clear()
                            self.stride_buffers[device_key]["az"].clear()

                        # Find TO between HS(i) and HS(i+1)
                        valid_to = [
                            t for t in self.to_events
                            if hs_prev < t < hs_curr
                        ]

                        if len(valid_to) >= 1:

                            to = valid_to[0]

                            stride_time = hs_curr - hs_prev
                            stance_time = to - hs_prev
                            swing_time = hs_curr - to
                            cadence = 120.0 / stride_time

                            cycle_no = len(self.realtime_temporal_rows)+1
                            log.info(
                                f"\n===== REALTIME TEMPORAL (Cycle {cycle_no}) =====\n"
                                f"HS Time     : {hs_prev:.3f} s\n"
                                f"TO Time     : {to:.3f} s\n"
                                f"Next HS Time: {hs_curr:.3f} s\n"
                                f"Stride Time : {stride_time:.3f} s\n"
                                f"Stance Time : {stance_time:.3f} s\n"
                                f"Swing Time  : {swing_time:.3f} s\n"
                                f"Cadence     : {cadence:.2f} steps/min\n"
                                f"Stride Length : {stride_length:.3f} m\n"
                                f"Stride Height : {stride_height:.3f} m\n"
                            )

                            self.realtime_temporal_rows.append({
                                "cycle": cycle_no,
                                "hs_time": hs_prev,
                                "to_time": to,
                                "next_hs_time": hs_curr,
                                "stride_time_s": stride_time,
                                "stance_time_s": stance_time,
                                "swing_time_s": swing_time,
                                "cadence_spm": cadence,
                                "stride_length_m": stride_length,
                                "stride_height_m": stride_height
                            })
                    self.latest_heel_strike[device_key] = event_time
                    values["heel_strike"] = 1.0
                    values["heel_strike_time"] = event_time
                    log.info("%s heel strike detected at %.3f", device_key, event_time)
                elif event_name == "TO":
                    toe_off_time = event_time
                    self.to_events.append(event_time)
                    values["toe_off"] = 1.0
                    values["toe_off_time"] = event_time
                    log.info("%s toe off detected at %.3f", device_key, event_time)

        # Streaming debug publishing is disabled for the CSV capture workflow.
        # self._queue_mqtt_debug_sample(
        #     device_key=device_key,
        #     packet_time=packet_time,
        #     values=values,
        #     heel_strike_time=heel_strike_time,
        #     toe_off_time=toe_off_time,
        # )
        # self._queue_mqtt_imu_sample(
        #     device_key=device_key,
        #     packet_time=packet_time,
        #     values=values,
        # )
