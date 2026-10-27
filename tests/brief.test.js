// The 7am morning brief: per-founder filtering and formatting, and sending from the owner's copy only.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { core } = require('./helpers');
const { createWorld } = require('./fakes');

execFileSync('node', [path.join(__dirname, '..', 'scripts', 'bundle.js')]);

const TZ = 'Asia/Kolkata';
const NOW = Date.parse('2026-10-28T07:00:00+05:30');
const ev = (summary, start, end, extra) => Object.assign({ summary, status: 'confirmed',
  start: { dateTime: start }, end: { dateTime: end } }, extra || {});
const EVENTS = [
  ev('[R+H+A] Chat with Prof. Jane Doe (Brevity)', '2026-10-28T14:00:00+05:30', '2026-10-28T14:30:00+05:30', { location: 'Room 12' }),
  ev('[R] Quick Chat | Alex', '2026-10-28T13:00:00+05:30', '2026-10-28T13:15:00+05:30',
    { location: 'https://meet.google.com/abc-defg-hij', description: 'Join: https://meet.google.com/abc-defg-hij\nWith: Alex' }),
  ev('[H] (?) Demo with Acme', '2026-10-28T16:00:00+05:30', '2026-10-28T16:30:00+05:30'),
  ev('(agent memory) cancelled', '2026-10-28T09:00:00+05:30', '2026-10-28T09:30:00+05:30')
];

test('brief: only that founder\'s meetings, in time order, with co-founders, place and join link', () => {
  const b = core.Brief.build(EVENTS, 'R', TZ, NOW);
  assert.strictEqual(b.count, 2);
  assert.strictEqual(b.title, 'Wednesday 28 Oct: 2 meetings, first at 13:00');
  assert.strictEqual(b.text, '13:00  Quick Chat | Alex · online\n14:00  Chat with Prof. Jane Doe (Brevity) (with H+A) · Room 12');
  assert.match(b.html, /href="https:\/\/meet\.google\.com\/abc-defg-hij">Join/);
  const h = core.Brief.build(EVENTS, 'H', TZ, NOW);
  assert.match(h.text, /16:00  \(\?\) Demo with Acme/);
  assert.match(h.html, /tentative/);
  const none = core.Brief.build([], 'A', TZ, NOW);
  assert.deepStrictEqual([none.count, none.title], [0, 'Wednesday 28 Oct: no meetings']);
});

test('brief: day bounds are midnight to midnight IST', () => {
  const d = core.Brief.dayBounds(NOW, TZ);
  assert.strictEqual(new Date(d.start).toISOString(), '2026-10-27T18:30:00.000Z');
  assert.strictEqual(new Date(d.end).toISOString(), '2026-10-28T18:30:00.000Z');
});

test('brief end to end: owner emails everyone and puts one "☀ Today" event on the shared calendar', () => {
  let clock = NOW;
  const world = createWorld(() => clock);
  const owner = world.account('founders@tryamp.in');
  const r = world.account('ranabeer@school.example');
  owner.props.DEEPSEEK_API_KEY = 'ds-test';
  owner.ctx.setup();
  const cal = world.calendars[owner.props.SHARED_CALENDAR_ID];
  EVENTS.slice(0, 3).forEach((e, i) => { cal.events['b' + i] = Object.assign({ id: 'b' + i, extendedProperties: { private: { fm: '1' } } }, e); });
  const briefEvents = () => Object.values(cal.events).filter((e) => e.extendedProperties && e.extendedProperties.private.fm_brief);

  owner.ctx.enableMorningBrief();
  assert.ok(owner.triggers().includes('sendMorningBrief'));

  owner.ctx.sendMorningBrief();
  assert.deepStrictEqual(world.mails.map((m) => m.to), ['ranabeer@school.example',
    'hardik@school.example', 'anshul@school.example']);
  assert.ok(world.mails.every((m) => m.subject === '☀ Wednesday 28 Oct: 3 meetings, first at 13:00'));
  assert.match(world.mails[0].body, /14:00  Chat with Prof\. Jane Doe \(Brevity\) \[R\+H\+A\] · Room 12/);
  assert.deepStrictEqual(world.pushes, []);

  let b = briefEvents();
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].summary, '☀ Today: 13:00 Quick Chat | Alex · 14:00 Chat with Prof. Jane Doe (Brevity) · 16:00 Demo with Acme');
  assert.deepStrictEqual([b[0].start.date, b[0].end.date], ['2026-10-28', '2026-10-29']);

  // Running again replaces it instead of adding a second one.
  owner.ctx.sendMorningBrief();
  assert.strictEqual(briefEvents().length, 1);

  // Later syncs rewrite it with only what's left.
  owner.props.SYNC_EVERY_MIN = '0';
  clock = Date.parse('2026-10-28T13:30:00+05:30');
  owner.ctx.syncAll();
  assert.strictEqual(briefEvents()[0].summary, '☀ Left today: 14:00 Chat with Prof. Jane Doe (Brevity) · 16:00 Demo with Acme');
  clock = Date.parse('2026-10-28T18:00:00+05:30');
  owner.ctx.syncAll();
  assert.strictEqual(briefEvents()[0].summary, '☀ Today: all 3 meetings done');
  assert.strictEqual(briefEvents().length, 1);

  // A day with nothing on: no email, and the brief event goes away.
  ['b0', 'b1', 'b2'].forEach((k) => delete cal.events[k]);
  world.mails.length = 0;
  owner.ctx.sendMorningBrief();
  assert.strictEqual(world.mails.length, 0);
  assert.strictEqual(briefEvents().length, 0);

  assert.throws(() => r.ctx.sendMorningBrief(), /runs from founders@tryamp\.in only/);
});

test('the agent does not read its own brief email back as a meeting', () => {
  let clock = NOW;
  const world = createWorld(() => clock);
  const owner = world.account('founders@tryamp.in');
  const H = 'hardik@school.example';
  const hardik = world.account(H);
  for (const c of [owner, hardik]) { c.props.DEEPSEEK_API_KEY = 'ds-test'; c.props.SYNC_EVERY_MIN = '0'; }
  owner.ctx.setup();
  hardik.ctx.setup();
  hardik.ctx.syncAll(); // first run: history starts here
  world.deliver(H, 'brief1', [{ from: 'Founders Meeting Agent <founders@tryamp.in>', to: H,
    subject: '☀ Wednesday 28 Oct: 1 meeting, first at 13:00', date: '2026-10-28T06:45:00+05:30',
    body: '13:00  Quick Chat | Alex [R] · online' }]);
  world.replyWhenPromptContains('Quick Chat | Alex [R]', { meetings: [{ known_id: null, status: 'confirmed', title: 'Quick Chat | Alex',
    with: ['Alex'], attendee_emails: [], start: '2026-10-28T13:00:00+05:30', end: null, timezone: 'Asia/Kolkata',
    location: null, join_url: null, confidence: 0.95, evidence: '13:00 Quick Chat' }] });
  const calls = world.calls.deepseek;
  hardik.ctx.syncAll();
  assert.strictEqual(world.calls.deepseek, calls, 'brief email was not sent to the model');
  assert.ok(!world.sharedEvents().some((e) => /Alex/.test(e.summary)));
});
