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
  function fromCalendarEvent(ev, acct, cfg) {
    if (!ev || !ev.start) return { skip: 'no start' };
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
