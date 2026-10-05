# VSPIMU V5.8 computational parity protocol

## Objective

Validate **computational equivalence** between the phone/WebView implementation in `v5_gait.js` and the native ESP32 implementation over the **same raw LSM6DSO session**.

This is deliberately separate from absolute gait-event / step-count accuracy against manual or video ground truth.

## Architecture

```text
LSM6DSO raw 208 Hz
        |
        +----------------------- ESP32 native pipeline
        |                        TCN + WT + AFO + analytics
        |                                 |
        |                                 v
        |                        ANALYTICS_UUID (binary)
        |                                 |
        v                                 v
  192-byte DATA ----------------------> Android/App
        |                                 |
        |                           v5_gait.js reference
        |                                 |
        +---------------------------------+
                        |
                        v
              one parity verdict in app
              PASS / WARN / FAIL
```

The existing 192-byte raw DATA characteristic is unchanged.

The ESP32 is now the onboard computation device. The phone still computes the same pipeline independently so the implementation can be checked against a known reference.

## Exact TCN semantic contract

The verified Colab export reported TFJS GraphModel output order:

```text
['final_contact', 'initial_contact']
```

The native header's `vspimu_tcn::predictICFC()` already maps these to semantic IC/FC order.

The parity patch therefore maps the phone's two TFJS output tensors as:

```text
TFJS output 0 -> final_contact (FC)
TFJS output 1 -> initial_contact (IC)
```

This mapping is required before comparing event times.

## ESP32 summary packet

The version-5 summary is exactly 168 bytes. The event-chunk packet is exactly 144 bytes. Both are little-endian packed structs and fit below the 247-byte negotiated BLE MTU.

Little-endian, `#pragma pack(push,1)`, **version 5**, type 1, **168 bytes**.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 2 | magic `0x494D` |
| 2 | 1 | version `5` |
| 3 | 1 | type `1` summary |
| 4 | 2 | flags |
| 6 | 4 | next scheduled sequence |
| 10 | 4 | successful raw sample count |
| 14 | 4 | first successful sequence |
| 18 | 4 | last successful sequence |
| 22 | 4 | raw-record CRC-32 |
| 26 | 2 | sensor read misses |
| 28 | 2 | raw sequence-gap counter |
| 30 | 2 | live estimated steps |
| 32 | 2 | final estimated steps |
| 34 | 2 | live TCN anchors |
| 36 | 2 | final same-shank anchors |
| 38 | 2 | final FC events |
| 40 | 2 | final TCN-validated anchors |
| 42 | 2 | TCN validation denominator |
| 44 | 2 | final wavelet-confirmed anchors |
| 46 | 2 | signal-detector candidates |
| 48 | 1 | activity state |
| 49 | 1 | protocol phase |
| 50 | 1 | dominant gyro axis |
| 51 | 1 | reserved |
| 52 | 4 | session duration (float32) |
| 56 | 4 | protocol elapsed (float32) |
| 60 onward | 4 each | gait/activity/spectral metrics |

Total size: **168 bytes**.

## Raw CRC-32 contract

The CRC is computed over each successful raw sample in acquisition order, before physical scaling.

For each sample:

```text
uint32 sequence, little-endian
int16 ax, ay, az, gx, gy, gz, each little-endian
```

The polynomial is:

```text
0xEDB88320
```

with initial state `0xFFFFFFFF` and final bitwise complement.

The phone computes the same CRC directly while decoding the existing 192-byte DATA packets.

This is a **hard parity gate**. A CRC mismatch means the two implementations did not process the same raw integer stream, regardless of whether their final step counts happen to match.

## ESP32 event packet

Little-endian, **version 5**, type 2.

- Bytes 0–1: magic
- Byte 2: version `5`
- Byte 3: type `2`
- Bytes 4–7: transfer ID
- Bytes 8–9: total events in this event type
- Bytes 10–11: starting event index
- Byte 12: event type (`1=IC`, `2=FC`)
- Byte 13: count (`0..16`)
- Bytes 16–79: 16 event times (`float32`, seconds)
- Bytes 80–143: 16 event confidences (`float32`)
- Total size: **144 bytes**

