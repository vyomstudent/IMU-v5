/*
 * VSPIMU V5.9 — ESP32-C3 RAW-ONLY BLE TRANSPORT
 *
 * Purpose
 *   Read raw LSM6DSO 6-axis samples and stream them to the existing Android /
 *   MIT App Inventor app. ALL gait analysis, normalization, TCN inference,
 *   AFO, step/event detection, metrics, and report generation remain on the phone.
 *
 * Hardware
 *   ESP32-C3 Dev Module
 *   LSM6DSO I2C address: 0x6B (WHO_AM_I must be 0x6C)
 *   SDA GPIO4, SCL GPIO5, I2C 400 kHz
 *   Accelerometer: 208 Hz, +/-4 g
 *   Gyroscope:     208 Hz, +/-2000 dps
 *
 * BLE contract (kept compatible with the existing VSPIMU app)
 *   Name:      GAIT-V5-C3
 *   Service:   7b8a0001-4f2a-4a2e-9e51-1d9b6d8d5001
 *   Raw data:  7b8a0002-4f2a-4a2e-9e51-1d9b6d8d5001
 *   Command:   7b8a0003-4f2a-4a2e-9e51-1d9b6d8d5001
 *   Analytics: 7b8a0004-4f2a-4a2e-9e51-1d9b6d8d5001 (present, unused)
 *
 * Raw notification format: up to 12 records / 192 bytes per notification.
 * Each record is 8 little-endian signed 16-bit words:
 *   [sequence_low, sequence_high, ax_raw, ay_raw, az_raw, gx_raw, gy_raw, gz_raw]
 * The sequence restarts at zero on each START and advances on the 208-Hz
 * sample timeline. Sequence jumps let the phone identify missing samples.
 *
 * Commands: UTF-8 strings "START", "STOP", and optional "PING".
 * This sketch does not use LittleFS/SD, does not save session files, and does
 * not run any gait/ML/clinical algorithm. The analytics characteristic is
 * deliberately NOT populated with fake summaries or parity events.
 *
 * Required libraries: Arduino-ESP32 core 3.x and NimBLE-Arduino 2.x.
 */

#include <Arduino.h>
#include <Wire.h>
#include <NimBLEDevice.h>
#include <freertos/FreeRTOS.h>
#include <stdint.h>
#include <string>
#include <ctype.h>

// =========================== BLE CONTRACT ===========================
static constexpr char DEVICE_NAME[] = "GAIT-V5-C3";
static constexpr char SERVICE_UUID[] = "7b8a0001-4f2a-4a2e-9e51-1d9b6d8d5001";
static constexpr char DATA_UUID[]    = "7b8a0002-4f2a-4a2e-9e51-1d9b6d8d5001";
static constexpr char CMD_UUID[]     = "7b8a0003-4f2a-4a2e-9e51-1d9b6d8d5001";
static constexpr char ANALYTICS_UUID[] = "7b8a0004-4f2a-4a2e-9e51-1d9b6d8d5001";

// =========================== SENSOR CONFIG ==========================
static constexpr uint8_t LSM6DSO_ADDR = 0x6B;
static constexpr int SDA_PIN = 4; // ESP32-C3 wiring used by VSPIMU C3 builds
static constexpr int SCL_PIN = 5;
static constexpr uint32_t I2C_HZ = 400000UL;
static constexpr uint32_t RAW_HZ = 208UL;
static constexpr uint32_t SENSOR_STALL_TIMEOUT_MS = 1000UL;
static constexpr uint16_t MIN_REQUIRED_MTU = 195; // 192-byte notification + 3-byte ATT header

