/*
 VSPIMU V5.8 — in-WebViewer final report viewer

 Purpose:
   Keep the existing V5.8 gait engine untouched.
   The engine still builds its full final report HTML and returns it from
   VSPIMU.prepareReport(). This companion layer:
     1) blocks REPORT_BEGIN / REPORT_CHUNK / REPORT_END from reaching App Inventor,
     2) keeps normal small status/error messages flowing to LabelStatus,
     3) opens the exact report HTML in a full-screen iframe inside WebViewer1,
     4) adds a concise step-validation block using VSPIMU.state(),
     5) provides a BACK TO ANALYSIS button.

 No TCN, step detector, wavelet, AFO, BLE, or clinical metric calculation is changed.
*/
(function(){
  'use strict';

  const BLOCKED_TYPES = new Set(['REPORT_BEGIN','REPORT_CHUNK','REPORT_END']);
  const SHIELD_MARK = '__VSPIMU_V58_REPORT_SHIELD__';
  const ORIGINAL_PREPARE_MARK = '__VSPIMU_V58_ORIGINAL_PREPARE__';

  function safeJson(value){
    try{return JSON.parse(value);}catch(_){return null;}
  }

  function installBridgeShield(){
    if(!window.AppInventor || typeof window.AppInventor.setWebViewString!=='function') return;
    if(window[SHIELD_MARK]) return;

    const original = window.AppInventor.setWebViewString.bind(window.AppInventor);
    window[SHIELD_MARK] = original;

    window.AppInventor.setWebViewString = function(value){
      const obj=safeJson(value);
      if(obj && BLOCKED_TYPES.has(obj.type)){
        // Suppress the large legacy report-transfer payload. It never crosses
        // into the App Inventor WebViewString bridge.
        return;
      }
      return original(value);
    };
  }

  function sendAIStatus(status,detail){
    try{
      if(window.AppInventor && typeof window.AppInventor.setWebViewString==='function'){
        window.AppInventor.setWebViewString(JSON.stringify({type:'status',status,detail}));
      }
    }catch(e){console.warn('VSPIMU report status bridge',e);}
  }

  function css(){
    if(document.getElementById('vspimu58ReportCss')) return;
    const s=document.createElement('style');
    s.id='vspimu58ReportCss';
    s.textContent=`
      #vspimu58ReportOverlay{position:fixed;inset:0;z-index:99999;display:none;flex-direction:column;background:#e9eef5;overflow:hidden}
      #vspimu58ReportToolbar{height:58px;flex:0 0 58px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 12px;background:#fff;border-bottom:1px solid #cbd5e1;box-shadow:0 2px 9px rgba(15,23,42,.12)}
      #vspimu58ReportToolbarTitle{min-width:0;font:800 14px/1.1 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#172033}
      #vspimu58ReportToolbarSub{margin-top:3px;font:10px/1.2 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #vspimu58BackBtn{border:0;border-radius:8px;padding:9px 13px;background:#0f766e;color:#fff;font:800 11px system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;flex:0 0 auto}
      #vspimu58FrameWrap{position:relative;flex:1;min-height:0;background:#dfe6ee}
      #vspimu58Frame{width:100%;height:100%;border:0;display:block;background:#fff}
      #vspimu58Loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#fff;color:#334155;font:800 14px system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
      body.vspimu58ReportOpen{overflow:hidden}
    `;
    document.head.appendChild(s);
  }

  function ensureOverlay(){
    let overlay=document.getElementById('vspimu58ReportOverlay');
    if(overlay) return overlay;
    css();
    overlay=document.createElement('div');
    overlay.id='vspimu58ReportOverlay';
    overlay.setAttribute('aria-label','VSPIMU final doctor and user report');
    overlay.innerHTML=`
      <div id="vspimu58ReportToolbar">
        <div style="min-width:0">
          <div id="vspimu58ReportToolbarTitle">VSPIMU — Final Doctor + User Report</div>
          <div id="vspimu58ReportToolbarSub">Generated locally after full-session reconciliation • V5.8</div>
        </div>
        <button id="vspimu58BackBtn" type="button">BACK TO ANALYSIS</button>
      </div>
      <div id="vspimu58FrameWrap">
        <iframe id="vspimu58Frame" title="VSPIMU final report" src="about:blank"></iframe>
        <div id="vspimu58Loading">Preparing report…</div>
      </div>
    `;
    document.body.appendChild(overlay);
    const back=overlay.querySelector('#vspimu58BackBtn');
    if(back) back.addEventListener('click',closeReport);
    return overlay;
  }

  function closeReport(){
    const overlay=document.getElementById('vspimu58ReportOverlay');
    const frame=document.getElementById('vspimu58Frame');
    const loading=document.getElementById('vspimu58Loading');
    if(frame){
      try{frame.srcdoc='<!doctype html><html><body></body></html>';}catch(_){frame.src='about:blank';}
    }
    if(overlay) overlay.style.display='none';
    if(loading){loading.style.display='flex';loading.textContent='Preparing report…';}
    document.body.classList.remove('vspimu58ReportOpen');
    sendAIStatus('READY','Report closed — analysis dashboard restored.');
  }

  function esc(v){
    return String(v===undefined||v===null?'':v)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function enrichReport(html,snapshot){
    if(!html || !snapshot) return html;
    try{
      const steps=snapshot.steps||{};
      const m=snapshot.metrics||{};
      const activity=snapshot.activity||{};
      const protocol=snapshot.protocol||{};
      const detector=snapshot.stepDetector||{};
      const finalSteps=Number.isFinite(Number(steps.final))?String(Math.round(Number(steps.final))):'—';
      const liveSteps=Number.isFinite(Number(steps.live))?String(Math.round(Number(steps.live))):'—';
      const observed=Number.isFinite(Number(steps.observed))?String(Math.round(Number(steps.observed))):'—';
      const wavelet=Number.isFinite(Number(steps.waveletConfirmed))?String(Math.round(Number(steps.waveletConfirmed))):'—';
      const tcn=Number.isFinite(Number(steps.tcnValidated))?String(Math.round(Number(steps.tcnValidated))):'—';
      const cadence=Number.isFinite(Number(m.cadence))?Number(m.cadence).toFixed(1)+' steps/min':'—';
      const cv=Number.isFinite(Number(m.cv))?Number(m.cv).toFixed(1)+'% CV':'—';
      const walking=Number.isFinite(Number(activity.activeSec))?formatTime(Number(activity.activeSec)):'—';
      const protocolState=protocol.complete?'COMPLETE':'INCOMPLETE';
      const candidate=Number.isFinite(Number(detector.candidates))?String(Math.round(Number(detector.candidates))):'—';

      const block=`
      <div class="callout" style="margin:8px 0 12px;border-left-color:#2563eb;background:#eff6ff">
        <b>V5.8 step-count validation summary</b><br>
        <span class="small">Final estimated total steps: <b>${esc(finalSteps)}</b> • Live provisional steps: <b>${esc(liveSteps)}</b> • Direct same-shank anchors: <b>${esc(observed)}</b> • Wavelet-confirmed events: <b>${esc(wavelet)}</b> • TCN-validated events: <b>${esc(tcn)}</b> • Signal candidates: <b>${esc(candidate)}</b> • Cadence: <b>${esc(cadence)}</b> • Stride variability: <b>${esc(cv)}</b> • Detected walking time: <b>${esc(walking)}</b> • 123-second protocol: <b>${esc(protocolState)}</b>.</span>
        <br><span class="small">The live count is provisional. The final count is retrospectively reconciled. Because this V5 configuration directly measures one shank, total steps remain an estimate until bilateral shank sensing is implemented.</span>
      </div>`;

      // Insert into the existing report without changing its original report structure.
      if(html.includes('<h2>3. Frequency and oscillation measures</h2>')){
        return html.replace('<h2>3. Frequency and oscillation measures</h2>',block+'<h2>3. Frequency and oscillation measures</h2>');
      }
      if(html.includes('</body>')) return html.replace('</body>',block+'</body>');
      return html+block;
    }catch(e){
      console.warn('VSPIMU report enrichment',e);
      return html;
    }
  }

  function formatTime(sec){
    if(!Number.isFinite(sec)||sec<0) return '—';
    const s=Math.round(sec),m=Math.floor(s/60),r=s%60;
    return String(m).padStart(2,'0')+':'+String(r).padStart(2,'0');
  }

  function showReport(html,filename){
    const overlay=ensureOverlay();
    const frame=overlay.querySelector('#vspimu58Frame');
    const loading=overlay.querySelector('#vspimu58Loading');
    const sub=overlay.querySelector('#vspimu58ReportToolbarSub');
    if(sub){sub.textContent='Generated locally after full-session reconciliation • '+(filename||'VSPIMU report')+' • V5.8';}
    overlay.style.display='flex';
    document.body.classList.add('vspimu58ReportOpen');
    if(loading){loading.style.display='flex';loading.textContent='Preparing report…';}

    let finished=false;
    const finish=()=>{
      if(finished) return;
      finished=true;
      if(loading) loading.style.display='none';
      sendAIStatus('REPORT','Stage 2/3 — final doctor + user report rendered inside WebViewer.');
    };
    frame.onload=finish;

    try{
      frame.srcdoc=html;
      // Defensive fallback for a WebView that does not fire iframe.onload promptly.
      setTimeout(()=>{
        try{
          if(!finished && frame.contentDocument && frame.contentDocument.body && frame.contentDocument.body.innerHTML.length>100) finish();
        }catch(_){/* no-op */}
      },2500);
    }catch(e){
      try{
        const doc=frame.contentDocument||frame.contentWindow.document;
        doc.open();doc.write(html);doc.close();
        setTimeout(finish,100);
      }catch(e2){
        if(loading) loading.textContent='Report render error';
        sendAIStatus('REPORT ERROR',e2.message||String(e2));
        console.error('VSPIMU report iframe',e2);
      }
    }
  }

  function install(){
    installBridgeShield();
    if(!window.VSPIMU || typeof window.VSPIMU.prepareReport!=='function'){
      setTimeout(install,100);
      return;
    }
    if(window[ORIGINAL_PREPARE_MARK]) return;

    const original=window.VSPIMU.prepareReport;
    window[ORIGINAL_PREPARE_MARK]=original;

    window.VSPIMU.prepareReport=function(){
      installBridgeShield();
      let result=null;
      try{
        result=original.apply(window.VSPIMU,arguments);
      }catch(e){
        sendAIStatus('REPORT ERROR',e.message||String(e));
        throw e;
      }
      if(result && result.html){
        try{
          const snapshot=(typeof window.VSPIMU.state==='function')?window.VSPIMU.state():null;
          const html=enrichReport(result.html,snapshot);
          sendAIStatus('REPORT','Stage 1/3 — final report generated locally. Opening report viewer…');
          showReport(html,result.filename||'VSPIMU_Report');
        }catch(e){
          sendAIStatus('REPORT ERROR',e.message||String(e));
          console.error('VSPIMU report viewer',e);
        }
      }
      return result;
    };

    window.VSPIMU.closeReport=closeReport;
    sendAIStatus('READY','V5.8 report viewer ready — large report payloads stay inside the WebViewer.');
  }

  install();
})();
