/*
 * INTEGRATION NOTE — GENERATED HEADER API
 * The Colab-generated gait_tcn_model.h is the sole TCN implementation.
 * It must expose vspimu_tcn::predictICFC() and, in the current exporter,
 * IMU_TCN_SELFTEST_AVAILABLE plus the embedded deterministic self-test arrays.
 *
 * VSPIMU V5.8 — ESP32 NodeMCU / ESP32 Dev Module
 * V5.8 FINAL PARITY BUILD
 *
 * SINGLE-SHANK LSM6DSO ONBOARD ANALYTICS
 *
 * Hardware
 *   Classic ESP32 NodeMCU / ESP32 Dev Module
 *   LSM6DSO @ 0x6B
 *   SDA = GPIO21
 *   SCL = GPIO22
 *   I2C = 400 kHz
 *   Sensor ODR = 208 Hz
 *   Accel = +/-4 g
 *   Gyro  = +/-2000 dps
 *
 * EXISTING MOBILE BLE PROTOCOL — UNCHANGED
 *   Device:  GAIT-V5-C3
 *   Service: 7b8a0001-4f2a-4a2e-9e51-1d9b6d8d5001
 *   Data:    7b8a0002-4f2a-4a2e-9e51-1d9b6d8d5001
 *   Command: 7b8a0003-4f2a-4a2e-9e51-1d9b6d8d5001
 *
 * Raw BLE packet remains exactly:
 *   12 samples x 8 int16 = 192 bytes
 *   [seqLow, seqHigh, axRaw, ayRaw, azRaw, gxRaw, gyRaw, gzRaw] x 12
 *
 * NEW optional analytics characteristic (ignored by current app):
 *   7b8a0004-4f2a-4a2e-9e51-1d9b6d8d5001
 *
 * ONBOARD PIPELINE
 *   raw LSM6DSO
 *      -> 10 s walking normalization (same values used by current JS)
 *      -> live TCN gait-event inference
 *      -> gyro/acc signal candidate detector
 *      -> localized Morlet-like wavelet corroboration
 *      -> AFO frequency/phase support
 *      -> activity / stationary / transition timing
 *      -> gait metrics
 *      -> 64 Hz spectral analysis / tremor / Freeze Index research measures
 *      -> flash-backed full-session TCN scan at STOP
 *      -> wavelet + local evidence corroboration
 *      -> missed-anchor recovery
 *      -> final same-shank and estimated total steps
 *
 * IMPORTANT
 *   The exact trained TCN weights are NOT invented in this source file.
 *   The Google Colab exporter creates gait_tcn_model.h from the published
 *   SavedModel. Put that header beside this sketch before final upload.
 */

/*
 * Arduino IDE compatibility: the .ino preprocessor can auto-generate
 * function prototypes before the user-defined structs below. Forward
 * declare every custom type used in those prototypes so the generated
 * declarations remain valid.
 */
struct RawRecord;
struct PhysSample;
struct Event;
struct StepCandidate;
struct OnePoleBP;
struct Peak;
struct FeatureSet;
struct ActivityEval;
struct Spectrum;

#include <Arduino.h>
#include <Wire.h>
#include <NimBLEDevice.h>
#include <LittleFS.h>
#include <FS.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <math.h>
#include <stdint.h>
#include <string.h>
#include <algorithm>
#include "esp_timer.h"
#include "esp_heap_caps.h"

#if __has_include("gait_tcn_model.h")
  #include "gait_tcn_model.h"
  #ifndef IMU_TCN_MODEL_AVAILABLE
    #define IMU_TCN_MODEL_AVAILABLE 1
  #endif
#else
  #define IMU_TCN_MODEL_AVAILABLE 0
#endif

#if IMU_TCN_MODEL_AVAILABLE
  #ifndef GAIT_TCN_HEAP_WORKSPACE
    #error "Obsolete gait_tcn_model.h: regenerate it with the current VSPIMU exporter (requires GAIT_TCN_HEAP_WORKSPACE)."
  #endif
  #ifndef IMU_TCN_USE_SKIP_CONNECTIONS
    #define IMU_TCN_USE_SKIP_CONNECTIONS 1
  #endif
#endif

// ============================ CONFIG ============================
static constexpr char DEVICE_NAME[] = "GAIT-V5-C3";
static constexpr char SERVICE_UUID[] = "7b8a0001-4f2a-4a2e-9e51-1d9b6d8d5001";
static constexpr char DATA_UUID[]    = "7b8a0002-4f2a-4a2e-9e51-1d9b6d8d5001";
static constexpr char CMD_UUID[]     = "7b8a0003-4f2a-4a2e-9e51-1d9b6d8d5001";
static constexpr char ANALYTICS_UUID[] = "7b8a0004-4f2a-4a2e-9e51-1d9b6d8d5001";

static constexpr uint8_t LSM6DSO_ADDR = 0x6B;
static constexpr int SDA_PIN = 21;
static constexpr int SCL_PIN = 22;
static constexpr uint32_t I2C_HZ = 400000UL;
static constexpr int RAW_HZ = 208;
static constexpr int MODEL_HZ = 200;
static constexpr int MODEL_SAMPLES = 400;
static constexpr int MODEL_CHANNELS = 6;
static constexpr int PEAK_BUFFER_CAP = 32;
static constexpr int RAW_WINDOW = 417;
static constexpr int RAW_RING_CAP = 2080; // 10.0 s at 208 Hz; sufficient for 64 Hz FFT resampling
static constexpr int WARMUP_RAW = 2080;
static constexpr int WARMUP_MIN_RAW = (WARMUP_RAW*9)/10; // tolerate up to 10% sensor-read misses in the 10 s baseline
static constexpr int STATIC_RAW = 832;
static constexpr int ACTIVITY_WINDOW_RAW = 416;
static constexpr int SPECTRUM_MIN_RAW = 1664;
static constexpr int SPECTRUM_RAW = 2080;
static constexpr int FFT_N = 512;
static constexpr int TREMOR_WAVE_N = 256;
static constexpr int SAMPLES_PER_PACKET = 12;
static constexpr int SAMPLE_WORDS = 8;
static constexpr size_t RAW_PACKET_BYTES = SAMPLES_PER_PACKET * SAMPLE_WORDS * sizeof(int16_t);
static_assert(RAW_PACKET_BYTES == 192, "Raw BLE packet must remain 192 bytes");

// The user protocol is 123 s. 180 s is a hard safety cap for flash/session size.
static constexpr uint32_t MAX_SESSION_SEC = 180;
static constexpr uint32_t SESSION_RAW_LIMIT = MAX_SESSION_SEC * RAW_HZ;

// 104 records = 0.5 s. Six buffers provide 3 s of queue headroom.
static constexpr uint16_t FLASH_BLOCK_SAMPLES = 104;
static constexpr uint8_t FLASH_BLOCK_COUNT = 3; // 1.5 s producer headroom
static constexpr char SESSION_FILE[] = "/v58_session.bin";

static constexpr float ACC_G_PER_LSB = 0.0001220703125f;
static constexpr float GYRO_DPS_PER_LSB = 0.07f;
static constexpr float PI_F = 3.14159265358979323846f;

// LSM6DSO registers.
static constexpr uint8_t REG_WHO_AM_I = 0x0F;
static constexpr uint8_t REG_CTRL1_XL = 0x10;
static constexpr uint8_t REG_CTRL2_G  = 0x11;
static constexpr uint8_t REG_CTRL3_C  = 0x12;
static constexpr uint8_t REG_STATUS   = 0x1E;
static constexpr uint8_t REG_OUTX_L_G = 0x22;
static constexpr uint8_t CTRL1_XL_VALUE = 0x58; // 208 Hz, +/-4 g
static constexpr uint8_t CTRL2_G_VALUE  = 0x5C; // 208 Hz, +/-2000 dps
static constexpr uint8_t CTRL3_C_VALUE  = 0x44; // BDU + IF_INC
static constexpr uint32_t SENSOR_READY_TIMEOUT_US = 4000; // stay inside one 208-Hz sample period

// ============================ V5.7.2 JS CONFIG ============================
static constexpr float PEAK_HEIGHT = 0.40f;
static constexpr float RECOVERY_HEIGHT = 0.32f;
static constexpr int PEAK_DISTANCE = 100;
static constexpr float IC_MIN_GAP_SEC = 0.50f;
static constexpr float FC_MIN_GAP_SEC = 0.50f;
static constexpr int EDGE_LEFT = 40;
static constexpr int COMMIT_RIGHT = 40;
static constexpr float MIN_STRIDE_SEC = 0.40f;
static constexpr float MAX_STRIDE_SEC = 3.00f;
static constexpr float STEP_REFRACTORY_SEC = 0.55f;
static constexpr float STEP_MIN_WALK_GAP_SEC = 0.85f;
static constexpr float STEP_MAX_WALK_GAP_SEC = 3.00f;
static constexpr float STEP_HP_HZ = 0.45f;
static constexpr float STEP_LP_HZ = 4.00f;
static constexpr int STEP_THRESHOLD_UPDATE_SAMPLES = 16;
static constexpr int STEP_THRESHOLD_WINDOW_RAW = 416;
static constexpr float STEP_WAVELET_MIN_SCORE = 0.18f;
static constexpr float STEP_SIGNAL_MIN_SCORE = 0.25f;
static constexpr float STEP_INTERVAL_TOL_SEC = 0.55f;
static constexpr float STEP_TCN_MIN_PROB = 0.25f;
static constexpr float TCN_SCAN_STEP_SEC = 0.50f;
static constexpr float TCN_MATCH_SEC = 0.25f;
static constexpr float TCN_FC_LOOKAHEAD_SEC = 0.85f;
static constexpr bool AFO_ENABLED = true;
static constexpr float AFO_MIN_HZ = 0.35f;
static constexpr float AFO_MAX_HZ = 2.50f;
static constexpr int FINAL_MAX_CANDIDATES = 192; // covers the full 92 s walking exposure at the 0.5 s TCN scan cadence
static constexpr float VAR_CV_LOW = 1.1f;
static constexpr float VAR_CV_HIGH = 2.6f;
static constexpr float FOG_FI_THRESHOLD = 2.5f;

static constexpr float FFT_FS = 64.0f;
static constexpr float TREMOR_LOW_HZ = 3.0f;
static constexpr float TREMOR_HIGH_HZ = 8.0f;
static constexpr float LOCOMOTOR_LOW_HZ = 0.5f;
static constexpr float LOCOMOTOR_HIGH_HZ = 3.0f;

#ifdef GAIT_TCN_BN_EPS
static constexpr float TCN_BN_EPS = GAIT_TCN_BN_EPS;
#else
static constexpr float TCN_BN_EPS = 0.001f;
#endif

// ============================ PROTOCOL ============================
enum ActivityState : uint8_t {
  ACT_UNKNOWN = 0,
  ACT_STATIONARY = 1,
  ACT_TRANSITION = 2,
  ACT_WALKING = 3
};

enum ProtocolId : uint8_t {
  PH_NONE = 0,
  PH_STAND1,
  PH_BASELINE_WALK,
  PH_WALK_MAIN,
  PH_STAND2,
  PH_SIT,
  PH_STAND3,
  PH_WALK_REPEAT,
  PH_COMPLETE
};

struct PhaseDef { ProtocolId id; float dur; };
static constexpr PhaseDef PROTOCOL[] = {
  {PH_STAND1, 8.0f},
  {PH_BASELINE_WALK, 10.0f},
  {PH_WALK_MAIN, 50.0f},
  {PH_STAND2, 8.0f},
  {PH_SIT, 10.0f},
  {PH_STAND3, 5.0f},
  {PH_WALK_REPEAT, 32.0f}
};
static constexpr int PROTOCOL_COUNT = sizeof(PROTOCOL) / sizeof(PROTOCOL[0]);
static constexpr float PROTOCOL_TOTAL_SEC = 123.0f;

static inline bool isWalkPhase(ProtocolId id) {
  return id == PH_BASELINE_WALK || id == PH_WALK_MAIN || id == PH_WALK_REPEAT;
}
static inline bool isStillPhase(ProtocolId id) {
  return id == PH_STAND1 || id == PH_STAND2 || id == PH_SIT || id == PH_STAND3;
}
static ProtocolId protocolAt(float elapsed, float *phaseStartOut=nullptr, float *phaseEndOut=nullptr) {
  if (elapsed < 0) elapsed = 0;
  float s = 0;
  for (int i=0;i<PROTOCOL_COUNT;i++) {
    const float e = s + PROTOCOL[i].dur;
    if (elapsed < e) {
      if (phaseStartOut) *phaseStartOut = s;
      if (phaseEndOut) *phaseEndOut = e;
      return PROTOCOL[i].id;
    }
    s = e;
  }
  if (phaseStartOut) *phaseStartOut = PROTOCOL_TOTAL_SEC;
  if (phaseEndOut) *phaseEndOut = PROTOCOL_TOTAL_SEC;
  return PH_COMPLETE;
}
static const char* phaseName(ProtocolId id) {
  switch (id) {
    case PH_STAND1: return "STAND_1";
    case PH_BASELINE_WALK: return "BASELINE_WALK";
    case PH_WALK_MAIN: return "WALK_MAIN";
    case PH_STAND2: return "STAND_2";
    case PH_SIT: return "SIT";
    case PH_STAND3: return "STAND_3";
    case PH_WALK_REPEAT: return "WALK_REPEAT";
    case PH_COMPLETE: return "COMPLETE";
    default: return "NOT_STARTED";
  }
}

// ============================ DATA STRUCTURES ============================
struct RawRecord {
  uint32_t seq;
  int16_t ax, ay, az, gx, gy, gz;
};
static_assert(sizeof(RawRecord)==16, "RawRecord must be exactly 16 bytes");
static uint32_t gRawCrcState=0xFFFFFFFFUL;
static inline uint32_t crc32UpdateByte(uint32_t crc,uint8_t byte){crc^=byte;for(int i=0;i<8;i++)crc=(crc&1U)?((crc>>1)^0xEDB88320UL):(crc>>1);return crc;}
static void rawCrcUpdate(const RawRecord &r){const uint32_t seq=r.seq;const int16_t v[6]={r.ax,r.ay,r.az,r.gx,r.gy,r.gz};gRawCrcState=crc32UpdateByte(gRawCrcState,(uint8_t)(seq&0xFF));gRawCrcState=crc32UpdateByte(gRawCrcState,(uint8_t)((seq>>8)&0xFF));gRawCrcState=crc32UpdateByte(gRawCrcState,(uint8_t)((seq>>16)&0xFF));gRawCrcState=crc32UpdateByte(gRawCrcState,(uint8_t)((seq>>24)&0xFF));for(int i=0;i<6;i++){const uint16_t u=(uint16_t)v[i];gRawCrcState=crc32UpdateByte(gRawCrcState,(uint8_t)(u&0xFF));gRawCrcState=crc32UpdateByte(gRawCrcState,(uint8_t)(u>>8));}}
static inline uint32_t rawCrcFinal(){return ~gRawCrcState;}

struct PhysSample {
  float t;
  float ax, ay, az, gx, gy, gz;
};

struct Event {
  float t;
  float conf;
  float finalConfidence;
  float signalScore;
  float waveletScore;
  float waveletFreq;
  float localEvidence;
  uint8_t source;
  bool tcnValidated;
  bool recovered;
  bool validForCadence;
};

struct StepCandidate {
  float t;
  float signalScore;
};

struct OnePoleBP {
  float hpX=0;
  float hpY=0;
  float lpY=0;
  bool initialized=false;
};

struct Peak { int i; float v; };

struct FeatureSet {
  float accStd=NAN;
  float accRange=NAN;
  float gyroRms=NAN;
  float gyroRange=NAN;
  float periodicity=NAN;
  int axis=0;
};

struct ActivityEval {
  ActivityState desired=ACT_TRANSITION;
  float score=NAN;
  float walkingConfidence=NAN;
  float stationaryConfidence=NAN;
  float motionRms=NAN;
  float gyroRms=NAN;
  FeatureSet features{};
};

// ============================ GLOBAL STATE ============================
NimBLEServer *gServer=nullptr;
NimBLECharacteristic *gDataChar=nullptr;
NimBLECharacteristic *gCmdChar=nullptr;
NimBLECharacteristic *gAnalyticsChar=nullptr;
volatile bool gClientConnected=false;
volatile bool gAcquiring=false;
volatile bool gStopRequested=false;
volatile bool gSamplingStopped=true;
volatile bool gStorageWriterDone=true;
volatile bool gFinalizationInProgress=false;
volatile bool gFinalizationReady=false;
#if IMU_TCN_MODEL_AVAILABLE
volatile bool gTcnRuntimeFault=false;
#endif

portMUX_TYPE gRingMux=portMUX_INITIALIZER_UNLOCKED;
RawRecord *gRawRing=nullptr;
volatile uint32_t gRingWrite=0;
volatile uint32_t gRingCount=0;
volatile uint32_t gSeq=0;
volatile uint32_t gTotalSamples=0;
volatile uint32_t gSensorMisses=0;
volatile uint32_t gRawGaps=0; // missing scheduled sample slots (sensor read misses)
uint32_t gSessionFirstSeq=0;
uint32_t gSessionLastSeq=0;

int16_t gRawPacket[SAMPLES_PER_PACKET][SAMPLE_WORDS];
uint8_t gPacketCount=0;

// Warmup normalization is accumulated online over the 10 s baseline walk.
uint32_t gNormCount=0;
double gNormSum[MODEL_CHANNELS]={0,0,0,0,0,0};
double gNormSq[MODEL_CHANNELS]={0,0,0,0,0,0};
float gMean[MODEL_CHANNELS]={0,0,0,0,0,0};
float gStd[MODEL_CHANNELS]={1,1,1,1,1,1};
bool gWarmupDone=false;

FeatureSet gStaticProfile{};
FeatureSet gWalkProfile{};
bool gStaticProfileLocked=false;
int gDominantAxis=0;

// Reusable profile/feature buffer. Avoids large task-stack allocations.
PhysSample *gFeatureWindow=nullptr;
RawRecord *gModelRawWindow=nullptr; // 435 raw records: max live/offline model window
Peak *gPeakIC=nullptr;
Peak *gPeakFC=nullptr;
float *gFFTWorkRe=nullptr;
float *gFFTWorkIm=nullptr;

// Live signal detector.
struct SignalSample { float t, gyro, acc; };
SignalSample *gLiveSignal=nullptr;
uint16_t gLiveSignalCount=0;
uint32_t gLiveSignalWrite=0;
OnePoleBP gLiveGyroFilters[3];
OnePoleBP gLiveAccFilter;
float gLiveDetectorThreshold=NAN;
float gLiveAccThreshold=NAN;
uint32_t gLastThresholdSeq=0;
StepCandidate gPendingCandidates[16];
uint8_t gPendingCount=0;
uint16_t gLiveCorroborationCount=0;
float gLiveLastAnchorT=NAN;
float gLiveLastWavelet=NAN;
float gLiveLastWaveletFreq=NAN;
float gLiveLastSignalScore=NAN;
uint32_t gStepDetectorCandidates=0;
static constexpr int LIVE_EVENT_CAP = FINAL_MAX_CANDIDATES;
float gLiveAnchorTimes[LIVE_EVENT_CAP]; uint16_t gLiveAnchorCount=0;
float gLiveInferredTimes[LIVE_EVENT_CAP]; uint16_t gLiveInferredCount=0;
struct PendingOpposite { float t; };
PendingOpposite gPendingOpposite[16]; uint8_t gPendingOppositeCount=0;
uint32_t gLiveSignalPushes=0;

