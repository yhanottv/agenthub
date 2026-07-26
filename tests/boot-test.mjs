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
// Deliberately NO password and NO secret: a fresh install must come up with
// zero configuration and let the first visitor claim it.
delete process.env.APP_PASSWORD;
delete process.env.APP_SECRET;
process.env.HERMES_API_URL = 'http://127.0.0.1:9';   // unused, never called
process.env.HERMES_API_KEY = 'test-key-boot';
// AGENTROUTER_API_KEY deliberately unset: an unconfigured service must NOT be seeded.
delete process.env.AGENTROUTER_API_KEY;

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

// ---- first-run claim -------------------------------------------------------
const me0 = await fetch(`${base}/api/me`).then((r) => r.json());
ok('a fresh install reports itself as unclaimed', me0.claimed === false, JSON.stringify(me0));
ok('and advertises the minimum password length', me0.minPassword >= 8);

const tooShort = await fetch(`${base}/api/claim`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'court' }),
});
ok('a short password is refused', tooShort.status === 400, `status ${tooShort.status}`);

const loginBeforeClaim = await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
});
ok('logging in before claiming is impossible', loginBeforeClaim.status === 409,
  `status ${loginBeforeClaim.status}`);

const claim = await fetch(`${base}/api/claim`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
});
ok('the first visitor can claim the instance', claim.status === 200, `status ${claim.status}`);
let cookie = (claim.headers.get('set-cookie') || '').split(';')[0];
ok('claiming logs you straight in', Boolean(cookie));

const secondClaim = await fetch(`${base}/api/claim`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'attacker-password' }),
});
ok('A SECOND CLAIM IS REFUSED', secondClaim.status === 409, `status ${secondClaim.status}`);

const me1 = await fetch(`${base}/api/me`).then((r) => r.json());
ok('the instance now reports itself as claimed', me1.claimed === true);

// The password must be stored hashed, never in the clear.
const dump = fs.readFileSync(`${DATA_DIR}/agenthub.db`, 'latin1');
ok('THE PASSWORD IS NOT STORED IN THE CLEAR', !dump.includes(PASSWORD),
  'the plaintext password was found inside the database file');

const login = await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
});
ok('login succeeds with the chosen password', login.status === 200, `status ${login.status}`);
cookie = (login.headers.get('set-cookie') || '').split(';')[0];
ok('a session cookie is issued', Boolean(cookie));

const wrongLogin = await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'pas-le-bon' }),
});
ok('a wrong password is rejected', wrongLogin.status === 401);

// Changing the password from the app.
const badCurrent = await fetch(`${base}/api/password`, {
  method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify({ current: 'faux', password: 'nouveau-mot-de-passe' }),
});
ok('changing the password needs the current one', badCurrent.status === 401);

const changed = await fetch(`${base}/api/password`, {
  method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify({ current: PASSWORD, password: 'nouveau-mot-de-passe' }),
});
ok('the password can be changed from the app', changed.status === 200);
const reLogin = await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'nouveau-mot-de-passe' }),
});
ok('the new password works', reLogin.status === 200);
cookie = (reLogin.headers.get('set-cookie') || '').split(';')[0];

const state = await fetch(`${base}/api/state`, { headers: { cookie } }).then((r) => r.json());
ok('state exposes a seeded org', state.agents.length > 0 && state.channels.length > 0,
  `${state.agents.length} agents / ${state.channels.length} channels`);
ok('state exposes the provider catalogue', Array.isArray(state.providers) && state.providers.length === 1,
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

// A fresh install on someone else's machine must not inherit a provider that
// points at infrastructure only the author runs.
const seeded = await fetch(`${base}/api/providers`, { headers: { cookie } }).then((r) => r.json());
const seededIds = seeded.providers.map((p) => p.id);
ok('a keyless install seeds Hermes only', seededIds.length === 1 && seededIds[0] === 'hermes',
  JSON.stringify(seededIds));
ok('no provider points at the author private proxy',
  !seeded.providers.some((p) => /agentrouter-proxy/.test(p.base)),
  JSON.stringify(seeded.providers.map((p) => p.base)));
// What matters is that a fresh install only ever points at something the
// operator controls: a container name, localhost, or a private address.
// Anything with a public TLD would mean the app phones somewhere on its own.
ok('the seeded Hermes stays on infrastructure the operator controls',
  !/^https?:\/\/[^/]*\.[a-z]{2,}/i.test(seeded.providers[0].base),
  seeded.providers[0].base);

const provList = seeded;
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
