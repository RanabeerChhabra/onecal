// DeepSeek chat completions over UrlFetchApp (used when PROVIDER is deepseek). Same job as Claude.many.
// DeepSeek has no batch API, so the backfill calls this directly instead of submitting a batch.

var DeepSeek = (function () {
  var URL = 'https://api.deepseek.com/chat/completions';

  function opts(key, payload) {
    return { url: URL, method: 'post', muteHttpExceptions: true, contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + key }, payload: JSON.stringify(payload) };
  }

  function parse(resp) {
    try { return JSON.parse(resp.getContentText()); } catch (e) { return { error: { type: 'bad_response', code: resp.getResponseCode() } }; }
  }

  function retryable(resp) {
    var c = resp.getResponseCode();
    return c === 429 || c >= 500;
  }

  // JSON mode sometimes returns an empty reply; one more try usually fixes it.
  function empty(r) {
    return r.choices && !(r.choices[0] && r.choices[0].message && String(r.choices[0].message.content || '').trim());
  }

  function many(bodies, key) {
    var out = [];
    for (var i = 0; i < bodies.length; i += 5) {
      var chunk = bodies.slice(i, i + 5);
      var resps = UrlFetchApp.fetchAll(chunk.map(function (b) { return opts(key, b); }));
      resps.forEach(function (resp, j) {
        if (retryable(resp)) {
          Utilities.sleep(4000);
          resp = UrlFetchApp.fetch(URL, opts(key, chunk[j]));
        }
        var r = parse(resp);
        if (empty(r)) r = parse(UrlFetchApp.fetch(URL, opts(key, chunk[j])));
        out.push(r);
      });
    }
    return out;
  }

  return { many: many };
})();
