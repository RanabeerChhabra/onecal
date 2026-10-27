// Read-only access to a connected account's own calendars (calendar.readonly scope).

var CalApi = (function () {
  var BASE = 'https://www.googleapis.com/calendar/v3/';

  // Calendars the account owns (primary + ones they created). Skips subscribed/holiday calendars
  // and, importantly, the shared Founders calendar itself.
  function ownedCalendars(token, sharedId) {
    var out = [], pageToken = null;
    do {
      var r = GoogleApi.get(token, BASE + 'users/me/calendarList', { minAccessRole: 'owner', pageToken: pageToken, maxResults: 250 });
      (r.items || []).forEach(function (c) {
        if (c.id !== sharedId && !c.deleted) out.push({ id: c.id, summary: c.summary, primary: !!c.primary, timeZone: c.timeZone });
      });
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  function events(token, calendarId, timeMin, timeMax) {
    var out = [], pageToken = null;
    do {
      var r = GoogleApi.get(token, BASE + 'calendars/' + encodeURIComponent(calendarId) + '/events', {
        timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(),
        singleEvents: 'true', showDeleted: 'true', maxResults: 2500, pageToken: pageToken
      });
      out = out.concat(r.items || []);
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  return { ownedCalendars: ownedCalendars, events: events };
})();
