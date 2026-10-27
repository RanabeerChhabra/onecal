// A fake Google "world" (Gmail, Calendar, the shared calendar) plus a fake Claude, and a fake Apps Script
// runtime per account. Each account runs the real bundled script (dist/Code.gs) in its own VM context,
// exactly like the five copies will in production.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const BUNDLE = path.join(__dirname, '..', 'dist', 'Code.gs');

function b64url(s) { return Buffer.from(s, 'utf8').toString('base64url'); }

// Gmail API "format=full" thread from a test fixture.
function rawThread(threadId, messages) {
  return {
    id: threadId,
    messages: messages.map((m, i) => {
      const headers = [['From', m.from], ['To', m.to], ['Subject', m.subject], ['Date', m.date]];
      if (m.cc) headers.push(['Cc', m.cc]);
      if (m.listUnsubscribe) headers.push(['List-Unsubscribe', m.listUnsubscribe]);
      const parts = [{ mimeType: 'text/plain', body: { data: b64url(m.body) } }];
      (m.icsTexts || []).forEach((t) => parts.push({ mimeType: 'text/calendar', body: { data: b64url(t) } }));
      return {
        id: threadId + '-' + i, threadId, labelIds: m.labels || ['INBOX'], internalDate: String(Date.parse(m.date)),
        payload: { mimeType: 'multipart/alternative', headers: headers.map(([name, value]) => ({ name, value })), parts }
      };
    })
  };
}

