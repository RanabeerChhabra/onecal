// Claude API over UrlFetchApp. Apps Script can't load npm packages, so this uses the REST API directly.

var Claude = (function () {
  var BASE = 'https://api.anthropic.com/v1/';

  function opts(key, method, payload) {
    var o = { method: method || 'get', muteHttpExceptions: true,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } };
    if (payload) { o.contentType = 'application/json'; o.payload = JSON.stringify(payload); }
    return o;
  }

  function parse(resp) {
    try { return JSON.parse(resp.getContentText()); } catch (e) { return { type: 'error', error: { type: 'bad_response', code: resp.getResponseCode() } }; }
  }

  function retryable(resp) {
    var c = resp.getResponseCode();
    return c === 429 || c === 529 || c >= 500;
  }

  // Several Messages API calls in parallel (5 at a time). Returns parsed responses in order.
  function many(bodies, key) {
    var out = [];
    for (var i = 0; i < bodies.length; i += 5) {
      var chunk = bodies.slice(i, i + 5);
      var resps = UrlFetchApp.fetchAll(chunk.map(function (b) {
        var o = opts(key, 'post', b); o.url = BASE + 'messages'; return o;
      }));
      resps.forEach(function (resp, j) {
        if (retryable(resp)) {
          Utilities.sleep(4000);
          resp = UrlFetchApp.fetch(BASE + 'messages', opts(key, 'post', chunk[j]));
        }
        out.push(parse(resp));
      });
    }
    return out;
  }

  // Message Batches API: half price, results within 24h (usually minutes). Used for the backfill.
  function createBatch(requests, key) {
    var r = parse(UrlFetchApp.fetch(BASE + 'messages/batches', opts(key, 'post', { requests: requests })));
    if (!r.id) throw new Error('Batch create failed: ' + JSON.stringify(r).slice(0, 300));
    return r;
  }

  function getBatch(id, key) {
    return parse(UrlFetchApp.fetch(BASE + 'messages/batches/' + id, opts(key)));
  }

  function batchResults(url, key) {
    var text = UrlFetchApp.fetch(url, opts(key)).getContentText();
    return text.split('\n').filter(function (l) { return l.trim(); }).map(function (l) { return JSON.parse(l); });
  }

  return { many: many, createBatch: createBatch, getBatch: getBatch, batchResults: batchResults };
})();
