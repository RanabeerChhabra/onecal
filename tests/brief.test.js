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

test('brief end to end: owner sends one email + push per founder; other copies refuse', () => {
  const world = createWorld(() => NOW);
  const owner = world.account('founders@tryamp.in');
  const r = world.account('ranabeer@school.example');
  owner.props.DEEPSEEK_API_KEY = 'ds-test';
  owner.ctx.setup();
  const cal = world.calendars[owner.props.SHARED_CALENDAR_ID];
  EVENTS.slice(0, 3).forEach((e, i) => { cal.events['b' + i] = Object.assign({ id: 'b' + i, extendedProperties: { private: { fm: '1' } } }, e); });

  owner.ctx.enableMorningBrief();
  assert.ok(owner.triggers().includes('sendMorningBrief'));
  const topics = JSON.parse(owner.props.NTFY_TOPICS);
  assert.match(topics.R, /^founders-ranabeer-[0-9a-f]{16}$/);
  assert.ok(owner.logs.some((l) => l.includes(topics.H)));

  owner.ctx.sendMorningBrief();
  assert.deepStrictEqual(world.mails.map((m) => m.to), ['ranabeer@school.example',
    'hardik@school.example', 'anshul@school.example']);
  // Everyone gets the whole team's day.
  assert.ok(world.mails.every((m) => m.subject === 'Wednesday 28 Oct: 3 meetings, first at 13:00'));
  assert.deepStrictEqual(world.pushes.map((p) => p.topic), [topics.R, topics.H, topics.A]);
  assert.strictEqual(world.pushes[2].message, '13:00  Quick Chat | Alex [R] · online\n' +
    '14:00  Chat with Prof. Jane Doe (Brevity) [R+H+A] · Room 12\n16:00  (?) Demo with Acme [H]');

  // A day with nothing on: push only, no email.
  Object.keys(cal.events).forEach((k) => delete cal.events[k]);
  world.mails.length = 0;
  owner.ctx.sendMorningBrief();
  assert.strictEqual(world.mails.length, 0);
  assert.strictEqual(world.pushes[3].title, 'Wednesday 28 Oct: no meetings');

  assert.throws(() => r.ctx.sendMorningBrief(), /runs from founders@tryamp\.in only/);
});
