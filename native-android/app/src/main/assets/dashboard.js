(function (root) {
  'use strict';
  const UNAVAILABLE = 'Unavailable';
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const label = value => typeof value === 'string' && value.trim() ? value.slice(0, 2000) : UNAVAILABLE;
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : UNAVAILABLE;
  const quantity = (value, unit) => number(value) ? `${value} ${unit}` : UNAVAILABLE;
  const fields = value => object(value) ? value : {};

  // This boundary accepts evidence only. It never fills missing values with demo data.
  function summarize(input) {
    const valid = object(input) && input.schemaVersion === 1;
    const source = valid ? input : {};
    const counts = fields(source.counts);
    const quality = fields(source.quality);
    const rates = fields(source.rates);
    const units = fields(source.recentUnits);
    const streams = ['shank', 'acc', 'gyro'].map(key => ({
      key, count: count(counts[key]), rate: quantity(rates[key], 'Hz')
    }));
    const knownCounts = streams.every(stream => stream.count !== UNAVAILABLE);
    const active = streams.filter(stream => stream.count !== UNAVAILABLE && Number(stream.count) > 0).length;
    const placement = typeof source.placement === 'string' ? label(source.placement) :
      object(source.placement) ? Object.entries(source.placement).slice(0, 20)
        .filter(([, value]) => typeof value === 'string' || typeof value === 'boolean')
        .map(([key, value]) => `${label(key)}: ${typeof value === 'boolean' ? String(value) : label(value)}`).join('; ') || UNAVAILABLE : UNAVAILABLE;
    const recent = Array.isArray(source.recent) ? source.recent.slice(-240).map(point => {
      const value = fields(point);
      return { t: number(value.t) ? value.t : null,
        accMagnitude: number(value.accMagnitude) ? value.accMagnitude : null,
        gyroMagnitude: number(value.gyroMagnitude) ? value.gyroMagnitude : null };
    }) : [];
    const limitations = Array.isArray(source.limitations) ? source.limitations
      .filter(value => typeof value === 'string' && value.trim()).slice(0, 40).map(label) : [];
    const events = Array.isArray(source.events) ? source.events.slice(-40).filter(object)
      .map(event => `${label(event.kind)}: ${label(event.text)}`) : [];
    return {
      valid, sessionId: label(source.sessionId), status: label(source.status),
      elapsed: quantity(source.elapsedSeconds, 's'), placement, streams,
      activeStreams: knownCounts ? `${active} of 3 streams have recorded samples` : 'Stream count unavailable',
      quality: [['Sequence gaps', count(quality.gaps)], ['Duplicate records', count(quality.duplicates)],
        ['Malformed packets', count(quality.malformed)], ['Interrupted', typeof quality.interrupted === 'boolean' ? (quality.interrupted ? 'Yes' : 'No') : UNAVAILABLE]],
      recent, units: { accMagnitude: label(units.accMagnitude), gyroMagnitude: label(units.gyroMagnitude) },
      limitations, events, modelStatus: label(source.modelStatus)
    };
  }

  function render(input) {
    const state = summarize(input);
    if (!root.document) return state;
    const document = root.document;
    const host = document.getElementById('dashboard');
    if (!host) return state;
    function element(tag, text, className) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    function section(title) {
      const node = element('section');
      node.appendChild(element('h2', title));
      host.appendChild(node);
      return node;
    }
    function description(parent, rows) {
      const list = element('dl');
      rows.forEach(([key, value]) => { list.appendChild(element('dt', key)); list.appendChild(element('dd', value)); });
      parent.appendChild(list);
    }
    function list(parent, rows, absent) {
      if (!rows.length) { parent.appendChild(element('p', absent, 'muted')); return; }
      const node = element('ul');
      rows.forEach(row => node.appendChild(element('li', row)));
      parent.appendChild(node);
    }
    host.replaceChildren();
    host.appendChild(element('p', 'VSPIMU • SESSION EVIDENCE', 'eyebrow'));
    host.appendChild(element('h1', 'Your recorded session'));
    host.appendChild(element('p', 'Read-only evidence view. Use the native controls to connect, record, stop, export or delete.', 'notice'));
    if (!state.valid) host.appendChild(element('p', 'Snapshot v1 unavailable. Session evidence cannot be displayed until a valid snapshot arrives.', 'notice error'));
    description(section('Session'), [['Status', state.status], ['Session ID', state.sessionId], ['Elapsed time', state.elapsed], ['Placement', state.placement]]);
    const sensors = section('Recorded streams');
    sensors.appendChild(element('p', state.activeStreams));
    description(sensors, state.streams.flatMap(stream => [[`${{ shank: 'Shank', acc: 'Phone accelerometer', gyro: 'Phone gyroscope' }[stream.key]} samples`, stream.count], [`${stream.key} rate`, stream.rate]]));
    sensors.appendChild(element('p', 'Sample counts show recording evidence; connection and sensor availability are managed by the native controls.', 'muted'));
    const signals = section('Recent signal');
    signals.appendChild(element('p', 'Descriptive magnitudes only. Shank and phone recordings remain separate. These plots do not estimate gait, joint angles or clinical risk.', 'muted'));
    for (const key of ['accMagnitude', 'gyroMagnitude']) {
      const title = key === 'accMagnitude' ? 'Acceleration magnitude' : 'Gyroscope magnitude';
      const points = state.recent.map(point => point[key]);
      const available = points.filter(value => value !== null);
      signals.appendChild(element('p', `${title} • units: ${state.units[key]}`, 'plot-label'));
      if (!available.length) { signals.appendChild(element('p', 'Recent values unavailable.', 'muted')); continue; }
      const min = Math.min(...available), max = Math.max(...available);
      signals.appendChild(element('p', `${available.length} reported values; range ${min}–${max}. Horizontal order follows the supplied recent samples; timing alignment is unavailable.`, 'muted'));
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 600 150'); svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `${title}, ${available.length} values, minimum ${min}, maximum ${max}; units ${state.units[key]}. Missing values break the line.`);
      svg.classList.add('plot');
      let pathData = '', started = false;
      points.forEach((value, index) => {
        if (value === null) { started = false; return; }
        const x = points.length > 1 ? 12 + index / (points.length - 1) * 576 : 300;
        // Scale before subtracting to keep very large finite inputs finite.
        const scale = Math.max(max, 1);
        const span = max / scale - min / scale;
        const y = span > 0 ? 138 - (value / scale - min / scale) / span * 126 : 75;
        pathData += `${started ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
        started = true;
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(y)); dot.setAttribute('r', '2'); dot.setAttribute('fill', '#00766b');
        svg.appendChild(dot);
      });
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData); path.classList.add('plot-line'); svg.appendChild(path);
      signals.appendChild(svg);
    }
    const qualitySection = section('Quality and uncertainty');
    description(qualitySection, state.quality);
    qualitySection.appendChild(element('p', 'Wearable sequence time is nominal 208 Hz. Phone acquisition uses a monotonic clock. BLE receipt time does not establish synchronized acquisition.', 'muted'));
    list(qualitySection, state.limitations, 'Session-specific limitations unavailable. This does not establish good recording quality.');
    list(section('Session evidence'), state.events, 'Session events unavailable.');
    const model = section('Model availability');
    description(model, [['Reported model status', state.modelStatus]]);
    model.appendChild(element('p', 'This dashboard displays recorded evidence. No model interpretation is inferred from an absent status.', 'muted'));
    return state;
  }
  root.VspimuUi = Object.freeze({ render });
  if (typeof module !== 'undefined' && module.exports) module.exports = { summarize, render };
  if (root.document) render(null);
})(typeof window !== 'undefined' ? window : globalThis);
