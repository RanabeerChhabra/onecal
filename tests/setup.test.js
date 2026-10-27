// Setup when the "shared with you" email never arrives: the calendar ID is pasted in by hand.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { createWorld } = require('./fakes');

execFileSync('node', [path.join(__dirname, '..', 'scripts', 'bundle.js')]);

test('non-owner setup with a pasted SHARED_CALENDAR_ID adds the calendar itself', () => {
  const world = createWorld(() => Date.parse('2026-10-26T10:00:00+05:30'));
  world.shareEmailsLost = true;
  const owner = world.account('founders@tryamp.in');
  const hardik = world.account('hardik@school.example');
  owner.props.DEEPSEEK_API_KEY = hardik.props.DEEPSEEK_API_KEY = 'ds-test';
  owner.ctx.setup();
  const calId = owner.props.SHARED_CALENDAR_ID;
  assert.ok(owner.logs.some((l) => l.includes('SHARED_CALENDAR_ID = ' + calId)), owner.logs.join('\n'));

  assert.throws(() => hardik.ctx.setup(), /SHARED_CALENDAR_ID/);
  hardik.props.SHARED_CALENDAR_ID = calId;
  hardik.ctx.setup();
  assert.ok(world.calendarLists['hardik@school.example'].includes(calId));
  assert.ok(hardik.logs.some((l) => l.includes('✅ Setup done')), hardik.logs.join('\n'));
});

test('pasted ID without the owner having shared it gives a clear error', () => {
  const world = createWorld(() => Date.parse('2026-10-26T10:00:00+05:30'));
  const owner = world.account('founders@tryamp.in');
  const r = world.account('ranabeer@school.example');
  owner.props.DEEPSEEK_API_KEY = r.props.DEEPSEEK_API_KEY = 'ds-test';
  owner.ctx.setup();
  world.calendars[owner.props.SHARED_CALENDAR_ID].acl = []; // sharing failed (e.g. admin setting off)
  r.props.SHARED_CALENDAR_ID = owner.props.SHARED_CALENDAR_ID;
  assert.throws(() => r.ctx.setup(), /no access to the shared calendar yet.*outsiders can change calendars/);
});
