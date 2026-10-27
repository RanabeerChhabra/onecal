const test = require('node:test');
const assert = require('node:assert');
const { core, fixture, cfg } = require('./helpers');

test('ics: parses Google invite with TZID, attendees, folded description', () => {
  const cal = core.Ics.parse(fixture('invite_dup.json').ics, 'Asia/Kolkata');
  assert.strictEqual(cal.method, 'REQUEST');
  assert.strictEqual(cal.events.length, 1);
  const e = cal.events[0];
  assert.strictEqual(e.uid, '5q8v2kq0abcd1234@google.com');
  assert.strictEqual(new Date(e.start).toISOString(), '2026-11-02T09:00:00.000Z');
  assert.strictEqual(e.end - e.start, 3600000);
  assert.strictEqual(e.attendees.length, 3);
  assert.match(e.description, /meet\.google\.com\/xyz-abcd-efg/);
  assert.strictEqual(e.organizer.email, 'meera@fundx.example');
});

test('ics: Windows timezone names and UTC times', () => {
  const text = 'BEGIN:VCALENDAR\nMETHOD:REQUEST\nBEGIN:VEVENT\nUID:abc\nDTSTART;TZID=India Standard Time:20261105T100000\nDTEND:20261105T050000Z\nSUMMARY:Teams sync\nEND:VEVENT\nEND:VCALENDAR';
  const e = core.Ics.parse(text).events[0];
  assert.strictEqual(new Date(e.start).toISOString(), '2026-11-05T04:30:00.000Z');
  assert.strictEqual(new Date(e.end).toISOString(), '2026-11-05T05:00:00.000Z');
});

test('ics: METHOD:CANCEL becomes a cancelled observation', () => {
  const text = fixture('invite_dup.json').ics.replace('METHOD:REQUEST', 'METHOD:CANCEL');
  const thread = { id: 't1', messages: [{ date: Date.now(), subject: 'Cancelled', icsTexts: [text] }] };
  const r = core.Sources.fromThreadIcs(thread, { email: 'hardik.personal@gmail.com', founder: 'H' }, cfg());
  assert.strictEqual(r.obs.length, 1);
  assert.strictEqual(r.obs[0].status, 'cancelled');
  assert.strictEqual(r.obs[0].ical, '5q8v2kq0abcd1234@google.com@');
});

test('university classes are left out, meetings with similar words are kept', () => {
  const acct = { email: 'hardik.personal@gmail.com', founder: 'H' };
  const ev = (summary, extra) => Object.assign({ summary, status: 'confirmed', updated: '2026-10-26T05:00:00Z',
    start: { dateTime: '2026-11-09T10:10:00+05:30' }, end: { dateTime: '2026-11-09T11:40:00+05:30' } }, extra || {});
  const skip = (e) => core.Sources.fromCalendarEvent(e, acct, cfg()).skip;
  assert.strictEqual(skip(ev('Macroeconomic Theory I (Ronit Mukherji) (ECO-2201-2)', { recurringEventId: 'r1' })), 'university class');
  assert.strictEqual(skip(ev('CS-1104 Intro to CS')), 'university class');
  assert.strictEqual(skip(ev('Weekly Lecture: Statistics', { recurringEventId: 'r2' })), 'university class');
  assert.strictEqual(skip(ev('Masterclass prep with Priya', { attendees: [{ email: 'p@x.com' }] })), undefined);
  assert.strictEqual(skip(ev('Call with Sequoia')), undefined);
});
