import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import {
  Agents, Channels, Messages, Tasks, Settings, Stats, Notes, NoteProposals, Usage, Providers,
  Sessions, Prices, Search, Attachments, Schedules, Webhooks, Translations, MAX_I18N_SOURCE,
  notesBudget, NOTES_BUDGET_MAX, slug, db,
} from './db.js';
import { buildGraph, layerCounts, GRAPH_LAYERS, LAYER_META } from './graph.js';
import { skillsCatalogue, invalidateSkills } from './skills.js';
import { safeEntryPath } from './archive.js';
import {
  discover as discoverHermes, installHermes, installPlan, dockerStatus, connectToNetwork,
  diagnoseGateway, startGateway,
} from './hermes.js';
import {
  providerCatalog, probeProvider, seedProvidersFromEnv, streamChat, PRESETS,
  transcribeAudio, transcribeProvider, findTranscriber, freeTranscribeOptions,
} from './llm.js';
import { Orchestrator } from './orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8090);
const MAX_MESSAGE_CHARS = 8000;
const MIN_PASSWORD_CHARS = 8;

/**
 * Session signing key. An explicit APP_SECRET still wins (existing
 * deployments), otherwise one is generated once and persisted so that no
 * configuration file is required to install the app.
 */
function resolveSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  let s = Settings.get('session_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    Settings.set('session_secret', s);
    console.log('Secret de session généré et enregistré en base.');
  }
  return s;
}
const SECRET = resolveSecret();

// Legacy path: a password pinned in the environment. Left in place so existing
// installs keep working, but nothing requires it any more.
const ENV_PASSWORD = process.env.APP_PASSWORD || '';

const storedHash = () => Settings.get('auth_hash');

/**
 * Whether this instance has ever been secured. Sticky on purpose: an install
 * protected only by APP_PASSWORD writes no hash, so without a durable marker
 * dropping that variable — a rotated .env, a redeploy that loses a secret —
 * would flip the instance back to "unclaimed" and hand a database full of
 * conversations and provider keys to the first stranger who asks.
 */
const isClaimed = () => Settings.get('claimed') === '1';
const hasPassword = () => Boolean(ENV_PASSWORD || storedHash() || isClaimed());

function setPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  Settings.set('auth_salt', salt);
  Settings.set('auth_hash', crypto.scryptSync(plain, salt, 64).toString('hex'));
  Settings.set('claimed', '1');
}

// An APP_PASSWORD install is claimed too, even though it stores no hash.
if (ENV_PASSWORD && !isClaimed()) Settings.set('claimed', '1');

const app = express();

// Trusting X-Forwarded-For makes req.ip client-controlled, and req.ip is the
// only key the login lockout has. Trusting it unconditionally let anyone rotate
// the header to guess passwords forever, so it is now opt-in: set TRUST_PROXY=1
// (or a CIDR) only when something really does sit in front.
const TRUST_PROXY = process.env.TRUST_PROXY || '';
if (TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
}
app.disable('x-powered-by');

/**
 * Whether the browser reached us over TLS. Read separately from `req.secure`
 * so that dropping the proxy trust above cannot silently strip `Secure` from
 * the session cookie behind a TLS-terminating proxy. A forged header here only
 * marks the forger's own cookie Secure, which costs them, not us.
 */
const isSecureRequest = (req) =>
  req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

// ---- security headers -------------------------------------------------------
// Agent output is rendered through a markdown pipeline that ends in innerHTML,
// so a strict CSP is the backstop if any escaping there is ever wrong.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // `microphone=()` interdit le micro à tout le monde, nous compris — et c'est
  // exactement ce qui se passait : l'utilisateur autorisait le micro dans son
  // navigateur, la page était quand même bloquée, et la dictée annonçait un
  // refus qui ne venait pas de lui. La dictée a besoin de `self`. La caméra et
  // la géolocalisation restent fermées : rien ici ne s'en sert.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self'; " +
    // La prévisualisation d'une page produite par un agent vit dans une iframe
    // servie par nous ; sans `frame-src`, `default-src` la refuserait.
    "frame-src 'self'; " +
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none';",
  );
  next();
});

/** Same-origin test shared by the CSRF gate and the WebSocket handshake. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                 // non-browser callers send no Origin
  const host = req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  return origin === `http://${host}` || origin === `https://${host}` || origin === `${proto}://${host}`;
}

// ---- CSRF -------------------------------------------------------------------
// The session lives in a cookie, so a cross-site page could otherwise drive any
// mutating endpoint. Login and claim are exempt: neither relies on an existing
// session, so there is nothing to ride.
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();
  if (req.path === '/api/login' || req.path === '/api/claim') return next();
  if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-origin request rejected' });
  next();
});

app.use(express.json({ limit: '512kb' }));

// ---- tiny signed-cookie auth ----------------------------------------------
// Every login mints a fresh random token held server-side. Signing alone would
// make one constant cookie valid forever: logout could not revoke it, and
// changing the password would not evict whoever already had it.
//
// That token set now lives in SQLite rather than in this process. In memory,
// every restart — so every deploy — logged everyone out, and nothing ever
// expired a token that had been issued.
setInterval(() => {
  const gone = Sessions.purge();
  if (gone) console.log(`${gone} session(s) expirée(s) purgée(s).`);
}, 3600_000).unref();
Sessions.purge();

function sign(val) {
  const h = crypto.createHmac('sha256', SECRET).update(val).digest('hex');
  return `${val}.${h}`;
}
function verify(signed) {
  if (!signed || !signed.includes('.')) return false;
  const i = signed.lastIndexOf('.');
  const token = signed.slice(0, i);
  const expected = sign(token);
  // Constant-time: compare fixed-length buffers.
  const a = Buffer.from(expected);
  const b = Buffer.from(signed);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  return Sessions.valid(token) ? token : false;
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      try { out[k] = decodeURIComponent(part.slice(idx + 1).trim()); }
      catch { out[k] = part.slice(idx + 1).trim(); }
    }
  }
  return out;
}
const isAuthed = (req) => Boolean(verify(parseCookies(req).ah_session));

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

/**
 * Password comparison that does not leak length or content through timing.
 *
 * A stored hash wins over APP_PASSWORD, and that order matters.
 *
 * It used to be the other way round, which made one documented recovery path
 * impossible to walk: an install protected only by APP_PASSWORD is marked
 * claimed but stores no hash, so losing the variable locks the owner out for
 * good. The README told them to put the variable back and set a real password
 * from Réglages — but that screen refused to do anything while the variable
 * existed. Reading the environment only when no hash exists turns APP_PASSWORD
 * into what it should always have been: a bootstrap credential, replaceable
 * from the interface, and safe to drop afterwards.
 */
function passwordMatches(candidate) {
  const given = String(candidate ?? '');

  const salt = Settings.get('auth_salt');
  const hash = storedHash();
  if (salt && hash) {
    const known = Buffer.from(hash, 'hex');
    const attempt = crypto.scryptSync(given, salt, known.length);
    return crypto.timingSafeEqual(attempt, known);
  }

  if (ENV_PASSWORD) {
    const a = crypto.createHmac('sha256', SECRET).update(given).digest();
    const b = crypto.createHmac('sha256', SECRET).update(ENV_PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
  }
  return false;
}

/** True while APP_PASSWORD is the credential actually in force. */
const envPasswordInEffect = () => Boolean(ENV_PASSWORD) && !storedHash();

// Built in one place so login and first-run claim issue identical sessions.
function sessionCookie(req) {
  const token = crypto.randomBytes(24).toString('hex');
  Sessions.create(token);
  const secure = isSecureRequest(req) ? ' Secure;' : '';
  return `ah_session=${encodeURIComponent(sign(token))}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=2592000`;
}

/** Drop the caller's own session, if it carried a valid one. */
function revokeSession(req) {
  const signed = parseCookies(req).ah_session;
  if (!signed) return;
  const i = signed.lastIndexOf('.');
  if (i > 0) Sessions.remove(signed.slice(0, i));
}

// ---- login throttling ------------------------------------------------------
// In-memory is enough for a single-instance app: it resets on restart, which is
// acceptable, and it stops online brute force which is the actual threat here.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 10 * 60 * 1000;
const attempts = new Map();

setInterval(() => {
  const t = Date.now();
  for (const [ip, rec] of attempts) {
    if (rec.lockedUntil < t && rec.resetAt < t) attempts.delete(ip);
  }
}, 60_000).unref();

function loginGate(req) {
  const ip = req.ip || 'unknown';
  const t = Date.now();
  const rec = attempts.get(ip) || { count: 0, resetAt: t + WINDOW_MS, lockedUntil: 0 };
  if (rec.lockedUntil > t) return { blocked: true, retryAfter: Math.ceil((rec.lockedUntil - t) / 1000) };
  if (rec.resetAt < t) { rec.count = 0; rec.resetAt = t + WINDOW_MS; }
  attempts.set(ip, rec);
  return { blocked: false, rec };
}
function noteFailure(req) {
  const ip = req.ip || 'unknown';
  const rec = attempts.get(ip);
  if (!rec) return;
  rec.count++;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    rec.count = 0;
    console.warn(`login: locking out ${ip} for ${LOCKOUT_MS / 60000} min`);
  }
}