function json(code, body) {
  return { getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

function evStart(e) { return Date.parse(e.start.dateTime || e.start.date + 'T00:00:00Z'); }
function evEnd(e) { return Date.parse(e.end.dateTime || e.end.date + 'T00:00:00Z'); }

function createWorld(now) {
  const world = {
    calendars: {},      // calId -> { meta, owner, events: {id: ev}, acl: [] }
    calendarLists: {},  // email -> [calId] (calendars "added" in that account)
    mail: {},           // email -> { threads: {id: messages}, newIds: [] }
    ownEvents: {},      // email -> events on that account's own primary calendar
    claudeReplies: [],  // [{ marker, reply }]
    batches: {},
    calls: { claude: 0, deepseek: 0, batchCreates: 0, eventWrites: 0 },
    mails: [], pushes: [],
    deepseekEmptyReplies: 0, // the next N DeepSeek calls return empty content (a known JSON-mode glitch)
    seq: 0,
    staleEvents: null   // when set, shared-calendar reads return this snapshot (simulates a race)
  };

  function replyFor(prompt) {
    const hit = world.claudeReplies.filter((r) => prompt.includes(r.marker)).pop();
    return hit ? hit.reply : { meetings: [] };
  }

  function claudeMessage(body) {
    world.calls.claude++;
    return { type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(replyFor(body.messages[0].content)) }] };
  }

  function deepseekCompletion(body) {
    world.calls.deepseek++;
    const empty = world.deepseekEmptyReplies > 0 && world.deepseekEmptyReplies-- > 0;
    const prompt = body.messages[body.messages.length - 1].content;
    return { object: 'chat.completion', model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: empty ? '' : JSON.stringify(replyFor(prompt)) } }] };
  }

  function route(email, url, opts) {
    opts = opts || {};
    const u = new URL(url);
    const q = Object.fromEntries(u.searchParams.entries());
    if (u.host === 'ntfy.sh') { world.pushes.push(JSON.parse(opts.payload)); return json(200, { id: 'n' + (++world.seq) }); }
    if (u.host === 'api.deepseek.com') {
      if (!opts.headers || opts.headers.Authorization !== 'Bearer ds-test') return json(401, { error: { message: 'Authentication Fails', type: 'authentication_error' } });
      if (world.deepseekNoBalance) return json(402, { error: { message: 'Insufficient Balance', type: 'unknown_error' } });
      if (u.pathname === '/chat/completions') return json(200, deepseekCompletion(JSON.parse(opts.payload)));
    }
    if (u.host === 'api.anthropic.com') {
      if (!opts.headers || !opts.headers['x-api-key']) return json(401, { type: 'error', error: { type: 'authentication_error' } });
      const body = opts.payload ? JSON.parse(opts.payload) : null;
      if (u.pathname === '/v1/messages') return json(200, claudeMessage(body));
      if (u.pathname === '/v1/messages/batches') {
        world.calls.batchCreates++;
        const id = 'msgbatch_' + (++world.seq);
        world.batches[id] = body.requests.map((r) => ({ custom_id: r.custom_id, result: { type: 'succeeded', message: claudeMessage(r.params) } }));
        return json(200, { id, processing_status: 'in_progress' });
      }
      const mRes = u.pathname.match(/^\/v1\/messages\/batches\/([^/]+)\/results$/);
      if (mRes) return json(200, world.batches[mRes[1]].map((l) => JSON.stringify(l)).join('\n'));
      const mGet = u.pathname.match(/^\/v1\/messages\/batches\/([^/]+)$/);
      if (mGet) return json(200, { id: mGet[1], processing_status: 'ended', results_url: 'https://api.anthropic.com/v1/messages/batches/' + mGet[1] + '/results' });
    }
    const auth = (opts.headers && opts.headers.Authorization) || '';
    if (auth !== 'Bearer at:' + email) return json(401, { error: 'bad token' });
    if (u.host === 'gmail.googleapis.com') {
      const box = world.mail[email] || { threads: {}, newIds: [] };
      const p = u.pathname.replace('/gmail/v1/users/me/', '');
      if (p === 'profile') return json(200, { emailAddress: email, historyId: String(1000 + world.seq) });
      if (p === 'history') {
        const ids = box.newIds.splice(0);
        return json(200, { historyId: String(2000 + (++world.seq)), history: ids.map((id) => ({ messagesAdded: [{ message: { id: id + '-x', threadId: id, labelIds: ['INBOX'] } }] })) });
      }
      if (p === 'threads') return json(200, { threads: Object.keys(box.threads).map((id) => ({ id })) });
      const mt = p.match(/^threads\/(.+)$/);
      if (mt) return json(200, rawThread(mt[1], box.threads[mt[1]]));
    }
    if (u.host === 'www.googleapis.com' && u.pathname.startsWith('/calendar/v3/')) {
      if (u.pathname.endsWith('/calendarList')) {
        const items = [{ id: email, primary: true, summary: email, timeZone: 'Asia/Kolkata', accessRole: 'owner' }];
        Object.entries(world.calendars).forEach(([id, c]) => { if (c.owner === email) items.push({ id, summary: c.meta.summary, accessRole: 'owner' }); });
        return json(200, { items });
      }
      if (u.pathname.endsWith('/events')) {
        const calId = decodeURIComponent(u.pathname.split('/calendars/')[1].split('/events')[0]);
        const events = calId === email ? (world.ownEvents[email] || []) : Object.values((world.calendars[calId] || { events: {} }).events);
        const min = Date.parse(q.timeMin), max = Date.parse(q.timeMax);
        return json(200, { items: events.filter((e) => evEnd(e) > min && evStart(e) < max) });
      }
    }
    return json(404, { error: 'no fake route for ' + url });
  }

  // Advanced Calendar service, seen from `email`.
  function calendarService(email) {
    const cal = (id) => {
      const c = world.calendars[id];
      if (!c) throw new Error('Not Found: ' + id);
      const role = c.owner === email ? 'owner' : (c.acl.find((r) => r.scope.value === email) || {}).role;
      if (!role) throw new Error('Not Found: ' + id);
      return { c, role };
    };
    const write = (id) => { const { c, role } = cal(id); if (role !== 'owner' && role !== 'writer') throw new Error('Forbidden'); world.calls.eventWrites++; return c; };
    return {
      Calendars: { insert: (meta) => {
        const id = 'shared' + (++world.seq) + '@group.calendar.google.com';
        world.calendars[id] = { meta, owner: email, events: {}, acl: [] };
        (world.calendarLists[email] = world.calendarLists[email] || []).push(id);
        return Object.assign({ id }, meta);
      } },
      CalendarList: {
        list: () => ({ items: (world.calendarLists[email] || []).map((id) => ({ id, summary: world.calendars[id].meta.summary, accessRole: cal(id).role })) }),
        get: (id) => {
          if (!(world.calendarLists[email] || []).includes(id)) throw new Error('Not Found');
          return { id, accessRole: cal(id).role };
        },
        insert: (res) => {
          if (!world.calendars[res.id] || cal(res.id).role === 'none') throw new Error('Not Found');
          (world.calendarLists[email] = world.calendarLists[email] || []).push(res.id);
          return { id: res.id, accessRole: cal(res.id).role };
        }
      },
      Acl: {
        list: (id) => ({ items: cal(id).c.acl }),
        insert: (rule, id) => {
          const { c } = cal(id);
          c.acl.push(rule);
          // Simulates the recipient clicking "Add this calendar" in the share email.
          if (world.shareEmailsLost) return rule;
          (world.calendarLists[rule.scope.value] = world.calendarLists[rule.scope.value] || []).push(id);
          return rule;
        }
      },
      Events: {
        list: (id, o) => {
          const { c } = cal(id);
          const source = world.staleEvents || Object.values(c.events);
          let items = source.map((e) => JSON.parse(JSON.stringify(e)));
          if (o.timeMin) items = items.filter((e) => evEnd(e) > Date.parse(o.timeMin));
          if (o.timeMax) items = items.filter((e) => evStart(e) < Date.parse(o.timeMax));
          if (o.privateExtendedProperty) {
            const [k, v] = o.privateExtendedProperty.split('=');
            items = items.filter((e) => e.extendedProperties && e.extendedProperties.private[k] === v);
          }
          return { items };
        },
        insert: (ev, id) => { const c = write(id); const eid = 'e' + (++world.seq); c.events[eid] = JSON.parse(JSON.stringify(Object.assign({}, ev, { id: eid }))); return { id: eid }; },
        update: (ev, id, eid) => { const c = write(id); if (!c.events[eid]) throw new Error('Not Found'); c.events[eid] = JSON.parse(JSON.stringify(Object.assign({}, ev, { id: eid }))); return ev; },
        remove: (id, eid) => { const c = write(id); if (!c.events[eid]) throw new Error('Resource has been deleted'); delete c.events[eid]; }
      }
    };
  }

  // One account running its own copy of the script.
  function account(email) {
    const props = {}, cache = {}, logs = [], sheetRows = [];
    const sheet = {
      getLastRow: () => sheetRows.length, appendRow: (r) => sheetRows.push(r), setName: () => {}, setFrozenRows: () => {},
      deleteRows: () => {}, getRange: () => ({ setValues: (rows) => rows.forEach((r) => sheetRows.push(r)) })
    };
    let triggers = [];
    const ctx = vm.createContext({
      console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')) },
      Intl, JSON, Math, URL, Object, String, Number, Array,
      Date: class extends Date {
        constructor(...a) { if (a.length) super(...a); else super(now()); }
        static now() { return now(); }
      },
      Session: { getEffectiveUser: () => ({ getEmail: () => email }) },
      MailApp: { sendEmail: (m) => { world.mails.push(Object.assign({ from: email }, m)); } },
      PropertiesService: { getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
        getProperties: () => Object.assign({}, props)
      }) },
      CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
      LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
      Utilities: {
        getUuid: () => crypto.randomUUID(), sleep: () => {},
        base64EncodeWebSafe: (x) => Buffer.from(x).toString('base64url'),
        base64DecodeWebSafe: (s) => Buffer.from(s, 'base64url'),
        newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') })
      },
      UrlFetchApp: {
        fetch: (url, opts) => route(email, url, opts),
        fetchAll: (reqs) => reqs.map((r) => route(email, r.url, r))
      },
      Calendar: calendarService(email),
      SpreadsheetApp: {
        create: () => ({ getId: () => 'sheet-' + email, getSheets: () => [sheet] }),
        openById: () => ({ getSheetByName: () => sheet })
      },
      ScriptApp: {
        getOAuthToken: () => 'at:' + email,
        getProjectTriggers: () => triggers.map((h) => ({ getHandlerFunction: () => h })),
        // Any chain of builder calls (timeBased().atHour(7).everyDays(1)...) ending in create().
        newTrigger: (h) => { const b = new Proxy({}, { get: (_, k) => (k === 'create' ? () => { triggers.push(h); } : () => b) }); return b; },
        deleteTrigger: (t) => { triggers = triggers.filter((h) => h !== t.getHandlerFunction()); }
      }
    });
    vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), ctx, { filename: 'Code.gs' });
    world.mail[email] = world.mail[email] || { threads: {}, newIds: [] };
    return { email, ctx, props, logs, sheetRows, triggers: () => triggers.slice() };
  }

  return Object.assign(world, {
    route, account,
    sharedEvents() {
      const id = Object.keys(world.calendars)[0];
      return id ? Object.values(world.calendars[id].events) : [];
    },
    deliver(email, threadId, messages, isNew = true) {
      world.mail[email] = world.mail[email] || { threads: {}, newIds: [] };
      world.mail[email].threads[threadId] = messages;
      if (isNew) world.mail[email].newIds.push(threadId);
    },
    replyWhenPromptContains(marker, reply) { world.claudeReplies.push({ marker, reply }); }
  });
}

module.exports = { createWorld };
