/* VSPIMU V5.9 — parity-free same-document final report viewer */
(function(){
  'use strict';
  function css(){
    if(document.getElementById('vspimu59ReportCss'))return;
    const s=document.createElement('style');s.id='vspimu59ReportCss';s.textContent=`
      #vspimu59ReportOverlay{position:fixed;inset:0;z-index:99999;display:none;flex-direction:column;background:#e9eef5;overflow:hidden}
      #vspimu59ReportToolbar{height:58px;flex:0 0 58px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 12px;background:#fff;border-bottom:1px solid #cbd5e1;box-shadow:0 2px 9px rgba(15,23,42,.12)}
      #vspimu59ReportToolbarTitle{font:800 14px/1.1 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#172033}
      #vspimu59ReportToolbarSub{margin-top:3px;font:10px/1.2 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #vspimu59ReportContent{flex:1;min-height:0;overflow:auto;padding:12px}
      #vspimu59ReportContent .report-document{max-width:1050px;margin:0 auto;background:#fff;min-height:100%;padding:8px 12px 22px}
      #vspimu59ReportContent .report-document img,#vspimu59ReportContent .report-document svg{max-width:100%;height:auto}
      #vspimu59ReportBack{border:0;border-radius:8px;padding:9px 12px;background:#0f766e;color:#fff;font:800 11px system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
    `;document.head.appendChild(s);
  }
  function ensure(){
    css();let o=document.getElementById('vspimu59ReportOverlay');
    if(o)return o;
    o=document.createElement('div');o.id='vspimu59ReportOverlay';o.innerHTML=`<div id="vspimu59ReportToolbar"><div style="min-width:0"><div id="vspimu59ReportToolbarTitle">VSPIMU — Final Doctor + User Report</div><div id="vspimu59ReportToolbarSub">Generated locally after full-session reconciliation • Inertia-1 server section appended separately</div></div><button id="vspimu59ReportBack" type="button">BACK TO ANALYSIS</button></div><div id="vspimu59ReportContent"></div>`;document.body.appendChild(o);
    o.querySelector('#vspimu59ReportBack').addEventListener('click',()=>{o.style.display='none';document.body.classList.remove('vspimu59ReportOpen');const rs=document.getElementById('reportStatus');if(rs)rs.textContent='Report closed — analysis dashboard restored.';});
    return o;
  }
  function extract(html){
    const doc=new DOMParser().parseFromString(String(html||''),'text/html');
    let styles='';for(const s of Array.from(doc.head?.querySelectorAll('style')||[]))styles+=s.textContent||'';
    styles=styles.replace(/\bbody\b/g,'#vspimu59ReportContent .report-document').replace(/\bhtml\b/g,'#vspimu59ReportContent .report-document');
    return {body:doc.body?doc.body.innerHTML:String(html||''),styles};
  }
  function scrubText(root){
    const replacements=[
      [/native TCN \+ independent phone parity validation/ig,'native TCN + server-side Inertia-1 analysis'],
      [/ESP32→phone parity is checked after STOP/ig,'server analysis starts after STOP'],
      [/ESP32→phone parity/ig,'server analysis'],
      [/ESP32↔APP computational parity/ig,'ESP32/APP comparison'],
      [/ESP32↔APP PARITY/ig,'ESP32/APP comparison']
    ];
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const nodes=[];let n;while((n=walker.nextNode()))nodes.push(n);
    for(const node of nodes){let v=node.nodeValue||'';for(const [re,to] of replacements)v=v.replace(re,to);if(v!==node.nodeValue)node.nodeValue=v;}
  }
  function removeParity(root){
    for(const h of Array.from(root.querySelectorAll('h1,h2,h3'))){
      if(!/parity|ESP32↔APP/i.test(h.textContent||''))continue;
      let n=h.nextSibling;h.remove();while(n){const next=n.nextSibling;if(n.nodeType===1 && /^H[1-3]$/.test(n.tagName))break;if(n.nodeType===1)n.remove();n=next;}
    }
    for(const e of Array.from(root.querySelectorAll('*'))){if(/^ESP32\s*↔\s*APP.*PARITY$/i.test((e.textContent||'').trim())&&e.children.length===0){const p=e.parentElement;if(p&&p.children.length<=2)p.remove();}}
    scrubText(root);
  }
  function show(html,filename){
    const o=ensure(),c=o.querySelector('#vspimu59ReportContent'),r=extract(html);c.innerHTML='<style>'+r.styles+'</style><div class="report-document">'+r.body+'</div>';removeParity(c);o.querySelector('#vspimu59ReportToolbarSub').textContent='Generated locally after full-session reconciliation • '+(filename||'VSPIMU report')+' • V5.9';o.style.display='flex';document.body.classList.add('vspimu59ReportOpen');c.scrollTop=0;return true;
  }
  function install(){
    if(!window.VSPIMU||typeof window.VSPIMU.prepareReport!=='function'){setTimeout(install,100);return;}
    window.VSPIMU.openPreparedReport=function(html,filename){try{return show(html,filename||'VSPIMU_Report');}catch(e){console.error('VSPIMU V5.9 report viewer',e);const rs=document.getElementById('reportStatus');if(rs)rs.textContent='Report viewer error: '+(e.message||String(e));return false;}};
    window.VSPIMU.closeReport=function(){const o=document.getElementById('vspimu59ReportOverlay');if(o)o.style.display='none';document.body.classList.remove('vspimu59ReportOpen');};
  }
  install();
})();