app.post('/api/login', (req, res) => {
  if (!hasPassword()) return res.status(409).json({ error: 'not_claimed' });
  const gate = loginGate(req);
  if (gate.blocked) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'too_many_attempts', retryAfter: gate.retryAfter });
  }
  if (!passwordMatches(req.body?.password)) {
    noteFailure(req);
    return res.status(401).json({ error: 'bad_password' });
  }
  attempts.delete(req.ip || 'unknown');
  res.setHeader('Set-Cookie', sessionCookie(req));
  res.json({ ok: true });
});

/**
 * First-run claim: the very first visitor chooses the password, so installing
 * needs no configuration file at all. Only ever possible while no password
 * exists — afterwards this returns 409, whoever asks.
 */
app.post('/api/claim', (req, res) => {
  if (hasPassword()) return res.status(409).json({ error: 'Cette instance a déjà un mot de passe.' });
  const pw = String(req.body?.password ?? '');
  if (pw.length < MIN_PASSWORD_CHARS) {
    return res.status(400).json({ error: `Le mot de passe doit faire au moins ${MIN_PASSWORD_CHARS} caractères.` });
  }
  setPassword(pw);
  res.setHeader('Set-Cookie', sessionCookie(req));
  console.log('Mot de passe défini depuis l\'interface — instance sécurisée.');
  res.json({ ok: true });
});

/** Change the password from Réglages. Requires the current one. */
app.post('/api/password', requireAuth, (req, res) => {
  if (!passwordMatches(req.body?.current)) return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
  const pw = String(req.body?.password ?? '');
  if (pw.length < MIN_PASSWORD_CHARS) {
    return res.status(400).json({ error: `Le nouveau mot de passe doit faire au moins ${MIN_PASSWORD_CHARS} caractères.` });
  }
  const wasEnvOnly = envPasswordInEffect();
  setPassword(pw);
  // Changing the password is the one lever that must evict a stolen cookie, so
  // every existing session dies and the caller gets a fresh one.
  Sessions.clear();
  res.setHeader('Set-Cookie', sessionCookie(req));
  if (wasEnvOnly) {
    console.log('Mot de passe désormais stocké en base — APP_PASSWORD peut être retirée du .env.');
  }
  res.json({ ok: true, envReleased: wasEnvOnly });
});

/** Sign every other browser out, without changing the password. */
app.post('/api/sessions/revoke-others', requireAuth, (req, res) => {
  const mine = verify(parseCookies(req).ah_session);
  const before = Sessions.count();
  Sessions.clear();
  if (mine) Sessions.create(mine);
  res.json({ ok: true, revoked: Math.max(0, before - 1) });
});

app.post('/api/logout', (req, res) => {
  revokeSession(req);
  res.setHeader('Set-Cookie', 'ah_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({
  authed: isAuthed(req),
  // false ⇒ the client shows "choose a password" instead of "log in".
  claimed: hasPassword(),
  // Only true while the variable is what actually guards the door: once a
  // password is stored, the hash wins and the variable is dead weight.
  envPassword: envPasswordInEffect(),
  minPassword: MIN_PASSWORD_CHARS,
}));
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

// ---- state -----------------------------------------------------------------
app.get('/api/state', requireAuth, (req, res) => {
  res.json({
    agents: Agents.all(),
    channels: Channels.all(),
    settings: Settings.publicAll(),
    providers: providerCatalog(),
  });
});

// ---- providers -------------------------------------------------------------
app.get('/api/providers', requireAuth, (req, res) =>
  res.json({ providers: providerCatalog(), presets: PRESETS }));

app.put('/api/providers/:id', requireAuth, (req, res) => {
  const id = slug(req.params.id);
  if (!id) return res.status(400).json({ error: 'identifiant invalide' });
  const p = Providers.upsert({ ...(req.body || {}), id });
  if (!p) return res.status(400).json({ error: 'enregistrement impossible' });
  broadcast({ type: 'providers.update', providers: providerCatalog() });
  res.json({ providers: providerCatalog() });
});

app.delete('/api/providers/:id', requireAuth, (req, res) => {
  if (Providers.count() <= 1) {
    return res.status(409).json({ error: 'Impossible de supprimer le dernier fournisseur.' });
  }
  if (!Providers.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'providers.update', providers: providerCatalog() });
  broadcast({ type: 'agents.reload', agents: Agents.all() });
  res.json({ providers: providerCatalog() });
});

/**
 * Reach the service and list its models. The key may come from the request
 * (testing before saving) or from what is already stored (re-testing).
 */
app.post('/api/providers/:id/test', requireAuth, async (req, res) => {
  const id = slug(req.params.id);
  const stored = Providers.get(id);
  const body = req.body || {};
  const preset = PRESETS.find((p) => p.id === id);
  const cfg = {
    id,
    // Le libellé et l'en-tête de session servent à formuler une erreur utile
    // quand la clé est refusée : « ce service refuse cette clé » vaut mieux
    // que « la clé API est refusée ».
    label: body.label || stored?.label || preset?.label || id,
    session_header: stored?.session_header || preset?.session_header || '',
    base_url: body.base_url || stored?.base_url || '',
    api_key: body.api_key || stored?.api_key || '',
    // Whether a key is mandatory decides whether success may be reported at all.
    needs_key: body.needs_key !== undefined ? body.needs_key
      : stored ? Boolean(stored.needs_key)
      : preset ? preset.needs_key !== false : true,
  };
  const result = await probeProvider(cfg);
  // Cache the discovered models so the agent form has something to offer.
  if (result.ok && stored) {
    Providers.setModels(id, result.models, body.default_model || stored.default_model);
    broadcast({ type: 'providers.update', providers: providerCatalog() });
  }
  res.json(result);
});

/**
 * First-run status: is Hermes actually there, is any provider usable, does the
 * organisation exist yet? Drives the welcome wizard.
 */
app.get('/api/setup', requireAuth, async (req, res) => {
  const providers = providerCatalog();
  const hermes = Providers.get('hermes');
  let hermesProbe = { ok: false, error: "Hermes n'est pas configuré." };
  if (hermes && hermes.base_url) hermesProbe = await probeProvider(hermes);

  res.json({
    done: Settings.get('setup_done') === '1',
    hermes: {
      configured: Boolean(hermes && hermes.base_url),
      base: hermes ? hermes.base_url : '',
      keyConfigured: Boolean(hermes && hermes.api_key),
      reachable: hermesProbe.ok,
      error: hermesProbe.ok ? null : hermesProbe.error,
      models: hermesProbe.models || [],
    },
    providers,
    ready: providers.some((p) => p.enabled),
    agents: Agents.count(),
    channels: Channels.count(),
  });
});

// ---- détection et installation d'Hermes ------------------------------------
/**
 * Cherche une passerelle Hermes. Sans privilège si le socket Docker n'est pas
 * monté, avec bien plus de détail — dont la clé — s'il l'est.
 */