static constexpr uint8_t REG_WHO_AM_I = 0x0F;
static constexpr uint8_t REG_CTRL1_XL = 0x10;
static constexpr uint8_t REG_CTRL2_G  = 0x11;
static constexpr uint8_t REG_CTRL3_C  = 0x12;
static constexpr uint8_t REG_STATUS   = 0x1E;
static constexpr uint8_t REG_OUTX_L_G = 0x22; // Gyro XYZ then accelerometer XYZ through 0x2D
static constexpr uint8_t CTRL1_XL_VALUE = 0x58; // 208 Hz, +/-4 g
static constexpr uint8_t CTRL2_G_VALUE  = 0x5C; // 208 Hz, +/-2000 dps
static constexpr uint8_t CTRL3_C_VALUE  = 0x44; // BDU=1, IF_INC=1
static constexpr uint8_t WHO_AM_I_VALUE = 0x6C;

// =========================== PACKET FORMAT ===========================
static constexpr uint8_t SAMPLES_PER_PACKET = 12;
static constexpr uint8_t WORDS_PER_SAMPLE = 8;
static constexpr size_t RAW_PACKET_BYTES = SAMPLES_PER_PACKET * WORDS_PER_SAMPLE * sizeof(int16_t);
static_assert(RAW_PACKET_BYTES == 192, "VSPIMU raw BLE packet must be 192 bytes");

struct RawSample {
  int16_t ax;
  int16_t ay;
  int16_t az;
  int16_t gx;
  int16_t gy;
  int16_t gz;
};

static NimBLEServer *gServer = nullptr;
static NimBLECharacteristic *gRawCharacteristic = nullptr;
static NimBLECharacteristic *gCommandCharacteristic = nullptr;
static NimBLECharacteristic *gAnalyticsCharacteristic = nullptr;

static volatile bool gClientConnected = false;
static volatile uint16_t gClientMtu = 23;
static volatile bool gDataSubscribed = false;
static bool gSensorReady = false;
static bool gAcquiring = false;
static bool gWaitingForStart = false;
static uint32_t gMtuWaitLogMs = 0;

static int16_t gRawPacket[SAMPLES_PER_PACKET * WORDS_PER_SAMPLE];
static uint8_t gPacketSampleCount = 0;
static uint32_t gSessionStartUs = 0;
static uint32_t gNextExpectedSequence = 0;
static uint32_t gLastFreshSampleMs = 0;
static uint32_t gReadSamples = 0;
static uint32_t gSequenceGapSlots = 0;
static uint32_t gI2cErrors = 0;
static uint32_t gNotifyFailures = 0;
static uint32_t gPacketsNotified = 0;

// BLE callbacks run outside loop(); use a short critical section for commands.
enum PendingCommand : uint8_t { CMD_NONE = 0, CMD_START = 1, CMD_STOP = 2 };
static volatile uint8_t gPendingCommand = CMD_NONE;
static portMUX_TYPE gCommandMux = portMUX_INITIALIZER_UNLOCKED;

static void setPendingCommand(uint8_t command) {
  portENTER_CRITICAL(&gCommandMux);
  gPendingCommand = command;
  portEXIT_CRITICAL(&gCommandMux);
}

static uint8_t takePendingCommand() {
  portENTER_CRITICAL(&gCommandMux);
  const uint8_t command = gPendingCommand;
  gPendingCommand = CMD_NONE;
  portEXIT_CRITICAL(&gCommandMux);
  return command;
}

// =========================== I2C HELPERS =============================
static bool writeRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(LSM6DSO_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission(true) == 0;
}

static bool readRegister(uint8_t reg, uint8_t &value) {
  Wire.beginTransmission(LSM6DSO_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(LSM6DSO_ADDR, (uint8_t)1) != 1) return false;
  if (Wire.available() < 1) return false;
  value = (uint8_t)Wire.read();
  return true;
}

static bool readRegisters(uint8_t firstReg, uint8_t *destination, size_t length) {
  if (!destination || length == 0 || length > 32) return false;
  Wire.beginTransmission(LSM6DSO_ADDR);
  Wire.write(firstReg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(LSM6DSO_ADDR, (uint8_t)length) != length) return false;
  for (size_t i = 0; i < length; ++i) {
    if (Wire.available() < 1) return false;
    destination[i] = (uint8_t)Wire.read();
  }
  return true;
}

