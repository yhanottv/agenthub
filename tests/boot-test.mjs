/**
 * Boot smoke test — actually starts server.js and exercises HTTP + WebSocket.
 *
 * The module-import tests cannot catch a ReferenceError that only fires inside
 * a request or upgrade handler (a stale hermesConfig() call shipped exactly
 * that way), so this test drives the real server end to end.
 */
import fs from 'node:fs';
// `ws` is CommonJS, so it has no named ESM exports.
import wsPkg from '/app/node_modules/ws/index.js';
const { WebSocket } = wsPkg;

const PORT = 8391;
const PASSWORD = 'boot-test-password';
const DATA_DIR = '/tmp/ah-boot-' + Date.now();
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.PORT = String(PORT);
process.env.DATA_DIR = DATA_DIR;
process.env.APP_PASSWORD = PASSWORD;
process.env.APP_SECRET = 'boot-test-secret';
process.env.HERMES_API_URL = 'http://127.0.0.1:9';   // unused, never called
process.env.AGENTROUTER_API_KEY = 'test-key-boot';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}${extra ? '\n    ' + extra : ''}`); fail++; }
};

// Any unhandled error during boot must fail the test loudly.
process.on('uncaughtException', (e) => { console.log('✗ uncaught exception:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log('✗ unhandled rejection:', e && e.message); process.exit(1); });

await import('/app/server.js');

// Wait for the listener to come up.
const base = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 50; i++) {
  try { const r = await fetch(`${base}/api/health`); if (r.ok) { up = true; break; } } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
ok('server listens and answers /api/health', up);
if (!up) process.exit(1);

// A fresh database must seed itself.
const login = await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
});
ok('login succeeds', login.status === 200, `status ${login.status}`);
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
ok('a session cookie is issued', Boolean(cookie));

const state = await fetch(`${base}/api/state`, { headers: { cookie } }).then((r) => r.json());
ok('state exposes a seeded org', state.agents.length > 0 && state.channels.length > 0,
  `${state.agents.length} agents / ${state.channels.length} channels`);
ok('state exposes the provider catalogue', Array.isArray(state.providers) && state.providers.length === 2,
  JSON.stringify(state.providers && state.providers.map((p) => p.id)));
ok('no API key reaches the client', !JSON.stringify(state).includes('test-key-boot'));

// A deploy must invalidate the browser cache, or the new build stays invisible.
const shell = await fetch(`${base}/`).then((r) => r.text());
const jsRef = /src="\/app\.js\?v=([a-f0-9]+)"/.exec(shell);
const cssRef = /href="\/styles\.css\?v=([a-f0-9]+)"/.exec(shell);
ok('the shell points at a fingerprinted app.js', Boolean(jsRef), shell.match(/app\.js[^"]*/)?.[0]);
ok('the shell points at a fingerprinted styles.css', Boolean(cssRef), shell.match(/styles\.css[^"]*/)?.[0]);
if (jsRef) {
  const versioned = await fetch(`${base}/app.js?v=${jsRef[1]}`);
  const bare = await fetch(`${base}/app.js`);
  ok('fingerprinted assets are cached hard',
    /immutable/.test(versioned.headers.get('cache-control') || ''), versioned.headers.get('cache-control'));
  ok('bare assets must revalidate',
    /no-cache/.test(bare.headers.get('cache-control') || ''), bare.headers.get('cache-control'));
}
const shellCache = (await fetch(`${base}/`)).headers.get('cache-control');
ok('the shell itself is never cached', /no-cache/.test(shellCache || ''), shellCache);

// First-run wizard data
const setup = await fetch(`${base}/api/setup`, { headers: { cookie } }).then((r) => r.json());
ok('setup endpoint answers', typeof setup.done === 'boolean' && Array.isArray(setup.providers),
  JSON.stringify(setup).slice(0, 100));
ok('setup reports a fresh install as not done', setup.done === false);
ok('setup diagnoses Hermes', setup.hermes && typeof setup.hermes.reachable === 'boolean',
  JSON.stringify(setup.hermes).slice(0, 120));
ok('setup counts the organisation', typeof setup.agents === 'number' && setup.agents > 0);
ok('no API key in the setup payload', !JSON.stringify(setup).includes('test-key-boot'));

await fetch(`${base}/api/setup/complete`, { method: 'POST', headers: { cookie } });
const setup2 = await fetch(`${base}/api/setup`, { headers: { cookie } }).then((r) => r.json());
ok('completing the wizard is remembered', setup2.done === true);

const provList = await fetch(`${base}/api/providers`, { headers: { cookie } }).then((r) => r.json());
ok('providers endpoint exposes presets', Array.isArray(provList.presets) && provList.presets.length >= 4,
  `${(provList.presets || []).length} presets`);
ok('presets include OpenRouter', (provList.presets || []).some((p) => p.id === 'openrouter'));
ok('no key in the provider payload', !JSON.stringify(provList).includes('test-key-boot'));

const created = await fetch(`${base}/api/providers/my-service`, {
  method: 'PUT', headers: { cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify({ label: 'Mon service', base_url: 'http://127.0.0.1:9/v1', api_key: 'test-key-written-here' }),
}).then((r) => r.json());
ok('a provider can be created over HTTP', created.providers.some((p) => p.id === 'my-service'));
ok('its key is never echoed back', !JSON.stringify(created).includes('test-key-written-here'));

const notes = await fetch(`${base}/api/notes`, { headers: { cookie } }).then((r) => r.json());
ok('notes endpoint answers', Array.isArray(notes.notes), JSON.stringify(notes).slice(0, 80));
const usage = await fetch(`${base}/api/usage?range=7d`, { headers: { cookie } }).then((r) => r.json());
ok('usage endpoint answers', typeof usage.calls === 'number' && Array.isArray(usage.byModel),
  JSON.stringify(usage).slice(0, 80));
ok('an unknown range falls back safely',
  (await fetch(`${base}/api/usage?range=pwn`, { headers: { cookie } }).then((r) => r.json())).range === '7d');

const bad = await fetch(`${base}/api/state`);
ok('unauthenticated state is refused', bad.status === 401, `status ${bad.status}`);
const notFound = await fetch(`${base}/api/definitely-not-a-route`, { headers: { cookie } });
ok('unknown api routes 404 as JSON', notFound.status === 404);

// The upgrade handler is where the stale reference used to blow up.
const wsResult = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ ok: false, why: 'timeout' }); }, 5000);
  ws.on('message', (raw) => {
    clearTimeout(timer);
    let msg = null;
    try { msg = JSON.parse(raw.toString()); } catch {}
    try { ws.close(); } catch {}
    resolve({ ok: msg && msg.type === 'hello', msg });
  });
  ws.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, why: e.message }); });
});
ok('websocket upgrade works and greets the client', wsResult.ok, wsResult.why || JSON.stringify(wsResult.msg));
ok('the greeting carries the providers', wsResult.msg && Array.isArray(wsResult.msg.providers),
  JSON.stringify(wsResult.msg));

const unauthWs = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const timer = setTimeout(() => resolve('timeout'), 5000);
  ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
  ws.on('error', () => {});
});
ok('websocket rejects an unauthenticated client', unauthWs === 4401 || unauthWs === 1006, `close code ${unauthWs}`);

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(DATA_DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