app.get('/api/hermes/discover', requireAuth, async (req, res) => {
  try {
    const r = await discoverHermes();
    res.json({
      ...r,
      // Le plan manuel est toujours joint : c'est la voie sans privilège, et
      // certains préféreront la lire plutôt que de laisser l'app agir.
      plan: r.found.length ? null : installPlan(),
      canInstall: r.docker.available && r.found.length === 0,
    });
  } catch (err) {
    console.error('hermes discover:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Reprend un Hermes détecté : enregistre son URL et sa clé comme fournisseur.
 * C'est l'intérêt principal de la détection — la clé est la valeur qu'on passe
 * sinon un quart d'heure à chercher dans les fichiers d'un autre conteneur.
 */
app.post('/api/hermes/adopt', requireAuth, async (req, res) => {
  const r = await discoverHermes();
  const hit = r.found.find((f) => f.name === req.body?.name) || r.found[0];
  if (!hit) return res.status(404).json({ error: 'Aucune passerelle Hermes détectée.' });

  // Hermes existe mais dans un autre projet Compose, donc sur un autre réseau :
  // son nom ne résoudrait pas. On se raccorde plutôt que d'enregistrer un
  // fournisseur mort.
  let joined = null;
  if (hit.shared === false && hit.networks?.length) {
    const c = await connectToNetwork(hit.networks[0]);
    if (!c.ok) {
      return res.status(409).json({
        error: `Hermes tourne sur le réseau « ${hit.networks[0] }», qu'AgentHub ne partage pas, `
             + `et le raccordement a échoué : ${c.error}`,
        network: hit.networks[0],
      });
    }
    joined = c.already ? null : c.network;
  }
  if (!hit.key && !req.body?.api_key) {
    return res.status(422).json({
      error: "Hermes a été trouvé, mais sa clé n'est pas lisible d'ici. Saisis-la à la main.",
      base_url: hit.base_url,
    });
  }

  const provider = Providers.upsert({
    id: 'hermes',
    label: 'Hermes',
    base_url: hit.base_url,
    api_key: req.body?.api_key || hit.key,
    session_header: 'X-Hermes-Session-Key',
    hint: PRESETS.find((p) => p.id === 'hermes')?.hint || '',
    needs_key: true,
    enabled: true,
  });

  const probe = await probeProvider(Providers.get('hermes'));
  if (probe.ok) Providers.setModels('hermes', probe.models, probe.models[0]);
  broadcast({ type: 'providers.update', providers: providerCatalog() });
  res.json({
    ok: true, provider: provider.id, reachable: probe.ok, joined,
    error: probe.ok ? null : probe.error, models: probe.models || [],
  });
});

/**
 * Installe Hermes. La progression est renvoyée en flux : le téléchargement de
 * l'image dure plusieurs minutes, et une page figée passe pour une panne.
 */
app.post('/api/hermes/install', requireAuth, async (req, res) => {
  const status = await dockerStatus();
  if (!status.available) {
    return res.status(409).json({
      error: status.detail,
      reason: status.reason,
      plan: installPlan(),
    });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();
  const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch { /* client parti */ } };

  try {
    const r = await installHermes({ onProgress: (m) => send({ type: 'progress', message: m }) });
    if (r.ok) {
      Providers.upsert({
        id: 'hermes', label: 'Hermes', base_url: r.base_url, api_key: r.key,
        session_header: 'X-Hermes-Session-Key', needs_key: true, enabled: true,
        hint: PRESETS.find((p) => p.id === 'hermes')?.hint || '',
      });
      const probe = await probeProvider(Providers.get('hermes'));
      if (probe.ok) Providers.setModels('hermes', probe.models, probe.models[0]);
      broadcast({ type: 'providers.update', providers: providerCatalog() });
      send({ type: 'done', ...r, models: probe.models || [], reachable: probe.ok });
    } else {
      send({ type: 'error', ...r });
    }
  } catch (err) {
    console.error('hermes install:', err);
    send({ type: 'error', error: err.message });
  }
  res.end();
});

/** Pourquoi la passerelle se tait, et peut-on la démarrer d'ici ? */
app.get('/api/hermes/diagnose', requireAuth, async (req, res) => {
  const name = String(req.query.name || '');
  if (!name) return res.status(400).json({ error: 'name requis' });
  try { res.json(await diagnoseGateway(name)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/** Démarre la passerelle d'Hermes, en flux : elle met une dizaine de secondes. */
app.post('/api/hermes/start-gateway', requireAuth, async (req, res) => {
  const name = String(req.body?.name || '');
  if (!name) return res.status(400).json({ error: 'name requis' });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();
  const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch { /* client parti */ } };

  try {
    const r = await startGateway(name, { onProgress: (m) => send({ type: 'progress', message: m }) });
    if (r.ok) {
      // La passerelle répond : on retente la sonde pour lister les modèles.
      const probe = await probeProvider(Providers.get('hermes'));
      if (probe.ok) Providers.setModels('hermes', probe.models, probe.models[0]);
      broadcast({ type: 'providers.update', providers: providerCatalog() });
      send({ type: 'done', ...r, models: probe.models || [], reachable: probe.ok });
    } else {
      send({ type: 'error', ...r });
    }
  } catch (err) {
    console.error('start gateway:', err);
    send({ type: 'error', detail: err.message });
  }
  res.end();
});

app.post('/api/setup/complete', requireAuth, (req, res) => {
  Settings.set('setup_done', '1');
  res.json({ ok: true });
});

app.post('/api/setup/reset', requireAuth, (req, res) => {
  Settings.set('setup_done', '');
  res.json({ ok: true });
});

app.get('/api/stats', requireAuth, (req, res) => res.json(Stats.overview()));
app.get('/api/settings', requireAuth, (req, res) => res.json(Settings.publicAll()));

app.put('/api/settings', requireAuth, (req, res) => {
  const patch = req.body || {};
  const ALLOWED = [
    'owner_name', 'org_name', 'theme', 'daily_budget', 'tools_enabled',
    'notes_auto', 'notes_budget', 'context_budget',
    'image_provider', 'image_model', 'image_mode',
    'transcribe_provider', 'transcribe_model',
  ];
  const FLAGS = ['tools_enabled', 'notes_auto'];
  for (const [k, v] of Object.entries(patch)) {
    if (!ALLOWED.includes(k)) continue;
    if (k === 'theme' && !['light', 'dark'].includes(v)) continue;
    if (k === 'daily_budget' && v !== '' && !(Number(v) >= 0)) continue;
    if ((k === 'notes_budget' || k === 'context_budget') && v !== '' && !(Number(v) > 0)) continue;
    // Une case décochée s'enregistre comme chaîne vide : un '0' serait une
    // valeur non vide, donc lue comme « présent » par un test de vérité.
    if (FLAGS.includes(k)) { Settings.set(k, v ? '1' : ''); continue; }
    Settings.set(k, String(v ?? '').slice(0, 80));
  }
  const settings = Settings.publicAll();
  broadcast({ type: 'settings.update', settings });
  res.json(settings);
});

// ---- agents ----------------------------------------------------------------
app.post('/api/agents', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  if (Agents.byName(name)) return res.status(409).json({ error: 'Un agent porte déjà ce nom.' });

  const a = Agents.create(req.body || {});
  broadcast({ type: 'agent.new', agent: a });
  res.json(a);
});

app.put('/api/agents/:id', requireAuth, (req, res) => {
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : null;
  if (name !== null) {
    if (!name) return res.status(400).json({ error: 'name required' });
    const clash = Agents.byName(name);
    if (clash && clash.id !== req.params.id) {
      return res.status(409).json({ error: 'Un agent porte déjà ce nom.' });
    }
  }
  const a = Agents.update(req.params.id, req.body || {});
  if (!a) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'agent.update', agent: a });
  res.json(a);
});

app.delete('/api/agents/:id', requireAuth, (req, res) => {
  const agent = Agents.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'not found' });
  if (!Agents.remove(req.params.id)) {
    return res.status(403).json({ error: 'Cet agent est protégé et ne peut pas être supprimé.' });
  }
  broadcast({ type: 'agent.remove', id: req.params.id });
  // Membership rows cascade away, so channel member lists changed too.
  for (const c of Channels.all()) broadcast({ type: 'channel.update', channel: c });
  res.json({ ok: true });
});

// ---- channels --------------------------------------------------------------
app.post('/api/channels', requireAuth, (req, res) => {
  if (!String(req.body?.name || '').trim()) return res.status(400).json({ error: 'name required' });
  const c = Channels.create(req.body || {});
  broadcast({ type: 'channel.new', channel: c });
  res.json(c);
});

app.put('/api/channels/:id', requireAuth, (req, res) => {
  const c = Channels.update(req.params.id, req.body || {});
  if (!c) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'channel.update', channel: c });
  res.json(c);
});

app.put('/api/channels/:id/members', requireAuth, (req, res) => {
  const members = req.body?.members;
  if (!Array.isArray(members)) return res.status(400).json({ error: 'members must be an array' });
  const c = Channels.setMembers(req.params.id, members);
  if (!c) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'channel.update', channel: c });
  res.json(c);
});

/** Change the model used inside one conversation, without touching the agents. */
app.put('/api/channels/:id/model', requireAuth, (req, res) => {
  const c = Channels.setModel(req.params.id, req.body || {});
  if (!c) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'channel.update', channel: c });
  res.json(c);
});

app.delete('/api/channels/:id', requireAuth, (req, res) => {
  if (!Channels.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'channel.remove', id: req.params.id });
  res.json({ ok: true });
});

/** Attach each message's files, so the client never has to ask per message. */
function withAttachments(channelId, messages) {
  const byMessage = new Map();
  for (const a of Attachments.list(channelId)) {
    if (!a.message_id) continue;
    if (!byMessage.has(a.message_id)) byMessage.set(a.message_id, []);
    byMessage.get(a.message_id).push({ id: a.id, name: a.name, bytes: a.bytes, mime: a.mime });
  }
  return messages.map((m) => (byMessage.has(m.id) ? { ...m, attachments: byMessage.get(m.id) } : m));
}

app.get('/api/channels/:id/messages', requireAuth, (req, res) => {
  if (!Channels.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({
    messages: withAttachments(req.params.id, Messages.list(req.params.id)),
    tasks: Tasks.list(req.params.id),
    files: Attachments.list(req.params.id),
  });
});

// ---- send a message (fires orchestration) ----------------------------------
app.post('/api/channels/:id/messages', requireAuth, (req, res) => {
  const channel = Channels.get(req.params.id);
  if (!channel) return res.status(404).json({ error: 'no channel' });

  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'empty' });
  if (text.length > MAX_MESSAGE_CHARS) {
    return res.status(413).json({ error: `Message trop long (max ${MAX_MESSAGE_CHARS} caractères).` });
  }

  const userMsg = Messages.create({
    channel_id: channel.id,
    author_type: 'user',
    author_name: 'Toi',
    author_emoji: '🧑',
    author_color: '#8a8f83',
    content: text,
    status: 'complete',
  });

  // Files uploaded while composing are bound to the message now. Only those
  // belonging to this channel, so an id from elsewhere cannot be grafted on.
  const attached = [];
  for (const id of (Array.isArray(req.body?.attachments) ? req.body.attachments : []).slice(0, 10)) {
    const a = Attachments.get(String(id));
    if (a && a.channel_id === channel.id && !a.message_id) {
      Attachments.attachTo(a.id, userMsg.id);
      attached.push({ id: a.id, name: a.name, bytes: a.bytes, mime: a.mime });
    }
  }
  const message = attached.length ? { ...userMsg, attachments: attached } : userMsg;

  broadcast({ type: 'message.new', message });
  res.json({ ok: true, message });

  // Orchestration runs off the response path; errors are reported in-channel.
  orchestrator.handleUserMessage(channel, text).catch((err) => {
    console.error('orchestration error:', err);
  });
});

