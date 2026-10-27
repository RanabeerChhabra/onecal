const test = require('node:test');
const assert = require('node:assert');
const { core, NOW, cfg, fixture, threadFromFixture, claudeReply } = require('./helpers');

function run(name, opts = {}) {
  const f = fixture(name + '.json');
  const reply = JSON.parse(JSON.stringify(f.mockReply).replace(/"__KNOWN__"/g, JSON.stringify(opts.knownId || null)));
  const thread = threadFromFixture(f);
  return core.Extract.toObservations(claudeReply(reply), {
    acct: f.account, threadId: f.threadId, asOf: thread.messages[thread.messages.length - 1].date,
    knownIds: opts.knownIds || []
  }, cfg(), opts.now || NOW);
}

test('extract: request carries sent dates, default timezone and structured output schema', () => {
  const f = fixture('confirmed.json');
  const body = core.Extract.buildRequest(threadFromFixture(f), f.account, [{ id: 'm1', title: 'Old', start: NOW, with: [] }], cfg(), NOW);
  assert.strictEqual(body.model, 'claude-haiku-5-5');
  assert.strictEqual(body.output_config.format.type, 'json_schema');
  const prompt = body.messages[0].content;
  assert.match(prompt, /Default timezone: Asia\/Kolkata/);
  assert.match(prompt, /Sent: 2026-10-26T09:02:00\+05:30 \(Mon/);
  assert.match(prompt, /id=m1/);
  assert.doesNotMatch(prompt, /^> Hi Priya/m, 'quoted reply should be stripped in multi-message threads');
});

test('extract: confirmed meeting becomes an observation in IST with join link', () => {
  const r = run('confirmed');
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.obs.length, 1);
  const o = r.obs[0];
  assert.strictEqual(new Date(o.start).toISOString(), '2026-10-29T10:30:00.000Z');
  assert.strictEqual(o.end - o.start, 30 * 60000);
  assert.strictEqual(o.confKey, 'zoom:81234567890');
  assert.strictEqual(o.founder, 'R');
  assert.match(o.link, /authuser=ranabeer.personal%40gmail.com#all\/18f0a1confirm01/);
});

test('extract: vague proposal yields nothing', () => {
  const r = run('vague');
  assert.deepStrictEqual([r.obs.length, r.skipped.length], [0, 0]);
});

test('extract: relative date "28th" from the accelerator', () => {
  const o = run('accelerator').obs[0];
  assert.strictEqual(new Date(o.start).toISOString(), '2026-10-28T05:30:00.000Z');
  assert.strictEqual(o.end - o.start, 45 * 60000);
});

test('extract: missing end uses default duration; missing offset uses timezone', () => {
  const reply = claudeReply({ meetings: [Object.assign({}, fixture('confirmed.json').mockReply.meetings[0],
    { start: '2026-11-10T09:00:00', end: null, timezone: 'Europe/London' })] });
  const o = core.Extract.toObservations(reply, { acct: { email: 'a@x', founder: 'R' }, threadId: 't', asOf: NOW }, cfg(), NOW).obs[0];
  assert.strictEqual(new Date(o.start).toISOString(), '2026-11-10T09:00:00.000Z');
  assert.strictEqual(o.end - o.start, 30 * 60000);
});

test('extract: confidence thresholds (tentative band kept, low skipped, low cancellations skipped)', () => {
  const base = fixture('confirmed.json').mockReply.meetings[0];
  const mk = (conf, status) => Object.assign({}, base, { confidence: conf, status: status || 'confirmed' });
  const r = core.Extract.toObservations(claudeReply({ meetings: [mk(0.7), mk(0.5), mk(0.7, 'cancelled')] }),
    { acct: { email: 'a@x', founder: 'R' }, threadId: 't', asOf: NOW }, cfg(), NOW);
  assert.strictEqual(r.obs.length, 1);
  assert.strictEqual(r.obs[0].confidence, 0.7);
  assert.strictEqual(r.skipped.length, 2);
});

test('extract: past meetings are skipped', () => {
  const r = run('confirmed', { now: Date.parse('2026-11-01T00:00:00Z') });
  assert.strictEqual(r.obs.length, 0);
  assert.match(r.skipped[0].reason, /past/);
});

test('extract: API errors keep the thread\'s known meetings untouched', () => {
  const r = core.Extract.toObservations({ type: 'error', error: { type: 'overloaded_error' } },
    { acct: { email: 'a@x', founder: 'R' }, threadId: 't', asOf: NOW, knownIds: ['m1'] }, cfg(), NOW);
  assert.ok(r.error);
  assert.deepStrictEqual(r.keepIds, ['m1']);
});

test('extract: one known meeting + one returned meeting are linked even without known_id', () => {
  const r = run('reschedule', { knownIds: ['m42'] });
  assert.strictEqual(r.obs[0].knownId, 'm42');
  assert.deepStrictEqual(r.keepIds, []);
});
