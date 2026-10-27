// The morning brief: one founder's meetings for the day, as plain text (push) and HTML (email).
// Works from shared-calendar events, whose titles start with the owner tag, e.g. "[R+H] (?) Demo with Acme".

var Brief = (function () {
  var TAG = /^\[([A-Z]+(?:\+[A-Z]+)*)\]\s*(\(\?\)\s*)?/;

  function hhmm(ms, tz) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  }

  // "Wednesday 28 Oct", built from parts because ICU versions differ on the comma.
  function dayLabel(ms, tz) {
    var p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'short' })
      .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return p.weekday + ' ' + p.day + ' ' + p.month;
  }

  // Midnight-to-midnight bounds of the day containing `now` in tz.
  function dayBounds(now, tz) {
    var p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(now)).forEach(function (x) { p[x.type] = x.value; });
    var start = Util.zonedToUtc(+p.year, +p.month, +p.day, 0, 0, 0, tz);
    return { start: start, end: Util.zonedToUtc(+p.year, +p.month, +p.day + 1, 0, 0, 0, tz) };
  }

  function fromEvent(ev) {
    if (!ev || ev.status === 'cancelled' || !ev.start || !ev.start.dateTime) return null;
    var m = TAG.exec(ev.summary || '');
    if (!m) return null;
    var join = /^Join: (\S+)/m.exec(ev.description || '');
    return {
      tags: m[1].split('+'),
      tentative: !!m[2],
      title: (ev.summary || '').slice(m[0].length).trim() || '(untitled meeting)',
      start: Date.parse(ev.start.dateTime),
      end: ev.end && ev.end.dateTime ? Date.parse(ev.end.dateTime) : null,
      joinUrl: join ? join[1] : null,
      location: ev.location && !/^https?:/.test(ev.location) ? ev.location : null,
      link: ev.htmlLink || null
    };
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // events: shared-calendar events for the day. Returns { count, title, text, html } for founder `tag`.
  function build(events, tag, tz, now) {
    var items = events.map(fromEvent).filter(function (x) { return x && x.tags.indexOf(tag) >= 0; })
      .sort(function (a, b) { return a.start - b.start; });
    var day = dayLabel(now, tz);
    var others = function (x) { var o = x.tags.filter(function (t) { return t !== tag; }); return o.length ? ' (with ' + o.join('+') + ')' : ''; };
    if (!items.length) return { count: 0, title: day + ': no meetings', text: 'Nothing on the shared calendar today.', html: '' };

    var text = items.map(function (x) {
      var where = x.joinUrl ? ' · online' : x.location ? ' · ' + x.location : '';
      return hhmm(x.start, tz) + '  ' + (x.tentative ? '(?) ' : '') + x.title + others(x) + where;
    }).join('\n');

    var rows = items.map(function (x) {
      var time = hhmm(x.start, tz) + (x.end ? '–' + hhmm(x.end, tz) : '');
      var name = x.link ? '<a href="' + esc(x.link) + '">' + esc(x.title) + '</a>' : esc(x.title);
      var extra = [];
      if (x.tentative) extra.push('<span style="color:#b26a00">tentative, check the email</span>');
      if (others(x)) extra.push(esc(others(x).trim()));
      if (x.location) extra.push(esc(x.location));
      if (x.joinUrl) extra.push('<a href="' + esc(x.joinUrl) + '">Join</a>');
      return '<tr><td style="padding:6px 14px 6px 0;white-space:nowrap;vertical-align:top;font-weight:600">' + time + '</td>' +
        '<td style="padding:6px 0">' + name + (extra.length ? '<br><span style="color:#666;font-size:13px">' + extra.join(' · ') + '</span>' : '') + '</td></tr>';
    }).join('');
    var html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#202124">' +
      '<p style="margin:0 0 10px">' + esc(day) + '</p><table style="border-collapse:collapse">' + rows + '</table>' +
      '<p style="margin:16px 0 0;color:#888;font-size:12px">From the "Founders — All Meetings" calendar.</p></div>';
    var n = items.length;
    return { count: n, title: day + ': ' + n + ' meeting' + (n === 1 ? '' : 's') + ', first at ' + hhmm(items[0].start, tz), text: text, html: html };
  }

  return { build: build, dayBounds: dayBounds, fromEvent: fromEvent };
})();
