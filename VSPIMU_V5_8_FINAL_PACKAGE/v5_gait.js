/*
 VSPIMU V5.8
 Published single-shank TCN + research-grade derived gait analytics.

 PRIMARY MODEL
   Romijnders et al. shank/ankle gait-event TCN
   Input: 400 x 6, 200 Hz, Acc[g] + Gyro[deg/s]
   Outputs: Initial Contact (IC), Final Contact (FC)

 DERIVED (not model outputs)
   - low-latency LIVE step count from gyro/acceleration signal detection + wavelet confirmation
   - FINAL estimated total steps from full-session retrospective reconciliation
   - TCN used only as a gait-event validator, never as the primary live counter
   - optional adaptive frequency oscillator (AFO) used only for phase/cadence support
   - true single-shank cadence correction: ~120 / stride seconds
   - stride/step-frequency
   - protocol-gated active / stationary / transition time
   - standardized user journey with explicit walking/standing/sitting phases
   - gait phase + phase sub-stage (time-normalized IC cycle)
   - IC/FC labels as heel-strike/toe-off proxies
   - mid-swing estimate
   - swing angular-velocity peak + timing
   - dominant-gyro zero-crossing count (research signal feature)
   - gait-frequency trend
   - tremor-band RMS and peak frequency
   - Freeze Index (research-only; not diagnosis)
   - acceleration/gyro signal quality and live graphs

 IMPORTANT
   This file does not diagnose disease. FOG/tremor values are research signals.
   Terrain classes (stairs/slopes/etc.) are intentionally not included yet.
*/
(function(){
  'use strict';

  const CFG = {
    RAW_HZ: 208,
    MODEL_HZ: 200,
    MODEL_SAMPLES: 400,
    RAW_WINDOW: 417,
    WARMUP_RAW: 2080,
    WARMUP_MIN_RAW: Math.floor(2080*0.90),
    INFERENCE_STEP_RAW: 104,
    PEAK_HEIGHT: 0.40,
    RECOVERY_HEIGHT: 0.32,
    PEAK_DISTANCE: 100,          // 0.50 s at 200 Hz; matches the published post-processing
    IC_MIN_GAP_SEC: 0.50,
    FC_MIN_GAP_SEC: 0.50,
    EDGE_LEFT: 40,
    COMMIT_RIGHT: 40,
    EVENT_DEDUP_SEC: 0.30,
    MIN_STRIDE_SEC: 0.40,
    MAX_STRIDE_SEC: 3.00,
    STEP_REFRACTORY_SEC: 0.55,
    STEP_MIN_WALK_GAP_SEC: 0.85,
    STEP_MAX_WALK_GAP_SEC: 3.00,
    STEP_HP_HZ: 0.45,
    STEP_LP_HZ: 4.00,
    STEP_THRESHOLD_UPDATE_SAMPLES: 16,
    STEP_THRESHOLD_WINDOW_RAW: 416,
    LIVE_SIGNAL_CAP: 416,
    STEP_WAVELET_DELAY_SEC: 0.32,
    STEP_WAVELET_LOW_HZ: 0.70,
    STEP_WAVELET_HIGH_HZ: 3.20,
    STEP_WAVELET_FREQS: [0.55,0.65,0.75,0.90,1.10,1.30,1.50,1.80,2.10,2.40,2.80,3.00],
    STEP_WAVELET_MIN_SCORE: 0.18,
    STEP_SIGNAL_MIN_SCORE: 0.25,
    STEP_INTERVAL_TOL_SEC: 0.55,
    STEP_TCN_MIN_PROB: 0.25,
    STEP_FINAL_SCORE: 0.35,
    TCN_MATCH_SEC: 0.25,
    TCN_FC_LOOKAHEAD_SEC: 0.85,
    AFO_ENABLED: true,
    AFO_MIN_HZ: 0.35,
    AFO_MAX_HZ: 2.50,
    CLEAN_AFTER_GAP: 417,

    HISTORY_RAW: 30000,         // full 123 s session (~25,584 samples) + margin
    GRAPH_RAW: 500,             // ~2.4 s visible trace
    FFT_N: 512,
    FFT_FS: 64,
    ACTIVITY_STEP_SEC: 0.5,
    ACTIVITY_WINDOW_RAW: 416,     // ~2.0 s
    SPECTRUM_STEP_SEC: 1.0,
    SPECTRUM_MIN_RAW: 1664,     // ~8 s; avoids edge-padded FFT windows
    SPECTRUM_RAW: 2080,
    TREMOR_LOW_HZ: 3.0,
    TREMOR_HIGH_HZ: 8.0,
    LOCOMOTOR_LOW_HZ: 0.5,
    LOCOMOTOR_HIGH_HZ: 3.0,

    REPORT_MIN_SEC: 45,
    REPORT_MIN_STRIDES: 4,
    FINAL_MAX_CANDIDATES: 192,
    VAR_CV_LOW: 1.1,
    VAR_CV_HIGH: 2.6,
    FOG_FI_THRESHOLD: 2.5
  };

  // Standardized journey: 123 s total. Walking phases are long enough to
  // obtain stable event/cadence estimates; stationary and sitting phases make
  // activity segmentation substantially less dependent on a heuristic alone.
  const PROTOCOL = [
    {id:'STAND_1',dur:8,label:'Stand still',instruction:'Stand upright and still. Keep the sensor leg relaxed.'},
    {id:'BASELINE_WALK',dur:10,label:'Baseline walk',instruction:'Walk at your normal comfortable pace. This builds the model normalization.'},
    {id:'WALK_MAIN',dur:50,label:'Continuous walk',instruction:'Walk naturally on a safe straight path. Turn normally at the ends; do not run.'},
    {id:'STAND_2',dur:8,label:'Stand still',instruction:'Stop and stand still. Do not deliberately move the sensor leg.'},
    {id:'SIT',dur:10,label:'Sit',instruction:'Sit down normally and remain seated and relaxed.'},
    {id:'STAND_3',dur:5,label:'Stand still',instruction:'Stand up normally, then remain still.'},
    {id:'WALK_REPEAT',dur:32,label:'Repeat walk',instruction:'Walk again at the same comfortable pace for a repeatability segment.'}
  ];
  const PROTOCOL_TOTAL_SEC=PROTOCOL.reduce((a,p)=>a+p.dur,0);
  const PROTOCOL_WALK_IDS=new Set(['BASELINE_WALK','WALK_MAIN','WALK_REPEAT']);
  const PROTOCOL_STILL_IDS=new Set(['STAND_1','STAND_2','SIT','STAND_3']);

  const state = {
    model:null,
    modelReady:false,
    running:false,
    warmupDone:false,
    warmup:[],
    staticCalib:[],
    staticProfileLocked:false,
    raw:[],                 // FULL SESSION [ax,ay,az,gx,gy,gz,seq] — retained for final reconciliation
    expectedSeq:null,
    totalSamples:0,
    cleanSamplesSinceGap:CFG.CLEAN_AFTER_GAP,
    lastInferenceRawCount:0,
    inferenceBusy:false,
    inferencePending:false,
    mean:null,
    std:null,
    ic:[],
    fc:[],
    gaps:0,
    lastStatus:'',
    reportTransferToken:0,
    liveSignalPushes:0,
    modelOutputInfo:'',
    backend:'',
    lastInferenceMs:NaN,
    lastWindowPeakIC:NaN,
    lastWindowPeakFC:NaN,
    recovery:false,
    samplesSinceStart:0,

    sessionFirstT:null,
    lastActivityT:null,
    activityCurrent:'UNKNOWN',
    activeSec:0,
    stationarySec:0,
    transitionSec:0,
    activityLastUpdateT:null,
    activityScore:NaN,
    motionRms:NaN,
    gyroRms:NaN,
    lastActivityEvalT:null,
    activityStableSince:0,
    activityCandidate:null,
    activityCandidateSince:null,
    staticProfile:{gyroRms:NaN,accStd:NaN,gyroRange:NaN,accRange:NaN},
    walkProfile:{gyroRms:NaN,accStd:NaN,periodicity:NaN,gyroRange:NaN},
    stepEstimate:0,
    stepLastUpdateT:null,
    liveStepCount:0,
    liveObservedSteps:0,
    liveInferredOppositeSteps:0,
    liveEvents:[],
    livePendingOpposite:[],
    liveLastAnchorT:null,
    liveLastAnchorPhase:'',
    liveDetectorThreshold:NaN,
    liveDetectorAccThreshold:NaN,
    liveWaveletLastScore:NaN,
    liveWaveletLastFreq:NaN,
    liveSignalLastScore:NaN,
    stepDetectorStatus:'WAITING',
    stepDetectorCandidates:0,
    finalStepCount:NaN,
    finalObservedSteps:0,
    finalEvents:[],
    finalTcnValidatedSteps:0,
    finalTcnValidationTotal:0,
    finalWaveletConfirmedSteps:0,
    finalizationReady:false,
    finalizationInProgress:false,
    finalizationMessage:'',
    finalStepMethod:'',
    tcnIc:[],
    tcnFc:[],
    afoFreqHz:NaN,
    afoPhasePct:NaN,
    afoAnchorT:null,
    afoLastT:null,
    afoOppositeEmitted:false,
    liveFilterGyro:null,
    liveFilterAcc:null,
    liveStepSignal:[],
    protocolActiveSec:0,
    protocolStationarySec:0,
    activityConfidence:NaN,
    walkingConfidence:NaN,
    stationaryConfidence:NaN,
    tremorBandRatio:NaN,

    protocolPhase:'NOT_STARTED',
    protocolElapsedSec:0,
    protocolRemainingSec:PROTOCOL_TOTAL_SEC,
    protocolInstruction:'Press START ANALYSIS to begin.',
    protocolComplete:false,
    protocolLastId:'',
    protocolWalkElapsedSec:0,
    protocolStationaryElapsedSec:0,
    activeAdherencePct:NaN,
    walkingExposureSec:0,
    stepEstimateMethod:'',
    stepRateSpectralSpm:NaN,
    stepRateEventSpm:NaN,

    gaitFreqHz:NaN,
    strideFreqHz:NaN,
    gaitFreqTrend:[],
    tremorRms:NaN,
    tremorPeakHz:NaN,
    freezeIndex:NaN,
    freezeFlag:false,
    spectralLastT:null,
    spectralQuality:'WAITING',

    dominantGyroAxis:0,
    swingPeakDps:NaN,
    swingPeakPct:NaN,
    swingZeroCrossings:NaN,
    phasePct:NaN,
    phaseName:'—',
    gaitState:'—',

    signalSaturationCount:0,
    sessionDurationSec:NaN,
    patient:{name:'',age:'',sex:'',notes:''},
    reportReady:false,
    freezeFlagWindows:0,
    freezeFlagSec:0,
    freezeFlagActive:false,
    tremorGyroPeakHz:NaN,
    tremorGyroRms:NaN,
    gaitFreqMeanHz:NaN,
    gaitFreqCvPct:NaN,
    lastGraphDraw:0,
    lastDashboardUpdate:0,
    captureTail:false,
    stopRequestedAt:0,
    parity:{
      rawCrc:0xFFFFFFFF,phoneSampleCount:0,phoneFirstSeq:null,phoneLastSeq:null,
      phoneMissingSlots:0,phoneGapEvents:0,
      espSummary:null,espIC:[],espFC:[],espICTotal:null,espFCTotal:null,
      espICReceived:0,espFCReceived:0,espTransferId:0,
      verdict:'NOT READY',hardFailures:[],numericWarnings:[],
      report:{hard:[],numeric:[],ic:null,fc:null}
    }
  };

  const $=(id)=>document.getElementById(id);
  const finite=(v)=>Number.isFinite(v);
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

  function setText(id,value){
    const el=$(id);
    if(el) el.textContent=value;
  }

  function sendToAI(obj){
    try{
      if(window.AppInventor && window.AppInventor.setWebViewString){
        window.AppInventor.setWebViewString(JSON.stringify(obj));
        return true;
      }
    }catch(e){
      console.warn(e);
    }
    return false;
  }

  // REPORT_HTML can be substantially larger than ordinary WebViewString messages.
  // Transfer it as ordered JSON chunks, then let App Inventor assemble the exact HTML
  // string before calling CustomWebView.LoadHtml(). This keeps each JS->AI message small
  // and makes the PDF handoff observable and recoverable.
  const REPORT_CHUNK_CHARS = 4500;
  const REPORT_CHUNK_DELAY_MS = 20;
  const STOP_RAW_TAIL_MS = 900;

  function sendReportInChunks(html, filename, overall){
    const reportId = 'R' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,7);
    const total = Math.max(1, Math.ceil(html.length / REPORT_CHUNK_CHARS));
    const transferToken = ++state.reportTransferToken;
    const send = (obj)=>sendToAI(obj);

    send({
      type:'REPORT_BEGIN',
      reportId,
      filename,
      overall,
      chars:html.length,
      total
    });

    for(let i=0;i<total;i++){
      const data=html.slice(i*REPORT_CHUNK_CHARS, (i+1)*REPORT_CHUNK_CHARS);
      setTimeout(()=>{
        if(transferToken!==state.reportTransferToken) return;
        send({type:'REPORT_CHUNK',reportId,index:i,total,data});
      }, (i+1)*REPORT_CHUNK_DELAY_MS);
    }

    setTimeout(()=>{
      if(transferToken!==state.reportTransferToken) return;
      send({type:'REPORT_END',reportId,total,chars:html.length});
    }, (total+1)*REPORT_CHUNK_DELAY_MS);

    return {reportId,total};
  }

  function setStatus(status,detail,cls){
    setText('status',status);
    const el=$('status');
    if(el) el.className='value '+(cls||'');
    setText('detail',detail||'');
    const key=status+'|'+(detail||'');
    if(key!==state.lastStatus){
      state.lastStatus=key;
      sendToAI({type:'status',status,detail});
    }
  }

  function csvToNumbers(csv){
    if(Array.isArray(csv)) return csv.map(Number).filter(Number.isFinite);
    return String(csv).replace(/[\r\n]/g,'').split(',').map(s=>parseFloat(s.replace(/^"|"$/g,''))).filter(Number.isFinite);
  }

  function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN;}

  function median(a){
    if(!a.length) return NaN;
    const b=a.slice().sort((x,y)=>x-y),m=Math.floor(b.length/2);
    return b.length%2?b[m]:(b[m-1]+b[m])/2;
  }

  function std(a,m){
    if(a.length<2) return NaN;
    const mu=finite(m)?m:mean(a);
    return Math.sqrt(a.reduce((s,x)=>s+(x-mu)*(x-mu),0)/a.length);
  }

  function rms(a){
    if(!a.length) return NaN;
    return Math.sqrt(a.reduce((s,x)=>s+x*x,0)/a.length);
  }

  function computeStats(samples){
    const mu=new Array(6).fill(0),sd=new Array(6).fill(0);
    for(const s of samples) for(let c=0;c<6;c++) mu[c]+=s[c];
    for(let c=0;c<6;c++) mu[c]/=samples.length;
    for(const s of samples) for(let c=0;c<6;c++){
      const d=s[c]-mu[c]; sd[c]+=d*d;
    }
    for(let c=0;c<6;c++){
      sd[c]=Math.sqrt(sd[c]/samples.length);
      if(sd[c]<1e-8) sd[c]=1;
    }
    return {mean:mu,std:sd};
  }

  function resampleTo200(raw){
    if(raw.length<CFG.RAW_WINDOW) return null;
    const src=raw.slice(raw.length-CFG.RAW_WINDOW);
    const out=new Array(CFG.MODEL_SAMPLES);
    const ratio=CFG.RAW_HZ/CFG.MODEL_HZ;
    const start=(src.length-1)-((CFG.MODEL_SAMPLES-1)*ratio);
    for(let j=0;j<CFG.MODEL_SAMPLES;j++){
      const p=start+j*ratio;
      const i0=Math.floor(p),a=p-i0;
      const s0=src[Math.max(0,Math.min(i0,src.length-1))];
      const s1=src[Math.max(0,Math.min(i0+1,src.length-1))];
      const row=new Array(6);
      for(let c=0;c<6;c++) row[c]=s0[c]+a*(s1[c]-s0[c]);
      out[j]=row;
    }
    return out;
  }

  function findPeaks(values,height,distance,left,right){
    const candidates=[];
    const end=values.length-(right||0);
    for(let i=1+(left||0);i<end-1;i++){
      const v=values[i];
      if(finite(v)&&v>=height&&v>values[i-1]&&v>=values[i+1]) candidates.push({i,v});
    }
    candidates.sort((a,b)=>b.v-a.v);
    const accepted=[];
    for(const p of candidates){
      let ok=true;
      for(const q of accepted){
        if(Math.abs(p.i-q.i)<distance){ok=false;break;}
      }
      if(ok) accepted.push(p);
    }
    accepted.sort((a,b)=>a.i-b.i);
    return accepted;
  }

    function rawWindowByTime(t0,t1){
    if(!state.raw.length||!finite(t0)||!finite(t1)||t1<t0)return[];
    const timeOf=i=>state.raw[i][6]/CFG.RAW_HZ;
    let lo=0,hi=state.raw.length-1;
    while(lo<hi){const mid=(lo+hi)>>1;if(timeOf(mid)<t0)lo=mid+1;else hi=mid;}
    const s=lo;
    lo=0;hi=state.raw.length-1;
    while(lo<hi){const mid=((lo+hi+1)>>1);if(timeOf(mid)>t1)hi=mid-1;else lo=mid;}
    const e=lo;
    return e>=s?state.raw.slice(s,e+1):[];
  }

  function localGaitEvidenceAt(t){
    if(!finite(t)||!state.raw.length)return 0;
    const arr=rawWindowByTime(t-0.85,t+0.35);
    if(arr.length<40)return 0;
    const f=featureFromSamples(arr);
    if(!f)return 0;
    const wt=walkThresholds();
    const g=clamp(f.gyroRms/Math.max(1,wt.gyro),0,2)/2;
    const a=clamp(f.accStd/Math.max(1e-5,wt.acc),0,2)/2;
    const p=clamp((f.periodicity-0.05)/Math.max(0.05,wt.periodic-0.05),0,1);
    const r=clamp(f.gyroRange/Math.max(1,wt.range),0,2)/2;
    return 0.35*p+0.30*g+0.20*a+0.15*r;
  }

  function walkingGateAt(t,deep=false){
    if(!isProtocolWalkTime(t))return false;
    if(state.activityCurrent==='WALKING'&&finite(state.walkingConfidence)&&state.walkingConfidence>=0.50)return true;
    return deep?localGaitEvidenceAt(t)>=0.48:false;
  }


  function eventAllowed(t,type,conf){
    if(!finite(t)||!finite(conf))return false;
    if(!isProtocolWalkTime(t))return false;

    // An event must be supported by local periodic shank motion. Do not use
    // the previous stable activity label as a permissive fallback: that could
    // admit a false IC for ~1 s after walking stops.
    const evidence=localGaitEvidenceAt(t);
    const threshold=type==='IC'?0.43:0.36;
    const minProb=type==='IC'?0.40:0.35;
    return evidence>=threshold&&conf>=minProb;
  }
  function insertEventSorted(list,t,conf,source,minGap,validForCadence){
    if(!finite(t)||!finite(conf))return false;
    let idx=0;
    while(idx<list.length&&list[idx].t<t)idx++;
    const neighbors=[];
    if(idx>0)neighbors.push(idx-1);
    if(idx<list.length)neighbors.push(idx);
    for(const j of neighbors){
      if(Math.abs(list[j].t-t)<minGap){
        if(conf>list[j].conf){
          list[j]={t,conf,source:source||'TCN',validForCadence:validForCadence!==false};
          list.sort((a,b)=>a.t-b.t);
          return true;
        }
        return false;
      }
    }
    list.splice(idx,0,{t,conf,source:source||'TCN',validForCadence:validForCadence!==false});
    return true;
  }

  function protocolAt(elapsed){
    const t=Math.max(0,Number(elapsed)||0);
    let acc=0;
    for(const p of PROTOCOL){
      const end=acc+p.dur;
      if(t<end) return {...p,start:acc,end};
      acc=end;
    }
    return {id:'COMPLETE',dur:0,label:'Protocol complete',instruction:'Standardized journey complete. Press STOP to finish the session.',start:PROTOCOL_TOTAL_SEC,end:PROTOCOL_TOTAL_SEC,complete:true};
  }

  function protocolElapsedFromRaw(){
    if(state.sessionFirstT===null||!state.raw.length) return 0;
    const t=state.raw[state.raw.length-1][6]/CFG.RAW_HZ;
    return Math.max(0,t-state.sessionFirstT);
  }

  function updateProtocol(){
    if(!state.running||state.sessionFirstT===null||!state.raw.length){
      return protocolAt(0);
    }
    const elapsed=protocolElapsedFromRaw();
    const ph=protocolAt(elapsed);
    state.protocolElapsedSec=elapsed;
    state.protocolRemainingSec=Math.max(0,PROTOCOL_TOTAL_SEC-elapsed);
    state.protocolPhase=ph.id;
    state.protocolInstruction=ph.instruction;
    state.protocolComplete=elapsed>=(PROTOCOL_TOTAL_SEC-1/CFG.RAW_HZ);
    state.protocolWalkElapsedSec=0;
    state.protocolStationaryElapsedSec=0;
    let cursor=0;
    for(const p of PROTOCOL){
      const used=clamp(elapsed-cursor,0,p.dur);
      if(PROTOCOL_WALK_IDS.has(p.id)) state.protocolWalkElapsedSec+=used;
      if(PROTOCOL_STILL_IDS.has(p.id)) state.protocolStationaryElapsedSec+=used;
      cursor+=p.dur;
      if(cursor>=elapsed) break;
    }
    state.activeAdherencePct=state.protocolWalkElapsedSec>0?100*state.protocolActiveSec/state.protocolWalkElapsedSec:NaN;

    if(ph.id!==state.protocolLastId){
      state.protocolLastId=ph.id;
      const prefix=state.protocolComplete?'PROTOCOL COMPLETE':`${ph.label} — ${Math.max(0,ph.end-elapsed).toFixed(0)} s remaining`;
      if(state.warmupDone) setStatus('ANALYZING',`${prefix}. ${ph.instruction}`,'ok');
      else setStatus('WARMUP',`${prefix}. ${ph.instruction}`,'warn');
    }
    renderJourney();
    return ph;
  }

  function renderJourney(){
    const ph=protocolAt(state.protocolElapsedSec);
    const pct=clamp(state.protocolElapsedSec/PROTOCOL_TOTAL_SEC*100,0,100);
    setText('journeyPhase',state.running?(ph.label):(state.protocolComplete?'Protocol complete':'READY'));
    setText('journeyInstruction',state.running?ph.instruction:'Press START ANALYSIS and follow each on-screen instruction.');
    setText('journeyTimer',state.running?`${Math.max(0,ph.end-state.protocolElapsedSec).toFixed(0)} s`:'—');
    setText('journeyProgress',`${pct.toFixed(0)}%`);
    const bar=$('journeyBar');
    if(bar)bar.style.width=`${pct}%`;
    const dot=$('journeyProtocol');
    if(dot) dot.textContent=state.protocolComplete?'COMPLETE':`${state.protocolElapsedSec.toFixed(1)} / ${PROTOCOL_TOTAL_SEC.toFixed(0)} s`;
  }

  function isProtocolWalkTime(t){
    if(state.sessionFirstT===null||!finite(t)) return false;
    const elapsed=t-state.sessionFirstT;
    if(elapsed<0) return false;
    const ph=protocolAt(elapsed);
    return PROTOCOL_WALK_IDS.has(ph.id);
  }

  function recentValidICs(){
    return state.ic
      .filter(e=>e.validForCadence!==false && isProtocolWalkTime(e.t))
      .map(e=>e.t)
      .sort((a,b)=>a-b);
  }

  function robustStrideStatistics(times){
    const raw=[];
    for(let i=1;i<times.length;i++){
      const d=times[i]-times[i-1];
      if(d>=CFG.MIN_STRIDE_SEC&&d<=CFG.MAX_STRIDE_SEC) raw.push(d);
    }
    if(!raw.length) return {stride:NaN,values:[],all:[]};
    const center=median(raw);
    const tolerance=Math.max(0.18,0.30*center);
    const clean=raw.filter(d=>Math.abs(d-center)<=tolerance);
    return {stride:median(clean),values:clean,all:raw};
  }

    function metrics(){
    const icTimes=recentValidICs();
    const robust=robustStrideStatistics(icTimes);
    const stride=robust.stride;
    const eventCadence=finite(stride)?120/stride:NaN;

    const gaitF=finite(state.gaitFreqMeanHz)?state.gaitFreqMeanHz:state.gaitFreqHz;
    const spectralCadence=finite(gaitF)?60*gaitF:NaN;

    let cadence=NaN,method='';
    if(finite(eventCadence)&&finite(spectralCadence)){
      const rel=Math.abs(eventCadence-spectralCadence)/Math.max(1,eventCadence);
      if(robust.values.length>=4&&rel<=0.15){
        cadence=0.75*eventCadence+0.25*spectralCadence;
        method='validated IC cadence + spectral cross-check';
      }else{
        cadence=eventCadence;
        method='validated IC-event cadence';
      }
    }else if(finite(eventCadence)){
      cadence=eventCadence;
      method='validated IC-event cadence';
    }else if(finite(spectralCadence)&&state.activityCurrent==='WALKING'){
      cadence=spectralCadence;
      method='spectral cadence (secondary only)';
    }

    const walkingExposureSec=Math.max(0,state.walkingExposureSec||0);
    const exposureEstimate=finite(cadence)&&walkingExposureSec>1
      ?Math.max(0,Math.round(walkingExposureSec*cadence/60)):0;

    const liveEstimate=Math.max(0,Math.round(state.liveStepCount||0));
    const finalEstimate=finite(state.finalStepCount)?Math.max(0,Math.round(state.finalStepCount)):NaN;
    const primaryEstimate=state.running?liveEstimate:(finite(finalEstimate)?finalEstimate:liveEstimate);

    const stepInterval=finite(cadence)&&cadence>0?60/cadence:NaN;
    const strideFreq=finite(stride)?1/stride:NaN;
    const gaitFreq=finite(cadence)?cadence/60:NaN;
    const cv=robust.values.length>=3
      ?std(robust.values,median(robust.values))/Math.max(1e-9,median(robust.values))*100:NaN;

    const stances=[],swings=[];
    const fcTimes=state.fc.filter(e=>e.validForCadence!==false).sort((a,b)=>a.t-b.t);
    for(let i=0;i<icTimes.length-1;i++){
      const ic1=icTimes[i],ic2=icTimes[i+1];
      let best=null;
      for(const e of fcTimes){if(e.t>ic1+0.05&&e.t<ic2){best=e;break;}}
      if(best){
        const stance=best.t-ic1,swing=ic2-best.t;
        if(stance>0.15&&stance<1.7)stances.push(stance);
        if(swing>0.15&&swing<1.7)swings.push(swing);
      }
    }
    const stance=median(stances),swing=median(swings);
    const stancePct=finite(stance)&&finite(stride)?stance/stride*100:NaN;
    const swingPct=finite(swing)&&finite(stride)?swing/stride*100:NaN;

    const confs=state.finalEvents.length
      ?state.finalEvents.slice(-20).map(e=>e.finalConfidence).filter(finite)
      :state.ic.slice(-20).map(e=>e.conf).filter(finite);

    state.stepRateEventSpm=eventCadence;
    state.stepRateSpectralSpm=spectralCadence;
    state.stepEstimateMethod=state.running?'LIVE signal+wavelet counter':(finite(finalEstimate)?state.finalStepMethod:method);
    state.stepEstimate=primaryEstimate;

    return {
      cadence,stride,stepInterval,strideFreq,gaitFreq,cv,
      stance,swing,stancePct,swingPct,
      icCount:icTimes.length,
      fcCount:state.fc.filter(e=>e.validForCadence!==false&&isProtocolWalkTime(e.t)).length,
      detectedSameFootSteps:icTimes.length,
      estimatedTotalSteps:primaryEstimate,
      liveStepCount:liveEstimate,
      finalStepCount:finalEstimate,
      liveObservedSteps:state.liveObservedSteps,
      liveInferredOppositeSteps:state.liveInferredOppositeSteps,
      finalObservedSteps:state.finalObservedSteps,
      finalTcnValidatedSteps:state.finalTcnValidatedSteps,
      finalWaveletConfirmedSteps:state.finalWaveletConfirmedSteps,
      tcnValidationCoverage:state.finalTcnValidationTotal>0?state.finalTcnValidatedSteps/state.finalTcnValidationTotal:NaN,
      confidence:confs.length?mean(confs):NaN,
      walkingSec:Math.max(0,state.activeSec),
      walkingExposureSec,
      eventCadence,spectralCadence,
      stepMethod:state.stepEstimateMethod,
      exposureStepEstimate:exposureEstimate,
      cadenceCrossCheckEstimate:exposureEstimate,
      strideSampleCount:robust.values.length,
      totalStrideIntervals:robust.all.length,
      afoFreqHz:state.afoFreqHz,
      afoPhasePct:state.afoPhasePct,
      detectorCandidates:state.stepDetectorCandidates,
      liveDetectorThreshold:state.liveDetectorThreshold,
      liveWaveletScore:state.liveWaveletLastScore,
      liveWaveletFreq:state.liveWaveletLastFreq
    };
  }


  function completedCycleRecords(){
    const rec=[];
    for(let i=0;i<state.ic.length-1;i++){
      const ic1=state.ic[i].t;
      const ic2=state.ic[i+1].t;
      if(ic2<=ic1) continue;
      let fc=null;
      for(const e of state.fc){
        if(e.t>ic1+0.05&&e.t<ic2){fc=e;break;}
      }
      rec.push({ic1,ic2,fc});
    }
    return rec;
  }

    function gaitPhase(){
    const m=metrics();
    if(!state.ic.length||!finite(m.stride))return{pct:NaN,name:'—',state:'—',midSwing:NaN};
    const now=state.raw.length?state.raw[state.raw.length-1][6]/CFG.RAW_HZ:NaN;
    const lastIC=state.ic[state.ic.length-1].t;
    if(!finite(now)||!finite(lastIC))return{pct:NaN,name:'—',state:'—',midSwing:NaN};
    if(now-lastIC>Math.max(3.2,1.6*m.stride))return{pct:NaN,name:'—',state:'—',midSwing:NaN};
    let pct=clamp((now-lastIC)/m.stride*100,0,100);
    let latestFC=null;
    for(const e of state.fc)if(e.t>lastIC){latestFC=e;break;}
    let gstate=pct<60?'STANCE':'SWING';
    if(latestFC)gstate=now<latestFC.t?'STANCE':'SWING';
    let name='Terminal swing';
    if(pct<10)name='Loading response';
    else if(pct<30)name='Mid-stance';
    else if(pct<50)name='Terminal stance';
    else if(pct<60)name='Pre-swing';
    else if(pct<70)name='Initial swing';
    else if(pct<80)name='Mid-swing';
    return{pct,name,state:gstate,midSwing:lastIC+m.stride*0.75};
  }


  function dominantGyroAxis(){
    const arr=state.raw.slice(-Math.min(state.raw.length,800));
    if(arr.length<30) return 0;
    let best=0,bestVar=-Infinity;
    for(let c=0;c<3;c++){
      const vals=arr.map(r=>r[3+c]);
      const v=std(vals);
      if(finite(v)&&v>bestVar){bestVar=v;best=c;}
    }
    return best;
  }

  function updateSwingLandmarks(){
    const rec=completedCycleRecords();
    if(!rec.length){
      state.swingPeakDps=NaN;
      state.swingPeakPct=NaN;
      state.swingZeroCrossings=NaN;
      return;
    }
    const r=rec[rec.length-1];
    if(!r.fc){
      state.swingPeakDps=NaN;
      state.swingPeakPct=NaN;
      state.swingZeroCrossings=NaN;
      return;
    }

    const axis=dominantGyroAxis();
    state.dominantGyroAxis=axis;
    const win=rawWindowByTime(r.fc.t,r.ic2);
    const g=win.map(s=>({t:s[6]/CFG.RAW_HZ,v:s[3+axis]}));
    if(g.length<5){
      state.swingPeakDps=NaN;
      state.swingPeakPct=NaN;
      state.swingZeroCrossings=NaN;
      return;
    }

    const mu=mean(g.map(x=>x.v));
    let peak=-Infinity,peakT=NaN,z=0,prev=null;
    for(const p of g){
      const av=Math.abs(p.v);
      if(av>peak){peak=av;peakT=p.t;}
      const x=p.v-mu;
      if(prev!==null && ((prev<=0&&x>0)||(prev>=0&&x<0))) z++;
      if(x!==0) prev=x;
    }
    state.swingPeakDps=peak;
    state.swingPeakPct=finite(peakT)?(peakT-r.ic1)/(r.ic2-r.ic1)*100:NaN;
    state.swingZeroCrossings=z;
  }

  function paceDescriptor(cadence){
    if(!finite(cadence)) return '—';
    if(cadence<80) return 'Low cadence';
    if(cadence<100) return 'Below 100 spm';
    if(cadence<110) return '≥100 spm heuristic';
    if(cadence<120) return 'Brisk cadence';
    if(cadence<130) return 'High cadence';
    return '≥130 spm vigorous-intensity heuristic';
  }

  function arrayRange(a){
    if(!a.length)return NaN;
    let lo=Infinity,hi=-Infinity;
    for(const x of a){if(x<lo)lo=x;if(x>hi)hi=x;}
    return hi-lo;
  }

  function percentile(a,p){
    if(!a.length)return NaN;
    const b=a.slice().sort((x,y)=>x-y);
    const idx=(b.length-1)*clamp(p,0,1);
    const lo=Math.floor(idx),hi=Math.ceil(idx);
    return lo===hi?b[lo]:b[lo]+(b[hi]-b[lo])*(idx-lo);
  }

  function autocorrPeak(values,minLag,maxLag){
    if(values.length<120)return NaN;
    const mu=mean(values);
    const x=values.map(v=>v-mu);
    const den=x.reduce((s,v)=>s+v*v,0);
    if(den<1e-9)return NaN;
    let best=-1;
    const lo=Math.max(60,Math.round(minLag||80));
    const hi=Math.min(x.length-5,Math.round(maxLag||300));
    for(let lag=lo;lag<=hi;lag++){
      let num=0;
      for(let i=0;i<x.length-lag;i++)num+=x[i]*x[i+lag];
      const r=num/den;
      if(r>best)best=r;
    }
    return clamp(best,-1,1);
  }

  function featureFromSamples(arr){
    if(arr.length<160)return null;
    const amag=arr.map(r=>Math.sqrt(r[0]*r[0]+r[1]*r[1]+r[2]*r[2]));
    const gAxes=[0,1,2].map(c=>arr.map(r=>r[3+c]));
    let axis=0,bestStd=-Infinity;
    for(let c=0;c<3;c++){
      const s=std(gAxes[c]);
      if(finite(s)&&s>bestStd){bestStd=s;axis=c;}
    }
    const g=gAxes[axis];
    const accStd=std(amag);
    const accRange=arrayRange(amag);
    const gyroRms=rms(arr.map(r=>Math.sqrt(r[3]*r[3]+r[4]*r[4]+r[5]*r[5])));
    const gyroRange=arrayRange(g);
    const periodicity=autocorrPeak(g,80,Math.min(300,g.length-10));
    return {accStd,accRange,gyroRms,gyroRange,periodicity,axis};
  }

  function profileFromSamples(samples){
    if(samples.length<CFG.ACTIVITY_WINDOW_RAW)return null;
    const feats=[];
    for(let i=0;i+CFG.ACTIVITY_WINDOW_RAW<=samples.length;i+=104){
      const f=featureFromSamples(samples.slice(i,i+CFG.ACTIVITY_WINDOW_RAW));
      if(f)feats.push(f);
    }
    if(!feats.length)return null;
    return {
      accStd:median(feats.map(f=>f.accStd).filter(finite)),
      accRange:median(feats.map(f=>f.accRange).filter(finite)),
      gyroRms:median(feats.map(f=>f.gyroRms).filter(finite)),
      gyroRange:median(feats.map(f=>f.gyroRange).filter(finite)),
      periodicity:median(feats.map(f=>f.periodicity).filter(finite))
    };
  }

  function walkThresholds(){
    const b=state.walkProfile;
    return {
      gyro:finite(b.gyroRms)?Math.max(6,0.30*b.gyroRms):10,
      acc:finite(b.accStd)?Math.max(0.008,0.30*b.accStd):0.018,
      periodic:finite(b.periodicity)?Math.max(0.20,0.65*b.periodicity):0.24,
      range:finite(b.gyroRange)?Math.max(18,0.32*b.gyroRange):28
    };
  }

  function stationaryThresholds(){
    const s=state.staticProfile,w=state.walkProfile;
    return {
      gyro:clamp(Math.max(2.5,(finite(s.gyroRms)?4*s.gyroRms:2.5),finite(w.gyroRms)?0.10*w.gyroRms:0),2.5,8),
      acc:clamp(Math.max(0.006,(finite(s.accStd)?4*s.accStd:0.006),finite(w.accStd)?0.12*w.accStd:0),0.006,0.025),
      range:clamp(Math.max(8,(finite(s.gyroRange)?3*s.gyroRange:8)),8,24),
      accRange:clamp(Math.max(0.018,(finite(s.accRange)?3*s.accRange:0.018)),0.018,0.06)
    };
  }

  function activityClass(){
    const arr=state.raw.slice(-CFG.ACTIVITY_WINDOW_RAW);
    const f=featureFromSamples(arr);
    if(!f)return {name:'WARMING',score:0,walkingConfidence:0,stationaryConfidence:0,motion:NaN,gyro:NaN,features:null};

    const wt=walkThresholds(),st=stationaryThresholds();
    const staticGyro=f.gyroRms/Math.max(0.1,st.gyro);
    const staticAcc=f.accStd/Math.max(1e-4,st.acc);
    const gyroWalk=f.gyroRms/Math.max(1,wt.gyro);
    const accWalk=f.accStd/Math.max(1e-5,wt.acc);
    const periodicity=finite(f.periodicity)?f.periodicity:0;
    const walkP=clamp((periodicity-0.15)/Math.max(0.05,wt.periodic-0.15),0,1);
    const walkG=clamp(gyroWalk/2,0,1);
    const walkA=clamp(accWalk/2,0,1);
    const walkR=clamp(f.gyroRange/Math.max(1,wt.range)/2,0,1);

    // Require both periodic gait structure and movement well above the
    // individual's measured stationary noise floor. This rejects a single
    // shake, leg repositioning, phone movement, or other small transient.
    const gaitMovementGate=
      f.gyroRms>=Math.max(8,st.gyro*3.0)&&
      f.accStd>=Math.max(0.010,st.acc*2.5)&&
      f.gyroRange>=Math.max(15,st.range*1.8)&&
      periodicity>=Math.max(0.30,wt.periodic*0.85);

    const walkingConfidence=0.40*walkP+0.25*walkG+0.20*walkA+0.15*walkR;

    const stationaryConfidence=
      0.50*clamp(1-f.gyroRms/Math.max(0.1,st.gyro),0,1)+
      0.30*clamp(1-f.accStd/Math.max(1e-4,st.acc),0,1)+
      0.10*clamp(1-f.gyroRange/Math.max(1,st.range),0,1)+
      0.10*clamp(1-f.accRange/Math.max(1e-4,st.accRange),0,1);

    let desired='TRANSITION';
    if(gaitMovementGate&&walkingConfidence>=0.58){
      desired='WALKING';
    }else if(
      stationaryConfidence>=0.74&&
      staticGyro<=1.10&&
      staticAcc<=1.15&&
      f.gyroRange<=st.range*1.25&&
      f.accRange<=st.accRange*1.25
    ){
      desired='STATIONARY';
    }

    return {
      name:desired,
      score:Math.max(walkingConfidence,stationaryConfidence),
      walkingConfidence,stationaryConfidence,
      motion:f.accStd,
      gyro:f.gyroRms,
      features:f
    };
  }
  function applyActivityState(desired,nowT){
    const current=state.activityCurrent;
    if(current==='UNKNOWN'||current==='WARMING'||current==='TRANSITION'&&state.activityCandidate===null){
      if(desired==='STATIONARY'||desired==='WALKING'){
        if(state.activityCandidate!==desired){state.activityCandidate=desired;state.activityCandidateSince=nowT;}
        const required=desired==='STATIONARY'?0.50:0.65;
        if(nowT-state.activityCandidateSince>=required){
          state.activityCurrent=desired;state.activityStableSince=nowT;state.activityCandidate=null;state.activityCandidateSince=null;
        }else state.activityCurrent='TRANSITION';
      }else state.activityCurrent='TRANSITION';
      return;
    }
    if(desired===current){state.activityCandidate=null;state.activityCandidateSince=null;return;}
    if(state.activityCandidate!==desired){state.activityCandidate=desired;state.activityCandidateSince=nowT;return;}
    const required=current==='WALKING'&&desired==='STATIONARY'?0.90:(current==='STATIONARY'&&desired==='WALKING'?0.75:0.60);
    if(finite(state.activityCandidateSince)&&nowT-state.activityCandidateSince>=required){
      state.activityCurrent=desired;
      state.activityStableSince=nowT;
      state.activityCandidate=null;state.activityCandidateSince=null;
    }
  }

  function updateActivity(){
    if(!state.running||state.raw.length<CFG.ACTIVITY_WINDOW_RAW)return;
    const currentT=state.raw[state.raw.length-1][6]/CFG.RAW_HZ;
    const ac=activityClass();
    state.activityConfidence=ac.score;
    state.walkingConfidence=ac.walkingConfidence;
    state.stationaryConfidence=ac.stationaryConfidence;
    state.motionRms=ac.motion;
    state.gyroRms=ac.gyro;

    if(state.activityLastUpdateT===null){
      state.activityLastUpdateT=currentT;
      applyActivityState(ac.name,currentT);
      return;
    }
    let dt=currentT-state.activityLastUpdateT;
    state.activityLastUpdateT=currentT;
    if(!finite(dt)||dt<=0)return;
    dt=clamp(dt,0,0.75);

    // Attribute elapsed time to the PREVIOUS stable state, then update hysteresis.
    const prior=state.activityCurrent;
    const elapsed=protocolElapsedFromRaw();
    const ph=protocolAt(elapsed);
    const walkPhase=PROTOCOL_WALK_IDS.has(ph.id);

    if(prior==='WALKING'){
      state.activeSec+=dt;
      if(walkPhase){
        state.walkingExposureSec+=dt;
        state.protocolActiveSec+=dt;
      }
      if(state.stepLastUpdateT===null) state.stepLastUpdateT=currentT-dt;
      // Do not increment the displayed step counter from generic activity.
      // Step count is event-anchored in metrics(); activity time is independent.
    }else if(prior==='STATIONARY'){
      state.stationarySec+=dt;
      if(PROTOCOL_STILL_IDS.has(ph.id))state.protocolStationarySec+=dt;
    }else{
      state.transitionSec+=dt;
    }

    applyActivityState(ac.name,currentT);
  }

  // ---------- V5.7 live step detector + wavelet confirmation ----------
  function makeOnePoleFilter(){return {hpX:0,hpY:0,lpY:0,initialized:false};}
  function filterBandpass(x,st){
    if(!finite(x))x=0;
    const dt=1/CFG.RAW_HZ;
    const hpRC=1/(2*Math.PI*CFG.STEP_HP_HZ);
    const lpRC=1/(2*Math.PI*CFG.STEP_LP_HZ);
    const ah=hpRC/(hpRC+dt);
    const al=dt/(lpRC+dt);
    if(!st.initialized){st.hpX=x;st.hpY=0;st.lpY=0;st.initialized=true;}
    const hp=ah*(st.hpY+x-st.hpX);
    const lp=st.lpY+al*(hp-st.lpY);
    st.hpX=x;st.hpY=hp;st.lpY=lp;
    return lp;
  }

  function robustThreshold(values,scaleFloor){
    const a=values.filter(finite).map(Math.abs);
    if(a.length<24)return NaN;
    const med=median(a);
    const mad=median(a.map(v=>Math.abs(v-med)));
    const q90=percentile(a,0.90);
    return Math.max(scaleFloor||1,med+0.85*Math.max(1e-6,mad),0.80*q90);
  }

  function waveletCoefficient(signal,fs,centerIndex,freq){
    if(!signal||centerIndex<0||centerIndex>=signal.length)return NaN;
    const halfSec=Math.min(0.70,Math.max(0.28,2.2/freq));
    const halfN=Math.max(8,Math.floor(halfSec*fs));
    const s=Math.max(0,centerIndex-halfN),e=Math.min(signal.length-1,centerIndex+halfN);
    if(e-s<24)return NaN;
    let mu=0,n=0;
    for(let i=s;i<=e;i++){mu+=signal[i];n++;}
    mu/=n;
    let dot=0,ex=0,ey=0;
    const sigma=1.15/freq;
    for(let i=s;i<=e;i++){
      const u=(i-centerIndex)/fs;
      const w=Math.cos(2*Math.PI*freq*u)*Math.exp(-0.5*(u/sigma)*(u/sigma));
      const y=signal[i]-mu;
      dot+=y*w;ex+=y*y;ey+=w*w;
    }
    const d=Math.sqrt(Math.max(1e-12,ex*ey));
    return d>0?Math.abs(dot)/d:NaN;
  }

  function waveletConfirmAt(t){
    const arr=rawWindowByTime(t-0.70,t+0.32);
    if(arr.length<60)return{score:NaN,freq:NaN,source:'none'};
    const g=arr.map(r=>Math.sqrt(r[3]*r[3]+r[4]*r[4]+r[5]*r[5]));
    const a=arr.map(r=>Math.abs(Math.sqrt(r[0]*r[0]+r[1]*r[1]+r[2]*r[2])-1));
    const center=arr.findIndex(r=>Math.abs(r[6]/CFG.RAW_HZ-t)<=0.5/CFG.RAW_HZ);
    if(center<0)return{score:NaN,freq:NaN,source:'none'};
    let best={score:-Infinity,freq:NaN,source:'none'};
    for(const f of CFG.STEP_WAVELET_FREQS){
      const cg=waveletCoefficient(g,CFG.RAW_HZ,center,f);
      if(finite(cg)&&cg>best.score)best={score:cg,freq:f,source:'gyro-magnitude'};
      const ca=waveletCoefficient(a,CFG.RAW_HZ,center,f);
      if(finite(ca)&&ca>best.score)best={score:ca,freq:f,source:'acceleration-magnitude'};
    }
    return best;
  }

  function detectorThresholds(){
    const arr=state.liveStepSignal.slice(-CFG.STEP_THRESHOLD_WINDOW_RAW);
    const gyroFloor=finite(state.walkProfile.gyroRange)?Math.max(5,0.10*state.walkProfile.gyroRange):8;
    const accFloor=finite(state.walkProfile.accStd)?Math.max(0.004,0.20*state.walkProfile.accStd):0.006;
    const gt=robustThreshold(arr.map(x=>x.gyro),gyroFloor);
    const at=robustThreshold(arr.map(x=>x.acc),accFloor);
    state.liveDetectorThreshold=gt;
    state.liveDetectorAccThreshold=at;
    return{gyro:gt,acc:at};
  }

  function updateAFO(t,anchorT){
    if(!CFG.AFO_ENABLED){state.afoPhasePct=NaN;return;}
    if(state.afoLastT===null)state.afoLastT=t;
    const dt=Math.max(0,t-state.afoLastT);
    if(finite(state.afoFreqHz)&&dt>0){
      state.afoPhasePct=((state.afoPhasePct||0)+dt*state.afoFreqHz*360)%360;
    }
    state.afoLastT=t;
    if(finite(anchorT)){
      if(finite(state.liveLastAnchorT)&&anchorT-state.liveLastAnchorT>=CFG.STEP_MIN_WALK_GAP_SEC&&anchorT-state.liveLastAnchorT<=CFG.STEP_MAX_WALK_GAP_SEC){
        const f=1/(anchorT-state.liveLastAnchorT);
        state.afoFreqHz=finite(state.afoFreqHz)
          ?0.82*state.afoFreqHz+0.18*clamp(f,CFG.AFO_MIN_HZ,CFG.AFO_MAX_HZ)
          :clamp(f,CFG.AFO_MIN_HZ,CFG.AFO_MAX_HZ);
      }
      state.afoAnchorT=anchorT;
      state.afoPhasePct=0;
      state.afoOppositeEmitted=false;
    }
  }

  function liveOppositeService(t){
    if(!state.running)return;
    const gateNow=walkingGateAt(t,false);
    if(!gateNow){
      if(state.livePendingOpposite.length)state.livePendingOpposite=[];
      state.afoOppositeEmitted=true;
      state.liveStepCount=state.liveObservedSteps+state.liveInferredOppositeSteps;
      return;
    }
    while(state.livePendingOpposite.length&&state.livePendingOpposite[0].t<=t){
      const p=state.livePendingOpposite.shift();
      if(walkingGateAt(p.t,true)){state.liveInferredOppositeSteps++;state.liveInferredOppositeTimes.push(p.t);if(state.liveInferredOppositeTimes.length>300)state.liveInferredOppositeTimes.shift();state.stepDetectorStatus='LIVE OPPOSITE-FOOT ESTIMATE';}
    }
    state.liveStepCount=state.liveObservedSteps+state.liveInferredOppositeSteps;
  }

  function registerLiveAnchor(c){
    const t=c.t;
    liveOppositeService(t);
    const prev=state.liveEvents[state.liveEvents.length-1];
    if(prev&&isProtocolWalkTime(prev.t)&&isProtocolWalkTime(t)){
      const d=t-prev.t;
      if(d>=CFG.STEP_MIN_WALK_GAP_SEC&&d<=CFG.STEP_MAX_WALK_GAP_SEC){
        // This same-shank interval contains one contralateral step.  Count it
        // now if its midpoint was not already predicted by the optional AFO.
        const midpoint=prev.t+d/2;
        const already=state.liveInferredOppositeTimes.some(x=>Math.abs(x-midpoint)<0.18);
        if(!already&&walkingGateAt(midpoint,true)){state.liveInferredOppositeSteps++;state.liveInferredOppositeTimes.push(midpoint);if(state.liveInferredOppositeTimes.length>300)state.liveInferredOppositeTimes.shift();}
        updateAFO(t,t);
        state.livePendingOpposite=[];
        // AFO is now allowed to predict the next contralateral midpoint; the
        // oscillator itself never creates a step without the walking gate.
        if(CFG.AFO_ENABLED&&finite(state.afoFreqHz)&&state.afoFreqHz>0){
          state.livePendingOpposite.push({t:t+0.5/state.afoFreqHz,from:t,to:t+1/state.afoFreqHz,predicted:true});
        }
      }else if(d>CFG.STEP_MAX_WALK_GAP_SEC){
        state.livePendingOpposite=[];state.afoFreqHz=NaN;updateAFO(t,t);
      }else{
        state.livePendingOpposite=[];
      }
    }else{
      state.livePendingOpposite=[];updateAFO(t,t);
      if(CFG.AFO_ENABLED&&finite(state.afoFreqHz)&&state.afoFreqHz>0){
        state.livePendingOpposite.push({t:t+0.5/state.afoFreqHz,from:t,to:t+1/state.afoFreqHz,predicted:true});
      }
    }
    state.liveEvents.push(c);
    if(state.liveEvents.length>300)state.liveEvents.shift();
    state.liveObservedSteps++;
    state.liveLastAnchorT=t;
    state.ic=state.liveEvents.map(e=>({t:e.t,conf:finite(e.tcnProb)?e.tcnProb:e.waveletScore,source:e.tcnProb?'LIVE+WAVELET+TCN':'LIVE+WAVELET',validForCadence:true,signalScore:e.signalScore,waveletScore:e.waveletScore,tcnValidated:finite(e.tcnProb)&&e.tcnProb>=CFG.STEP_TCN_MIN_PROB,tcnProb:e.tcnProb}));
    state.liveStepCount=state.liveObservedSteps+state.liveInferredOppositeSteps;
    state.stepEstimate=state.liveStepCount;
    state.stepDetectorStatus='LIVE CONFIRMED';
  }

  function finalizeLiveCandidate(c,tNow){
    const w=waveletConfirmAt(c.t);
    state.liveWaveletLastScore=w.score;
    state.liveWaveletLastFreq=w.freq;
    const t=finite(c.tcnProb)?c.tcnProb:NaN;
    const signalOk=c.signalScore>=CFG.STEP_SIGNAL_MIN_SCORE;
    const waveOk=finite(w.score)&&w.score>=CFG.STEP_WAVELET_MIN_SCORE;
    if(!signalOk||!waveOk)return false;
    c.waveletScore=w.score;c.waveletFreq=w.freq;c.waveletSource=w.source;
    c.tcnValidated=finite(t)&&t>=CFG.STEP_TCN_MIN_PROB;
    // Live counter does not wait for the TCN. TCN only attaches validation later.
    if(!state.liveEvents.length||c.t-state.liveEvents[state.liveEvents.length-1].t>=CFG.STEP_REFRACTORY_SEC){
      registerLiveAnchor(c);return true;
    }
    return false;
  }

  function stepDetectorPush(t,row){
    if(!state.running)return;
    if(!state.liveFilterGyro)state.liveFilterGyro=[makeOnePoleFilter(),makeOnePoleFilter(),makeOnePoleFilter()];
    if(!state.liveFilterAcc)state.liveFilterAcc=makeOnePoleFilter();
    const axis=clamp(state.dominantGyroAxis|0,0,2);
    const gv=[];
    for(let i=0;i<3;i++)gv[i]=filterBandpass(row[3+i],state.liveFilterGyro[i]);
    const gyro=Math.abs(gv[axis]);
    const am=Math.sqrt(row[0]*row[0]+row[1]*row[1]+row[2]*row[2]);
    const acc=Math.abs(filterBandpass(am-1,state.liveFilterAcc));
    state.liveStepSignal.push({t,gyro,acc});
    if(state.liveStepSignal.length>CFG.LIVE_SIGNAL_CAP)state.liveStepSignal.shift();
    state.liveSignalPushes++;
    if(state.liveSignalPushes>=CFG.STEP_THRESHOLD_UPDATE_SAMPLES && state.liveSignalPushes%CFG.STEP_THRESHOLD_UPDATE_SAMPLES===0)detectorThresholds();
    liveOppositeService(t);

    const n=state.liveStepSignal.length;
    if(n<3)return;
    const p=state.liveStepSignal[n-2],pr=state.liveStepSignal[n-3],nx=state.liveStepSignal[n-1];
    const th=state.liveDetectorThreshold,at=state.liveDetectorAccThreshold;
    if(!finite(th)||!finite(at)||!walkingGateAt(p.t,true)){
      state.stepDetectorStatus=isProtocolWalkTime(p.t)?'WAITING FOR WALK GATE':'GATED';
      return;
    }
    if(p.t-(state.liveEvents.at(-1)?.t||-Infinity)<CFG.STEP_REFRACTORY_SEC)return;
    const isPeak=p.gyro>=th&&p.gyro>=pr.gyro&&p.gyro>nx.gyro;
    if(!isPeak)return;
    const gs=clamp(p.gyro/(th*1.45),0,1);
    const as=clamp(p.acc/(Math.max(at,0.01)*1.8),0,1);
    const signalScore=0.70*gs+0.30*as;
    state.stepDetectorCandidates++;
    state.liveSignalLastScore=signalScore;
    const cand={t:p.t,signalScore};
    state.livePendingStepCandidates=(state.livePendingStepCandidates||[]);
    state.livePendingStepCandidates.push(cand);
    while(state.livePendingStepCandidates.length&&t-state.livePendingStepCandidates[0].t>=CFG.STEP_WAVELET_DELAY_SEC){
      const c=state.livePendingStepCandidates.shift();
      if(finalizeLiveCandidate(c,t))break;
    }
  }

  function detectCandidatesOffline(){
    const out=[];
    if(state.raw.length<CFG.ACTIVITY_WINDOW_RAW)return out;
    const axis=dominantGyroAxis();
    const fg=[makeOnePoleFilter(),makeOnePoleFilter(),makeOnePoleFilter()];
    const fa=makeOnePoleFilter();
    const sig=[];
    let threshold=NaN,accThreshold=NaN;
    for(let i=0;i<state.raw.length;i++){
      const r=state.raw[i],t=r[6]/CFG.RAW_HZ;
      const gv=filterBandpass(r[3+axis],fg[axis]);
      const gyro=Math.abs(gv);
      const am=Math.sqrt(r[0]*r[0]+r[1]*r[1]+r[2]*r[2]);
      const acc=Math.abs(filterBandpass(am-1,fa));
      sig.push({t,gyro,acc});
      if(sig.length%CFG.STEP_THRESHOLD_UPDATE_SAMPLES===0){
        const win=sig.slice(-CFG.STEP_THRESHOLD_WINDOW_RAW);
        threshold=robustThreshold(win.map(x=>x.gyro),finite(state.walkProfile.gyroRange)?Math.max(5,0.10*state.walkProfile.gyroRange):8);
        accThreshold=robustThreshold(win.map(x=>x.acc),finite(state.walkProfile.accStd)?Math.max(0.004,0.20*state.walkProfile.accStd):0.006);
      }
      if(i<2||!finite(threshold))continue;
      const p=sig[i-1],pr=sig[i-2],nx=sig[i];
      if(!isProtocolWalkTime(p.t))continue;
      if(p.t-(out.at(-1)?.t||-Infinity)<CFG.STEP_REFRACTORY_SEC)continue;
      if(!(p.gyro>=threshold&&p.gyro>=pr.gyro&&p.gyro>nx.gyro))continue;
      const gs=clamp(p.gyro/(threshold*1.45),0,1);
      const as=clamp(p.acc/(Math.max(accThreshold,0.01)*1.8),0,1);
      const signalScore=0.70*gs+0.30*as;
      if(signalScore<CFG.STEP_SIGNAL_MIN_SCORE)continue;
      out.push({t:p.t,signalScore});
    }
    // Wavelet confirmation and interval consistency happen after candidate generation.
    const confirmed=[];
    for(const c of out.slice(0,CFG.FINAL_MAX_CANDIDATES)){
      const w=waveletConfirmAt(c.t);
      if(finite(w.score)&&w.score>=CFG.STEP_WAVELET_MIN_SCORE){
        c.waveletScore=w.score;c.waveletFreq=w.freq;c.waveletSource=w.source;confirmed.push(c);
      }
    }
    confirmed.sort((a,b)=>a.t-b.t);
    const ded=[];
    for(const c of confirmed){
      const prev=ded.at(-1);
      if(prev&&c.t-prev.t<CFG.STEP_REFRACTORY_SEC){
        if((c.signalScore+c.waveletScore)>(prev.signalScore+prev.waveletScore))ded[ded.length-1]=c;
      }else ded.push(c);
    }
    return ded;
  }

  function nearestTCNEvent(list,t,maxGap){
    let best=null,bestD=Infinity;
    for(const e of list){const d=Math.abs(e.t-t);if(d<=maxGap&&d<bestD){best=e;bestD=d;}}
    return best;
  }

  function modelWindowCenteredAt(centerT){
    const startT=centerT-1.0,endT=centerT+1.0;
    const arr=rawWindowByTime(startT-0.01,endT+0.01);
    if(arr.length<380)return null;
    for(let i=1;i<arr.length;i++)if(arr[i][6]!==arr[i-1][6]+1)return null;
    const out=new Array(CFG.MODEL_SAMPLES);
    let ptr=0;
    for(let j=0;j<CFG.MODEL_SAMPLES;j++){
      const tt=startT+j/CFG.MODEL_HZ;
      while(ptr+1<arr.length&&arr[ptr+1][6]/CFG.RAW_HZ<tt)ptr++;
      if(ptr+1>=arr.length)return null;
      const a=arr[ptr],b=arr[ptr+1];
      const ta=a[6]/CFG.RAW_HZ,tb=b[6]/CFG.RAW_HZ;
      const u=(tt-ta)/Math.max(1e-9,tb-ta);
      const row=new Array(6);
      for(let c=0;c<6;c++)row[c]=a[c]+clamp(u,0,1)*(b[c]-a[c]);
      out[j]=row;
    }
    return {samples:out,startT,endT};
  }

  async function runTCNValidationAt(centerT){
    if(!state.modelReady||!state.mean||!state.std)return{icProb:NaN,icTime:NaN,fcProb:NaN,fcTime:NaN,info:'TCN unavailable'};
    const win=modelWindowCenteredAt(centerT);
    if(!win)return{icProb:NaN,icTime:NaN,fcProb:NaN,fcTime:NaN,info:'TCN window unavailable'};
    const flat=new Array(CFG.MODEL_SAMPLES*6);let k=0;
    for(const row of win.samples)for(let c=0;c<6;c++)flat[k++]=(row[c]-state.mean[c])/state.std[c];
    const input=tf.tensor3d(flat,[1,CFG.MODEL_SAMPLES,6],'float32');
    let outputs=[];const t0=performance.now();
    try{
      const result=state.model.execute(input);outputs=outputTensors(result);
      const parsed=await extractProbabilities(outputs);
      let icP=0,fcP=0,icT=NaN,fcT=NaN;
      for(let i=0;i<CFG.MODEL_SAMPLES;i++){
        const tt=win.startT+i/CFG.MODEL_HZ;
        if(Math.abs(tt-centerT)<=CFG.TCN_MATCH_SEC&&parsed.icProb[i]>icP){icP=parsed.icProb[i];icT=tt;}
        if(tt>centerT+0.04&&tt<=centerT+CFG.TCN_FC_LOOKAHEAD_SEC&&parsed.fcProb[i]>fcP){fcP=parsed.fcProb[i];fcT=tt;}
      }
      return{icProb:icP,icTime:icT,fcProb:fcP,fcTime:fcT,info:parsed.info,ms:performance.now()-t0};
    }finally{
      input.dispose();for(const x of outputs){try{x.dispose();}catch(e){}}
    }
  }

  async function retrospectiveReconcile(){
    state.finalizationInProgress=true;state.finalizationReady=false;state.finalStepCount=NaN;
    state.finalEvents=[];state.finalObservedSteps=0;state.finalTcnValidatedSteps=0;state.finalWaveletConfirmedSteps=0;state.tcnIc=[];state.tcnFc=[];
    setStatus('FINALIZING','Stage 1/4 — full-session step candidate scan.','warn');
    const candidates=detectCandidatesOffline();
    if(!candidates.length){
      state.finalStepCount=0;state.finalObservedSteps=0;state.finalStepMethod='full-session reconciliation — no confirmed same-shank anchors';
      state.finalizationMessage='No confirmed same-shank step anchors found.';
    }

    setStatus('FINALIZING',`Stage 2/4 — TCN validation ${candidates.length?1:0}/${candidates.length} candidates.`,'warn');
    let validated=0;
    for(let i=0;i<candidates.length;i++){
      const c=candidates[i];
      const v=await runTCNValidationAt(c.t);
      c.tcnProb=v.icProb;c.tcnTime=v.icTime;c.tcnInfo=v.info;c.tcnValidated=finite(v.icProb)&&v.icProb>=CFG.STEP_TCN_MIN_PROB;
      if(c.tcnValidated)validated++;
      if(finite(v.fcProb)&&v.fcProb>=CFG.PEAK_HEIGHT&&finite(v.fcTime))state.tcnFc.push({t:v.fcTime,conf:v.fcProb,source:'TCN-VALIDATOR',validForCadence:true});
      state.finalTcnValidationTotal=i+1;
      if(i%3===0||i===candidates.length-1)setStatus('FINALIZING',`Stage 2/4 — TCN validation ${i+1}/${candidates.length}.`,'warn');
    }
    state.finalTcnValidatedSteps=validated;

    setStatus('FINALIZING','Stage 3/4 — temporal reconciliation + clinical event assembly.','warn');
    const accepted=[];
    for(const c of candidates){
      const tcn=finite(c.tcnProb)?c.tcnProb:0;
      const score=0.30*c.signalScore+0.35*c.waveletScore+0.35*tcn;
      const accept=c.signalScore>=CFG.STEP_SIGNAL_MIN_SCORE&&c.waveletScore>=CFG.STEP_WAVELET_MIN_SCORE&&(
        tcn>=CFG.STEP_TCN_MIN_PROB || (c.signalScore>=0.62&&c.waveletScore>=0.35)
      )&&score>=CFG.STEP_FINAL_SCORE;
      if(accept){c.finalConfidence=score;accepted.push(c);}
    }
    accepted.sort((a,b)=>a.t-b.t);
    const ded=[];
    for(const c of accepted){
      const p=ded.at(-1);
      if(p&&c.t-p.t<CFG.STEP_MIN_WALK_GAP_SEC){
        if(c.finalConfidence>p.finalConfidence)ded[ded.length-1]=c;
      }else ded.push(c);
    }

    state.finalEvents=ded.map(e=>({
      t:e.t,conf:e.tcnProb,finalConfidence:e.finalConfidence,source:'LIVE+WAVELET+TCN-RECONCILED',
      signalScore:e.signalScore,waveletScore:e.waveletScore,waveletFreq:e.waveletFreq,
      tcnValidated:e.tcnValidated,validForCadence:true
    }));
    state.finalObservedSteps=state.finalEvents.length;
    state.finalWaveletConfirmedSteps=state.finalEvents.filter(e=>e.waveletScore>=CFG.STEP_WAVELET_MIN_SCORE).length;

    // Final FCs come only from the TCN validator and are temporally tied to the validated IC candidates.
    const fc=[];
    for(const e of state.tcnFc)if(isProtocolWalkTime(e.t)){
      const p=fc.at(-1);if(!p||e.t-p.t>=CFG.FC_MIN_GAP_SEC)fc.push(e);else if(e.conf>p.conf)fc[fc.length-1]=e;
    }
    state.fc=fc;
    state.ic=state.finalEvents.slice();

    // Single-shank total step count: direct sensor-side events + one inferred opposite-foot step
    // between each adjacent sensor-side event inside each walking bout. No cadence*time multiplication.
    let total=0,bout=0,lastT=NaN;
    const flush=()=>{if(bout>0)total+=bout===1?1:2*bout-1;bout=0;};
    for(const e of state.finalEvents){
      if(!finite(lastT)||!isProtocolWalkTime(e.t)||e.t-lastT>CFG.STEP_MAX_WALK_GAP_SEC)flush();
      if(bout===0)bout=1;else bout++;
      lastT=e.t;
    }
    flush();
    state.finalStepCount=total;
    state.finalStepMethod='full-session retrospective reconciliation: gyro/acceleration detector + localized wavelet + TCN gait-event validation';
    state.finalizationMessage=`${state.finalObservedSteps} same-shank anchors reconciled; ${state.finalTcnValidatedSteps} TCN-validated.`;

    setStatus('FINALIZING','Stage 4/4 — freezing final metrics and report data.','warn');
    state.afoPhasePct=NaN;state.afoOppositeEmitted=true;
    state.finalizationReady=true;state.finalizationInProgress=false;
    state.reportReady=false;
    renderMetrics();
    setStatus('STOPPED',`Final count ready: ${state.finalStepCount} estimated steps. ${state.finalizationMessage}`,'ok');
    if($('generateReport'))$('generateReport').disabled=false;
    return state.finalStepCount;
  }

  // ---------- FFT helpers ----------
  function fft(re,im,inverse){
    const n=re.length;
    for(let i=1,j=0;i<n;i++){
      let bit=n>>1;
      for(;j&bit;bit>>=1) j^=bit;
      j^=bit;
      if(i<j){
        let t=re[i];re[i]=re[j];re[j]=t;
        t=im[i];im[i]=im[j];im[j]=t;
      }
    }
    for(let len=2;len<=n;len<<=1){
      const ang=(inverse?2:-2)*Math.PI/len;
      const wlenR=Math.cos(ang),wlenI=Math.sin(ang);
      for(let i=0;i<n;i+=len){
        let wr=1,wi=0;
        for(let j=0;j<len/2;j++){
          const uR=re[i+j],uI=im[i+j];
          const vR=re[i+j+len/2]*wr-im[i+j+len/2]*wi;
          const vI=re[i+j+len/2]*wi+im[i+j+len/2]*wr;
          re[i+j]=uR+vR; im[i+j]=uI+vI;
          re[i+j+len/2]=uR-vR; im[i+j+len/2]=uI-vI;
          const twR=wr*wlenR-wi*wlenI;
          wi=wr*wlenI+wi*wlenR; wr=twR;
        }
      }
    }
    if(inverse){
      for(let i=0;i<n;i++){re[i]/=n;im[i]/=n;}
    }
  }

  function resampleSignal(values,fsOld,fsNew,n){
    if(values.length<2) return null;
    const out=new Array(n);
    const ratio=fsOld/fsNew;
    const start=(values.length-1)-(n-1)*ratio;
    for(let j=0;j<n;j++){
      const p=start+j*ratio;
      const i0=Math.floor(p),a=p-i0;
      const s0=values[clamp(i0,0,values.length-1)];
      const s1=values[clamp(i0+1,0,values.length-1)];
      out[j]=s0+a*(s1-s0);
    }
    return out;
  }

  function spectrumOf(values,fs){
    const n=CFG.FFT_N;
    const x=resampleSignal(values,fs,CFG.FFT_FS,n);
    if(!x) return null;
    const re=x.slice(),im=new Array(n).fill(0);
    const mu=mean(re);
    for(let i=0;i<n;i++){
      const w=0.5-0.5*Math.cos(2*Math.PI*i/(n-1));
      re[i]=(re[i]-mu)*w;
    }
    fft(re,im,false);
    const powers=new Array(n/2+1);
    for(let k=0;k<=n/2;k++) powers[k]=(re[k]*re[k]+im[k]*im[k]);
    return {x,re,im,powers,fs:CFG.FFT_FS,n};
  }

  function bandPower(spec,lo,hi){
    if(!spec) return NaN;
    let p=0;
    for(let k=0;k<spec.powers.length;k++){
      const f=k*spec.fs/spec.n;
      if(f>=lo&&f<=hi) p+=spec.powers[k];
    }
    return p;
  }

  function dominantFrequency(spec,lo,hi){
    if(!spec) return NaN;
    let best=-Infinity,bestF=NaN;
    for(let k=1;k<spec.powers.length;k++){
      const f=k*spec.fs/spec.n;
      if(f>=lo&&f<=hi&&spec.powers[k]>best){best=spec.powers[k];bestF=f;}
    }
    return bestF;
  }

  function tremorWaveform(){
    const arr=state.raw.slice(-256);
    if(arr.length<128) return null;
    const values=arr.map(r=>Math.sqrt(r[0]*r[0]+r[1]*r[1]+r[2]*r[2]));
    const n=256;
    const x=resampleSignal(values,CFG.RAW_HZ,CFG.RAW_HZ,n);
    const re=x.slice(),im=new Array(n).fill(0);
    const mu=mean(re);
    for(let i=0;i<n;i++) re[i]-=mu;
    fft(re,im,false);
    for(let k=0;k<n;k++){
      const f=(k<=n/2?k:n-k)*CFG.RAW_HZ/n;
      if(f<CFG.TREMOR_LOW_HZ||f>CFG.TREMOR_HIGH_HZ){re[k]=0;im[k]=0;}
    }
    fft(re,im,true);
    return re;
  }

  function bandLimitedWaveform(values,fs,lo,hi,n){
    if(values.length<16)return null;
    const x=resampleSignal(values,fs,fs,n);
    if(!x)return null;
    const re=x.slice(),im=new Array(n).fill(0),mu=mean(re);
    for(let i=0;i<n;i++){const w=0.5-0.5*Math.cos(2*Math.PI*i/(n-1));re[i]=(re[i]-mu)*w;}
    fft(re,im,false);
    for(let k=0;k<n;k++){
      const f=(k<=n/2?k:n-k)*fs/n;
      if(f<lo||f>hi){re[k]=0;im[k]=0;}
    }
    fft(re,im,true);
    return re;
  }

    function updateSpectrum(){
    if((!state.running&&!state.finalizationReady)||state.raw.length<CFG.SPECTRUM_MIN_RAW)return;
    const t=state.raw[state.raw.length-1][6]/CFG.RAW_HZ;
    if(state.spectralLastT!==null&&t-state.spectralLastT<CFG.SPECTRUM_STEP_SEC)return;
    state.spectralLastT=t;
    const sessionT=state.sessionFirstT===null?0:t-state.sessionFirstT;
    const ph=protocolAt(Math.max(0,sessionT));
    const walkingContext=isProtocolWalkTime(t)||(PROTOCOL_WALK_IDS.has(ph.id)&&state.walkingConfidence>=0.50);
    const arr=state.raw.slice(-CFG.SPECTRUM_RAW);
    const aMag=arr.map(r=>Math.sqrt(r[0]*r[0]+r[1]*r[1]+r[2]*r[2]));
    const spec=spectrumOf(aMag,CFG.RAW_HZ);
    if(!spec){state.spectralQuality='NO DATA';return;}
    if(walkingContext){
      const gaitF=dominantFrequency(spec,CFG.LOCOMOTOR_LOW_HZ,CFG.LOCOMOTOR_HIGH_HZ);
      const walkPower=bandPower(spec,CFG.LOCOMOTOR_LOW_HZ,CFG.LOCOMOTOR_HIGH_HZ);
      const freezePower=bandPower(spec,CFG.TREMOR_LOW_HZ,CFG.TREMOR_HIGH_HZ);
      state.gaitFreqHz=gaitF;state.strideFreqHz=finite(gaitF)?gaitF/2:NaN;state.freezeIndex=walkPower>1e-12?freezePower/walkPower:NaN;
      if(finite(gaitF)){
        state.gaitFreqTrend.push({t,f:gaitF});if(state.gaitFreqTrend.length>60)state.gaitFreqTrend.shift();
        const fs=state.gaitFreqTrend.map(x=>x.f);state.gaitFreqMeanHz=mean(fs);state.gaitFreqCvPct=state.gaitFreqMeanHz>0?std(fs,state.gaitFreqMeanHz)/state.gaitFreqMeanHz*100:NaN;
      }
    }
    const gMag=arr.map(r=>Math.sqrt(r[3]*r[3]+r[4]*r[4]+r[5]*r[5]));
    const gSpec=spectrumOf(gMag,CFG.RAW_HZ);
    const tremorBand=bandPower(gSpec,4,12),broadBand=bandPower(gSpec,0.5,20);
    state.tremorBandRatio=broadBand>1e-12?tremorBand/broadBand:NaN;
    state.tremorGyroPeakHz=dominantFrequency(gSpec,4,12);
    const gt=bandLimitedWaveform(gMag,CFG.RAW_HZ,4,12,512);state.tremorGyroRms=gt?rms(gt):NaN;
    const tw=tremorWaveform();state.tremorRms=tw?rms(tw):NaN;state.tremorPeakHz=dominantFrequency(spec,CFG.TREMOR_LOW_HZ,CFG.TREMOR_HIGH_HZ);
    const newFreeze=walkingContext&&finite(state.freezeIndex)&&state.freezeIndex>=CFG.FOG_FI_THRESHOLD;
    if(newFreeze){state.freezeFlagWindows++;state.freezeFlagSec+=1.0;}state.freezeFlag=newFreeze;
    state.spectralQuality=walkingContext?'VALID WALK WINDOW':'VALID OSCILLATION WINDOW';
  }


  function signalQuality(){
    const arr=state.raw.slice(-CFG.ACTIVITY_WINDOW_RAW);
    if(!arr.length) return {quality:'WAITING',sat:0,drop:state.gaps};
    let sat=0;
    for(const r of arr){
      for(let c=0;c<6;c++){
        if((c<3&&Math.abs(r[c])>3.8)||(c>=3&&Math.abs(r[c])>1900)) sat++;
      }
    }
    return {
      quality:state.gaps===0&&sat===0?'GOOD':(sat>0?'CHECK SATURATION':'CHECK DROPS'),
      sat,
      drop:state.gaps
    };
  }

    function updateDerived(){
    if(!state.warmupDone&&state.running)return;
    if(state.running||state.finalizationReady){
      if(state.running)updateActivity();
      updateSpectrum();
      state.dominantGyroAxis=dominantGyroAxis();
      updateSwingLandmarks();
      const p=gaitPhase();state.phasePct=p.pct;state.phaseName=p.name;state.gaitState=p.state;
    }
  }


  function formatTime(sec){
    if(!finite(sec)||sec<0) return '—';
    const s=Math.round(sec);
    const m=Math.floor(s/60),r=s%60;
    return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;
  }

  // ---------- Patient metadata + clinical screening/report ----------
  function patientMetadata(){
    const name=($('patientName')?.value||'').trim();
    const age=($('patientAge')?.value||'').trim();
    const sex=($('patientSex')?.value||'').trim().toLowerCase();
    const notes=($('patientNotes')?.value||'').trim();
    state.patient={name,age,sex,notes};
    return state.patient;
  }

  function esc(v){
    return String(v===undefined||v===null?'':v)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function refStepFrequency(age,sex){
    const a=Number(age);
    if(!finite(a)) return null;
    // Oberg et al. 1993: 233 healthy subjects, 10–79 y, sex-stratified 95% prediction intervals.
    const male=[
      [10,14,2.14,1.72,2.56],[15,19,2.02,1.58,2.46],[20,29,1.98,1.71,2.25],
      [30,39,2.00,1.71,2.29],[40,49,2.01,1.78,2.24],[50,59,1.96,1.58,2.34],
      [60,69,1.95,1.66,2.24],[70,79,1.91,1.62,2.20]
    ];
    const female=[
      [10,14,1.97,1.60,2.34],[15,19,2.09,1.69,2.49],[20,29,2.08,1.77,2.40],
      [30,39,2.13,1.77,2.49],[40,49,2.16,1.82,2.50],[50,59,2.03,1.76,2.30],
      [60,69,2.06,1.68,2.44],[70,79,2.03,1.74,2.32]
    ];
    if(a>=10&&a<=79&&sex){
      const rows=sex.startsWith('m')?male:sex.startsWith('f')?female:null;
      if(rows){
        for(const r of rows) if(a>=r[0]&&a<=r[1]) return {source:'Oberg 1993',meanHz:r[2],loHz:r[3],hiHz:r[4],ageBand:`${r[0]}–${r[1]}`,sex:sex.startsWith('m')?'male':'female'};
      }
    }
    // Zhong et al. 2020: pooled healthy adults 80–89 y, 95% CI for step frequency.
    if(a>=80&&a<=89) return {source:'Zhong 2020',meanHz:1.95,loHz:1.88,hiHz:2.03,ageBand:'80–89',sex:'pooled'};
    return null;
  }

  function clinicalScreen(){
    const p=patientMetadata();
    const m=metrics();
    const duration=finite(state.sessionDurationSec)?state.sessionDurationSec:(state.sessionFirstT!==null&&state.raw.length?(state.raw[state.raw.length-1][6]/CFG.RAW_HZ-state.sessionFirstT):NaN);
    const q=signalQuality();
    const ref=refStepFrequency(p.age,p.sex);
    const cadenceHz=finite(m.cadence)?m.cadence/60:NaN;
    let paceStatus='NOT ASSESSABLE';
    if(ref&&finite(cadenceHz)){
      paceStatus=cadenceHz<ref.loHz?'BELOW REFERENCE':cadenceHz>ref.hiHz?'ABOVE REFERENCE':'WITHIN REFERENCE';
    }

    const variabilityStatus=finite(m.cv)?(
      m.cv>CFG.VAR_CV_HIGH?'HIGH':(m.cv<CFG.VAR_CV_LOW?'LOW':'WITHIN META-ANALYSIS WINDOW')
    ):'NOT ASSESSABLE';

    const gaitPattern=[];
    if(paceStatus==='BELOW REFERENCE') gaitPattern.push('cadence below the age/sex step-frequency reference');
    if(variabilityStatus==='HIGH') gaitPattern.push('elevated stride-time variability');
    if(finite(m.stancePct)&&m.stancePct>65) gaitPattern.push('prolonged stance fraction (>65%)');
    if(finite(m.swingPct)&&m.swingPct<35) gaitPattern.push('reduced swing fraction (<35%)');

    const evidenceCount=gaitPattern.length;
    const patternStatus=evidenceCount>=2?'MULTIPLE GAIT-PATTERN FLAGS':evidenceCount===1?'ONE GAIT-PATTERN FLAG':'NO STRONG COMPOSITE FLAG';

    const fogWindows=state.freezeFlagWindows;
    const fogSec=state.freezeFlagSec;
    const fogStatus=fogWindows>=2||fogSec>=2?'POSSIBLE FREEZE-LIKE SPECTRAL EPISODES':'NO PERSISTENT FREEZE-LIKE SPECTRAL EPISODES FLAGGED';

    const tremorLike=finite(state.tremorGyroPeakHz)&&state.tremorGyroPeakHz>=4&&state.tremorGyroPeakHz<=12&&finite(state.tremorGyroRms)&&state.tremorGyroRms>0&&finite(state.tremorBandRatio)&&state.tremorBandRatio>=0.12;
    const tremorStatus=tremorLike?'OSCILLATION IN 4–12 Hz BAND OBSERVED':'NO PROMINENT 4–12 Hz GYRO OSCILLATION CLASSIFIED';

    const dataAdequate=finite(duration)&&duration>=CFG.REPORT_MIN_SEC&&m.icCount>=CFG.REPORT_MIN_STRIDES&&m.walkingExposureSec>=30&&q.sat===0;
    const majorFlags=[];
    if(!dataAdequate) majorFlags.push('insufficient standardized session data');
    if(state.protocolComplete===false) majorFlags.push('standardized journey incomplete');
    if(finite(state.activeAdherencePct)&&state.activeAdherencePct<75) majorFlags.push('low walking-segment adherence');
    if(variabilityStatus==='HIGH') majorFlags.push('high stride-time variability');
    if(paceStatus==='BELOW REFERENCE') majorFlags.push('below-reference cadence');
    if(patternStatus==='MULTIPLE GAIT-PATTERN FLAGS') majorFlags.push('multiple gait-pattern flags');
    if(fogWindows>=2||fogSec>=2) majorFlags.push('repeated freeze-index spectral flags');

    const overall=!dataAdequate?'INSUFFICIENT DATA':majorFlags.length?'CLINICAL REVIEW ADVISED':'NO MAJOR SIGNAL-DERIVED RED FLAGS';

    return {
      patient:p,metrics:m,duration,quality:q,reference:ref,cadenceHz,paceStatus,
      variabilityStatus,gaitPattern,patternStatus,fogWindows,fogSec,fogStatus,
      tremorLike,tremorStatus,overall,dataAdequate,majorFlags
    };
  }

  function svgChart(series,w=860,h=220,yLabel=''){
    if(!series||!series.length||!series[0].length) return '<div class="empty">No signal data available.</div>';
    const all=series.flatMap(s=>s.data).filter(finite);
    if(!all.length) return '<div class="empty">No signal data available.</div>';
    let lo=Math.min(...all),hi=Math.max(...all); if(Math.abs(hi-lo)<1e-9){lo-=1;hi+=1;}
    const pad=(hi-lo)*.08;lo-=pad;hi+=pad;
    const palette=['#0f766e','#2563eb','#d97706','#dc2626'];
    const paths=series.map((s,idx)=>{
      const pts=s.data.map((v,i)=>`${(i/(s.data.length-1))*w},${h-((v-lo)/(hi-lo))*h}`).join(' ');
      return `<polyline fill="none" stroke="${palette[idx%palette.length]}" stroke-width="1.8" points="${pts}"/>`;
    }).join('');
    const labels=series.map((s,i)=>`<span class="legend"><i style="background:${palette[i%palette.length]}"></i>${esc(s.name)}</span>`).join('');
    return `<div class="svgwrap"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><rect x="0" y="0" width="${w}" height="${h}" fill="#f8fafc"/><line x1="0" y1="${h/2}" x2="${w}" y2="${h/2}" stroke="#e2e8f0"/><g>${paths}</g></svg><div class="legendrow">${labels}<span class="axislabel">${esc(yLabel)}</span></div></div>`;
  }

  function reportSignalSeries(){
    const arr=state.raw.slice(-Math.min(state.raw.length,1000));
    if(arr.length<10) return {acc:null,gyro:null,tremor:null,freq:null};
    const acc={
      data:[arr.map(r=>r[0]),arr.map(r=>r[1]),arr.map(r=>r[2]),arr.map(r=>Math.sqrt(r[0]*r[0]+r[1]*r[1]+r[2]*r[2]))],
      names:['Ax (g)','Ay (g)','Az (g)','|A| (g)']
    };
    const gyro={
      data:[arr.map(r=>r[3]),arr.map(r=>r[4]),arr.map(r=>r[5]),arr.map(r=>Math.sqrt(r[3]*r[3]+r[4]*r[4]+r[5]*r[5]))],
      names:['Gx (°/s)','Gy (°/s)','Gz (°/s)','|G| (°/s)']
    };
    const tw=tremorWaveform();
    const freq=state.gaitFreqTrend.slice();
    return {acc,gyro,tremor:tw,freq};
  }

  function formatDuration(sec){
    if(!finite(sec)) return '—';
    const s=Math.max(0,Math.round(sec));
    return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  }

  function buildParityReportSection(){
    const p=state.parity,verdict=p.verdict||'NOT READY',cls=verdict==='PASS'?'good':(verdict==='WARN'?'warn':'review');
    if(!p.report||!p.report.summary){
      return `<h2>6A. ESP32↔APP computational parity</h2><div class="summary warn"><b>Parity: ${esc(verdict)}</b><div class="small" style="margin-top:5px">ESP32 final analytics/event packets were not available when this report was generated.</div></div>`;
    }
    const rows=(p.report.hard||[]).map(r=>`<tr><td>${esc(r.name)}</td><td>${r.ok?'PASS':'FAIL'}</td><td>${esc(r.detail)}</td></tr>`).join('');
    const nrows=(p.report.numeric||[]).map(r=>`<tr><td>${esc(r.name)}</td><td>${finite(r.app)?r.app:'—'}</td><td>${finite(r.esp)?r.esp:'—'}</td><td>${finite(r.delta)?r.delta:'—'}</td><td>${esc(r.tol)}</td><td>${esc(r.status)}</td></tr>`).join('');
    const ic=p.report.ic||{appCount:0,espCount:0,matched:0,maxErrSec:0,meanErrSec:0},fc=p.report.fc||{appCount:0,espCount:0,matched:0,maxErrSec:0,meanErrSec:0};
    return `<h2>6A. ESP32↔APP computational parity</h2>
      <div class="summary ${cls}"><b>ESP32↔APP PARITY ${esc(verdict)}</b><div class="small" style="margin-top:5px">Implementation-equivalence check over the same raw LSM6DSO session; separate from manual/video gait accuracy.</div></div>
      <h3>Hard integrity checks</h3>
      <table><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>
      <h3>Numeric parity checks</h3>
      <table><thead><tr><th>Quantity</th><th>App</th><th>ESP32</th><th>Δ</th><th>Tolerance</th><th>Status</th></tr></thead><tbody>${nrows}</tbody></table>
      <h3>Event timing</h3>
      <table><thead><tr><th>Event</th><th>App</th><th>ESP32</th><th>Matched</th><th>Max |Δt|</th><th>Mean |Δt|</th></tr></thead><tbody>
        <tr><td>IC</td><td>${ic.appCount}</td><td>${ic.espCount}</td><td>${ic.matched}</td><td>${ic.maxErrSec.toFixed(3)} s</td><td>${ic.meanErrSec.toFixed(3)} s</td></tr>
        <tr><td>FC</td><td>${fc.appCount}</td><td>${fc.espCount}</td><td>${fc.matched}</td><td>${fc.maxErrSec.toFixed(3)} s</td><td>${fc.meanErrSec.toFixed(3)} s</td></tr>
      </tbody></table>`;
  }

  function buildClinicalReportHtml(){
    const c=clinicalScreen();
    const m=c.metrics;
    const sig=reportSignalSeries();
    const generated=new Date().toLocaleString();
    const name=c.patient.name||'Unnamed patient';
    const cadenceRef=c.reference&&finite(c.cadenceHz)?`${c.cadenceHz.toFixed(2)} Hz (${m.cadence.toFixed(1)} steps/min); reference ${c.reference.loHz.toFixed(2)}–${c.reference.hiHz.toFixed(2)} Hz (${(c.reference.loHz*60).toFixed(0)}–${(c.reference.hiHz*60).toFixed(0)} steps/min)`:'No age/sex-matched published step-frequency reference available for this session.';
    const pdFeatureHtml=c.gaitPattern.length?c.gaitPattern.map(x=>`<li>${esc(x)}</li>`).join(''):'<li>No composite gait-pattern flags from the measured features.</li>';
    const overallClass=c.overall==='NO MAJOR SIGNAL-DERIVED RED FLAGS'?'good':(c.overall==='INSUFFICIENT DATA'?'warn':'review');
    const liveStepText=finite(m.liveStepCount)?String(m.liveStepCount):'—';
    const finalStepText=finite(m.finalStepCount)?String(m.finalStepCount):'—';
    const eventRows=[];
    const allE=[...state.ic.map(e=>({t:e.t,type:'IC / heel-strike proxy',conf:finite(e.tcnProb)?e.tcnProb:e.conf,finalConfidence:e.finalConfidence,src:e.source})),...state.fc.map(e=>({t:e.t,type:'FC / toe-off proxy',conf:e.conf,finalConfidence:e.finalConfidence,src:e.source}))].sort((a,b)=>a.t-b.t).slice(-40);
    for(const e of allE){const conf=finite(e.conf)?e.conf:e.finalConfidence;eventRows.push(`<tr><td>${e.t.toFixed(2)}</td><td>${esc(e.type)}</td><td>${finite(conf)?(conf*100).toFixed(1)+'%':'—'}</td><td>${esc(e.src)}</td></tr>`);}
    const eventTable=eventRows.length?`<table><thead><tr><th>Time (s)</th><th>Event</th><th>TCN confidence</th><th>Source</th></tr></thead><tbody>${eventRows.join('')}</tbody></table>`:'<p>No accepted events.</p>';
    const notes=c.patient.notes?`<p><b>Operator/session notes:</b> ${esc(c.patient.notes)}</p>`:'';
    const qualityText=`${c.quality.quality}; BLE packet gaps ${c.quality.drop}; recent-window saturation samples ${c.quality.sat}.`;

    const accChart=sig.acc?svgChart(sig.acc.data.map((d,i)=>({data:d,name:sig.acc.names[i]})),860,220,'g'):'';
    const gyroChart=sig.gyro?svgChart(sig.gyro.data.map((d,i)=>({data:d,name:sig.gyro.names[i]})),860,220,'°/s'):'';
    const tremChart=sig.tremor?svgChart([{data:sig.tremor,name:'3–8 Hz acceleration-magnitude band'}],860,180,'g'):'';
    const freqChart=sig.freq&&sig.freq.length>1?svgChart([{data:sig.freq.map(x=>x.f),name:'dominant locomotor frequency'}],860,180,'Hz'):'';

    return `<!doctype html><html><head><meta charset="utf-8"><title>VSPIMU Clinical Gait Screening Report — ${esc(name)}</title>
    <style>
    @page{size:A4;margin:14mm}body{font-family:Arial,Helvetica,sans-serif;color:#172033;line-height:1.42;font-size:11px;margin:0}h1{font-size:23px;margin:0 0 3px}h2{font-size:15px;border-bottom:2px solid #cbd5e1;padding-bottom:5px;margin:22px 0 8px}h3{font-size:12px;margin:14px 0 5px}.muted{color:#64748b}.header{display:flex;justify-content:space-between;border-bottom:3px solid #0f766e;padding-bottom:10px}.tag{font-size:10px;background:#e2e8f0;padding:4px 7px;border-radius:999px}.summary{padding:12px;border:1px solid #cbd5e1;border-radius:8px;margin-top:12px}.summary.good{background:#ecfdf5;border-color:#86efac}.summary.warn{background:#fffbeb;border-color:#fcd34d}.summary.review{background:#fef2f2;border-color:#fca5a5}.grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.metric{border:1px solid #e2e8f0;padding:8px;border-radius:6px}.metric b{display:block;font-size:14px;margin-top:2px}.small{font-size:9.5px}.callout{border-left:4px solid #0f766e;padding:7px 9px;background:#f8fafc}.warning{border-left-color:#dc2626}.tablewrap{overflow:hidden}table{width:100%;border-collapse:collapse;margin:7px 0}th,td{border:1px solid #cbd5e1;padding:5px;text-align:left}th{background:#f1f5f9;font-size:10px}.svgwrap{border:1px solid #e2e8f0;border-radius:6px;padding:5px;margin:5px 0 10px}.svgwrap svg{width:100%;height:180px;display:block}.legendrow{display:flex;gap:12px;flex-wrap:wrap;font-size:9px;margin-top:4px}.legend{display:inline-flex;align-items:center;gap:4px}.legend i{width:9px;height:9px;display:inline-block;border-radius:2px}.axislabel{margin-left:auto;color:#64748b}.empty{color:#64748b;padding:12px}.pagebreak{page-break-before:always}.refs{font-size:9px}.footer{margin-top:20px;padding-top:8px;border-top:1px solid #cbd5e1;color:#64748b;font-size:8.5px}
    </style></head><body>
    <div class="header"><div><h1>VSPIMU Clinical Gait Screening Report</h1><div class="muted">Single-shank LSM6DSO • ESP32 NodeMCU • native TCN + independent phone parity validation</div></div><div class="tag">SCREENING / DECISION SUPPORT</div></div>
    <div class="grid" style="margin-top:10px"><div class="metric"><span class="muted">Patient</span><b>${esc(name)}</b></div><div class="metric"><span class="muted">Age / Sex</span><b>${esc(c.patient.age||'Not entered')} / ${esc(c.patient.sex||'Not entered')}</b></div><div class="metric"><span class="muted">Session duration</span><b>${formatDuration(c.duration)}</b></div><div class="metric"><span class="muted">Generated</span><b>${esc(generated)}</b></div></div>
    ${notes}
    <div class="summary ${overallClass}"><div class="muted">Overall signal-derived screening impression</div><b style="font-size:18px">${esc(c.overall)}</b><div style="margin-top:5px">${c.majorFlags.length?`Flags: ${c.majorFlags.map(esc).join('; ')}.`:'No major signal-derived red flags were generated from the available measurements.'}</div></div>

    <h2>1. Clinical screening interpretation</h2>
    <div class="callout warning"><b>Important:</b> This report does <b>not</b> establish a medical diagnosis. The MDS Parkinson’s disease criteria require clinical parkinsonism—bradykinesia plus rest tremor or rigidity—followed by exclusion criteria, red flags, and supportive features. A single shank IMU cannot assess that diagnostic examination.</div>
    <div class="grid" style="margin-top:8px">
      <div class="metric"><span class="muted">Parkinsonism-pattern screen</span><b>${esc(c.patternStatus)}</b><div class="small">${c.gaitPattern.length?'Observed features are listed below.':'No composite flag from these limited gait metrics.'}</div></div>
      <div class="metric"><span class="muted">Freezing-of-gait screen</span><b>${esc(c.fogStatus)}</b><div class="small">${c.fogWindows} flagged spectral windows; ${c.fogSec.toFixed(1)} s accumulated in the current heuristic tracker.</div></div>
      <div class="metric"><span class="muted">Tremor screen</span><b>${esc(c.tremorStatus)}</b><div class="small">4–12 Hz gyro peak: ${finite(state.tremorGyroPeakHz)?state.tremorGyroPeakHz.toFixed(2)+' Hz':'—'}; RMS: ${finite(state.tremorGyroRms)?state.tremorGyroRms.toFixed(3)+' °/s':'—'}.</div></div>
      <div class="metric"><span class="muted">Terrain / stairs</span><b>NOT ASSESSED</b><div class="small">Not assessed in the single-shank V5.8 configuration.</div></div>
    </div>
    <h3>Features contributing to the gait-pattern screen</h3><ul>${pdFeatureHtml}</ul>
    <p class="small">These pattern flags are derived from gait measurements and literature context; they are not a validated PD classifier and must not be interpreted as “Parkinson’s disease = yes/no.”</p>

    <h2>2. Step counting architecture</h2>
    <div class="grid"><div class="metric"><span class="muted">LIVE step count</span><b>${liveStepText}</b><div class="small">provisional real-time gyro/acceleration + wavelet count</div></div><div class="metric"><span class="muted">FINAL estimated total steps</span><b>${finalStepText}</b><div class="small">full-session retrospective reconciliation</div></div><div class="metric"><span class="muted">Direct same-shank anchors</span><b>${m.finalObservedSteps}</b><div class="small">sensor-side footfall events</div></div><div class="metric"><span class="muted">TCN validator coverage</span><b>${m.finalTcnValidatedSteps}/${state.finalTcnValidationTotal}</b><div class="small">TCN validates gait events; it does not drive the live counter</div></div></div>
    <p>Final total steps are not calculated from cadence multiplied by walking time. In the current single-shank configuration, the reconciler counts directly supported sensor-side anchors and estimates one opposite-foot step between adjacent anchors within each walking bout.</p>

    <h2>2. Objective gait measurements</h2>
    <div class="grid">
      ${[
        ['Estimated total steps',finalStepText,'full-session reconciliation; not cadence × walking-time'],
        ['Cadence',finite(m.cadence)?m.cadence.toFixed(1)+' steps/min':'—','single-shank estimate'],
        ['Stride time',finite(m.stride)?m.stride.toFixed(3)+' s':'—','same-shank IC → IC'],
        ['Estimated step interval',finite(m.stepInterval)?m.stepInterval.toFixed(3)+' s':'—','approximately stride/2'],
        ['Stance time',finite(m.stance)?m.stance.toFixed(3)+' s':'—','IC → FC / toe-off proxy'],
        ['Swing time',finite(m.swing)?m.swing.toFixed(3)+' s':'—','FC → next IC'],
        ['Stance / stride',finite(m.stancePct)?m.stancePct.toFixed(1)+'%':'—','phase fraction'],
        ['Swing / stride',finite(m.swingPct)?m.swingPct.toFixed(1)+'%':'—','phase fraction'],
        ['Stride-time variability',finite(m.cv)?m.cv.toFixed(2)+'% CV':'—','coefficient of variation'],
        ['Event confidence',finite(m.confidence)?(m.confidence*100).toFixed(1)+'%':'—','validated event confidence (TCN where available)'],
        ['IC / FC count',`${m.icCount} / ${m.fcCount}`,'same-shank events'],
        ['Session active / stationary',`${formatDuration(state.activeSec)} / ${formatDuration(state.stationarySec)}`,'heuristic activity detector']
      ].map(x=>`<div class="metric"><span class="muted">${esc(x[0])}</span><b>${esc(x[1])}</b><div class="small">${esc(x[2])}</div></div>`).join('')}
    </div>

    <h2>3. Frequency and oscillation measures</h2>
    <div class="grid">
      <div class="metric"><span class="muted">Dominant gait frequency</span><b>${finite(state.gaitFreqHz)?state.gaitFreqHz.toFixed(3)+' Hz':'—'}</b><div class="small">0.5–3 Hz acceleration-magnitude spectral peak</div></div>
      <div class="metric"><span class="muted">Mean gait frequency</span><b>${finite(state.gaitFreqMeanHz)?state.gaitFreqMeanHz.toFixed(3)+' Hz':'—'}</b></div>
      <div class="metric"><span class="muted">Gait-frequency variability</span><b>${finite(state.gaitFreqCvPct)?state.gaitFreqCvPct.toFixed(1)+'% CV':'—'}</b></div>
      <div class="metric"><span class="muted">3–8 Hz acceleration RMS</span><b>${finite(state.tremorRms)?state.tremorRms.toFixed(4)+' g':'—'}</b><div class="small">research oscillation measure</div></div>
      <div class="metric"><span class="muted">4–12 Hz gyro peak</span><b>${finite(state.tremorGyroPeakHz)?state.tremorGyroPeakHz.toFixed(2)+' Hz':'—'}</b><div class="small">frequency alone does not identify a tremor disorder</div></div>
      <div class="metric"><span class="muted">Freeze Index</span><b>${finite(state.freezeIndex)?state.freezeIndex.toFixed(2):'—'}</b><div class="small">3–8 Hz / 0.5–3 Hz power</div></div>
    </div>
    <p class="small">The Freeze Index is a published research feature based on shank acceleration, but published thresholds and performance vary. It should be treated here as a screening signal, not a diagnosis of FOG.</p>
    ${freqChart}
    ${tremChart}

    <h2>4. Activity / gait phase</h2>
    <div class="grid"><div class="metric"><span class="muted">Walking time</span><b>${formatDuration(state.activeSec)}</b><div class="small">heuristic</div></div><div class="metric"><span class="muted">Stationary time</span><b>${formatDuration(state.stationarySec)}</b><div class="small">heuristic</div></div><div class="metric"><span class="muted">Transition time</span><b>${formatDuration(state.transitionSec)}</b><div class="small">heuristic</div></div><div class="metric"><span class="muted">Final detected gait phase</span><b>${esc(state.phaseName)}</b><div class="small">${esc(state.gaitState)} • ${finite(state.phasePct)?state.phasePct.toFixed(1)+'% cycle':'—'}</div></div></div>
    <p class="small">The phase names are time-normalized estimates around the detected IC/FC events; they are not separately trained phase classifications.</p>

    <div class="pagebreak"></div><h2>5. Age/sex reference comparison</h2>
    <div class="metric"><span class="muted">Published step-frequency comparison</span><b>${esc(c.paceStatus)}</b><div class="small">${esc(cadenceRef)}</div></div>
    <p>Oberg et al. reported gait-laboratory reference data from 233 healthy participants aged 10–79 years and provided sex-specific 95% prediction intervals. Their work found meaningful age/sex effects for some parameters but not step frequency. This report uses their step-frequency reference only as contextual benchmarking—not as a diagnostic cutoff.</p>
    <div class="metric"><span class="muted">Stride-time variability reference</span><b>${esc(c.variabilityStatus)}</b><div class="small">König et al. meta-analysis: an evidence-based healthy window of approximately 1.1–2.6% CV for stride time; values above 2.6% or below 1.1% were associated with pathology in their pooled analysis.</div></div>
    <p class="small">The reported reference ranges come from specific populations and study conditions. They should not be interpreted as age/sex-independent “normal limits” for every individual.</p>

    <h2>6. Signal quality</h2><p>${esc(qualityText)} The live sensor was measured on one shank. Sensor mounting that is loose or able to rotate independently of the leg can degrade event detection.</p>

    <h2>7. Live accelerometer record</h2>${accChart}
    <h2>8. Live gyroscope record</h2>${gyroChart}

    <h2>9. Gait event log</h2>${eventTable}

    ${buildParityReportSection()}

    <h2>10. What this report can and cannot conclude</h2>
    <div class="callout"><b>Can support:</b> objective description of cadence, stride timing, stance/swing timing, stride-time variability, event confidence, signal-derived frequency content, and research screening flags for unusual variability or freeze-like spectral episodes.<br><br><b>Cannot establish:</b> Parkinson’s disease, essential tremor, another tremor disorder, freezing of gait as a clinical diagnosis, balance/fall-risk diagnosis, bilateral asymmetry, true stride length, walking speed, or terrain/stair mode from this one-shank V5 setup.</div>

    <h2>11. Suggested clinical follow-up</h2>
    <ol><li>Take this report and the raw/session context to a clinician when abnormalities are flagged or symptoms are concerning.</li><li>For suspected parkinsonism, a clinician should perform the standard neurologic examination required by MDS criteria, including assessment of bradykinesia, rigidity and rest tremor.</li><li>For suspected freezing of gait, a supervised assessment should include turning, gait initiation, narrow passages and other clinically relevant triggers; a shank Freeze Index alone is insufficient.</li><li>For suspected tremor disorder, use dedicated rest/postural/action tremor testing on the clinically affected limb rather than inferring a disorder from walking-derived shank frequency alone.</li><li>Repeat the walking test under the same setup if a result is unexpected, preferably with a rigid sensor mount and a standardized walking protocol.</li></ol>

    <h2>12. References</h2>
    <div class="refs">
      <p>1. Postuma RB, Berg D, Stern M, et al. MDS clinical diagnostic criteria for Parkinson’s disease. <i>Movement Disorders</i>. 2015;30(12):1591–1601. DOI: 10.1002/mds.26424.</p>
      <p>2. Romijnders R, et al. Automated gait event detection using a single shank/ankle inertial sensor using temporal convolutional networks. <i>Sensors</i>. 2022. The published model uses 6-axis IMU input and predicts initial/final contact.</p>
      <p>3. Oberg T, Karsznia A, Oberg K. Basic gait parameters: reference data for normal subjects, 10–79 years of age. <i>J Rehabil Res Dev</i>. 1993;30(2):210–223. PMID: 8035350.</p>
      <p>4. König N, Taylor WR, Baumann CR, Wenderoth N, Singh NB. Revealing the quality of movement: a meta-analysis review to quantify the thresholds to pathological variability during standing and walking. <i>Neurosci Biobehav Rev</i>. 2016;68:111–119. DOI: 10.1016/j.neubiorev.2016.03.035.</p>
      <p>5. Moore ST, MacDougall HG, Ondo WG. Ambulatory monitoring of freezing of gait in Parkinson’s disease. <i>J Neurosci Methods</i>. 2008. PMID: 17928063. Freeze Index uses the 3–8 Hz band divided by the 0.5–3 Hz locomotor band.</p>
    </div>
    <div class="footer">VSPIMU V5.8 • Research / screening report • Generated locally in WebView • Not a substitute for clinical diagnosis.</div>
    </body></html>`;
  }

  function downsampleSeries(values,n){
    if(!values||!values.length)return[];
    if(values.length<=n)return values.slice();
    const out=[];
    for(let i=0;i<n;i++){
      const idx=Math.round(i*(values.length-1)/(n-1));
      out.push(values[idx]);
    }
    return out;
  }

    function buildReportPayload(){
    const c=clinicalScreen(),m=c.metrics,arr=state.raw.slice();
    const accMag=arr.map(r=>Math.sqrt(r[0]*r[0]+r[1]*r[1]+r[2]*r[2]));
    const gyroMag=arr.map(r=>Math.sqrt(r[3]*r[3]+r[4]*r[4]+r[5]*r[5]));
    const times=arr.map(r=>r[6]/CFG.RAW_HZ);
    const events=[...state.finalEvents.map(e=>({t:e.t,type:'IC / heel-strike proxy',conf:e.tcnProb,finalConfidence:e.finalConfidence,source:e.source})),...state.fc.map(e=>({t:e.t,type:'FC / toe-off proxy',conf:e.conf,finalConfidence:e.conf,source:e.source}))].sort((a,b)=>a.t-b.t).slice(-80);
    return {
      schema:'VSPIMU-REPORT-2',generated:new Date().toISOString(),duration:c.duration,
      filename:'VSPIMU_Report_'+((c.patient.name||'Patient').replace(/[^A-Za-z0-9_-]+/g,'_')),patient:c.patient,
      clinical:{overall:c.overall,patternStatus:c.patternStatus,gaitPattern:c.gaitPattern,paceStatus:c.paceStatus,variabilityStatus:c.variabilityStatus,fogStatus:c.fogStatus,fogWindows:c.fogWindows,fogSec:c.fogSec,tremorStatus:c.tremorStatus},
      steps:{liveCount:m.liveStepCount,finalEstimatedCount:m.finalStepCount,finalObservedShankSteps:m.finalObservedSteps,finalTcnValidatedSteps:m.finalTcnValidatedSteps,finalWaveletConfirmedSteps:m.finalWaveletConfirmedSteps,method:m.stepMethod,cadenceCrossCheck:m.cadenceCrossCheckEstimate,afo:{enabled:CFG.AFO_ENABLED,freqHz:state.afoFreqHz}},
      metrics:m,
      activity:{activeSec:state.activeSec,stationarySec:state.stationarySec,transitionSec:state.transitionSec,detectedMode:state.activityCurrent,walkingConfidence:state.walkingConfidence,stationaryConfidence:state.stationaryConfidence,walkingCoverageSec:m.walkingSec,walkingExposureSec:m.walkingExposureSec,activeAdherencePct:state.activeAdherencePct,protocolActiveSec:state.protocolActiveSec,protocolStationarySec:state.protocolStationarySec},
      protocol:{phase:state.protocolPhase,elapsedSec:state.protocolElapsedSec,remainingSec:state.protocolRemainingSec,totalSec:PROTOCOL_TOTAL_SEC,complete:state.protocolComplete,walkPlannedSec:state.protocolWalkElapsedSec,stationaryPlannedSec:state.protocolStationaryElapsedSec,instruction:state.protocolInstruction},
      quality:c.quality,spectrum:{gaitFreqHz:state.gaitFreqHz,gaitFreqMeanHz:state.gaitFreqMeanHz,gaitFreqCvPct:state.gaitFreqCvPct,tremorRms:state.tremorRms,tremorPeakHz:state.tremorPeakHz,tremorGyroPeakHz:state.tremorGyroPeakHz,tremorGyroRms:state.tremorGyroRms,tremorBandRatio:state.tremorBandRatio,freezeIndex:state.freezeIndex},
      eventValidation:{candidateCount:state.stepDetectorCandidates,tcnValidatedCount:state.finalTcnValidatedSteps,tcnCoverage:state.finalTcnValidationTotal>0?state.finalTcnValidatedSteps/state.finalTcnValidationTotal:NaN,waveletConfirmedCount:state.finalWaveletConfirmedSteps},
      parity:JSON.parse(JSON.stringify(state.parity)),
      events,signal:{time:downsampleSeries(times,240),accMag:downsampleSeries(accMag,240),gyroMag:downsampleSeries(gyroMag,240),freqTrend:state.gaitFreqTrend.slice(-60)},
      software:{version:'VSPIMU V5.8',model:state.modelOutputInfo,backend:state.backend,gaps:state.gaps,stepDetector:'real-time gyro/acceleration + localized Morlet wavelet confirmation',tcnRole:'gait-event validator',afoRole:'optional phase/cadence support only',staticProfile:state.staticProfile,walkProfile:state.walkProfile}
    };
  }


    function prepareReport(){
    if(state.running||!state.finalizationReady){
      setStatus('REPORT BLOCKED',state.running?'Stop the session and wait for final reconciliation.':'Final reconciliation is not ready.','warn');
      return null;
    }
    const html=buildClinicalReportHtml();
    const safe=(state.patient.name||'Patient').replace(/[^A-Za-z0-9_-]+/g,'_');
    const filename='VSPIMU_Report_'+safe;
    state.reportReady=true;
    setStatus('PDF','Stage 1/6 — report HTML generated; starting chunked transfer to App Inventor.','ok');
    setText('reportStatus','PDF STAGE 1 — report HTML prepared; transferring to App Inventor in chunks.');
    const transfer=sendReportInChunks(html,filename,clinicalScreen().overall);
    return {filename,html,reportId:transfer.reportId,totalChunks:transfer.total};
  }


  function renderMetrics(){
    updateProtocol();
    const m=metrics();
    if($('generateReport')) $('generateReport').disabled=state.running||state.finalizationInProgress||!state.finalizationReady;

    updateDerived();
    const q=signalQuality();
    try{
      const cs=clinicalScreen();
      setText('screeningOverall',cs.overall);
      setText('gaitPatternScreen',cs.patternStatus);
      setText('paceReference',cs.paceStatus);
      setText('variabilityReference',cs.variabilityStatus);
    }catch(e){ console.warn('screening render',e); }

    // Core gait
    setText('cadence',finite(m.cadence)?m.cadence.toFixed(1):'—');
    setText('stride',finite(m.stride)?m.stride.toFixed(3):'—');
    setText('stepTime',finite(m.stepInterval)?m.stepInterval.toFixed(3):'—');
    setText('stance',finite(m.stance)?m.stance.toFixed(3):'—');
    setText('swing',finite(m.swing)?m.swing.toFixed(3):'—');
    setText('stancePct',finite(m.stancePct)?m.stancePct.toFixed(1)+'%':'—');
    setText('swingPct',finite(m.swingPct)?m.swingPct.toFixed(1)+'%':'—');
    setText('variability',finite(m.cv)?m.cv.toFixed(1)+'%':'—');
    setText('confidence',finite(m.confidence)?(m.confidence*100).toFixed(1)+'%':'—');
    setText('icCount',String(m.icCount));
    setText('fcCount',String(m.fcCount));

    // Session
    const duration=finite(state.sessionDurationSec)?state.sessionDurationSec:(state.sessionFirstT===null?NaN:(state.raw.length?state.raw[state.raw.length-1][6]/CFG.RAW_HZ-state.sessionFirstT:NaN));
    const accounted=state.activeSec+state.stationarySec+state.transitionSec;
    setText('sessionTime',finite(duration)?formatTime(duration):'—');
    setText('activeTime',formatTime(state.activeSec));
    setText('stationaryTime',formatTime(state.stationarySec));
    setText('transitionTime',formatTime(state.transitionSec));
    setText('steps',String(m.estimatedTotalSteps));
    setText('liveSteps',String(m.liveStepCount));
    setText('finalSteps',finite(m.finalStepCount)?String(m.finalStepCount):'—');
    setText('stepDetectorStatus',state.stepDetectorStatus);
    setText('waveletStatus',finite(state.liveWaveletLastScore)?`${state.liveWaveletLastScore.toFixed(3)} @ ${state.liveWaveletLastFreq.toFixed(2)} Hz`:'—');
    setText('tcnValidationStatus',state.finalTcnValidationTotal?`${state.finalTcnValidatedSteps}/${state.finalTcnValidationTotal}`:'live validator');
    setText('finalizationStatus',state.finalizationReady?'READY':state.finalizationInProgress?'IN PROGRESS':'NOT READY');
    setText('sameShankSteps',String(m.detectedSameFootSteps));
    setText('stepMethod',m.stepMethod||'—');
    setText('afoStatus',CFG.AFO_ENABLED&&finite(state.afoFreqHz)?`${state.afoFreqHz.toFixed(2)} Hz • ${finite(state.afoPhasePct)?state.afoPhasePct.toFixed(0):0}°`:'optional / waiting');
    setText('stepCoverage',finite(m.walkingExposureSec)?formatTime(m.walkingExposureSec):'—');
    setText('paceDescriptor',paceDescriptor(m.cadence));
    setText('gaitFrequency',finite(state.gaitFreqHz)?state.gaitFreqHz.toFixed(2)+' Hz':'—');
    setText('strideFrequency',finite(m.strideFreq)?m.strideFreq.toFixed(2)+' Hz':'—');
    setText('gaitTrendStatus',state.gaitFreqTrend.length>=2?'TRENDING':'BUILDING');

    // Current phase / events
    setText('activityMode',state.activityCurrent);
    setText('activityConfidence',finite(state.activityConfidence)?(state.activityConfidence*100).toFixed(0)+'%':'—');
    setText('walkingConfidence',finite(state.walkingConfidence)?(state.walkingConfidence*100).toFixed(0)+'%':'—');
    setText('stationaryConfidence',finite(state.stationaryConfidence)?(state.stationaryConfidence*100).toFixed(0)+'%':'—');
    setText('phase',state.phaseName);
    setText('gaitState',state.gaitState);
    setText('phasePct',finite(state.phasePct)?state.phasePct.toFixed(1)+'%':'—');
    const lastIC=state.ic.at(-1);
    const lastFC=state.fc.at(-1);
    setText('heelStrike',lastIC?`${lastIC.t.toFixed(2)} s | ${(finite(lastIC.conf)?lastIC.conf:(finite(lastIC.tcnProb)?lastIC.tcnProb:lastIC.finalConfidence)).toFixed(3)}`:'—');
    setText('toeOff',lastFC?`${lastFC.t.toFixed(2)} s | ${lastFC.conf.toFixed(3)}`:'—');
    const p=gaitPhase();
    setText('midSwing',finite(p.midSwing)?`${p.midSwing.toFixed(2)} s (estimated)`:'—');
    setText('swingPeak',finite(state.swingPeakDps)?`${state.swingPeakDps.toFixed(1)} °/s`:'—');
    setText('swingPeakPct',finite(state.swingPeakPct)?`${state.swingPeakPct.toFixed(1)}% cycle`:'—');
    setText('zeroCross',finite(state.swingZeroCrossings)?String(state.swingZeroCrossings):'—');
    setText('gyroAxis',['X','Y','Z'][state.dominantGyroAxis]);

    // Spectral / tremor
    setText('tremorRms',finite(state.tremorRms)?state.tremorRms.toFixed(4)+' g':'—');
    setText('tremorPeak',finite(state.tremorPeakHz)?state.tremorPeakHz.toFixed(2)+' Hz':'—');
    setText('freezeIndex',finite(state.freezeIndex)?state.freezeIndex.toFixed(2):'—');
    setText('freezeFlag',state.freezeFlag?'RESEARCH FLAG':'not flagged');
    const fEl=$('freezeFlag');
    if(fEl) fEl.className='value '+(state.freezeFlag?'bad':'ok');
    setText('spectralQuality',state.spectralQuality);

    // Signal
    setText('motionRms',finite(state.motionRms)?state.motionRms.toFixed(4):'—');
    setText('gyroRms',finite(state.gyroRms)?state.gyroRms.toFixed(1)+' °/s':'—');
    setText('signalQuality',q.quality);
    setText('signalDrops',String(q.drop));
    setText('saturation',String(q.sat));

    // Diagnostics
    setText('samples',String(state.totalSamples));
    setText('inferenceMs',finite(state.lastInferenceMs)?state.lastInferenceMs.toFixed(0)+' ms':'—');
    setText('peakIC',finite(state.lastWindowPeakIC)?state.lastWindowPeakIC.toFixed(3):'—');
    setText('peakFC',finite(state.lastWindowPeakFC)?state.lastWindowPeakFC.toFixed(3):'—');
    setText('modelOutput',state.modelOutputInfo||'—');
    setText('stepCandidates',String(state.stepDetectorCandidates));
    setText('backend',state.backend||'—');
    setText('continuity',state.cleanSamplesSinceGap>=CFG.CLEAN_AFTER_GAP?'CLEAN':String(state.cleanSamplesSinceGap)+' / '+CFG.CLEAN_AFTER_GAP);

    const lines=[];
    const events=[];
    state.ic.slice(-10).forEach(e=>events.push({t:e.t,type:'IC / HS*',p:finite(e.tcnProb)?e.tcnProb:e.conf,src:e.source}));
    state.fc.slice(-10).forEach(e=>events.push({t:e.t,type:'FC / TO*',p:e.conf,src:e.source}));
    events.sort((a,b)=>a.t-b.t);
    for(const e of events.slice(-20)) lines.push(`${e.t.toFixed(2).padStart(7)} s   ${e.type.padEnd(9)} p=${e.p.toFixed(3)}   ${e.src}`);
    setText('events',lines.length?lines.join('\n'):'No accepted events yet.');
    renderParityPanel();
    const rs=$('reportStatus');
    if(rs&&!state.reportReady) rs.textContent=state.running?'Report becomes available after Stop.':'Stop the session, then generate the report.';

  }

  function drawLine(canvasId,series,unit,zeroLine){
    const canvas=$(canvasId);
    if(!canvas||!canvas.getContext) return;
    const ctx=canvas.getContext('2d');
    const DPR=window.devicePixelRatio||1;
    const w=canvas.width=canvas.clientWidth*DPR;
    const h=canvas.height=canvas.clientHeight*DPR;
    ctx.clearRect(0,0,w,h);
    ctx.font=`${11*DPR}px system-ui`;
    ctx.fillStyle='rgba(152,163,189,0.9)';
    ctx.strokeStyle='rgba(39,49,75,0.9)';
    ctx.lineWidth=1*DPR;
    ctx.strokeRect(0.5*DPR,0.5*DPR,w-1*DPR,h-1*DPR);

    if(!series||!series.length) return;
    const flat=[];
    for(const s of series) for(const p of s.data) if(finite(p)) flat.push(p);
    if(!flat.length) return;
    let lo=Math.min(...flat),hi=Math.max(...flat);
    if(Math.abs(hi-lo)<1e-8){lo-=1;hi+=1;}
    const pad=(hi-lo)*0.10;lo-=pad;hi+=pad;

    if(zeroLine&&lo<0&&hi>0){
      const y0=h-(0-lo)/(hi-lo)*h;
      ctx.strokeStyle='rgba(152,163,189,0.25)';
      ctx.beginPath();ctx.moveTo(0,y0);ctx.lineTo(w,y0);ctx.stroke();
    }

    const labels=['X','Y','Z','MAG'];
    for(let si=0;si<series.length;si++){
      const data=series[si].data;
      if(data.length<2) continue;
      ctx.strokeStyle=series[si].stroke||'rgba(101,214,161,0.95)';
      ctx.lineWidth=1.5*DPR;
      ctx.beginPath();
      for(let i=0;i<data.length;i++){
        const x=(i/(data.length-1))*w;
        const y=h-(data[i]-lo)/(hi-lo)*h;
        if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
      }
      ctx.stroke();
      if(si<4){
        ctx.fillStyle=ctx.strokeStyle;
        ctx.fillText(labels[si],8*DPR,(16+si*14)*DPR);
      }
    }
    ctx.fillStyle='rgba(152,163,189,0.75)';
    ctx.fillText(unit||'',w-75*DPR,14*DPR);
  }

  function drawFrequencyTrend(){
    const canvas=$('freqCanvas');
    if(!canvas||!canvas.getContext)return;
    const ctx=canvas.getContext('2d');
    const DPR=window.devicePixelRatio||1;
    const w=canvas.width=canvas.clientWidth*DPR;
    const h=canvas.height=canvas.clientHeight*DPR;
    ctx.clearRect(0,0,w,h);
    ctx.strokeStyle='rgba(39,49,75,0.9)';ctx.strokeRect(0.5,0.5,w-1,h-1);
    const tr=state.gaitFreqTrend;
    if(tr.length<2){ctx.fillStyle='rgba(152,163,189,0.8)';ctx.font=`${12*DPR}px system-ui`;ctx.fillText('Building gait-frequency trend…',10,22*DPR);return;}
    const vals=tr.map(p=>p.f).filter(finite); if(vals.length<2)return;
    let lo=Math.min(...vals),hi=Math.max(...vals);if(Math.abs(hi-lo)<0.1){lo-=0.2;hi+=0.2;}const pad=(hi-lo)*0.15;lo-=pad;hi+=pad;
    ctx.strokeStyle='rgba(119,183,255,0.95)';ctx.lineWidth=2*DPR;ctx.beginPath();
    for(let i=0;i<tr.length;i++){const x=i/(tr.length-1)*w;const y=h-(tr[i].f-lo)/(hi-lo)*h;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.stroke();
    ctx.fillStyle='rgba(152,163,189,0.8)';ctx.font=`${10*DPR}px system-ui`;ctx.fillText(`${lo.toFixed(2)}–${hi.toFixed(2)} Hz`,8,14*DPR);
  }

  function drawGraphs(){
    const arr=state.raw.slice(-CFG.GRAPH_RAW);
    if(arr.length<2) return;
    const ax=arr.map(r=>r[0]),ay=arr.map(r=>r[1]),az=arr.map(r=>r[2]);
    const am=arr.map(r=>Math.sqrt(r[0]*r[0]+r[1]*r[1]+r[2]*r[2]));
    const gx=arr.map(r=>r[3]),gy=arr.map(r=>r[4]),gz=arr.map(r=>r[5]);
    const gm=arr.map(r=>Math.sqrt(r[3]*r[3]+r[4]*r[4]+r[5]*r[5]));
    drawLine('accCanvas',
      [
        {data:ax,stroke:'rgba(101,214,161,0.95)'},
        {data:ay,stroke:'rgba(119,183,255,0.95)'},
        {data:az,stroke:'rgba(244,189,88,0.95)'},
        {data:am,stroke:'rgba(255,117,117,0.95)'}
      ],'g',false);
    drawLine('gyroCanvas',
      [
        {data:gx,stroke:'rgba(101,214,161,0.95)'},
        {data:gy,stroke:'rgba(119,183,255,0.95)'},
        {data:gz,stroke:'rgba(244,189,88,0.95)'},
        {data:gm,stroke:'rgba(255,117,117,0.95)'}
      ],'°/s',false);

    const tw=tremorWaveform();
    if(tw) drawLine('tremorCanvas',[{data:tw,stroke:'rgba(255,117,117,0.95)'}],'3–8 Hz',true);
    drawFrequencyTrend();
  }

  function outputTensors(result){
    if(Array.isArray(result)) return result;
    if(result&&typeof result==='object'){
      const vals=Object.values(result).filter(v=>v&&Array.isArray(v.shape)&&typeof v.data==='function');
      if(vals.length) return vals;
    }
    if(result&&Array.isArray(result.shape)&&typeof result.data==='function') return [result];
    return [];
  }

  async function tensorVector(t){
    const data=await t.data();
    return {data:Array.from(data),shape:t.shape.slice()};
  }

  function probabilityVectors(tensors){
    const single=tensors.filter(t=>t&&Array.isArray(t.shape));
    if(single.length>=2){
      const a=single[0],b=single[1];
      // Verified exporter order: output 0 = final_contact (FC), output 1 = initial_contact (IC).
      if(a.shape.length>=2&&b.shape.length>=2)return{mode:'two-output',ic:b,fc:a,semanticOrder:'final_contact,initial_contact'};
    }
    if(single.length===1){
      const t=single[0],sh=t.shape;
      if(sh.length===3&&sh[0]===1&&sh[1]===CFG.MODEL_SAMPLES&&sh[2]>=2)return{mode:'packed',packed:t};
    }
    return null;
  }

  async function extractProbabilities(tensors){
    const p=probabilityVectors(tensors);
    if(!p)throw new Error('Unsupported model output shape. Expected two [1,400,1] outputs or one [1,400,2] output.');
    if(p.mode==='two-output'){
      const ia=await tensorVector(p.ic),fa=await tensorVector(p.fc);
      if(ia.data.length<CFG.MODEL_SAMPLES||fa.data.length<CFG.MODEL_SAMPLES)throw new Error('TCN output is shorter than 400 samples.');
      return{icProb:ia.data.slice(0,CFG.MODEL_SAMPLES),fcProb:fa.data.slice(0,CFG.MODEL_SAMPLES),info:`two outputs ${p.ic.shape.join('×')} + ${p.fc.shape.join('×')}`};
    }
    const pa=await tensorVector(p.packed);
    const icProb=new Array(CFG.MODEL_SAMPLES),fcProb=new Array(CFG.MODEL_SAMPLES);
    // Verified exporter order for packed output: channel 0 = final_contact (FC), channel 1 = initial_contact (IC).
    for(let i=0;i<CFG.MODEL_SAMPLES;i++){fcProb[i]=pa.data[i*pa.shape[2]];icProb[i]=pa.data[i*pa.shape[2]+1];}
    return{icProb,fcProb,info:`packed output ${pa.shape.join('×')} [FC,IC]`};
  }

  function peakTime(endTime,index){return endTime-(CFG.MODEL_SAMPLES-1-index)/CFG.MODEL_HZ;}

  function processSinglePeak(prob,list,endTime,height,source,type){
    const peaks=findPeaks(prob,height,CFG.PEAK_DISTANCE,CFG.EDGE_LEFT,CFG.COMMIT_RIGHT);
    let changed=false;
    for(const p of peaks){
      const t=peakTime(endTime,p.i);
      if(!eventAllowed(t,type,p.v))continue;
      const gap=type==='IC'?CFG.IC_MIN_GAP_SEC:CFG.FC_MIN_GAP_SEC;
      changed=insertEventSorted(list,t,p.v,source,gap,true)||changed;
    }
    return {changed,peaks};
  }

    function processPeaks(icProb,fcProb,endTime,height,source){
    const ip=findPeaks(icProb,height,CFG.PEAK_DISTANCE,CFG.EDGE_LEFT,CFG.COMMIT_RIGHT);
    const fp=findPeaks(fcProb,height,CFG.PEAK_DISTANCE,CFG.EDGE_LEFT,CFG.COMMIT_RIGHT);
    let icChanged=false,fcChanged=false;
    for(const p of ip){
      const t=peakTime(endTime,p.i);
      if(!isProtocolWalkTime(t))continue;
      if(insertEventSorted(state.tcnIc,t,p.v,'TCN-VALIDATOR',CFG.IC_MIN_GAP_SEC,false))icChanged=true;
      const live=nearestTCNEvent(state.liveEvents,t,CFG.TCN_MATCH_SEC);
      if(live){live.tcnProb=p.v;live.tcnValidated=p.v>=CFG.STEP_TCN_MIN_PROB;}
    }
    for(const p of fp){
      const t=peakTime(endTime,p.i);
      if(!isProtocolWalkTime(t))continue;
      if(insertEventSorted(state.tcnFc,t,p.v,'TCN-VALIDATOR',CFG.FC_MIN_GAP_SEC,true))fcChanged=true;
    }
    state.fc=state.tcnFc.slice();
    if(icChanged&&state.liveEvents.length){
      state.ic=state.liveEvents.map(e=>({t:e.t,conf:finite(e.tcnProb)?e.tcnProb:e.waveletScore,source:e.tcnValidated?'LIVE+WAVELET+TCN':'LIVE+WAVELET',validForCadence:true}));
    }
    return{changed:icChanged||fcChanged,icChanged,fcChanged,icPeaks:ip,fcPeaks:fp};
  }


  function addRecoveredICs(endTime){
    if(state.raw.length<CFG.ACTIVITY_WINDOW_RAW||state.ic.length<2)return;
    const times=recentValidICs();
    if(times.length<2)return;
    const intervals=[];
    for(let i=Math.max(1,times.length-6);i<times.length;i++){
      const d=times[i]-times[i-1];
      if(d>=CFG.MIN_STRIDE_SEC&&d<=CFG.MAX_STRIDE_SEC)intervals.push(d);
    }
    const stride=median(intervals);
    if(!finite(stride))return;
    const last=times[times.length-1];
    const tailGap=endTime-last;
    if(tailGap<Math.max(1.35,1.25*stride)||tailGap>1.85*stride)return;

    const axis=state.dominantGyroAxis;
    const candidateT=last+stride;
    const arr=state.raw.filter(r=>{
      const t=r[6]/CFG.RAW_HZ;
      return t>=candidateT-0.30*stride&&t<=Math.min(endTime-0.12,candidateT+0.30*stride);
    });
    if(arr.length<80)return;
    const vals=arr.map(r=>Math.abs(r[3+axis]));
    const peak=Math.max(...vals);
    const baseline=std(vals);
    const wt=walkThresholds();
    const minPeak=Math.max(0.75*wt.gyro,20,2.2*(finite(baseline)?baseline:0));
    if(peak<minPeak)return;
    let best=0,bestV=-Infinity;
    for(let i=1;i<vals.length-1;i++){
      if(vals[i]>bestV&&vals[i]>=vals[i-1]&&vals[i]>=vals[i+1]){bestV=vals[i];best=i;}
    }
    const t=arr[best][6]/CFG.RAW_HZ;
    if(!eventAllowed(t,'IC',CFG.RECOVERY_HEIGHT))return;
    insertEventSorted(state.ic,t,CFG.RECOVERY_HEIGHT,'SIGNAL-RECOVERY',CFG.IC_MIN_GAP_SEC,true);
  }

    async function runInference(){
    if(!state.modelReady||!state.warmupDone||!state.running)return;
    if(state.cleanSamplesSinceGap<CFG.CLEAN_AFTER_GAP)return;
    const win=resampleTo200(state.raw);if(!win||!state.mean||!state.std)return;
    const flat=new Array(CFG.MODEL_SAMPLES*6);let k=0;
    for(const row of win)for(let c=0;c<6;c++)flat[k++]=(row[c]-state.mean[c])/state.std[c];
    const input=tf.tensor3d(flat,[1,CFG.MODEL_SAMPLES,6],'float32');
    let outputs=[];const t0=performance.now();
    try{
      const result=state.model.execute(input);outputs=outputTensors(result);
      if(outputs.length===0)throw new Error('Model execute returned no tensors.');
      const parsed=await extractProbabilities(outputs);
      state.modelOutputInfo=parsed.info;state.lastWindowPeakIC=Math.max(...parsed.icProb);state.lastWindowPeakFC=Math.max(...parsed.fcProb);
      const endSeq=state.raw[state.raw.length-1][6],endTime=endSeq/CFG.RAW_HZ;
      processPeaks(parsed.icProb,parsed.fcProb,endTime,CFG.PEAK_HEIGHT,'TCN-VALIDATOR');
      state.lastInferenceMs=performance.now()-t0;
      renderMetrics();
    }finally{
      input.dispose();for(const t of outputs){try{t.dispose();}catch(e){}}
    }
  }


  async function maybeInference(){
    if(state.inferenceBusy){state.inferencePending=true;return;}
    if(!state.running||!state.warmupDone||!state.modelReady)return;
    state.inferenceBusy=true;
    try{await runInference();}
    catch(e){
      console.error(e);state.lastInferenceMs=NaN;
      setStatus('MODEL ERROR',e.message||String(e),'bad');
      sendToAI({type:'model_error',error:e.message||String(e)});
    }finally{
      state.inferenceBusy=false;
      if(state.inferencePending){state.inferencePending=false;setTimeout(maybeInference,0);}
    }
  }

  function finishWarmup(forceBoundary=false){
    if(state.warmupDone)return true;
    if(state.warmup.length<CFG.WARMUP_MIN_RAW)return false;
    if(!forceBoundary && state.warmup.length<CFG.WARMUP_RAW)return false;
    const received=state.warmup.length;
    const s=computeStats(state.warmup);
    state.mean=s.mean;state.std=s.std;
    const wp=profileFromSamples(state.warmup);
    if(wp)state.walkProfile={gyroRms:wp.gyroRms,accStd:wp.accStd,periodicity:wp.periodicity,gyroRange:wp.gyroRange};
    state.warmup=[];
    state.warmupDone=true;
    state.cleanSamplesSinceGap=CFG.CLEAN_AFTER_GAP;
    setStatus('ANALYZING',`Baseline normalization locked: ${received}/${CFG.WARMUP_RAW} successful samples (minimum ${CFG.WARMUP_MIN_RAW}). TCN + WT + AFO + activity analytics active.`,'ok');
    renderMetrics();
    maybeInference();
    return true;
  }

  function crc32UpdateByte(crc,b){
    crc^=(b&0xFF);
    for(let i=0;i<8;i++)crc=(crc&1)?((crc>>>1)^0xEDB88320)>>>0:(crc>>>1)>>>0;
    return crc>>>0;
  }
  function crc32UpdateU32LE(crc,v){
    v=Number(v)>>>0;
    crc=crc32UpdateByte(crc,v&255);
    crc=crc32UpdateByte(crc,(v>>>8)&255);
    crc=crc32UpdateByte(crc,(v>>>16)&255);
    return crc32UpdateByte(crc,(v>>>24)&255);
  }

  function crc32UpdateI16LE(crc,v){
    let x=Math.round(v);x=((x+32768)%65536+65536)%65536-32768;const u=x&0xFFFF;
    crc=crc32UpdateByte(crc,u&255);return crc32UpdateByte(crc,(u>>>8)&255);
  }
  function parityReset(){
    state.parity={
      rawCrc:0xFFFFFFFF,phoneSampleCount:0,phoneFirstSeq:null,phoneLastSeq:null,
      phoneMissingSlots:0,phoneGapEvents:0,espSummary:null,espIC:[],espFC:[],
      espICTotal:null,espFCTotal:null,espICReceived:0,espFCReceived:0,espTransferId:0,
      verdict:'NOT READY',hardFailures:[],numericWarnings:[],
      report:{hard:[],numeric:[],ic:null,fc:null}
    };
    setText('parityStatus','WAITING FOR ESP32 FINAL SUMMARY');
    renderParityPanel();
  }
  function parityRawSample(seq,ax,ay,az,gx,gy,gz){
    if(!state.running&&!state.captureTail)return;
    const p=state.parity,cur=Number(seq)>>>0;
    if(p.phoneFirstSeq===null)p.phoneFirstSeq=cur;
    if(p.phoneLastSeq!==null){
      const expected=(Number(p.phoneLastSeq)+1)>>>0;
      if(cur!==expected){
        p.phoneGapEvents++;
        p.phoneMissingSlots+=(cur-expected)>>>0;
      }
    }
    p.phoneLastSeq=cur;p.phoneSampleCount++;
    let c=p.rawCrc>>>0;
    c=crc32UpdateU32LE(c,cur);
    c=crc32UpdateI16LE(c,ax);c=crc32UpdateI16LE(c,ay);c=crc32UpdateI16LE(c,az);
    c=crc32UpdateI16LE(c,gx);c=crc32UpdateI16LE(c,gy);c=crc32UpdateI16LE(c,gz);
    p.rawCrc=c>>>0;
  }
  const dvU16=(d,o)=>d.getUint16(o,true);
  const dvU32=(d,o)=>d.getUint32(o,true);
  const dvF32=(d,o)=>d.getFloat32(o,true);
  function decodeEspSummary(bytes){
    if(!bytes||bytes.length!==168)return null;
    const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(dvU16(d,0)!==0x494D||d.getUint8(2)!==5||d.getUint8(3)!==1)return null;
    return {
      flags:dvU16(d,4),seq:dvU32(d,6),sampleCount:dvU32(d,10),firstSeq:dvU32(d,14),lastSeq:dvU32(d,18),
      rawCrc32:dvU32(d,22),sensorMisses:dvU16(d,26),rawGaps:dvU16(d,28),liveSteps:dvU16(d,30),
      finalSteps:dvU16(d,32),liveAnchors:dvU16(d,34),finalAnchors:dvU16(d,36),finalFC:dvU16(d,38),
      finalTCN:dvU16(d,40),finalTCNTotal:dvU16(d,42),waveletConfirmed:dvU16(d,44),candidates:dvU16(d,46),
      activity:d.getUint8(48),phase:d.getUint8(49),dominantAxis:d.getUint8(50),
      sessionDurationSec:dvF32(d,52),protocolElapsedSec:dvF32(d,56),
      cadence:dvF32(d,60),stride:dvF32(d,64),stepInterval:dvF32(d,68),stance:dvF32(d,72),
      swing:dvF32(d,76),strideCV:dvF32(d,80),stancePct:dvF32(d,84),swingPct:dvF32(d,88),
      activeSec:dvF32(d,92),stationarySec:dvF32(d,96),transitionSec:dvF32(d,100),
      walkingExposureSec:dvF32(d,104),protocolActiveSec:dvF32(d,108),protocolStationarySec:dvF32(d,112),
      gaitFreqHz:dvF32(d,116),gaitFreqMeanHz:dvF32(d,120),gaitFreqCvPct:dvF32(d,124),strideFreqHz:dvF32(d,128),
      tremorRms:dvF32(d,132),tremorPeakHz:dvF32(d,136),tremorGyroPeakHz:dvF32(d,140),tremorGyroRms:dvF32(d,144),
      tremorBandRatio:dvF32(d,148),freezeIndex:dvF32(d,152),phasePct:dvF32(d,156),
      afoFreqHz:dvF32(d,160),afoPhaseDeg:dvF32(d,164)
    };
  }
  function decodeEspEvent(bytes){
    if(!bytes||bytes.length!==144)return null;
    const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(dvU16(d,0)!==0x494D||d.getUint8(2)!==5||d.getUint8(3)!==2)return null;
    const total=dvU16(d,8),startIndex=dvU16(d,10),eventType=d.getUint8(12),count=d.getUint8(13);
    if(count>16||startIndex+count>total)return null;
    const events=[];
    for(let i=0;i<count;i++)events.push({index:startIndex+i,t:dvF32(d,16+i*4),conf:dvF32(d,80+i*4)});
    return {transferId:dvU32(d,4),total,startIndex,eventType,count,events};
  }
  function eventParity(appEvents,espEvents,tol){
    const a=(appEvents||[]).slice().sort((x,y)=>x.t-y.t),e=(espEvents||[]).slice().sort((x,y)=>x.t-y.t);
    const n=Math.min(a.length,e.length);let max=0,sum=0;
    for(let i=0;i<n;i++){const er=Math.abs(a[i].t-e[i].t);if(er>max)max=er;sum+=er;}
    return {pass:a.length===e.length&&max<=tol,appCount:a.length,espCount:e.length,matched:n,maxErrSec:max,meanErrSec:n?sum/n:0,tol};
  }
  function parityNum(name,a,b,tol,warnings){
    const af=finite(a),bf=finite(b);
    if(!af&&!bf)return {name,app:a,esp:b,delta:NaN,tol,status:'NA'};
    if(af&&bf){
      const delta=Math.abs(a-b),ok=delta<=tol;
      const row={name,app:a,esp:b,delta,tol,status:ok?'PASS':'WARN'};
      if(!ok)warnings.push(row);
      return row;
    }
    const row={name,app:a,esp:b,delta:NaN,tol,status:'WARN'};
    warnings.push(row);return row;
  }
  function parityHard(name,ok,detail,failures,rows){
    const row={name,ok,detail:detail||''};rows.push(row);if(!ok)failures.push(row);
  }
  function parityCompleteEvents(arr,total){
    if(total===0)return [];
    if(!Array.isArray(arr)||arr.length!==total)return null;
    for(let i=0;i<total;i++)if(!arr[i]||!finite(arr[i].t))return null;
    return arr.slice().sort((a,b)=>a.t-b.t);
  }
  function renderParityPanel(){
    const p=state.parity||{};
    const s=p.espSummary;
    const verdict=p.verdict||'NOT READY';
    const cls=verdict==='PASS'?'ok':(verdict==='WARN'?'warn':(verdict==='FAIL'?'bad':'blue'));
    const status=verdict==='NOT READY'
      ?(s?'RECEIVING ESP32 FINAL DATA':'WAITING FOR ESP32 FINAL SUMMARY')
      :`ESP32↔APP PARITY ${verdict}`;
    const el=$('parityStatus');
    if(el){el.textContent=status;el.className='value '+cls;}
    if(!s){
      setText('parityDetail','Parity runs after STOP, app retrospective reconciliation, and complete ESP32 IC/FC event transfer.');
      setText('parityRaw','Raw integrity: waiting');setText('parityEvents','Events: waiting for final IC/FC packets');setText('parityNumeric','Numeric parity: waiting');setText('parityChecks','No final parity verdict yet.');
      return;
    }
    const hard=(p.report?.hard||[]), num=(p.report?.numeric||[]);
    const hardFail=hard.filter(x=>!x.ok).length;
    const numWarn=num.filter(x=>x.status==='WARN').length;
    const summaryText=verdict==='PASS'?'All parity checks passed.':verdict==='WARN'?`${numWarn} numeric tolerance check${numWarn===1?'':'s'} outside tolerance.`:`${hardFail} hard integrity check${hardFail===1?'':'s'} failed.`;
    setText('parityDetail',summaryText);
    const crcPhone=p.report?.phoneRawCrc;
    const crcEsp=s.rawCrc32;
    setText('parityRaw',`Raw: ${p.phoneSampleCount}/${s.sampleCount} samples • missing ${p.phoneMissingSlots}/${s.sensorMisses} • gaps ${s.rawGaps} • CRC ${finite(crcPhone)?'0x'+crcPhone.toString(16).padStart(8,'0'):'—'} / 0x${(crcEsp>>>0).toString(16).padStart(8,'0')}`);
    const ic=p.report?.ic,fc=p.report?.fc;
    const icText=ic?`IC ${ic.appCount}/${ic.espCount} • max Δ ${ic.maxErrSec.toFixed(3)}s`:'IC —';
    const fcText=fc?`FC ${fc.appCount}/${fc.espCount} • max Δ ${fc.maxErrSec.toFixed(3)}s`:'FC —';
    setText('parityEvents',`Events: ${icText} • ${fcText}`);
    setText('parityNumeric',`Numeric: ${num.length-numWarn}/${num.length} within tolerance${numWarn?` • ${numWarn} WARN`:''}`);
    const problems=[...(p.report?.hard||[]).filter(x=>!x.ok).map(x=>`FAIL • ${x.name}: ${x.detail}`),...(p.report?.numeric||[]).filter(x=>x.status==='WARN').slice(0,8).map(x=>`WARN • ${x.name}: app=${finite(x.app)?x.app:'—'} esp=${finite(x.esp)?x.esp:'—'} Δ=${finite(x.delta)?x.delta:'—'} tol=${x.tol}`)];
    setText('parityChecks',problems.length?problems.join('\n'):'No failing/warning checks.');
  }
  function maybeRunEspParity(){
    const p=state.parity,s=p.espSummary;
    if(!s||!(s.flags&1)||!state.finalizationReady)return false;
    const espIC=parityCompleteEvents(p.espIC,s.finalAnchors);
    const espFC=parityCompleteEvents(p.espFC,s.finalFC);
    if(!espIC||!espFC){renderParityPanel();return false;}
    const m=metrics(),hard=[],numeric=[],hr=[],nr=[];
    parityHard('raw successful sample count',p.phoneSampleCount===s.sampleCount,`${p.phoneSampleCount} vs ${s.sampleCount}`,hard,hr);
    parityHard('first raw sequence',p.phoneFirstSeq!==null&&((p.phoneFirstSeq>>>0)===(s.firstSeq>>>0)),`${p.phoneFirstSeq} vs ${s.firstSeq}`,hard,hr);
    parityHard('last raw sequence',p.phoneLastSeq!==null&&((p.phoneLastSeq>>>0)===(s.lastSeq>>>0)),`${p.phoneLastSeq} vs ${s.lastSeq}`,hard,hr);
    parityHard('phone missing slots',p.phoneMissingSlots===s.sensorMisses,`${p.phoneMissingSlots} vs ${s.sensorMisses}`,hard,hr);
    parityHard('phone raw sequence gaps = 0',p.phoneGapEvents===0,`${p.phoneGapEvents}`,hard,hr);
    parityHard('ESP32 sensor read misses = 0',s.sensorMisses===0,`${s.sensorMisses}`,hard,hr);
    parityHard('ESP32 raw-gap counter = 0',s.rawGaps===0,`${s.rawGaps}`,hard,hr);
    parityHard('ESP32 baseline normalization complete',(s.flags&4)!==0,'warmup flag='+((s.flags&4)!==0?'SET':'NOT SET'),hard,hr);
    parityHard('ESP32 final session storage complete',(s.flags&8)===0,'flashIncomplete='+((s.flags&8)!==0?'YES':'NO'),hard,hr);
    const phoneCrc=(p.rawCrc^0xFFFFFFFF)>>>0;
    parityHard('raw-record CRC-32',phoneCrc===(s.rawCrc32>>>0),`0x${phoneCrc.toString(16).padStart(8,'0')} vs 0x${(s.rawCrc32>>>0).toString(16).padStart(8,'0')}`,hard,hr);
    parityHard('live step count',Number(state.liveStepCount||0)===Number(s.liveSteps),`${state.liveStepCount||0} vs ${s.liveSteps}`,hard,hr);
    parityHard('final estimated total steps',Number(m.finalStepCount||0)===Number(s.finalSteps),`${m.finalStepCount||0} vs ${s.finalSteps}`,hard,hr);
    parityHard('final same-shank IC anchors',Number(m.finalObservedSteps||0)===Number(s.finalAnchors),`${m.finalObservedSteps||0} vs ${s.finalAnchors}`,hard,hr);
    parityHard('final FC count',Number(m.fcCount||0)===Number(s.finalFC),`${m.fcCount||0} vs ${s.finalFC}`,hard,hr);
    parityHard('final TCN-validated anchors',Number(state.finalTcnValidatedSteps||0)===Number(s.finalTCN),`${state.finalTcnValidatedSteps||0} vs ${s.finalTCN}`,hard,hr);
    parityHard('final wavelet-confirmed anchors',Number(state.finalWaveletConfirmedSteps||0)===Number(s.waveletConfirmed),`${state.finalWaveletConfirmedSteps||0} vs ${s.waveletConfirmed}`,hard,hr);
    const ic=eventParity(state.finalEvents,espIC,0.05),fc=eventParity(state.fc,espFC,0.05);
    parityHard('IC events one-to-one',ic.pass,`${ic.appCount} vs ${ic.espCount}; max ${ic.maxErrSec.toFixed(3)} s`,hard,hr);
    parityHard('FC events one-to-one',fc.pass,`${fc.appCount} vs ${fc.espCount}; max ${fc.maxErrSec.toFixed(3)} s`,hard,hr);
    parityHard('session duration <= 0.50 s',
      finite(state.sessionDurationSec)&&finite(s.sessionDurationSec)&&Math.abs(state.sessionDurationSec-s.sessionDurationSec)<=0.50,
      `${state.sessionDurationSec} vs ${s.sessionDurationSec}`,hard,hr);
    const checks=[
      ['Cadence',m.cadence,s.cadence,0.50],['Stride time',m.stride,s.stride,0.005],['Step interval',m.stepInterval,s.stepInterval,0.005],
      ['Stance time',m.stance,s.stance,0.005],['Swing time',m.swing,s.swing,0.005],['Stride CV',m.cv,s.strideCV,0.50],
      ['Stance %',m.stancePct,s.stancePct,0.50],['Swing %',m.swingPct,s.swingPct,0.50],
      ['Active time',state.activeSec,s.activeSec,0.50],['Stationary time',state.stationarySec,s.stationarySec,0.50],
      ['Transition time',state.transitionSec,s.transitionSec,0.50],['Walking exposure',state.walkingExposureSec,s.walkingExposureSec,0.50],
      ['Protocol-active time',state.protocolActiveSec,s.protocolActiveSec,0.50],['Protocol-stationary time',state.protocolStationarySec,s.protocolStationarySec,0.50],
      ['Gait frequency',state.gaitFreqHz,s.gaitFreqHz,0.01],['Mean gait frequency',state.gaitFreqMeanHz,s.gaitFreqMeanHz,0.01],
      ['Gait-frequency CV',state.gaitFreqCvPct,s.gaitFreqCvPct,0.50],['Stride frequency',m.strideFreq,s.strideFreqHz,0.01],
      ['Acceleration tremor RMS',state.tremorRms,s.tremorRms,0.002],['Acceleration tremor peak',state.tremorPeakHz,s.tremorPeakHz,0.10],
      ['Gyro tremor peak',state.tremorGyroPeakHz,s.tremorGyroPeakHz,0.10],['Gyro tremor RMS',state.tremorGyroRms,s.tremorGyroRms,0.20],
      ['Tremor band ratio',state.tremorBandRatio,s.tremorBandRatio,0.01],['Freeze Index',state.freezeIndex,s.freezeIndex,0.10],
      ['Phase %',state.phasePct,s.phasePct,0.50],['AFO frequency',state.afoFreqHz,s.afoFreqHz,0.02],
      ['AFO phase',state.afoPhasePct,s.afoPhaseDeg,1.0]
    ];
    for(const c of checks)nr.push(parityNum(c[0],c[1],c[2],c[3],numeric));
    p.hardFailures=hard;p.numericWarnings=numeric;
    p.report={hard:hr,numeric:nr,ic,fc,summary:s,phoneMissingSlots:p.phoneMissingSlots,phoneGapEvents:p.phoneGapEvents,phoneRawCrc:phoneCrc};
    p.verdict=hard.length?'FAIL':numeric.length?'WARN':'PASS';
    renderParityPanel();
    setText('parityStatus',`ESP32↔APP PARITY ${p.verdict}`);
    setStatus(`ESP32↔APP PARITY ${p.verdict}`,
      p.verdict==='PASS'?'All hard and numeric parity checks passed.':
      p.verdict==='WARN'?`${numeric.length} numeric checks exceeded tolerance; integrity checks passed.`:
      `${hard.length} hard parity checks failed.`,
      p.verdict==='PASS'?'ok':p.verdict==='WARN'?'warn':'bad');
    renderMetrics();
    sendToAI({type:'ESP_PARITY_RESULT',verdict:p.verdict,report:p.report});
    return true;
  }
  function receiveEspAnalyticsCsv(csv){
    const nums=csvToNumbers(csv);if(nums.length<4)return false;
    const bytes=Uint8Array.from(nums.map(v=>Math.max(0,Math.min(255,Math.round(v)))));
    const s=decodeEspSummary(bytes);
    if(s){
      state.parity.espSummary=s;
      if(s.flags&1)maybeRunEspParity();
      return true;
    }
    const e=decodeEspEvent(bytes);if(!e)return false;
    if(e.eventType===1){
      if(state.parity.espICTotal!==e.total){state.parity.espICTotal=e.total;state.parity.espIC=new Array(e.total);}
      state.parity.espTransferId=e.transferId;
      for(const x of e.events)state.parity.espIC[x.index]=x;
    }else if(e.eventType===2){
      if(state.parity.espFCTotal!==e.total){state.parity.espFCTotal=e.total;state.parity.espFC=new Array(e.total);}
      state.parity.espTransferId=e.transferId;
      for(const x of e.events)state.parity.espFC[x.index]=x;
    }else return false;
    if(state.parity.espSummary?.flags&1)maybeRunEspParity();
    return true;
  }

    function handleSample(seq,row){
    if(!state.running&&!state.captureTail)return;
    if(state.expectedSeq!==null&&seq!==state.expectedSeq){
      state.gaps++;state.cleanSamplesSinceGap=0;state.expectedSeq=seq;
      state.activityCandidate=null;state.activityCandidateSince=null;state.livePendingStepCandidates=[];state.livePendingOpposite=[];
      setStatus('DATA GAP',`BLE gap #${state.gaps}; retained full session data, temporarily blocking model windows.`,'warn');
    }
    state.expectedSeq=seq+1;
    const sampleT=seq/CFG.RAW_HZ;
    if(state.running&&state.sessionFirstT===null)state.sessionFirstT=sampleT;
    const elapsed=state.sessionFirstT===null?0:sampleT-state.sessionFirstT;
    const ph=protocolAt(Math.max(0,elapsed));

    if(state.running&&elapsed>=0&&elapsed<8)state.staticCalib.push(row.slice(0,6));
    if(state.running&&!state.warmupDone&&ph.id==='BASELINE_WALK'){
      state.warmup.push(row.slice(0,6));
    }
    // Do not require exactly 2080 successful reads: a small number of sensor/I2C
    // misses must not leave the model permanently in WARMUP. Lock normalization
    // at the first WALK_MAIN sample when >=90% of the planned baseline arrived.
    if(state.running&&!state.warmupDone&&ph.id==='WALK_MAIN'&&state.warmup.length>=CFG.WARMUP_MIN_RAW){
      finishWarmup(true);
    }

    state.raw.push([row[0],row[1],row[2],row[3],row[4],row[5],seq]);
    if(state.raw.length>CFG.HISTORY_RAW)state.raw.splice(0,state.raw.length-CFG.HISTORY_RAW);
    if(state.cleanSamplesSinceGap<CFG.CLEAN_AFTER_GAP)state.cleanSamplesSinceGap++;
    state.totalSamples++;state.samplesSinceStart++;

    if(state.running&&elapsed>=8&&elapsed<9&&state.staticCalib.length>=CFG.ACTIVITY_WINDOW_RAW&&!state.staticProfileLocked){
      const sp=profileFromSamples(state.staticCalib.slice(-Math.min(state.staticCalib.length,CFG.ACTIVITY_WINDOW_RAW*2)));
      if(sp)state.staticProfile={gyroRms:sp.gyroRms,accStd:sp.accStd,gyroRange:sp.gyroRange,accRange:sp.accRange};
      state.staticProfileLocked=true;
      state.dominantGyroAxis=dominantGyroAxis();
    }

    if(state.running&&state.warmupDone&&!state.captureTail){
      // LIVE step counter runs on the phone reference implementation.
      stepDetectorPush(sampleT,row);
      updateAFO(sampleT,NaN);
    }
  }


  function receiveShortsCsv(csv){
    const a=csvToNumbers(csv);if(a.length<8)return;
    const n=Math.floor(a.length/8);
    for(let i=0;i<n;i++){
      const b=i*8;
      const lo=(Math.round(a[b])&0xFFFF)>>>0;
      const hi=(Math.round(a[b+1])&0xFFFF)>>>0;
      const seq=(lo+hi*65536)>>>0;
      const s16=v=>{let x=Math.round(v);x=((x+32768)%65536+65536)%65536-32768;return x;};
      const ax=s16(a[b+2]),ay=s16(a[b+3]),az=s16(a[b+4]),gx=s16(a[b+5]),gy=s16(a[b+6]),gz=s16(a[b+7]);
      parityRawSample(seq,ax,ay,az,gx,gy,gz);
      // Exact LSM6DSO scale conversion happens ONLY here, inside the phone/WebView.
      const row=[ax*0.0001220703125,ay*0.0001220703125,az*0.0001220703125,gx*0.07,gy*0.07,gz*0.07];
      handleSample(seq,row);
    }
    setText('samples',String(state.totalSamples));
    if(state.running&&!state.warmupDone){
      const sec=Math.max(0,Math.min(10,protocolElapsedFromRaw()-8));
      const got=state.warmup.length;
      setStatus('WARMUP',`Baseline walk: ${sec.toFixed(1)} / 10.0 s • ${got}/${CFG.WARMUP_RAW} samples (minimum ${CFG.WARMUP_MIN_RAW})`,'warn');
      if(protocolElapsedFromRaw()>=18.0 && got>=CFG.WARMUP_MIN_RAW)finishWarmup(true);
    }else if(state.running&&!state.captureTail&&state.warmupDone&&state.totalSamples-state.lastInferenceRawCount>=CFG.INFERENCE_STEP_RAW){
      state.lastInferenceRawCount=state.totalSamples;maybeInference();
    }
  }


  async function loadModel(){
    setText('modelState','LOADING');
    try{
      const deadline=Date.now()+20000;
      while(!window.tf&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
      if(!window.tf)throw new Error('TensorFlow.js not loaded. Put tf.min.js in App Inventor assets.');
      let backendSet=false;
      try{await tf.setBackend('webgl');await tf.ready();backendSet=true;}catch(e){console.warn('WebGL unavailable; using CPU',e);}
      if(!backendSet){await tf.setBackend('cpu');await tf.ready();}
      state.backend=tf.getBackend();
      state.model=await tf.loadGraphModel('http://localhost/model.json',{strict:false});
      const x=tf.zeros([1,CFG.MODEL_SAMPLES,6]);
      const r=state.model.execute(x);const outs=outputTensors(r);
      if(!outs.length)throw new Error('Converted model returned no output tensors during warm-up.');
      let info='';const p=probabilityVectors(outs);
      if(p?.mode==='two-output')info=`${outs.length} outputs: ${outs.map(t=>t.shape.join('×')).join(' + ')}`;
      else if(p?.mode==='packed')info=`1 packed output: ${outs[0].shape.join('×')}`;
      else throw new Error(`Unexpected model output shapes: ${outs.map(t=>t.shape.join('×')).join(', ')}`);
      for(const t of outs)t.dispose();x.dispose();
      state.modelReady=true;state.modelOutputInfo=info;
      setText('modelState','READY');setText('modelDetail',`Romijnders TCN • IC/FC validator • ${info}`);
      setStatus('READY','Connect GAIT-V5-C3. ESP32 and phone analytics are independent; ESP32→phone parity is checked after STOP.','ok');renderMetrics();
    }catch(e){
      console.error(e);state.modelReady=false;setText('modelState','ERROR');setText('modelDetail',e.message||String(e));
      setStatus('MODEL NOT READY',e.message||String(e),'bad');sendToAI({type:'model_error',error:e.message||String(e)});
    }
  }

  const api={
    receiveShortsCsv,
    receiveEspAnalyticsCsv,
    start:function(){
      if(state.running)return;
      state.running=true;state.captureTail=false;state.stopRequestedAt=0;state.finalizationReady=false;state.finalizationInProgress=false;state.finalStepCount=NaN;state.finalStepMethod='';state.finalEvents=[];state.finalObservedSteps=0;state.finalTcnValidatedSteps=0;state.finalTcnValidationTotal=0;state.finalWaveletConfirmedSteps=0;state.finalizationMessage='';
      state.warmupDone=false;state.warmup=[];state.staticCalib=[];state.staticProfileLocked=false;state.raw=[];state.expectedSeq=null;parityReset();
      state.totalSamples=0;state.samplesSinceStart=0;state.lastInferenceRawCount=0;state.gaps=0;state.ic=[];state.fc=[];state.tcnIc=[];state.tcnFc=[];state.mean=null;state.std=null;state.cleanSamplesSinceGap=CFG.CLEAN_AFTER_GAP;
      state.lastInferenceMs=NaN;state.lastWindowPeakIC=NaN;state.lastWindowPeakFC=NaN;state.recovery=false;state.sessionFirstT=null;state.sessionDurationSec=NaN;
      state.lastActivityT=null;state.activityCurrent='UNKNOWN';state.activeSec=0;state.stationarySec=0;state.transitionSec=0;state.activityLastUpdateT=null;state.activityStableSince=0;state.activityCandidate=null;state.activityCandidateSince=null;state.activityScore=NaN;state.motionRms=NaN;state.gyroRms=NaN;state.walkingConfidence=NaN;state.stationaryConfidence=NaN;state.activityConfidence=NaN;
      state.staticProfile={gyroRms:NaN,accStd:NaN,gyroRange:NaN,accRange:NaN};state.walkProfile={gyroRms:NaN,accStd:NaN,periodicity:NaN,gyroRange:NaN};
      state.stepEstimate=0;state.stepLastUpdateT=null;state.liveStepCount=0;state.liveObservedSteps=0;state.liveInferredOppositeSteps=0;state.liveEvents=[];state.livePendingOpposite=[];state.liveLastAnchorT=null;state.liveLastAnchorPhase='';state.livePendingStepCandidates=[];state.liveDetectorThreshold=NaN;state.liveDetectorAccThreshold=NaN;state.liveWaveletLastScore=NaN;state.liveWaveletLastFreq=NaN;state.liveSignalLastScore=NaN;state.stepDetectorStatus='WAITING';state.stepDetectorCandidates=0;state.liveStepSignal=[];state.liveSignalPushes=0;
      state.liveFilterGyro=[makeOnePoleFilter(),makeOnePoleFilter(),makeOnePoleFilter()];state.liveFilterAcc=makeOnePoleFilter();
      state.afoFreqHz=NaN;state.afoPhasePct=NaN;state.afoAnchorT=null;state.afoLastT=null;state.afoOppositeEmitted=false;state.liveInferredOppositeTimes=[];
      state.protocolPhase='NOT_STARTED';state.protocolElapsedSec=0;state.protocolRemainingSec=PROTOCOL_TOTAL_SEC;state.protocolInstruction='Starting standardized journey…';state.protocolComplete=false;state.protocolLastId='';state.protocolWalkElapsedSec=0;state.protocolStationaryElapsedSec=0;state.activeAdherencePct=NaN;state.walkingExposureSec=0;state.protocolActiveSec=0;state.protocolStationarySec=0;state.stepEstimateMethod='';state.stepRateSpectralSpm=NaN;state.stepRateEventSpm=NaN;
      state.gaitFreqHz=NaN;state.strideFreqHz=NaN;state.gaitFreqTrend=[];state.tremorRms=NaN;state.tremorBandRatio=NaN;state.tremorPeakHz=NaN;state.freezeIndex=NaN;state.freezeFlag=false;state.spectralLastT=null;state.spectralQuality='WAITING';
      state.swingPeakDps=NaN;state.swingPeakPct=NaN;state.swingZeroCrossings=NaN;state.phasePct=NaN;state.phaseName='—';state.gaitState='—';state.dominantGyroAxis=0;
      state.signalSaturationCount=0;state.patient=patientMetadata();state.reportReady=false;state.freezeFlagWindows=0;state.freezeFlagSec=0;state.freezeFlagActive=false;state.tremorGyroPeakHz=NaN;state.tremorGyroRms=NaN;state.gaitFreqMeanHz=NaN;state.gaitFreqCvPct=NaN;
      if($('generateReport'))$('generateReport').disabled=true;
      renderMetrics();setStatus('WARMUP','Follow the 123 s journey. Phone and ESP32 compute independently for V5.8 parity validation.','warn');
    },
    stop:function(){
      if(!state.running||state.finalizationInProgress||state.captureTail)return;
      state.captureTail=true;
      state.stopRequestedAt=performance.now();
      state.inferencePending=false;
      setStatus('FINALIZING','Stage 0/4 — STOP received; capturing the final BLE raw packet before retrospective reconciliation.','warn');
      renderMetrics();drawGraphs();

      setTimeout(()=>{
        if(!state.running||!state.captureTail)return;
        state.captureTail=false;

        if(state.sessionFirstT!==null&&state.raw.length){
          const lastT=state.raw[state.raw.length-1][6]/CFG.RAW_HZ;
          if(state.activityLastUpdateT!==null){
            const dt=clamp(Math.max(0,lastT-state.activityLastUpdateT),0,0.75),prior=state.activityCurrent,ph=protocolAt(Math.max(0,lastT-state.sessionFirstT));
            if(prior==='WALKING'){
              state.activeSec+=dt;
              if(PROTOCOL_WALK_IDS.has(ph.id)){
                state.walkingExposureSec+=dt;
                state.protocolActiveSec+=dt;
              }
            }else if(prior==='STATIONARY'){
              state.stationarySec+=dt;
              if(PROTOCOL_STILL_IDS.has(ph.id))state.protocolStationarySec+=dt;
            }else state.transitionSec+=dt;
            state.activityLastUpdateT=lastT;
          }
          state.sessionDurationSec=Math.max(0,lastT-state.sessionFirstT);
        }

        updateProtocol();updateActivity();updateSpectrum();updateSwingLandmarks();
        state.running=false;
        state.inferencePending=false;
        state.warmup=[];
        state.expectedSeq=null;
        state.finalizationInProgress=true;
        state.finalizationReady=false;
        state.reportReady=false;
        if($('generateReport'))$('generateReport').disabled=true;
        setStatus('FINALIZING','Stage 1/4 — raw stream closed; retaining the complete session for retrospective reconciliation.','warn');
        renderMetrics();drawGraphs();

        setTimeout(()=>{
          retrospectiveReconcile().then(()=>{
            setTimeout(maybeRunEspParity,50);
          }).catch(e=>{
            console.error(e);
            state.finalizationInProgress=false;
            setStatus('FINALIZATION ERROR',e.message||String(e),'bad');
            sendToAI({type:'finalization_error',error:e.message||String(e)});
            renderMetrics();
          });
        },0);
      },STOP_RAW_TAIL_MS);
    },
    reset:function(){
      if(state.running){state.running=false;}state.captureTail=false;state.stopRequestedAt=0;parityReset();
      state.finalizationInProgress=false;state.finalizationReady=false;state.finalStepCount=NaN;state.finalEvents=[];state.raw=[];state.ic=[];state.fc=[];state.tcnIc=[];state.tcnFc=[];state.liveEvents=[];state.livePendingOpposite=[];state.livePendingStepCandidates=[];state.liveStepSignal=[];state.liveSignalPushes=0;state.liveInferredOppositeTimes=[];state.liveStepCount=0;state.liveObservedSteps=0;state.liveInferredOppositeSteps=0;state.stepDetectorCandidates=0;state.stepDetectorStatus='RESET';state.totalSamples=0;state.sessionFirstT=null;state.sessionDurationSec=NaN;state.afoFreqHz=NaN;state.afoPhasePct=NaN;state.afoAnchorT=null;state.afoLastT=null;state.afoOppositeEmitted=false;state.patient=patientMetadata();state.reportReady=false;state.lastStatus='';
      if($('generateReport'))$('generateReport').disabled=true;
      renderMetrics();drawGraphs();setStatus('READY','Session reset. Connect GAIT-V5-C3.','');
    },
    prepareReport:function(){return prepareReport();},
    updatePatient:function(){patientMetadata();return state.patient;},
    state:function(){
      return JSON.parse(JSON.stringify({
        modelReady:state.modelReady,running:state.running,warmupDone:state.warmupDone,totalSamples:state.totalSamples,gaps:state.gaps,metrics:metrics(),backend:state.backend,outputInfo:state.modelOutputInfo,
        steps:{live:state.liveStepCount,final:state.finalStepCount,observed:state.finalObservedSteps,tcnValidated:state.finalTcnValidatedSteps,waveletConfirmed:state.finalWaveletConfirmedSteps,ready:state.finalizationReady},
        stepDetector:{status:state.stepDetectorStatus,candidates:state.stepDetectorCandidates,waveletScore:state.liveWaveletLastScore,waveletFreq:state.liveWaveletLastFreq,tcnValidated:state.finalTcnValidatedSteps},
        activity:{mode:state.activityCurrent,activeSec:state.activeSec,stationarySec:state.stationarySec,transitionSec:state.transitionSec},protocol:{phase:state.protocolPhase,elapsedSec:state.protocolElapsedSec,remainingSec:state.protocolRemainingSec,complete:state.protocolComplete,adherencePct:state.activeAdherencePct},
        spectrum:{gaitFreqHz:state.gaitFreqHz,tremorRms:state.tremorRms,tremorPeakHz:state.tremorPeakHz,freezeIndex:state.freezeIndex,tremorGyroPeakHz:state.tremorGyroPeakHz},
        parity:{verdict:state.parity.verdict,hardFailures:state.parity.hardFailures,numericWarnings:state.parity.numericWarnings,report:state.parity.report},
        screening:clinicalScreen()
      }));
    }
  };

  window.VSPIMU=api;
  renderParityPanel();
  // Legacy bridge compatibility: older App Inventor blocks used IMU.*.
  window.IMU=window.VSPIMU;

  // Low-frequency dashboard loop keeps BLE callback lightweight.
  setInterval(function(){
    if(!state.running) return;
    const now=performance.now();
    if(now-state.lastDashboardUpdate>=250){
      state.lastDashboardUpdate=now;
      updateProtocol();
      updateDerived();
      renderMetrics();
      if(now-state.lastGraphDraw>=250){
        state.lastGraphDraw=now;
        drawGraphs();
      }
    }
  },100);

  loadModel();
})();
