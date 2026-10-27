// Founders Meeting Agent — single-file build 2026-10-27 18:22 UTC. Do not edit here; edit src/ and run `npm run bundle`.
// Paste this whole file into Code.gs of a new Apps Script project in each account. See README.

// ===== Founders Meeting Agent: shared configuration =====
// The same file runs in each connected Google account. Nothing here is secret: the API key goes in
// Project Settings -> Script properties -> ANTHROPIC_API_KEY (or DEEPSEEK_API_KEY), never in code.

var CONFIG = {
  calendarName: 'Founders — All Meetings',
  // This account creates the shared calendar and shares it (edit access) with every other account below.
  calendarOwner: 'founders@tryamp.in',
  founders: [
    // First email = the account each founder uses on their phone (gets the shared calendar).
    { tag: 'R', name: 'Ranabeer', emails: ['ranabeer@school.example'] },
    { tag: 'H', name: 'Hardik', emails: ['hardik@school.example'] },
    { tag: 'A', name: 'Anshul', emails: ['anshul@school.example'] }
  ],
  // Every account that runs a copy of this script, and whose meetings it holds.
  // "R+H+A" = shared team inbox: its meetings belong to all three.
  accounts: {
    'ranabeer@school.example': 'R',
    'hardik@school.example': 'H',
    'anshul@school.example': 'A',
    'founders@tryamp.in': 'R+H+A',
    'team@brand.example': 'R+H+A'
  }
};

function props_() {
  return PropertiesService.getScriptProperties();
}

// Script properties can override any default in core/Settings.js (e.g. BACKFILL_MONTHS).
function getConfig_() {
  var raw = props_().getProperties();
  raw.FOUNDERS = JSON.stringify(CONFIG.founders);
  var accounts = Object.keys(CONFIG.accounts).map(function (e) { return { email: e, founder: CONFIG.accounts[e] }; });
  var cfg = Settings.build(raw, accounts);
  cfg.raw = raw;
  return cfg;
}

function requireSettings_(cfg, keys) {
  var missing = keys.filter(function (k) { return !cfg.raw[k]; });
  if (missing.length) throw new Error('Missing Script property: ' + missing.join(', ') + ' (Project Settings -> Script properties).');
}

// ---- core/Util.js ----
// Shared helpers. Pure JS: runs both in Apps Script (V8) and in Node tests.

var Util = (function () {
  var fmtCache = {};

  function partsFormatter(tz) {
    if (!fmtCache[tz]) {
      fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    }
    return fmtCache[tz];
  }

  function isValidTz(tz) {
    if (!tz || typeof tz !== 'string') return false;
    try { partsFormatter(tz); return true; } catch (e) { return false; }
  }

  // Minutes east of UTC for `tz` at instant `ms`.
  function tzOffsetMin(ms, tz) {
    var p = {};
    partsFormatter(tz).formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  }

  // Wall-clock time in `tz` -> epoch ms. Second pass handles DST edges.
  function zonedToUtc(y, mo, d, h, mi, s, tz) {
    var guess = Date.UTC(y, mo - 1, d, h, mi, s || 0);
    var ms = guess - tzOffsetMin(guess, tz) * 60000;
    return guess - tzOffsetMin(ms, tz) * 60000;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // "2026-10-29T16:00:00+05:30"
  function isoInTz(ms, tz) {
    var off = tzOffsetMin(ms, tz);
    var wall = new Date(ms + off * 60000).toISOString().slice(0, 19);
    var sign = off < 0 ? '-' : '+';
    var a = Math.abs(off);
    return wall + sign + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
  }

  // "Thu 29 Oct 2026, 16:00"
  function fmt(ms, tz) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(new Date(ms));
  }

  // Parses ISO 8601. With an offset/Z it is absolute; without, it is wall time in `tz`.
  function parseIso(str, tz) {
    if (!str || typeof str !== 'string') return null;
    var m = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
    if (!m) return null;
    if (m[7]) {
      var t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + (m[6] || '00') +
        (m[7].toUpperCase() === 'Z' ? 'Z' : m[7].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')));
      return isNaN(t) ? null : t;
    }
    return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), isValidTz(tz) ? tz : 'UTC');
  }

  // FNV-1a, two rounds -> 16 hex chars. Not cryptographic; used for ids and fingerprints.
  function hash(str) {
    function fnv(s, seed) {
      var h = seed >>> 0;
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return ('0000000' + h.toString(16)).slice(-8);
    }
    return fnv(str, 2166136261) + fnv(str, 374761393);
  }

  function uniq(arr) {
    var seen = {}, out = [];
    (arr || []).forEach(function (x) {
      if (x === null || x === undefined || x === '') return;
      var k = typeof x === 'string' ? x : JSON.stringify(x);
      if (!seen[k]) { seen[k] = true; out.push(x); }
    });
    return out;
  }

  var EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;

  function emailsIn(str) {
    return uniq(((str || '').match(EMAIL_RE) || []).map(function (e) { return e.toLowerCase(); }));
  }

  function normEmail(str) {
    var e = emailsIn(str);
    return e.length ? e[0] : null;
  }

  var STOP = { the: 1, a: 1, an: 1, with: 1, and: 1, 'for': 1, of: 1, to: 1, on: 1, call: 1, meeting: 1,
    re: 1, fwd: 1, fw: 1, invitation: 1, updated: 1, x: 1, '<>': 1, at: 1, '-': 1, 'in': 1 };

  function tokens(s) {
    return uniq(String(s || '').toLowerCase().replace(/[^a-z0-9@. ]+/g, ' ').split(/\s+/)
      .filter(function (t) { return t.length > 1 && !STOP[t]; }));
  }

  // Jaccard similarity on meaningful words.
  function titleSim(a, b) {
    var ta = tokens(a), tb = tokens(b);
    if (!ta.length || !tb.length) return 0;
    var inter = ta.filter(function (t) { return tb.indexOf(t) >= 0; }).length;
    return inter / (ta.length + tb.length - inter);
  }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  return {
    isValidTz: isValidTz, tzOffsetMin: tzOffsetMin, zonedToUtc: zonedToUtc, isoInTz: isoInTz,
    fmt: fmt, parseIso: parseIso, hash: hash, uniq: uniq, emailsIn: emailsIn, normEmail: normEmail,
    titleSim: titleSim, truncate: truncate
  };
})();

// ---- core/Links.js ----
// Video-call link detection. The conference key (e.g. "zoom:81234567890") is a dedupe signal,
// but only together with a matching start time: personal Zoom rooms get reused across meetings.

