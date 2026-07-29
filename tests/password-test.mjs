/**
 * Migration d'un mot de passe d'environnement vers la base.
 *
 * Une instance protégée par le seul APP_PASSWORD est marquée « revendiquée »
 * sans stocker le moindre hash : perdre le .env la verrouillait donc pour de
 * bon. Le README décrivait une sortie de secours — remettre la variable, se
 * connecter, enregistrer le mot de passe depuis Réglages — que le code
 * refusait, puisque /api/password répondait 409 tant que la variable existait.
 *
 * Ce test fige le comportement corrigé : la variable amorce l'accès, un hash
 * en base la remplace dès qu'il existe, et elle devient retirable sans risque.
 */
import fs from 'node:fs';

const PORT = 8393;
const ENV_PASSWORD = 'mot-de-passe-du-env';
const NEW_PASSWORD = 'nouveau-mot-de-passe';
const DATA_DIR = '/tmp/ah-pw-' + Date.now();
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.PORT = String(PORT);
process.env.DATA_DIR = DATA_DIR;
process.env.APP_PASSWORD = ENV_PASSWORD;
process.env.APP_SECRET = 'test-secret-password-migration';
process.env.HERMES_API_URL = 'http://127.0.0.1:9';
delete process.env.AGENTROUTER_API_KEY;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}${extra ? '\n    ' + extra : ''}`); fail++; }
};

process.on('uncaughtException', (e) => { console.log('✗ uncaught exception:', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log('✗ unhandled rejection:', e && e.message); process.exit(1); });

await import('/app/server.js');
await new Promise((r) => setTimeout(r, 400));

const BASE = `http://127.0.0.1:${PORT}`;
let cookie = '';

async function call(path, { method = 'GET', body, useCookie = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (useCookie && cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch { /* corps non JSON */ }
  return { status: res.status, json };
}

// ---- la variable garde la porte tant que rien n'est en base ----------------
const before = await call('/api/me');
ok('l\'instance se déclare revendiquée', before.json.claimed === true);
ok('APP_PASSWORD est signalée comme active', before.json.envPassword === true);

const login = await call('/api/login', { method: 'POST', body: { password: ENV_PASSWORD } });
ok('on entre avec le mot de passe de la variable', login.status === 200);
ok('une session est délivrée', Boolean(cookie));

// ---- le changement est possible, et contrôlé ------------------------------
const wrong = await call('/api/password', {
  method: 'POST', useCookie: true, body: { current: 'pas-le-bon', password: NEW_PASSWORD },
});
ok('un mauvais mot de passe actuel est refusé', wrong.status === 401);

const short = await call('/api/password', {
  method: 'POST', useCookie: true, body: { current: ENV_PASSWORD, password: 'court' },
});
ok('un nouveau mot de passe trop court est refusé', short.status === 400);

const change = await call('/api/password', {
  method: 'POST', useCookie: true, body: { current: ENV_PASSWORD, password: NEW_PASSWORD },
});
ok('LE MOT DE PASSE PEUT PASSER EN BASE MALGRÉ APP_PASSWORD', change.status === 200,
  `HTTP ${change.status} — c'est précisément ce que le 409 empêchait`);
ok('le serveur signale que la variable est libérée', change.json?.envReleased === true);

// ---- le hash l'emporte désormais ------------------------------------------
const after = await call('/api/me');
ok('APP_PASSWORD n\'est plus la référence', after.json.envPassword === false);

const withNew = await call('/api/login', { method: 'POST', body: { password: NEW_PASSWORD } });
ok('le nouveau mot de passe fonctionne', withNew.status === 200);

const withOld = await call('/api/login', { method: 'POST', body: { password: ENV_PASSWORD } });
ok('L\'ANCIEN MOT DE PASSE DU .ENV NE FONCTIONNE PLUS', withOld.status === 401,
  'le hash en base doit primer, sinon retirer la variable ne changerait rien');

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* verrou Windows */ }
process.exit(fail ? 1 : 0);