app.post('/api/channels/:id/stop', requireAuth, (req, res) => {
  if (!Channels.get(req.params.id)) return res.status(404).json({ error: 'no channel' });
  res.json({ ok: true, stopped: orchestrator.stop(req.params.id) });
});

// ---- deleting messages / clearing a conversation ---------------------------
app.delete('/api/messages/:id', requireAuth, (req, res) => {
  const msg = Messages.get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'not found' });
  if (msg.status === 'streaming') {
    return res.status(409).json({ error: 'Ce message est encore en cours d\'écriture. Arrête le run d\'abord.' });
  }
  Messages.remove(req.params.id);
  broadcast({ type: 'message.remove', id: msg.id, channelId: msg.channel_id });
  res.json({ ok: true });
});

app.delete('/api/channels/:id/messages', requireAuth, (req, res) => {
  const channel = Channels.get(req.params.id);
  if (!channel) return res.status(404).json({ error: 'no channel' });
  // Cancel anything in flight first, so a running agent cannot immediately
  // write new messages into the conversation we just emptied.
  orchestrator.stop(channel.id);
  const { messages, tasks } = Messages.clearChannel(channel.id);
  broadcast({ type: 'channel.cleared', channelId: channel.id, messages, tasks });
  broadcast({ type: 'channel.update', channel: Channels.get(channel.id) });
  res.json({ ok: true, messages, tasks });
});

app.get('/api/tasks', requireAuth, (req, res) => res.json({ tasks: Tasks.recent() }));

// ---- second cerveau (shared memory) ----------------------------------------
// Note: the fixed sub-paths are declared before '/:id', otherwise Express would
// read "graph" as a note identifier.
app.get('/api/notes', requireAuth, (req, res) => res.json({
  notes: Notes.all(),
  tags: Notes.tags(),
  pendingProposals: NoteProposals.countPending(),
  budget: notesBudget(),
  budgetMax: NOTES_BUDGET_MAX,
  autoAccept: NoteProposals.autoAccept(),
}));

/**
 * Nodes and edges for the Memory Galaxy.
 * `layers` selects the families to include; unknown names are ignored rather
 * than rejected, so an old client never gets an empty map.
 */
app.get('/api/notes/graph', requireAuth, (req, res) => {
  const asked = String(req.query.layers ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const layers = asked.filter((l) => GRAPH_LAYERS.includes(l));
  res.json({
    ...buildGraph(layers.length ? layers : GRAPH_LAYERS),
    counts: layerCounts(),
    meta: LAYER_META,
  });
});

// ---- skills Hermes ---------------------------------------------------------
app.get('/api/skills', requireAuth, (req, res) => {
  if (req.query.refresh) invalidateSkills();
  res.json(skillsCatalogue(Boolean(req.query.refresh)));
});

/** Most recently touched first — the "Récent" tab. */
app.get('/api/notes/recent', requireAuth, (req, res) =>
  res.json({ notes: Notes.recent(Number(req.query.limit) || 30) }));

app.get('/api/notes/tags', requireAuth, (req, res) => res.json({ tags: Notes.tags() }));

// ---- notes proposed by agents ----------------------------------------------
app.get('/api/notes/proposals', requireAuth, (req, res) =>
  res.json({ proposals: NoteProposals.pending() }));

app.post('/api/notes/proposals/:id/accept', requireAuth, (req, res) => {
  const note = NoteProposals.accept(req.params.id, req.body || {});
  if (!note) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'note.change', note });
  broadcast({ type: 'proposals.update', pending: NoteProposals.countPending() });
  res.json(note);
});

app.post('/api/notes/proposals/:id/reject', requireAuth, (req, res) => {
  if (!NoteProposals.reject(req.params.id)) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'proposals.update', pending: NoteProposals.countPending() });
  res.json({ ok: true });
});

app.post('/api/notes', requireAuth, (req, res) => {
  const n = Notes.create(req.body || {});
  broadcast({ type: 'note.change', note: n });
  // A new note is a new star, and it may satisfy links other notes were
  // already pointing at — both change the shape of the graph.
  broadcast({ type: 'graph.dirty' });
  res.json(n);
});

app.get('/api/notes/:id', requireAuth, (req, res) => {
  const n = Notes.get(req.params.id);
  if (!n) return res.status(404).json({ error: 'not found' });
  res.json(n);
});

/** Opening a note in the UI counts as using it — that is what lights the star. */
app.post('/api/notes/:id/touch', requireAuth, (req, res) => {
  const n = Notes.touch(req.params.id);
  if (!n) return res.status(404).json({ error: 'not found' });
  res.json(n);
});

app.put('/api/notes/:id', requireAuth, (req, res) => {
  const n = Notes.update(req.params.id, req.body || {});
  if (!n) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'note.change', note: n });
  // Editing a body rewires the graph, and renaming can resolve other notes'
  // dangling links — the client cannot derive either from the note alone.
  broadcast({ type: 'graph.dirty' });
  res.json(n);
});

app.delete('/api/notes/:id', requireAuth, (req, res) => {
  if (!Notes.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'note.remove', id: req.params.id });
  broadcast({ type: 'graph.dirty' });
  res.json({ ok: true });
});

// ---- langue de l'interface -------------------------------------------------
/**
 * Traductions de l'interface, remplies à la demande.
 *
 * Le français est la langue source, et la source sert de clé : une chaîne
 * inconnue retombe donc simplement en français au lieu de laisser un trou.
 * Le client envoie ce qu'il n'a pas, on traduit en un seul appel, on conserve —
 * la fois suivante, plus rien à demander.
 *
 * Ce n'est pas un fichier de traduction figé, et c'est délibéré : l'interface
 * compte près de cinq cents chaînes qui bougent à chaque fonctionnalité. Un
 * fichier à maintenir à la main serait périmé en une semaine.
 */
const I18N_LANGS = { en: 'anglais', fr: 'français' };
const MAX_I18N_BATCH = 60;

// Le vocabulaire maison — sans ces équivalences, le modèle traduit « pôle » par
// « hub » ici et par « division » là, et l'interface se contredit d'un écran à
// l'autre. Les mêmes choix que le noyau écrit à la main dans public/i18n.js.
const I18N_GLOSSARY = {
  en: 'pôle = unit, salon = channel, second cerveau = second brain, '
    + 'tâche déléguée = delegated task, consommation = usage, '
    + 'fournisseur = provider, clé API = API key, agent et skill ne changent pas',
};

app.get('/api/i18n/:lang', requireAuth, (req, res) => {
  const lang = I18N_LANGS[req.params.lang] ? req.params.lang : 'fr';
  res.json({ lang, translations: lang === 'fr' ? {} : Translations.all(lang) });
});

app.post('/api/i18n/:lang', requireAuth, async (req, res) => {
  const lang = req.params.lang;
  if (!I18N_LANGS[lang] || lang === 'fr') return res.json({ translations: {} });

  const asked = (Array.isArray(req.body?.missing) ? req.body.missing : [])
    .map((s) => String(s).slice(0, MAX_I18N_SOURCE).trim())
    .filter(Boolean);
  if (!asked.length) return res.json({ translations: {} });

  const unique = [...new Set(asked)];
  const known = Translations.known(lang, unique);
  const todo = unique.filter((s) => !(s in known)).slice(0, MAX_I18N_BATCH);
  if (!todo.length) return res.json({ translations: known });

  const ref = Agents.all()[0] || {};
  let out = '';
  const r = await streamChat({
    agent: { provider: ref.provider, model: ref.model },
    messages: [
      {
        role: 'system',
        content: `Tu traduis des libellés d'interface logicielle du français vers ${I18N_LANGS[lang]}.\n`
          + 'On te donne un tableau JSON de chaînes. Réponds UNIQUEMENT par un tableau JSON de même '
          + 'longueur et dans le même ordre, contenant les traductions.\n'
          + 'Règles : garde la ponctuation, les majuscules initiales et les emoji tels quels ; '
          + 'ne traduis pas les noms propres, les noms de produits ni le contenu entre backticks ; '
          + 'reste concis, c\'est de l\'interface, pas de la prose ; aucun commentaire, aucun texte '
          + 'autour du tableau.'
          + (I18N_GLOSSARY[lang] ? `\nVocabulaire imposé : ${I18N_GLOSSARY[lang]}.` : ''),
      },
      { role: 'user', content: JSON.stringify(todo) },
    ],
    onDelta: (d) => { out += d; },
  });

  if (r.error) return res.status(502).json({ error: r.error, translations: known });
  if (r.usage) {
    Usage.record({
      agent_id: null, channel_id: null, provider: r.provider, model: r.model,
      tokens_in: r.usage.tokensIn, tokens_out: r.usage.tokensOut, estimated: r.usage.estimated,
    });
  }

  // Le modèle encadre parfois sa réponse d'un bloc de code : on ne garde que le
  // tableau, et on exige la même longueur — un décalage fausserait tout.
  let list = null;
  try {
    const m = out.match(/\[[\s\S]*\]/);
    if (m) list = JSON.parse(m[0]);
  } catch { list = null; }

  if (!Array.isArray(list) || list.length !== todo.length) {
    console.warn(`i18n ${lang} : réponse inutilisable (${Array.isArray(list) ? list.length : 'non-tableau'} pour ${todo.length} demandés).`);
    return res.json({ translations: known, partial: true });
  }

  const pairs = {};
  todo.forEach((src, i) => {
    const v = String(list[i] ?? '').trim();
    if (v) pairs[src] = v;
  });
  Translations.put(lang, pairs);
  console.log(`i18n ${lang} : ${Object.keys(pairs).length} libellé(s) traduit(s) et conservé(s).`);
  res.json({ translations: { ...known, ...pairs } });
});