static int16_t decodeSigned16LE(uint8_t lowByte, uint8_t highByte) {
  const uint16_t raw = (uint16_t)lowByte | ((uint16_t)highByte << 8);
  const int32_t signedValue = (raw & 0x8000U) ? ((int32_t)raw - 65536L) : (int32_t)raw;
  return (int16_t)signedValue;
}

static bool readSampleIfReady(RawSample &sample) {
  uint8_t status = 0;
  if (!readRegister(REG_STATUS, status)) {
    ++gI2cErrors;
    return false;
  }
  // STATUS_REG: bit 0 = accelerometer data ready, bit 1 = gyroscope data ready.
  if ((status & 0x03U) != 0x03U) return false;

  uint8_t bytes[12];
  if (!readRegisters(REG_OUTX_L_G, bytes, sizeof(bytes))) {
    ++gI2cErrors;
    return false;
  }

  // LSM6DSO register order at 0x22 is gyro X/Y/Z first, then accel X/Y/Z.
  sample.gx = decodeSigned16LE(bytes[0],  bytes[1]);
  sample.gy = decodeSigned16LE(bytes[2],  bytes[3]);
  sample.gz = decodeSigned16LE(bytes[4],  bytes[5]);
  sample.ax = decodeSigned16LE(bytes[6],  bytes[7]);
  sample.ay = decodeSigned16LE(bytes[8],  bytes[9]);
  sample.az = decodeSigned16LE(bytes[10], bytes[11]);
  return true;
}

static bool waitForFirstSample(RawSample &sample, uint32_t timeoutUs) {
  const uint32_t began = micros();
  while ((uint32_t)(micros() - began) < timeoutUs) {
    if (readSampleIfReady(sample)) return true;
    delayMicroseconds(200);
  }
  return false;
}

static bool initializeSensor() {
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(I2C_HZ);
  delay(20);

  uint8_t who = 0;
  if (!readRegister(REG_WHO_AM_I, who)) {
    Serial.println("IMU ERROR: LSM6DSO I2C read failed at 0x6B.");
    return false;
  }
  if (who != WHO_AM_I_VALUE) {
    Serial.printf("IMU ERROR: WHO_AM_I=0x%02X, expected 0x%02X.\n", who, WHO_AM_I_VALUE);
    return false;
  }

  // Reset to a known configuration, then enable block-data-update and auto-increment.
  if (!writeRegister(REG_CTRL3_C, 0x01)) {
    Serial.println("IMU ERROR: unable to request sensor soft reset.");
    return false;
  }
  delay(20);
  if (!writeRegister(REG_CTRL3_C, CTRL3_C_VALUE) ||
      !writeRegister(REG_CTRL1_XL, CTRL1_XL_VALUE) ||
      !writeRegister(REG_CTRL2_G, CTRL2_G_VALUE)) {
    Serial.println("IMU ERROR: failed to configure LSM6DSO registers.");
    return false;
  }
  delay(100); // allow 208-Hz accel/gyro outputs to settle

  uint8_t ctrl1 = 0, ctrl2 = 0, ctrl3 = 0;
  if (!readRegister(REG_CTRL1_XL, ctrl1) ||
      !readRegister(REG_CTRL2_G, ctrl2) ||
      !readRegister(REG_CTRL3_C, ctrl3) ||
      ctrl1 != CTRL1_XL_VALUE || ctrl2 != CTRL2_G_VALUE ||
      (ctrl3 & CTRL3_C_VALUE) != CTRL3_C_VALUE) {
    Serial.printf("IMU ERROR: config readback mismatch (CTRL1=0x%02X CTRL2=0x%02X CTRL3=0x%02X).\n",
                  ctrl1, ctrl2, ctrl3);
    return false;
  }

  Serial.printf("IMU OK: LSM6DSO @0x%02X, SDA=%d, SCL=%d, 208 Hz, +/-4g, +/-2000 dps.\n",
                LSM6DSO_ADDR, SDA_PIN, SCL_PIN);
  return true;
}

