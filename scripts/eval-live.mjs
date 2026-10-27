// Live extraction check: sends each sample email in tests/fixtures to the real model and compares
// with the expected result. Costs well under $0.01 per run on Claude Haiku 5.5.
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run eval:live
//   npm run eval:live -- path/to/thread.json   (your own thread, same shape as the fixtures; prints only)

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { core, cfg: makeCfg, threadFromFixture } = require('../tests/helpers.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, '..', 'tests', 'fixtures');
const cfg = makeCfg();
const client = new Anthropic();
const BASE_NOW = Date.parse('2026-10-26T10:00:00+05:30');

// Meetings already on the calendar when the reschedule/cancel emails arrive.
const KNOWN = {
  reschedule: [{ id: 'm1', title: 'Intro call with Priya (Sequoia)', start: Date.parse('2026-10-29T16:00:00+05:30'), with: ['Priya Raman'] }],
  cancel: [{ id: 'm1', title: 'Intro call with Priya (Sequoia)', start: Date.parse('2026-10-30T11:00:00+05:30'), with: ['Priya Raman'] }]
};

function cases() {
  const custom = process.argv.slice(2);
  if (custom.length) return custom.map((p) => ({ name: path.basename(p), f: JSON.parse(fs.readFileSync(p, 'utf8')) }));
  const out = fs.readdirSync(FIX).filter((n) => n.endsWith('.json') && n !== 'invite_dup.json')
    .map((n) => ({ name: n.replace('.json', ''), f: JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8')) }));
  const inv = JSON.parse(fs.readFileSync(path.join(FIX, 'invite_dup.json'), 'utf8'));
  out.push({ name: 'invite_followup', f: Object.assign({}, inv.followUpEmail, {
    expected: { prefilter: true, meetings: [{ status: 'confirmed', start: '2026-11-02T14:30:00+05:30' }] } }) });
  return out;
}

function iso(ms) { return core.Util.isoInTz(ms, cfg.defaultTz); }

let failures = 0;
for (const { name, f } of cases()) {
  const thread = threadFromFixture(f);
  const last = thread.messages[thread.messages.length - 1].date;
  const now = Math.max(BASE_NOW, last + 60000);
  const pf = core.Prefilter.checkThread(thread);
  const known = KNOWN[name] || [];
  let got = [], note = '';
  if (pf.candidate) {
    const body = core.Extract.buildRequest(thread, f.account, known, cfg, now);
    const resp = await client.messages.create(body);
    const r = core.Extract.toObservations(resp, { acct: f.account, threadId: f.threadId, asOf: last,
      knownIds: known.map((k) => k.id) }, cfg, now);
    if (r.error) note = 'error: ' + r.error;
    got = r.obs.map((o) => ({ status: o.status, start: iso(o.start), title: o.title, confidence: o.confidence, evidence: o.evidence }));
    r.skipped.forEach((s) => { note += ` [skipped "${s.title}": ${s.reason}]`; });
  } else {
    note = 'prefilter: ' + pf.reason;
  }

  let ok = true;
  if (f.expected) {
    const want = f.expected.meetings;
    ok = pf.candidate === f.expected.prefilter && got.length === want.length &&
      want.every((w, i) => got[i].status === w.status && got[i].start === w.start);
    if (!ok) failures++;
  }
  console.log(`${f.expected ? (ok ? 'PASS' : 'FAIL') : '----'}  ${name}`);
  got.forEach((g) => console.log(`        ${g.status} ${g.start}  "${g.title}"  conf=${g.confidence}  — ${g.evidence}`));
  if (!got.length) console.log('        (no meetings)');
  if (note) console.log('        ' + note.trim());
  if (!ok && f.expected) console.log('        expected: ' + JSON.stringify(f.expected.meetings));
}
process.exit(failures ? 1 : 0);
