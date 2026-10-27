// The Google account this copy of the script runs as, and its sync cursors (Script Properties "SELF").

var Self = (function () {
  function email() {
    return String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  }

  function tag() {
    var t = CONFIG.accounts[email()];
    if (!t) throw new Error(email() + ' is not listed in CONFIG.accounts. Add it at the top of the script.');
    return t;
  }

  function account() {
    var s = props_().getProperty('SELF');
    var a = s ? JSON.parse(s) : null;
    if (!a || a.email !== email()) {
      var months = getConfig_().backfillMonths;
      a = { email: email(), aid: 'a1', historyId: null, lastSync: null, retry: [],
        backfill: { phase: 'list', afterSec: Math.floor((Date.now() - months * 30.5 * 86400000) / 1000), pageToken: null, threads: 0 } };
    }
    a.founder = tag();
    a.status = 'ok';
    return a;
  }

  function save(a) {
    props_().setProperty('SELF', JSON.stringify(a));
  }

  function update(fn) {
    var a = account();
    fn(a);
    save(a);
    return a;
  }

  // The script's own OAuth token works for the Gmail/Calendar REST APIs (scopes from appsscript.json).
  function token() {
    return ScriptApp.getOAuthToken();
  }

  return { email: email, tag: tag, account: account, save: save, update: update, token: token };
})();
