'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, render } = require('../app/src/main/assets/dashboard.js');

test('snapshot v1 preserves zero values and reports streams with samples', () => {
  const result = summarize({ schemaVersion: 1, elapsedSeconds: 0, counts: { shank: 0, acc: 12, gyro: 10 },
    rates: { shank: 208, acc: 50, gyro: 50 }, quality: { gaps: 0, duplicates: 0, malformed: 0, interrupted: false } });
  assert.equal(result.activeStreams, '2 of 3 streams have recorded samples');
  assert.equal(result.elapsed, '0 s');
  assert.equal(result.streams[0].rate, '208 Hz');
  assert.deepEqual(result.quality, [['Sequence gaps', '0'], ['Duplicate records', '0'], ['Malformed packets', '0'], ['Interrupted', 'No']]);
});

test('partial sessions keep missing values unavailable without synthetic data', () => {
  const result = summarize({ schemaVersion: 1, sessionId: 'partial', counts: { acc: 0 }, recent: [{ accMagnitude: 0 }] });
  assert.equal(result.status, 'Unavailable');
  assert.equal(result.activeStreams, 'Stream count unavailable');
  assert.equal(result.streams[2].count, 'Unavailable');
  assert.equal(result.modelStatus, 'Unavailable');
  assert.equal(result.units.accMagnitude, 'Unavailable');
  assert.deepEqual(result.recent, [{ t: null, accMagnitude: 0, gyroMagnitude: null }]);
  assert.deepEqual(result.events, []);
});

test('invalid inputs and unsupported schemas fail closed', () => {
  for (const input of [null, [], 'snapshot', 42, {}, { schemaVersion: 2, sessionId: 'ignored' }]) {
    const result = summarize(input);
    assert.equal(result.valid, false);
    assert.equal(result.sessionId, 'Unavailable');
    assert.deepEqual(result.recent, []);
  }
});

test('unavailable numeric evidence cannot be coerced from strings or invalid numbers', () => {
  const result = summarize({ schemaVersion: 1, elapsedSeconds: NaN, counts: { shank: -1, acc: '10', gyro: 1.5 },
    rates: { acc: Infinity }, quality: { interrupted: 'false' }, recent: [null, { t: '2', accMagnitude: Infinity, gyroMagnitude: -2 }] });
  assert.ok(result.streams.every(stream => stream.count === 'Unavailable'));
  assert.equal(result.elapsed, 'Unavailable');
  assert.equal(result.quality[3][1], 'Unavailable');
  assert.ok(result.recent.every(point => point.t === null && point.accMagnitude === null && point.gyroMagnitude === null));
});

test('text boundary preserves literal markup without interpreting it', () => {
  const text = '<img src=x onerror=alert(1)>&"';
  const result = summarize({ schemaVersion: 1, sessionId: text, placement: { leg: text },
    limitations: [text, null], events: [{ kind: 'note', text }] });
  assert.equal(result.sessionId, text);
  assert.equal(result.placement, `leg: ${text}`);
  assert.deepEqual(result.limitations, [text]);
  assert.deepEqual(result.events, [`note: ${text}`]);
  assert.equal(render({ schemaVersion: 1, sessionId: text }).sessionId, text);
});

test('render puts untrusted evidence into textContent only', () => {
  const created = [];
  function node(tag) {
    const value = { tag, children: [], textContent: '', appendChild(child) { this.children.push(child); },
      replaceChildren() { this.children = []; } };
    Object.defineProperty(value, 'innerHTML', { set() { throw new Error('HTML interpretation is forbidden'); } });
    created.push(value);
    return value;
  }
  const host = node('main');
  const previous = globalThis.document;
  globalThis.document = { createElement: node, getElementById: () => host };
  try {
    const text = '<script>alert("untrusted")</script>';
    render({ schemaVersion: 1, sessionId: text, status: text, limitations: [text], events: [{ kind: 'note', text }] });
    assert.ok(created.some(value => value.tag === 'dd' && value.textContent === text));
    assert.ok(created.some(value => value.tag === 'li' && value.textContent === text));
    assert.ok(!created.some(value => value.tag === 'script'));
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test('recent evidence and text payloads are bounded and snapshots are not mutated', () => {
  const input = { schemaVersion: 1, sessionId: 'x'.repeat(3000), recent: Array.from({ length: 400 }, (_, t) => ({ t, accMagnitude: t })) };
  const result = summarize(input);
  assert.equal(result.recent.length, 240);
  assert.equal(result.recent[0].t, 160);
  assert.equal(result.sessionId.length, 2000);
  assert.equal(input.recent.length, 400);
});
