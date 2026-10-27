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
