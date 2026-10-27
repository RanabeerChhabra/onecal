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