var Links = (function () {
  var PATTERNS = [
    { re: /https?:\/\/[\w.-]*zoom\.us\/(?:j|my|w)\/([\w.-]+)[^\s<>"')\]]*/i, key: 'zoom' },
    { re: /https?:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})[^\s<>"')\]]*/i, key: 'meet' },
    { re: /https?:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join\/|meet\/)([^\s<>"')\]\/?]+)[^\s<>"')\]]*/i, key: 'teams' },
    { re: /https?:\/\/[\w.-]*webex\.com\/[^\s<>"')\]]*?(?:MTID=|\/j\.php\?MTID=|\/meet\/)([\w.-]+)[^\s<>"')\]]*/i, key: 'webex' },
    { re: /https?:\/\/(?:[\w-]+\.)?whereby\.com\/([\w-]+)[^\s<>"')\]]*/i, key: 'whereby' }
  ];

  function find(text) {
    text = String(text || '');
    for (var i = 0; i < PATTERNS.length; i++) {
      var m = text.match(PATTERNS[i].re);
      if (m) return { url: m[0].replace(/[.,;]+$/, ''), key: PATTERNS[i].key + ':' + decodeSafe(m[1]).toLowerCase() };
    }
    return null;
  }

  function decodeSafe(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function keyFor(url) {
    var f = find(url);
    return f ? f.key : null;
  }

  return { find: find, keyFor: keyFor };
})();

// ---- core/Settings.js ----
// Builds the runtime config object used by the core modules from raw key/value settings
// (Script Properties in Apps Script, a plain object in tests).

var Settings = (function () {
  var DEFAULTS = {
    PROVIDER: '',  // 'anthropic' or 'deepseek'; empty = whichever API key is set (Anthropic if both)
    MODEL: '',     // empty = the provider's default below
    DEFAULT_TZ: 'Asia/Kolkata',
    ADD_THRESHOLD: '0.8',
    TENTATIVE_THRESHOLD: '0.6',
    DEFAULT_DURATION_MIN: '30',
    BACKFILL_MONTHS: '6',
    LOOKAHEAD_DAYS: '120',
    INCLUDE_ALL_DAY: 'false',
    DRY_RUN_DAYS: '14',
    DRY_RUN_MAX_THREADS: '40'
  };

  var PROVIDERS = {
    anthropic: { model: 'claude-haiku-5-5', keyName: 'ANTHROPIC_API_KEY' },
    deepseek: { model: 'deepseek-flash', keyName: 'DEEPSEEK_API_KEY' }
  };

  function pickProvider(raw) {
    var p = String(raw.PROVIDER || '').toLowerCase();
    if (p) {
      if (!PROVIDERS[p]) throw new Error('PROVIDER must be "anthropic" or "deepseek", not "' + raw.PROVIDER + '"');
      return p;
    }
    return raw.DEEPSEEK_API_KEY && !raw.ANTHROPIC_API_KEY ? 'deepseek' : 'anthropic';
  }

  // raw.FOUNDERS: JSON [{ "tag": "R", "name": "Ranabeer", "emails": ["..."] }, ...]
  // accounts: connected accounts [{ email, founder }] — their addresses count as that founder's too.
  // A shared inbox has a team tag like "R+H+A" and counts for all of them.
  function build(raw, accounts) {
    var get = function (k) { return raw[k] !== undefined && raw[k] !== null && raw[k] !== '' ? String(raw[k]) : DEFAULTS[k]; };
    var founders;
    try { founders = JSON.parse(raw.FOUNDERS || '[]'); } catch (e) { throw new Error('FOUNDERS setting is not valid JSON'); }
    founders = founders.map(function (f) {
      return { tag: String(f.tag), name: String(f.name || f.tag), emails: (f.emails || []).map(function (e) { return String(e).toLowerCase(); }) };
    });
    var founderOf = {}, founderName = {};
    founders.forEach(function (f) {
      founderName[f.tag] = f.name;
      f.emails.forEach(function (e) { founderOf[e] = f.tag; });
    });
    (accounts || []).forEach(function (a) {
      var e = a.email.toLowerCase();
      if (!founderOf[e]) founderOf[e] = a.founder;
      var f = founders.filter(function (x) { return x.tag === a.founder; })[0]; // none for team inboxes
      if (f && f.emails.indexOf(e) < 0) f.emails.push(e);
    });
    var provider = pickProvider(raw);
    return {
      provider: provider,
      keyName: PROVIDERS[provider].keyName,
      model: get('MODEL') || PROVIDERS[provider].model,
      defaultTz: get('DEFAULT_TZ'),
      addThreshold: parseFloat(get('ADD_THRESHOLD')),
      tentativeThreshold: parseFloat(get('TENTATIVE_THRESHOLD')),
      defaultDurationMin: parseInt(get('DEFAULT_DURATION_MIN'), 10),
      backfillMonths: parseInt(get('BACKFILL_MONTHS'), 10),
      lookaheadDays: parseInt(get('LOOKAHEAD_DAYS'), 10),
      includeAllDay: get('INCLUDE_ALL_DAY') === 'true',
      dryRunDays: parseInt(get('DRY_RUN_DAYS'), 10),
      dryRunMaxThreads: parseInt(get('DRY_RUN_MAX_THREADS'), 10),
      founders: founders,
      founderOf: founderOf,
      founderName: founderName,
      teamTag: founders.map(function (f) { return f.tag; }).join('+')
    };
  }

  return { build: build, DEFAULTS: DEFAULTS, PROVIDERS: PROVIDERS };
})();

// ---- core/Prefilter.js ----
// Cheap, local filter that decides whether a thread is worth sending to the LLM.
// It should be generous: the model rejects vague proposals; this only drops obvious noise.

var Prefilter = (function () {
  var KEYWORDS = /\b(meet|meets|meeting|meetings|call|calls|catch[- ]?up|sync|chat|interview|demo|discussion|zoom|google meet|teams|webex|calendly|cal\.com|invite|invitation|invited|resched\w*|postpon\w*|moved? to|push(?:ed)? to|cancel\w*|confirm\w*|see you|slot|booked|scheduled?|appointment|coffee|lunch|dinner|pitch|session|can'?t make it|cannot make it|won'?t be able)\b/i;
  var TIME = /\b(\d{1,2}(:\d{2})?\s?(am|pm|a\.m\.|p\.m\.)|\d{1,2}[:.]\d{2}\s?(hrs|h|ist|gmt|utc|pst|est)?|noon|midnight)\b/i;
  var DATE = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day)?\b|\b(today|tomorrow|tonight|next week)\b|\b\d{1,2}(st|nd|rd|th)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\b\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?\b/i;
  var SCHEDULERS = /(calendly\.com|cal\.com|zoom\.us|calendar-notification@google\.com|teams\.microsoft|savvycal|hubspot|zcal|tidycal|doodle|acuityscheduling|youcanbook\.me|outlook\.com.*calendar)/i;
  var NOISE_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'SPAM', 'TRASH'];

  // msg: { from, subject, body, labels[], listUnsubscribe, precedence, icsTexts[] }
  function checkMessage(msg) {
    if (msg.icsTexts && msg.icsTexts.length) return { candidate: true, reason: 'calendar invite attached' };
    var labels = msg.labels || [];
    for (var i = 0; i < NOISE_LABELS.length; i++) {
      if (labels.indexOf(NOISE_LABELS[i]) >= 0) return { candidate: false, reason: 'label ' + NOISE_LABELS[i] };
    }
    if (SCHEDULERS.test(msg.from || '')) return { candidate: true, reason: 'scheduling service sender' };
    if (msg.listUnsubscribe || /^(bulk|list|junk)$/i.test(msg.precedence || '')) {
      return { candidate: false, reason: 'bulk/newsletter mail' };
    }
    var text = (msg.subject || '') + '\n' + String(msg.body || '').slice(0, 6000);
    if (!KEYWORDS.test(text)) return { candidate: false, reason: 'no meeting words' };
    if (!TIME.test(text) && !DATE.test(text)) return { candidate: false, reason: 'no date or time mentioned' };
    return { candidate: true, reason: 'meeting words + date/time' };
  }

  // A thread is a candidate if any of its recent messages is.
  function checkThread(thread) {
    var msgs = (thread.messages || []).slice(-6);
    var last = { candidate: false, reason: 'empty thread' };
    for (var i = msgs.length - 1; i >= 0; i--) {
      var r = checkMessage(msgs[i]);
      if (r.candidate) return r;
      if (i === msgs.length - 1) last = r;
    }
    return last;
  }

  return { checkMessage: checkMessage, checkThread: checkThread };
})();

// ---- core/Ics.js ----
// Minimal iCalendar (RFC 5545) parser for invite emails (.ics parts).
// Handles line folding, TZID (IANA and common Windows names), UTC and floating times.

var Ics = (function () {
  // Outlook/Teams invites use Windows zone names.
  var WINDOWS_TZ = {
    'india standard time': 'Asia/Kolkata', 'utc': 'UTC', 'coordinated universal time': 'UTC',
    'gmt standard time': 'Europe/London', 'greenwich standard time': 'Atlantic/Reykjavik',
    'w. europe standard time': 'Europe/Berlin', 'central europe standard time': 'Europe/Budapest',
    'romance standard time': 'Europe/Paris', 'pacific standard time': 'America/Los_Angeles',
    'mountain standard time': 'America/Denver', 'central standard time': 'America/Chicago',
    'eastern standard time': 'America/New_York', 'singapore standard time': 'Asia/Singapore',
    'arabian standard time': 'Asia/Dubai', 'china standard time': 'Asia/Shanghai',
    'tokyo standard time': 'Asia/Tokyo', 'aus eastern standard time': 'Australia/Sydney',
    'sri lanka standard time': 'Asia/Colombo', 'nepal standard time': 'Asia/Kathmandu'
  };

  function resolveTz(tzid, fallback) {
    if (!tzid) return fallback;
    var t = tzid.replace(/^"|"$/g, '').replace(/^\/[\w.-]+\//, '');
    if (Util.isValidTz(t)) return t;
    return WINDOWS_TZ[t.toLowerCase()] || fallback;
  }

  function unescapeText(s) {
    return String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  }

  function parseLine(line) {
    // NAME;PARAM=VAL;PARAM="a:b":VALUE  — the first ':' outside quotes separates the value.
    var inQ = false, idx = -1;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') inQ = !inQ;
      else if (c === ':' && !inQ) { idx = i; break; }
    }
    if (idx < 0) return null;
    var head = line.slice(0, idx).split(';');
    var params = {};
    head.slice(1).forEach(function (p) {
      var eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    });
    return { name: head[0].toUpperCase(), params: params, value: line.slice(idx + 1) };
  }

  // Returns { ms, allDay } or null.
  function parseDate(value, params, defaultTz) {
    var v = String(value || '').trim();
    var m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
    if (!m) return null;
    if (!m[4] || (params && params.VALUE === 'DATE')) {
      return { ms: Util.zonedToUtc(+m[1], +m[2], +m[3], 0, 0, 0, defaultTz), allDay: true };
    }
    if (m[7]) return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)), allDay: false };
    var tz = resolveTz(params && params.TZID, defaultTz);
    return { ms: Util.zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), tz), allDay: false, tz: tz };
  }

  function parseDuration(v) {
    var m = String(v || '').match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
    if (!m) return null;
    return ((+(m[1] || 0) * 7 + +(m[2] || 0)) * 86400 + +(m[3] || 0) * 3600 + +(m[4] || 0) * 60 + +(m[5] || 0)) * 1000;
  }

  function parse(text, defaultTz) {
    defaultTz = defaultTz || 'Asia/Kolkata';
    var lines = String(text || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    var out = { method: null, events: [] };
    var stack = [], ev = null;
    lines.forEach(function (raw) {
      if (!raw) return;
      var p = parseLine(raw);
      if (!p) return;
      if (p.name === 'BEGIN') {
        stack.push(p.value.toUpperCase());
        if (p.value.toUpperCase() === 'VEVENT' && stack.length <= 2) ev = { attendees: [], raw: {} };
        return;
      }
      if (p.name === 'END') {
        var closed = stack.pop();
        if (closed === 'VEVENT' && ev) { out.events.push(finish(ev, defaultTz)); ev = null; }
        return;
      }
      var top = stack[stack.length - 1];
      if (top === 'VCALENDAR' && p.name === 'METHOD') out.method = p.value.trim().toUpperCase();
      if (top !== 'VEVENT' || !ev) return; // skip VTIMEZONE / VALARM contents
      switch (p.name) {
        case 'UID': ev.uid = p.value.trim(); break;
        case 'SUMMARY': ev.summary = unescapeText(p.value); break;
        case 'LOCATION': ev.location = unescapeText(p.value); break;
        case 'DESCRIPTION': ev.description = unescapeText(p.value); break;
        case 'URL': ev.url = p.value.trim(); break;
        case 'STATUS': ev.status = p.value.trim().toUpperCase(); break;
        case 'SEQUENCE': ev.sequence = parseInt(p.value, 10) || 0; break;
        case 'RRULE': ev.rrule = p.value; break;
        case 'DURATION': ev.duration = parseDuration(p.value); break;
        case 'DTSTART': ev.start = parseDate(p.value, p.params, defaultTz); break;
        case 'DTEND': ev.end = parseDate(p.value, p.params, defaultTz); break;
        case 'RECURRENCE-ID': ev.recurrenceId = parseDate(p.value, p.params, defaultTz); break;
        case 'ORGANIZER': ev.organizer = { email: Util.normEmail(p.value), name: p.params.CN || null }; break;
        case 'ATTENDEE':
          ev.attendees.push({ email: Util.normEmail(p.value), name: p.params.CN || null,
            partstat: (p.params.PARTSTAT || '').toUpperCase() });
          break;
        default:
          if (/^X-GOOGLE-CONFERENCE$|^X-MICROSOFT-SKYPETEAMSMEETINGURL$/.test(p.name)) ev.conference = p.value.trim();
      }
    });
    return out;
  }

  function finish(ev, defaultTz) {
    var start = ev.start || null;
    var end = ev.end || null;
    if (start && !end && ev.duration) end = { ms: start.ms + ev.duration, allDay: start.allDay };
    return {
      uid: ev.uid || null,
      summary: ev.summary || '',
      location: ev.location || null,
      description: ev.description || '',
      url: ev.url || null,
      conference: ev.conference || null,
      status: ev.status || 'CONFIRMED',
      sequence: ev.sequence || 0,
      recurring: !!ev.rrule,
      recurrenceId: ev.recurrenceId ? ev.recurrenceId.ms : null,
      start: start ? start.ms : null,
      end: end ? end.ms : null,
      allDay: !!(start && start.allDay),
      tz: (start && start.tz) || defaultTz,
      organizer: ev.organizer || null,
      attendees: ev.attendees.filter(function (a) { return a.email; })
    };
  }

  return { parse: parse, resolveTz: resolveTz };
})();

// ---- core/Sources.js ----
// Turns raw sources (calendar events, .ics invites) into "observations": one source's view of a meeting.
//
// Observation fields:
//   src        scope the observation belongs to: "cal:<account>" or "gm:<account>:<threadId>"
//   kind       "calendar" | "ics" | "email"
//   acct       connected account email; founder = its founder tag ("R")
//   status     "confirmed" | "cancelled" | "declined"
//   title, start, end (epoch ms), tz, location, joinUrl, confKey, attendees[], with[]
//   ical       "<iCalUID>@<original start ms or ''>" when known — strongest dedupe key
//   confidence 0..1 (1 for calendar/ics), asOf (ms, when this source last changed)
//   knownId    meeting id hint from the LLM, link (back to source), evidence

var Sources = (function () {
  var SKIP_EVENT_TYPES = { outOfOffice: 1, focusTime: 1, workingLocation: 1, birthday: 1, fromGmail: 1 };

  function calScope(acct) { return 'cal:' + acct.email; }
  function threadScope(acct, threadId) { return 'gm:' + acct.email + ':' + threadId; }

  function gmailLink(acctEmail, threadId) {
    return 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(acctEmail) + '#all/' + threadId;
  }

  function icalKey(uid, originalStartMs) {
    return uid ? uid + '@' + (originalStartMs ? String(originalStartMs) : '') : null;
  }

  // Google Calendar API v3 event -> observation, or { skip: reason }.
  // University classes on the founders' student calendars, e.g. "Macroeconomic Theory I (ECO-2201-2)".
  var COURSE_CODE = /\b[A-Z]{2,5}-\d{3,4}\b/;
  var CLASS_WORDS = /\b(lecture|tutorial|recitation|lab section|class)\b/i;
  function looksLikeClass(title, recurringSolo) {
    title = String(title || '');
    return COURSE_CODE.test(title) || (recurringSolo && CLASS_WORDS.test(title));
  }

  function fromCalendarEvent(ev, acct, cfg) {
    if (!ev || !ev.start) return { skip: 'no start' };
    var others = (ev.attendees || []).filter(function (a) { return !a.self; });
    if (looksLikeClass(ev.summary, !!ev.recurringEventId && !others.length)) return { skip: 'university class' };
    if (SKIP_EVENT_TYPES[ev.eventType]) return { skip: 'event type ' + ev.eventType };
    var allDay = !ev.start.dateTime;
    if (allDay && !cfg.includeAllDay) return { skip: 'all-day event' };
    var tz = ev.start.timeZone || cfg.calendarTz || cfg.defaultTz;
    var start = allDay ? Util.parseIso(ev.start.date + 'T00:00:00', tz) : Date.parse(ev.start.dateTime);
    var end = ev.end ? (allDay ? Util.parseIso(ev.end.date + 'T00:00:00', tz) : Date.parse(ev.end.dateTime)) : null;
    if (!end || end <= start) end = start + cfg.defaultDurationMin * 60000;

    var status = ev.status === 'cancelled' ? 'cancelled' : 'confirmed';
    var attendees = (ev.attendees || []);
    var self = attendees.filter(function (a) { return a.self; })[0];
    if (status !== 'cancelled' && self && self.responseStatus === 'declined') status = 'declined';

    var join = ev.hangoutLink || null;
    if (!join && ev.conferenceData && ev.conferenceData.entryPoints) {
      var video = ev.conferenceData.entryPoints.filter(function (e) { return e.entryPointType === 'video'; })[0];
      join = video ? video.uri : null;
    }
    var found = Links.find([join, ev.location, ev.description].join('\n'));
    if (!join && found) join = found.url;

    var orig = ev.originalStartTime ? Date.parse(ev.originalStartTime.dateTime || ev.originalStartTime.date) : null;
    return {
      src: calScope(acct), kind: 'calendar', acct: acct.email, founder: acct.founder,
      status: status,
      title: ev.summary || '(no title)',
      start: start, end: end, tz: Util.isValidTz(tz) ? tz : cfg.defaultTz,
      location: ev.location || null,
      joinUrl: join,
      confKey: found ? found.key : (join ? Links.keyFor(join) : null),
      attendees: Util.uniq(attendees.map(function (a) { return (a.email || '').toLowerCase(); })
        .concat(ev.organizer && ev.organizer.email ? [ev.organizer.email.toLowerCase()] : [])),
      with: Util.uniq(attendees.filter(function (a) { return !a.self; }).map(function (a) { return a.displayName || a.email; })),
      ical: icalKey(ev.iCalUID, orig),
      confidence: 1,
      asOf: ev.updated ? Date.parse(ev.updated) : 0,
      knownId: null,
      link: ev.htmlLink || null,
      evidence: 'on ' + acct.email + "'s calendar"
    };
  }

  // One VEVENT from an invite email -> observation, or { skip: reason }.
  function fromIcsEvent(cal, ve, ctx, cfg) {
    var method = cal.method || 'REQUEST';
    if (method === 'REPLY' || method === 'COUNTER' || method === 'REFRESH') return { skip: 'invite ' + method.toLowerCase() };
    if (!ve.start) return { skip: 'invite without start' };
    if (looksLikeClass(ve.summary, false)) return { skip: 'university class' };
    if (ve.allDay && !cfg.includeAllDay) return { skip: 'all-day invite' };
    if (ve.recurring && !ve.recurrenceId) return { skip: 'recurring invite (handled by calendar sync)' };
    var cancelled = method === 'CANCEL' || ve.status === 'CANCELLED';
    var end = ve.end && ve.end > ve.start ? ve.end : ve.start + cfg.defaultDurationMin * 60000;
    var found = Links.find([ve.conference, ve.url, ve.location, ve.description].join('\n'));
    var acctEmail = ctx.acct.email.toLowerCase();
    var selfAtt = ve.attendees.filter(function (a) { return a.email === acctEmail; })[0];
    return {
      src: threadScope(ctx.acct, ctx.threadId), kind: 'ics', acct: ctx.acct.email, founder: ctx.acct.founder,
      status: cancelled ? 'cancelled' : (selfAtt && selfAtt.partstat === 'DECLINED' ? 'declined' : 'confirmed'),
      title: ve.summary || '(no title)',
      start: ve.start, end: end, tz: ve.tz || cfg.defaultTz,
      location: ve.location && !/^https?:\/\//.test(ve.location) ? ve.location : null,
      joinUrl: found ? found.url : null,
      confKey: found ? found.key : null,
      attendees: Util.uniq(ve.attendees.map(function (a) { return a.email; })
        .concat(ve.organizer && ve.organizer.email ? [ve.organizer.email] : [])),
      with: Util.uniq(ve.attendees.filter(function (a) { return a.email !== acctEmail; })
        .map(function (a) { return a.name || a.email; })),
      ical: icalKey(ve.uid, ve.recurrenceId),
      confidence: 1,
      asOf: ctx.sentAt,
      knownId: null,
      link: gmailLink(ctx.acct.email, ctx.threadId),
      evidence: (cancelled ? 'cancellation' : 'invite') + ' email: ' + Util.truncate(ctx.subject || ve.summary, 80)
    };
  }

  // All invite observations in a thread. Later messages override earlier ones for the same event.
  function fromThreadIcs(thread, acct, cfg) {
    var byKey = {}, skipped = [];
    (thread.messages || []).forEach(function (msg) {
      (msg.icsTexts || []).forEach(function (text) {
        var cal = Ics.parse(text, cfg.defaultTz);
        cal.events.forEach(function (ve) {
          var o = fromIcsEvent(cal, ve, { acct: acct, threadId: thread.id, sentAt: msg.date, subject: msg.subject }, cfg);
          if (o.skip) { skipped.push(o.skip); return; }
          var k = o.ical || (o.start + '|' + o.title);
          if (!byKey[k] || byKey[k].asOf <= o.asOf) byKey[k] = o;
        });
      });
    });
    return { obs: Object.keys(byKey).map(function (k) { return byKey[k]; }), skipped: skipped };
  }

  return {
    calScope: calScope, threadScope: threadScope, gmailLink: gmailLink, icalKey: icalKey,
    fromCalendarEvent: fromCalendarEvent, fromIcsEvent: fromIcsEvent, fromThreadIcs: fromThreadIcs
  };
})();

// ---- core/Extract.js ----
// LLM extraction: builds the Claude request for one email thread and turns the reply into observations.
// Transport lives elsewhere (UrlFetchApp in Apps Script, fetch in Node) so this stays pure and testable.

var Extract = (function () {
  var SYSTEM = [
    'You extract scheduled meetings from email threads for a founders\' shared calendar.',
    '',
    'Output a meeting ONLY when the thread shows it is agreed/confirmed for a specific date AND a specific start time.',
    '- Count: explicit agreement ("see you Thursday at 4", "call confirmed for 26th, 11am IST", "works for me, booked"),',
    '  booking/scheduling confirmations (Calendly, Cal.com, Zoom, Google Calendar, Teams, HubSpot, etc.),',
    '  investor/accelerator/interview slots that were accepted or assigned, and forwarded invites.',
    '- Do NOT count: proposals or questions not yet accepted ("how about Thursday?", "free next week?"),',
    '  lists of available slots, "let\'s find a time", newsletters, promotions, open-registration webinars/events/livestreams,',
    '  receipts, flights, hotels, deliveries, deadlines, or reminders that are not meetings,',
    '  university classes, lectures, tutorials, exams and course announcements.',
    '',
    'Dates and times:',
    '- Every message has a "Sent" timestamp. Resolve relative dates ("Thursday", "tomorrow", "the 26th") against the Sent',
    '  time of the message where they were written, choosing the next occurrence on or after that date.',
    '- Use a timezone stated in the text (IST, GMT, PT, "Singapore time", ...). Otherwise use the default timezone given below.',
    '- start/end: ISO 8601 with a numeric UTC offset, e.g. 2026-10-29T16:00:00+05:30. end is null if no end or duration is stated.',
    '- timezone: the IANA name you used (e.g. Asia/Kolkata).',
    '',
    'Changes:',
    '- If the thread moves a meeting, output it ONCE with the NEW time.',
    '- If a meeting was explicitly cancelled (and not re-booked), output it with status "cancelled" and its last known time.',
    '- "Known meetings" are meetings already on the calendar that may relate to this thread. If an output meeting is one of',
    '  them (same meeting, even if moved or cancelled), set known_id to its id; otherwise known_id is null.',
    '  Return every known meeting this thread is about, with its current time or cancelled status.',
    '',
    'Fields:',
    '- title: short and specific, e.g. "Call with Priya (Sequoia)" or "Demo with Acme". No date in the title.',
    '- with: names (and company if known) of the other people. attendee_emails: email addresses of everyone attending.',
    '- location: physical place if any. join_url: the video link (Zoom/Meet/Teams/...) if present.',
    '- confidence: 0-1 that this is a confirmed meeting at exactly that time (0.9+ explicit confirmation or booking',
    '  email; ~0.7 strongly implied; below 0.5 unclear).',
    '- evidence: a short quote (max 20 words) from the email that fixes the date/time or the cancellation.',
    '',
    'If nothing qualifies, return {"meetings": []}.'
  ].join('\n');

  var NULLABLE_STRING = { anyOf: [{ type: 'string' }, { type: 'null' }] };

  var SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['meetings'],
    properties: {
      meetings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['known_id', 'status', 'title', 'with', 'attendee_emails', 'start', 'end', 'timezone',
            'location', 'join_url', 'confidence', 'evidence'],
          properties: {
            known_id: NULLABLE_STRING,
            status: { type: 'string', enum: ['confirmed', 'cancelled'] },
            title: { type: 'string' },
            with: { type: 'array', items: { type: 'string' } },
            attendee_emails: { type: 'array', items: { type: 'string' } },
            start: { type: 'string' },
            end: NULLABLE_STRING,
            timezone: { type: 'string' },
            location: NULLABLE_STRING,
            join_url: NULLABLE_STRING,
            confidence: { type: 'number' },
            evidence: { type: 'string' }
          }
        }
      }
    }
  };

  var MAX_MESSAGES = 8;
  var MAX_MSG_CHARS = 4000;
  var MAX_TOTAL_CHARS = 24000;

  // Drops quoted replies. Only safe when the earlier messages are in the thread too.
  function stripQuotes(body) {
    var lines = String(body || '').split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/^On .{6,200}wrote:\s*$/.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) ||
          (/^From: /.test(l) && i + 1 < lines.length && /^(Sent|Date): /.test(lines[i + 1]))) break;
      if (/^\s*>/.test(l)) continue;
      out.push(l);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function founderLine(cfg) {
    return cfg.founders.map(function (f) { return f.tag + '=' + f.name + ' (' + f.emails.join(', ') + ')'; }).join('; ');
  }

  // thread: { id, subject, messages: [{ date, from, to, cc, subject, body }] }
  // known:  [{ id, title, start, with }] meetings this thread may update.
  function buildPrompt(thread, acct, known, cfg, now) {
    var msgs = (thread.messages || []).slice(-MAX_MESSAGES);
    var multi = msgs.length > 1;
    var parts = [
      'Default timezone: ' + cfg.defaultTz,
      'Now: ' + Util.isoInTz(now, cfg.defaultTz),
      'Mailbox owner: ' + acct.email + (String(acct.founder).indexOf('+') >= 0 ? ' (shared team inbox of all founders)' : ' (founder ' + acct.founder + ')'),
      'Founders: ' + founderLine(cfg),
      'Thread subject: ' + (thread.subject || (msgs[0] && msgs[0].subject) || '')
    ];
    if (known && known.length) {
      parts.push('Known meetings:');
      known.forEach(function (k) {
        parts.push('- id=' + k.id + ' | ' + k.title + ' | ' + Util.isoInTz(k.start, cfg.defaultTz) +
          (k.with && k.with.length ? ' | with ' + k.with.slice(0, 4).join(', ') : ''));
      });
    }
    var budget = MAX_TOTAL_CHARS;
    var rendered = [];
    for (var i = msgs.length - 1; i >= 0 && budget > 500; i--) {
      var m = msgs[i];
      var body = multi ? stripQuotes(m.body) : String(m.body || '').trim();
      body = Util.truncate(body, Math.min(MAX_MSG_CHARS, budget));
      budget -= body.length;
      rendered.unshift([
        '--- Message ' + (i + 1) + ' of ' + msgs.length + ' ---',
        'Sent: ' + Util.isoInTz(m.date, cfg.defaultTz) + ' (' + Util.fmt(m.date, cfg.defaultTz).split(' ')[0] + ')',
        'From: ' + (m.from || ''),
        'To: ' + (m.to || ''),
        m.cc ? 'Cc: ' + m.cc : null,
        'Subject: ' + (m.subject || ''),
        '',
        body
      ].filter(function (x) { return x !== null; }).join('\n'));
    }
    return parts.join('\n') + '\n\n' + rendered.join('\n\n');
  }

  // DeepSeek has no schema-enforced output, only "JSON mode", so the shape is spelled out in the prompt
  // and checked in readResponse.
  var JSON_SHAPE = [
    '',
    'Reply with json only, exactly in this shape (all keys required; use null where a value is unknown):',
    '{"meetings": [{"known_id": null, "status": "confirmed", "title": "Call with Priya (Sequoia)", "with": ["Priya Shah (Sequoia)"],',
    ' "attendee_emails": ["priya@sequoia.example"], "start": "2026-10-29T16:00:00+05:30", "end": "2026-10-29T16:30:00+05:30",',
    ' "timezone": "Asia/Kolkata", "location": null, "join_url": "https://zoom.us/j/123", "confidence": 0.95,',
    ' "evidence": "see you Thursday at 4"}]}',
    'status is "confirmed" or "cancelled".'
  ].join('\n');

  function buildRequest(thread, acct, known, cfg, now) {
    var prompt = buildPrompt(thread, acct, known, cfg, now);
    if (cfg.provider === 'deepseek') {
      return {
        model: cfg.model,
        max_tokens: 4096,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM + '\n' + JSON_SHAPE }, { role: 'user', content: prompt }]
      };
    }
    return {
      model: cfg.model,
      max_tokens: 4096,
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: prompt }]
    };
  }

  // Accepts a Claude Messages reply or a DeepSeek (OpenAI-style) chat completion.
  // Returns { meetings: [...] } or { error }.
  function readResponse(resp) {
    if (!resp) return { error: 'empty response' };
    if (resp.type === 'error' || resp.error) return { error: 'api error: ' + JSON.stringify(resp.error || resp).slice(0, 300) };
    var text;
    if (resp.choices) {
      var choice = resp.choices[0] || {};
      if (choice.finish_reason === 'length') return { error: 'output truncated (max_tokens)' };
      if (choice.finish_reason === 'content_filter') return { error: 'model refused' };
      text = (choice.message && choice.message.content) || '';
      if (!text.trim()) return { error: 'empty reply from model' };
    } else {
      if (resp.stop_reason === 'refusal') return { error: 'model refused' };
      if (resp.stop_reason === 'max_tokens') return { error: 'output truncated (max_tokens)' };
      text = (resp.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    }
    try {
      var data = JSON.parse(text);
      if (!data || !Array.isArray(data.meetings)) return { error: 'no meetings array' };
      if (!data.meetings.every(function (m) { return m && typeof m === 'object' && typeof m.start === 'string'; })) {
        return { error: 'meeting without a start time' };
      }
      return data;
    } catch (e) {
      return { error: 'invalid JSON from model' };
    }
  }

  // ctx: { acct, threadId, asOf, subject, knownIds[] (ids already linked to this thread) }
  // Returns { obs[], skipped[{ title, reason, confidence }], keepIds[], error }.
  function toObservations(resp, ctx, cfg, now) {
    var data = readResponse(resp);
    var result = { obs: [], skipped: [], keepIds: [], error: data.error || null };
    var threadKnown = ctx.knownIds || [];
    if (data.error) { result.keepIds = threadKnown.slice(); return result; }

    var meetings = data.meetings;
    // One meeting in, one meeting out: treat it as the same meeting even if the model left known_id empty.
    if (threadKnown.length === 1 && meetings.length === 1 && !meetings[0].known_id) meetings[0].known_id = threadKnown[0];

    var addressed = {};
    meetings.forEach(function (m) {
      var title = Util.truncate(m.title || '(untitled meeting)', 120);
      var conf = typeof m.confidence === 'number' ? Math.max(0, Math.min(1, m.confidence)) : 0;
      var tz = Util.isValidTz(m.timezone) ? m.timezone : cfg.defaultTz;
      var start = Util.parseIso(m.start, tz);
      if (start === null) return result.skipped.push({ title: title, reason: 'unparseable start "' + m.start + '"', confidence: conf });
      var end = Util.parseIso(m.end, tz);
      if (end === null || end <= start) end = start + cfg.defaultDurationMin * 60000;
      var knownId = m.known_id && threadKnownOrAny(m.known_id, ctx) ? m.known_id : null;

      if (end <= now) return result.skipped.push({ title: title, reason: 'in the past', confidence: conf });
      var need = (m.status === 'cancelled' || knownId) ? cfg.addThreshold : cfg.tentativeThreshold;
      if (conf < need) {
        return result.skipped.push({ title: title, confidence: conf,
          reason: 'confidence ' + conf.toFixed(2) + ' below ' + need + (m.status === 'cancelled' ? ' for a cancellation' : knownId ? ' for changing a known meeting' : '') });
      }
      if (knownId) addressed[knownId] = true;
      var join = m.join_url || null;
      var link = Links.find(join || '');
      result.obs.push({
        src: Sources.threadScope(ctx.acct, ctx.threadId), kind: 'email', acct: ctx.acct.email, founder: ctx.acct.founder,
        status: m.status === 'cancelled' ? 'cancelled' : 'confirmed',
        title: title, start: start, end: end, tz: tz,
        location: m.location || null, joinUrl: link ? link.url : join, confKey: link ? link.key : null,
        attendees: Util.uniq((m.attendee_emails || []).map(function (e) { return Util.normEmail(e); })).slice(0, 15),
        with: (m.with || []).slice(0, 8).map(function (w) { return Util.truncate(w, 60); }),
        ical: null,
        confidence: conf,
        asOf: ctx.asOf,
        knownId: knownId,
        link: Sources.gmailLink(ctx.acct.email, ctx.threadId),
        evidence: Util.truncate(m.evidence || '', 160)
      });
    });
    // Known meetings of this thread that the model did not confidently address keep their old observation.
    result.keepIds = threadKnown.filter(function (id) { return !addressed[id]; });
    return result;
  }

  function threadKnownOrAny(id, ctx) {
    return (ctx.knownIds || []).indexOf(id) >= 0 || (ctx.contextIds || []).indexOf(id) >= 0;
  }

  return { SYSTEM: SYSTEM, SCHEMA: SCHEMA, buildPrompt: buildPrompt, buildRequest: buildRequest,
    readResponse: readResponse, toObservations: toObservations, stripQuotes: stripQuotes };
})();

