import asyncio
import os
import numpy as np
from config_reader.config_reader import read_config
from mqtt_communication_interface.mqtt_client import MqttClientManager
from scipy.spatial.transform import Rotation as R
from scipy.signal import butter, lfilter
from data_collector import TrialDataLogger
from calibration_utils import *

import json
import logging
import yaml
import os
import traceback
from typing import Any, Dict, Optional



logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)





class IMUCalibrator:
    def __init__(self, packet_source: TrialDataLogger | None = None):
        self.topic_messages = {}
        self.lock_dict = {} 
        self.segment_axis_dict = {}
        self.walk_threshold_file = "event_threshold.yml"
        self.packet_source: TrialDataLogger | None = packet_source
        self.owns_packet_source = packet_source is None

    #destructor
    def __del__(self):
        try:
            # logger.info("IMUCalibrator instance has been deleted.")
            asyncio.run(self.shutdown())
        except Exception as e:
            logger.error(f"Error during shutdown: {e}")
        finally:
            logger.info("IMUCalibrator instance has been deleted.")


    def evaluate_op(self, node, context):
        if isinstance(node, str):
            return context[node]  # e.g., "accel", "z_axis", etc.
        elif isinstance(node, dict) and "op" in node:
            func = context[node["op"]]
            args = [self.evaluate_op(arg, context) for arg in node["args"]]
            return func(*args)
        else:
            raise ValueError(f"Unsupported operation format: {node}")


    def save_rotation_matrix_to_yaml(self, file_path, limb, segment, rotation_matrix):

        dir_path = os.path.dirname(file_path)
        os.makedirs(dir_path, exist_ok=True)
        if os.path.exists(file_path):
            with open(file_path, "r") as f:
                try:
                    data = yaml.safe_load(f) or {}
                except Exception:
                    data = {}
        else:
            data = {}    
    
        # Ensure structure
        if "limbs" not in data or data["limbs"] is None:
            data["limbs"] = {}

        limbs = data["limbs"]

        if limb not in limbs or limbs[limb] is None:
            limbs[limb] = {}

        if segment not in limbs[limb] or limbs[limb][segment] is None:
            limbs[limb][segment] = []

        # Store the rotation matrix as a list of lists (3x3)
        limbs[limb][segment] = rotation_matrix.tolist()

        # Write back to YAML
        with open(file_path, "w") as f:
            yaml.dump(data, f, default_flow_style=False, sort_keys=False)


    

    async def initialize(self):
        self.sensor_config = read_config("/workspace/config/sensor_config.yml")
        self.topic_list = [
            "imu/left/thigh", "imu/left/shank",  "imu/left/foot",
            "imu/right/thigh","imu/right/shank", "imu/right/foot",
            "pressure/left/foot","pressure/right/foot"
        ]

        self.rotation_matrices_path = "sensor_rotation_matrices.yml"
               
        for topic in self.topic_list:
            self.lock_dict[topic] = False
        if self.packet_source is None:
            self.packet_source = TrialDataLogger(
                root_dir="/tmp/ble_calibration_capture",
                enable_ble=True,
                capture_only=True,
            )
            self.owns_packet_source = True
            await self.packet_source.connect_ble_only()
            print("[calib] BLE packet source started in capture-only mode")
        self.packet_source.add_packet_listener(self._handle_ble_packet)



    async def start_listening(self):
        # BLE capture starts in initialize(); keep this for compatibility with main.py.
        return

    async def run(self):
        while True:
            await asyncio.sleep(1)  # Keeps the loop alive

    async def shutdown(self):
        if self.packet_source is not None and self.owns_packet_source:
            await self.packet_source.stop()
            self.packet_source = None
            print("[calib] BLE packet source stopped")


        # def check_calibratition_utils(self):
        #     print(minus(np.array([1, 2, 3])))
        #     print(mean(np.array([[1, 2, 3], [4, 5, 6]])))
        #     print(normalize(np.array([1, 2, 3])))
        #     print(cross(np.array([1, 0, 0]), np.array([0, 1, 0])))
        #     print(compose_rotation_matrix(np.array([1, 0, 0]), np.array([0, 1, 0]), np.array([0, 0, 1])))
        #     print("Calibration utils are working correctly.")
            
    async def run_calibration_sequence(self, rotation_matrices_dict):
        self.calibration_config = read_config("/workspace/config/calib_config2.yml")
        if not self.calibration_config:
            print("Error: Unable to read calibration config file.")
            return

        collected_thresholds: dict[str, dict[str, float]] = {}
        for sequence_item in self.calibration_config.get("calibration_sequence", []):
            side = str(sequence_item.get("side", "")).lower()
            if side not in ("left", "right"):
                print(f"Skipping calibration step with invalid side: {side!r}")
                continue

            duration_s = float(sequence_item.get("duration", 30))
            instruction = sequence_item.get(
                "instruction",
                f"Look to the {side} and walk for {duration_s:.0f} seconds.",
            )
            threshold = await self.capture_side_threshold(
                side=side,
                duration_s=duration_s,
                instruction=instruction,
            )
            if threshold is None:
                print(f"Unable to compute gait thresholds for {side} side.")
                return
            collected_thresholds[side] = threshold

        if "left" not in collected_thresholds or "right" not in collected_thresholds:
            print("Error: Both left and right thresholds are required.")
            return

        output_path = os.path.join(rotation_matrices_dict, self.walk_threshold_file)
        self.save_event_thresholds_to_yaml(output_path, collected_thresholds)
        print(f"Saved gait thresholds to {output_path}")

    async def capture_side_threshold(
        self,
        side: str,
        duration_s: float = 12.0,
        instruction: str | None = None,
    ) -> Optional[dict[str, float]]:
        print(f"\nWalking threshold capture for {side} side")
        if instruction is None:
            instruction = f"Walk at a comfortable pace in a straight line for {duration_s:.1f} seconds."
        print(f"Instruction: {instruction}")
        input("Press Enter when ready to start walking capture...")

        topic_key = f"imu/{side}/foot"
        self.topic_messages[topic_key] = []
        self.lock_dict[topic_key] = True
        print(f"[calib] walking capture armed for {topic_key}")

        duration_s = float(duration_s)
        print(f"[calib] walking capture started for {duration_s:.1f}s")
        await asyncio.sleep(duration_s)

        self.lock_dict[topic_key] = False
        print(f"[calib] walking capture stopped for {topic_key}")

        thresholds = self.compute_walking_thresholds([topic_key])
        if thresholds is None or side not in thresholds:
            print("Unable to compute gait thresholds from the walking capture.")
            return
        return thresholds[side]

    #write me a function which will now convert whatever field I ask for in present in the proto say acceleration, gyro, quat, timestamp to a numpy array and return it a numpy array of (n,3) or (n,4) or (n,1) depending on the field

    def get_field_as_numpy_array(self, field_name, topic):
        if field_name not in ['acceleration', 'gyro', 'quat', 'timestamp']:
            raise ValueError(f"Field '{field_name}' is not supported. Choose from 'acceleration', 'gyro', 'quat', or 'timestamp'.")

        result = []
        for imu_data in self.topic_messages.get(topic, []):
            if isinstance(imu_data, dict):
                if field_name == 'acceleration':
                    result.append(imu_data.get("acceleration", [np.nan, np.nan, np.nan]))
                elif field_name == 'gyro':
                    result.append(imu_data.get("gyro", [np.nan, np.nan, np.nan]))
                elif field_name == 'quat':
                    result.append(imu_data.get("quat", [np.nan, np.nan, np.nan, np.nan]))
                elif field_name == 'timestamp':
                    result.append([imu_data.get("timestamp", np.nan)])
                continue
            if field_name == 'acceleration':
                result.append([imu_data.acceleration.x, imu_data.acceleration.y, imu_data.acceleration.z])
            elif field_name == 'gyro':
                result.append([imu_data.gyro.x, imu_data.gyro.y, imu_data.gyro.z])
            elif field_name == 'quat':
                result.append([imu_data.quat.w, imu_data.quat.x, imu_data.quat.y, imu_data.quat.z])
            elif field_name == 'timestamp':
                result.append([imu_data.timestamp])

        arr = np.array(result)
        print(f"[calib] read field='{field_name}' topic='{topic}' shape={arr.shape}")
        if arr.size:
            preview = arr[:3].tolist()
            print(f"[calib] preview field='{field_name}' topic='{topic}': {preview}")
        return arr

    def compute_walking_thresholds(self, topics):
        gyro_series = {}
        timestamp_series = {}
        for topic in topics:
            gyro = self.get_field_as_numpy_array("gyro", topic)
            ts = self.get_field_as_numpy_array("timestamp", topic).reshape(-1)
            if gyro.size == 0 or ts.size == 0:
                print(f"No walking data captured for topic {topic}")
                return None
            gyro_series[topic] = gyro[:, 1].astype(float)
            timestamp_series[topic] = ts.astype(float)
            print(
                f"[calib] walking raw topic={topic} samples={gyro_series[topic].shape[0]} "
                f"ts_start={timestamp_series[topic][0]:.3f} ts_end={timestamp_series[topic][-1]:.3f}"
            )

        def _estimate_fs(samples: np.ndarray) -> float:
            if samples.size < 2:
                return 60.0
            diffs = np.diff(samples)
            diffs = diffs[np.isfinite(diffs) & (diffs > 0)]
            if diffs.size == 0:
                return 60.0
            median_dt = float(np.median(diffs))
            return 1.0 / median_dt if median_dt > 0 else 60.0

        def _lowpass(sig: np.ndarray, fs: float, cutoff_hz: float = 6.0, order: int = 4) -> np.ndarray:
            if sig.size == 0:
                return sig
            if fs <= 0:
                fs = 60.0
            b, a = butter(order, cutoff_hz / (fs / 2.0), btype="low")
            zi = np.zeros(max(len(a), len(b)) - 1)
            y, _ = lfilter(b, a, sig.astype(float), zi=zi)
            return y.astype(float)

        thresholds = {}
        for topic in topics:
            side = topic.split("/")[1]
            sig = gyro_series[topic]
            fs = _estimate_fs(timestamp_series[topic])
            filtered = _lowpass(sig, fs)
            if filtered.size == 0:
                print(f"No filtered walking signal for {topic}")
                return None

            sig_min = float(np.min(filtered))
            sig_max = float(np.max(filtered))
            sig_rng = max(sig_max - sig_min, 1e-6)
            hs_thr = float(np.clip(sig_min + 0.80 * sig_rng, 1e-6, 0.499999))
            to_thr = float(max(0.0 - 0.10 * sig_rng, -0.25))
            print(
                f"[calib] thresholds topic={topic} side={side} fs={fs:.3f} "
                f"min={sig_min:.6f} max={sig_max:.6f} hs_thr={hs_thr:.6f} "
                f"to_thr={to_thr:.6f}"
            )
            thresholds[side] = {
                "min": sig_min,
                "max": sig_max,
                "hs_thr": hs_thr,
                "to_thr_ref": to_thr,
                "to_thr": to_thr,
                "to_prev_min": to_thr,
                "to_prev_max": 0.0,
                "estimated_fs_hz": fs,
                "samples": int(filtered.size),
                "timestamp_start_epoch_s": float(timestamp_series[topic][0]),
                "timestamp_end_epoch_s": float(timestamp_series[topic][-1]),
                "duration_s": float(timestamp_series[topic][-1] - timestamp_series[topic][0]),
            }

        return thresholds

    def save_event_thresholds_to_yaml(self, file_path: str, thresholds: dict[str, dict[str, float]]) -> None:
        payload = {
            "source": {
                "derived_from": "calibration_main.walking_capture",
            },
            "processing": {
                "estimated_fs_hz": float(
                    np.mean([thresholds[side]["estimated_fs_hz"] for side in ("left", "right") if side in thresholds])
                ),
                "hs_pct": 0.8,
                "to_range_frac": 0.1,
                "to_prev_max": 0.0,
                "cutoff_hz": 6.0,
                "filter_order": 4,
            },
            "left": {
                key: thresholds["left"][key]
                for key in ("min", "max", "hs_thr", "to_thr_ref", "to_thr", "to_prev_min", "to_prev_max")
            },
            "right": {
                key: thresholds["right"][key]
                for key in ("min", "max", "hs_thr", "to_thr_ref", "to_thr", "to_prev_min", "to_prev_max")
            },
        }
        payload["source"].update(
            {
                "timestamp_start_epoch_s": min(thresholds["left"]["timestamp_start_epoch_s"], thresholds["right"]["timestamp_start_epoch_s"]),
                "timestamp_end_epoch_s": max(thresholds["left"]["timestamp_end_epoch_s"], thresholds["right"]["timestamp_end_epoch_s"]),
                "duration_s": max(thresholds["left"]["timestamp_end_epoch_s"], thresholds["right"]["timestamp_end_epoch_s"])
                - min(thresholds["left"]["timestamp_start_epoch_s"], thresholds["right"]["timestamp_start_epoch_s"]),
                "samples": int(max(thresholds["left"]["samples"], thresholds["right"]["samples"])),
            }
        )
        print(f"[calib] writing event thresholds yaml to {file_path}")
        print(f"[calib] payload preview: {payload}")
        with open(file_path, "w") as f:
            yaml.safe_dump(payload, f, sort_keys=False)

    def _handle_ble_packet(
        self,
        device_key: str,
        values: Dict[str, float],
        packet_time: float,
        motion_sample: Optional[Dict[str, Any]],
    ) -> None:
        topic_key = f"imu/{device_key}"
        if not self.lock_dict.get(topic_key, False):
            return
        packet = {
            "timestamp": packet_time,
            "acceleration": [values.get("acc_x"), values.get("acc_y"), values.get("acc_z")],
            "gyro": [values.get("gyr_x"), values.get("gyr_y"), values.get("gyr_z")],
            "quat": [values.get("qw"), values.get("qx"), values.get("qy"), values.get("qz")],
        }
        self.topic_messages.setdefault(topic_key, []).append(packet)
        if len(self.topic_messages[topic_key]) > 1000:
            self.topic_messages[topic_key] = self.topic_messages[topic_key][-1000:]
        if len(self.topic_messages[topic_key]) <= 3 or len(self.topic_messages[topic_key]) % 100 == 0:
            print(
                f"[calib] stored BLE packet topic={topic_key} count={len(self.topic_messages[topic_key])} "
                f"packet_time={packet_time:.3f} gyro_y={values.get('gyr_y')}"
            )


# async def main():

#     try:

#         # imu_publisher = IMUPublisher()
#         # # asyncio.ensure_future(imu_publisher.start())
#         # publisher_task = asyncio.create_task(imu_publisher.start())
#         print("IMU Publisher started...")

#         imu_listener = IMUCalibrator()
#         await imu_listener.initialize()
#         await imu_listener.start_listening()

#         # Run calibration sequence if needed
#         await imu_listener.run_calibration_sequence()


        
#         # await imu_listener.run()
#     except KeyboardInterrupt:
#         print("\nShutting down listener...")
#         await imu_listener.shutdown()

# if __name__ == "__main__":
#     asyncio.run(main())
