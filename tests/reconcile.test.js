// End-to-end scenarios on the dedupe/reschedule/cancel engine, through an in-memory shared calendar.
const test = require('node:test');
const assert = require('node:assert');
const { core, NOW, cfg, fixture, threadFromFixture, claudeReply, fakeStore } = require('./helpers');

const C = cfg();

function sync(store, updates, now = NOW) {
  const res = core.Reconcile.run(store.load(), updates, C, now);
  store.apply(res.ops);
  return res;
}

// Email thread -> update, using a fixture's canned model reply.
function emailUpdate(store, name, overrides = {}) {
  const f = fixture(name + '.json');
  const thread = threadFromFixture(f);
  const scope = core.Sources.threadScope(f.account, f.threadId);
  const knownIds = store.load().filter((m) => m.obs.some((o) => o.src === scope)).map((m) => m.id);
  const reply = JSON.parse(JSON.stringify(overrides.reply || f.mockReply).replace(/"__KNOWN__"/g, JSON.stringify(knownIds[0] || null)));
  const asOf = thread.messages[thread.messages.length - 1].date;
  const r = core.Extract.toObservations(claudeReply(reply), { acct: f.account, threadId: f.threadId, asOf, knownIds }, C, NOW);
  return { scope, kind: 'email', asOf: overrides.asOf || asOf, obs: r.obs, keepIds: r.keepIds };
}

function calendarUpdate(acct, events) {
  const obs = events.map((ev) => core.Sources.fromCalendarEvent(ev, acct, C)).filter((o) => !o.skip);
  return { scope: core.Sources.calScope(acct), kind: 'calendar', asOf: NOW, obs };
}

function icsUpdate(email) {
  const thread = threadFromFixture(email);
  const r = core.Sources.fromThreadIcs(thread, email.account, C);
  return { scope: core.Sources.threadScope(email.account, email.threadId), kind: 'email', asOf: thread.messages[0].date, obs: r.obs };
}