// ---- traduction ------------------------------------------------------------
/**
 * Traduit un texte avec le fournisseur déjà configuré.
 *
 * Pas de service de traduction dédié : ce serait une clé de plus à obtenir pour
 * une tâche que les modèles déjà branchés font très bien. Le coût entre dans la
 * consommation comme n'importe quel appel, sinon le total mentirait.
 */
const TRANSLATE_LANGS = { fr: 'français', en: 'anglais' };
const MAX_TRANSLATE_CHARS = 6000;

app.post('/api/translate', requireAuth, async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  const to = TRANSLATE_LANGS[req.body?.to] ? req.body.to : 'en';
  if (!text) return res.status(400).json({ error: 'Rien à traduire.' });
  if (text.length > MAX_TRANSLATE_CHARS) {
    return res.status(413).json({ error: `Texte trop long (max ${MAX_TRANSLATE_CHARS} caractères).` });
  }

  const target = TRANSLATE_LANGS[to];
  let out = '';

  /*
   * On emprunte le service et le modèle du premier agent, pas « le premier
   * service utilisable ».
   *
   * La différence compte : le premier service utilisable était Hermes, qui
   * répond à /v1/models et paraît donc parfaitement valide — mais refuse toute
   * complétion tant qu'aucun modèle d'inférence ne lui a été choisi. Le modèle
   * des agents, lui, est celui dont on sait qu'il répond.
   */
  const ref = Agents.all()[0] || {};

  const r = await streamChat({
    agent: { provider: ref.provider, model: ref.model },
    messages: [
      {
        role: 'system',
        content: `Tu es un traducteur. Traduis le texte de l'utilisateur en ${target}. `
          + 'Rends UNIQUEMENT la traduction, sans guillemets, sans commentaire, sans préambule. '
          + 'Conserve la mise en forme, les sauts de ligne, les listes et le code tels quels. '
          + `Si le texte est déjà en ${target}, renvoie-le inchangé.`,
      },
      { role: 'user', content: text },
    ],
    onDelta: (d) => { out += d; },
  });

  if (r.error) return res.status(502).json({ error: r.error });
  if (r.usage) {
    Usage.record({
      agent_id: null, channel_id: null, provider: r.provider, model: r.model,
      tokens_in: r.usage.tokensIn, tokens_out: r.usage.tokensOut, estimated: r.usage.estimated,
    });
  }
  res.json({ text: out.trim(), to, model: r.model, provider: r.provider });
});

// ---- recherche -------------------------------------------------------------
app.get('/api/search', requireAuth, (req, res) => {
  const r = Search.run(req.query.q, Number(req.query.limit) || 40);
  res.json(r);
});

// ---- prix des modèles ------------------------------------------------------
app.get('/api/prices', requireAuth, (req, res) => {
  // Every provider/model pair actually used, so the form can offer the ones
  // that matter instead of an empty box.
  const seen = db.prepare(`SELECT DISTINCT provider, model FROM usage_log
                           WHERE model != '' ORDER BY provider, model`).all();
  res.json({ prices: Prices.all(), seen });
});

app.put('/api/prices', requireAuth, (req, res) => {
  const p = Prices.upsert(req.body || {});
  if (!p) return res.status(400).json({ error: 'modèle manquant' });
  res.json({ prices: Prices.all() });
});

app.delete('/api/prices/:id', requireAuth, (req, res) => {
  if (!Prices.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ prices: Prices.all() });
});

// ---- usage -----------------------------------------------------------------
// Bucket size is chosen per range so the curve always has enough points to be
// worth drawing — a 24 h window grouped by day would be a single dot.
const USAGE_WINDOWS = {
  '24h': { window: 86400000, bucket: 3600000 },
  '7d': { window: 7 * 86400000, bucket: 86400000 },
  '30d': { window: 30 * 86400000, bucket: 86400000 },
};
app.get('/api/usage', requireAuth, (req, res) => {
  const range = USAGE_WINDOWS[req.query.range] ? req.query.range : '7d';
  const { window, bucket } = USAGE_WINDOWS[range];
  res.json({ range, ...Usage.summary(window, bucket) });
});

// Recent activity feed for the dashboard studio + system journal.
app.get('/api/activity', requireAuth, (req, res) => {
  const msgs = Messages.recent(30).map((m) => ({
    kind: 'message', id: m.id, channel_id: m.channel_id, at: m.created_at,
    author_name: m.author_name, author_emoji: m.author_emoji, author_color: m.author_color,
    status: m.status, preview: (m.content || '').replace(/\s+/g, ' ').slice(0, 140),
  }));
  const tasks = Tasks.recent(30).map((t) => ({
    kind: 'task', id: t.id, channel_id: t.channel_id, at: t.updated_at,
    title: t.title, status: t.status, assigner_id: t.assigner_id, assignee_id: t.assignee_id,
  }));
  res.json({ feed: [...msgs, ...tasks].sort((a, b) => b.at - a.at).slice(0, 40) });
});

// ---- pièces jointes --------------------------------------------------------
// The body arrives raw rather than as multipart: parsing multipart by hand for
// one field would be more code than it is worth, and this keeps the dependency
// list at three.
const DATA_DIR = process.env.DATA_DIR || './data';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
// Extensions whose bytes are also kept as text, so an agent can read the file
// instead of merely being told one was attached.
const TEXTUAL = /\.(txt|md|markdown|csv|tsv|json|ya?ml|toml|ini|conf|log|sql|html?|css|jsx?|tsx?|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|zsh|ps1|xml|svg)$/i;

const safeName = (n) => String(n || 'fichier')
  .replace(/\p{Cc}/gu, '')          // un caractère de contrôle casserait l'en-tête
  .replace(/[/\\]/g, '_')           // affichage seulement, mais autant rester net
  .trim()
  .slice(0, 200) || 'fichier';

app.post('/api/channels/:id/attachments',
  requireAuth,
  express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
  (req, res) => {
    const channel = Channels.get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'no channel' });
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) return res.status(400).json({ error: 'fichier vide' });

    const name = safeName(req.query.name);
    const id = 'at_' + crypto.randomBytes(8).toString('hex');
    // The stored filename is ours, never the client's: a name is untrusted
    // input and this path is joined straight onto the data directory.
    const diskPath = path.join(UPLOAD_DIR, id);
    try {
      fs.writeFileSync(diskPath, buf);
    } catch (err) {
      console.error('upload write failed:', err);
      return res.status(500).json({ error: "Écriture impossible sur le disque." });
    }

    const mime = String(req.query.type || 'application/octet-stream').slice(0, 100);
    const isText = TEXTUAL.test(name) || mime.startsWith('text/') || mime === 'application/json';
    const a = Attachments.create({
      id, channel_id: channel.id, name, mime, bytes: buf.length, path: diskPath,
      text: isText ? buf.toString('utf8') : '',
    });
    res.json({ id: a.id, name: a.name, mime: a.mime, bytes: a.bytes, readable: Boolean(a.text) });
  });

// ---- prévisualisation de page ----------------------------------------------
/*
 * Exécuter le HTML qu'un agent vient d'écrire, sans lui ouvrir la maison.
 *
 * Pourquoi passer par le serveur alors que le code est déjà dans le navigateur :
 * une iframe `srcdoc` ou `blob:` hérite de la politique de la page parente, où
 * `script-src 'self'` interdit tout script en ligne. Le jeu ne démarrerait pas.
 * On sert donc la page depuis une URL à nous, avec sa propre politique.
 *
 * Ce qui la rend sûre, dans cet ordre :
 *
 * - l'iframe est en `sandbox` sans `allow-same-origin`, donc la page tourne dans
 *   une origine opaque : pas d'accès au cookie de session, ni au DOM parent ;
 * - sa politique est `default-src 'none'` avec les scripts en ligne autorisés :
 *   le code fourni s'exécute, mais ne peut joindre aucun réseau, donc ni notre
 *   API ni l'extérieur ;
 * - rien n'est écrit sur le disque et tout expire, parce qu'une prévisualisation
 *   n'est pas un document.
 */
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_PREVIEWS = 16;
const MAX_PREVIEW_FILES = 60;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const previews = new Map();

