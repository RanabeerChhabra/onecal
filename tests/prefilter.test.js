const test = require('node:test');
const assert = require('node:assert');
const { core, fixture, threadFromFixture } = require('./helpers');

for (const name of ['confirmed', 'vague', 'reschedule', 'cancel', 'accelerator', 'calendly', 'newsletter']) {
  test(`prefilter: ${name}`, () => {
    const f = fixture(name + '.json');
    const r = core.Prefilter.checkThread(threadFromFixture(f));
    assert.strictEqual(r.candidate, f.expected.prefilter, r.reason);
  });
}

test('prefilter: invite emails always pass', () => {
  const f = fixture('invite_dup.json');
  const r = core.Prefilter.checkThread(threadFromFixture(f.emails[0]));
  assert.strictEqual(r.candidate, true);
});

test('prefilter: promotions tab is dropped even with meeting words', () => {
  const r = core.Prefilter.checkMessage({ from: 'shop@x.example', subject: 'Book a call Thursday 4pm', body: 'meeting', labels: ['CATEGORY_PROMOTIONS'] });
  assert.strictEqual(r.candidate, false);
});
