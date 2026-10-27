// Read-only Gmail access for one connected account (Gmail REST API, gmail.readonly scope).

var GmailApi = (function () {
  var BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';
  // Server-side search used for backfill and dry runs: cheap first cut before the local prefilter.
  var SEARCH = '{meeting meet call zoom calendly "cal.com" invite invitation "google meet" teams webex ' +
    'reschedule rescheduled postponed cancelled canceled confirmed "see you" interview demo "catch up" sync ' +
    'slot booked scheduled appointment filename:ics} -category:promotions -category:social -category:forums -in:chats';
  var MEETING_LINK = /zoom\.us|meet\.google|teams\.(microsoft|live)|webex|calendly|cal\.com|whereby/i;

  function profile(token) {
    return GoogleApi.get(token, BASE + 'profile');
  }

  // Thread ids touched since `startHistoryId`. { expired: true } when Gmail no longer has that history.
  function history(token, startHistoryId) {
    var ids = {}, pageToken = null, latest = startHistoryId;
    do {
      var r;
      try {
        r = GoogleApi.get(token, BASE + 'history', { startHistoryId: startHistoryId, historyTypes: 'messageAdded', maxResults: 500, pageToken: pageToken });
      } catch (e) {
        if (e.code === 404) return { expired: true };
        throw e;
      }
      (r.history || []).forEach(function (h) {
        (h.messagesAdded || []).forEach(function (ma) {
          var labels = ma.message.labelIds || [];
          if (labels.indexOf('DRAFT') >= 0 || labels.indexOf('SPAM') >= 0 || labels.indexOf('TRASH') >= 0) return;
          ids[ma.message.threadId] = true;
        });
      });
      latest = r.historyId || latest;
      pageToken = r.nextPageToken;
    } while (pageToken);
    return { ids: Object.keys(ids), historyId: latest };
  }

  function listThreads(token, q, pageToken, max) {
    var r = GoogleApi.get(token, BASE + 'threads', { q: q, maxResults: max || 50, pageToken: pageToken });
    return { ids: (r.threads || []).map(function (t) { return t.id; }), nextPageToken: r.nextPageToken || null };
  }

  function getThreads(token, ids) {
    if (!ids.length) return [];
    var raws = GoogleApi.getAll(token, ids.map(function (id) { return BASE + 'threads/' + id + '?format=full'; }), 8);
    return raws.filter(Boolean).map(function (raw) { return normalizeThread(raw, token); });
  }

  function decode(data) {
    return Utilities.newBlob(Utilities.base64DecodeWebSafe(data)).getDataAsString('UTF-8');
  }

  function htmlToText(html) {
    return String(html)
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, function (m, href, text) {
        return MEETING_LINK.test(href) ? text + ' (' + href + ')' : text;
      })
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  }

  function walk(part, acc, token, messageId) {
    var mime = (part.mimeType || '').toLowerCase();
    if (part.parts) part.parts.forEach(function (p) { walk(p, acc, token, messageId); });
    var body = part.body || {};
    if (mime === 'text/calendar' || mime === 'application/ics' || /\.ics$/i.test(part.filename || '')) {
      var data = body.data;
      if (!data && body.attachmentId) {
        try { data = GoogleApi.get(token, BASE + 'messages/' + messageId + '/attachments/' + body.attachmentId).data; } catch (e) { data = null; }
      }
      if (data) acc.ics.push(decode(data));
      return;
    }
    if (!body.data || part.filename) return;
    if (mime === 'text/plain') acc.plain.push(decode(body.data));
    else if (mime === 'text/html') acc.html.push(decode(body.data));
  }

  function normalizeThread(raw, token) {
    var messages = (raw.messages || []).filter(function (m) { return (m.labelIds || []).indexOf('DRAFT') < 0; }).map(function (m) {
      var h = {};
      (m.payload.headers || []).forEach(function (x) { h[x.name.toLowerCase()] = x.value; });
      var acc = { plain: [], html: [], ics: [] };
      walk(m.payload, acc, token, m.id);
      var ics = Util.uniq(acc.ics);
      return {
        id: m.id,
        date: parseInt(m.internalDate, 10),
        from: h.from || '', to: h.to || '', cc: h.cc || '', subject: h.subject || '',
        listUnsubscribe: h['list-unsubscribe'] || null, precedence: h.precedence || null,
        labels: m.labelIds || [],
        body: acc.plain.length ? acc.plain.join('\n') : htmlToText(acc.html.join('\n')),
        icsTexts: ics
      };
    });
    return { id: raw.id, subject: messages.length ? messages[0].subject : '', messages: messages };
  }

  return { SEARCH: SEARCH, profile: profile, history: history, listThreads: listThreads, getThreads: getThreads, htmlToText: htmlToText };
})();