const PREVIEW_MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'video/webm', mp4: 'video/mp4',
};
const previewMime = (p) => PREVIEW_MIME[p.split('.').pop().toLowerCase()] || 'application/octet-stream';

const dropStalePreviews = () => {
  const cutoff = Date.now() - PREVIEW_TTL_MS;
  for (const [id, p] of previews) if (p.at < cutoff) previews.delete(id);
  // Un panneau laissé ouvert ne doit pas faire grossir la mémoire sans fin :
  // au-delà du plafond, les plus anciens partent (Map itère dans l'ordre
  // d'insertion, donc la première clé est la plus ancienne).
  while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value);
};

/**
 * Enregistre un site à prévisualiser.
 *
 * Un site n'est pas une page : il a une feuille de style à côté, un script, une
 * seconde page derrière un lien. Servir un seul document interdirait tout ça, et
 * « prévisualiser un site » ne voudrait plus rien dire. On garde donc un jeu de
 * fichiers, servi sous un préfixe commun pour que les chemins relatifs tombent
 * juste — `href="a-propos.html"` doit mener quelque part.
 */
app.post('/api/preview', requireAuth, (req, res) => {
  const raw = Array.isArray(req.body?.files) && req.body.files.length
    ? req.body.files
    : [{ path: 'index.html', content: String(req.body?.html || '') }];

  const files = new Map();
  let bytes = 0;
  for (const f of raw.slice(0, MAX_PREVIEW_FILES)) {
    const p = safeEntryPath(f?.path);
    if (!p || files.has(p)) continue;
    const body = Buffer.from(String(f?.content ?? ''), 'utf8');
    bytes += body.length;
    if (bytes > MAX_PREVIEW_BYTES) {
      return res.status(413).json({ error: 'Site trop lourd pour la prévisualisation (4 Mo maximum).' });
    }
    files.set(p, body);
  }
  if (!files.size) return res.status(400).json({ error: 'Rien à prévisualiser.' });

  // Point d'entrée : index.html s'il existe, sinon la première page trouvée,
  // sinon le premier fichier — mieux vaut afficher quelque chose que rien.
  const names = [...files.keys()];
  const entry = names.find((n) => /(^|\/)index\.html?$/i.test(n))
    || names.find((n) => /\.html?$/i.test(n))
    || names[0];

  const id = 'pv_' + crypto.randomBytes(9).toString('hex');
  previews.set(id, { files, entry, at: Date.now() });
  dropStalePreviews();
  res.json({ id, url: `/api/preview/${id}/${entry}`, entry, files: names, expiresIn: PREVIEW_TTL_MS });
});

/**
 * Sert un fichier du site prévisualisé.
 *
 * La politique est reconstruite à chaque réponse parce qu'elle doit nommer notre
 * propre origine : l'iframe tourne en `sandbox` sans `allow-same-origin`, donc
 * son origine est opaque et `'self'` n'y désigne rien. Sans ça, une page ne
 * pourrait pas charger sa feuille de style voisine. Le chemin autorisé est
 * limité à ce site-ci : le reste du serveur reste hors de portée, et
 * `connect-src 'none'` interdit toujours le moindre appel réseau.
 */
app.get('/api/preview/:id/*', requireAuth, (req, res) => {
  dropStalePreviews();
  const p = previews.get(req.params.id);
  const wanted = safeEntryPath(decodeURIComponent(req.params[0] || ''));
  const body = p?.files.get(wanted) ?? (wanted ? undefined : p?.files.get(p.entry));

  const base = `${isSecureRequest(req) ? 'https' : 'http'}://${req.headers.host}/api/preview/${req.params.id}/`;
  res.setHeader('Cache-Control', 'no-store');
  // L'en-tête global est DENY : il faut le desserrer ici, sinon notre propre
  // iframe se ferait refuser par notre propre page.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; "
    + `script-src 'unsafe-inline' blob: ${base}; `
    + `style-src 'unsafe-inline' ${base}; `
    + `img-src data: blob: ${base}; media-src data: blob: ${base}; font-src data: ${base}; `
    + "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self';");

  if (body === undefined) {
    return res.status(404).type('html').send(p
      ? `<p style="font:14px system-ui;padding:24px">Fichier absent du site : <code>${
        wanted.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</code></p>`
      : '<p style="font:14px system-ui;padding:24px">Prévisualisation expirée.</p>');
  }
  res.setHeader('Content-Type', previewMime(wanted || p.entry));
  res.send(body);
});

// ---- dictée ----------------------------------------------------------------
// L'audio traverse le serveur sans être stocké : il part vers le service de
// transcription, et le texte revient. Rien à nettoyer, rien qui traîne.

const MAX_AUDIO_UPLOAD = 24 * 1024 * 1024;

app.get('/api/transcribe', requireAuth, (_req, res) => {
  const { provider, model, reason, free } = transcribeProvider();
  res.json({
    ready: Boolean(provider), provider: provider?.id || '', label: provider?.label || '',
    model, reason, free: Boolean(free),
    // Ce qui reste à brancher pour ne plus payer la dictée.
    freeOptions: freeTranscribeOptions(),
  });
});

/** Cherche un service capable de transcrire et retient le premier qui répond. */
app.post('/api/transcribe/detect', requireAuth, async (_req, res) => {
  const r = await findTranscriber({ onProgress: (m) => console.log(`  transcription : essai ${m}`) });
  res.json(r);
});

app.post('/api/transcribe',
  requireAuth,
  express.raw({ type: '*/*', limit: MAX_AUDIO_UPLOAD }),
  async (req, res) => {
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buffer.length) return res.status(400).json({ error: 'Enregistrement vide.' });

    const mime = String(req.query.type || 'audio/webm').slice(0, 60);
    const ext = (mime.split(';')[0].split('/')[1] || 'webm').replace(/[^a-z0-9]/gi, '') || 'webm';
    const r = await transcribeAudio({
      buffer, mime, filename: `dictee.${ext}`,
      language: String(req.query.lang || 'fr').slice(0, 5),
    });

    if (!r.ok) return res.status(r.needsSetup ? 409 : 502).json({ error: r.error, needsSetup: r.needsSetup });

    Usage.record({
      agent_id: null, channel_id: null, provider: r.provider, model: r.model,
      tokens_in: 0, tokens_out: 0, estimated: false, cost: r.cost,
    });
    res.json({ text: r.text, seconds: r.seconds });
  });

/**
 * Formats matriciels servis tels quels, pour qu'une image s'affiche dans la
 * conversation au lieu de se télécharger.
 *
 * La liste est courte et fermée, et SVG en est volontairement absent : un SVG
 * est un document exécutable, et le servir en ligne le ferait tourner sur
 * notre propre origine — exactement ce que la CSP existe pour empêcher.
 */
const INLINE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