// =========================== RAW BLE TX ===============================
static bool notifyRawPacket(uint8_t sampleCount) {
  if (sampleCount == 0 || sampleCount > SAMPLES_PER_PACKET) return true;
  if (!gClientConnected || !gRawCharacteristic) return false;

  const size_t byteCount = (size_t)sampleCount * WORDS_PER_SAMPLE * sizeof(int16_t);
  // The ESP32-C3 is little-endian, matching RegisterForShorts in the app.
  gRawCharacteristic->setValue((const uint8_t *)gRawPacket, byteCount);
  const bool queued = gRawCharacteristic->notify();
  if (queued) {
    ++gPacketsNotified;
  } else {
    ++gNotifyFailures;
    if (gNotifyFailures <= 5 || (gNotifyFailures % 100) == 0) {
      Serial.printf("BLE WARN: raw notify enqueue failed (%lu total).\n",
                    (unsigned long)gNotifyFailures);
    }
  }
  return queued;
}

static void flushRawPacket() {
  if (gPacketSampleCount == 0) return;
  const uint8_t pending = gPacketSampleCount;
  if (gClientConnected) {
    notifyRawPacket(pending);
  }
  gPacketSampleCount = 0;
}

static void appendRawRecord(uint32_t sequence, const RawSample &sample) {
  const uint16_t offset = (uint16_t)gPacketSampleCount * WORDS_PER_SAMPLE;
  gRawPacket[offset + 0] = (int16_t)(sequence & 0xFFFFUL);
  gRawPacket[offset + 1] = (int16_t)((sequence >> 16) & 0xFFFFUL);
  gRawPacket[offset + 2] = sample.ax;
  gRawPacket[offset + 3] = sample.ay;
  gRawPacket[offset + 4] = sample.az;
  gRawPacket[offset + 5] = sample.gx;
  gRawPacket[offset + 6] = sample.gy;
  gRawPacket[offset + 7] = sample.gz;
  ++gPacketSampleCount;
  ++gReadSamples;

  if (gPacketSampleCount >= SAMPLES_PER_PACKET) {
    notifyRawPacket(SAMPLES_PER_PACKET);
    gPacketSampleCount = 0;
  }
}

// =========================== SESSION CONTROL ==========================
static bool startAcquisition() {
  if (!gClientConnected) {
    Serial.println("START ignored: no BLE client connected.");
    return false;
  }
  if (gClientMtu < MIN_REQUIRED_MTU) {
    Serial.printf("START waiting: negotiated MTU=%u; need at least %u.\n",
                  (unsigned)gClientMtu, (unsigned)MIN_REQUIRED_MTU);
    return false;
  }
  if (!gSensorReady) {
    Serial.println("START rejected: LSM6DSO initialization failed; check power, SDA/SCL, and address.");
    return false;
  }
  if (gAcquiring) {
    Serial.println("START ignored: acquisition is already running.");
    return true;
  }

  RawSample first{};
  if (!waitForFirstSample(first, 100000UL)) {
    Serial.println("START rejected: no fresh accelerometer+gyroscope sample from LSM6DSO.");
    return false;
  }

  gPacketSampleCount = 0;
  gReadSamples = 0;
  gSequenceGapSlots = 0;
  gI2cErrors = 0;
  gNotifyFailures = 0;
  gPacketsNotified = 0;
  gNextExpectedSequence = 1;
  gSessionStartUs = micros();
  gLastFreshSampleMs = millis();
  gAcquiring = true;
  appendRawRecord(0, first);

  Serial.println("RAW STREAM STARTED: phone-side analysis only; no onboard gait computation or session storage.");
  return true;
}

