// Loads src/core/*.js into one shared VM context, the same way Apps Script concatenates files.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE = path.join(__dirname, '..', 'src', 'core');
const ORDER = ['Util', 'Links', 'Settings', 'Prefilter', 'Ics', 'Sources', 'Extract', 'Render', 'Reconcile', 'Brief'];

function loadCore() {
  const ctx = vm.createContext({ console, Intl, Date, JSON, Math });
  const files = fs.readdirSync(CORE).filter((f) => f.endsWith('.js'));
  const names = ORDER.filter((n) => files.includes(n + '.js')).concat(
    files.map((f) => f.replace(/\.js$/, '')).filter((n) => !ORDER.includes(n)));
  for (const n of names) vm.runInContext(fs.readFileSync(path.join(CORE, n + '.js'), 'utf8'), ctx, { filename: n + '.js' });
  return ctx;
}

const core = loadCore();

// Fixed clock for deterministic tests: Mon 26 Oct 2026, 10:00 IST.
const NOW = Date.parse('2026-10-26T10:00:00+05:30');

const FOUNDERS = [
  { tag: 'R', name: 'Ranabeer', emails: ['ranabeer@sociops.example'] },
  { tag: 'H', name: 'Hardik', emails: ['hardik@sociops.example'] },
  { tag: 'A', name: 'Anshul', emails: ['anshul@sociops.example'] }
];

const ACCOUNTS = [
  { email: 'ranabeer.personal@gmail.com', founder: 'R' },
  { email: 'ranabeer@uni.example.edu', founder: 'R' },
  { email: 'hardik.personal@gmail.com', founder: 'H' },
  { email: 'anshul.personal@gmail.com', founder: 'A' },
  { email: 'founders@tryamp.example', founder: 'R+H+A' }
];

function cfg(extra) {
  const c = core.Settings.build(Object.assign({ FOUNDERS: JSON.stringify(FOUNDERS) }, extra || {}), ACCOUNTS);
  return c;
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

// Sample email fixtures carry human-readable dates; convert to ms like the Gmail adapter does.
function threadFromFixture(f) {
  return {
    id: f.threadId,
    subject: f.messages[0].subject,
    messages: f.messages.map((m) => Object.assign({ labels: [], icsTexts: [] }, m, { date: Date.parse(m.date) }))
  };
}

// Fake Claude response wrapping a JSON payload, as returned by the Messages API.
function claudeReply(payload) {
  return { type: 'message', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

// In-memory stand-in for the shared calendar + tombstones. Applies ops the way SharedStore does
// and reloads meetings through Render.meetingFromEvent, so tests cover the storage round trip.
function fakeStore() {
  const events = {};
  const tombs = {};
  let seq = 0;
  return {
    events, tombs,
    load() {
      const ms = Object.values(events).map((ev) => core.Render.meetingFromEvent(JSON.parse(JSON.stringify(ev))));
      Object.values(tombs).forEach((t) => ms.push({ id: t.id, eventId: null, obs: JSON.parse(JSON.stringify(t.obs)), fp: t.fp, tomb: true }));
      return ms;
    },
    apply(ops) {
      for (const op of ops) {
        const m = op.meeting;
        if (op.type === 'create') { const id = 'ev' + (++seq); events[id] = Object.assign({ id }, op.event); delete tombs[m.id]; }
        else if (op.type === 'update') events[m.eventId] = Object.assign({ id: m.eventId }, op.event);
        else if (op.type === 'delete') { delete events[m.eventId]; if (op.tomb) tombs[m.id] = { id: m.id, obs: m.obs, fp: op.tombFp }; }
        else if (op.type === 'tomb') tombs[m.id] = { id: m.id, obs: m.obs, fp: op.tombFp };
        else if (op.type === 'droptomb') delete tombs[m.id];
      }
    },
    list() { return Object.values(events); }
  };
}

module.exports = { core, NOW, cfg, fixture, threadFromFixture, claudeReply, ACCOUNTS, fakeStore };
