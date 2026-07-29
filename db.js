import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || './data';
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'agenthub.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  emoji       TEXT NOT NULL DEFAULT '🤖',
  color       TEXT NOT NULL DEFAULT '#3e5faf',
  role_prompt TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT 'hermes-agent',
  rank        TEXT NOT NULL DEFAULT 'worker',   -- 'ceo' | 'manager' | 'worker'
  title       TEXT NOT NULL DEFAULT '',
  is_manager  INTEGER NOT NULL DEFAULT 0,
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'pole',   -- 'pole' | 'hermes'
  topic      TEXT NOT NULL DEFAULT '',
  emoji      TEXT NOT NULL DEFAULT '🗂️',
  color      TEXT NOT NULL DEFAULT '#3e5faf',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, agent_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_type  TEXT NOT NULL,
  author_id    TEXT,
  author_name  TEXT NOT NULL,
  author_emoji TEXT NOT NULL DEFAULT '',
  author_color TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL DEFAULT '',
  task_id      TEXT,
  status       TEXT NOT NULL DEFAULT 'complete',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_type_created ON messages(author_type, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  assigner_id TEXT,
  assignee_id TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  result      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Fournisseurs de modèles, configurables à chaud depuis l'UI.
-- La colonne api_key ne quitte JAMAIS le serveur : voir Providers.publicAll().
-- (Pas de backtick dans ce bloc : il vit dans un template literal JavaScript.)
CREATE TABLE IF NOT EXISTS providers (
  id             TEXT PRIMARY KEY,
  label          TEXT NOT NULL DEFAULT '',
  base_url       TEXT NOT NULL DEFAULT '',
  api_key        TEXT NOT NULL DEFAULT '',
  default_model  TEXT NOT NULL DEFAULT '',
  models         TEXT NOT NULL DEFAULT '[]',
  hint           TEXT NOT NULL DEFAULT '',
  session_header TEXT NOT NULL DEFAULT '',
  needs_key      INTEGER NOT NULL DEFAULT 1,
  enabled        INTEGER NOT NULL DEFAULT 1,
  sort           INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Second cerveau : mémoire partagée injectée dans le prompt de chaque agent.
CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);

-- Une ligne par appel modèle, pour que l'onglet Consommation dise la vérité.
CREATE TABLE IF NOT EXISTS usage_log (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT,
  channel_id TEXT,
  provider   TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  estimated  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_log(agent_id, created_at);

-- Sessions de connexion. Elles vivaient dans un Set en mémoire : chaque
-- redémarrage — donc chaque déploiement — déconnectait tout le monde, et rien
-- ne purgeait jamais les jetons émis.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Liens [[wikilien]] entre notes, recalculés à chaque enregistrement.
-- C'est ce qui donne ses arêtes à la Memory Galaxy.
CREATE TABLE IF NOT EXISTS note_links (
  from_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_id   TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_note_links_to ON note_links(to_id);

-- Un lien vers une note qui n'existe pas encore. Obsidian les affiche en
-- pointillé ; on garde la trace du titre visé pour pouvoir créer la note d'un
-- clic depuis le graphe.
CREATE TABLE IF NOT EXISTS note_stubs (
  from_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title   TEXT NOT NULL,
  PRIMARY KEY (from_id, title)
);

-- Notes proposées par les agents, en attente de validation humaine.
CREATE TABLE IF NOT EXISTS note_proposals (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '[]',
  agent_id   TEXT,
  agent_name TEXT NOT NULL DEFAULT '',
  channel_id TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected
  note_id    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON note_proposals(status, created_at);

-- Prix par modèle, en euros par million de tokens. Sans cette table la
-- consommation ne sait parler qu'en tokens, ce qui ne dit rien du budget.
CREATE TABLE IF NOT EXISTS model_prices (
  id         TEXT PRIMARY KEY,          -- provider + ':' + model
  provider   TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  in_per_m   REAL NOT NULL DEFAULT 0,
  out_per_m  REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Fichiers déposés dans un salon. Le binaire vit sur le disque, la table ne
-- garde que les métadonnées.
CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id TEXT,
  name       TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL DEFAULT '',
  bytes      INTEGER NOT NULL DEFAULT 0,
  path       TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_channel ON attachments(channel_id, created_at);

-- Déclenchements programmés : un agent lancé à heure fixe dans un salon.
CREATE TABLE IF NOT EXISTS schedules (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  agent_id   TEXT,
  prompt     TEXT NOT NULL DEFAULT '',
  hour       INTEGER NOT NULL DEFAULT 8,
  minute     INTEGER NOT NULL DEFAULT 0,
  days       TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
  enabled    INTEGER NOT NULL DEFAULT 1,
  last_run   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Déclencheurs entrants : une URL secrète qui poste un message dans un salon.
CREATE TABLE IF NOT EXISTS webhooks (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL DEFAULT '',
  token      TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  calls      INTEGER NOT NULL DEFAULT 0,
  last_call  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhooks_token ON webhooks(token);
`);

// Lightweight migrations for databases created by older versions.
for (const ddl of [
  "ALTER TABLE agents ADD COLUMN rank TEXT NOT NULL DEFAULT 'worker'",
  "ALTER TABLE agents ADD COLUMN title TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE agents ADD COLUMN provider TEXT NOT NULL DEFAULT 'hermes'",
  "ALTER TABLE channels ADD COLUMN emoji TEXT NOT NULL DEFAULT '🗂️'",
  "ALTER TABLE channels ADD COLUMN color TEXT NOT NULL DEFAULT '#3e5faf'",
  // Réglages de modèle propres à une conversation, qui priment sur ceux de l'agent.
  "ALTER TABLE channels ADD COLUMN provider_override TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE channels ADD COLUMN model_override TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE channels ADD COLUMN effort TEXT NOT NULL DEFAULT ''",
  // Le raisonnement était parsé puis jeté : llm.js exposait onReasoning que
  // personne n'appelait. On le garde à côté de la réponse.
  "ALTER TABLE messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''",
  // Trace des outils appelés pour produire ce message : sans elle, une réponse
  // fondée sur une recherche web est indiscernable d'une réponse inventée.
  "ALTER TABLE messages ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'",
  // Second cerveau : de quoi construire un graphe navigable.
  "ALTER TABLE notes ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'",
  "ALTER TABLE notes ADD COLUMN color TEXT NOT NULL DEFAULT ''",
  // Dernière fois que la note a servi — pas seulement été modifiée. C'est ce
  // que la galaxie traduit en luminosité.
  "ALTER TABLE notes ADD COLUMN touched_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE notes ADD COLUMN uses INTEGER NOT NULL DEFAULT 0",
  // Coût réel de l'appel, en euros, figé au moment où il a lieu : changer un
  // prix plus tard ne doit pas réécrire l'historique.
  "ALTER TABLE usage_log ADD COLUMN cost REAL NOT NULL DEFAULT 0",
  "ALTER TABLE usage_log ADD COLUMN priced INTEGER NOT NULL DEFAULT 0",
]) {
  try { db.exec(ddl); } catch { /* column already exists */ }
}

// Une note créée avant l'ajout de touched_at n'a jamais été « touchée » : on
// part de sa date de modification plutôt que de l'époque Unix, sinon toute la
// mémoire existante apparaîtrait éteinte dans la galaxie.
try { db.exec('UPDATE notes SET touched_at = updated_at WHERE touched_at = 0'); } catch {}

// ---- recherche plein texte -------------------------------------------------
// Tables FTS5 à contenu externe : l'index ne duplique pas le texte et suit la
// table source par rowid. Des déclencheurs le tiennent à jour — sans eux, une
// suppression laisserait le message dans les résultats de recherche.
//
// FTS5 est compilé dans better-sqlite3, mais rien ne l'impose : si la table
// virtuelle refuse de se créer, la recherche retombe sur un LIKE (voir Search).
export let FTS_OK = false;

function buildFts(tokenize) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, content='messages', content_rowid='rowid', tokenize='${tokenize}');
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      title, content, content='notes', content_rowid='rowid', tokenize='${tokenize}');

    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
      INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
    END;
  `);
}

try {
  // `remove_diacritics 2` fait correspondre « resume » et « résumé », ce qui
  // compte pour une app en français. Il demande un SQLite récent : à défaut on
  // se rabat sur le tokeniseur nu plutôt que de perdre la recherche.
  try { buildFts('unicode61 remove_diacritics 2'); }
  catch { buildFts('unicode61'); }

  // Premier démarrage après la mise à jour : la base contient déjà des
  // messages, l'index non. Les déclencheurs ne rattrapent que le futur.
  const indexed = db.prepare('SELECT COUNT(*) n FROM messages_fts').get().n;
  const stored = db.prepare('SELECT COUNT(*) n FROM messages').get().n;
  if (stored > 0 && indexed === 0) {
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    db.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");
    console.log(`Index de recherche construit sur ${stored} message(s).`);
  }
  FTS_OK = true;
} catch (err) {
  console.warn('FTS5 indisponible, la recherche utilisera LIKE :', err.message);
  FTS_OK = false;
}

export const uid = (p = '') => p + crypto.randomBytes(8).toString('hex');
export const now = () => Date.now();

// ---- validation ------------------------------------------------------------
// Everything reaching the DB is normalised here, so a malformed API payload can
// never store a bogus rank, an unbounded blob, or a colour that would be
// interpolated into a style attribute on the client.
export const RANKS = ['ceo', 'manager', 'worker'];
export const CHANNEL_KINDS = ['pole', 'hermes'];

const LIMITS = {
  name: 40, title: 60, topic: 140, emoji: 8,
  role_prompt: 4000, model: 60, content: 100000, task_title: 500, result: 8000,
  reasoning: 60000,
};

export function clampText(v, max, fallback = '') {
  if (v === undefined || v === null) return fallback;
  const s = String(v).replace(/\p{Cc}/gu, (c) => (c === '\n' || c === '\t' ? c : '')).trim();
  return s.length > max ? s.slice(0, max) : s;
}
export const validRank = (r) => (RANKS.includes(r) ? r : 'worker');
export const validKind = (k) => (CHANNEL_KINDS.includes(k) ? k : 'pole');
// Providers now live in the database, so validity is looked up rather than
// checked against a hardcoded list.
export const validProvider = (p) => {
  const id = slug(p);
  if (id && db.prepare('SELECT 1 FROM providers WHERE id=?').get(id)) return id;
  const first = db.prepare('SELECT id FROM providers WHERE enabled=1 ORDER BY sort, id LIMIT 1').get();
  return first ? first.id : 'hermes';
};
export const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
export const validColor = (c, fallback = '#3e5faf') =>
  (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || '').trim()) ? String(c).trim().toLowerCase() : fallback);
export const validEmoji = (e, fallback) => {
  const s = clampText(e, LIMITS.emoji);
  return s || fallback;
};

const rankToManager = (rank) => (rank === 'ceo' || rank === 'manager' ? 1 : 0);

// ---- Settings --------------------------------------------------------------
// The settings table doubles as the store for the app's own secrets (session
// signing key, password salt and hash), so anything that leaves the server goes
// through an allowlist. A denylist would leak the next secret someone adds.
export const PUBLIC_SETTINGS = [
  'owner_name', 'org_name', 'theme', 'setup_done',
  'daily_budget',      // seuil d'alerte de dépense, en euros
  'tools_enabled',     // les agents peuvent-ils appeler des outils
];

export const Settings = {
  get: (key, def = '') => {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return r ? r.value : def;
  },
  set: (key, value) => {
    db.prepare(`INSERT INTO settings (key,value) VALUES (?,?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
    return value;
  },
  all: () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((r) => [r.key, r.value])),

  /** The only shape allowed over HTTP or the WebSocket. */
  publicAll: () => {
    const all = Settings.all();
    return Object.fromEntries(PUBLIC_SETTINGS.filter((k) => k in all).map((k) => [k, all[k]]));
  },
};

// ---- Agents ----------------------------------------------------------------
export const Agents = {
  all: () => db.prepare(`SELECT * FROM agents ORDER BY
    CASE rank WHEN 'ceo' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, created_at ASC`).all(),
  get: (id) => db.prepare('SELECT * FROM agents WHERE id=?').get(id),
  byName: (name) => db.prepare('SELECT * FROM agents WHERE lower(name)=lower(?)').get(String(name || '')),
  count: () => db.prepare('SELECT COUNT(*) n FROM agents').get().n,

  create: (a) => {
    const id = a.id || uid('ag_');
    const rank = validRank(a.rank || (a.is_manager ? 'manager' : 'worker'));
    db.prepare(`INSERT INTO agents (id,name,emoji,color,role_prompt,model,provider,rank,title,is_manager,is_system,created_at)
                VALUES (@id,@name,@emoji,@color,@role_prompt,@model,@provider,@rank,@title,@is_manager,@is_system,@created_at)`)
      .run({
        id,
        name: clampText(a.name, LIMITS.name) || 'Agent',
        emoji: validEmoji(a.emoji, '🤖'),
        color: validColor(a.color, '#6366f1'),
        role_prompt: clampText(a.role_prompt, LIMITS.role_prompt),
        model: clampText(a.model, LIMITS.model) || 'hermes-agent',
        provider: validProvider(a.provider),
        rank,
        title: clampText(a.title, LIMITS.title),
        is_manager: rankToManager(rank),
        is_system: a.is_system ? 1 : 0,
        created_at: now(),
      });
    return Agents.get(id);
  },

  update: (id, a) => {
    const cur = Agents.get(id);
    if (!cur) return null;
    const rank = validRank(a.rank ?? cur.rank);
    db.prepare(`UPDATE agents SET name=@name, emoji=@emoji, color=@color, role_prompt=@role_prompt,
                model=@model, provider=@provider, rank=@rank, title=@title, is_manager=@is_manager WHERE id=@id`)
      .run({
        id,
        name: a.name !== undefined ? (clampText(a.name, LIMITS.name) || cur.name) : cur.name,
        emoji: a.emoji !== undefined ? validEmoji(a.emoji, cur.emoji) : cur.emoji,
        color: a.color !== undefined ? validColor(a.color, cur.color) : cur.color,
        role_prompt: a.role_prompt !== undefined ? clampText(a.role_prompt, LIMITS.role_prompt) : cur.role_prompt,
        model: a.model !== undefined ? (clampText(a.model, LIMITS.model) || cur.model) : cur.model,
        provider: a.provider !== undefined ? validProvider(a.provider) : cur.provider,
        rank,
        title: a.title !== undefined ? clampText(a.title, LIMITS.title) : cur.title,
        is_manager: rankToManager(rank),
      });
    return Agents.get(id);
  },

  // System agents are protected; the caller can tell whether anything happened.
  remove: (id) => db.prepare('DELETE FROM agents WHERE id=? AND is_system=0').run(id).changes > 0,
};

// ---- Channels (pôles) ------------------------------------------------------
// One grouped query for every channel's metadata instead of N+1 per render.
function allChannelMeta() {
  const dayAgo = now() - 86400000;
  const rows = db.prepare(`
    SELECT channel_id,
           MAX(created_at) last_activity,
           COUNT(*) msg_count,
           SUM(CASE WHEN created_at >= ? AND author_type='agent' THEN 1 ELSE 0 END) recent_count
    FROM messages GROUP BY channel_id`).all(dayAgo);
  const map = new Map();
  for (const r of rows) {
    map.set(r.channel_id, {
      last_activity: r.last_activity || null,
      msg_count: r.msg_count || 0,
      recent_count: r.recent_count || 0,
    });
  }
  return map;
}
const EMPTY_META = { last_activity: null, msg_count: 0, recent_count: 0 };

/**
 * Same figures for a single channel.
 *
 * `Channels.get()` used to call allChannelMeta(), grouping the entire messages
 * table to read one row — and the orchestrator calls it on every agent turn.
 * The index on (channel_id, created_at) makes this one bounded lookup.
 */
function channelMeta(channelId) {
  const dayAgo = now() - 86400000;
  const r = db.prepare(`
    SELECT MAX(created_at) last_activity,
           COUNT(*) msg_count,
           SUM(CASE WHEN created_at >= ? AND author_type='agent' THEN 1 ELSE 0 END) recent_count
    FROM messages WHERE channel_id = ?`).get(dayAgo, channelId);
  if (!r || !r.msg_count) return EMPTY_META;
  return {
    last_activity: r.last_activity || null,
    msg_count: r.msg_count || 0,
    recent_count: r.recent_count || 0,
  };
}

export const Channels = {
  all: () => {
    const meta = allChannelMeta();
    const members = db.prepare('SELECT channel_id, agent_id FROM channel_members').all();
    const byChannel = new Map();
    for (const m of members) {
      if (!byChannel.has(m.channel_id)) byChannel.set(m.channel_id, []);
      byChannel.get(m.channel_id).push(m.agent_id);
    }
    return db.prepare('SELECT * FROM channels ORDER BY kind DESC, created_at ASC').all()
      .map((c) => ({ ...c, members: byChannel.get(c.id) || [], ...(meta.get(c.id) || EMPTY_META) }));
  },

  get: (id) => {
    const c = db.prepare('SELECT * FROM channels WHERE id=?').get(id);
    if (!c) return null;
    return { ...c, members: Channels.memberIds(id), ...channelMeta(id) };
  },

  memberIds: (id) =>
    db.prepare('SELECT agent_id FROM channel_members WHERE channel_id=?').all(id).map((r) => r.agent_id),

  members: (id) => db.prepare(`SELECT a.* FROM channel_members m JOIN agents a ON a.id=m.agent_id
    WHERE m.channel_id=? ORDER BY CASE a.rank WHEN 'ceo' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, a.name ASC`).all(id),

  count: () => db.prepare('SELECT COUNT(*) n FROM channels').get().n,

  create: db.transaction((c) => {
    const id = c.id || uid('ch_');
    db.prepare('INSERT INTO channels (id,name,kind,topic,emoji,color,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, clampText(c.name, LIMITS.name) || 'Pôle', validKind(c.kind),
        clampText(c.topic, LIMITS.topic), validEmoji(c.emoji, '🗂️'), validColor(c.color), now());
    const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id,agent_id) VALUES (?,?)');
    for (const m of c.members || []) if (Agents.get(m)) ins.run(id, m);
    return Channels.get(id);
  }),

  update: (id, patch) => {
    const cur = db.prepare('SELECT * FROM channels WHERE id=?').get(id);
    if (!cur) return null;
    db.prepare('UPDATE channels SET name=?, topic=?, emoji=?, color=? WHERE id=?').run(
      patch.name !== undefined ? (clampText(patch.name, LIMITS.name) || cur.name) : cur.name,
      patch.topic !== undefined ? clampText(patch.topic, LIMITS.topic) : cur.topic,
      patch.emoji !== undefined ? validEmoji(patch.emoji, cur.emoji) : cur.emoji,
      patch.color !== undefined ? validColor(patch.color, cur.color) : cur.color,
      id);
    return Channels.get(id);
  },

  setMembers: db.transaction((id, memberIds) => {
    if (!db.prepare('SELECT 1 FROM channels WHERE id=?').get(id)) return null;
    db.prepare('DELETE FROM channel_members WHERE channel_id=?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id,agent_id) VALUES (?,?)');
    for (const m of memberIds || []) if (Agents.get(m)) ins.run(id, m);
    return Channels.get(id);
  }),

  /**
   * Per-conversation model settings. They take precedence over each agent's own
   * provider/model for this channel only, so you can try a stronger model on a
   * hard thread without touching your org.
   * Passing an empty provider clears the override and gives the agents back.
   */
  setModel: (id, patch) => {
    const cur = db.prepare('SELECT * FROM channels WHERE id=?').get(id);
    if (!cur) return null;
    const provider = patch.provider ? slug(patch.provider) : '';
    db.prepare('UPDATE channels SET provider_override=?, model_override=?, effort=? WHERE id=?').run(
      provider && Providers.exists(provider) ? provider : '',
      provider ? clampText(patch.model, 120) : '',
      validEffort(patch.effort),
      id);
    return Channels.get(id);
  },

  remove: (id) => db.prepare('DELETE FROM channels WHERE id=?').run(id).changes > 0,
};

export const EFFORTS = ['low', 'medium', 'high'];
export const validEffort = (e) => (EFFORTS.includes(e) ? e : '');

// ---- Messages --------------------------------------------------------------
export const Messages = {
  /**
   * The MOST RECENT `limit` messages, returned oldest-first for display.
   *
   * The previous implementation was `ORDER BY created_at ASC LIMIT n`, which
   * returns the *oldest* n rows — so any channel past the limit showed (and fed
   * the model) its opening messages forever instead of the current conversation.
   */
  list: (channelId, limit = 200) => {
    // Take the newest rows in the base table (where rowid is a valid tiebreaker
    // for messages sharing a millisecond), then flip to oldest-first in JS.
    // Ordering in an outer SELECT over a derived table cannot see rowid.
    const rows = db.prepare(
      'SELECT * FROM messages WHERE channel_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ).all(channelId, Math.max(1, Math.min(limit, 500)));
    return rows.reverse();
  },

  recent: (limit = 20) =>
    db.prepare(`SELECT * FROM messages WHERE author_type != 'user'
                ORDER BY created_at DESC LIMIT ?`).all(Math.max(1, Math.min(limit, 200))),

  get: (id) => db.prepare('SELECT * FROM messages WHERE id=?').get(id),

  create: (m) => {
    const id = m.id || uid('ms_');
    db.prepare(`INSERT INTO messages (id,channel_id,author_type,author_id,author_name,author_emoji,author_color,content,task_id,status,created_at)
                VALUES (@id,@channel_id,@author_type,@author_id,@author_name,@author_emoji,@author_color,@content,@task_id,@status,@created_at)`)
      .run({
        id,
        channel_id: m.channel_id,
        author_type: m.author_type,
        author_id: m.author_id || null,
        author_name: clampText(m.author_name, LIMITS.name) || '?',
        author_emoji: validEmoji(m.author_emoji, ''),
        author_color: m.author_color ? validColor(m.author_color, '') : '',
        content: String(m.content || '').slice(0, LIMITS.content),
        task_id: m.task_id || null,
        status: m.status || 'complete',
        created_at: now(),
      });
    return Messages.get(id);
  },

  setContent: (id, content, status) =>
    db.prepare('UPDATE messages SET content=?, status=? WHERE id=?')
      .run(String(content || '').slice(0, LIMITS.content), status || 'complete', id),

  // Kept apart from the answer: the reasoning is folded away in the UI and must
  // never be mistaken for what the agent actually said.
  setReasoning: (id, reasoning) =>
    db.prepare('UPDATE messages SET reasoning=? WHERE id=?')
      .run(String(reasoning || '').slice(0, LIMITS.reasoning), id),

  setTools: (id, calls) =>
    db.prepare('UPDATE messages SET tools=? WHERE id=?')
      .run(JSON.stringify((calls || []).slice(0, 40)), id),

  remove: (id) => db.prepare('DELETE FROM messages WHERE id=?').run(id).changes > 0,

  // Wipe a conversation. Tasks belong to the conversation too, so they go with
  // it — otherwise the rail would keep showing work with no trace of its origin.
  clearChannel: db.transaction((channelId) => {
    const messages = db.prepare('DELETE FROM messages WHERE channel_id=?').run(channelId).changes;
    const tasks = db.prepare('DELETE FROM tasks WHERE channel_id=?').run(channelId).changes;
    return { messages, tasks };
  }),

  // A message is only flipped out of 'streaming' when its run finishes. If the
  // process dies mid-stream the row stays 'streaming' forever and the client
  // renders a blinking cursor that never resolves.
  reconcileStreaming: () =>
    db.prepare(`UPDATE messages
                SET status='error',
                    content = CASE WHEN content='' THEN ? ELSE content || ? END
                WHERE status='streaming'`)
      .run('⚠️ Réponse interrompue par un redémarrage du serveur.',
        '\n\n> ⚠️ Interrompu par un redémarrage du serveur.').changes,
};

// ---- Tasks -----------------------------------------------------------------
export const Tasks = {
  list: (channelId) =>
    db.prepare('SELECT * FROM tasks WHERE channel_id=? ORDER BY created_at DESC LIMIT 100').all(channelId),
  recent: (limit = 100) =>
    db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(limit, 200))),
  get: (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id),

  create: (t) => {
    const id = t.id || uid('tk_');
    const ts = now();
    db.prepare(`INSERT INTO tasks (id,channel_id,title,assigner_id,assignee_id,status,result,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, t.channel_id, clampText(t.title, LIMITS.task_title) || 'Tâche',
        t.assigner_id || null, t.assignee_id || null, t.status || 'pending',
        String(t.result || '').slice(0, LIMITS.result), ts, ts);
    return Tasks.get(id);
  },

  update: (id, patch) => {
    const cur = Tasks.get(id);
    if (!cur) return null;
    db.prepare('UPDATE tasks SET status=?, result=?, updated_at=? WHERE id=?').run(
      patch.status ?? cur.status,
      patch.result !== undefined ? String(patch.result || '').slice(0, LIMITS.result) : cur.result,
      now(), id);
    return Tasks.get(id);
  },

  // Any task left running when the server restarts is stale, not in progress.
  reconcileOrphans: () =>
    db.prepare("UPDATE tasks SET status='failed', updated_at=? WHERE status='in_progress'").run(now()).changes,
};

// ---- Providers -------------------------------------------------------------
const parseModels = (raw) => {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((m) => typeof m === 'string').slice(0, 400) : [];
  } catch { return []; }
};

export const Providers = {
  all: () => db.prepare('SELECT * FROM providers ORDER BY sort, id').all()
    .map((p) => ({ ...p, models: parseModels(p.models) })),

  get: (id) => {
    const p = db.prepare('SELECT * FROM providers WHERE id=?').get(id);
    return p ? { ...p, models: parseModels(p.models) } : null;
  },

  count: () => db.prepare('SELECT COUNT(*) n FROM providers').get().n,
  exists: (id) => Boolean(db.prepare('SELECT 1 FROM providers WHERE id=?').get(id)),

  /** Everything the browser is allowed to know — never the key itself. */
  publicAll: () => Providers.all().map((p) => ({
    id: p.id,
    label: p.label,
    hint: p.hint,
    base: p.base_url,
    models: p.models,
    defaultModel: p.default_model,
    needsKey: Boolean(p.needs_key),
    keyConfigured: Boolean(p.api_key),
    keyHint: p.api_key ? `••••${p.api_key.slice(-4)}` : '',
    enabled: Boolean(p.enabled) && Boolean(p.base_url) && (!p.needs_key || Boolean(p.api_key)),
  })),

  upsert: (p) => {
    const id = slug(p.id);
    if (!id) return null;
    const cur = Providers.get(id);
    const ts = now();
    const row = {
      id,
      label: clampText(p.label, 60) || cur?.label || id,
      base_url: clampText(p.base_url, 300) ?? cur?.base_url ?? '',
      // An absent or empty key means "keep the existing one", so the UI can
      // save a provider without ever round-tripping the secret.
      api_key: p.api_key === undefined || p.api_key === '' ? (cur?.api_key || '') : String(p.api_key).trim().slice(0, 400),
      default_model: clampText(p.default_model, 120) ?? cur?.default_model ?? '',
      models: JSON.stringify(Array.isArray(p.models) ? p.models.filter((m) => typeof m === 'string').slice(0, 400)
        : (cur?.models || [])),
      hint: clampText(p.hint, 200) ?? cur?.hint ?? '',
      session_header: clampText(p.session_header, 60) ?? cur?.session_header ?? '',
      needs_key: p.needs_key === undefined ? (cur ? cur.needs_key : 1) : (p.needs_key ? 1 : 0),
      enabled: p.enabled === undefined ? (cur ? cur.enabled : 1) : (p.enabled ? 1 : 0),
      sort: p.sort === undefined ? (cur ? cur.sort : Providers.count()) : Number(p.sort) || 0,
      created_at: cur ? cur.created_at : ts,
      updated_at: ts,
    };
    db.prepare(`INSERT INTO providers
        (id,label,base_url,api_key,default_model,models,hint,session_header,needs_key,enabled,sort,created_at,updated_at)
      VALUES (@id,@label,@base_url,@api_key,@default_model,@models,@hint,@session_header,@needs_key,@enabled,@sort,@created_at,@updated_at)
      ON CONFLICT(id) DO UPDATE SET label=@label, base_url=@base_url, api_key=@api_key,
        default_model=@default_model, models=@models, hint=@hint, session_header=@session_header,
        needs_key=@needs_key, enabled=@enabled, sort=@sort, updated_at=@updated_at`).run(row);
    return Providers.get(id);
  },

  setModels: (id, models, defaultModel) => {
    const cur = Providers.get(id);
    if (!cur) return null;
    const list = (models || []).filter((m) => typeof m === 'string').slice(0, 400);
    db.prepare('UPDATE providers SET models=?, default_model=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(list),
        defaultModel && list.includes(defaultModel) ? defaultModel : (cur.default_model || list[0] || ''),
        now(), id);
    return Providers.get(id);
  },

  remove: (id) => {
    // Agents pointing at a removed provider fall back to whatever is left.
    const gone = db.prepare('DELETE FROM providers WHERE id=?').run(id).changes > 0;
    if (gone) {
      const fallback = db.prepare('SELECT id FROM providers WHERE enabled=1 ORDER BY sort, id LIMIT 1').get();
      if (fallback) db.prepare('UPDATE agents SET provider=? WHERE provider=?').run(fallback.id, id);
    }
    return gone;
  },
};

// ---- Notes (second cerveau) ------------------------------------------------
const NOTE_LIMITS = { title: 120, content: 8000 };
// Hard ceiling on what gets injected into a system prompt, so the shared memory
// can never crowd out the actual conversation.
export const NOTES_CONTEXT_BUDGET = 6000;
export const NOTE_KINDS = ['note', 'wiki', 'auto'];
const validNoteKind = (k) => (NOTE_KINDS.includes(k) ? k : 'note');

const parseTags = (raw) => {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((t) => typeof t === 'string' && t).slice(0, 12) : [];
  } catch { return []; }
};
const cleanTags = (tags) => {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const s = clampText(t, 24).toLowerCase().replace(/^#/, '');
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
    if (out.length >= 12) break;
  }
  return out;
};

/**
 * Pull `[[Titre]]` references out of a note body.
 * Deliberately tolerant of `[[Titre|libellé]]`: only the target matters here.
 */
export function parseWikilinks(content) {
  const out = [];
  const seen = new Set();
  const re = /\[\[([^\]|\n]{1,120})(?:\|[^\]\n]*)?\]\]/g;
  let m;
  while ((m = re.exec(String(content || ''))) !== null) {
    const title = m[1].trim();
    const key = title.toLowerCase();
    if (title && !seen.has(key)) { seen.add(key); out.push(title); }
  }
  return out;
}