static void stopAcquisition(bool allowFlush) {
  const bool wasRunning = gAcquiring;
  gAcquiring = false;
  gWaitingForStart = false;

  if (allowFlush && gClientConnected) flushRawPacket();
  else gPacketSampleCount = 0;

  if (wasRunning) {
    Serial.printf("RAW STREAM STOPPED: samples_read=%lu, sequence_gap_slots=%lu, packets_notified=%lu, notify_failures=%lu, i2c_errors=%lu.\n",
                  (unsigned long)gReadSamples,
                  (unsigned long)gSequenceGapSlots,
                  (unsigned long)gPacketsNotified,
                  (unsigned long)gNotifyFailures,
                  (unsigned long)gI2cErrors);
  }
}

static void serviceCommandQueue() {
  const uint8_t command = takePendingCommand();
  if (command == CMD_START) {
    if (gAcquiring) {
      Serial.println("START ignored: acquisition is already running.");
    } else {
      gWaitingForStart = true;
      gMtuWaitLogMs = 0;
    }
  } else if (command == CMD_STOP) {
    gWaitingForStart = false;
    stopAcquisition(true);
  }

  if (!gWaitingForStart) return;
  if (!gClientConnected) {
    gWaitingForStart = false;
    return;
  }
  if (gClientMtu >= MIN_REQUIRED_MTU) {
    gWaitingForStart = false;
    startAcquisition();
    return;
  }
  const uint32_t now = millis();
  if (gMtuWaitLogMs == 0 || (uint32_t)(now - gMtuWaitLogMs) >= 1500UL) {
    gMtuWaitLogMs = now;
    Serial.printf("START waiting for app MTU negotiation: current=%u, required>=%u.\n",
                  (unsigned)gClientMtu, (unsigned)MIN_REQUIRED_MTU);
  }
}

static void serviceSensorStream() {
  if (!gAcquiring) return;

  const uint32_t elapsedUs = (uint32_t)(micros() - gSessionStartUs);
  const uint64_t nextDueUs64 = ((uint64_t)gNextExpectedSequence * 1000000ULL) / RAW_HZ;
  const uint32_t nextDueUs = (nextDueUs64 > 0xFFFFFFFFULL) ? 0xFFFFFFFFUL : (uint32_t)nextDueUs64;
  if (elapsedUs < nextDueUs) {
    const uint32_t remaining = nextDueUs - elapsedUs;
    if (remaining > 700UL) delayMicroseconds(remaining - 500UL);
    else delayMicroseconds(80);
    return;
  }

  RawSample sample{};
  if (!readSampleIfReady(sample)) {
    if ((uint32_t)(millis() - gLastFreshSampleMs) >= SENSOR_STALL_TIMEOUT_MS) {
      Serial.println("SENSOR ERROR: no fresh LSM6DSO sample for 1 second; stopping raw stream.");
      stopAcquisition(true);
      return;
    }
    delayMicroseconds(150);
    return;
  }

  const uint32_t sampleElapsedUs = (uint32_t)(micros() - gSessionStartUs);
  const uint32_t clockSequence = (uint32_t)(((uint64_t)sampleElapsedUs * RAW_HZ) / 1000000ULL);
  const uint32_t sequence = (clockSequence < gNextExpectedSequence) ? gNextExpectedSequence : clockSequence;
  if (sequence > gNextExpectedSequence) gSequenceGapSlots += sequence - gNextExpectedSequence;
  gNextExpectedSequence = sequence + 1;
  gLastFreshSampleMs = millis();
  appendRawRecord(sequence, sample);
}

// =========================== BLE CALLBACKS ============================
class RawCharacteristicCallbacks final : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic *, NimBLEConnInfo &, uint16_t subValue) override {
    gDataSubscribed = (subValue & 0x0001U) != 0;
    Serial.printf("RAW DATA SUBSCRIPTION: %s.\n", gDataSubscribed ? "enabled" : "disabled");
  }
};

