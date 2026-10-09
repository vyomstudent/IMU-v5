import csv
import asyncio
from imu_pb2 import IMUData, Vector3, Quaternion  # Import Vector3 and Quaternion directly
from libs.zmq_communication_interface.abstract_zmq_communication_interface import ZMQInterface

# ZMQ Configuration
ZMQ_PORT = "5555"

# Async function to publish IMU data
async def publish_imu_data(csv_file_path, frequency_hz=60):
    zmq_iface = ZMQInterface()
    await zmq_iface.bind_publisher(f"tcp://*:{ZMQ_PORT}")



    print(f"Publishing IMU data from {csv_file_path} at {frequency_hz} Hz...\n\n\n")

    with open(csv_file_path, 'r') as csvfile:
        reader = csv.DictReader(csvfile)
        print(f"CSV Headers: {reader.fieldnames}")
        for row in reader:
            for limb in ["left", "right"]:
                for segment in ["thigh", "shank", "foot"]:
                    topic = f"imu/{limb}/{segment}"

                    imu_data = IMUData(
                        imu_position=topic,  # Using topic as imu_position
                        acceleration=Vector3(
                            x=float(row[f"{limb}_{segment}_acc_x"]),
                            y=float(row[f"{limb}_{segment}_acc_y"]),
                            z=float(row[f"{limb}_{segment}_acc_z"]),
                        ),
                        gyro=Vector3(
                            x=float(row[f"{limb}_{segment}_gyro_x"]),
                            y=float(row[f"{limb}_{segment}_gyro_y"]),
                            z=float(row[f"{limb}_{segment}_gyro_z"]),
                        ),
                        mag=Vector3(
                            x=0.0,  # Placeholder values for mag
                            y=0.0,
                            z=0.0,
                        ),
                        quat=Quaternion(
                            i=float(row[f"{limb}_{segment}_quat_i"]),
                            j=float(row[f"{limb}_{segment}_quat_j"]),
                            k=float(row[f"{limb}_{segment}_quat_k"]),
                            real=float(row[f"{limb}_{segment}_quat_real"]),
                        ),
                        timestamp=int(float(row["timestamp"])),  # Convert to float first, then cast to integer
                    )

            # Publish the IMU data
                    # print(f"Publishing IMU data for topic: {topic}")
                    await zmq_iface.publish(topic, imu_data.SerializeToString())

            await asyncio.sleep(1 / frequency_hz)

if __name__ == "__main__":
    csv_file_path = "/workspace/imu.csv"  # Adjust the path if needed
    asyncio.run(publish_imu_data(csv_file_path))
