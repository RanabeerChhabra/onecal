// First-run backfill of the last BACKFILL_MONTHS of mail, spread over many sync runs.
// With Claude, candidate threads go to the Message Batches API (half price) and results are collected
// on later runs. DeepSeek has no batch API, so its threads are extracted right away, in smaller pages.
// Only meetings that are still in the future are kept.

var Backfill = (function () {
  var PAGE = 50;
  var MIN_LEFT_MS = 75 * 1000; // stop starting new pages when less than this is left

  function pending() { return JSON.parse(props_().getProperty('BATCHES') || '[]'); }
  function savePending(list) { props_().setProperty('BATCHES', JSON.stringify(list)); }

  // custom_id carries what we need to rebuild context: "<aid>_<threadId>_<asOf base36>"
  function customId(acct, threadId, asOf) { return acct.aid + '_' + threadId + '_' + asOf.toString(36); }
  function parseId(id) {
    var p = id.split('_');
    return { aid: p[0], threadId: p[1], asOf: parseInt(p[2], 36) };
  }

  function collect(accounts, cfg, now, updates, t0, budget) {
    var key = cfg.raw.ANTHROPIC_API_KEY;
    if (!key) return; // batches only exist with Claude
    var byAid = {};
    accounts.forEach(function (a) { byAid[a.aid] = a; });
    var still = [];
    pending().forEach(function (b) {
      if (Date.now() - t0 > budget - MIN_LEFT_MS) { still.push(b); return; }
      var st = Claude.getBatch(b.id, key);
      if (st.type === 'error') { AgentLog.add({ action: 'error', reason: 'batch ' + b.id + ': ' + JSON.stringify(st.error) }); still.push(b); return; }
      if (st.processing_status !== 'ended') { still.push(b); return; }
      var n = 0;
      Claude.batchResults(st.results_url, key).forEach(function (line) {
        var id = parseId(line.custom_id);
        var acct = byAid[id.aid];
        if (!acct) return; // account removed since
        var link = Sources.gmailLink(acct.email, id.threadId);
        if (!line.result || line.result.type !== 'succeeded') {
          AgentLog.add({ action: 'error', who: acct.founder, reason: 'backfill extraction ' + (line.result ? line.result.type : 'missing'), link: link });
          return;
        }
        var r = Extract.toObservations(line.result.message, { acct: acct, threadId: id.threadId, asOf: id.asOf, knownIds: [] }, cfg, now);
        r.skipped.forEach(function (s) {
          if (!/past/.test(s.reason)) AgentLog.add({ action: 'skip', who: acct.founder, title: s.title, confidence: s.confidence, reason: s.reason, link: link });
        });
        if (r.error) return;
        updates.push({ scope: Sources.threadScope(acct, id.threadId), kind: 'email', asOf: id.asOf, obs: r.obs, keepIds: r.keepIds });
        n++;
      });
      AgentLog.add({ action: 'note', reason: 'backfill batch ' + b.id + ' done: ' + n + ' threads' });
    });
    savePending(still);
  }

  // DeepSeek path: extract the page's candidates now instead of batching them.
  // Returns false if the API itself failed (no credit, bad key, outage): the page is then redone next run.
  function extractNow(requests, acct, cfg, now, updates) {
    var resps = askModel_(requests.map(function (r) { return r.params; }), cfg);
    var apiError = null;
    resps.forEach(function (r) { if (!apiError && r && r.error) apiError = r.error; });
    if (apiError) {
      AgentLog.add({ action: 'error', who: acct.founder, reason: 'backfill paused, DeepSeek API error (will retry): ' + JSON.stringify(apiError).slice(0, 200) });
      return false;
    }
    requests.forEach(function (req, i) {
      var id = parseId(req.custom_id);
      var link = Sources.gmailLink(acct.email, id.threadId);
      var r = Extract.toObservations(resps[i], { acct: acct, threadId: id.threadId, asOf: id.asOf, knownIds: [] }, cfg, now);
      if (r.error) return AgentLog.add({ action: 'error', who: acct.founder, reason: 'backfill extraction: ' + r.error, link: link });
      r.skipped.forEach(function (s) {
        if (!/past/.test(s.reason)) AgentLog.add({ action: 'skip', who: acct.founder, title: s.title, confidence: s.confidence, reason: s.reason, link: link });
      });
      updates.push({ scope: Sources.threadScope(acct, id.threadId), kind: 'email', asOf: id.asOf, obs: r.obs, keepIds: r.keepIds });
    });
    return true;
  }

  function advance(acct, cfg, now, updates, patches, t0, budget) {
    var bf = JSON.parse(JSON.stringify(acct.backfill));
    var direct = cfg.provider === 'deepseek';
    var token = Self.token();
    var q = 'after:' + bf.afterSec + ' ' + GmailApi.SEARCH;
    while (bf.phase === 'list' && Date.now() - t0 < budget - MIN_LEFT_MS) {
      var page = GmailApi.listThreads(token, q, bf.pageToken, direct ? PAGE / 2 : PAGE);
      var requests = [];
      GmailApi.getThreads(token, page.ids).forEach(function (th) {
        if (!th.messages.length || !Prefilter.checkThread(th).candidate) return;
        var asOf = th.messages[th.messages.length - 1].date;
        if (th.messages.some(function (m) { return m.icsTexts.length; })) {
          var r = Sources.fromThreadIcs(th, acct, cfg);
          var future = r.obs.filter(function (o) { return o.end > now; });
          if (r.obs.length || r.skipped.length) {
            if (future.length) updates.push({ scope: Sources.threadScope(acct, th.id), kind: 'email', asOf: asOf, obs: future });
            return;
          }
        }
        requests.push({ custom_id: customId(acct, th.id, asOf), params: Extract.buildRequest(th, acct, [], cfg, now) });
      });
      if (requests.length && direct) {
        if (!extractNow(requests, acct, cfg, now, updates)) break;
      } else if (requests.length) {
        var batch = Claude.createBatch(requests, cfg.raw.ANTHROPIC_API_KEY);
        var list = pending();
        list.push({ id: batch.id, aid: acct.aid, n: requests.length, at: now });
        savePending(list); // saved right away so results are never orphaned
      }
      bf.threads += page.ids.length;
      bf.pageToken = page.nextPageToken;
      if (!bf.pageToken) {
        bf.phase = 'done';
        AgentLog.add({ action: 'note', who: acct.founder, reason: 'backfill listing finished for ' + acct.email + ' (' + bf.threads + ' threads scanned)' });
      }
    }
    var prev = patches[acct.email];
    patches[acct.email] = function (a) { if (prev) prev(a); a.backfill = bf; };
  }

  function step(accounts, cfg, now, updates, patches, t0, budget) {
    try { collect(accounts, cfg, now, updates, t0, budget); }
    catch (e) { AgentLog.add({ action: 'error', reason: 'collecting backfill results: ' + e.message }); }
    accounts.filter(function (a) { return a.status === 'ok' && a.backfill && a.backfill.phase === 'list'; }).forEach(function (acct) {
      if (Date.now() - t0 > budget - MIN_LEFT_MS) return;
      try { advance(acct, cfg, now, updates, patches, t0, budget); }
      catch (e) { AgentLog.add({ action: 'error', who: acct.founder, reason: 'backfill for ' + acct.email + ': ' + e.message }); }
    });
  }

  function status() {
    return { pendingBatches: pending().length };
  }

  return { step: step, status: status, customId: customId, parseId: parseId };
})();
