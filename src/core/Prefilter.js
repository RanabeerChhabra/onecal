// Cheap, local filter that decides whether a thread is worth sending to the LLM.
// It should be generous: the model rejects vague proposals; this only drops obvious noise.

var Prefilter = (function () {
  var KEYWORDS = /\b(meet|meets|meeting|meetings|call|calls|catch[- ]?up|sync|chat|interview|demo|discussion|zoom|google meet|teams|webex|calendly|cal\.com|invite|invitation|invited|resched\w*|postpon\w*|moved? to|push(?:ed)? to|cancel\w*|confirm\w*|see you|slot|booked|scheduled?|appointment|coffee|lunch|dinner|pitch|session|can'?t make it|cannot make it|won'?t be able)\b/i;
  var TIME = /\b(\d{1,2}(:\d{2})?\s?(am|pm|a\.m\.|p\.m\.)|\d{1,2}[:.]\d{2}\s?(hrs|h|ist|gmt|utc|pst|est)?|noon|midnight)\b/i;
  var DATE = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day)?\b|\b(today|tomorrow|tonight|next week)\b|\b\d{1,2}(st|nd|rd|th)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\b\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?\b/i;
  var SCHEDULERS = /(calendly\.com|cal\.com|zoom\.us|calendar-notification@google\.com|teams\.microsoft|savvycal|hubspot|zcal|tidycal|doodle|acuityscheduling|youcanbook\.me|outlook\.com.*calendar)/i;
  var NOISE_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'SPAM', 'TRASH'];

  // msg: { from, subject, body, labels[], listUnsubscribe, precedence, icsTexts[] }
  function checkMessage(msg) {
    if (msg.icsTexts && msg.icsTexts.length) return { candidate: true, reason: 'calendar invite attached' };
    var labels = msg.labels || [];
    for (var i = 0; i < NOISE_LABELS.length; i++) {
      if (labels.indexOf(NOISE_LABELS[i]) >= 0) return { candidate: false, reason: 'label ' + NOISE_LABELS[i] };
    }
    if (SCHEDULERS.test(msg.from || '')) return { candidate: true, reason: 'scheduling service sender' };
    if (msg.listUnsubscribe || /^(bulk|list|junk)$/i.test(msg.precedence || '')) {
      return { candidate: false, reason: 'bulk/newsletter mail' };
    }
    var text = (msg.subject || '') + '\n' + String(msg.body || '').slice(0, 6000);
    if (!KEYWORDS.test(text)) return { candidate: false, reason: 'no meeting words' };
    if (!TIME.test(text) && !DATE.test(text)) return { candidate: false, reason: 'no date or time mentioned' };
    return { candidate: true, reason: 'meeting words + date/time' };
  }

  // A thread is a candidate if any of its recent messages is.
  function checkThread(thread) {
    var msgs = (thread.messages || []).slice(-6);
    var last = { candidate: false, reason: 'empty thread' };
    for (var i = msgs.length - 1; i >= 0; i--) {
      var r = checkMessage(msgs[i]);
      if (r.candidate) return r;
      if (i === msgs.length - 1) last = r;
    }
    return last;
  }

  return { checkMessage: checkMessage, checkThread: checkThread };
})();