// Passes the falsy value straight through rather than normalising to null:
// Notes.get() has always returned undefined for a missing row, and callers
// (and the integration test) check for exactly that.
const hydrate = (n) => (n ? { ...n, tags: parseTags(n.tags) } : n);

/**
 * Recompute one note's outgoing edges. A link whose target does not exist yet
 * is kept as a stub rather than dropped: the graph shows it hollow, and one
 * click creates the missing note — which is the whole point of writing
 * `[[Quelque chose]]` before that something exists.
 */
const reindexLinks = db.transaction((id, content) => {
  db.prepare('DELETE FROM note_links WHERE from_id=?').run(id);
  db.prepare('DELETE FROM note_stubs WHERE from_id=?').run(id);
  const insLink = db.prepare('INSERT OR IGNORE INTO note_links (from_id,to_id) VALUES (?,?)');
  const insStub = db.prepare('INSERT OR IGNORE INTO note_stubs (from_id,title) VALUES (?,?)');
  const byTitle = db.prepare('SELECT id FROM notes WHERE lower(title)=lower(?)');
  for (const title of parseWikilinks(content)) {
    const target = byTitle.get(title);
    if (target && target.id !== id) insLink.run(id, target.id);
    else if (!target) insStub.run(id, title.slice(0, 120));
  }
});