// TCN events.
Event *gTcnIC=nullptr;
uint16_t gTcnICCount=0;
Event *gTcnFC=nullptr;
uint16_t gTcnFCCount=0;
uint16_t gFinalEventCount=0;
uint16_t gFinalTcnValidated=0;
uint16_t gFinalTcnTotal=0;
uint16_t gFinalWaveletConfirmed=0;
uint16_t gLiveTcnAnchors=0;
uint16_t gLiveObservedSteps=0;
uint16_t gLiveInferredOpposite=0;
uint16_t gLiveStepCount=0;
uint16_t gFinalStepCount=0;
String gFinalizationMessage;

// AFO support.
float gAfoFreqHz=NAN;
float gAfoPhaseDeg=NAN;
float gAfoLastT=NAN;
float gAfoAnchorT=NAN;
bool gAfoOppositeEmitted=false;

// Activity/time.
ActivityState gActivity=ACT_UNKNOWN;
ActivityState gPreviousActivity=ACT_UNKNOWN;
ActivityState gActivityCandidate=ACT_UNKNOWN;
float gActivityCandidateSince=NAN;
float gActivityStableSince=NAN;
float gActivityLastUpdateT=NAN;
float gActivityConfidence=NAN;
float gWalkingConfidence=NAN;
float gStationaryConfidence=NAN;
float gMotionRms=NAN;
float gGyroRms=NAN;
float gActiveSec=0;
float gStationarySec=0;
float gTransitionSec=0;
float gWalkingExposureSec=0;
float gProtocolActiveSec=0;
float gProtocolStationarySec=0;
float gActiveAdherencePct=NAN;

// Gait metrics.
float gCadence=NAN;
float gStride=NAN;
float gStepInterval=NAN;
float gStrideFreq=NAN;
float gGaitFreq=NAN;
float gStrideCV=NAN;
float gStance=NAN;
float gSwing=NAN;
float gStancePct=NAN;
float gSwingPct=NAN;
float gMeanEventConfidence=NAN;
float gPhasePct=NAN;
float gSwingPeakDps=NAN;
float gSwingPeakPct=NAN;
int gSwingZeroCrossings=-1;
const char *gPhaseName="-";
const char *gGaitState="-";

// Spectral / research measures.
float gGaitFreqHz=NAN;
float gStrideFreqHz=NAN;
float gGaitFreqTrend[60];
uint8_t gGaitFreqTrendCount=0;
float gGaitFreqMeanHz=NAN;
float gGaitFreqCvPct=NAN;
float gTremorRms=NAN;
float gTremorPeakHz=NAN;
float gTremorGyroPeakHz=NAN;
float gTremorGyroRms=NAN;
float gTremorBandRatio=NAN;
float gFreezeIndex=NAN;
bool gFreezeFlag=false;
uint16_t gFreezeFlagWindows=0;
float gFreezeFlagSec=0;
float gLastSpectrumT=NAN;
const char *gSpectrumQuality="WAITING";

// Protocol/session.
float gSessionFirstT=NAN;
float gSessionDurationSec=NAN;
ProtocolId gProtocolPhase=PH_NONE;
float gProtocolElapsedSec=0;
float gProtocolRemainingSec=PROTOCOL_TOTAL_SEC;
float gProtocolWalkElapsedSec=0;
float gProtocolStationaryElapsedSec=0;
bool gProtocolComplete=false;

// Diagnostics.
uint32_t gLastAnalysisSeq=0;
uint32_t gLastReportMs=0;
uint32_t gLastLiveInferenceSeq=0;
float gLastInferenceMs=NAN;
float gLastPeakIC=NAN;
float gLastPeakFC=NAN;
uint32_t gLastIdlePrintMs=0;
uint32_t gLastSensorErrPrintMs=0;
uint32_t gLastStackDiagMs=0;
uint32_t gSensorReadyTimeouts=0;
TaskHandle_t gSampleTaskHandle=nullptr;
TaskHandle_t gFlashTaskHandle=nullptr;
TaskHandle_t gAnalysisTaskHandle=nullptr;
uint16_t gSignalSaturationCount=0;
const char *gSignalQuality="WAITING";
bool gFlashReady=false;
volatile bool gFlashIncomplete=false;

// ============================ FLASH QUEUES ============================
struct FlashBlock {
  uint16_t count;
  RawRecord rec[FLASH_BLOCK_SAMPLES];
};
FlashBlock *gFlashBlocks=nullptr;
QueueHandle_t gFreeQ=nullptr;
QueueHandle_t gReadyQ=nullptr;
volatile uint8_t gCurrentFlashBlock=0xFF;
volatile uint16_t gCurrentFlashCount=0;

// ============================ MODEL BUFFERS ============================
#if IMU_TCN_MODEL_AVAILABLE
// The generated header owns the verified TCN feature workspace. The firmware
// only allocates model input and the two 400-sample output vectors.
float *gTcnInput=nullptr;
float *gTcnICProb=nullptr;
float *gTcnFCProb=nullptr;
#endif

// ============================ HEAP ANALYSIS SCRATCH ============================
// Large temporary arrays live on the heap, never in .bss.
struct AnalysisScratch {
  float *featureAmag=nullptr,*featureGx=nullptr,*featureGy=nullptr,*featureGz=nullptr,*featureGm=nullptr;
  float *robustTmp=nullptr;
  float *waveletG=nullptr,*waveletAm=nullptr;
  float *detectorGyroVals=nullptr,*detectorAccVals=nullptr;
  Event *validEvents=nullptr,*swingEvents=nullptr,*metricEvents=nullptr;
  float *strideTmpA=nullptr,*strideTmpB=nullptr,*strideMed=nullptr;
  float *stanceVals=nullptr,*swingVals=nullptr,*gapVals=nullptr,*confidenceVals=nullptr;
  float *offlineSigG=nullptr,*offlineSigA=nullptr,*offlineGV=nullptr,*offlineAV=nullptr;
};
AnalysisScratch gScratch{};

// ============================ FINALIZATION BUFFERS ============================
Event *gFinalWorkB=nullptr;

// ============================ SPECTRUM BUFFERS ============================
float *gSpectrumScratch=nullptr;
float *gTremorWave=nullptr;

struct Spectrum {
  float pow[FFT_N/2+1];
  float re[FFT_N];
  float im[FFT_N];
};
Spectrum gSpectrum;

// ============================ SMALL UTILITIES ============================
static inline bool finiteF(float x){return isfinite(x);}
static inline float clampF(float x,float lo,float hi){return x<lo?lo:(x>hi?hi:x);}
static inline float fmaxSafe(float a,float b){return (a>b)?a:b;}
static inline uint16_t satU16(int x){return x<0?0:(x>65535?65535:(uint16_t)x);}
static inline int16_t f2i16(float v,float scale){if(!finiteF(v))return -32768;float x=v*scale;if(x>32767)x=32767;if(x<-32767)x=-32767;return (int16_t)lrintf(x);}
static float meanF(const float *a,int n){if(n<=0)return NAN;float s=0;for(int i=0;i<n;i++)s+=a[i];return s/(float)n;}
static float stdF(const float *a,int n,float mu=NAN){if(n<=0)return NAN;if(!finiteF(mu))mu=meanF(a,n);float s=0;for(int i=0;i<n;i++){float d=a[i]-mu;s+=d*d;}return sqrtf(s/(float)n);}
static float rmsF(const float *a,int n){if(n<=0)return NAN;float s=0;for(int i=0;i<n;i++)s+=a[i]*a[i];return sqrtf(s/(float)n);}
static float medianSmall(float *a,int n){if(n<=0)return NAN;std::sort(a,a+n);return (n&1)?a[n/2]:0.5f*(a[n/2-1]+a[n/2]);}
static float percentileSmall(float *a,int n,float p){if(n<=0)return NAN;p=clampF(p,0,1);std::sort(a,a+n);float pos=p*(n-1),loF=floorf(pos),hiF=ceilf(pos);int lo=(int)loF,hi=(int)hiF;if(lo==hi)return a[lo];float f=pos-lo;return a[lo]+f*(a[hi]-a[lo]);}
static float arrayRange(const float *a,int n){if(n<=0)return NAN;float lo=INFINITY,hi=-INFINITY;for(int i=0;i<n;i++){if(a[i]<lo)lo=a[i];if(a[i]>hi)hi=a[i];}return hi-lo;}
static float fastSigmoid(float x){return 1.0f/(1.0f+expf(-x));}
static const char* activityName(ActivityState a){switch(a){case ACT_STATIONARY:return "STATIONARY";case ACT_TRANSITION:return "TRANSITION";case ACT_WALKING:return "WALKING";default:return "UNKNOWN";}}

// ============================ SENSOR ============================
static bool writeReg(uint8_t reg,uint8_t val){Wire.beginTransmission(LSM6DSO_ADDR);Wire.write(reg);Wire.write(val);return Wire.endTransmission()==0;}
static uint8_t readReg(uint8_t reg){Wire.beginTransmission(LSM6DSO_ADDR);Wire.write(reg);if(Wire.endTransmission(false)!=0)return 0;if(Wire.requestFrom((int)LSM6DSO_ADDR,1)!=1)return 0;return (uint8_t)Wire.read();}
static bool readBurst(uint8_t reg,uint8_t *buf,size_t n){Wire.beginTransmission(LSM6DSO_ADDR);Wire.write(reg);if(Wire.endTransmission(false)!=0)return false;size_t got=Wire.requestFrom((int)LSM6DSO_ADDR,(int)n);if(got!=n)return false;for(size_t i=0;i<n;i++)buf[i]=(uint8_t)Wire.read();return true;}
static bool sensorInit(){
  const uint8_t who=readReg(REG_WHO_AM_I);
  if(who!=0x6C){Serial.printf("FATAL LSM6DSO WHO_AM_I=0x%02X expected 0x6C\n",who);return false;}
  if(!writeReg(REG_CTRL3_C,CTRL3_C_VALUE))return false;
  delay(10);
  if(!writeReg(REG_CTRL1_XL,CTRL1_XL_VALUE))return false;
  if(!writeReg(REG_CTRL2_G,CTRL2_G_VALUE))return false;
  delay(40);
  return true;
}
static bool sensorReadRaw(RawRecord &r){
  const uint64_t t0=(uint64_t)esp_timer_get_time();
  uint8_t status=0;
  while((uint64_t)esp_timer_get_time()-t0 < SENSOR_READY_TIMEOUT_US){
    status=readReg(REG_STATUS);
    if((status&0x03U)==0x03U)break;
    delayMicroseconds(40);
  }
  if((status&0x03U)!=0x03U){
    gSensorReadyTimeouts++;
    return false;
  }
  uint8_t b[12];
  if(!readBurst(REG_OUTX_L_G,b,sizeof(b)))return false;
  r.gx=(int16_t)((uint16_t)b[1]<<8|b[0]);
  r.gy=(int16_t)((uint16_t)b[3]<<8|b[2]);
  r.gz=(int16_t)((uint16_t)b[5]<<8|b[4]);
  r.ax=(int16_t)((uint16_t)b[7]<<8|b[6]);
  r.ay=(int16_t)((uint16_t)b[9]<<8|b[8]);
  r.az=(int16_t)((uint16_t)b[11]<<8|b[10]);
  return true;
}
static inline float recT(const RawRecord &r){return (float)r.seq/(float)RAW_HZ;}
static inline PhysSample toPhys(const RawRecord &r){
  PhysSample p;
  p.t=recT(r);
  p.ax=r.ax*ACC_G_PER_LSB;p.ay=r.ay*ACC_G_PER_LSB;p.az=r.az*ACC_G_PER_LSB;
  p.gx=r.gx*GYRO_DPS_PER_LSB;p.gy=r.gy*GYRO_DPS_PER_LSB;p.gz=r.gz*GYRO_DPS_PER_LSB;
  return p;
}

// ============================ RING ACCESS ============================
static void ringPush(const RawRecord &r){
  portENTER_CRITICAL(&gRingMux);
  const uint32_t idx=gRingWrite%RAW_RING_CAP;
  gRawRing[idx]=r;
  gRingWrite++;
  if(gRingCount<RAW_RING_CAP)gRingCount++;
  portEXIT_CRITICAL(&gRingMux);
}
static int ringSnapshotRaw(RawRecord *out,int maxN){
  if(!out||maxN<=0)return 0;
  portENTER_CRITICAL(&gRingMux);
  const uint32_t gc=gRingCount;const int n=(int)min<uint32_t>(gc,(uint32_t)maxN);const uint32_t end=gRingWrite;
  for(int i=0;i<n;i++)out[i]=gRawRing[(end-(uint32_t)n+(uint32_t)i)%RAW_RING_CAP];
  portEXIT_CRITICAL(&gRingMux);return n;
}
static int ringSnapshotPhys(PhysSample *out,int maxN){
  if(!out||maxN<=0)return 0;
  portENTER_CRITICAL(&gRingMux);
  const uint32_t gc=gRingCount;const int n=(int)min<uint32_t>(gc,(uint32_t)maxN);const uint32_t end=gRingWrite;
  for(int i=0;i<n;i++)out[i]=toPhys(gRawRing[(end-(uint32_t)n+(uint32_t)i)%RAW_RING_CAP]);
  portEXIT_CRITICAL(&gRingMux);return n;
}
static int ringWindowByTime(float t0,float t1,PhysSample *out,int maxN){
  if(!out||maxN<=0||!finiteF(t0)||!finiteF(t1)||t1<t0)return 0;
  portENTER_CRITICAL(&gRingMux);
  const uint32_t gc=gRingCount;const uint32_t count=(gc<(uint32_t)RAW_RING_CAP)?gc:(uint32_t)RAW_RING_CAP;const uint32_t end=gRingWrite;int w=0;
  for(uint32_t i=0;i<count&&w<maxN;i++){const RawRecord &r=gRawRing[(end-count+i)%RAW_RING_CAP];const float t=recT(r);if(t>=t0&&t<=t1)out[w++]=toPhys(r);}
  portEXIT_CRITICAL(&gRingMux);return w;
}

// ============================ FEATURE FUNCTIONS ============================
static float autocorrPeak(const float *values,int n,int minLag=80,int maxLag=300){
  if(n<120)return NAN;
  const float mu=meanF(values,n);
  float den=0;
  for(int i=0;i<n;i++){float x=values[i]-mu;den+=x*x;}
  if(den<1e-9f)return NAN;
  const int lo=max(60,minLag),hi=min(n-5,maxLag);
  float best=-1;
  for(int lag=lo;lag<=hi;lag++){
    float num=0;
    for(int i=0;i<n-lag;i++)num+=(values[i]-mu)*(values[i+lag]-mu);
    float rr=num/den;
    if(rr>best)best=rr;
  }
  return clampF(best,-1,1);
}

static FeatureSet featureFromPhys(const PhysSample *a,int n){
  FeatureSet f;
  if(!a||n<160)return f;
  n=min(n,ACTIVITY_WINDOW_RAW);
  float *amag=gScratch.featureAmag,*gx=gScratch.featureGx,*gy=gScratch.featureGy,*gz=gScratch.featureGz,*gm=gScratch.featureGm;
  if(!amag||!gx||!gy||!gz||!gm)return f;
  for(int i=0;i<n;i++){
    amag[i]=sqrtf(a[i].ax*a[i].ax+a[i].ay*a[i].ay+a[i].az*a[i].az);
    gx[i]=a[i].gx;gy[i]=a[i].gy;gz[i]=a[i].gz;
    gm[i]=sqrtf(a[i].gx*a[i].gx+a[i].gy*a[i].gy+a[i].gz*a[i].gz);
  }
  const float sx=stdF(gx,n),sy=stdF(gy,n),sz=stdF(gz,n);
  const int axis=(sy>sx&&sy>=sz)?1:((sz>sx&&sz>sy)?2:0);
  const float *g=axis==0?gx:(axis==1?gy:gz);
  f.accStd=stdF(amag,n);
  f.accRange=arrayRange(amag,n);
  f.gyroRms=rmsF(gm,n);
  f.gyroRange=arrayRange(g,n);
  f.periodicity=autocorrPeak(g,n,80,min(300,n-10));
  f.axis=axis;
  return f;
}

static FeatureSet profileFromRawInt16(const int16_t raw[][MODEL_CHANNELS],int n,int baseSeq){
  FeatureSet out;
  if(!raw||n<ACTIVITY_WINDOW_RAW)return out;
  FeatureSet feats[32];int nf=0;
  for(int start=0;start+ACTIVITY_WINDOW_RAW<=n&&nf<32;start+=104){
    for(int i=0;i<ACTIVITY_WINDOW_RAW;i++){
      const int idx=start+i;PhysSample &p=gFeatureWindow[i];p.t=(float)(baseSeq+idx)/(float)RAW_HZ;
      p.ax=raw[idx][0]*ACC_G_PER_LSB;p.ay=raw[idx][1]*ACC_G_PER_LSB;p.az=raw[idx][2]*ACC_G_PER_LSB;
      p.gx=raw[idx][3]*GYRO_DPS_PER_LSB;p.gy=raw[idx][4]*GYRO_DPS_PER_LSB;p.gz=raw[idx][5]*GYRO_DPS_PER_LSB;
    }
    feats[nf++]=featureFromPhys(gFeatureWindow,ACTIVITY_WINDOW_RAW);
  }
  if(!nf)return out;
  float t[32];
  for(int i=0;i<nf;i++)t[i]=feats[i].accStd;out.accStd=medianSmall(t,nf);
  for(int i=0;i<nf;i++)t[i]=feats[i].accRange;out.accRange=medianSmall(t,nf);
  for(int i=0;i<nf;i++)t[i]=feats[i].gyroRms;out.gyroRms=medianSmall(t,nf);
  for(int i=0;i<nf;i++)t[i]=feats[i].gyroRange;out.gyroRange=medianSmall(t,nf);
  for(int i=0;i<nf;i++)t[i]=feats[i].periodicity;out.periodicity=medianSmall(t,nf);
  out.axis=feats[nf/2].axis;return out;
}

