// 7am morning brief, sent from the calendar owner's copy only (so each founder gets it once):
// an email to each founder's phone account, and a short "☀ Today: …" event on the shared calendar
// that Google Calendar shows on everyone's lock screen (via the calendar's default notification).
//
//   enableMorningBrief()   run once in the owner's account
//   sendMorningBrief()     what the 7am trigger runs; run it by hand to test
//   disableMorningBrief()

var BRIEF_EVENT_MIN = 7 * 60 + 10; // 7:10, so a "10 minutes before" notification fires at 7:00

function enableMorningBrief() {
  requireOwner_();
  disableMorningBrief();
  var cfg = getConfig_();
  ScriptApp.newTrigger('sendMorningBrief').timeBased().atHour(6).nearMinute(45).everyDays(1).inTimezone(cfg.defaultTz).create();
  console.log(['Morning brief on: email around 6:45-7:00 and a "☀ Today" event at 7:10 on the shared calendar (' + cfg.defaultTz + ').',
    'For the lock-screen alert, set the calendar\'s default notification on each phone to "10 minutes before".',
    'Run sendMorningBrief to test it now.'].join('\n'));
}

function disableMorningBrief() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendMorningBrief') ScriptApp.deleteTrigger(t);
  });
}

function sendMorningBrief() {
  requireOwner_();
  var cfg = getConfig_();
  var calId = props_().getProperty('SHARED_CALENDAR_ID');
  var now = Date.now();
  var day = Brief.dayBounds(now, cfg.defaultTz);
  var events = Calendar.Events.list(calId, {
    timeMin: new Date(day.start).toISOString(), timeMax: new Date(day.end).toISOString(),
    singleEvents: true, orderBy: 'startTime', privateExtendedProperty: 'fm=1', maxResults: 250
  }).items || [];
  var b = Brief.build(events, null, cfg.defaultTz, now); // everyone sees the whole team's day
  if (b.count) {
    CONFIG.founders.forEach(function (f) {
      try { MailApp.sendEmail({ to: f.emails[0], subject: b.title, body: b.text, htmlBody: b.html, name: 'Founders Meeting Agent' }); }
      catch (e) { console.warn('Brief email to ' + f.name + ' failed: ' + e.message); }
    });
  }
  try { putBriefEvent_(calId, day.start, b, cfg); }
  catch (e) { console.warn('Brief calendar event failed: ' + e.message); }
  console.log('Brief sent to ' + CONFIG.founders.map(function (f) { return f.name; }).join(', ') + ': ' + b.title);
}

// One "☀ Today" event per day, replaced if the brief runs again. Days with no meetings get none.
function putBriefEvent_(calId, dayStart, b, cfg) {
  var key = 'fm_brief=' + new Date(dayStart).toISOString().slice(0, 10);
  var existing = (Calendar.Events.list(calId, { privateExtendedProperty: key, singleEvents: true, maxResults: 5 }).items || [])
    .filter(function (e) { return e.status !== 'cancelled'; });
  if (!b.count) {
    existing.forEach(function (e) { Calendar.Events.remove(calId, e.id); });
    return;
  }
  var start = dayStart + BRIEF_EVENT_MIN * 60000;
  var ev = {
    summary: '☀ Today: ' + b.oneLine,
    description: b.title + '\n\n' + b.text,
    start: { dateTime: Util.isoInTz(start, cfg.defaultTz), timeZone: cfg.defaultTz },
    end: { dateTime: Util.isoInTz(start + 5 * 60000, cfg.defaultTz), timeZone: cfg.defaultTz },
    transparency: 'transparent',
    extendedProperties: { 'private': { fm_brief: key.split('=')[1] } }
  };
  if (existing.length) Calendar.Events.update(ev, calId, existing[0].id);
  else Calendar.Events.insert(ev, calId);
}

function requireOwner_() {
  if (Self.email() !== CONFIG.calendarOwner.toLowerCase()) {
    throw new Error('The morning brief runs from ' + CONFIG.calendarOwner + ' only, so each founder gets it once.');
  }
}