/**
 * A new note may be the target of stubs written before it existed. Turning
 * those into real edges is what makes the graph knit itself together as the
 * memory grows, instead of only ever linking forward.
 */
const resolveStubsFor = db.transaction((id, title) => {
  const rows = db.prepare('SELECT from_id FROM note_stubs WHERE lower(title)=lower(?)').all(title);
  const insLink = db.prepare('INSERT OR IGNORE INTO note_links (from_id,to_id) VALUES (?,?)');
  for (const r of rows) if (r.from_id !== id) insLink.run(r.from_id, id);
  db.prepare('DELETE FROM note_stubs WHERE lower(title)=lower(?)').run(title);
});

export const Notes = {
  all: () => db.prepare('SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC').all().map(hydrate),
  get: (id) => hydrate(db.prepare('SELECT * FROM notes WHERE id=?').get(id)),
  byTitle: (t) => hydrate(db.prepare('SELECT * FROM notes WHERE lower(title)=lower(?)').get(String(t || ''))),
  count: () => db.prepare('SELECT COUNT(*) n FROM notes').get().n,

  /** Most recently touched first — the "Récent" tab. */
  recent: (limit = 30) =>
    db.prepare('SELECT * FROM notes ORDER BY touched_at DESC, updated_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 200))).map(hydrate),

  /** Every distinct tag with how many notes carry it. */
  tags: () => {
    const counts = new Map();
    for (const n of Notes.all()) for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()].map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  },

  create: (n) => {
    const id = n.id || uid('nt_');
    const ts = now();
    const title = clampText(n.title, NOTE_LIMITS.title) || 'Sans titre';
    const content = String(n.content || '').slice(0, NOTE_LIMITS.content);
    db.prepare(`INSERT INTO notes (id,title,content,pinned,tags,kind,color,touched_at,uses,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,0,?,?)`)
      .run(id, title, content, n.pinned ? 1 : 0,
        JSON.stringify(cleanTags(n.tags)), validNoteKind(n.kind), validColor(n.color, ''), ts, ts, ts);
    reindexLinks(id, content);
    resolveStubsFor(id, title);
    return Notes.get(id);
  },

  update: (id, patch) => {
    const cur = Notes.get(id);
    if (!cur) return null;
    const title = patch.title !== undefined ? (clampText(patch.title, NOTE_LIMITS.title) || cur.title) : cur.title;
    const content = patch.content !== undefined
      ? String(patch.content || '').slice(0, NOTE_LIMITS.content) : cur.content;
    db.prepare(`UPDATE notes SET title=?, content=?, pinned=?, tags=?, kind=?, color=?,
                updated_at=?, touched_at=? WHERE id=?`).run(
      title, content,
      patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : cur.pinned,
      patch.tags !== undefined ? JSON.stringify(cleanTags(patch.tags)) : JSON.stringify(cur.tags),
      patch.kind !== undefined ? validNoteKind(patch.kind) : cur.kind,
      patch.color !== undefined ? validColor(patch.color, '') : cur.color,
      now(), now(), id);
    if (patch.content !== undefined) reindexLinks(id, content);
    // Renaming a note can satisfy stubs that were waiting on the new title.
    if (title !== cur.title) resolveStubsFor(id, title);
    return Notes.get(id);
  },

  /** Opening a note counts as using it — that is what the galaxy lights up. */
  touch: (id) => {
    db.prepare('UPDATE notes SET touched_at=?, uses=uses+1 WHERE id=?').run(now(), id);
    return Notes.get(id);
  },

  remove: (id) => db.prepare('DELETE FROM notes WHERE id=?').run(id).changes > 0,

  /**
   * Nodes and edges for the Memory Galaxy.
   * Stubs become hollow nodes with a synthetic id so the client can offer to
   * create them without inventing a shape of its own.
   */
  graph: () => {
    const notes = Notes.all();
    const nodes = notes.map((n) => ({
      id: n.id,
      title: n.title,
      kind: n.kind,
      tags: n.tags,
      color: n.color || '',
      pinned: Boolean(n.pinned),
      chars: (n.content || '').length,
      uses: n.uses,
      touched_at: n.touched_at || n.updated_at,
      updated_at: n.updated_at,
      stub: false,
    }));

    const links = db.prepare('SELECT from_id, to_id FROM note_links').all()
      .map((l) => ({ source: l.from_id, target: l.to_id }));

    // One hollow node per missing title, however many notes point at it.
    const stubs = db.prepare('SELECT from_id, title FROM note_stubs').all();
    const stubId = new Map();
    for (const s of stubs) {
      const key = s.title.toLowerCase();
      if (!stubId.has(key)) {
        const id = 'stub_' + Buffer.from(key).toString('hex').slice(0, 24);
        stubId.set(key, id);
        nodes.push({
          id, title: s.title, kind: 'stub', tags: [], color: '', pinned: false,
          chars: 0, uses: 0, touched_at: 0, updated_at: 0, stub: true,
        });
      }
      links.push({ source: s.from_id, target: stubId.get(key) });
    }

    return { nodes, links };
  },

  /** Pinned first, truncated to the context budget, for the system prompt. */
  forContext: () => {
    const out = [];
    const used = [];
    let budget = NOTES_CONTEXT_BUDGET;
    for (const n of Notes.all()) {
      if (!n.content.trim()) continue;
      const block = `### ${n.title}\n${n.content.trim()}`;
      if (block.length > budget) {
        if (budget > 200) { out.push(block.slice(0, budget) + '\n…(note tronquée)'); used.push(n.id); }
        break;
      }
      out.push(block);
      used.push(n.id);
      budget -= block.length;
    }
    // Count the injection without moving touched_at: every note reaches every
    // prompt, so bumping recency here would flatten the galaxy to one shade.
    if (used.length) {
      db.prepare(`UPDATE notes SET uses = uses + 1 WHERE id IN (${used.map(() => '?').join(',')})`).run(...used);
    }
    return out;
  },
};