Both packet types fit comfortably below a 247-byte negotiated ATT MTU.

## Hard parity checks

These are implementation-integrity checks and must match exactly:

- raw successful sample count
- first raw sequence
- last raw sequence
- raw sequence discontinuities on the phone
- raw-record CRC-32
- phone missing sample slots vs ESP32 missing slots
- ESP32 sensor read misses = 0
- ESP32 raw-gap counter = 0
- live step count
- final estimated total steps
- final same-shank IC anchor count
- final FC count
- final TCN-validated anchor count
- final wavelet-confirmed anchor count
- IC event timestamps one-to-one
- FC event timestamps one-to-one
- session duration within 0.50 s

Event timestamp tolerance: **50 ms**.

The event comparator also reports matched count, maximum absolute timestamp error, and mean absolute timestamp error.

## Numeric parity checks

These checks compare the actual reported scalar computations and tolerate only floating-point / implementation differences:

| Quantity | Tolerance |
|---|---:|
| Cadence | 0.50 steps/min |
| Stride time | 0.005 s |
| Step interval | 0.005 s |
| Stance time | 0.005 s |
| Swing time | 0.005 s |
| Stride CV | 0.50 percentage points |
| Stance % | 0.50 percentage points |
| Swing % | 0.50 percentage points |
| Active time | 0.50 s |
| Stationary time | 0.50 s |
| Transition time | 0.50 s |
| Walking exposure | 0.50 s |
| Protocol-active time | 0.50 s |
| Protocol-stationary time | 0.50 s |
| Gait frequency | 0.01 Hz |
| Mean gait frequency | 0.01 Hz |
| Gait-frequency CV | 0.50 percentage points |
| Stride frequency | 0.01 Hz |
| Acceleration tremor RMS | 0.002 g |
| Acceleration tremor peak | 0.10 Hz |
| Gyro tremor peak | 0.10 Hz |
| Gyro tremor RMS | 0.20 deg/s |
| Tremor band ratio | 0.01 |
| Freeze Index | 0.10 |
| Phase % | 0.50 percentage points |
| AFO frequency | 0.02 Hz |
| AFO phase | 1 degree |

Verdict:

```text
PASS = all hard checks pass + all numeric checks pass
WARN = all hard checks pass + one or more numeric checks exceed tolerance
FAIL = at least one hard check fails
```

## Full comparison table shown by the app

| Output | Mobile app | ESP32 | Check |
|---|---|---|---|
| IC events | timestamps | timestamps | event-by-event, <=50 ms |
| FC events | timestamps | timestamps | event-by-event, <=50 ms |
| Same-shank steps | count | count | exact |
| Estimated total steps | count | count | exact |
| Active time | seconds | seconds | <=0.50 s |
| Stationary time | seconds | seconds | <=0.50 s |
| Cadence | steps/min | steps/min | <=0.50 spm |
| Step interval | sec | sec | <=0.005 s |
| Stride interval | sec | sec | <=0.005 s |
| Stance % | % | % | <=0.50 pp |
| Swing % | % | % | <=0.50 pp |
| Gait frequency | Hz | Hz | <=0.01 Hz |
| Tremor measures | values | values | per scalar tolerance |
| Freeze Index | value | value | <=0.10 |

Additional integrity rows include the raw CRC, sample sequence, TCN validation coverage, protocol times, AFO state, and event counts.

## Ground-truth validation is a separate stage

A parity PASS means the **phone and ESP32 implementations agree**. It does not prove either implementation is accurate.

After parity is established, annotate the same session manually/video and calculate:

```text
APP error vs ground truth
ESP32 error vs ground truth
ESP32 − APP computational difference
```

For the cleanest experiment, use the same physical sensor/session and do not change sensor placement between trials.
