// Morning brief, run from the calendar owner's copy only (so each founder gets it once):
// - around 6:45 an email to each founder's phone account with the whole team's day, and
// - an all-day "☀ Today: …" item on the shared calendar, rewritten on every 2-hour sync with what's left.
//   Google Calendar shows it at the top of the day; its all-day notification gives the 7am alert.
//
//   enableMorningBrief()   run once in the owner's account
//   sendMorningBrief()     what the morning trigger runs; run it by hand to test
//   disableMorningBrief()

function enableMorningBrief() {
  requireOwner_();
  disableMorningBrief();
  var cfg = getConfig_();
  ScriptApp.newTrigger('sendMorningBrief').timeBased().atHour(6).nearMinute(45).everyDays(1).inTimezone(cfg.defaultTz).create();
  console.log(['Morning brief on: email around 6:45 and an all-day "☀ Today" item on the shared calendar,',
    'updated every 2 hours with what is left (' + cfg.defaultTz + ').',
    'For the 7am alert, set the calendar\'s all-day notification on each phone to "On the day at 7:00 AM".',
    'Run sendMorningBrief to test it now.'].join('\n'));
}

function disableMorningBrief() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendMorningBrief') ScriptApp.deleteTrigger(t);
  });
}

function morningBriefOn_() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'sendMorningBrief'; });
}

function sendMorningBrief() {
  requireOwner_();
  var b = todayBrief_();
  if (b.brief.count) {
    CONFIG.founders.forEach(function (f) {
      try { MailApp.sendEmail({ to: f.emails[0], subject: '☀ ' + b.brief.title, body: b.brief.text, htmlBody: b.brief.html, name: 'Founders Meeting Agent' }); }
      catch (e) { console.warn('Brief email to ' + f.name + ' failed: ' + e.message); }
    });
  }
  try { putTodayItem_(b); } catch (e) { console.warn('"☀ Today" item failed: ' + e.message); }
  console.log('Brief sent to ' + CONFIG.founders.map(function (f) { return f.name; }).join(', ') + ': ' + b.brief.title);
}

// Called after each full sync in the owner's copy: keeps the "☀ Today" item current.
function refreshTodayItem_() {
  if (Self.email() !== CONFIG.calendarOwner.toLowerCase() || !morningBriefOn_()) return;
  try { putTodayItem_(todayBrief_()); } catch (e) { console.warn('"☀ Today" refresh failed: ' + e.message); }
}

function todayBrief_() {
  var cfg = getConfig_();
  var calId = props_().getProperty('SHARED_CALENDAR_ID');
  var now = Date.now();
  var day = Brief.dayBounds(now, cfg.defaultTz);
  var events = Calendar.Events.list(calId, {
    timeMin: new Date(day.start).toISOString(), timeMax: new Date(day.end).toISOString(),
    singleEvents: true, orderBy: 'startTime', privateExtendedProperty: 'fm=1', maxResults: 250
  }).items || [];
  return { calId: calId, day: day, cfg: cfg, now: now, brief: Brief.build(events, null, cfg.defaultTz, now) };
}

// One all-day item per day, replaced on every refresh. Days with no meetings get none.
function putTodayItem_(t) {
  var tz = t.cfg.defaultTz, b = t.brief;
  var date = Util.isoInTz(t.day.start, tz).slice(0, 10);
  var find = function (key) {
    return (Calendar.Events.list(t.calId, { privateExtendedProperty: 'fm_brief=' + key, singleEvents: true, maxResults: 5 }).items || [])
      .filter(function (e) { return e.status !== 'cancelled'; });
  };
  // Older builds made a timed 7:10 event (keyed by the UTC date); replace it with the all-day item.
  var oldKey = new Date(t.day.start).toISOString().slice(0, 10);
  (oldKey === date ? [] : find(oldKey)).concat(find(date)).forEach(function (e) {
    if (!e.start.date) Calendar.Events.remove(t.calId, e.id);
  });
  var existing = find(date).filter(function (e) { return e.start.date; });
  if (!b.count) {
    existing.forEach(function (e) { Calendar.Events.remove(t.calId, e.id); });
    return;
  }
  var morning = !existing.length || Util.isoInTz(t.now, tz).slice(11, 13) < '08';
  var summary = !b.left ? '☀ Today: all ' + b.count + ' meeting' + (b.count === 1 ? '' : 's') + ' done'
    : (morning ? '☀ Today: ' : '☀ Left today: ') + b.oneLine;
  var ev = {
    summary: summary,
    description: b.title + '\n\n' + b.text + '\n\nUpdated ' + Util.isoInTz(t.now, tz).slice(11, 16) + ' · refreshes every 2 hours',
    start: { date: date },
    end: { date: Util.isoInTz(t.day.end, tz).slice(0, 10) },
    transparency: 'transparent',
    extendedProperties: { 'private': { fm_brief: date } }
  };
  if (existing.length) {
    if (existing[0].summary === ev.summary && existing[0].description === ev.description) return;
    Calendar.Events.update(ev, t.calId, existing[0].id);
  } else {
    Calendar.Events.insert(ev, t.calId);
  }
}

function requireOwner_() {
  if (Self.email() !== CONFIG.calendarOwner.toLowerCase()) {
    throw new Error('The morning brief runs from ' + CONFIG.calendarOwner + ' only, so each founder gets it once.');
  }
}