// ---- Propositions de notes (second cerveau auto-alimenté) ------------------
export const NoteProposals = {
  pending: () => db.prepare("SELECT * FROM note_proposals WHERE status='pending' ORDER BY created_at DESC LIMIT 100")
    .all().map((p) => ({ ...p, tags: parseTags(p.tags) })),

  get: (id) => {
    const p = db.prepare('SELECT * FROM note_proposals WHERE id=?').get(id);
    return p ? { ...p, tags: parseTags(p.tags) } : null;
  },

  countPending: () => db.prepare("SELECT COUNT(*) n FROM note_proposals WHERE status='pending'").get().n,

  create: (p) => {
    const id = uid('np_');
    db.prepare(`INSERT INTO note_proposals (id,title,content,tags,agent_id,agent_name,channel_id,status,created_at)
                VALUES (?,?,?,?,?,?,?,'pending',?)`)
      .run(id, clampText(p.title, NOTE_LIMITS.title) || 'Sans titre',
        String(p.content || '').slice(0, NOTE_LIMITS.content),
        JSON.stringify(cleanTags(p.tags)), p.agent_id || null,
        clampText(p.agent_name, LIMITS.name), p.channel_id || null, now());
    return NoteProposals.get(id);
  },

  /** Accepting turns the proposal into a real note, in one transaction. */
  accept: db.transaction((id, patch = {}) => {
    const p = NoteProposals.get(id);
    if (!p || p.status !== 'pending') return null;
    const note = Notes.create({
      title: patch.title ?? p.title,
      content: patch.content ?? p.content,
      tags: patch.tags ?? p.tags,
      kind: 'auto',
    });
    db.prepare("UPDATE note_proposals SET status='accepted', note_id=? WHERE id=?").run(note.id, id);
    return note;
  }),

  reject: (id) => db.prepare("UPDATE note_proposals SET status='rejected' WHERE id=? AND status='pending'")
    .run(id).changes > 0,

  /**
   * Same title already proposed and still waiting, or already in memory?
   * Agents re-propose the same fact constantly; without this the queue fills
   * with duplicates and stops being reviewable.
   */
  isDuplicate: (title) => {
    const t = String(title || '');
    if (Notes.byTitle(t)) return true;
    return Boolean(db.prepare("SELECT 1 FROM note_proposals WHERE lower(title)=lower(?) AND status='pending'").get(t));
  },
};

