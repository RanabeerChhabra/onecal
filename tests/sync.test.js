// Five accounts, each running the real bundled script, sharing one calendar (fake Google + fake Claude).
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { createWorld } = require('./fakes');
const { fixture } = require('./helpers');

execFileSync('node', [path.join(__dirname, '..', 'scripts', 'bundle.js')]);

const R = 'ranabeer@school.example';
const H = 'hardik@school.example';
const A = 'anshul@school.example';
const AMP = 'founders@tryamp.in';
const BREVITY = 'team@brand.example';

// Fixtures use example addresses; map them onto the real accounts.
const MAP = {
  'ranabeer.personal@gmail.com': R, 'ranabeer@uni.example.edu': R, 'ranabeer@sociops.example': R,
  'hardik.personal@gmail.com': H, 'hardik@sociops.example': H,
  'anshul.personal@gmail.com': AMP, 'anshul@sociops.example': A
};
function load(name) {
  let s = JSON.stringify(fixture(name));
  for (const [from, to] of Object.entries(MAP)) s = s.split(from).join(to);
  return JSON.parse(s);
}
function lastBody(f) { return f.messages[f.messages.length - 1].body.slice(0, 40); }
function known(reply) { return JSON.parse(JSON.stringify(reply).replace('"__KNOWN__"', 'null')); }

let clock = Date.parse('2026-10-26T10:00:00+05:30');
const world = createWorld(() => clock);
const copies = {};
const summaries = () => world.sharedEvents().map((e) => e.summary).sort();
const syncEveryone = () => [R, H, A, AMP, BREVITY].forEach((e) => copies[e].ctx.syncAll());

test.before(() => {
  for (const e of [R, H, A, AMP, BREVITY]) {
    copies[e] = world.account(e);
    copies[e].props.ANTHROPIC_API_KEY = 'sk-test';
    copies[e].props.SYNC_EVERY_MIN = '0'; // these tests sync back to back; the 2-hour pacing has its own test
  }
  for (const name of ['confirmed', 'vague', 'accelerator', 'calendly', 'newsletter']) {
    const f = load(name + '.json');
    world.deliver(f.account.email, f.threadId, f.messages);
    world.replyWhenPromptContains(lastBody(f), f.mockReply);
  }
  const inv = load('invite_dup.json');
  inv.emails.forEach((e) => world.deliver(e.account.email, e.threadId, e.messages));
  Object.assign(world.ownEvents, inv.calendarEvents);
});

test('setup in a non-owner account before the owner explains what to do', () => {
  assert.throws(() => copies[R].ctx.setup(), /Run setup\(\) in founders@tryamp\.in first/);
});

test('owner setup creates the calendar and gives every other account edit access', () => {
  copies[AMP].ctx.setup();
  const cal = Object.values(world.calendars)[0];
  assert.strictEqual(cal.meta.summary, 'Founders — All Meetings');
  assert.deepStrictEqual(cal.acl.map((r) => r.role + ' ' + r.scope.value).sort(),
    ['writer ' + A, 'writer ' + H, 'writer ' + R, 'writer ' + BREVITY].sort());
  for (const e of [R, H, A, BREVITY]) copies[e].ctx.setup();
  for (const e of [R, H, A, AMP, BREVITY]) assert.ok(copies[e].props.SHARED_CALENDAR_ID);
});

test('dry run in one account writes nothing', () => {
  copies[R].ctx.dryRun();
  assert.strictEqual(world.sharedEvents().length, 0);
  const actions = copies[R].sheetRows.filter((r) => r[1] === 'DRY').map((r) => r[2]);
  assert.ok(actions.includes('detected'), copies[R].logs.join('\n'));
  assert.ok(actions.includes('create'));
});

