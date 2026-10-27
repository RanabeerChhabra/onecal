// 7am morning brief, sent from the calendar owner's copy only (so each founder gets it once):
// an email to each founder's phone account and a push notification through the free ntfy app.
//
//   enableMorningBrief()   run once in the owner's account; prints each founder's ntfy topic
//   sendMorningBrief()     what the 7am trigger runs; run it by hand to test
//   disableMorningBrief()

function enableMorningBrief() {
  requireOwner_();
  disableMorningBrief();
  var cfg = getConfig_();
  ScriptApp.newTrigger('sendMorningBrief').timeBased().atHour(7).nearMinute(0).everyDays(1).inTimezone(cfg.defaultTz).create();
  var topics = ntfyTopics_();
  console.log(['Morning brief on: every day around 7:00 (' + cfg.defaultTz + ').', '',
    'Push notifications: install the free "ntfy" app, tap +, and subscribe to your topic:']
    .concat(CONFIG.founders.map(function (f) { return '  ' + f.name + ': ' + topics[f.tag]; }))
    .concat(['', 'Keep these private: anyone with a topic name can read that brief.', 'Run sendMorningBrief to test it now.']).join('\n'));
}

function disableMorningBrief() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendMorningBrief') ScriptApp.deleteTrigger(t);
  });
}

function sendMorningBrief() {
  requireOwner_();
  var cfg = getConfig_();
  var now = Date.now();
  var day = Brief.dayBounds(now, cfg.defaultTz);
  var events = Calendar.Events.list(props_().getProperty('SHARED_CALENDAR_ID'), {
    timeMin: new Date(day.start).toISOString(), timeMax: new Date(day.end).toISOString(),
    singleEvents: true, orderBy: 'startTime', privateExtendedProperty: 'fm=1', maxResults: 250
  }).items || [];
  var topics = ntfyTopics_();
  var b = Brief.build(events, null, cfg.defaultTz, now); // everyone sees the whole team's day
  CONFIG.founders.forEach(function (f) {
    try {
      if (b.count) MailApp.sendEmail({ to: f.emails[0], subject: b.title, body: b.text, htmlBody: b.html, name: 'Founders Meeting Agent' });
    } catch (e) { console.warn('Brief email to ' + f.name + ' failed: ' + e.message); }
    try {
      UrlFetchApp.fetch('https://ntfy.sh/', { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({ topic: topics[f.tag], title: b.title, message: b.text, tags: ['calendar'],
          click: 'https://calendar.google.com/calendar/r/day' }) });
    } catch (e) { console.warn('Brief push to ' + f.name + ' failed: ' + e.message); }
  });
  console.log('Brief sent to ' + CONFIG.founders.map(function (f) { return f.name; }).join(', ') + ': ' + b.title);
}

function requireOwner_() {
  if (Self.email() !== CONFIG.calendarOwner.toLowerCase()) {
    throw new Error('The morning brief runs from ' + CONFIG.calendarOwner + ' only, so each founder gets it once.');
  }
}

// One unguessable topic per founder, created once and kept in Script properties.
function ntfyTopics_() {
  var p = props_();
  var topics = JSON.parse(p.getProperty('NTFY_TOPICS') || '{}');
  var changed = false;
  CONFIG.founders.forEach(function (f) {
    if (!topics[f.tag]) {
      topics[f.tag] = 'founders-' + f.name.toLowerCase() + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
      changed = true;
    }
  });
  if (changed) p.setProperty('NTFY_TOPICS', JSON.stringify(topics));
  return topics;
}