// ---- Sessions --------------------------------------------------------------
// 30 days matches the cookie's Max-Age. The server-side row is what actually
// grants access, so an expired row invalidates a stolen cookie even if the
// browser still holds it.
export const SESSION_TTL_MS = 30 * 86400000;

export const Sessions = {
  create: (token) => {
    const ts = now();
    db.prepare('INSERT INTO sessions (token,created_at,seen_at,expires_at) VALUES (?,?,?,?)')
      .run(token, ts, ts, ts + SESSION_TTL_MS);
    return token;
  },

  /**
   * Valid only if the row exists and has not expired. `seen_at` is refreshed at
   * most once an hour: this runs on every authenticated request, and a write
   * per request would checkpoint the WAL for nothing.
   */
  valid: (token) => {
    const r = db.prepare('SELECT expires_at, seen_at FROM sessions WHERE token=?').get(token);
    if (!r) return false;
    const t = now();
    if (r.expires_at < t) { db.prepare('DELETE FROM sessions WHERE token=?').run(token); return false; }
    if (t - r.seen_at > 3600000) db.prepare('UPDATE sessions SET seen_at=? WHERE token=?').run(t, token);
    return true;
  },

  remove: (token) => db.prepare('DELETE FROM sessions WHERE token=?').run(token).changes > 0,
  clear: () => db.prepare('DELETE FROM sessions').run().changes,
  count: () => db.prepare('SELECT COUNT(*) n FROM sessions WHERE expires_at>=?').get(now()).n,
  purge: () => db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now()).changes,
};