static FeatureSet profileFromRecentRing(int n){
  FeatureSet out;const uint32_t gc=gRingCount;n=min(n,(int)min<uint32_t>(gc,(uint32_t)RAW_RING_CAP));if(n<ACTIVITY_WINDOW_RAW)return out;
  FeatureSet feats[32];int nf=0;portENTER_CRITICAL(&gRingMux);const uint32_t end=gRingWrite;const uint32_t begin=end-(uint32_t)n;
  for(int start=0;start+ACTIVITY_WINDOW_RAW<=n&&nf<32;start+=104){
    for(int i=0;i<ACTIVITY_WINDOW_RAW;i++){const RawRecord &r=gRawRing[(begin+(uint32_t)(start+i))%RAW_RING_CAP];gFeatureWindow[i]=toPhys(r);}
    feats[nf++]=featureFromPhys(gFeatureWindow,ACTIVITY_WINDOW_RAW);
  }
  portEXIT_CRITICAL(&gRingMux);if(!nf)return out;float t[32];int nt=0;
  for(int i=0;i<nf;i++)if(finiteF(feats[i].accStd))t[nt++]=feats[i].accStd;out.accStd=nt?medianSmall(t,nt):NAN;
  nt=0;for(int i=0;i<nf;i++)if(finiteF(feats[i].accRange))t[nt++]=feats[i].accRange;out.accRange=nt?medianSmall(t,nt):NAN;
  nt=0;for(int i=0;i<nf;i++)if(finiteF(feats[i].gyroRms))t[nt++]=feats[i].gyroRms;out.gyroRms=nt?medianSmall(t,nt):NAN;
  nt=0;for(int i=0;i<nf;i++)if(finiteF(feats[i].gyroRange))t[nt++]=feats[i].gyroRange;out.gyroRange=nt?medianSmall(t,nt):NAN;
  nt=0;for(int i=0;i<nf;i++)if(finiteF(feats[i].periodicity))t[nt++]=feats[i].periodicity;out.periodicity=nt?medianSmall(t,nt):NAN;
  out.axis=feats[nf/2].axis;return out;
}

// Forward declarations for cross-module analytics dependencies.
static void walkThresholds(float &g,float &a,float &p,float &r){
  g=finiteF(gWalkProfile.gyroRms)?fmaxSafe(6.0f,0.30f*gWalkProfile.gyroRms):10.0f;
  a=finiteF(gWalkProfile.accStd)?fmaxSafe(0.008f,0.30f*gWalkProfile.accStd):0.018f;
  p=finiteF(gWalkProfile.periodicity)?fmaxSafe(0.20f,0.65f*gWalkProfile.periodicity):0.24f;
  r=finiteF(gWalkProfile.gyroRange)?fmaxSafe(18.0f,0.32f*gWalkProfile.gyroRange):28.0f;
}
static void staticThresholds(float &g,float &a,float &r,float &ar){
  g=clampF(fmaxSafe(2.5f,fmaxSafe(finiteF(gStaticProfile.gyroRms)?4.0f*gStaticProfile.gyroRms:2.5f,finiteF(gWalkProfile.gyroRms)?0.10f*gWalkProfile.gyroRms:0)),2.5f,8.0f);
  a=clampF(fmaxSafe(0.006f,fmaxSafe(finiteF(gStaticProfile.accStd)?4.0f*gStaticProfile.accStd:0.006f,finiteF(gWalkProfile.accStd)?0.12f*gWalkProfile.accStd:0)),0.006f,0.025f);
  r=clampF(fmaxSafe(8.0f,finiteF(gStaticProfile.gyroRange)?3.0f*gStaticProfile.gyroRange:8.0f),8.0f,24.0f);
  ar=clampF(fmaxSafe(0.018f,finiteF(gStaticProfile.accRange)?3.0f*gStaticProfile.accRange:0.018f),0.018f,0.06f);
}
static float localGaitEvidenceFromPhys(const PhysSample *a,int n){
  if(!a||n<40)return 0.0f;
  const FeatureSet f=featureFromPhys(a,n);
  if(!finiteF(f.gyroRms)||!finiteF(f.accStd)||!finiteF(f.periodicity)||!finiteF(f.gyroRange))return 0.0f;
  float wtG,wtA,wtP,wtR;walkThresholds(wtG,wtA,wtP,wtR);
  const float g=clampF(f.gyroRms/fmaxSafe(1.0f,wtG),0,2)/2.0f;
  const float acc=clampF(f.accStd/fmaxSafe(1e-5f,wtA),0,2)/2.0f;
  const float per=clampF((f.periodicity-0.05f)/fmaxSafe(0.05f,wtP-0.05f),0,1);
  const float range=clampF(f.gyroRange/fmaxSafe(1.0f,wtR),0,2)/2.0f;
  return 0.35f*per+0.30f*g+0.20f*acc+0.15f*range;
}
static float localGaitEvidenceAt(float t){
  const int n=ringWindowByTime(t-0.85f,t+0.35f,gFeatureWindow,250);
  return localGaitEvidenceFromPhys(gFeatureWindow,n);
}

// ============================ ACTIVITY ============================
static ActivityEval evaluateActivity(){
  ActivityEval out;
  const int n=ringSnapshotPhys(gFeatureWindow,ACTIVITY_WINDOW_RAW);
  if(n<ACTIVITY_WINDOW_RAW)return out;
  const FeatureSet f=featureFromPhys(gFeatureWindow,n);
  out.features=f;
  float wtG,wtA,wtP,wtR;walkThresholds(wtG,wtA,wtP,wtR);
  float stG,stA,stR,stAR;staticThresholds(stG,stA,stR,stAR);
  const float staticGyro=f.gyroRms/fmaxSafe(0.1f,stG);
  const float staticAcc=f.accStd/fmaxSafe(1e-4f,stA);
  const float periodicity=finiteF(f.periodicity)?f.periodicity:0;
  const float walkP=clampF((periodicity-0.15f)/fmaxSafe(0.05f,wtP-0.15f),0,1);
  const float walkG=clampF((f.gyroRms/fmaxSafe(1.0f,wtG))/2,0,1);
  const float walkA=clampF((f.accStd/fmaxSafe(1e-5f,wtA))/2,0,1);
  const float walkR=clampF((f.gyroRange/fmaxSafe(1.0f,wtR))/2,0,1);
  const bool gaitMovement=
    f.gyroRms>=fmaxSafe(8.0f,stG*3.0f)&&
    f.accStd>=fmaxSafe(0.010f,stA*2.5f)&&
    f.gyroRange>=fmaxSafe(15.0f,stR*1.8f)&&
    periodicity>=fmaxSafe(0.30f,wtP*0.85f);
  const float wc=0.40f*walkP+0.25f*walkG+0.20f*walkA+0.15f*walkR;
  const float sc=
    0.50f*clampF(1-f.gyroRms/fmaxSafe(0.1f,stG),0,1)+
    0.30f*clampF(1-f.accStd/fmaxSafe(1e-4f,stA),0,1)+
    0.10f*clampF(1-f.gyroRange/fmaxSafe(1.0f,stR),0,1)+
    0.10f*clampF(1-f.accRange/fmaxSafe(1e-4f,stAR),0,1);
  ActivityState desired=ACT_TRANSITION;
  if(gaitMovement&&wc>=0.58f)desired=ACT_WALKING;
  else if(sc>=0.74f&&staticGyro<=1.10f&&staticAcc<=1.15f&&f.gyroRange<=stR*1.25f&&f.accRange<=stAR*1.25f)desired=ACT_STATIONARY;
  out.desired=desired;out.score=fmaxSafe(wc,sc);out.walkingConfidence=wc;out.stationaryConfidence=sc;out.motionRms=f.accStd;out.gyroRms=f.gyroRms;
  return out;
}
static void applyActivityState(ActivityState desired,float nowT){
  const ActivityState current=gActivity;
  if(current==ACT_UNKNOWN||(current==ACT_TRANSITION&&gActivityCandidate==ACT_UNKNOWN)){
    if(desired==ACT_STATIONARY||desired==ACT_WALKING){
      if(gActivityCandidate!=desired){gActivityCandidate=desired;gActivityCandidateSince=nowT;}
      const float required=(desired==ACT_STATIONARY)?0.50f:0.65f;
      if(finiteF(gActivityCandidateSince)&&nowT-gActivityCandidateSince>=required){gActivity=desired;gActivityStableSince=nowT;gActivityCandidate=ACT_UNKNOWN;gActivityCandidateSince=NAN;}
      else gActivity=ACT_TRANSITION;
    }else gActivity=ACT_TRANSITION;
    return;
  }
  if(desired==current){gActivityCandidate=ACT_UNKNOWN;gActivityCandidateSince=NAN;return;}
  if(gActivityCandidate!=desired){gActivityCandidate=desired;gActivityCandidateSince=nowT;return;}
  const float required=(current==ACT_WALKING&&desired==ACT_STATIONARY)?0.90f:((current==ACT_STATIONARY&&desired==ACT_WALKING)?0.75f:0.60f);
  if(finiteF(gActivityCandidateSince)&&nowT-gActivityCandidateSince>=required){gActivity=desired;gActivityStableSince=nowT;gActivityCandidate=ACT_UNKNOWN;gActivityCandidateSince=NAN;}
}
static void updateActivity(){
  if(!gWarmupDone||gRingCount<ACTIVITY_WINDOW_RAW||!finiteF(gSessionFirstT))return;
  RawRecord latest;if(ringSnapshotRaw(&latest,1)!=1)return;
  const float nowT=recT(latest);
  const ProtocolId ph=protocolAt(nowT-gSessionFirstT);
  const ActivityEval ev=evaluateActivity();
  if(!finiteF(ev.walkingConfidence))return;
  gActivityConfidence=ev.score;gWalkingConfidence=ev.walkingConfidence;gStationaryConfidence=ev.stationaryConfidence;gMotionRms=ev.motionRms;gGyroRms=ev.gyroRms;
  if(!finiteF(gActivityLastUpdateT)){gActivityLastUpdateT=nowT;applyActivityState(ev.desired,nowT);return;}
  float dt=clampF(nowT-gActivityLastUpdateT,0,0.75f);gActivityLastUpdateT=nowT;if(dt<=0)return;
  gPreviousActivity=gActivity;
  if(gPreviousActivity==ACT_WALKING){gActiveSec+=dt;if(isWalkPhase(ph)){gWalkingExposureSec+=dt;gProtocolActiveSec+=dt;}}
  else if(gPreviousActivity==ACT_STATIONARY){gStationarySec+=dt;if(isStillPhase(ph))gProtocolStationarySec+=dt;}
  else gTransitionSec+=dt;
  applyActivityState(ev.desired,nowT);
}

// ============================ FILTER / WAVELET ============================
static float bandpassOnePole(float x,OnePoleBP &s){
  if(!finiteF(x))x=0;
  const float dt=1.0f/RAW_HZ;
  const float hpRC=1.0f/(2.0f*PI_F*STEP_HP_HZ);
  const float lpRC=1.0f/(2.0f*PI_F*STEP_LP_HZ);
  const float ah=hpRC/(hpRC+dt),al=dt/(lpRC+dt);
  if(!s.initialized){s.hpX=x;s.hpY=0;s.lpY=0;s.initialized=true;}
  const float hp=ah*(s.hpY+x-s.hpX);
  const float lp=s.lpY+al*(hp-s.lpY);
  s.hpX=x;s.hpY=hp;s.lpY=lp;
  return lp;
}
static float robustThreshold(float *values,int n,float floorV){
  if(n<24)return NAN;
  float *tmp=gScratch.robustTmp; if(!tmp)return NAN;
  for(int i=0;i<n;i++)tmp[i]=fabsf(values[i]);
  const float med=medianSmall(tmp,n);
  for(int i=0;i<n;i++)tmp[i]=fabsf(fabsf(values[i])-med);
  const float mad=medianSmall(tmp,n);
  for(int i=0;i<n;i++)tmp[i]=fabsf(values[i]);
  const float q90=percentileSmall(tmp,n,0.90f);
  return fmaxSafe(floorV,fmaxSafe(med+0.85f*fmaxSafe(1e-6f,mad),0.80f*q90));
}
static float waveletCoefficient(const float *sig,int n,int center,float freq){
  if(!sig||center<0||center>=n)return NAN;
  const float halfSec=fminf(0.70f,fmaxf(0.28f,2.2f/freq));
  const int halfN=max(8,(int)floorf(halfSec*RAW_HZ));
  const int s=max(0,center-halfN),e=min(n-1,center+halfN);
  if(e-s<24)return NAN;
  float mu=0;for(int i=s;i<=e;i++)mu+=sig[i];mu/=(float)(e-s+1);
  float dot=0,ex=0,ey=0;const float sigma=1.15f/freq;
  for(int i=s;i<=e;i++){
    const float u=(i-center)/(float)RAW_HZ;
    const float q=u/sigma;
    const float w=cosf(2.0f*PI_F*freq*u)*expf(-0.5f*q*q);
    const float y=sig[i]-mu;
    dot+=y*w;ex+=y*y;ey+=w*w;
  }
  const float d=sqrtf(fmaxSafe(1e-12f,ex*ey));
  return d>0?fabsf(dot)/d:NAN;
}
static void waveletConfirmFromPhys(const PhysSample *a,int n,float eventT,float &bestScore,float &bestFreq){
  bestScore=NAN;bestFreq=NAN;if(n<60)return;
  float *g=gScratch.waveletG,*am=gScratch.waveletAm; if(!g||!am)return;
  int c=-1;float bestDt=999.0f;
  for(int i=0;i<n;i++){
    g[i]=sqrtf(a[i].gx*a[i].gx+a[i].gy*a[i].gy+a[i].gz*a[i].gz);
    const float mag=sqrtf(a[i].ax*a[i].ax+a[i].ay*a[i].ay+a[i].az*a[i].az);
    am[i]=fabsf(mag-1.0f);
    const float dt=fabsf(a[i].t-eventT);if(dt<bestDt){bestDt=dt;c=i;}
  }
  if(c<0||bestDt>0.5f/RAW_HZ)return;
  static constexpr float freqs[12]={0.55f,0.65f,0.75f,0.90f,1.10f,1.30f,1.50f,1.80f,2.10f,2.40f,2.80f,3.00f};
  float best=-INFINITY,bf=NAN;
  for(int k=0;k<12;k++){
    const float cg=waveletCoefficient(g,n,c,freqs[k]);if(finiteF(cg)&&cg>best){best=cg;bf=freqs[k];}
    const float ca=waveletCoefficient(am,n,c,freqs[k]);if(finiteF(ca)&&ca>best){best=ca;bf=freqs[k];}
  }
  bestScore=best;bestFreq=bf;
}
static void waveletConfirmAt(float eventT,float &bestScore,float &bestFreq){
  const int n=ringWindowByTime(eventT-0.70f,eventT+0.32f,gFeatureWindow,250);
  waveletConfirmFromPhys(gFeatureWindow,n,eventT,bestScore,bestFreq);
}

static void updateAFO(float t,float anchorT){
  if(!AFO_ENABLED)return;
  if(!finiteF(gAfoLastT))gAfoLastT=t;
  const float dt=t-gAfoLastT;
  if(dt>0&&finiteF(gAfoFreqHz))gAfoPhaseDeg=fmodf((finiteF(gAfoPhaseDeg)?gAfoPhaseDeg:0)+dt*gAfoFreqHz*360.0f,360.0f);
  gAfoLastT=t;
  if(finiteF(anchorT)){
    if(finiteF(gAfoAnchorT)){
      const float d=anchorT-gAfoAnchorT;
      if(d>=STEP_MIN_WALK_GAP_SEC&&d<=STEP_MAX_WALK_GAP_SEC){
        const float f=clampF(1.0f/d,AFO_MIN_HZ,AFO_MAX_HZ);
        gAfoFreqHz=finiteF(gAfoFreqHz)?0.82f*gAfoFreqHz+0.18f*f:f;
      }
    }
    gAfoAnchorT=anchorT;gAfoPhaseDeg=0;gAfoOppositeEmitted=false;
  }
}

// ============================ TCN EXACT NATIVE ENGINE ============================
#if IMU_TCN_MODEL_AVAILABLE
static bool runTCNExact(const float *input,float *ic,float *fc){
  if(!input||!ic||!fc)return false;
  // This is the exact implementation whose generated header passed the
  // Colab model-specific C++/TFJS parity gate. Do not duplicate its math here.
  return vspimu_tcn::predictICFC(input,ic,fc);
}
#else
static bool runTCNExact(const float*,float*,float*){return false;}
#endif

#if IMU_TCN_MODEL_AVAILABLE
static bool allocateTcnWorkspace(){
  if(gTcnInput&&gTcnICProb&&gTcnFCProb)return true;
  const size_t nIn=(size_t)MODEL_SAMPLES*MODEL_CHANNELS*sizeof(float);
  const size_t nProb=(size_t)MODEL_SAMPLES*sizeof(float);
  gTcnInput=(float*)heap_caps_malloc(nIn,MALLOC_CAP_8BIT);
  gTcnICProb=(float*)heap_caps_malloc(nProb,MALLOC_CAP_8BIT);
  gTcnFCProb=(float*)heap_caps_malloc(nProb,MALLOC_CAP_8BIT);
  const bool ok=gTcnInput&&gTcnICProb&&gTcnFCProb;
  if(!ok){
    if(gTcnInput)heap_caps_free(gTcnInput);
    if(gTcnICProb)heap_caps_free(gTcnICProb);
    if(gTcnFCProb)heap_caps_free(gTcnFCProb);
    gTcnInput=nullptr;gTcnICProb=nullptr;gTcnFCProb=nullptr;
  }
  return ok;
}
#endif

#if IMU_TCN_MODEL_AVAILABLE && defined(IMU_TCN_SELFTEST_AVAILABLE) && IMU_TCN_SELFTEST_AVAILABLE
static bool runTCNSelfTest(){
  if(!runTCNExact(&gait_tcn_selftest_input[0],gTcnICProb,gTcnFCProb))return false;
  float maxIC=0,maxFC=0;
  for(int i=0;i<MODEL_SAMPLES;i++){
    maxIC=fmaxSafe(maxIC,fabsf(gTcnICProb[i]-gait_tcn_selftest_initial_contact[i]));
    maxFC=fmaxSafe(maxFC,fabsf(gTcnFCProb[i]-gait_tcn_selftest_final_contact[i]));
  }
  Serial.printf("TCN SELFTEST | maxIC=%.7f maxFC=%.7f tol=%.7f | %s\n",maxIC,maxFC,(float)IMU_TCN_SELFTEST_TOLERANCE,(maxIC<=IMU_TCN_SELFTEST_TOLERANCE&&maxFC<=IMU_TCN_SELFTEST_TOLERANCE)?"PASS":"FAIL");
  return maxIC<=IMU_TCN_SELFTEST_TOLERANCE&&maxFC<=IMU_TCN_SELFTEST_TOLERANCE;
}
#else
static bool runTCNSelfTest(){Serial.println("TCN SELFTEST UNAVAILABLE | exporter header lacks embedded self-test");return false;}
#endif

