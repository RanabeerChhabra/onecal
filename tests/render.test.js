const test = require('node:test');
const assert = require('node:assert');
const { core } = require('./helpers');

test('render: oversized observations are shrunk to fit Calendar property limits', () => {
  const o = { src: 'gm:a@x:t', kind: 'email', acct: 'a@x', founder: 'R', status: 'confirmed', title: 'x'.repeat(300),
    start: 1, end: 2, tz: 'Asia/Kolkata', attendees: Array.from({ length: 40 }, (_, i) => `person${i}@example.com`),
    with: Array.from({ length: 10 }, (_, i) => `Person Number ${i}`), evidence: 'e'.repeat(200), link: 'https://mail.google.com/' + 'x'.repeat(100),
    confidence: 0.9, asOf: 3 };
  const s = core.Render.compactObs(o);
  assert.ok(s.length <= 1000, String(s.length));
  const back = core.Render.expandObs(s);
  assert.strictEqual(back.start, 1);
  assert.ok(Array.isArray(back.attendees));
});