// ---- Prix des modèles ------------------------------------------------------
// Euros par million de tokens. Rien n'est deviné : un modèle sans prix connu
// est compté à zéro et signalé comme non tarifé, plutôt que d'afficher un
// montant inventé.
export const Prices = {
  key: (provider, model) => `${slug(provider)}:${String(model || '').trim().toLowerCase()}`,

  all: () => db.prepare('SELECT * FROM model_prices ORDER BY provider, model').all(),

  get: (provider, model) =>
    db.prepare('SELECT * FROM model_prices WHERE id=?').get(Prices.key(provider, model)) || null,

  upsert: (p) => {
    const model = clampText(p.model, 120);
    if (!model) return null;
    const id = Prices.key(p.provider, model);
    db.prepare(`INSERT INTO model_prices (id,provider,model,in_per_m,out_per_m,updated_at)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET in_per_m=excluded.in_per_m,
                  out_per_m=excluded.out_per_m, updated_at=excluded.updated_at`)
      .run(id, slug(p.provider), model,
        Math.max(0, Number(p.in_per_m) || 0), Math.max(0, Number(p.out_per_m) || 0), now());

    // Rattrape les appels passés qui n'avaient AUCUN tarif.
    //
    // Ce n'est pas réécrire l'histoire : une ligne déjà tarifée garde son prix
    // d'origine (priced=1, jamais touchée). Sans ce rattrapage, renseigner ses
    // tarifs pour la première fois laisserait toute la consommation existante à
    // zéro euro, ce qui se lit comme « gratuit » et non comme « inconnu ».
    const row = db.prepare('SELECT * FROM model_prices WHERE id=?').get(id);
    const back = db.prepare(`UPDATE usage_log
      SET cost = (tokens_in / 1000000.0) * ? + (tokens_out / 1000000.0) * ?, priced = 1
      WHERE priced = 0 AND provider = ? AND lower(model) = lower(?)`)
      .run(row.in_per_m, row.out_per_m, row.provider, row.model);
    if (back.changes) console.log(`Tarif ${id} appliqué à ${back.changes} appel(s) jusqu'ici non tarifé(s).`);

    return row;
  },

  remove: (id) => db.prepare('DELETE FROM model_prices WHERE id=?').run(String(id || '')).changes > 0,

  /** Cost of one call in euros, and whether a price was actually known. */
  compute: (provider, model, tokensIn, tokensOut) => {
    const p = Prices.get(provider, model);
    if (!p) return { cost: 0, priced: false };
    const cost = (Math.max(0, tokensIn) / 1e6) * p.in_per_m
               + (Math.max(0, tokensOut) / 1e6) * p.out_per_m;
    return { cost, priced: true };
  },
};

