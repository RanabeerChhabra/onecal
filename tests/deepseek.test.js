// DeepSeek as the model provider: settings, request/reply format, and a full sync through the bundled script.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { core, NOW, cfg, fixture, threadFromFixture } = require('./helpers');
const { createWorld } = require('./fakes');

execFileSync('node', [path.join(__dirname, '..', 'scripts', 'bundle.js')]);

const completion = (content, finish) => ({ choices: [{ index: 0, finish_reason: finish || 'stop', message: { role: 'assistant', content } }] });

test('settings: provider follows whichever key is set, PROVIDER overrides', () => {
  assert.strictEqual(cfg().provider, 'anthropic');
  assert.strictEqual(cfg({ DEEPSEEK_API_KEY: 'x' }).provider, 'deepseek');
  assert.strictEqual(cfg({ DEEPSEEK_API_KEY: 'x' }).model, 'deepseek-flash');
  assert.strictEqual(cfg({ DEEPSEEK_API_KEY: 'x' }).keyName, 'DEEPSEEK_API_KEY');
  assert.strictEqual(cfg({ DEEPSEEK_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }).provider, 'anthropic');
  assert.strictEqual(cfg({ DEEPSEEK_API_KEY: 'x', ANTHROPIC_API_KEY: 'y', PROVIDER: 'DeepSeek' }).provider, 'deepseek');
  assert.strictEqual(cfg({ DEEPSEEK_API_KEY: 'x', MODEL: 'deepseek-v4-pro' }).model, 'deepseek-v4-pro');
  assert.throws(() => cfg({ PROVIDER: 'openai' }), /PROVIDER must be/);
});

test('deepseek request: JSON mode, thinking off, prompt says json and shows the shape', () => {
  const f = fixture('confirmed.json');
  const body = core.Extract.buildRequest(threadFromFixture(f), f.account, [], cfg({ DEEPSEEK_API_KEY: 'x' }), NOW);
  assert.strictEqual(body.model, 'deepseek-flash');
  assert.deepStrictEqual({ ...body.response_format }, { type: 'json_object' });
  assert.deepStrictEqual({ ...body.thinking }, { type: 'disabled' });
  assert.strictEqual(body.output_config, undefined);
  assert.strictEqual(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /json/);
  assert.match(body.messages[0].content, /"known_id"/);
  assert.match(body.messages[1].content, /Default timezone: Asia\/Kolkata/);
});

test('deepseek reply: parsed like a Claude reply; empty, truncated and malformed replies are errors', () => {
  const f = fixture('confirmed.json');
  const ctx = { acct: f.account, threadId: f.threadId, asOf: NOW };
  const ok = core.Extract.toObservations(completion(JSON.stringify(f.mockReply)), ctx, cfg(), NOW);
  assert.strictEqual(ok.error, null);
  assert.strictEqual(new Date(ok.obs[0].start).toISOString(), '2026-10-29T10:30:00.000Z');
  const err = (resp) => core.Extract.readResponse(resp).error;
  assert.match(err(completion('')), /empty/);
  assert.match(err(completion('{"meetings": [', 'length')), /truncated/);
  assert.match(err(completion('{"meetings": [{"title": "x"}]}')), /start/);
  assert.match(err(completion('not json')), /invalid JSON/);
  assert.match(err({ error: { message: 'Insufficient Balance' } }), /Insufficient Balance/);
});

test('deepseek end to end: backfill extracts right away (no batches) and retries an empty reply', () => {
  const AMP = 'founders@tryamp.in';
  const world = createWorld(() => Date.parse('2026-10-26T10:00:00+05:30'));
  const copy = world.account(AMP);
  copy.props.DEEPSEEK_API_KEY = 'ds-test';
  let s = JSON.stringify(fixture('confirmed.json')).split('ranabeer.personal@gmail.com').join(AMP);
  const f = JSON.parse(s);
  world.deliver(AMP, f.threadId, f.messages);
  world.replyWhenPromptContains(f.messages[f.messages.length - 1].body.slice(0, 40), f.mockReply);
  world.deepseekEmptyReplies = 1;
  copy.ctx.setup();
  copy.ctx.syncAll();
  assert.strictEqual(world.calls.batchCreates, 0);
  assert.strictEqual(world.calls.claude, 0);
  assert.ok(world.calls.deepseek >= 2, 'empty reply was retried');
  const titles = world.sharedEvents().map((e) => e.summary);
  assert.ok(titles.some((t) => t.includes('Priya')), titles.join(' | ') + '\n' + copy.logs.join('\n'));
});

test('deepseek out of credit: backfill pauses on that page and picks it up after a top-up', () => {
  const AMP = 'founders@tryamp.in';
  const world = createWorld(() => Date.parse('2026-10-26T10:00:00+05:30'));
  const copy = world.account(AMP);
  copy.props.DEEPSEEK_API_KEY = 'ds-test';
  const f = JSON.parse(JSON.stringify(fixture('confirmed.json')).split('ranabeer.personal@gmail.com').join(AMP));
  world.deliver(AMP, f.threadId, f.messages, false); // old mail: only the backfill finds it
  world.replyWhenPromptContains(f.messages[f.messages.length - 1].body.slice(0, 40), f.mockReply);
  copy.ctx.setup();
  world.deepseekNoBalance = true;
  copy.ctx.syncAll();
  assert.strictEqual(world.sharedEvents().length, 0);
  assert.ok(copy.logs.some((l) => /backfill paused.*Insufficient Balance/.test(l)), copy.logs.join('\n'));
  world.deepseekNoBalance = false;
  copy.ctx.syncAll();
  assert.ok(world.sharedEvents().some((e) => e.summary.includes('Priya')), copy.logs.join('\n'));
});
