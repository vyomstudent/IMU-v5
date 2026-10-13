"""Browser smoke test for the actual patched VSPIMU HTML shell.

Uses a mocked VSPIMU core because the user's deployed v6_gait.js / model weights
are deliberately not bundled or replaced. This verifies DOM + additive bridge wiring,
not actual gait inference, Android sensors, BLE hardware, or clinical performance.
Requires: playwright Python package and an available Chromium installation.
"""
from pathlib import Path
import json
import shutil
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML_PATH = ROOT / "assets" / "vspimu_v6_single.html"
MODULE_PATH = ROOT / "assets" / "v6_phone_imu.js"

html = HTML_PATH.read_text(encoding="utf-8")
module = MODULE_PATH.read_text(encoding="utf-8")
errors = []

# Stub the existing engine/viewer dependencies only for this integration harness.
# In the real app, the original assets remain untouched.
stubs = {
    '<script src="tf.min.js"></script>': '<script>window.tf = {};</script>',
    '<script src="v6_gait.js"></script>': '''<script>
      window.__bridgeMessages=[]; window.__originalReceived=0; window.__openedHtml='';
      window.__coreState={running:false,finalizationReady:true,finalizationInProgress:false,finalEvents:[],fc:[],finalStepCount:0};
      window.AppInventor={setWebViewString(s){window.__bridgeMessages.push(JSON.parse(s));}};
      window.VSPIMU={
        updatePatient(){}, shareReport(){}, printReport(){}, closeReport(){},
        receiveShortsCsv(csv){window.__originalReceived++;},
        start(){window.__coreState.running=true;window.__coreState.finalizationReady=false;return 'core-start-ok';},
        stop(){window.__coreState.running=false;window.__coreState.finalizationReady=true;return 'core-stop-ok';},
        state(){return {...window.__coreState};},
        openPreparedReport(html,filename,snapshot){window.__openedHtml=html;return true;},
        prepareReport(){const html='<!doctype html><html><body><h1>Original core report</h1></body></html>';const filename='Smoke_Report';const result={html,filename};this.openPreparedReport(html,filename,this.state());return result;}
      };
    </script>''',
    '<script src="v6_report_viewer_FINAL.js"></script>': '<script>/* viewer intentionally stubbed in this test */</script>',
    '<script src="v6_report_intelligence.js"></script>': '<script>/* intelligence intentionally stubbed in this test */</script>',
    '<script src="v6_phone_imu.js"></script>': '<script>\n' + module + '\n</script>',
}
for needle, replacement in stubs.items():
    if needle not in html:
        raise RuntimeError(f"Expected script include missing from patched HTML: {needle}")
    html = html.replace(needle, replacement, 1)

with sync_playwright() as p:
    executable = shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")
    launch_args = {"headless": True, "args": ["--no-sandbox"]}
    if executable:
        launch_args["executable_path"] = executable
    browser = p.chromium.launch(**launch_args)
    page = browser.new_page()
    page.on("pageerror", lambda exc: errors.append("PAGE: " + str(exc)))
    page.on("console", lambda msg: errors.append("CONSOLE: " + msg.text) if msg.type == "error" else None)
    page.set_content(html, wait_until="load")
    page.wait_for_function("!!window.VSPIMUPhoneIMU")

    # The live HTML UI exists, placement validation works, and the addon loaded.
    for required in [
        "phoneCaptureOptIn", "phonePocketSelect", "phonePlacementDetailWrap",
        "phoneImuStatus", "phoneAccCount", "phoneGyroCount", "shankRawCount",
        "syncQualityText", "exportShankCsv", "exportPhoneAccCsv", "dualImuReportBtn",
        "dualImuReportOverlay", "dualImuReportFrame"
    ]:
        assert page.locator(f"#{required}").count() == 1, f"missing/nonunique id {required}"

    page.locator("#phoneCaptureOptIn").check()
    page.locator("#phonePocketSelect").select_option("other_declared")
    assert page.locator("#phonePlacementDetailWrap").evaluate("e => getComputedStyle(e).display") != "none"
    page.locator("#phonePlacementDetail").fill("fixed waist pouch")
    page.locator("#phonePocketSelect").select_option("left_front_pocket")
    assert page.locator("#phonePlacementDetailWrap").evaluate("e => getComputedStyle(e).display") == "none"

    initial = page.evaluate("""() => {
      const api=window.VSPIMUPhoneIMU;
      const started=window.VSPIMU.start();
      api.setNativeSensorStatus(true,true,true,true);
      const base=Date.now(); const batch=[];
      for(let i=0;i<120;i++){
        batch.push(['acc',base+i*20,0,Math.sin(i*.1),Math.cos(i*.1),9.7]);
        batch.push(['gyro',base+i*20,5000000000+i*20000000,Math.sin(i*.1),Math.cos(i*.1),.1]);
      }
      const ingestion=api.ingestBatch(batch);
      const raw=[];
      for(let i=0;i<240;i++){
        const a=Math.round(300*Math.sin(i*.1)), b=Math.round(200*Math.cos(i*.13));
        raw.push(i&65535,(i>>>16)&65535,a,b,8000,a*2,b*2,0);
      }
      window.VSPIMU.receiveShortsCsv(raw.join(','));
      const stopped=window.VSPIMU.stop();
      return {started,stopped,ingestion,originalReceived:window.__originalReceived,
        bridge:window.__bridgeMessages.map(x=>x.type+':'+x.command),version:api.version,
        counts:{acc:api._test.state.phoneAcc.length,gyro:api._test.state.phoneGyro.length,shank:api._test.state.shank.length}};
    }""")
    page.wait_for_timeout(1350)
    final = page.evaluate("""() => {
      const api=window.VSPIMUPhoneIMU; const summary=api.getSummary();
      const prepared=window.VSPIMU.prepareReport();
      return {finalized:api._test.state.finalized, coreReady:summary.coreAnalysis.finalizationReady,
        shankSamples:summary.shank.sampleCount, phoneAccQuality:summary.phoneAccelerometer.quality,
        phoneGyroQuality:summary.phoneGyroscope.quality,
        resultHasSection:prepared.html.includes('vspimu-dual-imu-report'),
        originalReportRetained:prepared.html.includes('Original core report'),
        handoffHasSection:window.__openedHtml.includes('vspimu-dual-imu-report')};
    }""")
    browser.close()

assert initial["version"] == "6.0.0", initial
assert initial["originalReceived"] == 1, initial
assert initial["ingestion"]["accepted"] == 240, initial
assert initial["counts"] == {"acc": 120, "gyro": 120, "shank": 240}, initial
assert final["finalized"] and final["coreReady"], final
assert final["shankSamples"] == 240, final
assert final["resultHasSection"] and final["originalReportRetained"] and final["handoffHasSection"], final
assert not errors, errors
print(json.dumps({"result":"PASS", "test":"patched HTML DOM + add-on bridge + raw capture + stop/finalization + report handoff", "initial":initial, "final":final, "errors":errors}, indent=2))
