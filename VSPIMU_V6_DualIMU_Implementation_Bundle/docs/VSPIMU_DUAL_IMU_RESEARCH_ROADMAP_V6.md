# VSPIMU dual-IMU research roadmap

## Implemented in this patch

- Optional native AI2 smartphone accelerometer and gyroscope event capture, gated by explicit user opt-in and declared placement.
- Fixed session-start wall-to-WebView monotonic offset mapping and a discontinuity detector; original wall timestamps retained.
- Native gyro event timestamp capture for interval/rate analysis when complete.
- Raw mirrored shank sample export and phone-stream exports, kept separate.
- Per-stream sequence/timing QC, bounded buffers, partial-sensor behavior, a coarse initial `STAND_1` descriptive feature window, manual turn/pause/issue annotations, and optional descriptive within-person history.
- Exploratory 500-ms movement-envelope matching, with the candidate lag never applied to raw timestamps and no end-to-end sync uncertainty claim.
- Dual-IMU report section and a separate data report; unique export names and acknowledged chunk transfer into app-private storage.

## Highest-value next additions (current hardware)

1. **Physical integration validation.** Verify sensor-rate behaviour and export on the actual phone and current `.aia`; check drop rates and clock stability during the full 123-s standardized journey.
2. **Reference annotations.** Annotate video, pressure insole/force plate or Vicon data to evaluate existing shank IC/FC and any movement-segment features. Report sensitivity, PPV, event-time error and confidence intervals by participant/session when sample size permits.
3. **Turn/bout segmentation validation.** Derive candidates from the existing app outputs and native phone/shank features; validate event definitions and boundaries against manual annotations before promoting them to report metrics.
4. **Repeatability.** Assess between-trial/intra-day variability, sensor repositioning, phone-pocket movement and use of walking aids. Do not establish “meaningful change” limits until within-person repeatability data exist.
5. **Synchronization evaluation.** Use a common physical trigger or externally annotated repeated motion in both sensors to estimate actual offset/drift/latency distribution. The activity-envelope match is not enough for exact event fusion.
6. **Data export/review utility.** Build a reproducible notebook for CSV integrity, alignment visualization, gap plots and per-session QC. Store exact algorithm versions and independent reference labels.

## Features requiring extra information or validation

- **Bilateral asymmetry:** preferably add a second calibrated shank IMU or a validated instrumented reference; do not label phone-pocket peaks as left/right foot contacts.
- **Walking speed and distance:** marked course distance/time or a validated stride-length model and external comparison; no indefinite acceleration double integration.
- **Foot clearance / foot drop / joint angles / joint forces:** an appropriate additional sensor setup and reference validation, often motion capture, pressure insole, or validated biomechanical instrumentation.
- **Definitive FOG detector or fall-risk predictor:** appropriate labelled datasets covering older adults/clinical subgroups and independent external validation; define outcome, time horizon and performance metrics up front.
- **TUG / sit-to-stand:** implement their full task workflow, event definitions and repeatability tests separately rather than reinterpret the existing walking protocol.
- **PPG/HR/HRV/temperature/sleep:** requires those sensors/data sources, explicit signal-quality checks and independent validation. These values must remain absent while sensors/data are absent.
- **Background daily monitoring:** native Android foreground service/lifecycle integration, power/privacy review and platform-specific testing. The current AI2/WebView path supports the foreground standardized assessment only.

## Research claims policy

Every metric should have a registered definition, source stream, units, minimum data, rejection rules, version, uncertainty and known confounders. Split data by participant rather than randomly by samples. Report poor-quality/incomplete runs rather than excluding them silently. A plausible graph or a successful build is not evidence of clinical validity.
