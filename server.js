import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { Agents, Channels, Messages, Tasks, Settings, Stats, Notes, Usage, Providers, slug } from './db.js';
import { providerCatalog, probeProvider, seedProvidersFromEnv, PRESETS } from './llm.js';
import { Orchestrator } from './orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8090);
const PASSWORD = process.env.APP_PASSWORD || 'hermes';
const SECRET = process.env.APP_SECRET || 'change-me-secret';
const MAX_MESSAGE_CHARS = 8000;

if (SECRET === 'change-me-secret' || SECRET === 'please-change-this-secret') {
  console.warn('⚠️  APP_SECRET is still the default value — sessions are forgeable. Set AGENTHUB_SECRET.');
}

const app = express();
app.set('trust proxy', 1);          // behind Traefik
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));

// ---- tiny signed-cookie auth ----------------------------------------------
function sign(val) {
  const h = crypto.createHmac('sha256', SECRET).update(val).digest('hex');
  return `${val}.${h}`;
}
function verify(signed) {
  if (!signed || !signed.includes('.')) return false;
  const i = signed.lastIndexOf('.');
  const val = signed.slice(0, i);
  const expected = sign(val);
  // Constant-time: compare fixed-length buffers.
  const a = Buffer.from(expected);
  const b = Buffer.from(signed);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b) ? val : false;
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
const isAuthed = (req) => verify(parseCookies(req).ah_session) === 'ok';

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// Password comparison that does not leak length or content through timing.
function passwordMatches(candidate) {
  const a = crypto.createHmac('sha256', SECRET).update(String(candidate ?? '')).digest();
  const b = crypto.createHmac('sha256', SECRET).update(String(PASSWORD)).digest();
  return crypto.timingSafeEqual(a, b);
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
  const secure = req.secure ? ' Secure;' : '';
  res.setHeader('Set-Cookie',
    `ah_session=${encodeURIComponent(sign('ok'))}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=2592000`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'ah_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ authed: isAuthed(req) }));
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

// ---- state -----------------------------------------------------------------
app.get('/api/state', requireAuth, (req, res) => {
  res.json({
    agents: Agents.all(),
    channels: Channels.all(),
    settings: Settings.all(),
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

app.post('/api/setup/complete', requireAuth, (req, res) => {
  Settings.set('setup_done', '1');
  res.json({ ok: true });
});

app.post('/api/setup/reset', requireAuth, (req, res) => {
  Settings.set('setup_done', '');
  res.json({ ok: true });
});

app.get('/api/stats', requireAuth, (req, res) => res.json(Stats.overview()));
app.get('/api/settings', requireAuth, (req, res) => res.json(Settings.all()));

app.put('/api/settings', requireAuth, (req, res) => {
  const patch = req.body || {};
  const ALLOWED = ['owner_name', 'org_name', 'theme'];
  for (const [k, v] of Object.entries(patch)) {
    if (!ALLOWED.includes(k)) continue;
    if (k === 'theme' && !['light', 'dark'].includes(v)) continue;
    Settings.set(k, String(v ?? '').slice(0, 80));
  }
  const settings = Settings.all();
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

app.delete('/api/channels/:id', requireAuth, (req, res) => {
  if (!Channels.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'channel.remove', id: req.params.id });
  res.json({ ok: true });
});

app.get('/api/channels/:id/messages', requireAuth, (req, res) => {
  if (!Channels.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ messages: Messages.list(req.params.id), tasks: Tasks.list(req.params.id) });
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
  broadcast({ type: 'message.new', message: userMsg });
  res.json({ ok: true, message: userMsg });

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
app.get('/api/notes', requireAuth, (req, res) => res.json({ notes: Notes.all() }));

app.post('/api/notes', requireAuth, (req, res) => {
  const n = Notes.create(req.body || {});
  broadcast({ type: 'note.change', note: n });
  res.json(n);
});

app.put('/api/notes/:id', requireAuth, (req, res) => {
  const n = Notes.update(req.params.id, req.body || {});
  if (!n) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'note.change', note: n });
  res.json(n);
});

app.delete('/api/notes/:id', requireAuth, (req, res) => {
  if (!Notes.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'note.remove', id: req.params.id });
  res.json({ ok: true });
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

// Unknown API routes must 404 as JSON, not fall through to the SPA shell.
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

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

const ASSET_V = { js: fingerprint('app.js'), css: fingerprint('styles.css') };
const SHELL = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace('href="/styles.css"', `href="/styles.css?v=${ASSET_V.css}"`)
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

if (PASSWORD === 'hermes') {
  console.warn('⚠️  APP_PASSWORD is still the default value — set AGENTHUB_PASSWORD in .env.');
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
