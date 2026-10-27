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