test('confirmed meeting in email text -> one event, idempotent on re-sync', () => {
  const store = fakeStore();
  const res = sync(store, [emailUpdate(store, 'confirmed')]);
  assert.deepStrictEqual([...res.ops.map((o) => o.type)], ['create']);
  const [ev] = store.list();
  assert.strictEqual(ev.summary, '[R] Intro call with Priya (Sequoia)');
  assert.strictEqual(ev.start.dateTime, '2026-10-29T16:00:00+05:30');
  assert.strictEqual(ev.status, 'confirmed');
  assert.match(ev.description, /Join: https:\/\/us02web\.zoom\.us\/j\/81234567890/);
  assert.match(ev.description, /mail\.google\.com\/mail\/\?authuser=ranabeer\.personal%40gmail\.com#all\/18f0a1confirm01/);
  assert.match(ev.description, /Why: "Thursday 4pm IST works/);

  assert.strictEqual(sync(store, [emailUpdate(store, 'confirmed')]).ops.length, 0);
});

test('vague proposal -> nothing on the calendar', () => {
  const store = fakeStore();
  assert.strictEqual(sync(store, [emailUpdate(store, 'vague')]).ops.length, 0);
  assert.strictEqual(store.list().length, 0);
});

test('reschedule in the same thread -> same event moves', () => {
  const store = fakeStore();
  sync(store, [emailUpdate(store, 'confirmed')]);
  const res = sync(store, [emailUpdate(store, 'reschedule')]);
  assert.deepStrictEqual([...res.ops.map((o) => o.type)], ['update']);
  assert.strictEqual(store.list().length, 1);
  assert.strictEqual(store.list()[0].start.dateTime, '2026-10-30T11:00:00+05:30');
});

test('reschedule without known_id from the model is still matched (single-meeting thread)', () => {
  const store = fakeStore();
  sync(store, [emailUpdate(store, 'confirmed')]);
  const f = fixture('reschedule.json');
  const reply = JSON.parse(JSON.stringify(f.mockReply).replace(/"__KNOWN__"/g, 'null'));
  sync(store, [emailUpdate(store, 'reschedule', { reply })]);
  assert.strictEqual(store.list().length, 1);
  assert.strictEqual(store.list()[0].start.dateTime, '2026-10-30T11:00:00+05:30');
});

test('cancellation -> event deleted, and an older snapshot cannot bring it back', () => {
  const store = fakeStore();
  sync(store, [emailUpdate(store, 'confirmed')]);
  sync(store, [emailUpdate(store, 'reschedule')]);
  const res = sync(store, [emailUpdate(store, 'cancel')]);
  assert.deepStrictEqual([...res.ops.map((o) => o.type)], ['delete']);
  assert.match(res.ops[0].reason, /cancelled/);
  assert.strictEqual(store.list().length, 0);
  assert.strictEqual(Object.keys(store.tombs).length, 1);

  // A late backfill result for the same thread, from before the cancellation.
  const late = sync(store, [emailUpdate(store, 'confirmed')]);
  assert.strictEqual(late.ops.length, 0);
  assert.match(late.notes[0].reason, /stale/);
  assert.strictEqual(store.list().length, 0);
});

test('same invite on two founders\' accounts (email + calendar) + a text confirmation -> exactly one [R+H] event', () => {
  const f = fixture('invite_dup.json');
  const store = fakeStore();
  const rUni = f.emails[0].account, hPers = f.emails[1].account;
  const follow = f.followUpEmail;
  const followThread = threadFromFixture(follow);
  const followObs = core.Extract.toObservations(claudeReply(f.followUpMockReply),
    { acct: follow.account, threadId: follow.threadId, asOf: followThread.messages[0].date }, C, NOW).obs;

  const res = sync(store, [
    icsUpdate(f.emails[0]),
    icsUpdate(f.emails[1]),
    calendarUpdate(rUni, f.calendarEvents[rUni.email]),
    calendarUpdate(hPers, f.calendarEvents[hPers.email]),
    { scope: core.Sources.threadScope(follow.account, follow.threadId), kind: 'email', asOf: followThread.messages[0].date, obs: followObs }
  ]);
  assert.deepStrictEqual([...res.ops.map((o) => o.type)], ['create']);
  const [ev] = store.list();
  assert.strictEqual(store.list().length, 1);
  assert.strictEqual(ev.summary, '[R+H] FundX <> Sociops partner meeting');
  assert.strictEqual(ev.start.dateTime, '2026-11-02T14:30:00+05:30');
  assert.match(ev.description, /Join: https:\/\/meet\.google\.com\/xyz-abcd-efg/);
  assert.match(ev.description, /Hardik's calendar/);
  assert.match(ev.description, /Ranabeer's calendar/);
  assert.match(ev.description, /Email in ranabeer\.personal@gmail\.com/);

  // Every 10 minutes the calendars are re-read; nothing should change.
  const again = sync(store, [calendarUpdate(rUni, f.calendarEvents[rUni.email]), calendarUpdate(hPers, f.calendarEvents[hPers.email])]);
  assert.strictEqual(again.ops.length, 0);
});

test('calendar reschedule and cancellation propagate', () => {
  const f = fixture('invite_dup.json');
  const store = fakeStore();
  const acct = f.emails[0].account;
  const ev = f.calendarEvents[acct.email][0];
  sync(store, [calendarUpdate(acct, [ev])]);

  const moved = Object.assign({}, ev, { start: { dateTime: '2026-11-03T12:00:00+05:30' }, end: { dateTime: '2026-11-03T13:00:00+05:30' }, updated: '2026-10-26T04:00:00Z' });
  assert.deepStrictEqual([...sync(store, [calendarUpdate(acct, [moved])]).ops.map((o) => o.type)], ['update']);
  assert.strictEqual(store.list()[0].start.dateTime, '2026-11-03T12:00:00+05:30');

  const cancelled = Object.assign({}, moved, { status: 'cancelled', updated: '2026-10-26T04:30:00Z' });
  assert.deepStrictEqual([...sync(store, [calendarUpdate(acct, [cancelled])]).ops.map((o) => o.type)], ['delete']);
  assert.strictEqual(store.list().length, 0);
});

test('a founder declining drops their tag', () => {
  const f = fixture('invite_dup.json');
  const store = fakeStore();
  const rUni = f.emails[0].account, hPers = f.emails[1].account;
  sync(store, [calendarUpdate(rUni, f.calendarEvents[rUni.email]), calendarUpdate(hPers, f.calendarEvents[hPers.email])]);
  assert.strictEqual(store.list()[0].summary, '[R+H] FundX <> Sociops partner meeting');

  const hEv = JSON.parse(JSON.stringify(f.calendarEvents[hPers.email][0]));
  hEv.attendees.find((a) => a.self).responseStatus = 'declined';
  sync(store, [calendarUpdate(hPers, [hEv])]);
  assert.strictEqual(store.list()[0].summary, '[R] FundX <> Sociops partner meeting');
});

test('same personal Zoom room at different times -> two separate meetings', () => {
  const store = fakeStore();
  const base = fixture('confirmed.json').mockReply.meetings[0];
  const a = Object.assign({}, base, { title: 'Call with Priya' });
  const b = Object.assign({}, base, { title: 'Call with Rohan', start: '2026-10-29T18:00:00+05:30', end: null, attendee_emails: ['rohan@x.example'] });
  const obs = core.Extract.toObservations(claudeReply({ meetings: [a, b] }),
    { acct: { email: 'ranabeer.personal@gmail.com', founder: 'R' }, threadId: 't9', asOf: NOW }, C, NOW).obs;
  sync(store, [{ scope: 'gm:ranabeer.personal@gmail.com:t9', kind: 'email', asOf: NOW, obs }]);
  assert.strictEqual(store.list().length, 2);
});

test('mid-confidence email-only meeting is added as tentative with (?)', () => {
  const store = fakeStore();
  const f = fixture('confirmed.json');
  const reply = { meetings: [Object.assign({}, f.mockReply.meetings[0], { confidence: 0.7 })] };
  sync(store, [emailUpdate(store, 'confirmed', { reply })]);
  const [ev] = store.list();
  assert.strictEqual(ev.summary, '[R] (?) Intro call with Priya (Sequoia)');
  assert.strictEqual(ev.status, 'tentative');
});

test('removing an account removes the meetings only it knew about', () => {
  const f = fixture('invite_dup.json');
  const store = fakeStore();
  const rUni = f.emails[0].account, hPers = f.emails[1].account;
  sync(store, [calendarUpdate(rUni, f.calendarEvents[rUni.email]), calendarUpdate(hPers, f.calendarEvents[hPers.email]),
    emailUpdate(store, 'confirmed')]);
  assert.strictEqual(store.list().length, 2);
  sync(store, [
    { scope: 'gm:ranabeer.personal@gmail.com:', prefix: true, kind: 'removal', asOf: NOW, obs: [] },
    { scope: 'cal:ranabeer.personal@gmail.com', kind: 'removal', asOf: NOW, obs: [] }
  ]);
  assert.deepStrictEqual(store.list().map((e) => e.summary), ['[R+H] FundX <> Sociops partner meeting']);
});

test('finished meetings stay on the calendar after they drop out of the calendar window', () => {
  const f = fixture('invite_dup.json');
  const store = fakeStore();
  const acct = f.emails[0].account;
  sync(store, [calendarUpdate(acct, f.calendarEvents[acct.email])]);
  const later = Date.parse('2026-11-05T00:00:00Z');
  const res = core.Reconcile.run(store.load(), [{ scope: core.Sources.calScope(acct), kind: 'calendar', asOf: later, obs: [] }], C, later);
  assert.strictEqual(res.ops.length, 0);
});

test('shared team inbox: its meetings are tagged with every founder, and merge with a founder\'s own copy', () => {
  const store = fakeStore();
  const team = { email: 'founders@tryamp.example', founder: 'R+H+A' };
  const f = fixture('invite_dup.json');
  const thread = threadFromFixture(f.emails[0]);
  const teamIcs = core.Sources.fromThreadIcs(thread, team, C);
  sync(store, [{ scope: core.Sources.threadScope(team, 'tteam'), kind: 'email', asOf: NOW, obs: teamIcs.obs }]);
  assert.strictEqual(store.list()[0].summary, '[R+H+A] FundX <> Sociops partner meeting');
  assert.match(store.list()[0].description, /Invite email in founders@tryamp\.example/);

  const rUni = f.emails[0].account;
  const res = sync(store, [calendarUpdate(rUni, f.calendarEvents[rUni.email])]);
  assert.strictEqual(store.list().length, 1);
  assert.deepStrictEqual([...res.ops.map((o) => o.type)], ['update']);
  assert.strictEqual(store.list()[0].summary, '[R+H+A] FundX <> Sociops partner meeting');
});

test('a shared inbox listed as an attendee counts as all founders', () => {
  const store = fakeStore();
  const f = fixture('invite_dup.json');
  const ev = JSON.parse(JSON.stringify(f.calendarEvents['ranabeer@uni.example.edu'][0]));
  ev.attendees = ev.attendees.filter((a) => a.self || a.organizer).concat([{ email: 'founders@tryamp.example' }]);
  sync(store, [calendarUpdate({ email: 'ranabeer@uni.example.edu', founder: 'R' }, [ev])]);
  assert.strictEqual(store.list()[0].summary, '[R+H+A] FundX <> Sociops partner meeting');
});

test('two accounts creating the same meeting at once: the next run merges the duplicates into one', () => {
  // Ranabeer's copy saw the email confirmation; at the same moment Hardik's copy saw a calendar invite.
  const fromEmail = fakeStore();
  sync(fromEmail, [emailUpdate(fromEmail, 'confirmed')]);
  const fromCal = fakeStore();
  const hAcct = { email: 'hardik.personal@gmail.com', founder: 'H' };
  const ev = { id: 'x1', iCalUID: 'seq-call@zoom.us', status: 'confirmed', summary: 'Sociops x Sequoia intro', updated: '2026-10-26T04:00:00Z',
    start: { dateTime: '2026-10-29T16:00:00+05:30' }, end: { dateTime: '2026-10-29T16:30:00+05:30' },
    attendees: [{ email: 'hardik.personal@gmail.com', self: true, responseStatus: 'accepted' }, { email: 'priya@sequoia.example' }], eventType: 'default' };
  sync(fromCal, [calendarUpdate(hAcct, [ev])]);

  const shared = fakeStore();
  [...fromEmail.list(), ...fromCal.list()].forEach((e, i) => { shared.events['d' + i] = Object.assign({}, e, { id: 'd' + i }); });
  assert.strictEqual(shared.list().length, 2);

  const res = sync(shared, []);
  assert.deepStrictEqual([...res.ops.map((o) => o.type)].sort(), ['delete', 'update']);
  assert.strictEqual(shared.list().length, 1);
  assert.match(shared.list()[0].summary, /^\[R\+H\] /);
  assert.strictEqual(sync(shared, []).ops.length, 0, 'stable after merging');
});
