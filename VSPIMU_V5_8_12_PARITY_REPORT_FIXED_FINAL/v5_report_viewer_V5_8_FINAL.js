/* VSPIMU V5.8 — robust in-WebViewer final report viewer */
(function(){
  'use strict';
  const ORIGINAL_PREPARE_MARK='__VSPIMU_V58_ORIGINAL_PREPARE__';
  function sendAIStatus(status,detail){
    try{if(window.AppInventor&&typeof window.AppInventor.setWebViewString==='function')window.AppInventor.setWebViewString(JSON.stringify({type:'status',status,detail}));}
    catch(e){console.warn('VSPIMU report status bridge',e);}
  }
  function css(){
    if(document.getElementById('vspimu58ReportCss'))return;
    const s=document.createElement('style');s.id='vspimu58ReportCss';
    s.textContent=`
      #vspimu58ReportOverlay{position:fixed;inset:0;z-index:99999;display:none;flex-direction:column;background:#e9eef5;overflow:hidden}
      #vspimu58ReportToolbar{height:58px;flex:0 0 58px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 12px;background:#fff;border-bottom:1px solid #cbd5e1;box-shadow:0 2px 9px rgba(15,23,42,.12)}
      #vspimu58ReportToolbarTitle{min-width:0;font:800 14px/1.1 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#172033}
      #vspimu58ReportToolbarSub{margin-top:3px;font:10px/1.2 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #vspimu58BackBtn{border:0;border-radius:8px;padding:9px 13px;background:#0f766e;color:#fff;font:800 11px system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;flex:0 0 auto}
      #vspimu58FrameWrap{position:relative;flex:1;min-height:0;background:#dfe6ee;overflow:auto}
      #vspimu58ReportContent{max-width:1050px;margin:0 auto;min-height:100%;padding:8px 10px 18px;background:#fff}
      #vspimu58ReportContent svg{max-width:100%;height:auto}
      #vspimu58ReportContent img{max-width:100%;height:auto}
      #vspimu58ReportLoading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#fff;color:#334155;font:800 14px system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
      body.vspimu58ReportOpen{overflow:hidden}
    `;
    document.head.appendChild(s);
  }
  function ensureOverlay(){
    let overlay=document.getElementById('vspimu58ReportOverlay');
    if(overlay)return overlay;
    css();
    overlay=document.createElement('div');overlay.id='vspimu58ReportOverlay';overlay.setAttribute('aria-label','VSPIMU final doctor and user report');
    overlay.innerHTML=`
      <div id="vspimu58ReportToolbar"><div style="min-width:0"><div id="vspimu58ReportToolbarTitle">VSPIMU — Final Doctor + User Report</div><div id="vspimu58ReportToolbarSub">Generated locally after full-session reconciliation • V5.8</div></div><button id="vspimu58BackBtn" type="button">BACK TO ANALYSIS</button></div>
      <div id="vspimu58FrameWrap"><div id="vspimu58ReportContent"></div><div id="vspimu58ReportLoading">Preparing report…</div></div>`;
    document.body.appendChild(overlay);
    const back=overlay.querySelector('#vspimu58BackBtn');if(back)back.addEventListener('click',closeReport);
    return overlay;
  }
  function closeReport(){
    const overlay=document.getElementById('vspimu58ReportOverlay');
    const content=document.getElementById('vspimu58ReportContent');
    const loading=document.getElementById('vspimu58ReportLoading');
    if(content)content.innerHTML='';
    if(overlay)overlay.style.display='none';
    if(loading){loading.style.display='flex';loading.textContent='Preparing report…';}
    document.body.classList.remove('vspimu58ReportOpen');
    sendAIStatus('READY','Report closed — analysis dashboard restored.');
  }
  function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
  function formatTime(sec){if(!Number.isFinite(sec)||sec<0)return '—';const s=Math.round(sec),m=Math.floor(s/60),r=s%60;return String(m).padStart(2,'0')+':'+String(r).padStart(2,'0');}
  function enrichReport(html,snapshot){
    if(!html||!snapshot)return html;
    try{
      const steps=snapshot.steps||{},m=snapshot.metrics||{},activity=snapshot.activity||{},protocol=snapshot.protocol||{},detector=snapshot.stepDetector||{};
      const n=v=>Number.isFinite(Number(v))?String(Math.round(Number(v))):'—';
      const f=(v,d=1)=>Number.isFinite(Number(v))?Number(v).toFixed(d):'—';
      const block=`<div class="callout" style="margin:8px 0 12px;border-left-color:#2563eb;background:#eff6ff"><b>V5.8 step-count validation summary</b><br><span class="small">Final estimated total steps: <b>${esc(n(steps.final))}</b> • Live provisional steps: <b>${esc(n(steps.live))}</b> • Direct same-shank anchors: <b>${esc(n(steps.observed))}</b> • Wavelet-confirmed events: <b>${esc(n(steps.waveletConfirmed))}</b> • TCN-validated events: <b>${esc(n(steps.tcnValidated))}</b> • Signal candidates: <b>${esc(n(detector.candidates))}</b> • Cadence: <b>${esc(f(m.cadence))} steps/min</b> • Stride variability: <b>${esc(f(m.cv))}% CV</b> • Detected walking time: <b>${esc(formatTime(activity.activeSec))}</b> • 123-second protocol: <b>${protocol.complete?'COMPLETE':'INCOMPLETE'}</b>.</span><br><span class="small">The live count is provisional. The final count is retrospectively reconciled. Because this V5 configuration directly measures one shank, total steps remain an estimate until bilateral shank sensing is implemented.</span></div>`;
      return html.includes('<h2>3. Frequency and oscillation measures</h2>')?html.replace('<h2>3. Frequency and oscillation measures</h2>',block+'<h2>3. Frequency and oscillation measures</h2>'):html.includes('</body>')?html.replace('</body>',block+'</body>'):html+block;
    }catch(e){console.warn('VSPIMU report enrichment',e);return html;}
  }
  function paritySummaryBlock(snapshot){
    const p=snapshot&&snapshot.parity;if(!p)return '';
    const verdict=String(p.verdict||'NOT READY'),r=p.report||{},hard=Array.isArray(r.hard)?r.hard:[],num=Array.isArray(r.numeric)?r.numeric:[];
    const hf=hard.filter(x=>x&&x.ok===false).length,nw=num.filter(x=>x&&x.status==='WARN').length,cls=verdict==='PASS'?'good':verdict==='WARN'?'warn':'review';
    return `<div class="summary ${cls}" style="margin:8px 0 12px"><b>ESP32↔APP PARITY ${esc(verdict)}</b><div class="small" style="margin-top:5px">Hard failures: ${hf} • Numeric warnings: ${nw} • Summary packets: ${Number(p.summaryPackets||0)} • Event packets: ${Number(p.eventPackets||0)}. This is computational parity over the same raw session, not ground-truth gait accuracy.</div></div>`;
  }
  function addParityToReport(html,snapshot){const block=paritySummaryBlock(snapshot);if(!block||!html)return html;if(html.includes('<h2>1. Clinical screening interpretation</h2>'))return html.replace('<h2>1. Clinical screening interpretation</h2>',block+'<h2>1. Clinical screening interpretation</h2>');return html.includes('</body>')?html.replace('</body>',block+'</body>'):html+block;}
  function extractReport(html){
    const doc=new DOMParser().parseFromString(html,'text/html');
    let styles='';for(const st of Array.from(doc.head.querySelectorAll('style')))styles+=st.textContent||'';
    styles=styles.replace(/\bbody\b/g,'#vspimu58ReportContent').replace(/\bhtml\b/g,'#vspimu58ReportContent');
    return {body:doc.body?doc.body.innerHTML:html,styles};
  }
  function showReport(html,filename){
    const overlay=ensureOverlay(),content=overlay.querySelector('#vspimu58ReportContent'),loading=overlay.querySelector('#vspimu58ReportLoading'),sub=overlay.querySelector('#vspimu58ReportToolbarSub');
    if(sub)sub.textContent='Generated locally after full-session reconciliation • '+(filename||'VSPIMU report')+' • V5.8';
    overlay.style.display='flex';document.body.classList.add('vspimu58ReportOpen');
    if(loading){loading.style.display='flex';loading.textContent='Preparing report…';}
    try{const r=extractReport(html);content.innerHTML='<style data-report-style>'+r.styles+'</style><div class="report-document">'+r.body+'</div>';content.scrollTop=0;if(loading)loading.style.display='none';sendAIStatus('REPORT','Final doctor + user report rendered directly inside WebViewer.');}
    catch(e){console.error('VSPIMU report viewer',e);if(loading){loading.style.display='flex';loading.textContent='Report render error: '+(e.message||String(e));}sendAIStatus('REPORT ERROR',e.message||String(e));}
  }
  function install(){
    if(!window.VSPIMU||typeof window.VSPIMU.prepareReport!=='function'){setTimeout(install,100);return;}
    window.VSPIMU.openPreparedReport=function(html,filename,snapshot){
      try{
        const snap=snapshot||(typeof window.VSPIMU.state==='function'?window.VSPIMU.state():null);
        let out=enrichReport(html,snap);out=addParityToReport(out,snap);
        showReport(out,filename||'VSPIMU_Report');
        return true;
      }catch(e){
        sendAIStatus('REPORT ERROR',e.message||String(e));
        console.error('VSPIMU report viewer',e);
        return false;
      }
    };
    window.VSPIMU.closeReport=closeReport;
    sendAIStatus('READY','V5.8 report viewer ready — final report renders directly in the WebViewer.');
  }

  install();
})();
