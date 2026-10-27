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