// ============================ PROTOCOL / RESET ============================
static bool allocateRuntimeBuffers(){
  bool ok=true;
  auto A=[&](size_t bytes)->void*{return heap_caps_malloc(bytes,MALLOC_CAP_8BIT);};
  gRawRing=(RawRecord*)A(sizeof(RawRecord)*RAW_RING_CAP);
  // These two windows are never needed simultaneously; share one block.
  const size_t featureWindowBytes=sizeof(PhysSample)*ACTIVITY_WINDOW_RAW;
  const size_t modelRawWindowBytes=sizeof(RawRecord)*435U;
  const size_t sharedWindowBytes=(featureWindowBytes>modelRawWindowBytes)?featureWindowBytes:modelRawWindowBytes;
  gFeatureWindow=(PhysSample*)A(sharedWindowBytes);
  gModelRawWindow=(RawRecord*)gFeatureWindow;
  gFlashBlocks=(FlashBlock*)A(sizeof(FlashBlock)*FLASH_BLOCK_COUNT);
  gTcnIC=(Event*)A(sizeof(Event)*FINAL_MAX_CANDIDATES);
  gTcnFC=(Event*)A(sizeof(Event)*FINAL_MAX_CANDIDATES);
  gFinalWorkB=(Event*)A(sizeof(Event)*FINAL_MAX_CANDIDATES);
  // With PEAK_DISTANCE=100 at 200 Hz, a 400-sample window cannot contain
  // more than a small number of accepted peaks; 32 leaves ample safety margin.
  gPeakIC=(Peak*)A(sizeof(Peak)*PEAK_BUFFER_CAP);
  gPeakFC=(Peak*)A(sizeof(Peak)*PEAK_BUFFER_CAP);
  gFFTWorkRe=(float*)A(sizeof(float)*FFT_N);
  gFFTWorkIm=(float*)A(sizeof(float)*FFT_N);
  gLiveSignal=(SignalSample*)A(sizeof(SignalSample)*STEP_THRESHOLD_WINDOW_RAW);
  gSpectrumScratch=(float*)A(sizeof(float)*FFT_N);
  gTremorWave=(float*)A(sizeof(float)*TREMOR_WAVE_N);
  gScratch.featureAmag=(float*)A(sizeof(float)*ACTIVITY_WINDOW_RAW);
  gScratch.featureGx=(float*)A(sizeof(float)*ACTIVITY_WINDOW_RAW);
  gScratch.featureGy=(float*)A(sizeof(float)*ACTIVITY_WINDOW_RAW);
  gScratch.featureGz=(float*)A(sizeof(float)*ACTIVITY_WINDOW_RAW);
  gScratch.featureGm=(float*)A(sizeof(float)*ACTIVITY_WINDOW_RAW);
  gScratch.robustTmp=(float*)A(sizeof(float)*STEP_THRESHOLD_WINDOW_RAW);
  gScratch.waveletG=(float*)A(sizeof(float)*250U);
  gScratch.waveletAm=(float*)A(sizeof(float)*250U);
  gScratch.detectorGyroVals=(float*)A(sizeof(float)*STEP_THRESHOLD_WINDOW_RAW);
  gScratch.detectorAccVals=(float*)A(sizeof(float)*STEP_THRESHOLD_WINDOW_RAW);
  gScratch.validEvents=(Event*)A(sizeof(Event)*FINAL_MAX_CANDIDATES);
  gScratch.swingEvents=(Event*)A(sizeof(Event)*FINAL_MAX_CANDIDATES);
  gScratch.metricEvents=(Event*)A(sizeof(Event)*FINAL_MAX_CANDIDATES);
  gScratch.strideTmpA=(float*)A(sizeof(float)*FINAL_MAX_CANDIDATES);
  gScratch.strideTmpB=(float*)A(sizeof(float)*FINAL_MAX_CANDIDATES);
  gScratch.strideMed=(float*)A(sizeof(float)*FINAL_MAX_CANDIDATES);
  gScratch.stanceVals=(float*)A(sizeof(float)*FINAL_MAX_CANDIDATES);
  gScratch.swingVals=(float*)A(sizeof(float)*FINAL_MAX_CANDIDATES);
  gScratch.gapVals=(float*)A(sizeof(float)*FINAL_MAX_CANDIDATES);
  gScratch.confidenceVals=(float*)A(sizeof(float)*20U);
  gScratch.offlineSigG=(float*)A(sizeof(float)*STEP_THRESHOLD_WINDOW_RAW);
  gScratch.offlineSigA=(float*)A(sizeof(float)*STEP_THRESHOLD_WINDOW_RAW);
  gScratch.offlineGV=(float*)A(sizeof(float)*STEP_THRESHOLD_WINDOW_RAW);
  gScratch.offlineAV=(float*)A(sizeof(float)*STEP_THRESHOLD_WINDOW_RAW);
  ok=gRawRing&&gModelRawWindow&&gFeatureWindow&&gFlashBlocks&&gTcnIC&&gTcnFC&&gFinalWorkB&&gPeakIC&&gPeakFC&&gFFTWorkRe&&gFFTWorkIm&&gLiveSignal&&gSpectrumScratch&&gTremorWave&&gScratch.featureAmag&&gScratch.featureGx&&gScratch.featureGy&&gScratch.featureGz&&gScratch.featureGm&&gScratch.robustTmp&&gScratch.waveletG&&gScratch.waveletAm&&gScratch.detectorGyroVals&&gScratch.detectorAccVals&&gScratch.validEvents&&gScratch.swingEvents&&gScratch.metricEvents&&gScratch.strideTmpA&&gScratch.strideTmpB&&gScratch.strideMed&&gScratch.stanceVals&&gScratch.swingVals&&gScratch.gapVals&&gScratch.confidenceVals&&gScratch.offlineSigG&&gScratch.offlineSigA&&gScratch.offlineGV&&gScratch.offlineAV;
  if(!ok){
    Serial.println("FATAL: runtime analytics buffer allocation failed");
    Serial.printf("Free heap after allocation attempt: %u bytes\n",(unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT));
    return false;
  }
  memset(gRawRing,0,sizeof(RawRecord)*RAW_RING_CAP);
  memset(gFlashBlocks,0,sizeof(FlashBlock)*FLASH_BLOCK_COUNT);
  memset(gGaitFreqTrend,0,sizeof(gGaitFreqTrend));
  return true;
}

static void resetAnalyticsState(){
  gPacketCount=0;gSeq=0;gTotalSamples=0;gSensorMisses=0;gRawGaps=0;gSensorReadyTimeouts=0;gRingWrite=0;gRingCount=0;gSessionFirstSeq=0;gSessionLastSeq=0;
  gRawCrcState=0xFFFFFFFFUL;gNormCount=0;gWarmupDone=false;gStaticProfileLocked=false;gDominantAxis=0;
  for(int c=0;c<6;c++){gNormSum[c]=0;gNormSq[c]=0;}
  for(int i=0;i<6;i++){gMean[i]=0;gStd[i]=1;}
  gStaticProfile=FeatureSet{};gWalkProfile=FeatureSet{};
  gLiveSignalCount=0;gLiveSignalWrite=0;gLiveSignalPushes=0;gLastThresholdSeq=0;gPendingCount=0;gPendingOppositeCount=0;gLiveCorroborationCount=0;gLiveAnchorCount=0;gLiveInferredCount=0;
  gLiveLastAnchorT=NAN;gLiveLastWavelet=NAN;gLiveLastWaveletFreq=NAN;gLiveLastSignalScore=NAN;gStepDetectorCandidates=0;
  for(int i=0;i<3;i++)gLiveGyroFilters[i]=OnePoleBP{};gLiveAccFilter=OnePoleBP{};gLiveDetectorThreshold=NAN;gLiveAccThreshold=NAN;
  gTcnICCount=0;gTcnFCCount=0;gFinalEventCount=0;gFinalTcnValidated=0;gFinalTcnTotal=0;gFinalWaveletConfirmed=0;
  gLiveTcnAnchors=0;gLiveObservedSteps=0;gLiveInferredOpposite=0;gLiveStepCount=0;gFinalStepCount=0;gFinalizationMessage="";
  gAfoFreqHz=NAN;gAfoPhaseDeg=NAN;gAfoLastT=NAN;gAfoAnchorT=NAN;gAfoOppositeEmitted=false;
  gActivity=ACT_UNKNOWN;gPreviousActivity=ACT_UNKNOWN;gActivityCandidate=ACT_UNKNOWN;gActivityCandidateSince=NAN;gActivityStableSince=NAN;gActivityLastUpdateT=NAN;
  gActivityConfidence=NAN;gWalkingConfidence=NAN;gStationaryConfidence=NAN;gMotionRms=NAN;gGyroRms=NAN;
  gActiveSec=0;gStationarySec=0;gTransitionSec=0;gWalkingExposureSec=0;gProtocolActiveSec=0;gProtocolStationarySec=0;gActiveAdherencePct=NAN;
  gCadence=NAN;gStride=NAN;gStepInterval=NAN;gStrideFreq=NAN;gGaitFreq=NAN;gStrideCV=NAN;gStance=NAN;gSwing=NAN;gStancePct=NAN;gSwingPct=NAN;gMeanEventConfidence=NAN;
  gPhasePct=NAN;gSwingPeakDps=NAN;gSwingPeakPct=NAN;gSwingZeroCrossings=-1;gPhaseName="-";gGaitState="-";
  gGaitFreqHz=NAN;gStrideFreqHz=NAN;gGaitFreqTrendCount=0;gGaitFreqMeanHz=NAN;gGaitFreqCvPct=NAN;gTremorRms=NAN;gTremorPeakHz=NAN;gTremorGyroPeakHz=NAN;gTremorGyroRms=NAN;gTremorBandRatio=NAN;gFreezeIndex=NAN;gFreezeFlag=false;gFreezeFlagWindows=0;gFreezeFlagSec=0;gLastSpectrumT=NAN;gSpectrumQuality="WAITING";
  gSessionFirstT=NAN;gSessionDurationSec=NAN;gParityTransferPending=false;gLastParityRetryMs=0;gProtocolPhase=PH_NONE;gProtocolElapsedSec=0;gProtocolRemainingSec=PROTOCOL_TOTAL_SEC;gProtocolWalkElapsedSec=0;gProtocolStationaryElapsedSec=0;gProtocolComplete=false;
  gLastAnalysisSeq=0;gLastReportMs=0;gLastLiveInferenceSeq=0;gLastInferenceMs=NAN;gLastPeakIC=NAN;gLastPeakFC=NAN;gSignalSaturationCount=0;gSignalQuality="WAITING";gFinalizationInProgress=false;gFinalizationReady=false;gFlashIncomplete=false;
}
static void updateProtocolState(){
  if(!finiteF(gSessionFirstT)||gRingCount==0)return;
  RawRecord latest;if(ringSnapshotRaw(&latest,1)!=1)return;
  const float elapsed=recT(latest)-gSessionFirstT;
  gProtocolElapsedSec=elapsed;gProtocolRemainingSec=fmaxf(0,PROTOCOL_TOTAL_SEC-elapsed);gProtocolPhase=protocolAt(elapsed);gProtocolComplete=elapsed>=PROTOCOL_TOTAL_SEC-1.0f/RAW_HZ;
  gProtocolWalkElapsedSec=0;gProtocolStationaryElapsedSec=0;float cur=0;
  for(int i=0;i<PROTOCOL_COUNT;i++){
    const float used=clampF(elapsed-cur,0,PROTOCOL[i].dur);
    if(isWalkPhase(PROTOCOL[i].id))gProtocolWalkElapsedSec+=used;
    if(isStillPhase(PROTOCOL[i].id))gProtocolStationaryElapsedSec+=used;
    cur+=PROTOCOL[i].dur;if(cur>=elapsed)break;
  }
  gActiveAdherencePct=gProtocolWalkElapsedSec>0?100.0f*gProtocolActiveSec/gProtocolWalkElapsedSec:NAN;
}

// ============================ RAW BLE ============================
static void notifyRawPacket(){if(gClientConnected&&gDataChar){gDataChar->setValue((uint8_t*)gRawPacket,RAW_PACKET_BYTES);gDataChar->notify();}}
static void appendRawPacket(const RawRecord &r){
  int16_t *d=gRawPacket[gPacketCount++];
  d[0]=(int16_t)(r.seq&0xFFFFUL);d[1]=(int16_t)((r.seq>>16)&0xFFFFUL);
  d[2]=r.ax;d[3]=r.ay;d[4]=r.az;d[5]=r.gx;d[6]=r.gy;d[7]=r.gz;
  if(gPacketCount>=SAMPLES_PER_PACKET){notifyRawPacket();gPacketCount=0;}
}

// Match the app's dynamically recomputed dominant gyro axis: highest standard deviation
// over the most recent 800 raw samples. The common 0.07 dps/LSB scale cancels in the ranking.
static int dominantAxisRecent(){
  const uint32_t gc=gRingCount;const int n=(int)min<uint32_t>(gc,800U);if(n<30)return gDominantAxis;float sum[3]={0,0,0},sq[3]={0,0,0};
  portENTER_CRITICAL(&gRingMux);const uint32_t end=gRingWrite;
  for(int i=0;i<n;i++){const RawRecord &r=gRawRing[(end-(uint32_t)n+(uint32_t)i)%RAW_RING_CAP];const float x=(float)r.gx,y=(float)r.gy,z=(float)r.gz;sum[0]+=x;sum[1]+=y;sum[2]+=z;sq[0]+=x*x;sq[1]+=y*y;sq[2]+=z*z;}
  portEXIT_CRITICAL(&gRingMux);int best=0;float bestVar=-1;for(int c=0;c<3;c++){const float mu=sum[c]/n;const float v=fmaxSafe(0,sq[c]/n-mu*mu);if(v>bestVar){bestVar=v;best=c;}}return best;
}
static bool walkingGateAt(float t,bool deep){
  if(!finiteF(gSessionFirstT)||!isWalkPhase(protocolAt(t-gSessionFirstT)))return false;
  if(gActivity==ACT_WALKING&&finiteF(gWalkingConfidence)&&gWalkingConfidence>=0.50f)return true;
  return deep&&localGaitEvidenceAt(t)>=0.48f;
}

// ============================ LIVE STEP DETECTOR ============================
static void detectorThresholds(){
  const int n=min<uint16_t>(gLiveSignalCount,STEP_THRESHOLD_WINDOW_RAW);
  if(n<24)return;
  float *gyroVals=gScratch.detectorGyroVals,*accVals=gScratch.detectorAccVals; if(!gyroVals||!accVals)return;
  const uint32_t start=gLiveSignalWrite-(uint32_t)n;
  for(int i=0;i<n;i++){const int idx=(int)((start+(uint32_t)i)%STEP_THRESHOLD_WINDOW_RAW);gyroVals[i]=gLiveSignal[idx].gyro;accVals[i]=gLiveSignal[idx].acc;}
  const float gf=finiteF(gWalkProfile.gyroRange)?fmaxSafe(5.0f,0.10f*gWalkProfile.gyroRange):8.0f;
  const float af=finiteF(gWalkProfile.accStd)?fmaxSafe(0.004f,0.20f*gWalkProfile.accStd):0.006f;
  gLiveDetectorThreshold=robustThreshold(gyroVals,n,gf);
  gLiveAccThreshold=robustThreshold(accVals,n,af);
}
static void addLiveInferred(float t){
  if(gLiveInferredCount<LIVE_EVENT_CAP)gLiveInferredTimes[gLiveInferredCount++]=t;
  gLiveInferredOpposite=(uint16_t)min<int>(65535,(int)gLiveInferredOpposite+1);
}
static bool alreadyLiveInferredNear(float t,float tol){
  for(uint16_t i=0;i<gLiveInferredCount;i++)if(fabsf(gLiveInferredTimes[i]-t)<tol)return true;
  return false;
}
static bool liveGateAt(float t){return walkingGateAt(t,true);}
static void liveOppositeService(float t){
  if(!finiteF(gSessionFirstT))return;
  if(!walkingGateAt(t,false)){
    gPendingOppositeCount=0;gAfoOppositeEmitted=true;gLiveStepCount=satU16((int)gLiveObservedSteps+(int)gLiveInferredOpposite);return;
  }
  while(gPendingOppositeCount&&gPendingOpposite[0].t<=t){
    const float pt=gPendingOpposite[0].t;
    for(int j=1;j<gPendingOppositeCount;j++)gPendingOpposite[j-1]=gPendingOpposite[j];gPendingOppositeCount--;
    if(liveGateAt(pt)&&!alreadyLiveInferredNear(pt,0.18f)){addLiveInferred(pt);gLiveLastWavelet=gLiveLastWavelet;}
  }
  gLiveStepCount=satU16((int)gLiveObservedSteps+(int)gLiveInferredOpposite);
}
static void scheduleLiveOpposite(float t){
  if(!AFO_ENABLED||!finiteF(gAfoFreqHz)||gAfoFreqHz<=0||gPendingOppositeCount>=16)return;
  gPendingOpposite[gPendingOppositeCount++].t=t+0.5f/gAfoFreqHz;
}
static void registerCorroboration(const StepCandidate &c){
  const float t=c.t;liveOppositeService(t);
  const float prev=(gLiveAnchorCount>0)?gLiveAnchorTimes[gLiveAnchorCount-1]:NAN;
  if(finiteF(prev)&&isProtocolWalkTime(prev)&&isProtocolWalkTime(t)){
    const float d=t-prev;
    if(d>=STEP_MIN_WALK_GAP_SEC&&d<=STEP_MAX_WALK_GAP_SEC){
      const float midpoint=prev+d*0.5f;
      if(!alreadyLiveInferredNear(midpoint,0.18f)&&liveGateAt(midpoint))addLiveInferred(midpoint);
      updateAFO(t,t);gPendingOppositeCount=0;scheduleLiveOpposite(t);
    }else if(d>STEP_MAX_WALK_GAP_SEC){
      gPendingOppositeCount=0;gAfoFreqHz=NAN;updateAFO(t,t);
    }else gPendingOppositeCount=0;
  }else{
    gPendingOppositeCount=0;updateAFO(t,t);scheduleLiveOpposite(t);
  }
  if(gLiveAnchorCount<LIVE_EVENT_CAP)gLiveAnchorTimes[gLiveAnchorCount++]=t;
  else {memmove(gLiveAnchorTimes,gLiveAnchorTimes+1,sizeof(float)*(LIVE_EVENT_CAP-1));gLiveAnchorTimes[LIVE_EVENT_CAP-1]=t;}
  gLiveObservedSteps=satU16((int)gLiveAnchorCount);gLiveLastAnchorT=t;gLiveCorroborationCount=gLiveObservedSteps;
  gLiveStepCount=satU16((int)gLiveObservedSteps+(int)gLiveInferredOpposite);
}
static void finalizeLiveCandidate(const StepCandidate &c,float nowT){
  (void)nowT;float wscore,wfreq;waveletConfirmAt(c.t,wscore,wfreq);gLiveLastWavelet=wscore;gLiveLastWaveletFreq=wfreq;
  if(!(c.signalScore>=STEP_SIGNAL_MIN_SCORE)||!finiteF(wscore)||wscore<STEP_WAVELET_MIN_SCORE)return;
  if(!finiteF(gLiveLastAnchorT)||c.t-gLiveLastAnchorT>=STEP_REFRACTORY_SEC)registerCorroboration(c);
}
static void servicePendingCandidates(float nowT){
  for(int i=0;i<gPendingCount;){
    if(nowT-gPendingCandidates[i].t<0.32f){i++;continue;}
    const StepCandidate c=gPendingCandidates[i];
    for(int j=i+1;j<gPendingCount;j++)gPendingCandidates[j-1]=gPendingCandidates[j];gPendingCount--;finalizeLiveCandidate(c,nowT);
  }
}
static void stepDetectorPush(const PhysSample &p){
  float gv[3]={bandpassOnePole(p.gx,gLiveGyroFilters[0]),bandpassOnePole(p.gy,gLiveGyroFilters[1]),bandpassOnePole(p.gz,gLiveGyroFilters[2])};
  const int axis=(gDominantAxis<0)?0:(gDominantAxis>2?2:gDominantAxis); const float gyro=fabsf(gv[axis]);const float mag=sqrtf(p.ax*p.ax+p.ay*p.ay+p.az*p.az);const float acc=fabsf(bandpassOnePole(mag-1.0f,gLiveAccFilter));
  const int idx=(int)(gLiveSignalWrite%STEP_THRESHOLD_WINDOW_RAW);gLiveSignal[idx]={p.t,gyro,acc};gLiveSignalWrite++;if(gLiveSignalCount<STEP_THRESHOLD_WINDOW_RAW)gLiveSignalCount++;gLiveSignalPushes++;
  if(gLiveSignalPushes>=STEP_THRESHOLD_UPDATE_SAMPLES&&gLiveSignalPushes%STEP_THRESHOLD_UPDATE_SAMPLES==0)detectorThresholds();
  liveOppositeService(p.t);
  if(gLiveSignalCount<3||!finiteF(gLiveDetectorThreshold)||!finiteF(gLiveAccThreshold))return;
  const int i2=(int)((gLiveSignalWrite-1)%STEP_THRESHOLD_WINDOW_RAW),i1=(int)((gLiveSignalWrite-2)%STEP_THRESHOLD_WINDOW_RAW),i0=(int)((gLiveSignalWrite-3)%STEP_THRESHOLD_WINDOW_RAW);
  const SignalSample pr=gLiveSignal[i0],pc=gLiveSignal[i1],nx=gLiveSignal[i2];
  if(!walkingGateAt(pc.t,true)){return;}
  if(finiteF(gLiveLastAnchorT)&&pc.t-gLiveLastAnchorT<STEP_REFRACTORY_SEC)return;
  if(!(pc.gyro>=gLiveDetectorThreshold&&pc.gyro>=pr.gyro&&pc.gyro>nx.gyro))return;
  const float gs=clampF(pc.gyro/(gLiveDetectorThreshold*1.45f),0,1),as=clampF(pc.acc/(fmaxSafe(gLiveAccThreshold,0.01f)*1.8f),0,1);const float score=0.70f*gs+0.30f*as;
  gStepDetectorCandidates++;gLiveLastSignalScore=score; if(gPendingCount<16)gPendingCandidates[gPendingCount++]={pc.t,score};
}