// ---- core/Render.js ----
// Builds the shared-calendar event for a merged meeting. Observations are stored on the event itself
// (private extended properties), so the shared calendar doubles as the agent's database.

var Render = (function () {
  var MAX_PROP = 1000; // Calendar caps each extended property value at 1024 chars.

  function compactObs(o) {
    var c = {};
    Object.keys(o).forEach(function (k) { if (o[k] !== null && o[k] !== '' && !(Array.isArray(o[k]) && !o[k].length)) c[k] = o[k]; });
    var s = JSON.stringify(c);
    // Shrink the bulky fields until it fits.
    var steps = [
      function () { c.evidence = Util.truncate(c.evidence, 60); },
      function () { c.with = (c.with || []).slice(0, 3); c.attendees = (c.attendees || []).slice(0, 5); },
      function () { delete c.evidence; c.title = Util.truncate(c.title, 60); delete c.location; },
      function () { delete c.with; c.attendees = (c.attendees || []).slice(0, 2); delete c.link; }
    ];
    for (var i = 0; s.length > MAX_PROP && i < steps.length; i++) { steps[i](); s = JSON.stringify(c); }
    return s;
  }

  function expandObs(s) {
    var o = JSON.parse(s);
    ['attendees', 'with'].forEach(function (k) { if (!o[k]) o[k] = []; });
    ['location', 'joinUrl', 'confKey', 'ical', 'knownId', 'link', 'evidence'].forEach(function (k) { if (o[k] === undefined) o[k] = null; });
    return o;
  }

  function sortObs(obs) {
    var key = function (o) { return [o.src, o.ical || '', String(o.start).padStart(15, '0'), o.title].join('|'); };
    return obs.slice().sort(function (a, b) { var ka = key(a), kb = key(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
  }

  function title(s) {
    return '[' + s.founders.join('+') + '] ' + (s.tentative ? '(?) ' : '') + s.title;
  }

  function sourceLine(o, cfg) {
    var team = String(o.founder).indexOf('+') >= 0;
    var who = team ? 'Shared inbox' : (cfg.founderName[o.founder] || o.founder);
    var label = o.kind === 'calendar' ? (team ? 'Shared calendar' : who + "'s calendar") + ' (' + o.acct + ')'
      : (o.kind === 'ics' ? 'Invite email' : 'Email') + ' in ' + o.acct;
    if (o.status === 'cancelled') label += ' [says cancelled]';
    if (o.status === 'declined') label += ' [declined]';
    return '• ' + label + (o.link ? '\n  ' + o.link : '');
  }

  function description(m, s, cfg) {
    var lines = [];
    if (s.joinUrl) lines.push('Join: ' + s.joinUrl);
    if (s.location) lines.push('Where: ' + s.location);
    if (s.with.length) lines.push('With: ' + s.with.join(', '));
    if (s.tentative) lines.push('(?) Tentative: found only in email text, confidence ' + s.confidence.toFixed(2) + '. Double-check.');
    lines.push('');
    lines.push('Sources:');
    var seen = {};
    sortObs(s.sources).forEach(function (o) {
      var line = sourceLine(o, cfg);
      if (!seen[line]) { seen[line] = true; lines.push(line); }
    });
    var t = s.timeSource;
    if (t && t.kind === 'email' && t.evidence) lines.push('', 'Why: "' + t.evidence + '"');
    lines.push('', '— Founders Meeting Agent · ' + m.id);
    return lines.join('\n');
  }

  function event(m, s, cfg) {
    var tz = Util.isValidTz(s.tz) ? s.tz : cfg.defaultTz;
    var priv = { fm: '1', fm_id: m.id };
    // Canonical order, so copies in different accounts produce byte-identical events (no update ping-pong).
    sortObs(m.obs).slice(0, 40).forEach(function (o, i) { priv['o' + i] = compactObs(o); });
    var ev = {
      summary: title(s),
      description: description(m, s, cfg),
      location: s.location || s.joinUrl || '',
      start: { dateTime: Util.isoInTz(s.start, tz), timeZone: tz },
      end: { dateTime: Util.isoInTz(s.end, tz), timeZone: tz },
      status: s.tentative ? 'tentative' : 'confirmed',
      transparency: 'opaque',
      reminders: { useDefault: true },
      extendedProperties: { 'private': priv }
    };
    priv.fm_fp = Util.hash(JSON.stringify([ev.summary, ev.description, ev.location, ev.start, ev.end, ev.status, priv]));
    return ev;
  }

  // Shared-calendar event -> meeting record, or null if it isn't ours.
  function meetingFromEvent(ev) {
    var p = ev.extendedProperties && ev.extendedProperties['private'];
    if (!p || (p.fm !== '1' && p.fm_tomb !== '1') || !p.fm_id) return null;
    var obs = Object.keys(p).filter(function (k) { return /^o\d+$/.test(k); })
      .sort(function (a, b) { return +a.slice(1) - +b.slice(1); })
      .map(function (k) { try { return expandObs(p[k]); } catch (e) { return null; } })
      .filter(Boolean);
    return { id: p.fm_id, eventId: ev.id, obs: obs, fp: p.fm_fp || null, tomb: false };
  }

  return { event: event, title: title, description: description, meetingFromEvent: meetingFromEvent,
    compactObs: compactObs, expandObs: expandObs, sortObs: sortObs };
})();

// ---- core/Reconcile.js ----
// Dedupe + reschedule/cancel engine.
//
// A meeting is a cluster of observations from different sources. Each sync produces "updates", each of
// which says "the current observations for scope S are X" (S = one account's calendar, or one email
// thread). We swap the old observations of S for X, attach each new one to the meeting it matches,
// then work out what the shared calendar should show for every meeting that changed.
//
// meeting: { id, eventId|null, obs[], fp|null, tomb: bool }   (tomb = cancelled, remembered so it is not re-added)
// update:  { scope, prefix?: bool, kind: 'calendar'|'email'|'removal', asOf, obs[], keepIds?[] }
//
// Several copies of the agent (one per Google account) write to the same shared calendar, so two of
// them can create the same meeting in the same minute. compact() heals that on the next run: any two
// meetings that match are merged into the one with the lower id, so every copy converges.

var Reconcile = (function () {
  var WINDOW_MS = 15 * 60 * 1000;

  function run(meetings, updates, cfg, now) {
    var touched = {}, notes = [];
    var byId = {};
    meetings.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    meetings.forEach(function (m) { byId[m.id] = m; });
    compact(meetings, cfg, now).forEach(function (m) { touched[m.id] = m; });

    updates.slice().sort(function (a, b) { return a.asOf - b.asOf; }).forEach(function (u) {
      var inScope = function (o) { return u.prefix ? o.src.indexOf(u.scope) === 0 : o.src === u.scope; };

      // An older snapshot of a thread (e.g. a late backfill batch) must not overwrite a newer one.
      if (u.kind === 'email') {
        var stale = meetings.some(function (m) {
          return m.obs.some(function (o) { return inScope(o) && o.asOf > u.asOf; });
        });
        if (stale) { notes.push({ action: 'skip', reason: 'stale snapshot of ' + u.scope }); return; }
      }

      var prior = [], removed = {};
      meetings.forEach(function (m) {
        if (u.keepIds && u.keepIds.indexOf(m.id) >= 0) return;
        var kept = m.obs.filter(function (o) {
          if (!inScope(o)) return true;
          // Calendar snapshots only cover the future; keep finished meetings as history.
          return u.kind === 'calendar' && o.end <= now;
        });
        if (kept.length !== m.obs.length) {
          removed[m.id] = m.obs.filter(function (o) { return kept.indexOf(o) < 0; });
          m.obs = kept; touched[m.id] = m; prior.push(m);
        }
      });

      (u.obs || []).forEach(function (o) {
        var m = match(o, meetings, byId, prior, removed, u, cfg);
        if (!m) {
          m = { id: newId(o, byId), eventId: null, obs: [], fp: null, tomb: false };
          meetings.push(m);
          byId[m.id] = m;
        }
        o.knownId = null; // a matching hint only; storing it would change the fingerprint on every re-read
        m.obs.push(o);
        touched[m.id] = m;
      });
    });

    var ops = [];
    Object.keys(touched).forEach(function (id) {
      var op = decide(touched[id], cfg, now);
      if (op) ops.push(op);
    });
    return { ops: ops, notes: notes };
  }

  function newId(o, byId) {
    var base = 'm' + Util.hash(o.ical || (o.src + '|' + o.start + '|' + o.title)).slice(0, 10);
    var id = base, n = 1;
    while (byId[id]) id = base + '-' + (n++);
    return id;
  }

  function external(emails, cfg) {
    return (emails || []).filter(function (e) { return e && !cfg.founderOf[e]; });
  }

  // `removed` holds the observations this same update just took away, so a moved calendar event
  // (same iCalUID, new time) finds its old meeting.
  function match(o, meetings, byId, prior, removed, u, cfg) {
    if (o.knownId && byId[o.knownId]) return byId[o.knownId];
    if (o.ical) {
      var sameIcal = function (p) { return p.ical === o.ical; };
      for (var i = 0; i < meetings.length; i++) {
        if (meetings[i].obs.some(sameIcal) || (removed[meetings[i].id] || []).some(sameIcal)) return meetings[i];
      }
    }
    // Re-extracted thread with a single meeting: same meeting as before, even if the time moved.
    if (o.kind === 'email' && prior.length === 1 && u.obs.length === 1) return prior[0];

    var best = null, bestScore = 0;
    meetings.forEach(function (m) {
      var sc = score(o, m, cfg);
      if (sc > bestScore) { bestScore = sc; best = m; }
    });
    return best;
  }

  // How well observation `o` fits meeting `m` (0 = not the same meeting).
  function score(o, m, cfg) {
    if (!m.obs.length) return 0;
    // Two different calendar events in the same account are different meetings.
    if (o.ical && m.obs.some(function (p) { return p.ical && p.ical !== o.ical && p.acct === o.acct; })) return 0;
    var oExt = external(o.attendees, cfg);
    var best = 0;
    m.obs.forEach(function (p) {
      if (o.ical && p.ical === o.ical) { best = Math.max(best, 5); return; }
      if (Math.abs(p.start - o.start) > WINDOW_MS) return;
      var sc = 0;
      if (o.confKey && o.confKey === p.confKey) sc = 3;
      var pExt = external(p.attendees, cfg);
      if (oExt.some(function (e) { return pExt.indexOf(e) >= 0; })) sc = Math.max(sc, 2);
      var sim = Util.titleSim(o.title, p.title);
      if (sim >= 0.5) sc = Math.max(sc, 1 + sim);
      best = Math.max(best, sc);
    });
    return best;
  }

  // Merges duplicate meetings (same meeting stored twice) into the lower id. Returns touched meetings.
  function compact(meetings, cfg, now) {
    var touched = [];
    var live = function (m) { return m.obs.length && m.obs.some(function (o) { return o.end > now; }); };
    for (var i = 0; i < meetings.length; i++) {
      var a = meetings[i];
      if (!live(a)) continue;
      for (var j = i + 1; j < meetings.length; j++) {
        var b = meetings[j];
        if (!live(b)) continue;
        var same = b.obs.some(function (o) { return score(o, a, cfg) > 0; });
        if (!same) continue;
        a.obs = a.obs.concat(b.obs);
        b.obs = [];
        touched.push(a, b);
      }
    }
    return touched;
  }

  // What the meeting should look like right now.
  function merge(m, cfg, now) {
    var obs = Render.sortObs(m.obs); // canonical order first, so ties break the same way in every account
    if (!obs.length) return { empty: true };
    var active = obs.filter(function (o) { return o.status !== 'declined'; });
    if (!active.length) return { hidden: true, reason: 'declined by everyone' };

    var rank = function (o) { return o.kind === 'email' ? 0 : 1; };
    active.sort(function (a, b) { return (b.asOf - a.asOf) || (rank(b) - rank(a)); });
    var latest = active[0];
    if (latest.status === 'cancelled') return { cancelled: true, by: latest };

    var live = active.filter(function (o) { return o.status !== 'cancelled'; });
    var timeSrc = live[0];
    var cal = live.filter(function (o) { return o.kind !== 'email'; })[0] || null;
    var pick = function (field) {
      var order = [cal, timeSrc].concat(live);
      for (var i = 0; i < order.length; i++) if (order[i] && order[i][field]) return order[i][field];
      return null;
    };

    // A tag may be a team ("R+H+A") for shared inboxes like founders@; split it into founders.
    var tags = function (t) { return String(t || '').split('+').filter(Boolean); };
    var declined = [], liveOwners = [], founders = [];
    obs.forEach(function (o) { if (o.status === 'declined') declined = declined.concat(tags(o.founder)); });
    live.forEach(function (o) {
      liveOwners = liveOwners.concat(tags(o.founder));
      founders = founders.concat(tags(o.founder));
      (o.attendees || []).forEach(function (e) { if (cfg.founderOf[e]) founders = founders.concat(tags(cfg.founderOf[e])); });
    });
    var order = cfg.founders.map(function (f) { return f.tag; });
    founders = Util.uniq(founders).filter(function (f) { return declined.indexOf(f) < 0 || liveOwners.indexOf(f) >= 0; })
      .sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    if (!founders.length) return { hidden: true, reason: 'no attending founder' };

    var confidence = Math.max.apply(null, live.map(function (o) { return o.confidence; }));
    var withNames = Util.uniq([].concat.apply([], live.map(function (o) { return o.with || []; })))
      .filter(function (w) { return !cfg.founderOf[String(w).toLowerCase()]; });

    return {
      title: (cal || timeSrc).title,
      start: timeSrc.start, end: timeSrc.end, tz: timeSrc.tz || cfg.defaultTz,
      location: pick('location'), joinUrl: pick('joinUrl'),
      founders: founders,
      tentative: !cal && confidence < cfg.addThreshold,
      confidence: confidence,
      with: withNames.slice(0, 8),
      sources: obs,
      timeSource: timeSrc,
      past: timeSrc.end <= now
    };
  }

  function decide(m, cfg, now) {
    var s = merge(m, cfg, now);
    if (s.empty) {
      if (m.eventId) return { type: 'delete', meeting: m, reason: 'all sources gone (deleted or account removed)' };
      if (m.tomb) return { type: 'droptomb', meeting: m };
      return null;
    }
    if (s.cancelled) {
      var tombFp = Util.hash(JSON.stringify(Render.sortObs(m.obs)));
      if (m.eventId) return { type: 'delete', meeting: m, tomb: true, tombFp: tombFp, by: s.by, reason: 'cancelled: ' + describe(s.by) };
      if (m.tomb && m.fp === tombFp) return null;
      return { type: 'tomb', meeting: m, tombFp: tombFp, by: s.by, reason: 'cancelled: ' + describe(s.by) };
    }
    if (s.hidden) {
      if (m.eventId) return { type: 'delete', meeting: m, reason: s.reason };
      return null;
    }
    if (s.past) return null;
    var event = Render.event(m, s, cfg);
    var fp = event.extendedProperties.private.fm_fp;
    if (!m.eventId) {
      return { type: 'create', meeting: m, event: event, state: s, reason: (m.tomb ? 're-booked after cancellation: ' : '') + describe(s.timeSource) };
    }
    if (fp !== m.fp) return { type: 'update', meeting: m, event: event, state: s, reason: describe(s.timeSource) };
    return null;
  }

  function describe(o) {
    if (!o) return '';
    var what = o.kind === 'calendar' ? 'calendar of ' + o.acct : (o.kind === 'ics' ? 'invite in ' : 'email in ') + o.acct;
    return what + (o.kind === 'email' ? ' (confidence ' + o.confidence.toFixed(2) + '): ' + o.evidence : '');
  }

  return { run: run, merge: merge, match: match, compact: compact, decide: decide, WINDOW_MS: WINDOW_MS };
})();

// ---- Http.js ----
// Google REST calls made with a connected account's OAuth token (not the bot's own identity).

var GoogleApi = (function () {
  function query(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      (Array.isArray(v) ? v : [v]).forEach(function (x) { parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(x)); });
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  function request(token, url) {
    return { url: url, headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
  }

  function parse(resp) {
    var code = resp.getResponseCode();
    var text = resp.getContentText();
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { code: code, json: json, text: text };
  }

  // Gmail answers "too many requests" with 403 rateLimitExceeded as well as 429. A freshly enabled API
  // also returns 403 for a minute or two.
  function retryable(code, text) {
    return code === 429 || code >= 500 || (code === 403 && /rate ?limit|not been used|disabled/i.test(String(text || '')));
  }

  function get(token, url, params) {
    var full = url + query(params);
    for (var attempt = 0; ; attempt++) {
      var r = parse(UrlFetchApp.fetch(full, request(token, full)));
      if (r.code >= 200 && r.code < 300) return r.json;
      if (retryable(r.code, r.text) && attempt < 3) { Utilities.sleep(1000 * Math.pow(2, attempt)); continue; }
      var err = new Error('Google API ' + r.code + ' for ' + url.replace(/\?.*/, '') + ': ' + String(r.text).slice(0, 300));
      err.code = r.code;
      throw err;
    }
  }

  // Parallel GETs in small chunks (Gmail allows ~250 quota units/s per user). Returns json per url (or null).
  function getAll(token, urls, chunk) {
    chunk = chunk || 10;
    var out = [];
    for (var i = 0; i < urls.length; i += chunk) {
      var slice = urls.slice(i, i + chunk);
      var resps = UrlFetchApp.fetchAll(slice.map(function (u) { return request(token, u); }));
      resps.forEach(function (resp, j) {
        var r = parse(resp);
        if (r.code >= 200 && r.code < 300) { out.push(r.json); return; }
        if (retryable(r.code, r.text)) { // one quick retry only, so a run of failures can't eat the time budget
          Utilities.sleep(1500);
          r = parse(UrlFetchApp.fetch(slice[j], request(token, slice[j])));
          if (r.code >= 200 && r.code < 300) { out.push(r.json); return; }
        }
        console.warn('GET failed ' + r.code + ' ' + slice[j] + ' ' + String(r.text).replace(/\s+/g, ' ').slice(0, 200));
        out.push(null);
      });
    }
    return out;
  }

  return { query: query, get: get, getAll: getAll };
})();

// ---- Self.js ----
// The Google account this copy of the script runs as, and its sync cursors (Script Properties "SELF").

var Self = (function () {
  function email() {
    return String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  }

  function tag() {
    var t = CONFIG.accounts[email()];
    if (!t) throw new Error(email() + ' is not listed in CONFIG.accounts. Add it at the top of the script.');
    return t;
  }

  function account() {
    var s = props_().getProperty('SELF');
    var a = s ? JSON.parse(s) : null;
    if (!a || a.email !== email()) {
      var months = getConfig_().backfillMonths;
      a = { email: email(), aid: 'a1', historyId: null, lastSync: null, retry: [],
        backfill: { phase: 'list', afterSec: Math.floor((Date.now() - months * 30.5 * 86400000) / 1000), pageToken: null, threads: 0 } };
    }
    a.founder = tag();
    a.status = 'ok';
    return a;
  }

  function save(a) {
    props_().setProperty('SELF', JSON.stringify(a));
  }

  function update(fn) {
    var a = account();
    fn(a);
    save(a);
    return a;
  }

  // The script's own OAuth token works for the Gmail/Calendar REST APIs (scopes from appsscript.json).
  function token() {
    return ScriptApp.getOAuthToken();
  }

  return { email: email, tag: tag, account: account, save: save, update: update, token: token };
})();

// ---- GmailApi.js ----
// Read-only Gmail access for one connected account (Gmail REST API, gmail.readonly scope).

var GmailApi = (function () {
  var BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';
  // Server-side search used for backfill and dry runs: cheap first cut before the local prefilter.
  var SEARCH = '{meeting meet call zoom calendly "cal.com" invite invitation "google meet" teams webex ' +
    'reschedule rescheduled postponed cancelled canceled confirmed "see you" interview demo "catch up" sync ' +
    'slot booked scheduled appointment filename:ics} -category:promotions -category:social -category:forums -in:chats';
  var MEETING_LINK = /zoom\.us|meet\.google|teams\.(microsoft|live)|webex|calendly|cal\.com|whereby/i;

  function profile(token) {
    return GoogleApi.get(token, BASE + 'profile');
  }

  // Thread ids touched since `startHistoryId`. { expired: true } when Gmail no longer has that history.
  function history(token, startHistoryId) {
    var ids = {}, pageToken = null, latest = startHistoryId;
    do {
      var r;
      try {
        r = GoogleApi.get(token, BASE + 'history', { startHistoryId: startHistoryId, historyTypes: 'messageAdded', maxResults: 500, pageToken: pageToken });
      } catch (e) {
        if (e.code === 404) return { expired: true };
        throw e;
      }
      (r.history || []).forEach(function (h) {
        (h.messagesAdded || []).forEach(function (ma) {
          var labels = ma.message.labelIds || [];
          if (labels.indexOf('DRAFT') >= 0 || labels.indexOf('SPAM') >= 0 || labels.indexOf('TRASH') >= 0) return;
          ids[ma.message.threadId] = true;
        });
      });
      latest = r.historyId || latest;
      pageToken = r.nextPageToken;
    } while (pageToken);
    return { ids: Object.keys(ids), historyId: latest };
  }

  function listThreads(token, q, pageToken, max) {
    var r = GoogleApi.get(token, BASE + 'threads', { q: q, maxResults: max || 50, pageToken: pageToken });
    return { ids: (r.threads || []).map(function (t) { return t.id; }), nextPageToken: r.nextPageToken || null };
  }

  function getThreads(token, ids) {
    if (!ids.length) return [];
    var raws = GoogleApi.getAll(token, ids.map(function (id) { return BASE + 'threads/' + id + '?format=full'; }), 8);
    return raws.filter(Boolean).map(function (raw) { return normalizeThread(raw, token); });
  }

  function decode(data) {
    return Utilities.newBlob(Utilities.base64DecodeWebSafe(data)).getDataAsString('UTF-8');
  }

  function htmlToText(html) {
    return String(html)
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, function (m, href, text) {
        return MEETING_LINK.test(href) ? text + ' (' + href + ')' : text;
      })
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  }

  function walk(part, acc, token, messageId) {
    var mime = (part.mimeType || '').toLowerCase();
    if (part.parts) part.parts.forEach(function (p) { walk(p, acc, token, messageId); });
    var body = part.body || {};
    if (mime === 'text/calendar' || mime === 'application/ics' || /\.ics$/i.test(part.filename || '')) {
      var data = body.data;
      if (!data && body.attachmentId) {
        try { data = GoogleApi.get(token, BASE + 'messages/' + messageId + '/attachments/' + body.attachmentId).data; } catch (e) { data = null; }
      }
      if (data) acc.ics.push(decode(data));
      return;
    }
    if (!body.data || part.filename) return;
    if (mime === 'text/plain') acc.plain.push(decode(body.data));
    else if (mime === 'text/html') acc.html.push(decode(body.data));
  }

  function normalizeThread(raw, token) {
    var messages = (raw.messages || []).filter(function (m) { return (m.labelIds || []).indexOf('DRAFT') < 0; }).map(function (m) {
      var h = {};
      (m.payload.headers || []).forEach(function (x) { h[x.name.toLowerCase()] = x.value; });
      var acc = { plain: [], html: [], ics: [] };
      walk(m.payload, acc, token, m.id);
      var ics = Util.uniq(acc.ics);
      return {
        id: m.id,
        date: parseInt(m.internalDate, 10),
        from: h.from || '', to: h.to || '', cc: h.cc || '', subject: h.subject || '',
        listUnsubscribe: h['list-unsubscribe'] || null, precedence: h.precedence || null,
        labels: m.labelIds || [],
        body: acc.plain.length ? acc.plain.join('\n') : htmlToText(acc.html.join('\n')),
        icsTexts: ics
      };
    });
    return { id: raw.id, subject: messages.length ? messages[0].subject : '', messages: messages };
  }

  return { SEARCH: SEARCH, profile: profile, history: history, listThreads: listThreads, getThreads: getThreads, htmlToText: htmlToText };
})();

// ---- CalApi.js ----
// Read-only access to a connected account's own calendars (calendar.readonly scope).

var CalApi = (function () {
  var BASE = 'https://www.googleapis.com/calendar/v3/';

  // Calendars the account owns (primary + ones they created). Skips subscribed/holiday calendars
  // and, importantly, the shared Founders calendar itself.
  function ownedCalendars(token, sharedId) {
    var out = [], pageToken = null;
    do {
      var r = GoogleApi.get(token, BASE + 'users/me/calendarList', { minAccessRole: 'owner', pageToken: pageToken, maxResults: 250 });
      (r.items || []).forEach(function (c) {
        if (c.id !== sharedId && !c.deleted) out.push({ id: c.id, summary: c.summary, primary: !!c.primary, timeZone: c.timeZone });
      });
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  function events(token, calendarId, timeMin, timeMax) {
    var out = [], pageToken = null;
    do {
      var r = GoogleApi.get(token, BASE + 'calendars/' + encodeURIComponent(calendarId) + '/events', {
        timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(),
        singleEvents: 'true', showDeleted: 'true', maxResults: 2500, pageToken: pageToken
      });
      out = out.concat(r.items || []);
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  return { ownedCalendars: ownedCalendars, events: events };
})();

// ---- Claude.js ----
// Claude API over UrlFetchApp. Apps Script can't load npm packages, so this uses the REST API directly.

var Claude = (function () {
  var BASE = 'https://api.anthropic.com/v1/';

  function opts(key, method, payload) {
    var o = { method: method || 'get', muteHttpExceptions: true,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } };
    if (payload) { o.contentType = 'application/json'; o.payload = JSON.stringify(payload); }
    return o;
  }

  function parse(resp) {
    try { return JSON.parse(resp.getContentText()); } catch (e) { return { type: 'error', error: { type: 'bad_response', code: resp.getResponseCode() } }; }
  }

  function retryable(resp) {
    var c = resp.getResponseCode();
    return c === 429 || c === 529 || c >= 500;
  }

  // Several Messages API calls in parallel (5 at a time). Returns parsed responses in order.
  function many(bodies, key) {
    var out = [];
    for (var i = 0; i < bodies.length; i += 5) {
      var chunk = bodies.slice(i, i + 5);
      var resps = UrlFetchApp.fetchAll(chunk.map(function (b) {
        var o = opts(key, 'post', b); o.url = BASE + 'messages'; return o;
      }));
      resps.forEach(function (resp, j) {
        if (retryable(resp)) {
          Utilities.sleep(4000);
          resp = UrlFetchApp.fetch(BASE + 'messages', opts(key, 'post', chunk[j]));
        }
        out.push(parse(resp));
      });
    }
    return out;
  }

  // Message Batches API: half price, results within 24h (usually minutes). Used for the backfill.
  function createBatch(requests, key) {
    var r = parse(UrlFetchApp.fetch(BASE + 'messages/batches', opts(key, 'post', { requests: requests })));
    if (!r.id) throw new Error('Batch create failed: ' + JSON.stringify(r).slice(0, 300));
    return r;
  }

  function getBatch(id, key) {
    return parse(UrlFetchApp.fetch(BASE + 'messages/batches/' + id, opts(key)));
  }

  function batchResults(url, key) {
    var text = UrlFetchApp.fetch(url, opts(key)).getContentText();
    return text.split('\n').filter(function (l) { return l.trim(); }).map(function (l) { return JSON.parse(l); });
  }

  return { many: many, createBatch: createBatch, getBatch: getBatch, batchResults: batchResults };
})();

// ---- DeepSeek.js ----
// DeepSeek chat completions over UrlFetchApp (used when PROVIDER is deepseek). Same job as Claude.many.
// DeepSeek has no batch API, so the backfill calls this directly instead of submitting a batch.

var DeepSeek = (function () {
  var URL = 'https://api.deepseek.com/chat/completions';

  function opts(key, payload) {
    return { url: URL, method: 'post', muteHttpExceptions: true, contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + key }, payload: JSON.stringify(payload) };
  }

  function parse(resp) {
    try { return JSON.parse(resp.getContentText()); } catch (e) { return { error: { type: 'bad_response', code: resp.getResponseCode() } }; }
  }

  function retryable(resp) {
    var c = resp.getResponseCode();
    return c === 429 || c >= 500;
  }

  // JSON mode sometimes returns an empty reply; one more try usually fixes it.
  function empty(r) {
    return r.choices && !(r.choices[0] && r.choices[0].message && String(r.choices[0].message.content || '').trim());
  }

  function many(bodies, key) {
    var out = [];
    for (var i = 0; i < bodies.length; i += 5) {
      var chunk = bodies.slice(i, i + 5);
      var resps = UrlFetchApp.fetchAll(chunk.map(function (b) { return opts(key, b); }));
      resps.forEach(function (resp, j) {
        if (retryable(resp)) {
          Utilities.sleep(4000);
          resp = UrlFetchApp.fetch(URL, opts(key, chunk[j]));
        }
        var r = parse(resp);
        if (empty(r)) r = parse(UrlFetchApp.fetch(URL, opts(key, chunk[j])));
        out.push(r);
      });
    }
    return out;
  }

  return { many: many };
})();

// ---- AgentLog.js ----
// Decision log: every add/update/delete/skip with its reason. Goes to the execution log (console)
// and to the "Log" tab of the log spreadsheet created by setup().

var AgentLog = (function () {
  var HEADER = ['Time (IST)', 'Mode', 'Action', 'Who', 'Title', 'When', 'Confidence', 'Reason', 'Source', 'Meeting id'];
  var rows = [], mode = 'LIVE';

  function start(m) { rows = []; mode = m; }

  function add(e) {
    var row = [new Date(), mode, e.action || '', e.who || '', e.title || '', e.when || '',
      e.confidence === undefined || e.confidence === null ? '' : Number(e.confidence).toFixed(2),
      e.reason || '', e.link || '', e.meetingId || ''];
    rows.push(row);
    console.log([mode, e.action, e.who, e.title, e.when, e.confidence !== undefined ? 'conf=' + e.confidence : '', e.reason, e.link]
      .filter(function (x) { return x !== undefined && x !== null && x !== ''; }).join(' | '));
  }

  function flush() {
    var id = props_().getProperty('LOG_SHEET_ID');
    if (!id || !rows.length) return;
    try {
      var sheet = SpreadsheetApp.openById(id).getSheetByName('Log');
      if (sheet.getLastRow() === 0) sheet.appendRow(HEADER);
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADER.length).setValues(rows);
      if (sheet.getLastRow() > 20000) sheet.deleteRows(2, 5000);
    } catch (e) {
      console.warn('Could not write log sheet: ' + e);
    }
    rows = [];
  }

  return { start: start, add: add, flush: flush, HEADER: HEADER };
})();

// ---- SharedStore.js ----
// The shared "Founders — All Meetings" calendar. Every account's copy of the script reads and writes it,
// so all shared state lives here (Advanced Calendar service):
//   - live meetings: real events carrying their observations in private extended properties (fm=1)
//   - cancelled meetings: hidden "memory" events dated 1 Jan 2000 (fm_tomb=1), so that no copy re-adds
//     a meeting another copy saw get cancelled.

var SharedStore = (function () {
  var TOMB_DAY = '2000-01-01';

  function calId() {
    var id = props_().getProperty('SHARED_CALENDAR_ID');
    if (!id) throw new Error('SHARED_CALENDAR_ID not set. Run setup() first.');
    return id;
  }

  function listAll(opts) {
    var out = [], pageToken = null;
    do {
      var r = Calendar.Events.list(calId(), Object.assign({ singleEvents: true, maxResults: 2500, pageToken: pageToken }, opts));
      out = out.concat(r.items || []);
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  function load(now) {
    var meetings = [];
    listAll({ timeMin: new Date(now - 86400000).toISOString(), privateExtendedProperty: 'fm=1' }).forEach(function (ev) {
      var m = Render.meetingFromEvent(ev);
      if (m) meetings.push(m);
    });
    listAll({ timeMax: '2000-01-03T00:00:00Z', privateExtendedProperty: 'fm_tomb=1' }).forEach(function (ev) {
      var m = Render.meetingFromEvent(ev);
      if (!m) return;
      m.tomb = true;
      m.tombEventId = m.eventId;
      m.eventId = null;
      meetings.push(m);
    });
    return meetings;
  }

  function tombEvent(m, fp) {
    var priv = { fm_tomb: '1', fm_id: m.id, fm_fp: fp };
    var obs = m.obs.slice(-30);
    obs.forEach(function (o, i) { priv['o' + i] = Render.compactObs(o); });
    var end = Math.max.apply(null, obs.map(function (o) { return o.end || 0; }));
    priv.fm_end = String(end);
    var last = obs[obs.length - 1] || {};
    return {
      summary: '(agent memory) cancelled: ' + Util.truncate(last.title || m.id, 80),
      description: 'Remembers a cancelled meeting so it is not added again. Safe to ignore; removed automatically.',
      start: { date: TOMB_DAY }, end: { date: '2000-01-02' },
      transparency: 'transparent', visibility: 'private',
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: { 'private': priv }
    };
  }

  function saveTomb(m, fp) {
    var ev = tombEvent(m, fp);
    if (m.tombEventId) Calendar.Events.update(ev, calId(), m.tombEventId);
    else m.tombEventId = Calendar.Events.insert(ev, calId()).id;
  }

  function removeQuietly(id, eventId) {
    try { Calendar.Events.remove(id, eventId); } catch (e) { if (!/not found|deleted|410|404/i.test(String(e))) throw e; }
  }

  // Another account's copy may have created the same meeting moments ago.
  function existsAlready(id, meetingId) {
    var r = Calendar.Events.list(id, { privateExtendedProperty: 'fm_id=' + meetingId, maxResults: 5, singleEvents: true });
    return (r.items || []).some(function (ev) { return ev.status !== 'cancelled' && ev.extendedProperties && ev.extendedProperties['private'].fm === '1'; });
  }

  // Applies ops; one failing op is logged and does not stop the others.
  function apply(ops) {
    var id = calId(), done = 0;
    ops.forEach(function (op) {
      var m = op.meeting;
      try {
        if (op.type === 'create') {
          if (existsAlready(id, m.id)) {
            AgentLog.add({ action: 'note', title: op.event.summary, reason: 'already created by another account; merged next run', meetingId: m.id });
            return;
          }
          m.eventId = Calendar.Events.insert(op.event, id).id;
          if (m.tombEventId) { removeQuietly(id, m.tombEventId); m.tombEventId = null; }
        } else if (op.type === 'update') {
          Calendar.Events.update(op.event, id, m.eventId);
        } else if (op.type === 'delete') {
          removeQuietly(id, m.eventId);
          if (op.tomb) saveTomb(m, op.tombFp);
        } else if (op.type === 'tomb') {
          saveTomb(m, op.tombFp);
        } else if (op.type === 'droptomb') {
          if (m.tombEventId) removeQuietly(id, m.tombEventId);
        }
        done++;
      } catch (e) {
        AgentLog.add({ action: 'error', title: m.id, reason: op.type + ' failed: ' + e, meetingId: m.id });
      }
    });
    return done;
  }

  function pruneTombs(now) {
    listAll({ timeMax: '2000-01-03T00:00:00Z', privateExtendedProperty: 'fm_tomb=1' }).forEach(function (ev) {
      var end = Number(ev.extendedProperties['private'].fm_end || 0);
      if (end < now - 86400000) removeQuietly(calId(), ev.id);
    });
  }

  return { calId: calId, load: load, apply: apply, pruneTombs: pruneTombs };
})();

// ---- Backfill.js ----
// First-run backfill of the last BACKFILL_MONTHS of mail, spread over many sync runs.
// With Claude, candidate threads go to the Message Batches API (half price) and results are collected
// on later runs. DeepSeek has no batch API, so its threads are extracted right away, in smaller pages.
// Only meetings that are still in the future are kept.

var Backfill = (function () {
  var PAGE = 50;
  var MIN_LEFT_MS = 75 * 1000; // stop starting new pages when less than this is left

  function pending() { return JSON.parse(props_().getProperty('BATCHES') || '[]'); }
  function savePending(list) { props_().setProperty('BATCHES', JSON.stringify(list)); }

  // custom_id carries what we need to rebuild context: "<aid>_<threadId>_<asOf base36>"
  function customId(acct, threadId, asOf) { return acct.aid + '_' + threadId + '_' + asOf.toString(36); }
  function parseId(id) {
    var p = id.split('_');
    return { aid: p[0], threadId: p[1], asOf: parseInt(p[2], 36) };
  }

  function collect(accounts, cfg, now, updates, t0, budget) {
    var key = cfg.raw.ANTHROPIC_API_KEY;
    if (!key) return; // batches only exist with Claude
    var byAid = {};
    accounts.forEach(function (a) { byAid[a.aid] = a; });
    var still = [];
    pending().forEach(function (b) {
      if (Date.now() - t0 > budget - MIN_LEFT_MS) { still.push(b); return; }
      var st = Claude.getBatch(b.id, key);
      if (st.type === 'error') { AgentLog.add({ action: 'error', reason: 'batch ' + b.id + ': ' + JSON.stringify(st.error) }); still.push(b); return; }
      if (st.processing_status !== 'ended') { still.push(b); return; }
      var n = 0;
      Claude.batchResults(st.results_url, key).forEach(function (line) {
        var id = parseId(line.custom_id);
        var acct = byAid[id.aid];
        if (!acct) return; // account removed since
        var link = Sources.gmailLink(acct.email, id.threadId);
        if (!line.result || line.result.type !== 'succeeded') {
          AgentLog.add({ action: 'error', who: acct.founder, reason: 'backfill extraction ' + (line.result ? line.result.type : 'missing'), link: link });
          return;
        }
        var r = Extract.toObservations(line.result.message, { acct: acct, threadId: id.threadId, asOf: id.asOf, knownIds: [] }, cfg, now);
        r.skipped.forEach(function (s) {
          if (!/past/.test(s.reason)) AgentLog.add({ action: 'skip', who: acct.founder, title: s.title, confidence: s.confidence, reason: s.reason, link: link });
        });
        if (r.error) return;
        updates.push({ scope: Sources.threadScope(acct, id.threadId), kind: 'email', asOf: id.asOf, obs: r.obs, keepIds: r.keepIds });
        n++;
      });
      AgentLog.add({ action: 'note', reason: 'backfill batch ' + b.id + ' done: ' + n + ' threads' });
    });
    savePending(still);
  }

  // DeepSeek path: extract the page's candidates now instead of batching them.
  // Returns false if the API itself failed (no credit, bad key, outage): the page is then redone next run.
  function extractNow(requests, acct, cfg, now, updates) {
    var resps = askModel_(requests.map(function (r) { return r.params; }), cfg);
    var apiError = null;
    resps.forEach(function (r) { if (!apiError && r && r.error) apiError = r.error; });
    if (apiError) {
      AgentLog.add({ action: 'error', who: acct.founder, reason: 'backfill paused, DeepSeek API error (will retry): ' + JSON.stringify(apiError).slice(0, 200) });
      return false;
    }
    requests.forEach(function (req, i) {
      var id = parseId(req.custom_id);
      var link = Sources.gmailLink(acct.email, id.threadId);
      var r = Extract.toObservations(resps[i], { acct: acct, threadId: id.threadId, asOf: id.asOf, knownIds: [] }, cfg, now);
      if (r.error) return AgentLog.add({ action: 'error', who: acct.founder, reason: 'backfill extraction: ' + r.error, link: link });
      r.skipped.forEach(function (s) {
        if (!/past/.test(s.reason)) AgentLog.add({ action: 'skip', who: acct.founder, title: s.title, confidence: s.confidence, reason: s.reason, link: link });
      });
      updates.push({ scope: Sources.threadScope(acct, id.threadId), kind: 'email', asOf: id.asOf, obs: r.obs, keepIds: r.keepIds });
    });
    return true;
  }

  function advance(acct, cfg, now, updates, patches, t0, budget) {
    var bf = JSON.parse(JSON.stringify(acct.backfill));
    var direct = cfg.provider === 'deepseek';
    var token = Self.token();
    var q = 'after:' + bf.afterSec + ' ' + GmailApi.SEARCH;
    while (bf.phase === 'list' && Date.now() - t0 < budget - MIN_LEFT_MS) {
      var page = GmailApi.listThreads(token, q, bf.pageToken, direct ? PAGE / 2 : PAGE);
      var requests = [];
      GmailApi.getThreads(token, page.ids).forEach(function (th) {
        if (!th.messages.length || !Prefilter.checkThread(th).candidate) return;
        var asOf = th.messages[th.messages.length - 1].date;
        if (th.messages.some(function (m) { return m.icsTexts.length; })) {
          var r = Sources.fromThreadIcs(th, acct, cfg);
          var future = r.obs.filter(function (o) { return o.end > now; });
          if (r.obs.length || r.skipped.length) {
            if (future.length) updates.push({ scope: Sources.threadScope(acct, th.id), kind: 'email', asOf: asOf, obs: future });
            return;
          }
        }
        requests.push({ custom_id: customId(acct, th.id, asOf), params: Extract.buildRequest(th, acct, [], cfg, now) });
      });
      if (requests.length && direct) {
        if (!extractNow(requests, acct, cfg, now, updates)) break;
      } else if (requests.length) {
        var batch = Claude.createBatch(requests, cfg.raw.ANTHROPIC_API_KEY);
        var list = pending();
        list.push({ id: batch.id, aid: acct.aid, n: requests.length, at: now });
        savePending(list); // saved right away so results are never orphaned
      }
      bf.threads += page.ids.length;
      bf.pageToken = page.nextPageToken;
      if (!bf.pageToken) {
        bf.phase = 'done';
        AgentLog.add({ action: 'note', who: acct.founder, reason: 'backfill listing finished for ' + acct.email + ' (' + bf.threads + ' threads scanned)' });
      }
    }
    var prev = patches[acct.email];
    patches[acct.email] = function (a) { if (prev) prev(a); a.backfill = bf; };
  }

  function step(accounts, cfg, now, updates, patches, t0, budget) {
    try { collect(accounts, cfg, now, updates, t0, budget); }
    catch (e) { AgentLog.add({ action: 'error', reason: 'collecting backfill results: ' + e.message }); }
    accounts.filter(function (a) { return a.status === 'ok' && a.backfill && a.backfill.phase === 'list'; }).forEach(function (acct) {
      if (Date.now() - t0 > budget - MIN_LEFT_MS) return;
      try { advance(acct, cfg, now, updates, patches, t0, budget); }
      catch (e) { AgentLog.add({ action: 'error', who: acct.founder, reason: 'backfill for ' + acct.email + ': ' + e.message }); }
    });
  }

  function status() {
    return { pendingBatches: pending().length };
  }

  return { step: step, status: status, customId: customId, parseId: parseId };
})();

// ---- Sync.js ----
// The sync loop. syncAll() runs from a time trigger every 10 minutes; dryRun() is the manual preview.

var BUDGET_MS = 4.5 * 60 * 1000;     // Apps Script stops a run at 6 minutes.
var MAX_THREADS_PER_ACCOUNT = 60;    // per run; the rest waits in the account's retry list

function syncAll() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { console.log('Previous sync still running; skipping this one.'); return; }
  try { runSync_({ dry: false }); } finally { lock.releaseLock(); }
}

// Prints what would be added/changed for mail from the last DRY_RUN_DAYS days + all calendars,
// without writing to the shared calendar or moving any cursors. Results: execution log + "Log" tab.
function dryRun() {
  runSync_({ dry: true });
}

function runSync_(mode) {
  var t0 = Date.now(), now = Date.now();
  var cfg = getConfig_();
  requireSettings_(cfg, [cfg.keyName, 'SHARED_CALENDAR_ID']);
  AgentLog.start(mode.dry ? 'DRY' : 'LIVE');

  var acct = Self.account();
  var token = Self.token();
  var meetings = SharedStore.load(now);
  var updates = [], jobs = [], patches = {};
  var stats = { threads: 0, candidates: 0, llm: 0 };

  try {
    updates.push({ scope: Sources.calScope(acct), kind: 'calendar', asOf: now, obs: calendarObservations_(acct, token, cfg, now) });
  } catch (e) {
    AgentLog.add({ action: 'error', who: acct.founder, reason: 'calendar read failed for ' + acct.email + ': ' + e.message });
  }

  try {
    var ids;
    if (mode.dry) {
      ids = GmailApi.listThreads(token, 'newer_than:' + cfg.dryRunDays + 'd ' + GmailApi.SEARCH, null, cfg.dryRunMaxThreads).ids;
    } else {
      var inc = incrementalThreadIds_(acct, token, now);
      ids = inc.ids;
      patches[acct.email] = inc.patch;
    }
    var threads = GmailApi.getThreads(token, ids);
    stats.threads = threads.length;
    threads.forEach(function (th) {
      if (planThread_(th, acct, meetings, cfg, now, updates, jobs)) stats.candidates++;
    });
  } catch (e) {
    AgentLog.add({ action: 'error', who: acct.founder, reason: 'gmail read failed for ' + acct.email + ': ' + e.message });
  }

  stats.llm = jobs.length;
  var failed = runJobs_(jobs, cfg, now, updates, mode);
  if (!mode.dry) Backfill.step([acct], cfg, now, updates, patches, t0, BUDGET_MS);

  var res = Reconcile.run(meetings, updates, cfg, now);
  res.notes.forEach(function (n) { AgentLog.add({ action: 'skip', reason: n.reason }); });
  res.ops.forEach(function (op) { logOp_(op, cfg); });

  if (!mode.dry) {
    SharedStore.apply(res.ops);
    Self.update(function (a) {
      if (patches[a.email]) patches[a.email](a);
      a.retry = Util.uniq((a.retry || []).concat(failed[a.email] || [])).slice(0, 100);
    });
    SharedStore.pruneTombs(now);
  }
  AgentLog.add({ action: 'run', reason: (mode.dry ? 'dry run: ' : '') + acct.email + ': ' + stats.threads + ' threads read, ' +
    stats.candidates + ' candidates, ' + stats.llm + ' sent to ' + cfg.provider + ', ' + res.ops.length + ' calendar changes' +
    (mode.dry ? ' (not applied)' : '') + ', ' + Math.round((Date.now() - t0) / 1000) + 's' });
  AgentLog.flush();
}

// Stops syncing this account and removes upcoming meetings that only this account knew about.
function removeThisAccount() {
  disableSync();
  var now = Date.now(), cfg = getConfig_(), acct = Self.account();
  AgentLog.start('LIVE');
  var res = Reconcile.run(SharedStore.load(now), [
    { scope: Sources.threadScope(acct, ''), prefix: true, kind: 'removal', asOf: now, obs: [] },
    { scope: Sources.calScope(acct), kind: 'removal', asOf: now, obs: [] }
  ], cfg, now);
  res.ops.forEach(function (op) { logOp_(op, cfg); });
  SharedStore.apply(res.ops);
  props_().deleteProperty('SELF');
  AgentLog.add({ action: 'note', reason: acct.email + ' removed: ' + res.ops.length + ' calendar changes' });
  AgentLog.flush();
}

function calendarObservations_(acct, token, cfg, now) {
  var obs = [];
  CalApi.ownedCalendars(token, cfg.raw.SHARED_CALENDAR_ID).forEach(function (cal) {
    var calCfg = Object.create(cfg);
    calCfg.calendarTz = cal.timeZone;
    CalApi.events(token, cal.id, now, now + cfg.lookaheadDays * 86400000).forEach(function (ev) {
      var o = Sources.fromCalendarEvent(ev, acct, calCfg);
      if (!o.skip) obs.push(o);
    });
  });
  return obs;
}

// New thread ids since the last run, plus a patch that advances the cursor once the run succeeds.
function incrementalThreadIds_(acct, token, now) {
  var ids = (acct.retry || []).slice();
  var nextHistory;
  if (!acct.historyId) {
    nextHistory = GmailApi.profile(token).historyId;
  } else {
    var h = GmailApi.history(token, acct.historyId);
    if (h.expired) {
      // History is kept ~a week; after a long outage fall back to a date search.
      nextHistory = GmailApi.profile(token).historyId;
      var since = Math.floor(((acct.lastSync || now - 2 * 86400000) - 3600000) / 1000);
      ids = ids.concat(GmailApi.listThreads(token, 'after:' + since, null, 200).ids);
    } else {
      nextHistory = h.historyId;
      ids = ids.concat(h.ids);
    }
  }
  ids = Util.uniq(ids);
  var now_ = ids.slice(0, MAX_THREADS_PER_ACCOUNT), later = ids.slice(MAX_THREADS_PER_ACCOUNT);
  return {
    ids: now_,
    patch: function (a) { a.historyId = nextHistory; a.lastSync = now; a.retry = later; }
  };
}

// Meetings this thread may be about: ones it produced before, plus upcoming ones with the same outside people.
function knownContext_(th, scope, meetings, cfg, now) {
  var people = {};
  th.messages.forEach(function (m) {
    Util.emailsIn([m.from, m.to, m.cc].join(' ')).forEach(function (e) { if (!cfg.founderOf[e]) people[e] = true; });
  });
  var latest = function (m) {
    return m.obs.slice().sort(function (a, b) { return b.asOf - a.asOf; }).filter(function (o) { return o.status !== 'cancelled'; })[0] || m.obs[0];
  };
  var own = [], related = [];
  meetings.forEach(function (m) {
    if (!m.obs.length) return;
    if (m.obs.some(function (o) { return o.src === scope; })) { own.push(m); return; }
    var l = latest(m);
    if (l.end > now && !m.tomb && m.obs.some(function (o) { return (o.attendees || []).some(function (e) { return people[e]; }); })) related.push(m);
  });
  var pick = own.concat(related.slice(0, Math.max(0, 8 - own.length)));
  return {
    known: pick.map(function (m) { var l = latest(m); return { id: m.id, title: l.title, start: l.start, with: l.with }; }),
    knownIds: own.map(function (m) { return m.id; }),
    contextIds: related.map(function (m) { return m.id; })
  };
}

// Decides how to handle a thread: invites are parsed directly, likely meetings go to the model.
function planThread_(th, acct, meetings, cfg, now, updates, jobs) {
  if (!th.messages.length) return false;
  var scope = Sources.threadScope(acct, th.id);
  var asOf = th.messages[th.messages.length - 1].date;
  var linked = meetings.some(function (m) { return m.obs.some(function (o) { return o.src === scope; }); });
  var pf = Prefilter.checkThread(th);
  if (!pf.candidate && !linked) return false;

  if (th.messages.some(function (m) { return m.icsTexts && m.icsTexts.length; })) {
    var r = Sources.fromThreadIcs(th, acct, cfg);
    var future = r.obs.filter(function (o) { return o.end > now; });
    if (r.obs.length || r.skipped.length) {
      if (r.obs.length) updates.push({ scope: scope, kind: 'email', asOf: asOf, obs: future });
      return true;
    }
  }
  var ctx = knownContext_(th, scope, meetings, cfg, now);
  jobs.push({ acct: acct, threadId: th.id, scope: scope, asOf: asOf, subject: th.subject, ctx: ctx,
    body: Extract.buildRequest(th, acct, ctx.known, cfg, now) });
  return true;
}

// Sends extraction requests to whichever model provider is configured. Responses come back in order.
function askModel_(bodies, cfg) {
  var key = cfg.raw[cfg.keyName];
  return cfg.provider === 'deepseek' ? DeepSeek.many(bodies, key) : Claude.many(bodies, key);
}

// Calls the model for every planned thread. Returns { email: [threadIds that failed] } for retry.
function runJobs_(jobs, cfg, now, updates, mode) {
  var failed = {};
  if (!jobs.length) return failed;
  var resps = askModel_(jobs.map(function (j) { return j.body; }), cfg);
  jobs.forEach(function (j, i) {
    var r = Extract.toObservations(resps[i], { acct: j.acct, threadId: j.threadId, asOf: j.asOf,
      knownIds: j.ctx.knownIds, contextIds: j.ctx.contextIds }, cfg, now);
    var link = Sources.gmailLink(j.acct.email, j.threadId);
    if (r.error) {
      AgentLog.add({ action: 'error', who: j.acct.founder, title: j.subject, reason: 'extraction failed: ' + r.error + ' (will retry)', link: link });
      (failed[j.acct.email] = failed[j.acct.email] || []).push(j.threadId);
      return;
    }
    r.skipped.forEach(function (s) {
      AgentLog.add({ action: 'skip', who: j.acct.founder, title: s.title, confidence: s.confidence, reason: s.reason, link: link });
    });
    if (mode.dry) {
      r.obs.forEach(function (o) {
        AgentLog.add({ action: 'detected', who: o.founder, title: o.title, when: Util.fmt(o.start, cfg.defaultTz),
          confidence: o.confidence, reason: o.status + ': "' + o.evidence + '"', link: link });
      });
    }
    updates.push({ scope: j.scope, kind: 'email', asOf: j.asOf, obs: r.obs, keepIds: r.keepIds });
  });
  return failed;
}

function logOp_(op, cfg) {
  var m = op.meeting;
  var s = op.state;
  var latest = m.obs.slice().sort(function (a, b) { return b.asOf - a.asOf; })[0];
  AgentLog.add({
    action: op.type,
    who: s ? s.founders.join('+') : (latest ? latest.founder : ''),
    title: op.event ? op.event.summary : (latest ? latest.title : m.id),
    when: s ? Util.fmt(s.start, s.tz) : (latest ? Util.fmt(latest.start, cfg.defaultTz) : ''),
    confidence: s ? s.confidence : null,
    reason: op.reason || '',
    link: (op.by && op.by.link) || (s && s.timeSource && s.timeSource.link) || (latest && latest.link) || '',
    meetingId: m.id
  });
}

// ---- Setup.js ----
// One-time setup and maintenance. In the Apps Script editor pick a function in the toolbar and click Run.
//
//   setup()             run once per account (the calendar owner's account first)
//   dryRun()            preview what would be added, without writing anything
//   enableSync()        start syncing every 10 minutes
//   disableSync()       pause
//   removeThisAccount() stop and remove this account's upcoming meetings
//   showStatus()        print progress

function setup() {
  var cfg = getConfig_();
  requireSettings_(cfg, [cfg.keyName]);
  var me = Self.email();
  var tag = Self.tag();
  var p = props_();
  var isOwner = me === CONFIG.calendarOwner.toLowerCase();

  var calId = p.getProperty('SHARED_CALENDAR_ID') || findSharedCalendar_();
  if (!calId && isOwner) {
    calId = Calendar.Calendars.insert({
      summary: CONFIG.calendarName,
      description: 'Maintained automatically by the Founders Meeting Agent. [R]/[H]/[A] = whose meeting it is.',
      timeZone: cfg.defaultTz
    }).id;
    console.log('Created the shared calendar "' + CONFIG.calendarName + '".');
  }
  if (!calId) {
    throw new Error('Could not find the "' + CONFIG.calendarName + '" calendar in ' + me + '. ' +
      'Run setup() in ' + CONFIG.calendarOwner + ' first. Then either click "Add this calendar" in the "shared with you" email in this account, ' +
      'or add the Script property SHARED_CALENDAR_ID with the calendar ID that setup printed in ' + CONFIG.calendarOwner + '. Then run setup() again.');
  }
  p.setProperty('SHARED_CALENDAR_ID', calId);
  if (isOwner) shareCalendar_(calId);
  else addToCalendarList_(calId, me);

  // Check we can write to it (the owner must have given this account "Make changes to events").
  var acl = Calendar.CalendarList.get(calId);
  if (acl.accessRole !== 'owner' && acl.accessRole !== 'writer') {
    throw new Error(me + ' can only view the shared calendar (' + acl.accessRole + '). The owner (' + CONFIG.calendarOwner +
      ') must share it with "Make changes to events". See the README section "If sharing fails".');
  }

  if (!p.getProperty('LOG_SHEET_ID')) {
    var ss = SpreadsheetApp.create('Founders Meeting Agent — Log (' + me + ')');
    var sheet = ss.getSheets()[0];
    sheet.setName('Log');
    sheet.appendRow(AgentLog.HEADER);
    sheet.setFrozenRows(1);
    p.setProperty('LOG_SHEET_ID', ss.getId());
  }
  Self.save(Self.account());

  console.log([
    '',
    '✅ Setup done for ' + me + ' (meetings tagged [' + tag + ']).',
    'Shared calendar: ' + calId,
    'Decision log: https://docs.google.com/spreadsheets/d/' + p.getProperty('LOG_SHEET_ID'),
    '',
    'Next: run dryRun() and check the log, then run enableSync().'
  ].concat(isOwner ? ['', 'If another account never gets the "shared with you" email, add this Script property there instead:',
    '  SHARED_CALENDAR_ID = ' + calId] : []).join('\n'));
}

// Same as clicking "Add this calendar" in the share email, for when that email never arrives.
function addToCalendarList_(calId, me) {
  try { Calendar.CalendarList.get(calId); return; } catch (e) { /* not added yet */ }
  try {
    Calendar.CalendarList.insert({ id: calId });
    console.log('Added the shared calendar to ' + me + '.');
  } catch (e) {
    throw new Error(me + ' has no access to the shared calendar yet. Run setup() in ' + CONFIG.calendarOwner +
      ' (it shares the calendar with this account), and check the tryamp.in admin setting "outsiders can change calendars". (' + e.message + ')');
  }
}

function findSharedCalendar_() {
  var pageToken = null;
  do {
    var r = Calendar.CalendarList.list({ pageToken: pageToken, maxResults: 250 });
    var hit = (r.items || []).filter(function (c) { return (c.summaryOverride || c.summary) === CONFIG.calendarName; })[0];
    if (hit) return hit.id;
    pageToken = r.nextPageToken;
  } while (pageToken);
  return null;
}

// Owner only: gives every other account edit access (the script there writes meetings) and each
// founder's phone account the same, so it shows up on their phone.
function shareCalendar_(calId) {
  var want = Object.keys(CONFIG.accounts).concat(CONFIG.founders.map(function (f) { return f.emails[0]; }))
    .map(function (e) { return e.toLowerCase(); })
    .filter(function (e, i, all) { return e !== CONFIG.calendarOwner.toLowerCase() && all.indexOf(e) === i; });
  var existing = {};
  (Calendar.Acl.list(calId).items || []).forEach(function (r) { if (r.scope && r.scope.value) existing[r.scope.value.toLowerCase()] = r.role; });
  var failed = [];
  want.forEach(function (email) {
    if (existing[email] === 'writer' || existing[email] === 'owner') return;
    try {
      Calendar.Acl.insert({ role: 'writer', scope: { type: 'user', value: email } }, calId, { sendNotifications: true });
      console.log('Shared with ' + email + ' (can edit).');
    } catch (e) {
      failed.push(email + ': ' + e.message);
    }
  });
  if (failed.length) {
    console.warn('Could not share with:\n  ' + failed.join('\n  ') +
      '\nUsually the domain blocks sharing outside the organisation. See README "If sharing fails".');
  }
}

// Starts the 10-minute sync. Run dryRun() first and check the log.
function enableSync() {
  disableSync();
  ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(10).create();
  console.log('Sync enabled for ' + Self.email() + ': every 10 minutes. First runs also scan the last ' + getConfig_().backfillMonths + ' months.');
}

function disableSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncAll') ScriptApp.deleteTrigger(t);
  });
  console.log('Sync disabled.');
}

function showStatus() {
  var a = Self.account();
  var tz = getConfig_().defaultTz;
  console.log([
    a.email + ' [' + a.founder + ']',
    'Last sync: ' + (a.lastSync ? Util.fmt(a.lastSync, tz) : 'never'),
    'Backfill: ' + a.backfill.phase + ', ' + a.backfill.threads + ' threads scanned, ' + Backfill.status().pendingBatches + ' batches pending',
    'Retry queue: ' + (a.retry || []).length,
    'Sync trigger: ' + (ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'syncAll'; }) ? 'on' : 'off'),
    'Log: https://docs.google.com/spreadsheets/d/' + props_().getProperty('LOG_SHEET_ID')
  ].join('\n'));
}
