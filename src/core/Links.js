// Video-call link detection. The conference key (e.g. "zoom:81234567890") is a dedupe signal,
// but only together with a matching start time: personal Zoom rooms get reused across meetings.

var Links = (function () {
  var PATTERNS = [
    { re: /https?:\/\/[\w.-]*zoom\.us\/(?:j|my|w)\/([\w.-]+)[^\s<>"')\]]*/i, key: 'zoom' },
    { re: /https?:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})[^\s<>"')\]]*/i, key: 'meet' },
    { re: /https?:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join\/|meet\/)([^\s<>"')\]\/?]+)[^\s<>"')\]]*/i, key: 'teams' },
    { re: /https?:\/\/[\w.-]*webex\.com\/[^\s<>"')\]]*?(?:MTID=|\/j\.php\?MTID=|\/meet\/)([\w.-]+)[^\s<>"')\]]*/i, key: 'webex' },
    { re: /https?:\/\/(?:[\w-]+\.)?whereby\.com\/([\w-]+)[^\s<>"')\]]*/i, key: 'whereby' }
  ];

  function find(text) {
    text = String(text || '');
    for (var i = 0; i < PATTERNS.length; i++) {
      var m = text.match(PATTERNS[i].re);
      if (m) return { url: m[0].replace(/[.,;]+$/, ''), key: PATTERNS[i].key + ':' + decodeSafe(m[1]).toLowerCase() };
    }
    return null;
  }

  function decodeSafe(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function keyFor(url) {
    var f = find(url);
    return f ? f.key : null;
  }

  return { find: find, keyFor: keyFor };
})();
