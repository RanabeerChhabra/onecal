// Builds dist/Code.gs: every source file in one file, so each account can paste a single file
// into a new Apps Script project. Also copies the manifest.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, '..', 'dist');
const CORE = ['Util', 'Links', 'Settings', 'Prefilter', 'Ics', 'Sources', 'Extract', 'Render', 'Reconcile', 'Brief'];
const ADAPTERS = ['Http', 'Self', 'GmailApi', 'CalApi', 'Claude', 'DeepSeek', 'AgentLog', 'SharedStore', 'Backfill', 'Sync', 'Setup', 'Morning'];

const coreFiles = fs.readdirSync(path.join(SRC, 'core')).map((f) => f.replace(/\.js$/, ''));
const srcFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''));
for (const n of coreFiles) if (!CORE.includes(n)) throw new Error('Add core/' + n + ' to the bundle order');
for (const n of srcFiles) if (n !== 'Config' && !ADAPTERS.includes(n)) throw new Error('Add ' + n + ' to the bundle order');

const version = new Date().toISOString().slice(0, 16).replace('T', ' ');
const parts = [
  '// Founders Meeting Agent — single-file build ' + version + ' UTC. Do not edit here; edit src/ and run `npm run bundle`.',
  '// Paste this whole file into Code.gs of a new Apps Script project in each account. See README.',
  '',
  fs.readFileSync(path.join(SRC, 'Config.js'), 'utf8')
];
for (const n of CORE) parts.push('// ---- core/' + n + '.js ----\n' + fs.readFileSync(path.join(SRC, 'core', n + '.js'), 'utf8'));
for (const n of ADAPTERS) parts.push('// ---- ' + n + '.js ----\n' + fs.readFileSync(path.join(SRC, n + '.js'), 'utf8'));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'Code.gs'), parts.join('\n'));
fs.copyFileSync(path.join(SRC, 'appsscript.json'), path.join(OUT, 'appsscript.json'));
console.log('dist/Code.gs (' + Math.round(fs.statSync(path.join(OUT, 'Code.gs')).size / 1024) + ' KB) and dist/appsscript.json written');

// Setup page with both files embedded (published as the shareable setup link).
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const page = fs.readFileSync(path.join(__dirname, '..', 'docs', 'setup-page.template.html'), 'utf8')
  .replace('__MANIFEST__', () => esc(fs.readFileSync(path.join(OUT, 'appsscript.json'), 'utf8')))
  .replace('__CODE__', () => esc(fs.readFileSync(path.join(OUT, 'Code.gs'), 'utf8')))
  .replace('__VERSION__', () => version + ' UTC');
fs.writeFileSync(path.join(OUT, 'setup-page.html'), page);
console.log('dist/setup-page.html written');