app.get('/api/attachments/:id', requireAuth, (req, res) => {
  const a = Attachments.get(req.params.id);
  if (!a || !fs.existsSync(a.path)) return res.status(404).json({ error: 'not found' });

  const inline = INLINE_MIME.has(a.mime) && !req.query.download;
  res.setHeader('Content-Type', inline ? a.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`);
  // Avec nosniff, un fichier déclaré image/png qui n'en serait pas ne sera pas
  // réinterprété par le navigateur : il ne s'affichera simplement pas.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(a.path).pipe(res);
});

app.delete('/api/attachments/:id', requireAuth, (req, res) => {
  const a = Attachments.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  try { fs.unlinkSync(a.path); } catch { /* already gone */ }
  Attachments.remove(a.id);
  res.json({ ok: true });
});

// Uploads that never made it onto a message are abandoned drafts.
setInterval(() => {
  for (const a of Attachments.orphans(6 * 3600_000)) {
    try { fs.unlinkSync(a.path); } catch { /* already gone */ }
    Attachments.remove(a.id);
  }
}, 3600_000).unref();

// ---- export d'une conversation ---------------------------------------------
app.get('/api/channels/:id/export', requireAuth, (req, res) => {
  const channel = Channels.get(req.params.id);
  if (!channel) return res.status(404).json({ error: 'no channel' });

  const messages = Messages.list(channel.id, 500);
  const tasks = Tasks.list(channel.id);
  const out = [];
  out.push(`# ${channel.emoji || ''} ${channel.name}`.trim());
  if (channel.topic) out.push(`\n_${channel.topic}_`);
  out.push(`\nExporté le ${new Date().toLocaleString('fr-FR')} — ${messages.length} message(s).`);
  out.push('\n---\n');

  for (const m of messages) {
    const when = new Date(m.created_at).toLocaleString('fr-FR');
    if (m.author_type === 'system') { out.push(`> ${m.content}\n`); continue; }
    // author_name porte déjà « Toi » pour un vrai message humain — et le nom du
    // déclencheur pour ce qui est arrivé par webhook ou par le planificateur.
    out.push(`### ${m.author_emoji || ''} ${m.author_name}`.trim() + `\n<small>${when}</small>\n`);
    out.push(m.content + '\n');
  }

  if (tasks.length) {
    out.push('\n---\n\n## Tâches\n');
    for (const t of tasks) {
      const assignee = Agents.get(t.assignee_id);
      out.push(`- **${t.title}** — ${t.status}${assignee ? ` (${assignee.name})` : ''}`);
    }
  }

  const file = `${slug(channel.name) || 'salon'}-${new Date().toISOString().slice(0, 10)}.md`;
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file)}`);
  res.send(out.join('\n'));
});

// ---- déclenchements programmés ---------------------------------------------
app.get('/api/schedules', requireAuth, (req, res) => res.json({ schedules: Schedules.all() }));

app.post('/api/schedules', requireAuth, (req, res) => {
  if (!Channels.get(req.body?.channel_id)) return res.status(400).json({ error: 'salon inconnu' });
  res.json(Schedules.create(req.body || {}));
});

app.put('/api/schedules/:id', requireAuth, (req, res) => {
  const s = Schedules.update(req.params.id, req.body || {});
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s);
});

app.delete('/api/schedules/:id', requireAuth, (req, res) => {
  if (!Schedules.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

/** Fire one now, to check it does what you meant without waiting for the hour. */
app.post('/api/schedules/:id/run', requireAuth, (req, res) => {
  const s = Schedules.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const fired = runSchedule(s, 'manuel');
  res.json({ ok: fired });
});

// ---- webhooks entrants -----------------------------------------------------
app.get('/api/webhooks', requireAuth, (req, res) => res.json({
  webhooks: Webhooks.all().map((w) => ({ ...w, url: `/hook/${w.token}` })),
}));

app.post('/api/webhooks', requireAuth, (req, res) => {
  if (!Channels.get(req.body?.channel_id)) return res.status(400).json({ error: 'salon inconnu' });
  const w = Webhooks.create(req.body || {});
  res.json({ ...w, url: `/hook/${w.token}` });
});

app.put('/api/webhooks/:id', requireAuth, (req, res) => {
  const w = Webhooks.update(req.params.id, req.body || {});
  if (!w) return res.status(404).json({ error: 'not found' });
  res.json({ ...w, url: `/hook/${w.token}` });
});

app.delete('/api/webhooks/:id', requireAuth, (req, res) => {
  if (!Webhooks.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ---- sauvegarde ------------------------------------------------------------
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const KEEP_BACKUPS = 14;

/**
 * A consistent snapshot via SQLite's own backup API.
 *
 * Copying agenthub.db by hand is not enough: in WAL mode most of the recent
 * writes live in the -wal file, and on this install the main file was 4 KB
 * against a 3 MB journal. A naive copy would restore an almost empty database.
 */
async function makeBackup(reason = 'manuel') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `agenthub-${stamp}.db`);
  await db.backup(file);

  const kept = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('agenthub-') && f.endsWith('.db')).sort().reverse();
  for (const old of kept.slice(KEEP_BACKUPS)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch { /* ignore */ }
  }
  console.log(`Sauvegarde (${reason}) : ${path.basename(file)} — ${kept.length} conservée(s).`);
  return file;
}

app.get('/api/backups', requireAuth, (req, res) => {
  const list = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('agenthub-') && f.endsWith('.db'))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, bytes: st.size, at: st.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
  res.json({ backups: list, keep: KEEP_BACKUPS });
});

app.post('/api/backups', requireAuth, async (req, res) => {
  try {
    const file = await makeBackup('manuel');
    res.json({ ok: true, file: path.basename(file) });
  } catch (err) {
    console.error('backup failed:', err);
    res.status(500).json({ error: `Sauvegarde impossible : ${err.message}` });
  }
});

app.get('/api/backups/:file', requireAuth, (req, res) => {
  // basename() so a crafted name cannot walk out of the backup directory.
  const name = path.basename(String(req.params.file || ''));
  const full = path.join(BACKUP_DIR, name);
  if (!/^agenthub-[\w-]+\.db$/.test(name) || !fs.existsSync(full)) {
    return res.status(404).json({ error: 'not found' });
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  fs.createReadStream(full).pipe(res);
});

// A daily snapshot, plus one at boot so a fresh deploy always leaves a restore
// point behind before anything new touches the data.
setInterval(() => { makeBackup('quotidienne').catch((e) => console.error('backup:', e.message)); },
  24 * 3600_000).unref();
makeBackup('démarrage').catch((e) => console.error('backup:', e.message));

// Unknown API routes must 404 as JSON, not fall through to the SPA shell.
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// ---- déclencheur entrant ---------------------------------------------------
// Outside /api on purpose: the token in the path is the whole credential, so
// this route must not sit behind requireAuth, and keeping it separate makes
// that obvious rather than an oversight.
app.post('/hook/:token', express.json({ limit: '64kb' }), (req, res) => {
  const w = Webhooks.byToken(req.params.token);
  if (!w) return res.status(404).json({ error: 'not found' });
  const channel = Channels.get(w.channel_id);
  if (!channel) return res.status(410).json({ error: 'salon supprimé' });

  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > MAX_MESSAGE_CHARS) return res.status(413).json({ error: 'message trop long' });

  Webhooks.noteCall(w.id);
  const msg = Messages.create({
    channel_id: channel.id,
    author_type: 'user',
    author_name: w.label || 'Déclencheur',
    author_emoji: '🔗',
    author_color: '#8a8f83',
    content: text,
    status: 'complete',
  });
  broadcast({ type: 'message.new', message: msg });
  orchestrator.handleUserMessage(channel, text).catch((err) => console.error('webhook run:', err));
  res.json({ ok: true, channel: channel.name });
});

// ---- static frontend -------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');

// Assets are fingerprinted at boot and the shell is rewritten to point at the
// fingerprinted URLs. Without this, `max-age` served a stale app.js/styles.css
// for up to an hour after a deploy — the new build was live but invisible.
function fingerprint(file) {
  try {
    return crypto.createHash('sha1')
      .update(fs.readFileSync(path.join(PUBLIC_DIR, file))).digest('hex').slice(0, 10);
  } catch {
    return String(Date.now());
  }
}

const ASSET_V = {
  js: fingerprint('app.js'),
  css: fingerprint('styles.css'),
  i18n: fingerprint('i18n.js'),
};
const SHELL = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace('href="/styles.css"', `href="/styles.css?v=${ASSET_V.css}"`)
  .replace('src="/i18n.js"', `src="/i18n.js?v=${ASSET_V.i18n}"`)
  .replace('src="/app.js"', `src="/app.js?v=${ASSET_V.js}"`);

app.use(express.static(PUBLIC_DIR, {
  index: false,            // '/' must fall through to the versioned shell
  etag: true,
  setHeaders: (res) => {
    // A fingerprinted URL can be cached forever; a bare one must revalidate.
    res.setHeader('Cache-Control', res.req.query.v
      ? 'public, max-age=31536000, immutable'
      : 'no-cache');
  },
}));

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(SHELL);
});

// ---- websocket -------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws, req) => {
  // SameSite=Lax does not stop a cross-origin page from opening a WebSocket
  // with the session cookie attached, so the handshake is checked explicitly.
  // Without this, any site the owner visits could read the whole event stream.
  if (!sameOrigin(req)) { ws.close(4403, 'bad origin'); return; }
  if (!isAuthed(req)) { ws.close(4401, 'unauthorized'); return; }
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  ws.send(JSON.stringify({ type: 'hello', providers: providerCatalog() }));
});

// Drop half-open sockets so `clients` cannot grow without bound.
const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} clients.delete(ws); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30_000);
heartbeat.unref();

function broadcast(event) {
  const data = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(data); } catch { /* client will be reaped by the heartbeat */ }
    }
  }
}

const orchestrator = new Orchestrator(broadcast);

// ---- planificateur ---------------------------------------------------------
// A minute tick rather than a timer per schedule: schedules are edited from the
// UI at any moment, and re-arming timers on every change is where drift and
// double-fires come from.
function runSchedule(s, reason) {
  const channel = Channels.get(s.channel_id);
  if (!channel) return false;
  const prompt = String(s.prompt || '').trim();
  if (!prompt) return false;

  // Addressing the agent by mention reuses the normal routing rules rather than
  // inventing a second way to pick who answers.
  const agent = s.agent_id ? Agents.get(s.agent_id) : null;
  const text = agent ? `@${agent.name.replace(/\s+/g, '')} ${prompt}` : prompt;

  const msg = Messages.create({
    channel_id: channel.id,
    author_type: 'user',
    author_name: s.label || 'Planificateur',
    author_emoji: '⏰',
    author_color: '#8a8f83',
    content: prompt,
    status: 'complete',
  });
  broadcast({ type: 'message.new', message: msg });
  Schedules.markRun(s.id);
  console.log(`Planificateur (${reason}) : « ${s.label} » dans #${channel.name}.`);
  orchestrator.handleUserMessage(channel, text)
    .catch((err) => console.error('schedule run:', err));
  return true;
}

