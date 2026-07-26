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
]) {
  try { db.exec(ddl); } catch { /* column already exists */ }
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
export const PUBLIC_SETTINGS = ['owner_name', 'org_name', 'theme', 'setup_done'];

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
    return { ...c, members: Channels.memberIds(id), ...(allChannelMeta().get(id) || EMPTY_META) };
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

export const Notes = {
  all: () => db.prepare('SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC').all(),
  get: (id) => db.prepare('SELECT * FROM notes WHERE id=?').get(id),
  count: () => db.prepare('SELECT COUNT(*) n FROM notes').get().n,

  create: (n) => {
    const id = n.id || uid('nt_');
    const ts = now();
    db.prepare('INSERT INTO notes (id,title,content,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, clampText(n.title, NOTE_LIMITS.title) || 'Sans titre',
        String(n.content || '').slice(0, NOTE_LIMITS.content), n.pinned ? 1 : 0, ts, ts);
    return Notes.get(id);
  },

  update: (id, patch) => {
    const cur = Notes.get(id);
    if (!cur) return null;
    db.prepare('UPDATE notes SET title=?, content=?, pinned=?, updated_at=? WHERE id=?').run(
      patch.title !== undefined ? (clampText(patch.title, NOTE_LIMITS.title) || cur.title) : cur.title,
      patch.content !== undefined ? String(patch.content || '').slice(0, NOTE_LIMITS.content) : cur.content,
      patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : cur.pinned,
      now(), id);
    return Notes.get(id);
  },

  remove: (id) => db.prepare('DELETE FROM notes WHERE id=?').run(id).changes > 0,

  /** Pinned first, truncated to the context budget, for the system prompt. */
  forContext: () => {
    const out = [];
    let budget = NOTES_CONTEXT_BUDGET;
    for (const n of Notes.all()) {
      if (!n.content.trim()) continue;
      const block = `### ${n.title}\n${n.content.trim()}`;
      if (block.length > budget) {
        if (budget > 200) out.push(block.slice(0, budget) + '\n…(note tronquée)');
        break;
      }
      out.push(block);
      budget -= block.length;
    }
    return out;
  },
};

// ---- Usage -----------------------------------------------------------------
export const Usage = {
  record: (u) => {
    db.prepare(`INSERT INTO usage_log (id,agent_id,channel_id,provider,model,tokens_in,tokens_out,estimated,created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(uid('us_'), u.agent_id || null, u.channel_id || null,
        String(u.provider || ''), String(u.model || ''),
        Math.max(0, Math.round(u.tokens_in || 0)), Math.max(0, Math.round(u.tokens_out || 0)),
        u.estimated ? 1 : 0, now());
  },

  summary: (sinceMs, bucketMs = 86400000) => {
    const t = now();
    const since = t - sinceMs;
    const total = db.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(tokens_in),0) tin,
        COALESCE(SUM(tokens_out),0) tout, COALESCE(MIN(estimated),1) exact
      FROM usage_log WHERE created_at>=?`).get(since);

    // Buckets are zero-filled across the whole window: a day with no traffic is
    // a real data point at zero, not a gap the curve would smooth over.
    const rows = db.prepare(`SELECT CAST(created_at / ? AS INTEGER) AS b, COUNT(*) calls,
        COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out
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
      });
    }

    return {
      calls: total.calls,
      tokensIn: total.tin,
      tokensOut: total.tout,
      // Only claim exactness if every row in the window carried real counts.
      estimated: total.exact === 1,
      bucketMs,
      series,
      byModel: db.prepare(`SELECT provider, model, COUNT(*) calls,
          COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out
        FROM usage_log WHERE created_at>=? GROUP BY provider, model
        ORDER BY (tokens_in + tokens_out) DESC`).all(since),
      byAgent: db.prepare(`SELECT agent_id, COUNT(*) calls,
          COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out
        FROM usage_log WHERE created_at>=? AND agent_id IS NOT NULL GROUP BY agent_id
        ORDER BY (tokens_in + tokens_out) DESC LIMIT 12`).all(since),
    };
  },
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
