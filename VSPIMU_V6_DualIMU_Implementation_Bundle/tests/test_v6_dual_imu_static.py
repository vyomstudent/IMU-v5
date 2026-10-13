"""Dependency-free structural checks for the patched VSPIMU V6 HTML/add-on."""
from pathlib import Path
from html.parser import HTMLParser

ROOT = Path(__file__).resolve().parents[1]
HTML_PATH = ROOT / 'assets' / 'vspimu_v6_single.html'
JS_PATH = ROOT / 'assets' / 'v6_phone_imu.js'

class AuditParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids = []
        self.scripts = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs: self.ids.append(attrs['id'])
        if tag == 'script' and attrs.get('src'): self.scripts.append(attrs['src'])

html = HTML_PATH.read_text(encoding='utf-8')
js = JS_PATH.read_text(encoding='utf-8')
p = AuditParser(); p.feed(html); p.close()
assert len(p.ids) == len(set(p.ids)), 'duplicate HTML IDs found'
for expected in ['phoneCaptureOptIn','phonePocketSelect','phonePlacementDetailWrap','phoneImuStatus','phoneAccCount','phoneGyroCount','shankRawCount','syncQualityText','exportShankCsv','exportPhoneAccCsv','exportPhoneGyroCsv','exportEventsCsv','exportSummaryCsv','exportSyncCsv','exportSummaryJson','dualImuReportBtn','dualImuReportOverlay','dualImuReportFrame']:
    assert p.ids.count(expected) == 1, f'{expected} missing or duplicated'
expected_order = ['tf.min.js','v6_gait.js','v6_report_viewer_FINAL.js','v6_report_intelligence.js','v6_phone_imu.js']
positions = [p.scripts.index(x) for x in expected_order]
assert positions == sorted(positions), f'script order mismatch: {p.scripts}'
assert 'VSPIMUPhoneIMU' in js
assert "receiveShortsCsv" in js and "originalReceive.apply(this, arguments)" in js
assert 'SensorEvent.timestamp' in js
assert 'Not a diagnosis' in html or 'not a diagnosis' in html.lower()
print(f'PASS: {len(p.ids)} unique DOM IDs; required UI IDs once; existing engine/viewer precede addon; required APIs and limitations present.')