// ---- Usage -----------------------------------------------------------------
export const Usage = {
  record: (u) => {
    const tin = Math.max(0, Math.round(u.tokens_in || 0));
    const tout = Math.max(0, Math.round(u.tokens_out || 0));
    // The price is resolved and frozen now: re-tariffing a model later must not
    // silently rewrite what past months cost.
    const { cost, priced } = Prices.compute(u.provider, u.model, tin, tout);
    db.prepare(`INSERT INTO usage_log (id,agent_id,channel_id,provider,model,tokens_in,tokens_out,estimated,cost,priced,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uid('us_'), u.agent_id || null, u.channel_id || null,
        String(u.provider || ''), String(u.model || ''), tin, tout,
        u.estimated ? 1 : 0, cost, priced ? 1 : 0, now());
  },

  summary: (sinceMs, bucketMs = 86400000) => {
    const t = now();
    const since = t - sinceMs;
    const total = db.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(tokens_in),0) tin,
        COALESCE(SUM(tokens_out),0) tout, COALESCE(MIN(estimated),1) exact,
        COALESCE(SUM(cost),0) cost, COALESCE(MIN(priced),1) allPriced
      FROM usage_log WHERE created_at>=?`).get(since);

    // Buckets are zero-filled across the whole window: a day with no traffic is
    // a real data point at zero, not a gap the curve would smooth over.
    const rows = db.prepare(`SELECT CAST(created_at / ? AS INTEGER) AS b, COUNT(*) calls,
        COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out,
        COALESCE(SUM(cost),0) cost
      FROM usage_log WHERE created_at>=? GROUP BY b`).all(bucketMs, since);
    const byBucket = new Map(rows.map((r) => [r.b, r]));

    const series = [];
    const first = Math.floor(since / bucketMs);
    const last = Math.floor(t / bucketMs);
    for (let b = first; b <= last; b++) {
      const r = byBucket.get(b);
      series.push({
        t: b * bucketMs,
        calls: r ? r.calls : 0,
        tokens_in: r ? r.tokens_in : 0,
        tokens_out: r ? r.tokens_out : 0,
        cost: r ? r.cost : 0,
      });
    }

    // How many calls ran on a model with no price on file. Surfaced so the
    // total can say "au moins X €" instead of pretending to be complete.
    const unpriced = db.prepare(
      'SELECT COUNT(*) n FROM usage_log WHERE created_at>=? AND priced=0').get(since).n;

    return {
      calls: total.calls,
      tokensIn: total.tin,
      tokensOut: total.tout,
      // Only claim exactness if every row in the window carried real counts.
      estimated: total.exact === 1,
      cost: total.cost,
      unpricedCalls: unpriced,
      fullyPriced: total.calls > 0 && unpriced === 0,
      bucketMs,
      series,
      byModel: db.prepare(`SELECT provider, model, COUNT(*) calls,
          COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out,
          COALESCE(SUM(cost),0) cost, COALESCE(MIN(priced),1) priced
        FROM usage_log WHERE created_at>=? GROUP BY provider, model
        ORDER BY (tokens_in + tokens_out) DESC`).all(since),
      byAgent: db.prepare(`SELECT agent_id, COUNT(*) calls,
          COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out,
          COALESCE(SUM(cost),0) cost
        FROM usage_log WHERE created_at>=? AND agent_id IS NOT NULL GROUP BY agent_id
        ORDER BY (tokens_in + tokens_out) DESC LIMIT 12`).all(since),
      byChannel: db.prepare(`SELECT channel_id, COUNT(*) calls,
          COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out,
          COALESCE(SUM(cost),0) cost
        FROM usage_log WHERE created_at>=? AND channel_id IS NOT NULL GROUP BY channel_id
        ORDER BY cost DESC, (tokens_in + tokens_out) DESC LIMIT 12`).all(since),
    };
  },

  /** Spend since local midnight — what a daily budget alert compares against. */
  todayCost: () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const r = db.prepare('SELECT COALESCE(SUM(cost),0) c FROM usage_log WHERE created_at>=?').get(d.getTime());
    return r.c;
  },
};

