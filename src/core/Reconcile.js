// Dedupe + reschedule/cancel engine.
//
// A meeting is a cluster of observations from different sources. Each sync produces "updates", each of
// which says "the current observations for scope S are X" (S = one account's calendar, or one email
// thread). We swap the old observations of S for X, attach each new one to the meeting it matches,
// then work out what the shared calendar should show for every meeting that changed.
//
// meeting: { id, eventId|null, obs[], fp|null, tomb: bool }   (tomb = cancelled, remembered so it is not re-added)
// update:  { scope, prefix?: bool, kind: 'calendar'|'email'|'removal', asOf, obs[], keepIds?[] }
//
// Several copies of the agent (one per Google account) write to the same shared calendar, so two of
// them can create the same meeting in the same minute. compact() heals that on the next run: any two
// meetings that match are merged into the one with the lower id, so every copy converges.

var Reconcile = (function () {
  var WINDOW_MS = 15 * 60 * 1000;

  function run(meetings, updates, cfg, now) {
    var touched = {}, notes = [];
    var byId = {};
    meetings.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    meetings.forEach(function (m) { byId[m.id] = m; });
    compact(meetings, cfg, now).forEach(function (m) { touched[m.id] = m; });

    updates.slice().sort(function (a, b) { return a.asOf - b.asOf; }).forEach(function (u) {
      var inScope = function (o) { return u.prefix ? o.src.indexOf(u.scope) === 0 : o.src === u.scope; };

      // An older snapshot of a thread (e.g. a late backfill batch) must not overwrite a newer one.
      if (u.kind === 'email') {
        var stale = meetings.some(function (m) {
          return m.obs.some(function (o) { return inScope(o) && o.asOf > u.asOf; });
        });
        if (stale) { notes.push({ action: 'skip', reason: 'stale snapshot of ' + u.scope }); return; }
      }

      var prior = [], removed = {};
      meetings.forEach(function (m) {
        if (u.keepIds && u.keepIds.indexOf(m.id) >= 0) return;
        var kept = m.obs.filter(function (o) {
          if (!inScope(o)) return true;
          // Calendar snapshots only cover the future; keep finished meetings as history.
          return u.kind === 'calendar' && o.end <= now;
        });
        if (kept.length !== m.obs.length) {
          removed[m.id] = m.obs.filter(function (o) { return kept.indexOf(o) < 0; });
          m.obs = kept; touched[m.id] = m; prior.push(m);
        }
      });

      (u.obs || []).forEach(function (o) {
        var m = match(o, meetings, byId, prior, removed, u, cfg);
        if (!m) {
          m = { id: newId(o, byId), eventId: null, obs: [], fp: null, tomb: false };
          meetings.push(m);
          byId[m.id] = m;
        }
        o.knownId = null; // a matching hint only; storing it would change the fingerprint on every re-read
        m.obs.push(o);
        touched[m.id] = m;
      });
    });

    var ops = [];
    Object.keys(touched).forEach(function (id) {
      var op = decide(touched[id], cfg, now);
      if (op) ops.push(op);
    });
    return { ops: ops, notes: notes };
  }

  function newId(o, byId) {
    var base = 'm' + Util.hash(o.ical || (o.src + '|' + o.start + '|' + o.title)).slice(0, 10);
    var id = base, n = 1;
    while (byId[id]) id = base + '-' + (n++);
    return id;
  }

  function external(emails, cfg) {
    return (emails || []).filter(function (e) { return e && !cfg.founderOf[e]; });
  }

  // `removed` holds the observations this same update just took away, so a moved calendar event
  // (same iCalUID, new time) finds its old meeting.
  function match(o, meetings, byId, prior, removed, u, cfg) {
    if (o.knownId && byId[o.knownId]) return byId[o.knownId];
    if (o.ical) {
      var sameIcal = function (p) { return p.ical === o.ical; };
      for (var i = 0; i < meetings.length; i++) {
        if (meetings[i].obs.some(sameIcal) || (removed[meetings[i].id] || []).some(sameIcal)) return meetings[i];
      }
    }
    // Re-extracted thread with a single meeting: same meeting as before, even if the time moved.
    if (o.kind === 'email' && prior.length === 1 && u.obs.length === 1) return prior[0];

    var best = null, bestScore = 0;
    meetings.forEach(function (m) {
      var sc = score(o, m, cfg);
      if (sc > bestScore) { bestScore = sc; best = m; }
    });
    return best;
  }

  // How well observation `o` fits meeting `m` (0 = not the same meeting).
  function score(o, m, cfg) {
    if (!m.obs.length) return 0;
    // Two different calendar events in the same account are different meetings.
    if (o.ical && m.obs.some(function (p) { return p.ical && p.ical !== o.ical && p.acct === o.acct; })) return 0;
    var oExt = external(o.attendees, cfg);
    var best = 0;
    m.obs.forEach(function (p) {
      if (o.ical && p.ical === o.ical) { best = Math.max(best, 5); return; }
      if (Math.abs(p.start - o.start) > WINDOW_MS) return;
      var sc = 0;
      if (o.confKey && o.confKey === p.confKey) sc = 3;
      var pExt = external(p.attendees, cfg);
      if (oExt.some(function (e) { return pExt.indexOf(e) >= 0; })) sc = Math.max(sc, 2);
      var sim = Util.titleSim(o.title, p.title);
      if (sim >= 0.5) sc = Math.max(sc, 1 + sim);
      best = Math.max(best, sc);
    });
    return best;
  }

  // Merges duplicate meetings (same meeting stored twice) into the lower id. Returns touched meetings.
  function compact(meetings, cfg, now) {
    var touched = [];
    var live = function (m) { return m.obs.length && m.obs.some(function (o) { return o.end > now; }); };
    for (var i = 0; i < meetings.length; i++) {
      var a = meetings[i];
      if (!live(a)) continue;
      for (var j = i + 1; j < meetings.length; j++) {
        var b = meetings[j];
        if (!live(b)) continue;
        var same = b.obs.some(function (o) { return score(o, a, cfg) > 0; });
        if (!same) continue;
        a.obs = a.obs.concat(b.obs);
        b.obs = [];
        touched.push(a, b);
      }
    }
    return touched;
  }

  // What the meeting should look like right now.
  function merge(m, cfg, now) {
    var obs = Render.sortObs(m.obs); // canonical order first, so ties break the same way in every account
    if (!obs.length) return { empty: true };
    var active = obs.filter(function (o) { return o.status !== 'declined'; });
    if (!active.length) return { hidden: true, reason: 'declined by everyone' };

    var rank = function (o) { return o.kind === 'email' ? 0 : 1; };
    active.sort(function (a, b) { return (b.asOf - a.asOf) || (rank(b) - rank(a)); });
    var latest = active[0];
    if (latest.status === 'cancelled') return { cancelled: true, by: latest };

    var live = active.filter(function (o) { return o.status !== 'cancelled'; });
    var timeSrc = live[0];
    var cal = live.filter(function (o) { return o.kind !== 'email'; })[0] || null;
    var pick = function (field) {
      var order = [cal, timeSrc].concat(live);
      for (var i = 0; i < order.length; i++) if (order[i] && order[i][field]) return order[i][field];
      return null;
    };

    // A tag may be a team ("R+H+A") for shared inboxes like founders@; split it into founders.
    var tags = function (t) { return String(t || '').split('+').filter(Boolean); };
    var declined = [], liveOwners = [], founders = [];
    obs.forEach(function (o) { if (o.status === 'declined') declined = declined.concat(tags(o.founder)); });
    live.forEach(function (o) {
      liveOwners = liveOwners.concat(tags(o.founder));
      founders = founders.concat(tags(o.founder));
      (o.attendees || []).forEach(function (e) { if (cfg.founderOf[e]) founders = founders.concat(tags(cfg.founderOf[e])); });
    });
    var order = cfg.founders.map(function (f) { return f.tag; });
    founders = Util.uniq(founders).filter(function (f) { return declined.indexOf(f) < 0 || liveOwners.indexOf(f) >= 0; })
      .sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    if (!founders.length) return { hidden: true, reason: 'no attending founder' };

    var confidence = Math.max.apply(null, live.map(function (o) { return o.confidence; }));
    var withNames = Util.uniq([].concat.apply([], live.map(function (o) { return o.with || []; })))
      .filter(function (w) { return !cfg.founderOf[String(w).toLowerCase()]; });

    return {
      title: (cal || timeSrc).title,
      start: timeSrc.start, end: timeSrc.end, tz: timeSrc.tz || cfg.defaultTz,
      location: pick('location'), joinUrl: pick('joinUrl'),
      founders: founders,
      tentative: !cal && confidence < cfg.addThreshold,
      confidence: confidence,
      with: withNames.slice(0, 8),
      sources: obs,
      timeSource: timeSrc,
      past: timeSrc.end <= now
    };
  }

  function decide(m, cfg, now) {
    var s = merge(m, cfg, now);
    if (s.empty) {
      if (m.eventId) return { type: 'delete', meeting: m, reason: 'all sources gone (deleted or account removed)' };
      if (m.tomb) return { type: 'droptomb', meeting: m };
      return null;
    }
    if (s.cancelled) {
      var tombFp = Util.hash(JSON.stringify(Render.sortObs(m.obs)));
      if (m.eventId) return { type: 'delete', meeting: m, tomb: true, tombFp: tombFp, by: s.by, reason: 'cancelled: ' + describe(s.by) };
      if (m.tomb && m.fp === tombFp) return null;
      return { type: 'tomb', meeting: m, tombFp: tombFp, by: s.by, reason: 'cancelled: ' + describe(s.by) };
    }
    if (s.hidden) {
      if (m.eventId) return { type: 'delete', meeting: m, reason: s.reason };
      return null;
    }
    if (s.past) return null;
    var event = Render.event(m, s, cfg);
    var fp = event.extendedProperties.private.fm_fp;
    if (!m.eventId) {
      return { type: 'create', meeting: m, event: event, state: s, reason: (m.tomb ? 're-booked after cancellation: ' : '') + describe(s.timeSource) };
    }
    if (fp !== m.fp) return { type: 'update', meeting: m, event: event, state: s, reason: describe(s.timeSource) };
    return null;
  }

  function describe(o) {
    if (!o) return '';
    var what = o.kind === 'calendar' ? 'calendar of ' + o.acct : (o.kind === 'ics' ? 'invite in ' : 'email in ') + o.acct;
    return what + (o.kind === 'email' ? ' (confidence ' + o.confidence.toFixed(2) + '): ' + o.evidence : '');
  }

  return { run: run, merge: merge, match: match, compact: compact, decide: decide, WINDOW_MS: WINDOW_MS };
})();
