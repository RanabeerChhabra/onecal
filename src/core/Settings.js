// Builds the runtime config object used by the core modules from raw key/value settings
// (Script Properties in Apps Script, a plain object in tests).

var Settings = (function () {
  var DEFAULTS = {
    PROVIDER: '',  // 'anthropic' or 'deepseek'; empty = whichever API key is set (Anthropic if both)
    MODEL: '',     // empty = the provider's default below
    DEFAULT_TZ: 'Asia/Kolkata',
    ADD_THRESHOLD: '0.8',
    TENTATIVE_THRESHOLD: '0.6',
    DEFAULT_DURATION_MIN: '30',
    BACKFILL_MONTHS: '6',
    LOOKAHEAD_DAYS: '120',
    INCLUDE_ALL_DAY: 'false',
    DRY_RUN_DAYS: '14',
    DRY_RUN_MAX_THREADS: '40',
    SYNC_EVERY_MIN: '120'  // the trigger fires every 10 min; runs in between are skipped (except during the backfill)
  };

  var PROVIDERS = {
    anthropic: { model: 'claude-haiku-5-5', keyName: 'ANTHROPIC_API_KEY' },
    deepseek: { model: 'deepseek-flash', keyName: 'DEEPSEEK_API_KEY' }
  };

  function pickProvider(raw) {
    var p = String(raw.PROVIDER || '').toLowerCase();
    if (p) {
      if (!PROVIDERS[p]) throw new Error('PROVIDER must be "anthropic" or "deepseek", not "' + raw.PROVIDER + '"');
      return p;
    }
    return raw.DEEPSEEK_API_KEY && !raw.ANTHROPIC_API_KEY ? 'deepseek' : 'anthropic';
  }

  // raw.FOUNDERS: JSON [{ "tag": "R", "name": "Ranabeer", "emails": ["..."] }, ...]
  // accounts: connected accounts [{ email, founder }] — their addresses count as that founder's too.
  // A shared inbox has a team tag like "R+H+A" and counts for all of them.
  function build(raw, accounts) {
    var get = function (k) { return raw[k] !== undefined && raw[k] !== null && raw[k] !== '' ? String(raw[k]) : DEFAULTS[k]; };
    var founders;
    try { founders = JSON.parse(raw.FOUNDERS || '[]'); } catch (e) { throw new Error('FOUNDERS setting is not valid JSON'); }
    founders = founders.map(function (f) {
      return { tag: String(f.tag), name: String(f.name || f.tag), emails: (f.emails || []).map(function (e) { return String(e).toLowerCase(); }) };
    });
    var founderOf = {}, founderName = {};
    founders.forEach(function (f) {
      founderName[f.tag] = f.name;
      f.emails.forEach(function (e) { founderOf[e] = f.tag; });
    });
    (accounts || []).forEach(function (a) {
      var e = a.email.toLowerCase();
      if (!founderOf[e]) founderOf[e] = a.founder;
      var f = founders.filter(function (x) { return x.tag === a.founder; })[0]; // none for team inboxes
      if (f && f.emails.indexOf(e) < 0) f.emails.push(e);
    });
    var provider = pickProvider(raw);
    return {
      provider: provider,
      keyName: PROVIDERS[provider].keyName,
      model: get('MODEL') || PROVIDERS[provider].model,
      defaultTz: get('DEFAULT_TZ'),
      addThreshold: parseFloat(get('ADD_THRESHOLD')),
      tentativeThreshold: parseFloat(get('TENTATIVE_THRESHOLD')),
      defaultDurationMin: parseInt(get('DEFAULT_DURATION_MIN'), 10),
      backfillMonths: parseInt(get('BACKFILL_MONTHS'), 10),
      lookaheadDays: parseInt(get('LOOKAHEAD_DAYS'), 10),
      includeAllDay: get('INCLUDE_ALL_DAY') === 'true',
      dryRunDays: parseInt(get('DRY_RUN_DAYS'), 10),
      dryRunMaxThreads: parseInt(get('DRY_RUN_MAX_THREADS'), 10),
      syncEveryMin: parseInt(get('SYNC_EVERY_MIN'), 10),
      founders: founders,
      founderOf: founderOf,
      founderName: founderName,
      teamTag: founders.map(function (f) { return f.tag; }).join('+')
    };
  }

  return { build: build, DEFAULTS: DEFAULTS, PROVIDERS: PROVIDERS };
})();
