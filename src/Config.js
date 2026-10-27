// ===== Founders Meeting Agent: shared configuration =====
// The same file runs in each connected Google account. Nothing here is secret: the API key goes in
// Project Settings -> Script properties -> ANTHROPIC_API_KEY (or DEEPSEEK_API_KEY), never in code.

var CONFIG = {
  calendarName: 'Founders — All Meetings',
  // This account creates the shared calendar and shares it (edit access) with every other account below.
  calendarOwner: 'founders@tryamp.in',
  founders: [
    // First email = the account each founder uses on their phone (gets the shared calendar).
    { tag: 'R', name: 'Ranabeer', emails: ['ranabeer@school.example'] },
    { tag: 'H', name: 'Hardik', emails: ['hardik@school.example'] },
    { tag: 'A', name: 'Anshul', emails: ['anshul@school.example'] }
  ],
  // Every account that runs a copy of this script, and whose meetings it holds.
  // "R+H+A" = shared team inbox: its meetings belong to all three.
  accounts: {
    'ranabeer@school.example': 'R',
    'hardik@school.example': 'H',
    'anshul@school.example': 'A',
    'founders@tryamp.in': 'R+H+A',
    'team@brand.example': 'R+H+A'
  }
};

function props_() {
  return PropertiesService.getScriptProperties();
}

// Script properties can override any default in core/Settings.js (e.g. BACKFILL_MONTHS).
function getConfig_() {
  var raw = props_().getProperties();
  raw.FOUNDERS = JSON.stringify(CONFIG.founders);
  var accounts = Object.keys(CONFIG.accounts).map(function (e) { return { email: e, founder: CONFIG.accounts[e] }; });
  var cfg = Settings.build(raw, accounts);
  cfg.raw = raw;
  return cfg;
}

function requireSettings_(cfg, keys) {
  var missing = keys.filter(function (k) { return !cfg.raw[k]; });
  if (missing.length) throw new Error('Missing Script property: ' + missing.join(', ') + ' (Project Settings -> Script properties).');
}