// ============================ TCN MODEL WINDOW ============================
static bool makeLiveModelInput(float *out,float &endTime){
#if IMU_TCN_MODEL_AVAILABLE
  const int n=ringSnapshotRaw(gModelRawWindow,RAW_WINDOW);if(n<RAW_WINDOW)return false;
  for(int i=1;i<n;i++)if(gModelRawWindow[i].seq!=gModelRawWindow[i-1].seq+1)return false;
  endTime=recT(gModelRawWindow[n-1]);
  const float ratio=(float)RAW_HZ/(float)MODEL_HZ;
  const float start=(RAW_WINDOW-1)-(MODEL_SAMPLES-1)*ratio;
  for(int j=0;j<MODEL_SAMPLES;j++){
    const float pos=start+j*ratio;
    int i0=(int)floorf(pos);const float a=pos-i0;
    i0=constrain(i0,0,n-1);const int i1=constrain(i0+1,0,n-1);
    const RawRecord &s0=gModelRawWindow[i0],&s1=gModelRawWindow[i1];
    const int16_t v0[6]={s0.ax,s0.ay,s0.az,s0.gx,s0.gy,s0.gz};
    const int16_t v1[6]={s1.ax,s1.ay,s1.az,s1.gx,s1.gy,s1.gz};
    for(int c=0;c<6;c++){
      const float scale=(c<3)?ACC_G_PER_LSB:GYRO_DPS_PER_LSB;
      const float physical=(float)v0[c]+a*((float)v1[c]-(float)v0[c]);
      out[j*MODEL_CHANNELS+c]=(physical*scale-gMean[c])/gStd[c];
    }
  }
  return true;
#else
  (void)out;(void)endTime;return false;
#endif
}

static int findPeaks(const float *values,int n,float height,int distance,int left,int right,Peak *out,int maxOut){
  Peak cand[MODEL_SAMPLES];int nc=0;const int end=n-right;
  for(int i=1+left;i<end-1;i++){
    const float v=values[i];
    if(finiteF(v)&&v>=height&&v>values[i-1]&&v>=values[i+1]&&nc<MODEL_SAMPLES)cand[nc++]={i,v};
  }
  std::sort(cand,cand+nc,[](const Peak&a,const Peak&b){return a.v>b.v;});
  int na=0;
  for(int i=0;i<nc;i++){
    bool ok=true;for(int j=0;j<na;j++)if(abs(cand[i].i-out[j].i)<distance){ok=false;break;}
    if(ok&&na<maxOut)out[na++]=cand[i];
  }
  std::sort(out,out+na,[](const Peak&a,const Peak&b){return a.i<b.i;});
  return na;
}
static bool insertEvent(Event *list,uint16_t &count,const Event &e,float minGap){
  if(count>=FINAL_MAX_CANDIDATES||!finiteF(e.t)||!finiteF(e.conf))return false;
  int idx=0;while(idx<count&&list[idx].t<e.t)idx++;
  if(idx>0&&fabsf(list[idx-1].t-e.t)<minGap){if(e.conf>list[idx-1].conf){list[idx-1]=e;return true;}return false;}
  if(idx<count&&fabsf(list[idx].t-e.t)<minGap){if(e.conf>list[idx].conf){list[idx]=e;return true;}return false;}
  for(int i=count;i>idx;i--)list[i]=list[i-1];list[idx]=e;count++;return true;
}
static int buildValidTcn(Event *out,int maxOut){
  int n=0;
  for(uint16_t i=0;i<gTcnICCount;i++){
    Event e=gTcnIC[i];if(!finiteF(gSessionFirstT)||e.t<gSessionFirstT)continue;
    if(!isWalkPhase(protocolAt(e.t-gSessionFirstT)))continue;
    if(!finiteF(e.conf)||e.conf<STEP_TCN_MIN_PROB)continue;
    const float ev=finiteF(e.localEvidence)?e.localEvidence:localGaitEvidenceAt(e.t);
    if(ev<0.30f&&e.conf<0.55f)continue;
    e.localEvidence=ev;e.validForCadence=true;if(n<maxOut)out[n++]=e;
  }
  std::sort(out,out+n,[](const Event&a,const Event&b){return a.t<b.t;});
  int m=0;for(int i=0;i<n;i++){if(m==0||out[i].t-out[m-1].t>=STEP_REFRACTORY_SEC)out[m++]=out[i];else if(out[i].conf>out[m-1].conf)out[m-1]=out[i];}
  return m;
}
static int anchorBoutCount(const Event *events,int n,int *starts,int *lens){
  if(n<=0)return 0;int nb=0,start=0;
  for(int i=1;i<=n;i++)if(i==n||events[i].t-events[i-1].t>STEP_MAX_WALK_GAP_SEC){if(nb<64){starts[nb]=start;lens[nb]=i-start;nb++;}start=i;}
  return nb;
}
static uint16_t countLiveFromAnchors(const Event *events,int n){
  if(n<=0)return 0;int starts[64],lens[64];const int nb=anchorBoutCount(events,n,starts,lens);int total=0;
  for(int b=0;b<nb;b++)total+=(lens[b]==1)?1:(2*lens[b]-1);
  return satU16(total);
}
static void syncLiveFromTCN(){
  Event *valid=gScratch.validEvents; if(!valid)return;
  const int n=buildValidTcn(valid,FINAL_MAX_CANDIDATES);
  gLiveTcnAnchors=n;gLiveObservedSteps=n;gLiveStepCount=countLiveFromAnchors(valid,n);gLiveInferredOpposite=(gLiveStepCount>gLiveObservedSteps)?gLiveStepCount-gLiveObservedSteps:0;
}
static void processLivePeaks(const float *ic,const float *fc,float endTime){
  const int ni=findPeaks(ic,MODEL_SAMPLES,PEAK_HEIGHT,PEAK_DISTANCE,EDGE_LEFT,COMMIT_RIGHT,gPeakIC,PEAK_BUFFER_CAP);
  const int nf=findPeaks(fc,MODEL_SAMPLES,PEAK_HEIGHT,PEAK_DISTANCE,EDGE_LEFT,COMMIT_RIGHT,gPeakFC,PEAK_BUFFER_CAP);
  gLastPeakIC=0;gLastPeakFC=0;for(int i=0;i<MODEL_SAMPLES;i++){gLastPeakIC=fmaxSafe(gLastPeakIC,ic[i]);gLastPeakFC=fmaxSafe(gLastPeakFC,fc[i]);}
  for(int k=0;k<ni;k++){
    const float t=endTime-(MODEL_SAMPLES-1-gPeakIC[k].i)/(float)MODEL_HZ;
    if(!isWalkPhase(protocolAt(t-gSessionFirstT)))continue;
    const float evidence=localGaitEvidenceAt(t);
    if(gPeakIC[k].v<STEP_TCN_MIN_PROB||(evidence<0.30f&&gPeakIC[k].v<0.55f))continue;
    Event e{};e.t=t;e.conf=gPeakIC[k].v;e.finalConfidence=gPeakIC[k].v;e.localEvidence=evidence;e.source=1;e.tcnValidated=true;e.validForCadence=true;
    insertEvent(gTcnIC,gTcnICCount,e,IC_MIN_GAP_SEC);
  }
  for(int k=0;k<nf;k++){
    const float t=endTime-(MODEL_SAMPLES-1-gPeakFC[k].i)/(float)MODEL_HZ;
    if(!isWalkPhase(protocolAt(t-gSessionFirstT)))continue;
    Event e{};e.t=t;e.conf=gPeakFC[k].v;e.finalConfidence=gPeakFC[k].v;e.source=1;e.tcnValidated=true;e.validForCadence=true;
    insertEvent(gTcnFC,gTcnFCCount,e,FC_MIN_GAP_SEC);
  }
  gLiveTcnAnchors=gTcnICCount;
}
static void runLiveTCN(){
#if IMU_TCN_MODEL_AVAILABLE
  if(gTcnRuntimeFault)return;
  if(!gWarmupDone||gTotalSamples-gLastLiveInferenceSeq<104)return;
  if(gRingCount<RAW_WINDOW)return;
  float endTime;if(!makeLiveModelInput(gTcnInput,endTime))return;
  const uint64_t t0=(uint64_t)esp_timer_get_time();
  if(!runTCNExact(gTcnInput,gTcnICProb,gTcnFCProb)){gTcnRuntimeFault=true;Serial.println("TCN RUNTIME FAULT | generated header predictICFC failed");return;}
  gLastInferenceMs=((uint32_t)(esp_timer_get_time()-t0))/1000.0f;
  gLastLiveInferenceSeq=gTotalSamples;processLivePeaks(gTcnICProb,gTcnFCProb,endTime);
  static uint32_t lastTcnDiagMs=0;
  if(millis()-lastTcnDiagMs>=2000){
    lastTcnDiagMs=millis();
    Serial.printf("TCN LIVE | dt=%.1f ms maxIC=%.3f maxFC=%.3f anchors=%u IC=%u FC=%u\n",gLastInferenceMs,gLastPeakIC,gLastPeakFC,gLiveTcnAnchors,gTcnICCount,gTcnFCCount);
  }
#else
  static bool once=false;if(!once){Serial.println("TCN_MODEL=OFF | add Colab-generated gait_tcn_model.h");once=true;}
#endif
}

static void updateSignalQuality(){
  if(gRingCount==0){gSignalSaturationCount=0;gSignalQuality="WAITING";return;}
  const uint32_t gc=gRingCount;const int n=(int)((gc<(uint32_t)ACTIVITY_WINDOW_RAW)?gc:(uint32_t)ACTIVITY_WINDOW_RAW);uint16_t sat=0;portENTER_CRITICAL(&gRingMux);const uint32_t end=gRingWrite;
  for(int i=0;i<n;i++){const RawRecord &r=gRawRing[(end-(uint32_t)n+(uint32_t)i)%RAW_RING_CAP];if(abs((int)r.ax)>=(int)(3.8f/ACC_G_PER_LSB)||abs((int)r.ay)>=(int)(3.8f/ACC_G_PER_LSB)||abs((int)r.az)>=(int)(3.8f/ACC_G_PER_LSB)||abs((int)r.gx)>=(int)(1900.0f/GYRO_DPS_PER_LSB)||abs((int)r.gy)>=(int)(1900.0f/GYRO_DPS_PER_LSB)||abs((int)r.gz)>=(int)(1900.0f/GYRO_DPS_PER_LSB))sat++;}
  portEXIT_CRITICAL(&gRingMux);gSignalSaturationCount=sat;gSignalQuality=(gRawGaps==0&&sat==0)?"GOOD":(sat>0?"CHECK SATURATION":"CHECK DROPS");
}

// ============================ FFT / SPECTRUM ============================
static void fft(float *re,float *im,int n,bool inverse){
  for(int i=1,j=0;i<n;i++){int bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){float tr=re[i];re[i]=re[j];re[j]=tr;tr=im[i];im[i]=im[j];im[j]=tr;}}
  for(int len=2;len<=n;len<<=1){const float ang=(inverse?2.0f:-2.0f)*PI_F/len;const float wlr=cosf(ang),wli=sinf(ang);for(int i=0;i<n;i+=len){float wr=1,wi=0;for(int j=0;j<len/2;j++){const int u=i+j,v=u+len/2;const float tr=wr*re[v]-wi*im[v],ti=wr*im[v]+wi*re[v];re[v]=re[u]-tr;im[v]=im[u]-ti;re[u]+=tr;im[u]+=ti;const float nr=wr*wlr-wi*wli;wi=wr*wli+wi*wlr;wr=nr;}}}
  if(inverse)for(int i=0;i<n;i++){re[i]/=n;im[i]/=n;}
}
static void resample1D(const float *v,int n,float fsOld,float fsNew,int outN,float *out){
  const float ratio=fsOld/fsNew;const float start=(n-1)-(outN-1)*ratio;
  for(int j=0;j<outN;j++){const float p=start+j*ratio;int i0=(int)floorf(p);const float a=p-i0;i0=constrain(i0,0,n-1);const int i1=constrain(i0+1,0,n-1);out[j]=v[i0]+a*(v[i1]-v[i0]);}
}
static inline float rawSignalValue(const RawRecord &r,bool gyro){
  if(!gyro){const float ax=r.ax*ACC_G_PER_LSB,ay=r.ay*ACC_G_PER_LSB,az=r.az*ACC_G_PER_LSB;return sqrtf(ax*ax+ay*ay+az*az);}const float gx=r.gx*GYRO_DPS_PER_LSB,gy=r.gy*GYRO_DPS_PER_LSB,gz=r.gz*GYRO_DPS_PER_LSB;return sqrtf(gx*gx+gy*gy+gz*gz);
}
static bool spectrumFromRing(bool gyro,Spectrum &s){
  const uint32_t gc=gRingCount;const int n=(int)((gc<(uint32_t)SPECTRUM_RAW)?gc:(uint32_t)SPECTRUM_RAW);if(n<2)return false;const float ratio=RAW_HZ/FFT_FS;const float start=(float)(n-1)-(float)(FFT_N-1)*ratio;if(start<0)return false;
  portENTER_CRITICAL(&gRingMux);const uint32_t end=gRingWrite,begin=end-(uint32_t)n;
  for(int j=0;j<FFT_N;j++){const float pos=start+j*ratio;int i0=(int)floorf(pos);const float a=pos-i0;i0=constrain(i0,0,n-1);const int i1=constrain(i0+1,0,n-1);const RawRecord r0=gRawRing[(begin+(uint32_t)i0)%RAW_RING_CAP],r1=gRawRing[(begin+(uint32_t)i1)%RAW_RING_CAP];const float x0=rawSignalValue(r0,gyro),x1=rawSignalValue(r1,gyro);gSpectrumScratch[j]=x0+a*(x1-x0);}
  portEXIT_CRITICAL(&gRingMux);const float mu=meanF(gSpectrumScratch,FFT_N);for(int i=0;i<FFT_N;i++){const float w=0.5f-0.5f*cosf(2*PI_F*i/(FFT_N-1));gFFTWorkRe[i]=(gSpectrumScratch[i]-mu)*w;gFFTWorkIm[i]=0;}fft(gFFTWorkRe,gFFTWorkIm,FFT_N,false);memcpy(s.re,gFFTWorkRe,sizeof(float)*FFT_N);memcpy(s.im,gFFTWorkIm,sizeof(float)*FFT_N);for(int k=0;k<=FFT_N/2;k++)s.pow[k]=s.re[k]*s.re[k]+s.im[k]*s.im[k];return true;
}
static bool tremorWaveformFromRing(float *out){
  if(!out||gRingCount<TREMOR_WAVE_N)return false;portENTER_CRITICAL(&gRingMux);const uint32_t end=gRingWrite,begin=end-TREMOR_WAVE_N;for(int i=0;i<TREMOR_WAVE_N;i++)gFFTWorkRe[i]=rawSignalValue(gRawRing[(begin+(uint32_t)i)%RAW_RING_CAP],false);portEXIT_CRITICAL(&gRingMux);const float mu=meanF(gFFTWorkRe,TREMOR_WAVE_N);for(int i=0;i<TREMOR_WAVE_N;i++){gFFTWorkRe[i]-=mu;gFFTWorkIm[i]=0;}fft(gFFTWorkRe,gFFTWorkIm,TREMOR_WAVE_N,false);for(int k=0;k<TREMOR_WAVE_N;k++){const float f=(k<=TREMOR_WAVE_N/2?k:TREMOR_WAVE_N-k)*RAW_HZ/TREMOR_WAVE_N;if(f<TREMOR_LOW_HZ||f>TREMOR_HIGH_HZ){gFFTWorkRe[k]=0;gFFTWorkIm[k]=0;}}fft(gFFTWorkRe,gFFTWorkIm,TREMOR_WAVE_N,true);memcpy(out,gFFTWorkRe,sizeof(float)*TREMOR_WAVE_N);return true;
}
static bool bandLimitedGyroWaveformFromRing(float lo,float hi,float *out){
  if(!out||gRingCount<FFT_N)return false;portENTER_CRITICAL(&gRingMux);const uint32_t end=gRingWrite,begin=end-FFT_N;for(int i=0;i<FFT_N;i++)gFFTWorkRe[i]=rawSignalValue(gRawRing[(begin+(uint32_t)i)%RAW_RING_CAP],true);portEXIT_CRITICAL(&gRingMux);const float mu=meanF(gFFTWorkRe,FFT_N);for(int i=0;i<FFT_N;i++){const float w=0.5f-0.5f*cosf(2*PI_F*i/(FFT_N-1));gFFTWorkRe[i]=(gFFTWorkRe[i]-mu)*w;gFFTWorkIm[i]=0;}fft(gFFTWorkRe,gFFTWorkIm,FFT_N,false);for(int k=0;k<FFT_N;k++){const float f=(k<=FFT_N/2?k:FFT_N-k)*RAW_HZ/FFT_N;if(f<lo||f>hi){gFFTWorkRe[k]=0;gFFTWorkIm[k]=0;}}fft(gFFTWorkRe,gFFTWorkIm,FFT_N,true);memcpy(out,gFFTWorkRe,sizeof(float)*FFT_N);return true;
}
static float bandPower(const Spectrum &s,float lo,float hi){float p=0;for(int k=0;k<=FFT_N/2;k++){const float f=k*FFT_FS/FFT_N;if(f>=lo&&f<=hi)p+=s.pow[k];}return p;}
static float domFreq(const Spectrum &s,float lo,float hi){float best=-INFINITY,bf=NAN;for(int k=1;k<=FFT_N/2;k++){const float f=k*FFT_FS/FFT_N;if(f>=lo&&f<=hi&&s.pow[k]>best){best=s.pow[k];bf=f;}}return bf;}
static void updateSpectrum(){
  if(!gWarmupDone||gRingCount<SPECTRUM_MIN_RAW||!finiteF(gSessionFirstT))return;RawRecord latest;if(ringSnapshotRaw(gModelRawWindow,1)!=1)return;const float now=recT(gModelRawWindow[0]);if(finiteF(gLastSpectrumT)&&now-gLastSpectrumT<1.0f)return;gLastSpectrumT=now;const bool walking=isWalkPhase(protocolAt(now-gSessionFirstT));if(!spectrumFromRing(false,gSpectrum)){gSpectrumQuality="NO DATA";return;}
  if(walking){gGaitFreqHz=domFreq(gSpectrum,LOCOMOTOR_LOW_HZ,LOCOMOTOR_HIGH_HZ);gStrideFreqHz=finiteF(gGaitFreqHz)?gGaitFreqHz/2.0f:NAN;const float wp=bandPower(gSpectrum,LOCOMOTOR_LOW_HZ,LOCOMOTOR_HIGH_HZ),fp=bandPower(gSpectrum,TREMOR_LOW_HZ,TREMOR_HIGH_HZ);gFreezeIndex=wp>1e-12f?fp/wp:NAN;if(finiteF(gGaitFreqHz)){if(gGaitFreqTrendCount<60)gGaitFreqTrend[gGaitFreqTrendCount++]=gGaitFreqHz;else{memmove(gGaitFreqTrend,gGaitFreqTrend+1,sizeof(float)*59);gGaitFreqTrend[59]=gGaitFreqHz;}gGaitFreqMeanHz=meanF(gGaitFreqTrend,gGaitFreqTrendCount);gGaitFreqCvPct=gGaitFreqMeanHz>0?stdF(gGaitFreqTrend,gGaitFreqTrendCount,gGaitFreqMeanHz)/gGaitFreqMeanHz*100.0f:NAN;}}
  if(!tremorWaveformFromRing(gTremorWave)){gSpectrumQuality="NO DATA";return;}gTremorRms=rmsF(gTremorWave,TREMOR_WAVE_N);if(!spectrumFromRing(true,gSpectrum)){gSpectrumQuality="NO DATA";return;}const float tremP=bandPower(gSpectrum,4,12),broad=bandPower(gSpectrum,0.5f,20);gTremorBandRatio=broad>1e-12f?tremP/broad:NAN;gTremorGyroPeakHz=domFreq(gSpectrum,4,12);if(!bandLimitedGyroWaveformFromRing(4,12,gSpectrumScratch)){gSpectrumQuality="NO DATA";return;}gTremorGyroRms=rmsF(gSpectrumScratch,FFT_N);gTremorPeakHz=domFreq(gSpectrum,TREMOR_LOW_HZ,TREMOR_HIGH_HZ);gFreezeFlag=walking&&finiteF(gFreezeIndex)&&gFreezeIndex>=FOG_FI_THRESHOLD;if(gFreezeFlag){gFreezeFlagWindows++;gFreezeFlagSec+=1.0f;}gSpectrumQuality=walking?"VALID WALK WINDOW":"VALID OSCILLATION WINDOW";
}

