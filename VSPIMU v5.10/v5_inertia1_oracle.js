/*
 * VSPIMU V5.9 — Oracle Always Free / FastAPI / Inertia-1 client bridge
 *
 * LOAD ORDER (important):
 *   1. v5_gait.js
 *   2. v5_report_viewer_V5_9_FINAL.js   (recommended)
 *   3. v5_inertia1_oracle.js             (this file, LAST)
 *
 * The proven V5.8 gait engine is not rewritten here. This file wraps the
 * public receiveShortsCsv/start/stop/prepareReport API and leaves the core
 * acquisition, TCN, wavelet, AFO and retrospective reconciliation untouched.
 *
 * Deployment settings are loaded from v5_inertia1_config.js before this file.
 * Configure that asset after the local server / Tailscale Funnel host is known.
 */
(function(){
  'use strict';

  const REMOTE = window.VSPIMU_INERTIA1_CONFIG || {
    enabled: true,
    endpoint: 'https://REPLACE_WITH_TAILSCALE_FUNNEL_HOST.ts.net/api/v1/inertia/analyze',
    apiKey: 'REPLACE_WITH_VSPIMU_API_KEY',
    timeoutMs: 180000,
    sourceHz: 208,
    targetHz: 20,
    maxGapSec: 0.25,
    maxDurationSec: 180,
  };
  window.VSPIMU_INERTIA1_CONFIG = REMOTE;

  const original = window.VSPIMU;
  if(!original) return;

  const captured = new Map();
  const inertia = {
    status:'IDLE', error:'', startedMs:0, finishedMs:0,
    result:null, promise:null, sessionId:'', sampleCount:0,
    uploadCount:0, generation:0, abortController:null
  };
  let reportWaitTimer=0;
  let reportObserver=null;

  function safeText(id,v){ const e=document.getElementById(id); if(e)e.textContent=String(v); }
  function statusText(msg){
    safeText('inertia1Status',msg);
    safeText('reportStatus',msg);
  }
  function ensureStatusCard(){
    if(document.getElementById('inertia1Status')) return;
    const anchor=document.getElementById('reportStatus');
    if(!anchor || !anchor.parentNode) return;
    const card=document.createElement('div');
    card.className='card';
    card.id='inertia1StatusCard';
    card.style.marginTop='8px';
    card.innerHTML='<div class="label">Inertia-1 server analysis</div><div id="inertia1Status" class="value">IDLE</div><div id="inertia1StatusDetail" class="small">Runs once after STOP and local VSPIMU finalization.</div>';
    anchor.parentNode.insertBefore(card,anchor.nextSibling);
  }
  function detailText(v){ const e=document.getElementById('inertia1StatusDetail'); if(e)e.textContent=String(v); }
  function setInertiaStatus(s,d){
    inertia.status=s;ensureStatusCard();safeText('inertia1Status',s);detailText(d||'');
  }

  const HIDE_CSS=`
    #parityCard,#parityStatus,#parityDetail,#parityRaw,#parityEvents,#parityNumeric,#parityChecks{display:none!important}
    #vspimu58ReportOverlay [data-vspimu-parity],#vspimu58CoreReportOverlay [data-vspimu-parity]{display:none!important}
  `;
  function installParityHide(){
    if(document.getElementById('vspimu59NoParityCss'))return;
    const s=document.createElement('style');s.id='vspimu59NoParityCss';s.textContent=HIDE_CSS;document.head.appendChild(s);
    const oldTitle=document.title;
    document.title=oldTitle.replace(/\s*\+\s*ESP32↔APP\s*Parity\s*/i,'');
  }

  function csvToNumbers(csv){
    if(Array.isArray(csv))return csv.map(Number).filter(Number.isFinite);
    return String(csv).replace(/[\r\n]/g,'').split(',').map(s=>parseFloat(s.replace(/^"|"$/g,''))).filter(Number.isFinite);
  }
  function s16(v){let x=Math.round(v);x=((x+32768)%65536+65536)%65536-32768;return x;}
  function captureCsv(csv){
    const a=csvToNumbers(csv);if(a.length<8)return;
    const n=Math.floor(a.length/8);
    for(let i=0;i<n;i++){
      const b=i*8;
      const lo=(Math.round(a[b])&0xFFFF)>>>0,hi=(Math.round(a[b+1])&0xFFFF)>>>0;
      const seq=(lo+hi*65536)>>>0;
      captured.set(seq,[
        seq,
        s16(a[b+2]),s16(a[b+3]),s16(a[b+4])
      ]);
    }
    inertia.sampleCount=captured.size;
  }
  function clearCapture(){captured.clear();inertia.sampleCount=0;inertia.result=null;inertia.error='';}

  function prepare20Hz(){
    if(captured.size===0)throw new Error('No raw BLE samples were captured for server analysis.');
    const srcHz=REMOTE.sourceHz||208,targetHz=REMOTE.targetHz||20;
    const rows=Array.from(captured.values()).sort((a,b)=>a[0]-b[0]);
    const first=rows[0][0],last=rows[rows.length-1][0];
    const duration=Math.max(0,(last-first)/srcHz);
    if(duration<30)throw new Error('Session is shorter than the 30 s Inertia-1 window.');
    if(duration>REMOTE.maxDurationSec)throw new Error('Session exceeds configured safety limit.');

    const times=new Float64Array(rows.length);
    for(let i=0;i<rows.length;i++)times[i]=(rows[i][0]-first)/srcHz;
    const count=Math.floor(duration*targetHz+1e-9)+1;
    const out=new Float32Array(count*3);
    let j=0;
    for(let k=0;k<count;k++){
      const t=k/targetHz;
      while(j+1<rows.length && times[j+1]<t)j++;
      if(j>=rows.length-1){
        for(let c=0;c<3;c++)out[k*3+c]=rows[rows.length-1][c+1]*0.0001220703125;
        continue;
      }
      const t0=times[j],t1=times[j+1],gap=t1-t0;
      if(gap>REMOTE.maxGapSec)throw new Error(`Raw-data gap ${(gap).toFixed(3)} s exceeds server preprocessing limit.`);
      const u=gap<=1e-9?0:(t-t0)/gap;
      const u2=Math.max(0,Math.min(1,u));
      for(let c=0;c<3;c++){
        const v0=rows[j][c+1],v1=rows[j+1][c+1];
        out[k*3+c]=(v0+(v1-v0)*u2)*0.0001220703125;
      }
    }
    return {data:out,count,durationSec:duration,targetHz};
  }

  function f32Base64(f){
    const bytes=new Uint8Array(f.buffer,f.byteOffset,f.byteLength);
    let s='';
    const chunk=0x8000;
    for(let i=0;i<bytes.length;i+=chunk)s+=String.fromCharCode.apply(null,bytes.subarray(i,Math.min(bytes.length,i+chunk)));
    return btoa(s);
  }
  function makeSessionId(){
    const c=(typeof crypto!=='undefined')?crypto:null;
    if(c&&typeof c.randomUUID==='function')return c.randomUUID();
    return 'vspimu-'+Date.now()+'-'+Math.random().toString(36).slice(2);
  }

  async function upload(generationAtStart){
    if(!REMOTE.enabled)return null;
    if(generationAtStart!==inertia.generation)return null;
    if(!REMOTE.endpoint || /REPLACE_WITH/i.test(REMOTE.endpoint))throw new Error('Inertia-1 server endpoint is not configured.');
    if(!REMOTE.apiKey || /REPLACE_WITH/i.test(REMOTE.apiKey))throw new Error('Inertia-1 server API key is not configured.');
    const prepared=prepare20Hz();
    const sessionId=makeSessionId();inertia.sessionId=sessionId;inertia.startedMs=performance.now();
    setInertiaStatus('UPLOADING',`Preparing ${prepared.count} samples at ${prepared.targetHz} Hz…`);
    const ac=new AbortController();inertia.abortController=ac;const timer=setTimeout(()=>ac.abort(),REMOTE.timeoutMs);
    try{
      const body={
        schema_version:'vspimu-5.9',session_id:sessionId,
        sample_rate_hz:prepared.targetHz,
        source_sample_rate_hz:REMOTE.sourceHz,
        channels:['ax_g','ay_g','az_g'],
        samples_b64:f32Base64(prepared.data),sample_count:prepared.count,
        duration_sec:prepared.durationSec,
        metadata:{source:'VSPIMU',body_placement:'single_shank',local_server_prep:true}
      };
      const r=await fetch(REMOTE.endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':REMOTE.apiKey},body:JSON.stringify(body),signal:ac.signal});
      let data=null;try{data=await r.json();}catch(_){data={detail:'Non-JSON response'};}
      if(generationAtStart!==inertia.generation)return null;
      if(!r.ok){
        const detail=data&&data.detail?data.detail:data;
        const msg=typeof detail==='string'?detail:(detail&&detail.message)||`HTTP ${r.status}`;
        throw new Error(msg);
      }
      if(generationAtStart!==inertia.generation)return null;
      inertia.result=data;inertia.finishedMs=performance.now();inertia.uploadCount++;
      const isDemo=data.demo_backend===true||data.method==='demo'||data.engine==='VSPIMU-DEMO';
      if(isDemo){
        setInertiaStatus('DEMO ONLY',`Transport smoke test passed • ${data.windows_processed||0} windows • NOT Inertia-1 inference.`);
      }else{
        setInertiaStatus('READY',`Inertia-1 complete • ${data.windows_processed||0} windows • ${Number(data.server_elapsed_ms||0).toFixed(0)} ms server time.`);
      }
      return data;
    }finally{
      clearTimeout(timer);
      if(inertia.abortController===ac)inertia.abortController=null;
    }
  }

  async function runAfterStop(generationAtStart){
    if(generationAtStart!==inertia.generation)return;
    if(!REMOTE.enabled){setInertiaStatus('DISABLED','Server analysis is disabled in the client configuration.');return;}
    inertia.status='WAITING_FINALIZATION';setInertiaStatus('WAITING','Waiting for local VSPIMU finalization before uploading the session.');
    const deadline=performance.now()+180000;
    while(performance.now()<deadline){
      let s=null;try{s=original.state();}catch(e){}
      if(generationAtStart!==inertia.generation)return;
      if(s&&s.steps&&s.steps.ready){
        try{
          await upload(generationAtStart);
        }catch(e){
          inertia.error=e&&e.message?e.message:String(e);setInertiaStatus('ERROR',inertia.error);
        }
        scrubDashboardParityText();
        return;
      }
      await new Promise(r=>setTimeout(r,250));
    }
    inertia.error='Timed out waiting for VSPIMU local finalization.';setInertiaStatus('ERROR',inertia.error);scrubDashboardParityText();
  }

  function scrubKnownParityText(root){
    if(!root)return;
    const replacements=[
      [/native TCN \+ independent phone parity validation/ig,'native TCN + server-side Inertia-1 analysis'],
      [/ESP32→phone parity is checked after STOP/ig,'server analysis starts after STOP'],
      [/ESP32→phone parity/ig,'server analysis'],
      [/ESP32↔APP computational parity/ig,'ESP32/APP comparison'],
      [/ESP32↔APP PARITY/ig,'ESP32/APP comparison']
    ];
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    const nodes=[];let n;while((n=walker.nextNode()))nodes.push(n);
    for(const node of nodes){
      let v=node.nodeValue||'';
      for(const [re,to] of replacements)v=v.replace(re,to);
      if(v!==node.nodeValue)node.nodeValue=v;
    }
  }

  function stripParityFromDocument(root){
    if(!root)return;
    const headings=Array.from(root.querySelectorAll('h1,h2,h3'));
    for(const h of headings){
      if(!/parity|ESP32↔APP/i.test(h.textContent||''))continue;
      let n=h.nextSibling;h.remove();
      while(n){const next=n.nextSibling;if(n.nodeType===1 && /^H[1-3]$/.test(n.tagName))break;if(n.nodeType===1)n.remove();n=next;}
    }
    for(const el of Array.from(root.querySelectorAll('*'))){
      if(/^ESP32\s*↔\s*APP.*parity$/i.test((el.textContent||'').trim()) && el.children.length===0){
        const p=el.parentElement; if(p && p.children.length<=2) p.remove();
      }
    }
    scrubKnownParityText(root);
  }

  function scrubDashboardParityText(){
    const ids=['status','detail','reportStatus','modelDetail','journeyInstruction'];
    for(const id of ids)scrubKnownParityText(document.getElementById(id));
  }

  function inertiaReportHtml(){
    const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    if(inertia.status==='READY'&&inertia.result){
      const r=inertia.result;
      const dt=Number(r.server_elapsed_ms||0);
      const isDemo=r.demo_backend===true||r.method==='demo'||r.engine==='VSPIMU-DEMO';
      if(isDemo){
        return `<h2 data-vspimu-inertia="1">11. Server transport smoke test</h2><div class="summary warn" data-vspimu-inertia="1"><b>DEMO ONLY — NOT INERTIA-1 MODEL OUTPUT</b><div style="margin-top:6px">The API request/response path worked on ${Number(r.windows_processed||0)} × ${Number(r.window_sec||30)} s windows at ${Number(r.sample_rate_hz||20)} Hz. These values are simple synthetic statistics generated for a connectivity test; no Inertia-1 checkpoint was loaded.</div></div><div class="grid" data-vspimu-inertia="1"><div class="metric"><span class="muted">Backend</span><b>DEMO</b></div><div class="metric"><span class="muted">Windows processed</span><b>${Number(r.windows_processed||0)}</b></div><div class="metric"><span class="muted">Server time</span><b>${dt.toFixed(0)} ms</b></div></div><p class="small" data-vspimu-inertia="1">This section confirms transport only. It must not be interpreted as a motion-model embedding, gait event, diagnosis, or clinical result.</p>`;
      }
      return `<h2 data-vspimu-inertia="1">11. Inertia-1 server analysis</h2><div class="summary" data-vspimu-inertia="1"><b>Inertia-1 representation analysis complete</b><div style="margin-top:6px">Frozen-backbone embedding inference on ${Number(r.windows_processed||0)} × ${Number(r.window_sec||30)} s triaxial windows at ${Number(r.sample_rate_hz||20)} Hz.</div></div><div class="grid" data-vspimu-inertia="1"><div class="metric"><span class="muted">Method</span><b>${esc(r.method||'—')}</b></div><div class="metric"><span class="muted">Embedding dimension</span><b>${Number(r.embedding_dim||0)}</b></div><div class="metric"><span class="muted">Windows processed</span><b>${Number(r.windows_processed||0)}</b></div><div class="metric"><span class="muted">Server time</span><b>${dt.toFixed(0)} ms</b></div><div class="metric"><span class="muted">Covered duration</span><b>${Number(r.covered_duration_sec||0).toFixed(1)} s</b></div><div class="metric"><span class="muted">Dropped tail</span><b>${Number(r.dropped_tail_sec||0).toFixed(1)} s</b></div><div class="metric"><span class="muted">Mean embedding L2</span><b>${Number(r.window_embedding_l2_mean||0).toFixed(4)}</b></div><div class="metric"><span class="muted">Embedding L2 SD</span><b>${Number(r.window_embedding_l2_std||0).toFixed(4)}</b></div></div><p class="small" data-vspimu-inertia="1"><b>Interpretation boundary:</b> this is a pretrained-motion representation output. It is not a task-specific gait diagnosis, Parkinson’s classifier, FoG classifier, or validated clinical score. A task-specific downstream head and its validated checkpoint are required before calling a result a clinical prediction.</p>`;
    }
    const msg=esc(inertia.error||'Server analysis was not available.');
    return `<h2 data-vspimu-inertia="1">11. Inertia-1 server analysis</h2><div class="summary warn" data-vspimu-inertia="1"><b>Inertia-1 unavailable for this session</b><div style="margin-top:6px">${msg}</div><div style="margin-top:6px">The locally computed VSPIMU report remains valid and was not blocked by server failure.</div></div>`;
  }

  function renderInertiaReport(){
    const roots=[document.getElementById('vspimu59ReportContent'),document.getElementById('vspimu58ReportContent'),document.getElementById('vspimu58CoreReportDoc')];
    for(const root of roots){
      if(!root)continue;
      stripParityFromDocument(root);
      const report=root.querySelector('.report-document')||root;
      if(report.querySelector('[data-vspimu-inertia="1"]'))continue;
      const wrap=document.createElement('div');wrap.innerHTML=inertiaReportHtml();
      for(const n of Array.from(wrap.children))report.appendChild(n);
      const isDemo=!!(inertia.result&&(inertia.result.demo_backend===true||inertia.result.method==='demo'||inertia.result.engine==='VSPIMU-DEMO'));
      safeText('reportStatus',inertia.status==='READY'?(isDemo?'Transport smoke test complete — DEMO ONLY, not Inertia-1.':'Final report ready — Inertia-1 results included.'):`Final report ready — Inertia-1 ${inertia.status.toLowerCase()}.`);
      return;
    }
  }

  function watchReport(){
    installParityHide();
    if(reportObserver)reportObserver.disconnect();
    reportObserver=new MutationObserver(()=>renderInertiaReport());
    reportObserver.observe(document.body,{subtree:true,childList:true});
    setTimeout(renderInertiaReport,150);
    setTimeout(()=>{if(reportObserver)reportObserver.disconnect();},10000);
  }

  // Wrap the proven raw BLE ingress; the original function remains authoritative.
  const oldReceive=original.receiveShortsCsv;
  original.receiveShortsCsv=function(csv){captureCsv(csv);return oldReceive.call(original,csv);};

  const oldStart=original.start;
  original.start=function(){
    inertia.generation++;
    if(inertia.abortController){try{inertia.abortController.abort();}catch(_){}}
    inertia.abortController=null;
    clearCapture();inertia.status='IDLE';ensureStatusCard();installParityHide();
    const result=oldStart.call(original);
    setInertiaStatus('RUNNING','Server analysis will start automatically after STOP.');
    return result;
  };

  const oldStop=original.stop;
  original.stop=function(){
    const result=oldStop.call(original);
    const generationAtStart=inertia.generation;
    setTimeout(()=>runAfterStop(generationAtStart),0);
    return result;
  };

  const oldReset=original.reset;
  original.reset=function(){
    inertia.generation++;
    if(inertia.abortController){try{inertia.abortController.abort();}catch(_){}}
    inertia.abortController=null;
    clearCapture();if(reportObserver)reportObserver.disconnect();setInertiaStatus('IDLE','Session reset.');return oldReset.call(original);
  };

  // Do not allow stale analytics/parity packets to influence the V5.9 UI.
  original.receiveEspAnalyticsCsv=function(){return false;};

  // Report button: wait for remote analysis if it is currently running; otherwise
  // preserve the proven report path untouched.
  const oldPrepare=original.prepareReport;
  original.prepareReport=function(){
    let s=null;try{s=original.state();}catch(e){}
    if(s && s.steps && s.steps.ready && (inertia.status==='WAITING_FINALIZATION'||inertia.status==='UPLOADING')){
      if(reportWaitTimer)return null;
      setInertiaStatus(inertia.status,'Remote analysis is still running; the final report will open automatically when it returns.');
      reportWaitTimer=setInterval(()=>{
        if(inertia.status==='READY'||inertia.status==='ERROR'){
          clearInterval(reportWaitTimer);reportWaitTimer=0;
          try{oldPrepare.call(original);watchReport();}catch(e){console.error(e);}
        }
      },250);
      return null;
    }
    const out=oldPrepare.call(original);watchReport();return out;
  };

  ensureStatusCard();installParityHide();
  scrubDashboardParityText();
  setInterval(scrubDashboardParityText,500);
  // Public diagnostic accessor; no raw data is exposed through this object.
  original.inertia1=function(){return JSON.parse(JSON.stringify({status:inertia.status,error:inertia.error,result:inertia.result,sessionId:inertia.sessionId,sampleCount:inertia.sampleCount,uploadCount:inertia.uploadCount}));};
})();