// ---- Recherche -------------------------------------------------------------
// FTS5 when it is available, LIKE otherwise. Both paths return the same shape,
// so the UI never has to know which one answered.
const FTS_SAFE = (q) => String(q || '')
  .replace(/["'*^:(){}\[\]-]/g, ' ')   // operators would turn a typo into a syntax error
  .trim().split(/\s+/).filter(Boolean).slice(0, 8)
  .map((w) => `"${w}"*`).join(' ');

export const Search = {
  run: (query, limit = 40) => {
    const q = String(query || '').trim();
    if (q.length < 2) return { messages: [], notes: [], engine: FTS_OK ? 'fts5' : 'like' };
    const n = Math.max(1, Math.min(limit, 100));

    if (FTS_OK) {
      const match = FTS_SAFE(q);
      if (match) {
        try {
          const messages = db.prepare(`
            SELECT m.id, m.channel_id, m.author_name, m.author_emoji, m.author_color,
                   m.author_type, m.created_at,
                   snippet(messages_fts, 0, '<<', '>>', '…', 18) AS excerpt
            FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
            WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?`).all(match, n);
          const notes = db.prepare(`
            SELECT nt.id, nt.title, nt.pinned, nt.updated_at,
                   snippet(notes_fts, 1, '<<', '>>', '…', 18) AS excerpt
            FROM notes_fts f JOIN notes nt ON nt.rowid = f.rowid
            WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts) LIMIT ?`).all(match, n);
          return { messages, notes, engine: 'fts5' };
        } catch { /* fall through to LIKE */ }
      }
    }

    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    const messages = db.prepare(`
      SELECT id, channel_id, author_name, author_emoji, author_color, author_type, created_at,
             substr(content, 1, 200) AS excerpt
      FROM messages WHERE content LIKE ? ESCAPE '\\'
      ORDER BY created_at DESC LIMIT ?`).all(like, n);
    const notes = db.prepare(`
      SELECT id, title, pinned, updated_at, substr(content, 1, 200) AS excerpt
      FROM notes WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
      ORDER BY updated_at DESC LIMIT ?`).all(like, like, n);
    return { messages, notes, engine: 'like' };
  },
};

// ---- Pièces jointes --------------------------------------------------------
export const Attachments = {
  list: (channelId) =>
    db.prepare('SELECT id,channel_id,message_id,name,mime,bytes,created_at FROM attachments WHERE channel_id=? ORDER BY created_at DESC LIMIT 200')
      .all(channelId),
  get: (id) => db.prepare('SELECT * FROM attachments WHERE id=?').get(id),
  forMessage: (messageId) =>
    db.prepare('SELECT id,name,mime,bytes FROM attachments WHERE message_id=?').all(messageId),

  create: (a) => {
    const id = a.id || uid('at_');
    db.prepare(`INSERT INTO attachments (id,channel_id,message_id,name,mime,bytes,path,text,created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, a.channel_id, a.message_id || null, clampText(a.name, 200) || 'fichier',
        clampText(a.mime, 100), Math.max(0, Number(a.bytes) || 0), String(a.path || ''),
        String(a.text || '').slice(0, 40000), now());
    return Attachments.get(id);
  },

  attachTo: (id, messageId) =>
    db.prepare('UPDATE attachments SET message_id=? WHERE id=?').run(messageId, id).changes > 0,

  remove: (id) => db.prepare('DELETE FROM attachments WHERE id=?').run(id).changes > 0,

  /** Uploads with no message after a grace period were abandoned mid-compose. */
  orphans: (olderThanMs) =>
    db.prepare('SELECT * FROM attachments WHERE message_id IS NULL AND created_at < ?')
      .all(now() - olderThanMs),
};

// ---- Déclenchements programmés --------------------------------------------
const parseDays = (raw) => {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.map(Number).filter((d) => d >= 0 && d <= 6) : [];
  } catch { return []; }
};
const hydrateSchedule = (s) => (s ? { ...s, days: parseDays(s.days) } : null);

export const Schedules = {
  all: () => db.prepare('SELECT * FROM schedules ORDER BY hour, minute').all().map(hydrateSchedule),
  get: (id) => hydrateSchedule(db.prepare('SELECT * FROM schedules WHERE id=?').get(id)),
  enabled: () => db.prepare('SELECT * FROM schedules WHERE enabled=1').all().map(hydrateSchedule),

  create: (s) => {
    const id = uid('sc_');
    db.prepare(`INSERT INTO schedules (id,label,channel_id,agent_id,prompt,hour,minute,days,enabled,last_run,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,0,?)`)
      .run(id, clampText(s.label, 80) || 'Sans nom', s.channel_id, s.agent_id || null,
        String(s.prompt || '').slice(0, 4000),
        Math.min(23, Math.max(0, Number(s.hour) || 0)),
        Math.min(59, Math.max(0, Number(s.minute) || 0)),
        JSON.stringify(Array.isArray(s.days) && s.days.length
          ? s.days.map(Number).filter((d) => d >= 0 && d <= 6) : [0, 1, 2, 3, 4, 5, 6]),
        s.enabled === 0 ? 0 : 1, now());
    return Schedules.get(id);
  },

  update: (id, patch) => {
    const cur = Schedules.get(id);
    if (!cur) return null;
    db.prepare(`UPDATE schedules SET label=?, channel_id=?, agent_id=?, prompt=?, hour=?, minute=?,
                days=?, enabled=? WHERE id=?`).run(
      patch.label !== undefined ? (clampText(patch.label, 80) || cur.label) : cur.label,
      patch.channel_id ?? cur.channel_id,
      patch.agent_id !== undefined ? (patch.agent_id || null) : cur.agent_id,
      patch.prompt !== undefined ? String(patch.prompt || '').slice(0, 4000) : cur.prompt,
      patch.hour !== undefined ? Math.min(23, Math.max(0, Number(patch.hour) || 0)) : cur.hour,
      patch.minute !== undefined ? Math.min(59, Math.max(0, Number(patch.minute) || 0)) : cur.minute,
      patch.days !== undefined
        ? JSON.stringify((patch.days || []).map(Number).filter((d) => d >= 0 && d <= 6))
        : JSON.stringify(cur.days),
      patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
      id);
    return Schedules.get(id);
  },

  markRun: (id) => db.prepare('UPDATE schedules SET last_run=? WHERE id=?').run(now(), id),
  remove: (id) => db.prepare('DELETE FROM schedules WHERE id=?').run(id).changes > 0,
};

// ---- Webhooks entrants -----------------------------------------------------
export const Webhooks = {
  all: () => db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all(),
  get: (id) => db.prepare('SELECT * FROM webhooks WHERE id=?').get(id),
  byToken: (token) => db.prepare('SELECT * FROM webhooks WHERE token=? AND enabled=1').get(String(token || '')),

  create: (w) => {
    const id = uid('wh_');
    db.prepare('INSERT INTO webhooks (id,label,token,channel_id,enabled,calls,last_call,created_at) VALUES (?,?,?,?,1,0,0,?)')
      .run(id, clampText(w.label, 80) || 'Déclencheur', crypto.randomBytes(24).toString('hex'), w.channel_id, now());
    return Webhooks.get(id);
  },

  update: (id, patch) => {
    const cur = Webhooks.get(id);
    if (!cur) return null;
    db.prepare('UPDATE webhooks SET label=?, enabled=? WHERE id=?').run(
      patch.label !== undefined ? (clampText(patch.label, 80) || cur.label) : cur.label,
      patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled, id);
    return Webhooks.get(id);
  },

  noteCall: (id) => db.prepare('UPDATE webhooks SET calls=calls+1, last_call=? WHERE id=?').run(now(), id),
  remove: (id) => db.prepare('DELETE FROM webhooks WHERE id=?').run(id).changes > 0,
};

// ---- Stats -----------------------------------------------------------------
export const Stats = {
  overview: () => {
    const agents = Agents.all();
    const byRank = { ceo: 0, manager: 0, worker: 0 };
    for (const a of agents) byRank[a.rank] = (byRank[a.rank] || 0) + 1;

    const channels = Channels.all();
    const poles = channels.filter((c) => c.kind === 'pole');
    const dayAgo = now() - 86400000;
    const weekAgo = now() - 7 * 86400000;

    return {
      agents: agents.length,
      byRank,
      poles: poles.length,
      activePoles: poles.filter((c) => c.members.length > 0).length,
      runs24: db.prepare('SELECT COUNT(*) n FROM tasks WHERE created_at>=?').get(dayAgo).n,
      running: db.prepare("SELECT COUNT(*) n FROM tasks WHERE status='in_progress'").get().n,
      msgs7: db.prepare("SELECT COUNT(*) n FROM messages WHERE author_type='agent' AND created_at>=?").get(weekAgo).n,
      lastActivity: db.prepare('SELECT MAX(created_at) t FROM messages').get().t || null,
    };
  },
};