// ============================ GAIT METRICS ============================
static int collectValidIC(Event *out,int maxN){
  if(!gFinalizationReady){return buildValidTcn(out,maxN);}
  int n=0;for(uint16_t i=0;i<gFinalEventCount&&n<maxN;i++){const Event e=gTcnIC[i];if(!finiteF(gSessionFirstT)||!e.validForCadence||!isWalkPhase(protocolAt(e.t-gSessionFirstT)))continue;out[n++]=e;}return n;
}
static float robustStrideFromEvents(const Event *ev,int n,float *clean,int &nc,float *all,int &na){
  na=0;nc=0;if(n<2)return NAN;
  for(int i=1;i<n;i++){const float d=ev[i].t-ev[i-1].t;if(d>=MIN_STRIDE_SEC&&d<=MAX_STRIDE_SEC&&na<FINAL_MAX_CANDIDATES)all[na++]=d;}
  if(na==0)return NAN;float *tmp=gScratch.strideTmpA;if(!tmp)return NAN;memcpy(tmp,all,sizeof(float)*na);const float center=medianSmall(tmp,na);const float tol=fmaxSafe(0.18f,0.30f*center);
  for(int i=0;i<na;i++)if(fabsf(all[i]-center)<=tol&&nc<FINAL_MAX_CANDIDATES)clean[nc++]=all[i];
  if(nc==0)return NAN;float *tmp2=gScratch.strideTmpB;if(!tmp2)return NAN;memcpy(tmp2,clean,sizeof(float)*nc);return medianSmall(tmp2,nc);
}
static void updateSwingLandmarks(){
  Event *ev=gScratch.swingEvents; if(!ev)return;const int n=collectValidIC(ev,FINAL_MAX_CANDIDATES);if(n<2){gSwingPeakDps=NAN;gSwingPeakPct=NAN;gSwingZeroCrossings=-1;return;}
  const Event a=ev[n-2],b=ev[n-1];Event fcBest{};bool got=false;
  for(uint16_t j=0;j<gTcnFCCount;j++)if(gTcnFC[j].t>a.t+0.05f&&gTcnFC[j].t<b.t){if(!got||gTcnFC[j].t<fcBest.t){fcBest=gTcnFC[j];got=true;}}
  if(!got){gSwingPeakDps=NAN;gSwingPeakPct=NAN;gSwingZeroCrossings=-1;return;}
  const int wn=ringWindowByTime(fcBest.t,b.t,gFeatureWindow,250);if(wn<5){gSwingPeakDps=NAN;gSwingPeakPct=NAN;gSwingZeroCrossings=-1;return;}
  const int axis=gDominantAxis;float mu=0;for(int i=0;i<wn;i++)mu+=(axis==0?gFeatureWindow[i].gx:(axis==1?gFeatureWindow[i].gy:gFeatureWindow[i].gz));mu/=wn;
  float peak=-INFINITY,pt=NAN;int z=0;float prev=0;bool hp=false;
  for(int i=0;i<wn;i++){const float v=axis==0?gFeatureWindow[i].gx:(axis==1?gFeatureWindow[i].gy:gFeatureWindow[i].gz);if(fabsf(v)>peak){peak=fabsf(v);pt=gFeatureWindow[i].t;}const float q=v-mu;if(hp&&((prev<=0&&q>0)||(prev>=0&&q<0)))z++;if(q!=0){prev=q;hp=true;}}
  gSwingPeakDps=peak;gSwingPeakPct=finiteF(pt)?(pt-a.t)/(b.t-a.t)*100.0f:NAN;gSwingZeroCrossings=z;
}
static void computeMetrics(){
  Event *ev=gScratch.metricEvents; if(!ev)return;float *clean=gScratch.stanceVals,*all=gScratch.swingVals;if(!clean||!all){gCadence=NAN;gStride=NAN;return;}const int n=collectValidIC(ev,FINAL_MAX_CANDIDATES);int nc=0,na=0;
  const float stride=robustStrideFromEvents(ev,n,clean,nc,all,na);gStride=stride;const float eventCadence=finiteF(stride)?120.0f/stride:NAN;const float spectralCadence=finiteF(gGaitFreqMeanHz)?60.0f*gGaitFreqMeanHz:NAN;float cadence=NAN;
  if(finiteF(eventCadence)&&finiteF(spectralCadence)){const float rel=fabsf(eventCadence-spectralCadence)/fmaxSafe(1.0f,eventCadence);cadence=(nc>=4&&rel<=0.15f)?0.75f*eventCadence+0.25f*spectralCadence:eventCadence;}
  else if(finiteF(eventCadence))cadence=eventCadence;
  else if(finiteF(spectralCadence)&&gActivity==ACT_WALKING)cadence=spectralCadence;
  gCadence=cadence;gStepInterval=finiteF(cadence)&&cadence>0?60.0f/cadence:NAN;gStrideFreq=finiteF(stride)?1.0f/stride:NAN;gGaitFreq=finiteF(cadence)?cadence/60.0f:NAN;
  if(nc>=3){float *medBuf=gScratch.strideMed;if(!medBuf){gStrideCV=NAN;}else{memcpy(medBuf,clean,sizeof(float)*nc);const float med=medianSmall(medBuf,nc);gStrideCV=stdF(clean,nc,med)/fmaxSafe(1e-9f,med)*100.0f;}}else gStrideCV=NAN;
  float *sts=gScratch.stanceVals,*sws=gScratch.swingVals; if(!sts||!sws){gStance=NAN;gSwing=NAN;return;}int ns=0,nw=0;
  for(int i=0;i<n-1;i++){const float ic1=ev[i].t,ic2=ev[i+1].t;for(uint16_t j=0;j<gTcnFCCount;j++){if(gTcnFC[j].t>ic1+0.05f&&gTcnFC[j].t<ic2){const float st=gTcnFC[j].t-ic1,sw=ic2-gTcnFC[j].t;if(st>0.15f&&st<1.7f&&ns<FINAL_MAX_CANDIDATES)sts[ns++]=st;if(sw>0.15f&&sw<1.7f&&nw<FINAL_MAX_CANDIDATES)sws[nw++]=sw;break;}}}
  gStance=ns?medianSmall(sts,ns):NAN;gSwing=nw?medianSmall(sws,nw):NAN;gStancePct=finiteF(gStance)&&finiteF(gStride)?gStance/gStride*100.0f:NAN;gSwingPct=finiteF(gSwing)&&finiteF(gStride)?gSwing/gStride*100.0f:NAN;
  float *confs=gScratch.confidenceVals; if(!confs){gMeanEventConfidence=NAN;return;}int nc2=0;for(int i=max(0,n-20);i<n;i++)if(finiteF(ev[i].conf))confs[nc2++]=ev[i].conf;gMeanEventConfidence=nc2?meanF(confs,nc2):NAN;
  if(finiteF(gSessionFirstT)&&n>0&&finiteF(gStride)){
    RawRecord last;ringSnapshotRaw(&last,1);const float now=recT(last),lastIC=ev[n-1].t;
    if(now-lastIC>fmaxSafe(3.2f,1.6f*gStride)){gPhasePct=NAN;gPhaseName="-";gGaitState="-";}
    else{
      gPhasePct=clampF((now-lastIC)/gStride*100.0f,0,100);gGaitState=gPhasePct<60?"STANCE":"SWING";float latestFC=NAN;for(uint16_t j=0;j<gTcnFCCount;j++)if(gTcnFC[j].t>lastIC){latestFC=gTcnFC[j].t;break;}if(finiteF(latestFC))gGaitState=now<latestFC?"STANCE":"SWING";
      if(gPhasePct<10)gPhaseName="Loading response";else if(gPhasePct<30)gPhaseName="Mid-stance";else if(gPhasePct<50)gPhaseName="Terminal stance";else if(gPhasePct<60)gPhaseName="Pre-swing";else if(gPhasePct<70)gPhaseName="Initial swing";else if(gPhasePct<80)gPhaseName="Mid-swing";else gPhaseName="Terminal swing";
    }
  }
  updateSwingLandmarks();
}

// ============================ FLASH SESSION STORAGE ============================
static bool startStorage(){
  if(!gFlashReady)return false;
  if(!gFreeQ)gFreeQ=xQueueCreate(FLASH_BLOCK_COUNT,sizeof(uint8_t));
  if(!gReadyQ)gReadyQ=xQueueCreate(FLASH_BLOCK_COUNT,sizeof(uint8_t));
  if(!gFreeQ||!gReadyQ)return false;
  uint8_t idx;
  while(xQueueReceive(gFreeQ,&idx,0)==pdTRUE){}
  while(xQueueReceive(gReadyQ,&idx,0)==pdTRUE){}
  for(uint8_t i=0;i<FLASH_BLOCK_COUNT;i++)xQueueSend(gFreeQ,&i,0);
  gCurrentFlashBlock=0xFF;gCurrentFlashCount=0;
  if(xQueueReceive(gFreeQ,&idx,portMAX_DELAY)!=pdTRUE)return false;gCurrentFlashBlock=idx;
  LittleFS.remove(SESSION_FILE);gStorageWriterDone=false;gFlashIncomplete=false;return true;
}
static void storageFlushCurrent(){
  const uint8_t idx=gCurrentFlashBlock;if(idx==0xFF||gCurrentFlashCount==0)return;
  gFlashBlocks[idx].count=gCurrentFlashCount;
  if(xQueueSend(gReadyQ,&idx,0)!=pdTRUE)gFlashIncomplete=true;
  gCurrentFlashBlock=0xFF;gCurrentFlashCount=0;
}
static void storageEnqueueRecord(const RawRecord &r){
  if(!gFlashReady||gFlashIncomplete)return;
  uint8_t idx=gCurrentFlashBlock;
  if(idx==0xFF){if(xQueueReceive(gFreeQ,&idx,0)!=pdTRUE){gFlashIncomplete=true;return;}gCurrentFlashBlock=idx;gCurrentFlashCount=0;}
  gFlashBlocks[idx].rec[gCurrentFlashCount++]=r;
  if(gCurrentFlashCount>=FLASH_BLOCK_SAMPLES){gFlashBlocks[idx].count=gCurrentFlashCount;if(xQueueSend(gReadyQ,&idx,0)!=pdTRUE){gFlashIncomplete=true;return;}gCurrentFlashBlock=0xFF;gCurrentFlashCount=0;}
}
static void flashWriterTask(void *){
  File f;
  for(;;){
    uint8_t idx;
    if(xQueueReceive(gReadyQ,&idx,pdMS_TO_TICKS(100))==pdTRUE){
      if(!f)f=LittleFS.open(SESSION_FILE,FILE_WRITE);
      if(f){FlashBlock &b=gFlashBlocks[idx];const size_t want=(size_t)b.count*sizeof(RawRecord);const size_t wrote=f.write((const uint8_t*)b.rec,want);if(wrote!=want)gFlashIncomplete=true;}
      else gFlashIncomplete=true;
      xQueueSend(gFreeQ,&idx,portMAX_DELAY);
    }
    if(!gAcquiring&&gSamplingStopped&&gCurrentFlashBlock==0xFF&&uxQueueMessagesWaiting(gReadyQ)==0){
      if(f){f.flush();f.close();}
      gStorageWriterDone=true;
    }
  }
}

static uint32_t sessionRecordCount(File &f){const size_t bytes=f.size();return (uint32_t)(bytes/sizeof(RawRecord));}
static bool readSessionRecord(File &f,uint32_t index,RawRecord &r){const uint32_t pos=index*(uint32_t)sizeof(RawRecord);if(!f.seek(pos))return false;return f.read((uint8_t*)&r,sizeof(RawRecord))==sizeof(RawRecord);}
static bool readSessionSequential(File &f,uint32_t start,uint32_t count,RawRecord *out){
  if(!f.seek(start*(uint32_t)sizeof(RawRecord)))return false;const size_t want=(size_t)count*sizeof(RawRecord);return f.read((uint8_t*)out,want)==want;
}
static int readPhysWindowFromFile(File &f,float t0,float t1,PhysSample *out,int maxN){
  const uint32_t total=sessionRecordCount(f);if(!total||maxN<=0)return 0;
  int64_t start=(int64_t)floorf(t0*RAW_HZ)-2;if(start<0)start=0;int64_t end=(int64_t)ceilf(t1*RAW_HZ)+2;if(end>=(int64_t)total)end=total-1;if(end<start)return 0;
  const uint32_t count=(uint32_t)(end-start+1);if(count>435)return 0;if(!readSessionSequential(f,(uint32_t)start,count,gModelRawWindow))return 0;
  int w=0;for(uint32_t i=0;i<count&&w<maxN;i++){const PhysSample p=toPhys(gModelRawWindow[i]);if(p.t>=t0&&p.t<=t1)out[w++]=p;}return w;
}
static float localGaitEvidenceFromFile(File &f,float t){
  const int n=readPhysWindowFromFile(f,t-0.85f,t+0.35f,gFeatureWindow,250);return localGaitEvidenceFromPhys(gFeatureWindow,n);
}
static void waveletConfirmFromFile(File &f,float t,float &score,float &freq){
  const int n=readPhysWindowFromFile(f,t-0.75f,t+0.35f,gFeatureWindow,250);waveletConfirmFromPhys(gFeatureWindow,n,t,score,freq);
}

// ============================ FILE-BACKED TCN WINDOW ============================
#if IMU_TCN_MODEL_AVAILABLE
static bool makeSessionModelInput(File &f,float centerT){
  const uint32_t total=sessionRecordCount(f);
  if(total<RAW_WINDOW)return false;
  const float startT=centerT-1.0f;
  const float t0=startT-0.01f;
  const float t1=startT+2.0f+0.01f;
  int64_t start=(int64_t)floorf(fmaxf(0.0f,t0)*(float)RAW_HZ)-2;
  int64_t end=(int64_t)ceilf(t1*(float)RAW_HZ)+2;
  if(start<0)start=0;
  if(end>=(int64_t)total)end=(int64_t)total-1;
  if(end<start)return false;
  const uint32_t rawCount=(uint32_t)(end-start+1);
  if(rawCount>435U)return false;
  if(!readSessionSequential(f,(uint32_t)start,rawCount,gModelRawWindow))return false;
  int first=0;
  while(first<(int)rawCount && recT(gModelRawWindow[first])<t0)first++;
  int last=(int)rawCount-1;
  while(last>=first && recT(gModelRawWindow[last])>t1)last--;
  const int arrCount=last-first+1;
  if(arrCount<380)return false;
  for(int i=1;i<arrCount;i++)if(gModelRawWindow[first+i].seq!=gModelRawWindow[first+i-1].seq+1)return false;
  int ptr=0;
  for(int j=0;j<MODEL_SAMPLES;j++){
    const float tt=startT+j/(float)MODEL_HZ;
    while(ptr+1<arrCount && recT(gModelRawWindow[first+ptr+1])<tt)ptr++;
    if(ptr+1>=arrCount)return false;
    const RawRecord &s0=gModelRawWindow[first+ptr],&s1=gModelRawWindow[first+ptr+1];
    const float ta=recT(s0),tb=recT(s1);
    const float a=clampF((tt-ta)/fmaxSafe(1e-9f,tb-ta),0,1);
    const int16_t v0[6]={s0.ax,s0.ay,s0.az,s0.gx,s0.gy,s0.gz};
    const int16_t v1[6]={s1.ax,s1.ay,s1.az,s1.gx,s1.gy,s1.gz};
    for(int c=0;c<6;c++){
      const float scale=(c<3)?ACC_G_PER_LSB:GYRO_DPS_PER_LSB;
      const float physical=((float)v0[c]+a*((float)v1[c]-(float)v0[c]))*scale;
      gTcnInput[j*MODEL_CHANNELS+c]=(physical-gMean[c])/gStd[c];
    }
  }
  return true;
}
#endif