class CommandCallbacks final : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *characteristic, NimBLEConnInfo &) override {
    std::string command = characteristic->getValue();
    while (!command.empty() && isspace((unsigned char)command.back())) command.pop_back();
    while (!command.empty() && isspace((unsigned char)command.front())) command.erase(command.begin());
    for (size_t i = 0; i < command.size(); ++i) {
      command[i] = (char)toupper((unsigned char)command[i]);
    }

    if (command == "START") {
      setPendingCommand(CMD_START);
    } else if (command == "STOP") {
      setPendingCommand(CMD_STOP);
    } else if (command == "PING") {
      characteristic->setValue("PONG");
      if (gClientConnected) characteristic->notify();
    } else {
      Serial.printf("BLE: ignored unknown command (%u bytes).\n", (unsigned)command.size());
    }
  }
};

class ServerCallbacks final : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *, NimBLEConnInfo &) override {
    gClientConnected = true;
    gClientMtu = 23;
    gDataSubscribed = false;
    Serial.println("BLE CONNECTED; waiting for app MTU request and START.");
  }

  void onDisconnect(NimBLEServer *, NimBLEConnInfo &, int reason) override {
    gClientConnected = false;
    gClientMtu = 23;
    gDataSubscribed = false;
    setPendingCommand(CMD_STOP); // loop() safely drops any untransmitted remainder
    Serial.printf("BLE DISCONNECTED (reason=%d); restarting advertising.\n", reason);
    NimBLEDevice::startAdvertising();
  }

  void onMTUChange(uint16_t mtu, NimBLEConnInfo &) override {
    gClientMtu = mtu;
    Serial.printf("BLE MTU negotiated: %u (notification payload up to %u bytes).\n",
                  (unsigned)mtu, (unsigned)(mtu > 3 ? mtu - 3 : 0));
  }
};

static void setupBLE() {
  NimBLEDevice::init(DEVICE_NAME);
  NimBLEDevice::setMTU(247);

  gServer = NimBLEDevice::createServer();
  gServer->setCallbacks(new ServerCallbacks());

  NimBLEService *service = gServer->createService(SERVICE_UUID);
  gRawCharacteristic = service->createCharacteristic(
      DATA_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  gCommandCharacteristic = service->createCharacteristic(
      CMD_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::NOTIFY);
  // Keep the UUID discoverable for the existing app's RegisterForBytes block,
  // but do not send fabricated analytics/parity packets from this raw-only build.
  gAnalyticsCharacteristic = service->createCharacteristic(
      ANALYTICS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

  gRawCharacteristic->setCallbacks(new RawCharacteristicCallbacks());
  gCommandCharacteristic->setCallbacks(new CommandCallbacks());
  service->start();

  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  advertising->setName(DEVICE_NAME);
  advertising->enableScanResponse(true);
  advertising->setConnectableMode(BLE_GAP_CONN_MODE_UND);
  advertising->setDiscoverableMode(BLE_GAP_DISC_MODE_GEN);

  const bool started = advertising->start();
  Serial.printf("BLE ADVERTISING: %s; name=%s.\n", started ? "OK" : "FAILED", DEVICE_NAME);
}

// =========================== ARDUINO ENTRY ============================
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("VSPIMU V5.9 ESP32-C3 RAW-ONLY TRANSPORT");
  Serial.println("No TCN/AFO/step detection/clinical computation and no SD/flash logging.");

  gSensorReady = initializeSensor();
  if (!gSensorReady) {
    Serial.println("BLE will still advertise, but START cannot acquire data until the sensor/pins/power are fixed.");
  }
  setupBLE();
}

void loop() {
  serviceCommandQueue();
  serviceSensorStream();
  if (!gAcquiring) delay(2);
}
