// Google REST calls made with a connected account's OAuth token (not the bot's own identity).

var GoogleApi = (function () {
  function query(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      (Array.isArray(v) ? v : [v]).forEach(function (x) { parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(x)); });
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  function request(token, url) {
    return { url: url, headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
  }

  function parse(resp) {
    var code = resp.getResponseCode();
    var text = resp.getContentText();
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { code: code, json: json, text: text };
  }

  function retryable(code) { return code === 429 || code >= 500; }

  function get(token, url, params) {
    var full = url + query(params);
    for (var attempt = 0; ; attempt++) {
      var r = parse(UrlFetchApp.fetch(full, request(token, full)));
      if (r.code >= 200 && r.code < 300) return r.json;
      if (retryable(r.code) && attempt < 3) { Utilities.sleep(1000 * Math.pow(2, attempt)); continue; }
      var err = new Error('Google API ' + r.code + ' for ' + url.replace(/\?.*/, '') + ': ' + String(r.text).slice(0, 300));
      err.code = r.code;
      throw err;
    }
  }

  // Parallel GETs in small chunks (Gmail allows ~250 quota units/s per user). Returns json per url (or null).
  function getAll(token, urls, chunk) {
    chunk = chunk || 10;
    var out = [];
    for (var i = 0; i < urls.length; i += chunk) {
      var slice = urls.slice(i, i + chunk);
      var resps = UrlFetchApp.fetchAll(slice.map(function (u) { return request(token, u); }));
      resps.forEach(function (resp, j) {
        var r = parse(resp);
        if (r.code >= 200 && r.code < 300) { out.push(r.json); return; }
        if (retryable(r.code)) {
          Utilities.sleep(1500);
          try { out.push(get(token, slice[j])); return; } catch (e) { /* fall through */ }
        }
        console.warn('GET failed ' + r.code + ' ' + slice[j]);
        out.push(null);
      });
    }
    return out;
  }

  return { query: query, get: get, getAll: getAll };
})();