// ============================ FINAL RETROSPECTIVE TOOLS ============================
static int cleanAnchorSequence(const Event *in,int n,Event *out,int maxOut){
  if(n<=0)return 0;
  int m=min(n,maxOut);for(int i=0;i<m;i++)out[i]=in[i];std::sort(out,out+m,[](const Event&a,const Event&b){return a.t<b.t;});
  int k=0;for(int i=0;i<m;i++){if(k==0||out[i].t-out[k-1].t>=STEP_MIN_WALK_GAP_SEC)out[k++]=out[i];else if(out[i].conf>out[k-1].conf)out[k-1]=out[i];}
  if(k<3)return k;
  float *gaps=gScratch.gapVals; if(!gaps)return n;int ng=0;for(int i=1;i<k;i++){const float d=out[i].t-out[i-1].t;if(d>=STEP_MIN_WALK_GAP_SEC&&d<=STEP_MAX_WALK_GAP_SEC)gaps[ng++]=d;}
  if(!ng)return k;const float med=medianSmall(gaps,ng);for(int i=1;i<k-1;i++){
    const float a=out[i].t-out[i-1].t,b=out[i+1].t-out[i].t;const bool bothOdd=fabsf(a-med)>STEP_INTERVAL_TOL_SEC&&fabsf(b-med)>STEP_INTERVAL_TOL_SEC;const bool weak=out[i].conf<fminf(out[i-1].conf,out[i+1].conf);
    if((a<STEP_MIN_WALK_GAP_SEC||b<STEP_MIN_WALK_GAP_SEC)&&weak){for(int j=i+1;j<k;j++)out[j-1]=out[j];k--;i--;continue;}
    if(bothOdd&&weak){for(int j=i+1;j<k;j++)out[j-1]=out[j];k--;i--;}
  }
  return k;
}
static int detectCandidatesOffline(File &f,Event *out,int maxOut){
  if(!out||maxOut<=0)return 0;
  OnePoleBP fg{},fa{};float *sigG=gScratch.offlineSigG,*sigA=gScratch.offlineSigA,*gv=gScratch.offlineGV,*av=gScratch.offlineAV;
  if(!sigG||!sigA||!gv||!av)return 0;
  uint32_t scount=0,lastThreshold=0;float th=NAN,ath=NAN;RawRecord r;uint32_t total=sessionRecordCount(f);int nRaw=0;
  for(uint32_t i=0;i<total;i++){
    if(!readSessionRecord(f,i,r))break;
    const float gx=r.gx*GYRO_DPS_PER_LSB,gy=r.gy*GYRO_DPS_PER_LSB,gz=r.gz*GYRO_DPS_PER_LSB;
    float axes[3]={gx,gy,gz};const float g=bandpassOnePole(axes[gDominantAxis],fg);const float mag=sqrtf((float)r.ax*r.ax+(float)r.ay*r.ay+(float)r.az*r.az)*ACC_G_PER_LSB;const float a=bandpassOnePole(mag-1.0f,fa);
    const int idx=(int)(scount%STEP_THRESHOLD_WINDOW_RAW);sigG[idx]=fabsf(g);sigA[idx]=fabsf(a);scount++;
    if(scount>=STEP_THRESHOLD_UPDATE_SAMPLES&&scount-lastThreshold>=STEP_THRESHOLD_UPDATE_SAMPLES){lastThreshold=scount;const int n=(int)min<uint32_t>(scount,STEP_THRESHOLD_WINDOW_RAW);const uint32_t st=scount-(uint32_t)n;for(int j=0;j<n;j++){const int q=(int)((st+(uint32_t)j)%STEP_THRESHOLD_WINDOW_RAW);gv[j]=sigG[q];av[j]=sigA[q];}const float gf=finiteF(gWalkProfile.gyroRange)?fmaxSafe(5.0f,0.10f*gWalkProfile.gyroRange):8.0f;const float af=finiteF(gWalkProfile.accStd)?fmaxSafe(0.004f,0.20f*gWalkProfile.accStd):0.006f;th=robustThreshold(gv,n,gf);ath=robustThreshold(av,n,af);}
    if(scount<3||!finiteF(th)||!finiteF(ath))continue;
    const uint32_t pidx=scount-2,pridx=scount-3,nxidx=scount-1;const SignalSample pc{recT(r),sigG[pidx%STEP_THRESHOLD_WINDOW_RAW],sigA[pidx%STEP_THRESHOLD_WINDOW_RAW]};const SignalSample pr{recT(r)-1.0f/RAW_HZ,sigG[pridx%STEP_THRESHOLD_WINDOW_RAW],sigA[pridx%STEP_THRESHOLD_WINDOW_RAW]};const SignalSample nx{recT(r),sigG[nxidx%STEP_THRESHOLD_WINDOW_RAW],sigA[nxidx%STEP_THRESHOLD_WINDOW_RAW]};
    // pc is one successful sample behind the current record. The time for the peak must use the actual record at pidx.
    RawRecord rp; if(pidx<total && readSessionRecord(f,pidx,rp)){} else continue;
    const float pt=recT(rp);if(!isProtocolWalkTime(pt-gSessionFirstT))continue;if(nRaw>0&&pt-out[nRaw-1].t<STEP_REFRACTORY_SEC)continue;
    const float pg=sigG[pidx%STEP_THRESHOLD_WINDOW_RAW],pp=sigG[pridx%STEP_THRESHOLD_WINDOW_RAW],pn=sigG[nxidx%STEP_THRESHOLD_WINDOW_RAW],pa=sigA[pidx%STEP_THRESHOLD_WINDOW_RAW];
    if(!(pg>=th&&pg>=pp&&pg>pn))continue;
    const float gs=clampF(pg/(th*1.45f),0,1),as=clampF(pa/(fmaxSafe(ath,0.01f)*1.8f),0,1);const float score=0.70f*gs+0.30f*as;
    if(score>=STEP_SIGNAL_MIN_SCORE&&nRaw<maxOut){Event e{};e.t=pt;e.conf=score;e.finalConfidence=score;e.signalScore=score;e.localEvidence=NAN;e.source=2;e.tcnValidated=false;e.recovered=false;e.validForCadence=true;out[nRaw++]=e;}
  }
  return nRaw;
}
static bool acceptFinalCandidate(const Event &c,float tcnProb,float &score){
  const float tcn=finiteF(tcnProb)?tcnProb:0.0f;score=0.30f*c.signalScore+0.35f*c.waveletScore+0.35f*tcn;
  return c.signalScore>=STEP_SIGNAL_MIN_SCORE&&c.waveletScore>=STEP_WAVELET_MIN_SCORE&&(tcn>=STEP_TCN_MIN_PROB||(c.signalScore>=0.62f&&c.waveletScore>=0.35f))&&score>=0.35f;
}
#if IMU_TCN_MODEL_AVAILABLE
static bool runTCNValidationAt(File &f,float centerT,float &icProb,float &icTime,float &fcProb,float &fcTime){
  icProb=0;fcProb=0;icTime=NAN;fcTime=NAN;if(gTcnRuntimeFault)return false;if(!makeSessionModelInput(f,centerT))return false;
  if(!runTCNExact(gTcnInput,gTcnICProb,gTcnFCProb))return false;
  const float startT=centerT-1.0f;
  for(int i=0;i<MODEL_SAMPLES;i++){const float tt=startT+i/(float)MODEL_HZ;if(fabsf(tt-centerT)<=TCN_MATCH_SEC&&gTcnICProb[i]>icProb){icProb=gTcnICProb[i];icTime=tt;}if(tt>centerT+0.04f&&tt<=centerT+TCN_FC_LOOKAHEAD_SEC&&gTcnFCProb[i]>fcProb){fcProb=gTcnFCProb[i];fcTime=tt;}}
  return true;
}
#endif
static void retrospectiveReconcile(){
  gFinalizationInProgress=true;gFinalizationReady=false;gFinalEventCount=0;gFinalStepCount=0;gFinalTcnValidated=0;gFinalTcnTotal=0;gFinalWaveletConfirmed=0;gTcnICCount=0;gTcnFCCount=0;
  File f=LittleFS.open(SESSION_FILE,FILE_READ);
  if(!f||gFlashIncomplete){Serial.println("FINAL | ERROR | session file unavailable/incomplete");if(f)f.close();gFinalizationMessage="Session storage unavailable or incomplete.";gFinalizationReady=true;gFinalizationInProgress=false;return;}
  Serial.println("FINAL | Stage 1/4 | exact reference signal candidate scan + wavelet confirmation");
  const int nCand=detectCandidatesOffline(f,gFinalWorkB,FINAL_MAX_CANDIDATES);int confirmed=0;
  for(int i=0;i<nCand;i++){float ws,wf;waveletConfirmFromFile(f,gFinalWorkB[i].t,ws,wf);gFinalWorkB[i].waveletScore=ws;gFinalWorkB[i].waveletFreq=wf;if(finiteF(ws)&&ws>=STEP_WAVELET_MIN_SCORE)confirmed++;}
  // Match JS post-wavelet refractory filtering.
  int nConf=0;for(int i=0;i<nCand;i++){Event e=gFinalWorkB[i];if(!finiteF(e.waveletScore)||e.waveletScore<STEP_WAVELET_MIN_SCORE)continue;if(nConf==0||e.t-gFinalWorkB[nConf-1].t>=STEP_REFRACTORY_SEC)gFinalWorkB[nConf++]=e;else if(e.signalScore+e.waveletScore>gFinalWorkB[nConf-1].signalScore+gFinalWorkB[nConf-1].waveletScore)gFinalWorkB[nConf-1]=e;}
  Serial.printf("FINAL | candidates=%d waveletConfirmed=%d\n",nCand,nConf);
  Serial.println("FINAL | Stage 2/4 | TCN validation + exact acceptance rule");
  int acceptedN=0;
  for(int i=0;i<nConf;i++){
    Event c=gFinalWorkB[i];gFinalTcnTotal++;
    float icP=0,icT=NAN,fcP=0,fcT=NAN;bool ok=false;
#if IMU_TCN_MODEL_AVAILABLE
    ok=runTCNValidationAt(f,c.t,icP,icT,fcP,fcT);
#endif
    if(!ok){icP=NAN;fcP=NAN;}
    c.conf=icP;c.tcnValidated=finiteF(icP)&&icP>=STEP_TCN_MIN_PROB;c.tcnValidated=c.tcnValidated;c.localEvidence=NAN;c.source=2;
    if(c.tcnValidated)gFinalTcnValidated++;
    if(finiteF(fcP)&&fcP>=PEAK_HEIGHT&&finiteF(fcT)){Event fc{};fc.t=fcT;fc.conf=fcP;fc.finalConfidence=fcP;fc.source=1;fc.tcnValidated=true;fc.validForCadence=true;insertEvent(gTcnFC,gTcnFCCount,fc,FC_MIN_GAP_SEC);}
    float finalScore=0;bool accept=acceptFinalCandidate(c,icP,finalScore);
    if(accept){c.finalConfidence=finalScore;c.validForCadence=true;if(acceptedN<FINAL_MAX_CANDIDATES)gTcnIC[acceptedN++]=c;}
    if(i%4==0||i==nConf-1)Serial.printf("FINAL | TCN %d/%d | validated=%u accepted=%d\n",i+1,nConf,gFinalTcnValidated,acceptedN);
  }
  Serial.println("FINAL | Stage 3/4 | temporal dedupe + single-shank opposite-foot reconciliation");
  int nFinal=0;for(int i=0;i<acceptedN;i++){Event e=gTcnIC[i];if(nFinal==0||e.t-gTcnIC[nFinal-1].t>=STEP_MIN_WALK_GAP_SEC)gTcnIC[nFinal++]=e;else if(e.finalConfidence>gTcnIC[nFinal-1].finalConfidence)gTcnIC[nFinal-1]=e;}
  gTcnICCount=nFinal;gFinalEventCount=(uint16_t)nFinal;gFinalWaveletConfirmed=0;for(int i=0;i<nFinal;i++)if(finiteF(gTcnIC[i].waveletScore)&&gTcnIC[i].waveletScore>=STEP_WAVELET_MIN_SCORE)gFinalWaveletConfirmed++;
  int totalSteps=0,bout=0;float lastT=NAN;for(int i=0;i<nFinal;i++){const float t=gTcnIC[i].t;if(!finiteF(lastT)||t-lastT>STEP_MAX_WALK_GAP_SEC){if(bout>0)totalSteps+=(bout==1)?1:(2*bout-1);bout=0;}if(bout==0)bout=1;else bout++;lastT=t;}if(bout>0)totalSteps+=(bout==1)?1:(2*bout-1);gFinalStepCount=satU16(totalSteps);
  // gTcnFC already contains all candidate-linked FC peaks with exact 0.5 s dedupe; keep it walk-gated.
  gFinalizationMessage=String(gFinalEventCount)+" same-shank anchors reconciled; "+String(gFinalTcnValidated)+" TCN-validated; "+String(gFinalWaveletConfirmed)+" wavelet-confirmed.";
  Serial.println("FINAL | Stage 4/4 | final metrics");
  gFinalizationReady=true;computeMetrics();gParityTransferPending=true;f.close();gFinalizationInProgress=false;
  Serial.printf("FINAL | steps=%u anchors=%u TCN=%u/%u WT=%u FC=%u\n",gFinalStepCount,gFinalEventCount,gFinalTcnValidated,gFinalTcnTotal,gFinalWaveletConfirmed,gTcnFCCount);
}

// ============================ ANALYTICS ============================
#pragma pack(push,1)
struct AnalyticsPacket {
  uint16_t magic;
  uint8_t version;
  uint8_t type;       // 1 = summary
  uint16_t flags;     // bit0 finalReady, bit1 finalizing, bit2 warmupDone, bit3 flashIncomplete
  uint32_t seq;
  uint32_t sampleCount;
  uint32_t firstSeq;
  uint32_t lastSeq;
  uint32_t rawCrc32;
  uint16_t sensorMisses;
  uint16_t rawGaps;
  uint16_t liveSteps;
  uint16_t finalSteps;
  uint16_t liveAnchors;
  uint16_t finalAnchors;
  uint16_t finalFC;
  uint16_t finalTCN;
  uint16_t finalTCNTotal;
  uint16_t waveletConfirmed;
  uint16_t candidates;
  uint8_t activity;
  uint8_t phase;
  uint8_t dominantAxis;
  uint8_t reserved0;
  float sessionDurationSec;
  float protocolElapsedSec;
  float cadence;
  float stride;
  float stepInterval;
  float stance;
  float swing;
  float strideCV;
  float stancePct;
  float swingPct;
  float activeSec;
  float stationarySec;
  float transitionSec;
  float walkingExposureSec;
  float protocolActiveSec;
  float protocolStationarySec;
  float gaitFreqHz;
  float gaitFreqMeanHz;
  float gaitFreqCvPct;
  float strideFreqHz;
  float tremorRms;
  float tremorPeakHz;
  float tremorGyroPeakHz;
  float tremorGyroRms;
  float tremorBandRatio;
  float freezeIndex;
  float phasePct;
  float afoFreqHz;
  float afoPhaseDeg;
};

struct AnalyticsEventPacket {
  uint16_t magic;
  uint8_t version;
  uint8_t type;       // 2 = final event chunk
  uint32_t transferId;
  uint16_t total;
  uint16_t startIndex;
  uint8_t eventType;  // 1=IC, 2=FC
  uint8_t count;
  uint16_t reserved;
  float t[16];
  float conf[16];
};
#pragma pack(pop)
static_assert(sizeof(AnalyticsPacket) == 168, "Analytics summary must remain exactly 168 bytes");
static_assert(sizeof(AnalyticsEventPacket) == 144, "Analytics event packet must remain exactly 144 bytes");

static uint32_t gParityTransferId=0;
static volatile bool gParityTransferPending=false;
static uint32_t gLastParityRetryMs=0;
static bool gParitySending=false;

static void sendAnalytics(){
  AnalyticsPacket p{};
  p.magic=0x494D;p.version=5;p.type=1;
  p.flags=(gFinalizationReady?1:0)|(gFinalizationInProgress?2:0)|(gWarmupDone?4:0)|(gFlashIncomplete?8:0);
  p.seq=gSeq;p.sampleCount=gTotalSamples;p.firstSeq=gSessionFirstSeq;p.lastSeq=gSessionLastSeq;p.rawCrc32=rawCrcFinal();
  p.sensorMisses=satU16((int)gSensorMisses);p.rawGaps=satU16((int)gRawGaps);
  p.liveSteps=gLiveStepCount;p.finalSteps=gFinalStepCount;p.liveAnchors=gLiveTcnAnchors;p.finalAnchors=gFinalEventCount;
  p.finalFC=gTcnFCCount;p.finalTCN=gFinalTcnValidated;p.finalTCNTotal=gFinalTcnTotal;p.waveletConfirmed=gFinalWaveletConfirmed;p.candidates=satU16((int)gStepDetectorCandidates);
  p.activity=(uint8_t)gActivity;p.phase=(uint8_t)gProtocolPhase;p.dominantAxis=(uint8_t)gDominantAxis;
  p.sessionDurationSec=gSessionDurationSec;p.protocolElapsedSec=gProtocolElapsedSec;
  p.cadence=gCadence;p.stride=gStride;p.stepInterval=gStepInterval;p.stance=gStance;p.swing=gSwing;p.strideCV=gStrideCV;
  p.stancePct=gStancePct;p.swingPct=gSwingPct;p.activeSec=gActiveSec;p.stationarySec=gStationarySec;p.transitionSec=gTransitionSec;
  p.walkingExposureSec=gWalkingExposureSec;p.protocolActiveSec=gProtocolActiveSec;p.protocolStationarySec=gProtocolStationarySec;
  p.gaitFreqHz=gGaitFreqHz;p.gaitFreqMeanHz=gGaitFreqMeanHz;p.gaitFreqCvPct=gGaitFreqCvPct;p.strideFreqHz=gStrideFreqHz;
  p.tremorRms=gTremorRms;p.tremorPeakHz=gTremorPeakHz;p.tremorGyroPeakHz=gTremorGyroPeakHz;p.tremorGyroRms=gTremorGyroRms;
  p.tremorBandRatio=gTremorBandRatio;p.freezeIndex=gFreezeIndex;p.phasePct=gPhasePct;p.afoFreqHz=gAfoFreqHz;p.afoPhaseDeg=gAfoPhaseDeg;
  if(gAnalyticsChar){gAnalyticsChar->setValue((uint8_t*)&p,sizeof(p));if(gClientConnected)gAnalyticsChar->notify();}
}

static void sendFinalEventChunks(uint8_t eventType,const Event *events,uint16_t total){
  if(!gAnalyticsChar||!gClientConnected||!events||total==0)return;
  const uint32_t id=++gParityTransferId;
  for(uint16_t start=0;start<total;start+=16){
    AnalyticsEventPacket p{};p.magic=0x494D;p.version=5;p.type=2;p.transferId=id;p.total=total;p.startIndex=start;p.eventType=eventType;
    const uint16_t count=min<uint16_t>(16,total-start);p.count=(uint8_t)count;
    for(uint16_t i=0;i<count;i++){p.t[i]=events[start+i].t;p.conf[i]=finiteF(events[start+i].finalConfidence)?events[start+i].finalConfidence:events[start+i].conf;}
    gAnalyticsChar->setValue((uint8_t*)&p,sizeof(p));gAnalyticsChar->notify();
    delay(12);
  }
}

