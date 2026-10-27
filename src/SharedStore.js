// The shared "Founders — All Meetings" calendar. Every account's copy of the script reads and writes it,
// so all shared state lives here (Advanced Calendar service):
//   - live meetings: real events carrying their observations in private extended properties (fm=1)
//   - cancelled meetings: hidden "memory" events dated 1 Jan 2000 (fm_tomb=1), so that no copy re-adds
//     a meeting another copy saw get cancelled.

var SharedStore = (function () {
  var TOMB_DAY = '2000-01-01';

  function calId() {
    var id = props_().getProperty('SHARED_CALENDAR_ID');
    if (!id) throw new Error('SHARED_CALENDAR_ID not set. Run setup() first.');
    return id;
  }

  function listAll(opts) {
    var out = [], pageToken = null;
    do {
      var r = Calendar.Events.list(calId(), Object.assign({ singleEvents: true, maxResults: 2500, pageToken: pageToken }, opts));
      out = out.concat(r.items || []);
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  function load(now) {
    var meetings = [];
    listAll({ timeMin: new Date(now - 86400000).toISOString(), privateExtendedProperty: 'fm=1' }).forEach(function (ev) {
      var m = Render.meetingFromEvent(ev);
      if (m) meetings.push(m);
    });
    listAll({ timeMax: '2000-01-03T00:00:00Z', privateExtendedProperty: 'fm_tomb=1' }).forEach(function (ev) {
      var m = Render.meetingFromEvent(ev);
      if (!m) return;
      m.tomb = true;
      m.tombEventId = m.eventId;
      m.eventId = null;
      meetings.push(m);
    });
    return meetings;
  }

  function tombEvent(m, fp) {
    var priv = { fm_tomb: '1', fm_id: m.id, fm_fp: fp };
    var obs = m.obs.slice(-30);
    obs.forEach(function (o, i) { priv['o' + i] = Render.compactObs(o); });
    var end = Math.max.apply(null, obs.map(function (o) { return o.end || 0; }));
    priv.fm_end = String(end);
    var last = obs[obs.length - 1] || {};
    return {
      summary: '(agent memory) cancelled: ' + Util.truncate(last.title || m.id, 80),
      description: 'Remembers a cancelled meeting so it is not added again. Safe to ignore; removed automatically.',
      start: { date: TOMB_DAY }, end: { date: '2000-01-02' },
      transparency: 'transparent', visibility: 'private',
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: { 'private': priv }
    };
  }

  function saveTomb(m, fp) {
    var ev = tombEvent(m, fp);
    if (m.tombEventId) Calendar.Events.update(ev, calId(), m.tombEventId);
    else m.tombEventId = Calendar.Events.insert(ev, calId()).id;
  }

  function removeQuietly(id, eventId) {
    try { Calendar.Events.remove(id, eventId); } catch (e) { if (!/not found|deleted|410|404/i.test(String(e))) throw e; }
  }

  // Another account's copy may have created the same meeting moments ago.
  function existsAlready(id, meetingId) {
    var r = Calendar.Events.list(id, { privateExtendedProperty: 'fm_id=' + meetingId, maxResults: 5, singleEvents: true });
    return (r.items || []).some(function (ev) { return ev.status !== 'cancelled' && ev.extendedProperties && ev.extendedProperties['private'].fm === '1'; });
  }

  // Applies ops; one failing op is logged and does not stop the others.
  function apply(ops) {
    var id = calId(), done = 0;
    ops.forEach(function (op) {
      var m = op.meeting;
      try {
        if (op.type === 'create') {
          if (existsAlready(id, m.id)) {
            AgentLog.add({ action: 'note', title: op.event.summary, reason: 'already created by another account; merged next run', meetingId: m.id });
            return;
          }
          m.eventId = Calendar.Events.insert(op.event, id).id;
          if (m.tombEventId) { removeQuietly(id, m.tombEventId); m.tombEventId = null; }
        } else if (op.type === 'update') {
          Calendar.Events.update(op.event, id, m.eventId);
        } else if (op.type === 'delete') {
          removeQuietly(id, m.eventId);
          if (op.tomb) saveTomb(m, op.tombFp);
        } else if (op.type === 'tomb') {
          saveTomb(m, op.tombFp);
        } else if (op.type === 'droptomb') {
          if (m.tombEventId) removeQuietly(id, m.tombEventId);
        }
        done++;
      } catch (e) {
        AgentLog.add({ action: 'error', title: m.id, reason: op.type + ' failed: ' + e, meetingId: m.id });
      }
    });
    return done;
  }

  function pruneTombs(now) {
    listAll({ timeMax: '2000-01-03T00:00:00Z', privateExtendedProperty: 'fm_tomb=1' }).forEach(function (ev) {
      var end = Number(ev.extendedProperties['private'].fm_end || 0);
      if (end < now - 86400000) removeQuietly(calId(), ev.id);
    });
  }

  return { calId: calId, load: load, apply: apply, pruneTombs: pruneTombs };
})();
