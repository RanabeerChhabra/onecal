// The sync loop. syncAll() runs from a time trigger every 10 minutes (a full sync every 2 hours); dryRun() is the manual preview.

var BUDGET_MS = 4.5 * 60 * 1000;     // Apps Script stops a run at 6 minutes.
var MAX_THREADS_PER_ACCOUNT = 60;    // per run; the rest waits in the account's retry list

// e is set when the time trigger runs it; a manual Run from the editor always does a full sync.
function syncAll(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { console.log('Previous sync still running; skipping this one.'); return; }
  try {
    if (e && e.triggerUid && !syncDue_()) return;
    runSync_({ dry: false });
    refreshTodayItem_();
  } finally { lock.releaseLock(); }
}

// The trigger fires every 10 minutes, but a full sync only runs every SYNC_EVERY_MIN (2 hours by default).
// While the first-run backfill is still going, every trigger counts, so it finishes in hours, not days.
function syncDue_() {
  var a = Self.account();
  var backfilling = (a.backfill && a.backfill.phase === 'list') || Backfill.status().pendingBatches > 0;
  if (backfilling || !a.lastSync) return true;
  return Date.now() - a.lastSync >= (getConfig_().syncEveryMin - 5) * 60000;
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