static bool sendFinalParityTransfer(){
  if(!gFinalizationReady||!gClientConnected||!gAnalyticsChar||gParitySending)return false;
  gParitySending=true;
  // Snapshot the final summary first, then transmit all event chunks, then
  // repeat the immutable final summary so the phone can safely use the
  // final packet as the transfer-complete trigger.
  sendAnalytics();
  sendFinalEventChunks(1,gTcnIC,gFinalEventCount);
  sendFinalEventChunks(2,gTcnFC,gTcnFCCount);
  sendAnalytics();
  gParitySending=false;gParityTransferPending=false;return true;
}

static void printAnalytics(){
  Serial.printf("AN seq=%lu phase=%s activity=%s live=%u final=%u TCN=%u/%u WT=%u cand=%lu cadence=%.2f stride=%.3f stance=%.3f swing=%.3f CV=%.2f active=%.2f stationary=%.2f gait=%.3fHz tremor=%.2fHz freeze=%.3f samples=%lu miss=%lu\n",
    (unsigned long)gSeq,phaseName(gProtocolPhase),activityName(gActivity),gLiveStepCount,gFinalStepCount,gFinalTcnValidated,gFinalTcnTotal,gFinalWaveletConfirmed,(unsigned long)gStepDetectorCandidates,gCadence,gStride,gStance,gSwing,gStrideCV,gActiveSec,gStationarySec,gGaitFreqHz,gTremorPeakHz,gFreezeIndex,(unsigned long)gTotalSamples,(unsigned long)gSensorMisses);
}

// ============================ BLE CALLBACKS ============================
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*,NimBLEConnInfo&) override {gClientConnected=true;Serial.println("BLE CONNECTED");}
  void onDisconnect(NimBLEServer*,NimBLEConnInfo&,int reason) override {gClientConnected=false;Serial.printf("BLE DISCONNECTED reason=%d\n",reason);NimBLEDevice::startAdvertising();}
};
class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c,NimBLEConnInfo&) override {
    std::string cmd=c->getValue();
    while(!cmd.empty()&&(cmd.back()=='\0'||cmd.back()=='\n'||cmd.back()=='\r'||cmd.back()==' '||cmd.back()=='\t'))cmd.pop_back();
    if(cmd=="START"){
      if(gFinalizationInProgress||!gStorageWriterDone){Serial.println("CMD START REJECTED | finalization/storage busy");return;}
      if(!gFlashReady){Serial.println("CMD START REJECTED | LittleFS unavailable");return;}
      gAcquiring=false;delay(10);resetAnalyticsState();
      if(!startStorage()){Serial.println("CMD START REJECTED | flash session start failed");return;}
      gStopRequested=false;gSamplingStopped=false;gAcquiring=true;Serial.println("CMD START | onboard TCN+WT+AFO+analytics + raw BLE");
    }else if(cmd=="STOP"){
      if(!gAcquiring)return;gAcquiring=false;gStopRequested=true;Serial.println("CMD STOP | finalization queued");
    }else if(cmd=="PING"){
      c->setValue("PONG");if(gClientConnected)c->notify();
    }else Serial.printf("UNKNOWN CMD: %s\n",cmd.c_str());
  }
};
static void setupBLE(){
  Serial.println("BLE INIT | starting NimBLE...");

  NimBLEDevice::init(DEVICE_NAME);
  NimBLEDevice::setMTU(247);

  gServer=NimBLEDevice::createServer();
  gServer->setCallbacks(new ServerCallbacks());

  NimBLEService *svc=gServer->createService(SERVICE_UUID);

  gDataChar=svc->createCharacteristic(
    DATA_UUID,
    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY
  );

  gCmdChar=svc->createCharacteristic(
    CMD_UUID,
    NIMBLE_PROPERTY::WRITE |
    NIMBLE_PROPERTY::WRITE_NR |
    NIMBLE_PROPERTY::NOTIFY
  );

  gAnalyticsChar=svc->createCharacteristic(
    ANALYTICS_UUID,
    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY
  );

  gCmdChar->setCallbacks(new CommandCallbacks());
  svc->start();

  NimBLEAdvertising *adv=NimBLEDevice::getAdvertising();

  // Keep the broadcast payload deliberately simple so the device name is
  // reliably visible to Android/nRF Connect. The GATT service/characteristics
  // remain unchanged and are discovered after connection.
  adv->setName(DEVICE_NAME);
  adv->enableScanResponse(true);
  adv->setConnectableMode(BLE_GAP_CONN_MODE_UND);
  adv->setDiscoverableMode(BLE_GAP_DISC_MODE_GEN);

  const bool started=adv->start();

  Serial.printf(
    "BLE ADVERTISING | start=%s | isAdvertising=%s | name=%s\n",
    started?"OK":"FAIL",
    adv->isAdvertising()?"YES":"NO",
    DEVICE_NAME
  );

  if(!started || !adv->isAdvertising()){
    Serial.println("FATAL: BLE advertising did NOT start");
  }else{
    Serial.println("BLE ADVERTISING CONFIRMED");
  }
}

// ============================ SAMPLE TASK ============================
static void sampleTask(void *){
  bool wasAcquiring=false;uint64_t sessionStartUs=0;uint64_t sampleIndex=0;
  for(;;){
    if(!gAcquiring){
      if(wasAcquiring){storageFlushCurrent();if(gPacketCount>0){notifyRawPacket();gPacketCount=0;}gSamplingStopped=true;wasAcquiring=false;}
      delay(2);continue;
    }
    if(!wasAcquiring){sessionStartUs=(uint64_t)esp_timer_get_time();sampleIndex=0;wasAcquiring=true;gSamplingStopped=false;}
    const uint64_t target=sessionStartUs+(sampleIndex*1000000ULL)/(uint64_t)RAW_HZ;sampleIndex++;
    for(;;){const int64_t rem=(int64_t)target-(int64_t)esp_timer_get_time();if(rem<=0)break;if(rem>100)delayMicroseconds((uint32_t)min<int64_t>(rem-40,1000));else taskYIELD();}
    const uint32_t scheduledSeq=gSeq++;
    RawRecord r{};bool ok=false;for(int retry=0;retry<6&&!ok;retry++){ok=sensorReadRaw(r);if(!ok)delayMicroseconds(120);}
    if(!ok){gSensorMisses++;gRawGaps++;continue;}
    r.seq=scheduledSeq;
    rawCrcUpdate(r);
    if(gTotalSamples==0)gSessionFirstSeq=r.seq;
    gSessionLastSeq=r.seq;
    gTotalSamples++;
    if(gTotalSamples>SESSION_RAW_LIMIT){Serial.println("SESSION LIMIT reached; requesting automatic STOP");gAcquiring=false;gStopRequested=true;continue;}
    ringPush(r);
    appendRawPacket(r);
    storageEnqueueRecord(r);
    const PhysSample p=toPhys(r);
    if(!finiteF(gSessionFirstT))gSessionFirstT=p.t;
    const float elapsed=p.t-gSessionFirstT;

    const ProtocolId ph=protocolAt(elapsed);
    if(!gWarmupDone){
      if(ph==PH_BASELINE_WALK&&gNormCount<WARMUP_RAW){
        for(int c=0;c<6;c++){const double scale=(c<3)?ACC_G_PER_LSB:GYRO_DPS_PER_LSB;const double v=(double)(c==0?r.ax:c==1?r.ay:c==2?r.az:c==3?r.gx:c==4?r.gy:r.gz)*scale;gNormSum[c]+=v;gNormSq[c]+=v*v;}
        gNormCount++;
      }
      // The 10 s baseline is time-bounded. A handful of sensor-read misses
      // must not make a valid baseline impossible by demanding exactly 2080
      // successful reads. Finalize on the first WALK_MAIN sample using the
      // received baseline samples, provided >=90% were obtained.
      if((ph==PH_WALK_MAIN || elapsed>=17.80f) && gNormCount>=WARMUP_MIN_RAW){
        const double nWarm=(double)gNormCount;
        for(int c=0;c<6;c++){const double mu=gNormSum[c]/nWarm;double vv=gNormSq[c]/nWarm-mu*mu;if(vv<1e-16)vv=1e-16;gMean[c]=(float)mu;gStd[c]=(float)sqrt(vv);if(gStd[c]<1e-8f)gStd[c]=1.0f;}
        const int nBase=min<int>((int)gRingCount,(int)gNormCount);gWalkProfile=profileFromRecentRing(nBase);gWarmupDone=true;gDominantAxis=dominantAxisRecent();Serial.printf("WARMUP READY | normalization locked | received=%lu/%d min=%d gaps=%lu | dominant gyro axis=%d\n",(unsigned long)gNormCount,WARMUP_RAW,WARMUP_MIN_RAW,(unsigned long)gRawGaps,gDominantAxis);
      }
    }
    static uint32_t lastWarmupDiagSec=0xFFFFFFFFUL;
    const uint32_t warmupDiagSec=(uint32_t)elapsed;
    if(!gWarmupDone&&elapsed>=8.0f&&warmupDiagSec!=lastWarmupDiagSec){
      lastWarmupDiagSec=warmupDiagSec;
      Serial.printf("WARMUP PROGRESS | elapsed=%.1f s received=%lu/%d min=%d sensorMiss=%lu readyTimeout=%lu\n",
        elapsed,(unsigned long)gNormCount,WARMUP_RAW,WARMUP_MIN_RAW,
        (unsigned long)gSensorMisses,(unsigned long)gSensorReadyTimeouts);
    }
    if(elapsed>=8.0f&&!gStaticProfileLocked&&gRingCount>=ACTIVITY_WINDOW_RAW){
      const uint32_t gcCalib=gRingCount;const int nCalib=(int)min<uint32_t>(gcCalib,(uint32_t)STATIC_RAW);gStaticProfile=profileFromRecentRing(nCalib);gStaticProfileLocked=true;gDominantAxis=dominantAxisRecent();Serial.printf("STATIC PROFILE READY | gyro=%.3f accStd=%.5f gyroRange=%.3f axis=%d\n",gStaticProfile.gyroRms,gStaticProfile.accStd,gStaticProfile.gyroRange,gDominantAxis);
    }
    if(gWarmupDone){stepDetectorPush(p);updateAFO(p.t,NAN);}
  }
}

// ============================ ANALYSIS TASK ============================
static void finishStopAccounting(){
  if(gSessionFirstT==gSessionFirstT&&gRingCount){RawRecord latest;ringSnapshotRaw(&latest,1);gSessionDurationSec=recT(latest)-gSessionFirstT;}
  updateProtocolState();updateActivity();updateSpectrum();computeMetrics();
}
static void handleStopFinalization(){
  if(!gStopRequested||gFinalizationInProgress)return;
  gFinalizationInProgress=true;
  while(!gSamplingStopped)delay(2);
  while(!gStorageWriterDone)delay(5);
  finishStopAccounting();
  retrospectiveReconcile();
  gStopRequested=false;
  gParityTransferPending=true;
  sendFinalParityTransfer();
}
static void analysisTask(void *){
  for(;;){
    vTaskDelay(pdMS_TO_TICKS(50));

    if(gAcquiring){
      updateProtocolState();
      servicePendingCandidates(
        finiteF(gSessionFirstT)&&gRingCount
          ? recT(gRawRing[(gRingWrite-1)%RAW_RING_CAP])
          : 0
      );

      if(gWarmupDone && gTotalSamples-gLastAnalysisSeq>=52){
        gLastAnalysisSeq=gTotalSamples;
        gDominantAxis=dominantAxisRecent();
        updateSignalQuality();
        updateActivity();
        updateSpectrum();
        runLiveTCN();
        computeMetrics();
      }

      if(millis()-gLastReportMs>=1000){
        gLastReportMs=millis();
        printAnalytics();
        sendAnalytics();
      }
    }else if(gStopRequested){
      handleStopFinalization();
    }

    if(gFinalizationReady&&gParityTransferPending&&gClientConnected&&millis()-gLastParityRetryMs>=1000){
      gLastParityRetryMs=millis();sendFinalParityTransfer();
    }

    // Runtime task-stack telemetry.  ESP-IDF's ESP32 port reports the
    // high-water mark in bytes; smaller values mean the task came closer to
    // exhausting its allocated stack.
    if(millis()-gLastStackDiagMs>=3000){
      gLastStackDiagMs=millis();
      const unsigned sampleHwm=gSampleTaskHandle
        ? (unsigned)uxTaskGetStackHighWaterMark(gSampleTaskHandle) : 0U;
      const unsigned flashHwm=gFlashTaskHandle
        ? (unsigned)uxTaskGetStackHighWaterMark(gFlashTaskHandle) : 0U;
      const unsigned analysisHwm=gAnalysisTaskHandle
        ? (unsigned)uxTaskGetStackHighWaterMark(gAnalysisTaskHandle) : 0U;
      Serial.printf(
        "STACK HWM | sample=%u flash=%u analysis=%u bytes | sensorMiss=%lu readyTimeout=%lu\n",
        sampleHwm,flashHwm,analysisHwm,(unsigned long)gSensorMisses,(unsigned long)gSensorReadyTimeouts
      );
    }
  }
}

// ============================ SETUP / LOOP ============================
void setup(){
  Serial.begin(115200);delay(300);
  Serial.println();Serial.println("========================================================");Serial.println(" VSPIMU V5.8 | ESP32 NODEMCU ONBOARD");Serial.println(" 208 Hz raw + TCN + WT + AFO + full-session analytics");Serial.println("========================================================");
  Serial.printf("I2C SDA=%d SCL=%d @ %lu Hz | ODR=%d Hz\n",SDA_PIN,SCL_PIN,(unsigned long)I2C_HZ,RAW_HZ);
#if IMU_TCN_MODEL_AVAILABLE
  Serial.println("TCN_MODEL=ON | using generated verified header API");
#ifdef GAIT_TCN_MODEL_SHA256
  Serial.printf("TCN_MODEL_SHA256=%s\n",GAIT_TCN_MODEL_SHA256);
#endif
#else
  Serial.println("TCN_MODEL=OFF");
#endif

  Wire.begin(SDA_PIN,SCL_PIN,I2C_HZ);Wire.setTimeOut(4);
  if(!sensorInit()){Serial.println("FATAL: LSM6DSO init failed | check 0x6B SDA=21 SCL=22");while(true)delay(1000);}
  Serial.println("LSM6DSO READY | 208 Hz | +/-4g | +/-2000 dps");

  gFlashReady=LittleFS.begin(true);
  if(gFlashReady && LittleFS.totalBytes()<450000UL){Serial.printf("WARNING: LittleFS partition too small (%lu bytes) | need >=450000\n",(unsigned long)LittleFS.totalBytes());gFlashReady=false;}
  if(!gFlashReady)Serial.println("WARNING: LittleFS unavailable | final retrospective scan unavailable");
  else Serial.printf("LittleFS READY | total=%lu used=%lu\n",(unsigned long)LittleFS.totalBytes(),(unsigned long)LittleFS.usedBytes());

  if(!allocateRuntimeBuffers())while(true)delay(1000);
  Serial.printf("Runtime buffers READY | free heap=%u bytes\n",(unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT));
  gFreeQ=xQueueCreate(FLASH_BLOCK_COUNT,sizeof(uint8_t));gReadyQ=xQueueCreate(FLASH_BLOCK_COUNT,sizeof(uint8_t));
  gStorageWriterDone=true;resetAnalyticsState();
#if IMU_TCN_MODEL_AVAILABLE
  Serial.printf("TCN WORKSPACE REQUIRED | %u bytes | header allocator=PSRAM->IRAM_8BIT->INTERNAL_8BIT\n",
                (unsigned)vspimu_tcn::workspaceBytes());
  Serial.printf("TCN HEAP BEFORE WORKSPACE | free=%u largest=%u bytes\n",
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
  if(!allocateTcnWorkspace()){
    gTcnRuntimeFault=true;
    Serial.println("TCN DISABLED | insufficient heap for native TCN workspace");
  }else{
    Serial.printf("TCN HEAP AFTER WORKSPACE | free=%u largest=%u bytes\n",
                  (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
                  (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
    gTcnRuntimeFault=!runTCNSelfTest();
    Serial.printf("TCN WORKSPACE / SELFTEST COMPLETE | free heap=%u bytes\n",(unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT));
    if(gTcnRuntimeFault)Serial.println("TCN DISABLED AT RUNTIME | self-test failed");
  }
#else
  Serial.println("TCN_MODEL=OFF | upload Colab-generated gait_tcn_model.h for native TCN");
#endif
  setupBLE();
  Serial.println("BLE READY | existing raw protocol preserved | analytics + parity stream ready");
  Serial.println("PARITY CONTRACT | summary=168B event=144B | rawCRC=CRC32/0xEDB88320 | eventTol=50ms");
  Serial.printf("HEAP AFTER BLE | free=%u largest=%u bytes\n",
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));

  // Task stacks tuned from the observed runtime failure:
  //   sample  = 3072 bytes
  //   flash   = 4096 bytes (1536 bytes overflowed at START)
  //   analysis= 4096 bytes
  // High-water diagnostics below let us tighten these further only after
  // measuring the real peak usage on the physical board.
  const BaseType_t taskSample=xTaskCreatePinnedToCore(
      sampleTask,"imu_sample",3072,nullptr,5,&gSampleTaskHandle,1);
  const BaseType_t taskFlash=xTaskCreatePinnedToCore(
      flashWriterTask,"flash_writer",4096,nullptr,1,&gFlashTaskHandle,0);
  const BaseType_t taskAnalysis=xTaskCreatePinnedToCore(
      analysisTask,"analysis",4096,nullptr,2,&gAnalysisTaskHandle,0);

  Serial.printf("TASK CREATE | sample=%s flash=%s analysis=%s\n",
                taskSample==pdPASS?"OK":"FAIL",
                taskFlash==pdPASS?"OK":"FAIL",
                taskAnalysis==pdPASS?"OK":"FAIL");
  Serial.printf("TASK STACKS | sample=3072 flash=4096 analysis=4096 bytes\n");
  Serial.printf("HEAP AFTER TASKS | free=%u largest=%u bytes\n",
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
  if(heap_caps_get_free_size(MALLOC_CAP_8BIT)<6000){
    Serial.println("WARNING: critically low free heap after task creation");
  }

  gLastStackDiagMs=millis();
  Serial.println("STACK HWM | live diagnostics enabled");
  Serial.printf("SENSOR TIMING | readyTimeout=%lu us | misses=%lu\n",
                (unsigned long)SENSOR_READY_TIMEOUT_US,(unsigned long)gSensorReadyTimeouts);
}
void loop(){
  if(gFinalizationReady&&gParityTransferPending&&gClientConnected&&millis()-gLastParityRetryMs>=1000){gLastParityRetryMs=millis();sendFinalParityTransfer();}
  if(!gAcquiring&&!gFinalizationInProgress&&millis()-gLastIdlePrintMs>=3000){gLastIdlePrintMs=millis();Serial.printf("IDLE | BLE=%s | TCN=%s | finalReady=%s | parityPending=%s | flash=%s\n",gClientConnected?"CONNECTED":"WAITING",IMU_TCN_MODEL_AVAILABLE?"ON":"OFF",gFinalizationReady?"YES":"NO",gParityTransferPending?"YES":"NO",gFlashReady?(gFlashIncomplete?"INCOMPLETE":"READY"):"OFF");}
  delay(100);
}