test('every account syncs: one event per meeting, tagged by owner, duplicates across accounts merged', () => {
  syncEveryone(); // calendars right away; existing mail goes out as a backfill batch
  syncEveryone(); // batch results come back
  assert.deepStrictEqual(summaries(), [
    '[R+H+A] 30 min meeting with Neha Kapoor',
    '[R+H+A] Accelerator partner interview',
    '[R+H] FundX <> Sociops partner meeting',
    '[R] Intro call with Priya (Sequoia)'
  ], Object.values(copies).map((c) => c.logs.join('\n')).join('\n----\n'));
  const fundx = world.sharedEvents().find((e) => e.summary.includes('FundX'));
  assert.match(fundx.description, /Join: https:\/\/meet\.google\.com\/xyz-abcd-efg/);
  assert.match(fundx.description, /Ranabeer's calendar/);
  assert.match(fundx.description, /Hardik's calendar/);
});

test('repeated syncs from all five accounts change nothing (no ping-pong between copies)', () => {
  const writes = world.calls.eventWrites;
  const before = JSON.stringify(world.sharedEvents());
  syncEveryone();
  syncEveryone();
  assert.strictEqual(JSON.stringify(world.sharedEvents()), before);
  assert.strictEqual(world.calls.eventWrites, writes);
});

test('two accounts writing at the same moment: duplicate is merged on the next run', () => {
  const m = load('invite_dup.json');
  // A new meeting appears in R's and H's calendars; both copies run against the same stale read.
  const ev = JSON.parse(JSON.stringify(m.calendarEvents[R][0]));
  Object.assign(ev, { id: 'race1', iCalUID: 'race-1@google.com', summary: 'Race test sync', updated: '2026-10-26T05:00:00Z',
    start: { dateTime: '2026-11-06T12:00:00+05:30' }, end: { dateTime: '2026-11-06T12:30:00+05:30' } });
  const hEv = Object.assign(JSON.parse(JSON.stringify(ev)), { attendees: ev.attendees.map((a) => Object.assign({}, a, { self: a.email === H })) });
  world.ownEvents[R].push(ev);
  world.ownEvents[H].push(hEv);
  world.staleEvents = world.sharedEvents().map((e) => JSON.parse(JSON.stringify(e)));
  copies[R].ctx.syncAll();
  copies[H].ctx.syncAll();
  world.staleEvents = null;
  assert.strictEqual(summaries().filter((s) => s.includes('Race test')).length, 2, 'race produced a duplicate');
  copies[A].ctx.syncAll();
  assert.deepStrictEqual(summaries().filter((s) => s.includes('Race test')), ['[R+H] Race test sync']);
});

test('reschedule by email moves the event; a cancellation in one account is respected by all', () => {
  const r = load('reschedule.json');
  clock = Date.parse('2026-10-27T14:00:00+05:30');
  world.deliver(r.account.email, r.threadId, r.messages);
  world.replyWhenPromptContains(lastBody(r), known(r.mockReply));
  syncEveryone();
  const seq = world.sharedEvents().filter((e) => e.summary.includes('Sequoia'));
  assert.strictEqual(seq.length, 1);
  assert.strictEqual(seq[0].start.dateTime, '2026-10-30T11:00:00+05:30');

  // FundX gets cancelled by email in Ranabeer's inbox, while Hardik's calendar still shows the invite.
  clock = Date.parse('2026-10-28T09:00:00+05:30');
  const thread = 'fundxcancel01';
  world.deliver(R, thread, [{ from: 'Meera Iyer <meera@fundx.example>', to: R, subject: 'Re: FundX partner meeting',
    date: '2026-10-28T08:30:00+05:30', body: 'Hi both, we need to cancel Monday\'s partner meeting, apologies. Will come back with new dates.' }]);
  world.replyWhenPromptContains('we need to cancel Monday', { meetings: [{ known_id: null, status: 'cancelled',
    title: 'FundX partner meeting', with: ['Meera Iyer'], attendee_emails: ['meera@fundx.example', R, H],
    start: '2026-11-02T14:30:00+05:30', end: null, timezone: 'Asia/Kolkata', location: null, join_url: null,
    confidence: 0.95, evidence: "we need to cancel Monday's partner meeting" }] });
  syncEveryone();
  syncEveryone();
  assert.ok(!summaries().some((s) => s.startsWith('[') && s.includes('FundX <>')), summaries().join(' | '));
  assert.ok(summaries().some((s) => s.startsWith('(agent memory) cancelled')), 'cancellation is remembered on the shared calendar');
  const memory = world.sharedEvents().find((e) => e.summary.startsWith('(agent memory)'));
  assert.strictEqual(memory.start.date, '2000-01-01');
});

test('removeThisAccount clears that account\'s upcoming meetings and stops its sync', () => {
  copies[AMP].ctx.enableSync();
  copies[AMP].ctx.removeThisAccount();
  assert.deepStrictEqual(copies[AMP].triggers(), []);
  // Clock is 28 Oct 09:00, so both shared-inbox meetings are still upcoming and both go.
  assert.ok(!summaries().some((s) => s.includes('Neha Kapoor')));
  assert.ok(!summaries().some((s) => s.includes('Accelerator')));
  assert.ok(summaries().some((s) => s.includes('Sequoia')));
});

test('after the backfill, the 10-minute trigger only does a full sync every 2 hours', () => {
  const c = copies[R];
  c.props.SYNC_EVERY_MIN = '120';
  const lastSync = () => JSON.parse(c.props.SELF).lastSync;
  assert.strictEqual(JSON.parse(c.props.SELF).backfill.phase, 'done');
  const t0 = lastSync();
  clock = t0 + 30 * 60000;
  c.ctx.syncAll();
  assert.strictEqual(lastSync(), t0, 'skipped 30 min later');
  clock = t0 + 2 * 3600000;
  c.ctx.syncAll();
  assert.strictEqual(lastSync(), clock, 'ran 2 hours later');
});