// ---- rafraîchissement du catalogue de modèles ------------------------------
/**
 * La liste des modèles d'un fournisseur est mise en cache au moment du test de
 * connexion, et plus rien ne la rafraîchissait.
 *
 * En production, `kimi-k3` a disparu du catalogue d'AgentRouter sans qu'aucun
 * réglage ne change : AgentHub a continué à le demander pendant des jours, et
 * la passerelle répondait « 无可用渠道 » — un message en chinois, affiché tel
 * quel à l'utilisateur. Une fois la liste à jour, resolveForAgent retombe tout
 * seul sur un modèle encore desservi.
 */
async function refreshCatalogues(reason) {
  for (const p of Providers.all()) {
    if (!p.enabled || !p.base_url) continue;
    if (p.needs_key && !p.api_key) continue;
    const before = p.models.join(',');
    const probe = await probeProvider(p);
    if (!probe.ok || !probe.models?.length) continue;
    if (probe.models.join(',') === before) continue;

    const gone = p.models.filter((m) => !probe.models.includes(m));
    Providers.setModels(p.id, probe.models, p.default_model);
    console.log(`${p.label} (${reason}) : catalogue mis à jour, ${probe.models.length} modèle(s).`);
    if (gone.length) {
      console.warn(`  modèle(s) retiré(s) par le fournisseur : ${gone.join(', ')}`);
      // Les agents pointant sur un modèle disparu basculent sur le défaut ;
      // le dire est plus utile que de les laisser échouer un par un.
      const orphans = Agents.all().filter((a) => a.provider === p.id && gone.includes(a.model));
      for (const a of orphans) {
        console.warn(`  ${a.name} utilisait ${a.model} — repli sur ${p.default_model || probe.models[0]}.`);
      }
      if (orphans.length) broadcast({ type: 'agents.reload', agents: Agents.all() });
    }
    broadcast({ type: 'providers.update', providers: providerCatalog() });
  }
}

setInterval(() => { refreshCatalogues('périodique').catch((e) => console.error('catalogue:', e.message)); },
  6 * 3600_000).unref();
// Au démarrage, mais après les sondes d'ouverture, pour ne pas doubler les appels.
setTimeout(() => { refreshCatalogues('démarrage').catch((e) => console.error('catalogue:', e.message)); },
  60_000).unref();

setInterval(() => {
  const d = new Date();
  const day = d.getDay();
  const hour = d.getHours();
  const minute = d.getMinutes();
  for (const s of Schedules.enabled()) {
    if (s.hour !== hour || s.minute !== minute) continue;
    if (!s.days.includes(day)) continue;
    // A tick can land twice in the same minute after a clock adjustment; the
    // last-run stamp is what actually guarantees one firing.
    if (Date.now() - s.last_run < 90_000) continue;
    runSchedule(s, 'programmé');
  }
}, 30_000).unref();

// ---- first-run seed --------------------------------------------------------
// Only ever runs on a genuinely empty database. The previous version wiped all
// agents, channels, messages and tasks whenever SEED_VERSION changed.
const seededProviders = seedProvidersFromEnv();
if (seededProviders) console.log(`Seeded ${seededProviders} provider(s) from the environment.`);

function seed() {
  if (Agents.count() > 0 || Channels.count() > 0) return;
  console.log('Empty database — seeding the default organisation…');

  if (!Settings.get('owner_name')) Settings.set('owner_name', process.env.OWNER_NAME || 'Patron');
  if (!Settings.get('org_name')) Settings.set('org_name', process.env.ORG_NAME || 'AgentHub');

  const hermes = Agents.create({
    name: 'Hermes', emoji: '🪽', color: '#0f9b9b', is_system: 1, rank: 'worker', title: 'Assistant direct',
    role_prompt: "Tu es Hermes, l'assistant IA principal. Réponds directement et naturellement à l'utilisateur.",
  });
  const ceo = Agents.create({
    name: 'Directeur', emoji: '🧠', color: '#3e5faf', rank: 'ceo', title: 'CEO',
    role_prompt: "Tu es le Directeur (CEO). Tu comprends l'intention de l'utilisateur, tu définis la stratégie, tu délègues aux managers des pôles concernés et tu fais la synthèse finale. Sois concis et orienté résultat.",
  });
  const mContenu = Agents.create({
    name: 'Ingrid', emoji: '🎬', color: '#c4809a', rank: 'manager', title: 'Manager Contenu',
    role_prompt: 'Tu es Ingrid, manager du pôle Contenu. Tu pilotes la production de contenu, tu répartis le travail entre tes workers et tu garantis la qualité.',
  });
  const mTech = Agents.create({
    name: 'Adonis', emoji: '🛠️', color: '#4f7cf5', rank: 'manager', title: 'Manager Technique',
    role_prompt: 'Tu es Adonis, manager du pôle Technique. Tu pilotes les sujets techniques, tu délègues aux workers et tu valides les livrables.',
  });
  const dev = Agents.create({
    name: 'Dev', emoji: '💻', color: '#5878c4', rank: 'worker', title: 'Ingénieur logiciel',
    role_prompt: 'Tu es Dev, ingénieur logiciel. Tu écris du code propre, expliques tes choix et livres des solutions concrètes.',
  });
  const chercheur = Agents.create({
    name: 'Chercheur', emoji: '🔎', color: '#2f9e63', rank: 'worker', title: 'Analyste',
    role_prompt: 'Tu es Chercheur. Tu analyses, recherches et rends des synthèses factuelles et structurées.',
  });
  const redacteur = Agents.create({
    name: 'Plume', emoji: '✍️', color: '#a87f33', rank: 'worker', title: 'Rédacteur',
    role_prompt: 'Tu es Plume, rédacteur. Tu produis des textes clairs, bien structurés, adaptés au ton demandé.',
  });
  const community = Agents.create({
    name: 'Nova', emoji: '💬', color: '#7c5cbf', rank: 'worker', title: 'Community Manager',
    role_prompt: "Tu es Nova, community manager. Tu proposes des posts, réponses et idées d'engagement adaptées à chaque réseau.",
  });

  Channels.create({ name: 'Direction', kind: 'pole', emoji: '🧭', color: '#3e5faf',
    topic: 'Pilotage global · le CEO et les managers', members: [ceo.id, mContenu.id, mTech.id] });
  Channels.create({ name: 'Contenu', kind: 'pole', emoji: '🎬', color: '#c4809a',
    topic: 'Production de contenu', members: [mContenu.id, redacteur.id, community.id] });
  Channels.create({ name: 'Technique', kind: 'pole', emoji: '🛠️', color: '#4f7cf5',
    topic: 'Développement & recherche', members: [mTech.id, dev.id, chercheur.id] });
  Channels.create({ name: 'hermes', kind: 'hermes', emoji: '🪽', color: '#0f9b9b',
    topic: 'Discussion directe avec Hermes', members: [hermes.id] });
}
seed();

const orphaned = Tasks.reconcileOrphans();
if (orphaned) console.log(`Reconciled ${orphaned} task(s) left running by a previous process.`);
const halfWritten = Messages.reconcileStreaming();
if (halfWritten) console.log(`Reconciled ${halfWritten} message(s) left mid-stream by a previous process.`);

if (!hasPassword()) {
  console.warn('⚠️  Aucun mot de passe défini : la première personne qui ouvrira l\'interface le choisira.');
  console.warn('   Ouvre l\'app maintenant pour prendre la main avant d\'exposer ce port publiquement.');
} else if (envPasswordInEffect()) {
  console.warn('⚠️  Le mot de passe ne vient que de APP_PASSWORD : rien n\'est stocké en base.');
  console.warn('   Perdre ce .env verrouillerait l\'instance définitivement — elle se sait revendiquée');
  console.warn('   mais n\'aurait plus de mot de passe à vérifier. Va dans Réglages → Mot de passe pour');
  console.warn('   l\'enregistrer en base, puis retire la variable.');
} else if (!ENV_PASSWORD && !storedHash()) {
  // Claimed, but the only credential lived in APP_PASSWORD and that variable is
  // gone. Refusing to reopen the claim is deliberate — it protects the data —
  // but it does lock the owner out, so say exactly how to get back in.
  console.error('⛔ Cette instance est marquée comme revendiquée mais ne contient aucun mot de passe.');
  console.error('   APP_PASSWORD a probablement disparu de l\'environnement. Remets-la pour te reconnecter,');
  console.error('   puis change ton mot de passe depuis Réglages afin qu\'il soit stocké en base.');
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AgentHub prêt sur :${PORT}`);
  const cat = providerCatalog();
  if (!cat.length) console.log('  aucun fournisseur — l\'assistant de configuration s\'ouvrira au premier accès');
  for (const p of cat) {
    console.log(`  ${p.enabled ? '✓' : '✗'} ${p.label.padEnd(12)} ${p.base}  [${p.models.length} modèle(s)]${p.needsKey && !p.keyConfigured ? '  (clé manquante)' : ''}`);
  }
});

// ---- graceful shutdown -----------------------------------------------------
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received — shutting down.`);
    clearInterval(heartbeat);
    for (const ws of clients) { try { ws.close(1001, 'server shutting down'); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
