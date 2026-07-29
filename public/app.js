'use strict';

/* ============================================================================
   AgentHub — SPA client
   Vanilla JS, no build step. Sections: state → utils → toasts → api → icons →
   router → renders → markdown → websocket → modals → palette → init.
   ========================================================================== */

// ============================ state =========================================
const VIEWS = ['home', 'team', 'brain', 'skills', 'usage', 'journal', 'settings'];

const S = {
  agents: [], channels: [], settings: {}, providers: [],
  stats: null, activity: [],
  notes: [], usage: null, usageRange: '7d',
  // Second cerveau : trois façons de regarder la même mémoire.
  brainTab: 'recent',       // recent | notes | graph
  brainTag: '',             // filtre par tag dans l'onglet Notes
  noteTags: [], proposals: [], graph: null, graphKey: '',
  notesBudget: 60000, notesBudgetMax: 400000, notesAuto: true,
  skills: null, skillQuery: '', skillCat: '', skillOnly: '',
  // Les calques survivent au rechargement : c'est un réglage de lecture, pas
  // un état de session, et le refaire à chaque visite serait pénible.
  graphLayers: (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('ah_layers') || 'null');
      if (Array.isArray(saved) && saved.length) return saved;
    } catch { /* valeur illisible */ }
    return ['notes', 'agents', 'channels'];
  })(),
  presets: [], setup: null, wizStep: 0, wizProvider: null,
  auth: { claimed: true, envPassword: false, minPassword: 8 },
  view: 'home',             // home | chat | team | brain | usage | journal | settings
  animatedView: null,       // last destination that played the enter animation
  current: null,            // channel id (chat view)
  messages: [], tasks: [],
  status: {},               // agentId -> idle | thinking | working
  drafts: {},               // channelId -> composer text (survives re-render)
  ws: null, wsState: 'connecting', wsTries: 0, wsTimer: null,
  loading: true,
  sidebarOpen: false, railOpen: false,
  booted: false,
  pendingFiles: [], pendingChannel: null,
  // Les notifications restent un choix explicite : la permission n'est demandée
  // qu'au clic sur la case, jamais au chargement, où elle serait refusée d'office.
  notifyOn: localStorage.getItem('ah_notify') === '1',
};

/** Notification navigateur, seulement si l'onglet n'est pas déjà sous les yeux. */
function notify(title, body) {
  if (!S.notifyOn || !document.hidden) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, tag: 'agenthub', icon: '/favicon.ico' }); } catch { /* refusé */ }
}

// ============================ tiny DOM utils ================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

// Only ever inject colors we can prove are simple hex — never raw user input.
function safeColor(hex, fallback = '#6366f1') {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(hex || '').trim()) ? String(hex).trim() : fallback;
}
function softColor(hex) {
  const c = safeColor(hex, '#3e5faf');
  const full = c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c;
  const n = parseInt(full.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},.14)`;
}

const initials = (name) => {
  const p = String(name || '?').trim().split(/\s+/);
  return ((p[0]?.[0] || '?') + (p.length > 1 ? p[1][0] || '' : '')).toUpperCase();
};

const RANK_LABEL = { ceo: 'CEO', manager: 'Manager', worker: 'Worker' };
const RANK_ORDER = { ceo: 0, manager: 1, worker: 2 };
const STATUS_LABEL = {
  pending: 'en attente', in_progress: 'en cours', done: 'terminé', failed: 'échec',
  complete: 'ok', streaming: '…', error: 'erreur',
};
const statusLabel = (s) => STATUS_LABEL[s] || s;

function agoText(ts) {
  if (!ts) return 'aucune activité';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 45) return "à l'instant";
  const m = Math.floor(s / 60); if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60); if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24); if (d < 30) return `il y a ${d} j`;
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

const poles = () => S.channels.filter((c) => c.kind === 'pole');
const agentById = (id) => S.agents.find((a) => a.id === id);
const channelById = (id) => S.channels.find((c) => c.id === id);
const byRank = (a, b) => (RANK_ORDER[a.rank] ?? 2) - (RANK_ORDER[b.rank] ?? 2);

function announce(msg) {
  const live = $('#live');
  if (!live) return;
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 30);
}

// ============================ toasts ========================================
function toast(text, opts = {}) {
  const { kind = 'info', title = '', timeout = kind === 'error' ? 7000 : 4000 } = opts;
  const box = $('#toasts');
  if (!box) return;
  const t = el('div', `toast ${kind}`);
  t.innerHTML = `
    <div class="toast-body">
      ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ''}
      <div class="toast-text">${escapeHtml(text)}</div>
    </div>
    <button class="toast-close" type="button" aria-label="Fermer">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`;
  const close = () => {
    if (!t.isConnected) return;
    t.classList.add('out');
    setTimeout(() => t.remove(), 220);
  };
  t.querySelector('.toast-close').onclick = close;
  box.appendChild(t);
  if (timeout) setTimeout(close, timeout);
  if (kind === 'error') announce(text);
}

// ============================ api ===========================================
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(url, opts);
  } catch {
    throw new ApiError('Serveur injoignable — vérifie ta connexion.', 0);
  }
  if (r.status === 401) { showLogin(); throw new ApiError('Session expirée.', 401); }

  let data = null;
  try { data = await r.json(); } catch { /* empty or non-JSON body */ }
  if (!r.ok) throw new ApiError((data && data.error) || `Erreur ${r.status}`, r.status);
  return data;
}

// Wrap an api call so failures surface as a toast instead of a silent console error.
async function tryApi(promise, fallbackMsg) {
  try { return await promise; }
  catch (err) {
    if (err.status !== 401) toast(err.message || fallbackMsg, { kind: 'error', title: fallbackMsg });
    return null;
  }
}

// ============================ icons =========================================
// 1.75 rather than 2: a finer hairline reads calmer at these sizes.
const svg = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

// The brand mark — an open ensō carrying a centre node and three agent nodes.
const MARK = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <path d="M40.74 21.05A17 17 0 1 1 34.93 10.98" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
  <path d="M24 16v-5.5M30.93 28l4.76 2.75M17.07 28l-4.76 2.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".5"/>
  <circle cx="24" cy="24" r="4.6" fill="currentColor"/>
  <circle cx="24" cy="7" r="3.6" fill="currentColor"/>
  <circle cx="38.72" cy="32.5" r="3.6" fill="currentColor"/>
  <circle cx="9.28" cy="32.5" r="3.6" fill="currentColor"/>
</svg>`;

const IC = {
  dashboard: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>'),
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5"/><path d="M9.5 21v-6h5v6"/>'),
  note: svg('<path d="M4 4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>'),
  pin: svg('<path d="M12 17v5"/><path d="M9 3h6l-1 7 3 3v2H7v-2l3-3Z"/>'),
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  spark: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>'),
  team: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  brain: svg('<path d="M12 5a3 3 0 0 0-5.9-.6A3 3 0 0 0 4 9a3 3 0 0 0 .5 4.5A3 3 0 0 0 8 19a3 3 0 0 0 4 1 3 3 0 0 0 4-1 3 3 0 0 0 3.5-5.5A3 3 0 0 0 20 9a3 3 0 0 0-2.1-4.6A3 3 0 0 0 12 5Z"/><path d="M12 5v15"/>'),
  access: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>'),
  moon: svg('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
  menu: svg('<path d="M3 6h18M3 12h18M3 18h18"/>'),
  chev: svg('<path d="m9 18 6-6-6-6"/>'),
  down: svg('<path d="M12 5v14M19 12l-7 7-7-7"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  send: svg('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  agents: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>'),
  poles: svg('<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>'),
  bolt: svg('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>'),
  chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>'),
  tokens: svg('<path d="M3 3v18h18"/><path d="m7 15 3-4 3 2 4-6"/>'),
  journal: svg('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  tasks: svg('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  edit: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  download: svg('<path d="M12 4v10m0 0 4-4m-4 4-4-4"/><path d="M5 18h14"/>'),
  clip: svg('<path d="M20 11.5 12.3 19a4.6 4.6 0 0 1-6.5-6.5l7.9-7.9a3 3 0 0 1 4.3 4.3l-7.9 7.9a1.5 1.5 0 0 1-2.1-2.1l7.2-7.2"/>'),
  trash: svg('<path d="M4 7h16M9 7V5h6v2M6 7l1 12h10l1-12"/>'),
  graph: svg('<circle cx="6" cy="7" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="12" cy="17" r="2.4"/><path d="M8 8.4 10.6 15M16.2 8 13.4 15.2M8.3 6.6l7.4-.4"/>'),
  galaxy: svg('<circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="12" rx="9.5" ry="4" transform="rotate(-22 12 12)"/><circle cx="19" cy="8.6" r=".9" fill="currentColor"/><circle cx="5.2" cy="15.6" r=".9" fill="currentColor"/>'),
  broom: svg('<path d="M3 21h18"/><path d="M8 21v-4a4 4 0 0 1 8 0v4"/><path d="M12 13V3"/><path d="M9 6h6"/>'),
};

// ============================ auth ==========================================
/**
 * The card is rendered rather than hardcoded because it has two faces: on a
 * brand-new install nobody has a password yet, so the first visitor *creates*
 * one instead of being asked for it. No configuration file involved.
 */
function renderAuthCard() {
  const claim = !S.auth.claimed;
  $('#login-form').innerHTML = `
    <span class="login-logo" aria-hidden="true">${MARK}</span>
    <h1>AgentHub</h1>
    <p class="muted">${claim ? 'Choisis ton mot de passe pour prendre la main.' : "Ton organisation d'agents"}</p>

    <label for="login-password" class="sr-only">Mot de passe</label>
    <input type="password" id="login-password" name="password" required
           placeholder="${claim ? 'Nouveau mot de passe' : 'Mot de passe'}"
           autocomplete="${claim ? 'new-password' : 'current-password'}"
           ${claim ? `minlength="${S.auth.minPassword}"` : ''}>

    ${claim ? `
      <label for="login-confirm" class="sr-only">Confirmer le mot de passe</label>
      <input type="password" id="login-confirm" name="confirm" required
             placeholder="Confirme le mot de passe" autocomplete="new-password">
      <p class="login-hint">${S.auth.minPassword} caractères minimum. Il n'y a pas de
        récupération : note-le quelque part.</p>` : ''}

    <button type="submit" id="login-submit">${claim ? 'Créer mon accès' : 'Entrer'}</button>
    <div id="login-error" class="login-error" role="alert" aria-live="assertive"></div>
    <div class="login-seal">藍 · ai</div>`;
}

function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
  S.booted = false;
  if (S.ws) { try { S.ws.close(1000, 'logout'); } catch {} S.ws = null; }
  clearTimeout(S.wsTimer);
  renderAuthCard();
  setTimeout(() => $('#login-password')?.focus(), 40);
}

function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const claim = !S.auth.claimed;
  const btn = $('#login-submit');
  const input = $('#login-password');
  const confirm = $('#login-confirm');
  const errBox = $('#login-error');
  errBox.textContent = '';

  if (claim) {
    if (input.value.length < S.auth.minPassword) {
      errBox.textContent = `Au moins ${S.auth.minPassword} caractères.`;
      return;
    }
    if (input.value !== confirm.value) {
      errBox.textContent = 'Les deux mots de passe ne correspondent pas.';
      confirm.select();
      return;
    }
  }

  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = claim ? 'Création…' : 'Connexion…';
  try {
    const r = await fetch(claim ? '/api/claim' : '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
    });
    if (r.ok) {
      input.value = '';
      if (confirm) confirm.value = '';
      S.auth.claimed = true;
      showApp();
      await boot();
      if (claim) toast('Accès créé. Ton mot de passe est enregistré.', { kind: 'success' });
      return;
    }
    if (r.status === 429) errBox.textContent = 'Trop de tentatives. Réessaie dans un instant.';
    else if (r.status === 409) {
      // Someone claimed it between our check and this submit.
      errBox.textContent = 'Cette instance vient d\'être configurée. Recharge la page.';
      S.auth.claimed = true;
    } else if (claim) {
      const d = await r.json().catch(() => ({}));
      errBox.textContent = d.error || 'Création impossible.';
    } else {
      errBox.textContent = 'Mot de passe incorrect';
      input.select();
    }
  } catch {
    errBox.textContent = 'Serveur injoignable.';
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

// ============================ boot ==========================================
async function boot() {
  S.loading = true;
  renderAll();
  try {
    const st = await api('GET', '/api/state');
    S.agents = st.agents || [];
    S.channels = st.channels || [];
    S.settings = st.settings || {};
    S.providers = st.providers || [];
  } catch (err) {
    if (err.status === 401) return;
    toast(err.message, { kind: 'error', title: 'Chargement impossible' });
  }
  S.loading = false;
  S.booted = true;

  applyTheme(localStorage.getItem('ah_theme') || S.settings.theme || 'light');
  applyRoute(location.hash, { silent: true });
  renderAll();
  connectWS();
  refreshDashboard();
  loadNotes();          // the brain feeds every agent, so keep it warm
  loadForView();

  // Presets drive the "connect a service" cards; setup decides whether the
  // welcome wizard opens.
  const cat = await tryApi(api('GET', '/api/providers'), 'Fournisseurs');
  if (cat) { S.providers = cat.providers; S.presets = cat.presets || []; }
  checkSetup();
}

async function refreshDashboard() {
  try {
    const [stats, act] = await Promise.all([api('GET', '/api/stats'), api('GET', '/api/activity')]);
    S.stats = stats;
    S.activity = (act && act.feed) || [];
    if (S.view === 'home' || S.view === 'journal') renderView();
  } catch { /* best effort */ }
}

async function loadNotes() {
  const r = await tryApi(api('GET', '/api/notes'), 'Chargement des notes');
  if (!r) return;
  S.notes = r.notes || [];
  S.noteTags = r.tags || [];
  if (r.budget) S.notesBudget = r.budget;
  if (r.budgetMax) S.notesBudgetMax = r.budgetMax;
  S.notesAuto = r.autoAccept !== false;
  if (S.view === 'brain') renderView();
}

async function loadProposals() {
  const r = await tryApi(api('GET', '/api/notes/proposals'), 'Chargement des propositions');
  if (!r) return;
  S.proposals = r.proposals || [];
  if (S.view === 'brain') renderView();
}

/**
 * The graph is fetched separately from the note list: it carries the stub nodes
 * and every edge, which the notes payload has no reason to duplicate.
 * Layer selection happens server-side so an unwanted family is never sent.
 */
async function loadGraph(force = false) {
  const key = S.graphLayers.join(',');
  if (S.graph && S.graphKey === key && !force) return S.graph;
  const r = await tryApi(api('GET', `/api/notes/graph?layers=${encodeURIComponent(key)}`), 'Chargement du graphe');
  if (!r) return null;
  S.graph = r;
  S.graphKey = key;
  return r;
}

async function loadUsage() {
  if (S.view === 'usage') { S.usage = null; renderView(); }
  const r = await tryApi(api('GET', `/api/usage?range=${encodeURIComponent(S.usageRange)}`), 'Chargement de la consommation');
  if (!r) return;
  S.usage = r;
  if (S.view === 'usage') renderView();
}

// ============================ router ========================================
// Hash routes keep the current view across reloads and enable deep links.
function routeOf() {
  if (S.view === 'chat' && S.current) return `#/c/${S.current}`;
  return `#/${S.view}`;
}
function navigate(view, channelId, opts = {}) {
  S.view = view;
  if (channelId) S.current = channelId;
  S.sidebarOpen = false;
  const hash = routeOf();
  if (location.hash !== hash && !opts.fromRoute) {
    history.pushState(null, '', hash);
  }
  // Light update: the sidebar keeps its DOM so the indicator can glide.
  syncNavState();
  renderTopbar();
  renderView();
  renderScrim();
  loadForView();
}

// Each destination pulls exactly the data it needs, on arrival.
function loadForView() {
  if (S.view === 'home' || S.view === 'journal') refreshDashboard();
  else if (S.view === 'brain') { loadNotes(); loadProposals(); }
  else if (S.view === 'skills') loadSkills();
  else if (S.view === 'usage') loadUsage();
}
function applyRoute(hash, opts = {}) {
  const m = /^#\/c\/([\w-]+)$/.exec(hash || '');
  if (m && channelById(m[1])) {
    S.view = 'chat';
    S.current = m[1];
    if (!opts.silent) openChannel(m[1], { fromRoute: true });
    return;
  }
  const v = (hash || '').replace(/^#\//, '');
  S.view = VIEWS.includes(v) ? v : 'home';
}
window.addEventListener('popstate', () => {
  if (!S.booted) return;
  const m = /^#\/c\/([\w-]+)$/.exec(location.hash || '');
  if (m && channelById(m[1])) { openChannel(m[1], { fromRoute: true }); return; }
  applyRoute(location.hash, { silent: true });
  renderAll();
  loadForView();
});

async function openChannel(id, opts = {}) {
  const c = channelById(id);
  if (!c) { toast('Salon introuvable.', { kind: 'error' }); return; }
  S.view = 'chat';
  S.current = id;
  S.sidebarOpen = false;
  if (!opts.fromRoute && location.hash !== `#/c/${id}`) history.pushState(null, '', `#/c/${id}`);
  S.messages = []; S.tasks = [];
  syncNavState(); renderTopbar(); renderView();

  const data = await tryApi(api('GET', `/api/channels/${id}/messages`), 'Chargement du salon');
  if (!data || S.current !== id) return;
  S.messages = data.messages || [];
  S.tasks = data.tasks || [];
  renderView();
  scrollToBottom(true);
}

// ============================ render root ===================================
function renderAll() { renderSidebar(); renderTopbar(); renderView(); renderScrim(); }

function renderScrim() {
  const existing = $('#scrim');
  const need = S.sidebarOpen || S.railOpen;
  if (need && !existing) {
    const s = el('div', 'scrim');
    s.id = 'scrim';
    s.onclick = () => { S.sidebarOpen = false; S.railOpen = false; renderAll(); };
    document.body.appendChild(s);
  } else if (!need && existing) {
    existing.remove();
  }
}

// ---- Sidebar ---------------------------------------------------------------
function renderSidebar() {
  const sb = $('#sidebar');
  if (!sb) return;
  const owner = S.settings.owner_name || 'Patron';
  const org = S.settings.org_name || 'AgentHub';
  const pl = poles();
  const team = S.agents;
  const shown = team.slice(0, 7);
  const overflow = team.length - shown.length;

  sb.classList.toggle('open', S.sidebarOpen);
  sb.innerHTML = `
    <div class="brand">
      <span class="brand-logo" aria-hidden="true">${MARK}</span>
      <div class="brand-text">
        <div class="brand-name">${escapeHtml(org)}</div>
        <div class="brand-sub">${escapeHtml(owner)}</div>
      </div>
    </div>

    <div class="side-label" id="lbl-poles">Pôles</div>
    <div class="avatar-row" role="group" aria-labelledby="lbl-poles">
      ${pl.map((c) => `
        <button class="av square" data-pole="${escapeAttr(c.id)}" type="button"
                title="${escapeAttr(c.name)}" aria-label="Ouvrir le pôle ${escapeAttr(c.name)}"
                style="background:${softColor(c.color)};color:${safeColor(c.color, '#3e5faf')};font-size:15px">${escapeHtml(c.emoji || '#')}</button>`).join('')}
      <button class="av-add" id="add-pole" type="button" aria-label="Créer un pôle" title="Créer un pôle">+</button>
    </div>

    <div class="side-label" id="lbl-team">Ton équipe · ${team.length}</div>
    <div class="avatar-row" role="group" aria-labelledby="lbl-team">
      ${shown.map((a) => avatarHTML(a, { status: true, button: true, label: `Modifier ${a.name}` })).join('')}
      ${overflow > 0 ? `<button class="av-more" data-nav="team" type="button" aria-label="Voir les ${team.length} agents">+${overflow}</button>` : ''}
      <button class="av-add" id="add-agent-side" type="button" aria-label="Créer un agent" title="Créer un agent">+</button>
    </div>

    <div class="side-label">Navigation</div>
    <nav class="nav" aria-label="Sections">
      <span class="nav-indicator" aria-hidden="true"></span>
      ${navItem('home', IC.home, 'Accueil')}
      ${navItem('team', IC.team, 'Mon équipe')}
      ${navItem('brain', IC.brain, 'Second cerveau')}
      ${navItem('skills', IC.spark, 'Skills')}
      ${navItem('usage', IC.tokens, 'Consommation')}
      ${navItem('journal', IC.journal, 'Journal')}
      ${navItem('settings', IC.access, 'Réglages')}
    </nav>

    <div class="side-label">Channels</div>
    <div class="chan-list">
      ${S.channels.map((c) => {
        const active = S.view === 'chat' && S.current === c.id;
        const busy = c.members.some((id) => (S.status[id] || 'idle') !== 'idle');
        return `
        <button class="chan-item ${active ? 'active' : ''}" data-chan="${escapeAttr(c.id)}" type="button"
                ${active ? 'aria-current="page"' : ''}>
          <span class="chan-dot" style="background:${safeColor(c.color, '#3e5faf')}"></span>
          <span class="chan-name">${c.kind === 'hermes' ? escapeHtml(c.name) : 'Pôle ' + escapeHtml(c.name)}</span>
          ${busy ? '<span class="chan-live" title="Un agent travaille"></span>' : ''}
          ${c.recent_count ? `<span class="chan-badge">${c.recent_count}</span>` : ''}
        </button>`;
      }).join('')}
    </div>

    <div class="side-foot">
      <div class="conn ${S.wsState}">
        <span class="conn-dot"></span>
        <span>${S.wsState === 'online' ? 'Temps réel actif' : S.wsState === 'offline' ? 'Reconnexion…' : 'Connexion…'}</span>
      </div>
    </div>`;

  $$('[data-pole]', sb).forEach((n) => n.onclick = () => openChannel(n.dataset.pole));
  $$('[data-agent]', sb).forEach((n) => n.onclick = () => openAgentModal(agentById(n.dataset.agent)));
  $$('[data-chan]', sb).forEach((n) => n.onclick = () => openChannel(n.dataset.chan));
  $$('[data-nav]', sb).forEach((n) => n.onclick = () => navigate(n.dataset.nav));
  $$('.nav-item', sb).forEach((n) => n.onclick = () => navigate(n.dataset.view));
  $('#add-pole', sb).onclick = () => openPoleModal(null);
  $('#add-agent-side', sb).onclick = () => openAgentModal(null);

  // The markup was just recreated: place the pill without animating it.
  syncNavState(true);
}

const navItem = (view, icon, label) =>
  `<button class="nav-item ${S.view === view ? 'active' : ''}" data-view="${view}" type="button"
           ${S.view === view ? 'aria-current="page"' : ''}>${icon}<span>${label}</span></button>`;

/**
 * Move the sliding indicator and re-flag the active entries WITHOUT rebuilding
 * the sidebar — a freshly created element cannot animate from a previous state.
 * `instant` is used right after a full render, so the pill does not fly in from
 * the top of the list.
 */
function syncNavState(instant = false) {
  const sb = $('#sidebar');
  if (!sb) return;
  sb.classList.toggle('open', S.sidebarOpen);

  $$('.nav-item', sb).forEach((n) => {
    const on = n.dataset.view === S.view;
    n.classList.toggle('active', on);
    if (on) n.setAttribute('aria-current', 'page');
    else n.removeAttribute('aria-current');
  });
  $$('.chan-item', sb).forEach((n) => {
    const on = S.view === 'chat' && n.dataset.chan === S.current;
    n.classList.toggle('active', on);
    if (on) n.setAttribute('aria-current', 'page');
    else n.removeAttribute('aria-current');
  });

  const ind = $('.nav-indicator', sb);
  if (!ind) return;
  const active = sb.querySelector('.nav-item.active');
  if (instant) ind.classList.add('no-anim');
  if (active) {
    ind.style.height = `${active.offsetHeight}px`;
    ind.style.transform = `translateY(${active.offsetTop}px)`;
    ind.style.opacity = '1';
  } else {
    // Chat view: no nav entry owns the pill, so it fades out in place.
    ind.style.opacity = '0';
  }
  if (instant) {
    void ind.offsetHeight;          // commit the jump before re-enabling motion
    ind.classList.remove('no-anim');
  }
}

const STATUS_TEXT = { idle: 'disponible', thinking: 'réfléchit', working: 'travaille' };

function avatarHTML(agent, opts = {}) {
  const size = opts.size || 34;
  const st = S.status[agent.id] || 'idle';
  const color = safeColor(agent.color);
  // The dot is colour-only, so the status is also spelled out in the title and
  // the accessible name — never conveyed by colour alone.
  const dot = opts.status
    ? `<span class="dot ${st}" data-status-for="${escapeAttr(agent.id)}"></span>` : '';
  const label = opts.status ? `${agent.name} — ${STATUS_TEXT[st]}` : agent.name;
  const style = `width:${size}px;height:${size}px;background:${color};font-size:${Math.round(size * 0.38)}px`;
  if (opts.button) {
    return `<button class="av" type="button" data-agent="${escapeAttr(agent.id)}" style="${style}"
             data-label-for="${escapeAttr(agent.id)}" title="${escapeAttr(label)}"
             aria-label="${escapeAttr(opts.label ? opts.label + ' — ' + STATUS_TEXT[st] : label)}">${escapeHtml(initials(agent.name))}${dot}</button>`;
  }
  return `<span class="av" style="${style}" data-label-for="${escapeAttr(agent.id)}"
           title="${escapeAttr(label)}">${escapeHtml(initials(agent.name))}${dot}</span>`;
}

// Surgical status update — avoids re-rendering the whole sidebar on every tick.
function applyStatusDots(agentId) {
  const st = S.status[agentId] || 'idle';
  const agent = agentById(agentId);
  $$(`[data-status-for="${CSS.escape(agentId)}"]`).forEach((d) => { d.className = `dot ${st}`; });
  if (!agent) return;
  $$(`[data-label-for="${CSS.escape(agentId)}"]`).forEach((n) => {
    n.title = `${agent.name} — ${STATUS_TEXT[st]}`;
  });
}

// ---- Topbar ----------------------------------------------------------------
function renderTopbar() {
  const bar = $('#topbar');
  if (!bar) return;
  const c = channelById(S.current);
  const crumb = {
    home: 'Accueil', chat: c ? c.name : 'Salon', team: 'Mon équipe',
    brain: 'Second cerveau', usage: 'Consommation', journal: 'Journal', settings: 'Réglages',
  }[S.view] || '';
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';

  bar.innerHTML = `
    <div class="crumb">
      <button class="icon-btn burger" id="burger" type="button" aria-label="Ouvrir le menu" aria-expanded="${S.sidebarOpen}">${IC.menu}</button>
      <span>${escapeHtml(crumb)}</span>
    </div>
    <div class="topbar-spacer"></div>
    <button class="search" id="open-search" type="button" aria-label="Rechercher (Ctrl K)">
      ${IC.search}<span>Rechercher un agent, un pôle…</span><kbd>Ctrl K</kbd>
    </button>
    ${S.view === 'chat' ? `<button class="icon-btn" id="open-rail" type="button" aria-label="Voir les tâches" title="Tâches">${IC.tasks}</button>` : ''}
    <button class="icon-btn" id="theme-toggle" type="button"
            aria-label="${dark ? 'Passer en clair' : 'Passer en sombre'}">${dark ? IC.sun : IC.moon}</button>`;

  $('#burger', bar).onclick = () => { S.sidebarOpen = !S.sidebarOpen; renderSidebar(); renderTopbar(); renderScrim(); };
  $('#open-search', bar).onclick = openPalette;
  const rail = $('#open-rail', bar);
  if (rail) rail.onclick = () => { S.railOpen = !S.railOpen; renderView(); renderScrim(); };
  $('#theme-toggle', bar).onclick = () => {
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('ah_theme', next);
    tryApi(api('PUT', '/api/settings', { theme: next }), 'Thème');
    renderTopbar();
  };
}

// ============================ views =========================================
function renderView() {
  const v = $('#view');
  if (!v) return;

  // Replay the enter animation only when the destination really changed — this
  // function also runs on every agent-status tick, which would otherwise make
  // the whole page flicker while agents work.
  const key = S.view === 'chat' ? `chat:${S.current}` : S.view;
  if (key !== S.animatedView) {
    S.animatedView = key;
    v.classList.remove('view-enter');
    void v.offsetWidth;                 // restart the CSS animation
    v.classList.add('view-enter');
  }

  // The galaxy runs a rAF loop against its own canvas: leaving the brain view
  // without stopping it would repaint a detached node for the rest of the session.
  if (S.view !== 'brain') destroyGalaxy();

  if (S.loading) return renderSkeleton(v);
  if (S.view === 'chat') return renderChat(v);
  if (S.view === 'team') return renderTeam(v);
  if (S.view === 'brain') return renderBrain(v);
  if (S.view === 'skills') return renderSkills(v);
  if (S.view === 'usage') return renderUsage(v);
  if (S.view === 'journal') return renderJournal(v);
  if (S.view === 'settings') return renderSettings(v);
  return renderHome(v);
}

function renderSkeleton(v) {
  v.innerHTML = `<div class="dash">
    <div class="sk sk-line" style="width:220px;height:34px;margin-bottom:18px"></div>
    <div class="sk sk-line" style="width:320px;margin-bottom:28px"></div>
    <div class="stat-grid">${'<div class="sk sk-stat"></div>'.repeat(4)}</div>
    <div class="pole-grid">${'<div class="sk sk-stat" style="height:78px"></div>'.repeat(2)}</div>
  </div>`;
}

// ---- Accueil ---------------------------------------------------------------
function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Bonne nuit';
  if (h < 12) return 'Bonjour';
  if (h < 18) return 'Bon après-midi';
  return 'Bonsoir';
}

// One honest sentence about the state of the organisation, right now.
function orgMood() {
  const busy = S.agents.filter((a) => (S.status[a.id] || 'idle') !== 'idle');
  if (busy.length === 1) return `${busy[0].name} travaille en ce moment.`;
  if (busy.length > 1) return `${busy.length} agents travaillent en ce moment.`;
  const s = S.stats;
  if (!s || !s.lastActivity) return "Ton organisation est prête. Personne n'a encore rien produit.";
  if (s.msgs7 === 0) return `Rien ne tourne. Dernière activité ${agoText(s.lastActivity)}.`;
  return `Tout est calme. ${s.msgs7} réponse${s.msgs7 > 1 ? 's' : ''} produite${s.msgs7 > 1 ? 's' : ''} cette semaine, dernière ${agoText(s.lastActivity)}.`;
}

// The pôle you were last in — the single most useful thing on arrival.
function lastActivePole() {
  return [...poles()]
    .filter((c) => c.last_activity)
    .sort((a, b) => b.last_activity - a.last_activity)[0] || null;
}

function renderHome(v) {
  const owner = S.settings.owner_name || 'Patron';
  const s = S.stats;
  const rank = s ? s.byRank : { ceo: 0, manager: 0, worker: 0 };
  const resume = lastActivePole();
  const hermesChannel = S.channels.find((c) => c.kind === 'hermes');

  v.innerHTML = `
    <div class="hero">
      <div class="hero-inner">
        <p class="hero-eyebrow">${escapeHtml(S.settings.org_name || 'AgentHub')}</p>
        <h1 class="hero-title">${greeting()} ${escapeHtml(owner)}.</h1>
        <p class="hero-sub">${escapeHtml(orgMood())}</p>

        <div class="quick-row">
          ${resume ? `
            <button class="quick primary-quick" data-pole-open="${escapeAttr(resume.id)}" type="button">
              <span class="quick-ic" style="background:${softColor(resume.color)};color:${safeColor(resume.color, '#3e5faf')}">${escapeHtml(resume.emoji || '#')}</span>
              <span class="quick-main">
                <span class="quick-label">Reprendre</span>
                <span class="quick-title">Pôle ${escapeHtml(resume.name)}</span>
              </span>
              <span class="quick-go">${IC.arrow}</span>
            </button>` : ''}
          ${hermesChannel ? `
            <button class="quick" data-pole-open="${escapeAttr(hermesChannel.id)}" type="button">
              <span class="quick-ic" style="background:${softColor(hermesChannel.color)};color:${safeColor(hermesChannel.color, '#0f9b9b')}">🪽</span>
              <span class="quick-main">
                <span class="quick-label">Discussion directe</span>
                <span class="quick-title">Parler à Hermes</span>
              </span>
              <span class="quick-go">${IC.arrow}</span>
            </button>` : ''}
          <button class="quick" id="home-new-agent" type="button">
            <span class="quick-ic" style="background:var(--accent-soft);color:var(--accent)">${IC.plus}</span>
            <span class="quick-main">
              <span class="quick-label">Recruter</span>
              <span class="quick-title">Nouvel agent</span>
            </span>
            <span class="quick-go">${IC.arrow}</span>
          </button>
        </div>
      </div>
    </div>

    <div class="dash">
      <div class="section-title">Tes pôles <small>où le travail se passe</small>
        <button class="btn ghost" id="home-new-pole" type="button" style="margin-left:auto">${IC.plus} Nouveau pôle</button>
      </div>
      <div class="pole-grid">${poles().map(poleCardHTML).join('')
        || emptyBox('🗂️', 'Aucun pôle pour le moment. Un pôle, c\'est un salon où une équipe d\'agents travaille ensemble.')}</div>

      <div class="section-title">Il se passe quoi ? <small>les derniers mouvements</small></div>
      <div class="studio">${studioHTML()}</div>

      <div class="stat-strip">
        ${miniStat(IC.agents, s ? s.agents : S.agents.length, 'agents', `${rank.ceo || 0} CEO · ${rank.manager || 0} managers · ${rank.worker || 0} workers`)}
        ${miniStat(IC.poles, s ? s.poles : poles().length, 'pôles', `${s ? s.activePoles : 0} avec des membres`)}
        ${miniStat(IC.bolt, s ? s.runs24 : 0, 'tâches 24 h', s && s.running ? `${s.running} en cours` : 'rien en cours')}
        ${miniStat(IC.chat, s ? s.msgs7 : 0, 'réponses 7 j', 'produites par tes agents')}
      </div>
    </div>`;

  $$('[data-pole-open]', v).forEach((n) => n.onclick = () => openChannel(n.dataset.poleOpen));
  $('#home-new-agent', v).onclick = () => openAgentModal(null);
  $('#home-new-pole', v).onclick = () => openPoleModal(null);
}

const miniStat = (icon, num, unit, desc) => `
  <div class="mini-stat">
    <span class="mini-ic">${icon}</span>
    <span class="mini-body">
      <span class="mini-num">${Number(num) || 0} <span class="mini-unit">${escapeHtml(unit)}</span></span>
      <span class="mini-desc">${escapeHtml(desc)}</span>
    </span>
  </div>`;

// ---- Journal ---------------------------------------------------------------
function renderJournal(v) {
  v.innerHTML = `<div class="page">
    <div class="page-head"><h1>Journal</h1></div>
    <p class="page-lede">Tout ce que ton organisation a fait, du plus récent au plus ancien.</p>
    <div class="studio">${journalHTML()}</div>
  </div>`;
}

// `value` may arrive already formatted ("184.3 k"), so it must NOT be coerced
// with Number() — that silently turned every token figure into 0.
const statCard = (label, icon, value, desc) => `
  <div class="stat">
    <div class="stat-head">${escapeHtml(label)}${icon}</div>
    <div class="stat-num">${escapeHtml(String(value ?? 0))}</div>
    <div class="stat-desc">${escapeHtml(desc)}</div>
  </div>`;

const emptyBox = (ic, text) =>
  `<div class="empty"><div class="empty-ic" aria-hidden="true">${ic}</div>${escapeHtml(text)}</div>`;

function poleCardHTML(c) {
  const members = c.members.map(agentById).filter(Boolean).sort(byRank);
  const lead = members[0];
  return `<button class="pole-card" type="button" data-pole-open="${escapeAttr(c.id)}">
    <span class="pole-ic" style="background:${softColor(c.color)};color:${safeColor(c.color, '#3e5faf')}">${escapeHtml(c.emoji || '#')}</span>
    <span class="pole-main">
      <span class="pole-name">${escapeHtml(c.name)}</span>
      <span class="pole-meta">Piloté par ${lead ? escapeHtml(lead.name) : '—'} · ${c.members.length} agent${c.members.length > 1 ? 's' : ''} · ${agoText(c.last_activity)}</span>
    </span>
    ${c.recent_count ? `<span class="chan-badge">${c.recent_count}</span>` : ''}
    <span class="chev">${IC.chev}</span>
  </button>`;
}

function studioHTML() {
  const rows = [];
  for (const a of S.agents) {
    const st = S.status[a.id] || 'idle';
    if (st === 'idle') continue;
    rows.push(`<div class="activity">
      ${avatarHTML(a, { status: true })}
      <div class="activity-main">
        <div class="activity-top"><span class="activity-name">${escapeHtml(a.name)}</span>
          <span class="pill in_progress">actif</span></div>
        <div class="activity-text">${st === 'working' ? 'travaille sur une tâche…' : 'réfléchit…'}</div>
      </div></div>`);
  }
  for (const it of S.activity.slice(0, 6)) rows.push(activityFromFeed(it));
  return rows.join('') || emptyBox('🌱', "Aucune activité pour l'instant. Écris à un pôle pour lancer tes agents.");
}

function journalHTML() {
  return S.activity.map(activityFromFeed).join('') || emptyBox('📜', 'Journal vide.');
}

function activityFromFeed(it) {
  if (it.kind === 'task') {
    const asg = agentById(it.assignee_id);
    const by = agentById(it.assigner_id);
    return `<div class="activity">
      ${asg ? avatarHTML(asg) : `<span class="av" style="background:#8a8f9a">?</span>`}
      <div class="activity-main">
        <div class="activity-top"><span class="activity-name">Tâche</span>
          <span class="pill ${escapeAttr(it.status)}">${escapeHtml(statusLabel(it.status))}</span>
          <span class="activity-time">${agoText(it.at)}</span></div>
        <div class="activity-text">${escapeHtml(it.title)}${by ? ' — confiée par ' + escapeHtml(by.name) : ''}</div>
      </div></div>`;
  }
  const color = safeColor(it.author_color, '#8a8f9a');
  return `<div class="activity">
    <span class="av" style="background:${color}">${escapeHtml(initials(it.author_name))}</span>
    <div class="activity-main">
      <div class="activity-top"><span class="activity-name">${escapeHtml(it.author_name)}</span>
        ${it.status === 'error' ? '<span class="pill failed">erreur</span>' : ''}
        <span class="activity-time">${agoText(it.at)}</span></div>
      <div class="activity-text">${escapeHtml(it.preview || '')}</div>
    </div></div>`;
}

// ---- Team ------------------------------------------------------------------
function renderTeam(v) {
  const groups = [['ceo', 'Direction'], ['manager', 'Managers'], ['worker', 'Workers']];
  const filled = groups.filter(([rk]) => S.agents.some((a) => a.rank === rk));
  v.innerHTML = `<div class="page">
    <div class="page-head">
      <h1>Mon équipe</h1>
      <button class="btn" id="team-add" type="button">${IC.plus} Ajouter un agent</button>
    </div>
    ${filled.length ? filled.map(([rk, label]) => {
      const list = S.agents.filter((a) => a.rank === rk);
      return `<section class="team-group">
        <h3>${label} · ${list.length}</h3>
        <div class="agent-grid">${list.map(agentCardHTML).join('')}</div>
      </section>`;
    }).join('') : emptyBox('👥', 'Aucun agent. Crée ton premier employé IA.')}
  </div>`;
  $('#team-add', v).onclick = () => openAgentModal(null);
  $$('[data-agent-card]', v).forEach((n) => n.onclick = () => openAgentModal(agentById(n.dataset.agentCard)));
}

function agentCardHTML(a) {
  return `<button class="agent-card" type="button" data-agent-card="${escapeAttr(a.id)}">
    <div class="agent-card-top">
      ${avatarHTML(a, { size: 42, status: true })}
      <div class="agent-card-id">
        <div class="agent-card-name">${escapeHtml(a.name)}</div>
        <div class="agent-card-title">${escapeHtml(a.title || RANK_LABEL[a.rank] || '')}</div>
      </div>
      <span class="rank-tag ${escapeAttr(a.rank)}">${escapeHtml(RANK_LABEL[a.rank] || a.rank)}</span>
    </div>
    <div class="agent-card-role">${escapeHtml(a.role_prompt || '—')}</div>
    ${modelBadge(a)}
  </button>`;
}

// Small, quiet line telling you which brain an agent actually runs on.
function modelBadge(a) {
  const p = S.providers.find((x) => x.id === (a.provider || 'hermes'));
  if (!p) return '';
  const model = p.models.includes(a.model) ? a.model : p.defaultModel;
  return `<div class="model-badge ${p.enabled ? '' : 'off'}">
    <span class="provider-state ${p.enabled ? 'on' : 'off'}" aria-hidden="true"></span>
    <span>${escapeHtml(p.label)}</span><span class="model-sep">·</span><code>${escapeHtml(model)}</code>
  </div>`;
}

// ---- Skills Hermes ---------------------------------------------------------
async function loadSkills(force = false) {
  if (S.skills && !force) { if (S.view === 'skills') renderView(); return S.skills; }
  const r = await tryApi(api('GET', `/api/skills${force ? '?refresh=1' : ''}`), 'Chargement des skills');
  if (!r) return null;
  S.skills = r;
  if (S.view === 'skills') renderView();
  return r;
}

function renderSkills(v) {
  const data = S.skills;
  if (!data) {
    v.innerHTML = `<div class="page"><div class="page-head"><h1>Skills</h1></div>
      <div class="sk sk-stat"></div></div>`;
    return;
  }

  if (!data.mounted) {
    v.innerHTML = `<div class="page">
      <div class="page-head"><h1>Skills</h1></div>
      <div class="empty" style="text-align:left;padding:28px;line-height:1.8">
        <div class="empty-ic" aria-hidden="true">🔌</div>
        <strong>Les skills d'Hermes ne sont pas visibles d'ici.</strong><br>
        AgentHub lit le catalogue directement dans les dossiers d'Hermes, montés en
        lecture seule. Aucun des deux n'est présent dans le conteneur :<br><br>
        <code>${escapeHtml(data.sources.catalogue.dir)}</code> — catalogue officiel<br>
        <code>${escapeHtml(data.sources.installed.dir)}</code> — skills actifs<br><br>
        Ajoute les volumes d'Hermes dans <code>docker-compose.yml</code> (le fichier
        contient le bloc tout prêt), puis <code>docker compose up -d</code>.
      </div>
    </div>`;
    return;
  }

  const q = S.skillQuery.toLowerCase().trim();
  const shown = data.skills.filter((s) => {
    if (S.skillOnly === 'installed' && !s.installed) return false;
    if (S.skillOnly === 'available' && s.installed) return false;
    if (S.skillCat && s.category !== S.skillCat) return false;
    if (!q) return true;
    return s.name.toLowerCase().includes(q)
      || s.description.toLowerCase().includes(q)
      || s.tags.some((t) => t.toLowerCase().includes(q));
  });

  v.innerHTML = `<div class="page">
    <div class="page-head">
      <h1>Skills</h1>
      <button class="btn ghost" id="skills-refresh" type="button">Actualiser</button>
    </div>
    <p class="page-lede">
      Ce que ton Hermes sait faire. <strong>${data.counts.installed}</strong> skill${data.counts.installed > 1 ? 's' : ''}
      actif${data.counts.installed > 1 ? 's' : ''}, <strong>${data.counts.available}</strong> disponible${data.counts.available > 1 ? 's' : ''}
      dans le catalogue officiel Nous Research, sur ${data.categories.length} catégories.
      Lu directement dans les fichiers d'Hermes — l'installation, elle, se fait chez lui.
    </p>

    <div class="skill-toolbar">
      <div class="search-field">
        ${IC.search}
        <input id="skill-q" type="search" placeholder="Chercher par nom, description ou tag…"
               value="${escapeAttr(S.skillQuery)}" aria-label="Chercher un skill" autocomplete="off">
        <button class="search-clear ${S.skillQuery ? '' : 'hidden'}" id="skill-clear" type="button"
                aria-label="Effacer la recherche">×</button>
      </div>
      <div class="seg" role="group" aria-label="Filtrer par état">
        <button class="seg-btn ${S.skillOnly === '' ? 'on' : ''}" data-only="" type="button">Tous <small>${data.counts.total}</small></button>
        <button class="seg-btn ${S.skillOnly === 'installed' ? 'on' : ''}" data-only="installed" type="button">Actifs <small>${data.counts.installed}</small></button>
        <button class="seg-btn ${S.skillOnly === 'available' ? 'on' : ''}" data-only="available" type="button">À installer <small>${data.counts.available}</small></button>
      </div>
    </div>
    <div class="skill-result" id="skill-result" aria-live="polite"></div>

    <div class="tag-filter">
      <button class="tag ${S.skillCat ? '' : 'on'}" type="button" data-cat="">toutes</button>
      ${data.categories.map((c) => `<button class="tag ${S.skillCat === c.category ? 'on' : ''}" type="button"
        data-cat="${escapeAttr(c.category)}">${escapeHtml(c.category)} <span class="muted">${c.total}</span></button>`).join('')}
    </div>

    ${shown.length ? `<div class="skill-grid">${shown.map(skillCardHTML).join('')}</div>`
      : '<div class="empty skill-empty">Aucun skill ne correspond.</div>'}
  </div>`;

  const input = $('#skill-q', v);
  const clear = $('#skill-clear', v);
  const result = $('#skill-result', v);

  // Re-rendre la page à chaque frappe ferait perdre le focus et la position du
  // curseur : seule la grille est repeinte.
  const repaint = () => {
    const qq = S.skillQuery.toLowerCase().trim();
    const next = data.skills.filter((s) => {
      if (S.skillOnly === 'installed' && !s.installed) return false;
      if (S.skillOnly === 'available' && s.installed) return false;
      if (S.skillCat && s.category !== S.skillCat) return false;
      if (!qq) return true;
      return s.name.toLowerCase().includes(qq) || s.description.toLowerCase().includes(qq)
        || s.tags.some((t) => t.toLowerCase().includes(qq));
    });
    const list = $('.skill-grid', v) || $('.skill-empty', v);
    if (list) {
      list.outerHTML = next.length
        ? `<div class="skill-grid">${next.map(skillCardHTML).join('')}</div>`
        : `<div class="empty skill-empty">Aucun skill ne correspond à « ${escapeHtml(S.skillQuery)} ».</div>`;
      wireSkillCards(v, data);
    }
    clear.classList.toggle('hidden', !S.skillQuery);
    result.textContent = qq || S.skillCat || S.skillOnly
      ? `${next.length} skill${next.length > 1 ? 's' : ''} sur ${data.counts.total}`
      : '';
  };

  input.oninput = () => { S.skillQuery = input.value; repaint(); };
  input.onkeydown = (e) => {
    if (e.key === 'Escape' && S.skillQuery) {
      e.preventDefault();
      S.skillQuery = ''; input.value = ''; repaint();
    }
  };
  clear.onclick = () => { S.skillQuery = ''; input.value = ''; input.focus(); repaint(); };
  repaint();

  $$('[data-only]', v).forEach((b) => b.onclick = () => { S.skillOnly = b.dataset.only; renderView(); });
  $$('[data-cat]', v).forEach((b) => b.onclick = () => { S.skillCat = b.dataset.cat; renderView(); });
  $('#skills-refresh', v).onclick = async (e) => {
    e.currentTarget.disabled = true;
    await loadSkills(true);
    toast('Catalogue relu.', { kind: 'success' });
  };
  wireSkillCards(v, data);
}

function wireSkillCards(root, data) {
  $$('[data-skill]', root).forEach((c) => c.onclick = () => {
    const s = data.skills.find((x) => x.id === c.dataset.skill);
    if (s) openSkillModal(skillToNode(s));
  });
}

/** La fiche de skill est partagée avec la carte : même forme des deux côtés. */
const skillToNode = (s) => ({
  layer: 'skills', id: s.id, name: s.name, title: s.title,
  subtitle: s.description, version: s.version, author: s.author,
  license: s.license, tags: s.tags, installed: s.installed,
});

function skillCardHTML(s) {
  return `<button class="skill-card ${s.installed ? 'on' : ''}" type="button" data-skill="${escapeAttr(s.id)}">
    <span class="skill-top">
      <span class="skill-name">${escapeHtml(s.title)}</span>
      <span class="pill ${s.installed ? 'done' : 'pending'}">${s.installed ? 'actif' : 'à installer'}</span>
    </span>
    <span class="skill-desc">${escapeHtml(s.description || 'Pas de description.')}</span>
    <span class="skill-foot">
      <span class="tag sm">${escapeHtml(s.category)}</span>
      ${s.version ? `<span class="muted">v${escapeHtml(s.version)}</span>` : ''}
      ${s.author ? `<span class="muted">${escapeHtml(s.author)}</span>` : ''}
    </span>
  </button>`;
}

// ---- Second cerveau --------------------------------------------------------

function notesUsedChars() {
  return S.notes.reduce((n, x) => n + (x.content.trim() ? x.title.length + x.content.trim().length + 5 : 0), 0);
}

const BRAIN_TABS = [
  ['recent', 'Récent', IC.clock],
  ['notes', 'Notes', IC.note],
  ['graph', 'Graph', IC.graph],
];

function renderBrain(v) {
  // The galaxy owns a canvas and a rAF loop; leaving one running behind a tab
  // switch would keep repainting a detached node forever.
  destroyGalaxy();

  const tab = BRAIN_TABS.some(([id]) => id === S.brainTab) ? S.brainTab : 'recent';
  S.brainTab = tab;

  v.innerHTML = `<div class="page brain-page">
    <div class="brain-bar">
      <div class="brain-tabs" role="tablist" aria-label="Vues de la mémoire">
        ${BRAIN_TABS.map(([id, label, icon]) => `
          <button class="brain-tab ${id === tab ? 'on' : ''}" type="button" role="tab"
                  aria-selected="${id === tab}" aria-label="${escapeAttr(label)}" data-tab="${id}">
            ${icon}<span>${label}</span>
            ${id === 'recent' && S.proposals.length ? `<span class="tab-count">${S.proposals.length}</span>` : ''}
            ${id === 'notes' && S.notes.length ? `<span class="tab-count muted-count">${S.notes.length}</span>` : ''}
          </button>`).join('')}
      </div>
      <button class="btn" id="note-new" type="button">${IC.plus} Nouvelle note</button>
    </div>
    <div class="brain-panel" id="brain-panel"></div>
  </div>`;

  $$('[data-tab]', v).forEach((b) => b.onclick = () => {
    S.brainTab = b.dataset.tab;
    renderView();
  });
  $('#note-new', v).onclick = () => openNoteModal(null);

  const panel = $('#brain-panel', v);
  if (tab === 'graph') renderBrainGraph(panel);
  else if (tab === 'notes') renderBrainNotes(panel);
  else renderBrainRecent(panel);
}

/** Wire the shared note-card interactions of a freshly rendered panel. */
function wireNoteCards(root) {
  $$('[data-note]', root).forEach((n) => n.onclick = () => {
    const note = S.notes.find((x) => x.id === n.dataset.note);
    if (note) openNoteModal(note);
  });
  $$('[data-pin]', root).forEach((n) => n.onclick = async (e) => {
    e.stopPropagation();
    const note = S.notes.find((x) => x.id === n.dataset.pin);
    if (note) await tryApi(api('PUT', `/api/notes/${note.id}`, { pinned: note.pinned ? 0 : 1 }), 'Épinglage');
  });
}

// ---- onglet Récent ---------------------------------------------------------
/** Blanc quand c'est frais, bleu profond quand ça dort. Un mois pour s'éteindre. */
const FRESH_WINDOW_MS = 30 * 86400000;
function freshnessColor(ts, alpha = 1) {
  const f = ts ? Math.min(1, Math.max(0, (Date.now() - ts) / FRESH_WINDOW_MS)) : 1;
  return `hsl(${250 - f * 22} ${12 + f * 46}% ${96 - f * 42}% / ${alpha})`;
}

function renderBrainRecent(panel) {
  const recent = [...S.notes].sort((a, b) =>
    (b.touched_at || b.updated_at) - (a.touched_at || a.updated_at)).slice(0, 40);

  panel.innerHTML = `
    ${S.proposals.length ? `
      <section class="brain-section">
        <h2 class="brain-h">${S.proposals.length} note${S.proposals.length > 1 ? 's' : ''} proposée${S.proposals.length > 1 ? 's' : ''} par tes agents</h2>
        <p class="brain-sub">Rien n'entre en mémoire sans ton accord.</p>
        <div class="prop-list">${S.proposals.map(proposalHTML).join('')}</div>
      </section>` : ''}

    <section class="brain-section">
      <h2 class="brain-h">Dernières mémoires</h2>
      <p class="brain-sub">Du plus récemment utilisé au plus ancien — une note remonte quand tu l'ouvres ou qu'un agent s'en sert.</p>
      ${recent.length ? `<ol class="recent-list">${recent.map(recentRowHTML).join('')}</ol>` : emptyBrainHTML()}
    </section>`;

  wireNoteCards(panel);
  $$('[data-accept]', panel).forEach((b) => b.onclick = async () => {
    b.disabled = true;
    const r = await tryApi(api('POST', `/api/notes/proposals/${b.dataset.accept}/accept`), 'Validation');
    if (r) { toast('Note ajoutée à la mémoire.', { kind: 'success' }); loadProposals(); loadNotes(); S.graph = null; }
    else b.disabled = false;
  });
  $$('[data-reject]', panel).forEach((b) => b.onclick = async () => {
    b.disabled = true;
    const r = await tryApi(api('POST', `/api/notes/proposals/${b.dataset.reject}/reject`), 'Refus');
    if (r) loadProposals(); else b.disabled = false;
  });
}

function proposalHTML(p) {
  return `<article class="prop-card">
    <header>
      <strong>${escapeHtml(p.title)}</strong>
      <span class="muted">proposée par ${escapeHtml(p.agent_name || 'un agent')} · ${agoText(p.created_at)}</span>
    </header>
    <p>${escapeHtml((p.content || '').slice(0, 400))}${(p.content || '').length > 400 ? '…' : ''}</p>
    ${p.tags.length ? `<div class="tag-row">${p.tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
    <footer>
      <button class="primary sm" type="button" data-accept="${escapeAttr(p.id)}">Ajouter à la mémoire</button>
      <button class="btn sm" type="button" data-reject="${escapeAttr(p.id)}">Refuser</button>
    </footer>
  </article>`;
}

function recentRowHTML(n) {
  const when = n.touched_at || n.updated_at;
  return `<li class="recent-row">
    <button class="recent-open" type="button" data-note="${escapeAttr(n.id)}">
      <span class="recent-dot" style="--dot:${freshnessColor(when)}" aria-hidden="true"></span>
      <span class="recent-main">
        <span class="recent-title">${n.pinned ? '📌 ' : ''}${escapeHtml(n.title)}</span>
        <span class="recent-prev">${escapeHtml((n.content || '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Note vide')}</span>
      </span>
      <span class="recent-meta">${agoText(when)}${n.uses ? ` · ${n.uses} usage${n.uses > 1 ? 's' : ''}` : ''}</span>
    </button>
  </li>`;
}

const emptyBrainHTML = () => `
  <div class="empty" style="text-align:left;padding:28px;line-height:1.75">
    <div class="empty-ic" aria-hidden="true">🧠</div>
    <strong>Rien en mémoire pour l'instant.</strong><br>
    Écris ici ce que tes agents doivent toujours savoir : le ton de ta marque, tes
    clients, tes contraintes, tes décisions déjà prises. Une bonne première note :
    « Contexte de l'organisation » — qui tu es et ce que tu fais.<br>
    Relie-les entre elles avec des <code>[[doubles crochets]]</code> : c'est ce qui dessine la galaxie.
  </div>`;

// ---- onglet Notes ----------------------------------------------------------
function renderBrainNotes(panel) {
  const used = notesUsedChars();
  const budget = S.notesBudget;
  const pct = Math.min(100, Math.round((used / budget) * 100));
  const over = used > budget;
  const shown = S.brainTag ? S.notes.filter((n) => (n.tags || []).includes(S.brainTag)) : S.notes;

  panel.innerHTML = `
    <p class="page-lede">
      La mémoire commune de ton organisation. Tout ce qui est écrit ici est ajouté au
      prompt de <strong>chaque agent</strong>, dans chaque salon — c'est ce qu'ils savent
      sans que tu aies à le répéter.
    </p>

    <div class="budget">
      <div class="budget-head">
        <span>${used.toLocaleString('fr-FR')} / ${budget.toLocaleString('fr-FR')} caractères injectés</span>
        <span class="${over ? 'budget-over' : 'muted'}">${over ? 'au-delà : les dernières notes seront tronquées' : `${pct} %`}</span>
      </div>
      <div class="budget-bar"><span style="width:${pct}%" class="${over ? 'over' : ''}"></span></div>
      <div class="budget-tune">
        <label for="nb-budget">Mémoire injectée à chaque appel</label>
        <input id="nb-budget" type="number" min="2000" max="${S.notesBudgetMax}" step="10000" value="${budget}">
        <span class="muted">caractères ≈ <strong>${Math.round(budget / 4).toLocaleString('fr-FR')}</strong> tokens</span>
        <button class="btn sm" id="nb-save" type="button">Appliquer</button>
      </div>
      <div class="field-hint" style="margin-top:8px;line-height:1.7">
        Les notes épinglées passent en premier et sont donc les dernières à être coupées.
        Cette mémoire part avec <strong>chaque</strong> message de <strong>chaque</strong> agent :
        la doubler double la part de contexte facturée à chaque tour. Maximum ${S.notesBudgetMax.toLocaleString('fr-FR')} caractères.
      </div>
    </div>

    <label class="checklist-item" style="padding:0;margin:0 0 18px">
      <input type="checkbox" id="nb-auto" ${S.notesAuto ? 'checked' : ''}>
      <span>Les agents écrivent directement en mémoire, sans validation de ta part</span>
    </label>

    ${S.noteTags.length ? `<div class="tag-filter">
      <button class="tag ${S.brainTag ? '' : 'on'}" type="button" data-tagf="">tout</button>
      ${S.noteTags.map((t) => `<button class="tag ${S.brainTag === t.tag ? 'on' : ''}" type="button"
        data-tagf="${escapeAttr(t.tag)}">#${escapeHtml(t.tag)} <span class="muted">${t.count}</span></button>`).join('')}
    </div>` : ''}

    ${shown.length ? `<div class="note-grid">${shown.map(noteCardHTML).join('')}</div>`
      : S.notes.length ? '<div class="empty">Aucune note avec ce tag.</div>' : emptyBrainHTML()}`;

  $$('[data-tagf]', panel).forEach((b) => b.onclick = () => {
    S.brainTag = b.dataset.tagf;
    renderView();
  });

  $('#nb-save', panel).onclick = async (e) => {
    const v = Math.max(2000, Math.min(S.notesBudgetMax, Number($('#nb-budget', panel).value) || 0));
    e.currentTarget.disabled = true;
    const r = await tryApi(api('PUT', '/api/settings', { notes_budget: String(v) }), 'Enregistrement');
    e.currentTarget.disabled = false;
    if (r) { S.settings = r; toast(`Mémoire injectée portée à ${v.toLocaleString('fr-FR')} caractères.`, { kind: 'success' }); loadNotes(); }
  };

  $('#nb-auto', panel).onchange = async (e) => {
    const on = e.currentTarget.checked;
    const r = await tryApi(api('PUT', '/api/settings', { notes_auto: on ? '1' : '' }), 'Enregistrement');
    if (r) {
      S.settings = r;
      S.notesAuto = on;
      toast(on ? 'Les agents écrivent directement en mémoire.' : 'Les notes des agents attendront ta validation.',
        { kind: 'success' });
    } else e.currentTarget.checked = !on;
  };

  wireNoteCards(panel);
}

// ---- onglet Graph : la galaxie ---------------------------------------------
// Une carte en trois dimensions, mais structurée : chaque catégorie forme un
// amas identifiable, les amas se répartissent sur un disque, et l'ensemble
// tourne lentement. Ma première version dispersait tout dans un même nuage —
// c'était joli et illisible. Ici la structure vient d'abord, la profondeur
// ensuite.
//
// Canvas 2D avec projection écrite à la main : le projet n'a pas de build ni de
// dépendance, et sa politique de sécurité interdit de charger three.js depuis
// un CDN. Les étoiles sont dessinées à partir d'une image pré-calculée par
// couleur plutôt que d'un dégradé recréé à chaque image — à deux cents étoiles
// et soixante images par seconde, la différence est celle entre fluide et
// saccadé.

const LAYERS = [
  ['notes', 'Mémoire'],
  ['agents', 'Agents'],
  ['channels', 'Pôles'],
  ['tasks', 'Tâches'],
  ['skills', 'Skills'],
];
const LAYER_COLOR = {
  notes: '#9db4ff', agents: '#5fd3e0', channels: '#5fe0ab',
  tasks: '#f0c274', skills: '#dd9bf0',
};
const GALAXY_HELP = 'glisser pour tourner · molette pour zoomer · clic sur une étoile · double-clic met en pause';

let galaxy = null;
function destroyGalaxy() {
  if (galaxy) { galaxy.destroy(); galaxy = null; }
}

async function renderBrainGraph(panel) {
  panel.innerHTML = '<div class="galaxy-wrap"><div class="galaxy-loading">Construction de la carte…</div></div>';

  const data = await loadGraph();
  if (!data) { panel.innerHTML = '<div class="empty">La carte n\'a pas pu être chargée.</div>'; return; }
  if (S.brainTab !== 'graph') return;      // l'utilisateur a changé d'onglet entre-temps

  const counts = data.counts || {};
  const skillsOff = data.skills && !data.skills.mounted;

  if (!data.nodes.length) {
    panel.innerHTML = `<div class="empty" style="text-align:left;padding:28px;line-height:1.75">
      <div class="empty-ic" aria-hidden="true">✦</div>
      <strong>Rien à cartographier pour l'instant.</strong><br>
      Écris une note, ou active un autre calque.
    </div>`;
    return;
  }

  panel.innerHTML = `<div class="galaxy-wrap" id="galaxy-wrap">
    <canvas id="galaxy-canvas" aria-label="Carte de l'espace de travail"></canvas>

    <div class="galaxy-hud">
      <div class="galaxy-title">MEMORY GALAXY</div>
      <div class="galaxy-count"><strong>${data.nodes.length}</strong> étoile${data.nodes.length > 1 ? 's' : ''} · <strong>${data.links.length}</strong> lien${data.links.length > 1 ? 's' : ''} · <strong>${data.groups.length}</strong> amas</div>
      <div class="galaxy-help">${GALAXY_HELP}</div>
    </div>

    <div class="galaxy-layers" role="group" aria-label="Ce qui apparaît dans la galaxie">
      ${LAYERS.map(([id, label]) => `
        <button class="layer-btn ${S.graphLayers.includes(id) ? 'on' : ''}" type="button"
                data-layer="${id}" aria-pressed="${S.graphLayers.includes(id)}">
          <span class="layer-dot" style="--c:${LAYER_COLOR[id]}"></span>${label}
          <small>${counts[id] ?? 0}</small>
        </button>`).join('')}
    </div>

    ${skillsOff ? `<div class="galaxy-warn">Skills invisibles : les dossiers d'Hermes ne sont pas montés dans le conteneur.</div>` : ''}

    <div class="galaxy-card hidden" id="galaxy-card" aria-live="polite"></div>
    <div class="galaxy-tools">
      <button class="galaxy-btn" id="galaxy-spin" type="button" aria-pressed="true">Pause</button>
      <button class="galaxy-btn" id="galaxy-reset" type="button">Recentrer</button>
    </div>
  </div>`;

  $$('[data-layer]', panel).forEach((b) => b.onclick = () => {
    const id = b.dataset.layer;
    const next = S.graphLayers.includes(id)
      ? S.graphLayers.filter((l) => l !== id)
      : [...S.graphLayers, id];
    if (!next.length) { toast('Garde au moins un calque affiché.', { kind: 'warn' }); return; }
    S.graphLayers = LAYERS.map(([l]) => l).filter((l) => next.includes(l));
    localStorage.setItem('ah_layers', JSON.stringify(S.graphLayers));
    renderView();
  });

  const card = $('#galaxy-card', panel);
  galaxy = new Galaxy3D($('#galaxy-canvas', panel), data, {
    onHover: (node, group) => {
      if (!node) { card.classList.add('hidden'); return; }
      card.classList.remove('hidden');
      card.innerHTML = `
        <div class="gc-title">
          <span class="layer-dot" style="--c:${nodeColor(node, group)}"></span>
          <span>${escapeHtml((node.emoji ? node.emoji + ' ' : '') + node.title)}</span>
        </div>
        <div class="gc-meta">${escapeHtml(group ? group.label : '')}</div>
        <div class="gc-meta">${escapeHtml(node.subtitle || '')}</div>
        <div class="gc-meta">${escapeHtml(node.meta || '')}</div>`;
    },
    onPick: (node) => pickNode(node),
  });

  const spin = $('#galaxy-spin', panel);
  spin.onclick = () => {
    const on = galaxy.toggleSpin();
    spin.textContent = on ? 'Pause' : 'Reprendre';
    spin.setAttribute('aria-pressed', String(on));
  };
  $('#galaxy-reset', panel).onclick = () => galaxy.reset();
}

/** Couleur d'une étoile : la sienne s'il en a une, sinon celle de son calque. */
function nodeColor(node, group) {
  if (node.color) return safeColor(node.color, LAYER_COLOR[node.layer]);
  if (node.layer === 'tasks') {
    return { done: '#77e0a0', failed: '#f0947a', in_progress: '#f0c274' }[node.status] || LAYER_COLOR.tasks;
  }
  if (node.layer === 'skills' && !node.installed) return '#9a7fb0';
  return (group && group.color) || LAYER_COLOR[node.layer] || '#9db4ff';
}

class Galaxy3D {
  constructor(canvas, data, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = data;
    this.opts = opts;

    this.yaw = 0.4;
    this.pitch = -0.34;
    this.zoom = 1;
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
    this.spin = !this.reduced;
    this.hover = null;
    this.pointer = null;
    this.dragging = false;
    this.sprites = new Map();

    this.layout();
    this.bind();
    this.resize();
    // Une première image tout de suite : dans un onglet en arrière-plan,
    // requestAnimationFrame ne se déclenche pas et la carte resterait noire.
    this.draw();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  /**
   * Les amas d'abord, leurs membres ensuite.
   *
   * Les centres se répartissent sur un disque par spirale de Fibonacci, les
   * membres sur une petite sphère autour du leur. Tout est déterministe : la
   * carte doit se redessiner à l'identique d'une visite à l'autre, sinon on ne
   * s'y repère jamais.
   */
  layout() {
    const byGroup = new Map();
    for (const n of this.data.nodes) {
      if (!byGroup.has(n.group)) byGroup.set(n.group, []);
      byGroup.get(n.group).push(n);
    }

    this.groups = this.data.groups.filter((g) => byGroup.has(g.id));
    const G = this.groups.length;
    const spread = 210 + Math.sqrt(this.data.nodes.length) * 26;
    const golden = Math.PI * (3 - Math.sqrt(5));

    this.nodes = [];
    this.groups.forEach((g, i) => {
      // Disque plutôt que sphère : les amas restent distincts vus de face, et
      // la profondeur sert la lisibilité au lieu de tout mélanger.
      const t = G === 1 ? 0 : i / (G - 1);
      const rad = spread * Math.sqrt(0.12 + t * 0.88);
      const ang = i * golden;
      g.cx = Math.cos(ang) * rad;
      g.cy = (((i * 41) % 100) / 100 - 0.5) * spread * 0.30;
      g.cz = Math.sin(ang) * rad;

      const members = byGroup.get(g.id);
      const blob = 26 + Math.sqrt(members.length) * 15;
      members.forEach((n, j) => {
        const m = members.length;
        const y = m === 1 ? 0 : 1 - (j / (m - 1)) * 2;
        const rr = Math.sqrt(Math.max(0, 1 - y * y));
        const th = golden * j;
        // Rayon variable pour que l'amas ait du volume plutôt qu'une coquille.
        const shell = 0.45 + 0.55 * (((j * 29) % 100) / 100);
        this.nodes.push({
          node: n, group: g,
          x: g.cx + Math.cos(th) * rr * blob * shell,
          y: g.cy + y * blob * shell * 0.7,
          z: g.cz + Math.sin(th) * rr * blob * shell,
          r: 1.7 + (n.weight || 1) * 1.25,
          color: nodeColor(n, g),
        });
      });
    });

    this.index = new Map(this.nodes.map((s, i) => [s.node.id, i]));
    this.degree = new Map();
    for (const l of this.data.links) {
      this.degree.set(l.source, (this.degree.get(l.source) || 0) + 1);
      this.degree.set(l.target, (this.degree.get(l.target) || 0) + 1);
    }
    for (const s of this.nodes) s.r += Math.min(2.2, (this.degree.get(s.node.id) || 0) * 0.5);

    this.radius = this.nodes.reduce((m, s) => Math.max(m, Math.hypot(s.x, s.y, s.z)), 1);

    // Poussière : purement décoratif, mais c'est ce qui fait lire le vide comme
    // un ciel et non comme un fond gris.
    this.dust = [];
    for (let i = 0; i < 420; i++) {
      const a = (i * 2.399963) % (Math.PI * 2);
      const rr = this.radius * (0.25 + ((i * 37) % 100) / 74);
      this.dust.push({
        x: Math.cos(a) * rr,
        y: (((i * 53) % 100) / 100 - 0.5) * this.radius * 0.4,
        z: Math.sin(a) * rr,
        s: 0.5 + ((i * 17) % 10) / 12,
      });
    }
  }

  /**
   * Une étoile pré-dessinée par couleur : halo doux plus cœur clair.
   * Recréer un dégradé radial par étoile et par image coûterait plus que tout
   * le reste du rendu réuni.
   */
  sprite(color) {
    if (this.sprites.has(color)) return this.sprites.get(color);
    const S = 64;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.18, color);
    grad.addColorStop(0.45, withAlpha(color, 0.35));
    grad.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    this.sprites.set(color, c);
    return c;
  }

  bind() {
    const c = this.canvas;
    this.onResize = () => { this.resize(); this.draw(); };
    window.addEventListener('resize', this.onResize);
    this.onVisible = () => { if (!document.hidden) { this.resize(); this.draw(); } };
    document.addEventListener('visibilitychange', this.onVisible);

    this.onDown = (e) => {
      this.dragging = true;
      this.lastX = e.clientX; this.lastY = e.clientY; this.moved = 0;
      c.setPointerCapture?.(e.pointerId);
      c.classList.add('grabbing');
    };
    this.onMove = (e) => {
      const r = c.getBoundingClientRect();
      this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.moved += Math.abs(dx) + Math.abs(dy);
      this.yaw += dx * 0.006;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + dy * 0.006));
    };
    this.onUp = (e) => {
      // Un glissement n'est pas un clic : sans ce seuil, chaque rotation
      // finirait par ouvrir une fiche au hasard.
      if (this.dragging && this.moved < 5 && this.hover) this.opts.onPick?.(this.hover.node);
      this.dragging = false;
      c.releasePointerCapture?.(e.pointerId);
      c.classList.remove('grabbing');
    };
    this.onLeave = () => { this.pointer = null; this.setHover(null); };
    this.onWheel = (e) => {
      e.preventDefault();
      this.zoom = Math.max(0.4, Math.min(6, this.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    };
    this.onDbl = () => this.toggleSpin();
    this.onKey = (e) => {
      if (e.key === 'Escape') this.setHover(null);
      if (e.key === ' ') { e.preventDefault(); this.toggleSpin(); }
    };

    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointerleave', this.onLeave);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('dblclick', this.onDbl);
    c.addEventListener('keydown', this.onKey);
    c.tabIndex = 0;
  }

  toggleSpin() { this.spin = !this.spin; return this.spin; }
  reset() { this.yaw = 0.4; this.pitch = -0.34; this.zoom = 1; }

  resize() {
    const wrap = this.canvas.parentElement;
    if (!wrap) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = wrap.clientWidth; this.h = wrap.clientHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setHover(s) {
    if (this.hover === s) return;
    this.hover = s;
    this.canvas.style.cursor = s ? 'pointer' : 'grab';
    this.opts.onHover?.(s ? s.node : null, s ? s.group : null);
  }

  project(p) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const x1 = p.x * cy - p.z * sy;
    const z1 = p.x * sy + p.z * cy;
    const y2 = p.y * cp - z1 * sp;
    const z2 = p.y * sp + z1 * cp;
    const fov = 1100;
    const depth = fov + z2;
    if (depth < 80) return null;
    const k = (fov / depth) * this.zoom * this.fit;
    return { x: this.w / 2 + x1 * k, y: this.h / 2 + y2 * k, k, z: z2 };
  }

  loop() {
    this.raf = requestAnimationFrame(this.loop);
    if (this.spin && !this.dragging) this.yaw += 0.0013;
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const { w, h } = this;
    if (!w || !h) return;
    this.fit = Math.min(w, h) / (this.radius * 2.5);

    // Fond : un dégradé chaud au centre, noir aux bords. C'est lui qui donne
    // la sensation de profondeur avant même la première étoile.
    const bg = ctx.createRadialGradient(w / 2, h * 0.48, 0, w / 2, h * 0.48, Math.max(w, h) * 0.8);
    bg.addColorStop(0, '#1c1f47');
    bg.addColorStop(0.45, '#0e1029');
    bg.addColorStop(1, '#05060f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'lighter';
    for (const d of this.dust) {
      const p = this.project(d);
      if (!p) continue;
      ctx.globalAlpha = 0.10 + 0.18 * Math.min(1, p.k * 2);
      ctx.fillStyle = '#aab6ff';
      ctx.fillRect(p.x, p.y, d.s, d.s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    const proj = this.nodes.map((s) => this.project(s));

    // Voisins de l'étoile survolée : eux seuls resteront allumés.
    const hoverId = this.hover ? this.hover.node.id : null;
    const near = new Set();
    if (hoverId) {
      for (const l of this.data.links) {
        if (l.source === hoverId) near.add(l.target);
        if (l.target === hoverId) near.add(l.source);
      }
    }

    ctx.lineWidth = 1;
    for (const l of this.data.links) {
      const a = this.index.get(l.source), b = this.index.get(l.target);
      if (a === undefined || b === undefined) continue;
      const pa = proj[a], pb = proj[b];
      if (!pa || !pb) continue;
      const lit = hoverId && (l.source === hoverId || l.target === hoverId);
      if (hoverId && !lit) continue;              // au survol, seuls les liens concernés
      ctx.strokeStyle = lit ? 'rgba(200,216,255,.85)' : 'rgba(150,168,240,.13)';
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    // Du plus lointain au plus proche : les étoiles de devant couvrent celles
    // de derrière, ce qui est tout ce qui donne la profondeur.
    const order = this.nodes.map((_, i) => i).filter((i) => proj[i])
      .sort((a, b) => proj[b].z - proj[a].z);

    let best = null, bestD = 20;
    ctx.globalCompositeOperation = 'lighter';
    for (const i of order) {
      const s = this.nodes[i];
      const p = proj[i];
      const r = Math.max(0.8, s.r * p.k);

      if (this.pointer) {
        const d = Math.hypot(this.pointer.x - p.x, this.pointer.y - p.y);
        if (d < Math.max(bestD, r + 7)) { best = s; bestD = Math.min(bestD, d); }
      }

      const dim = hoverId && s.node.id !== hoverId && !near.has(s.node.id);
      // La profondeur assombrit : sans ça tout se vaut et le relief disparaît.
      const depth = 0.42 + 0.58 * Math.min(1, p.k * 1.5);
      const alpha = (dim ? 0.16 : 1) * depth;

      const size = r * (s.node.stub ? 5 : 7);
      ctx.globalAlpha = alpha * (s.node.stub ? 0.45 : 0.95);
      ctx.drawImage(this.sprite(s.color), p.x - size, p.y - size, size * 2, size * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // Nom des amas, posé au centre de chacun : c'est ce qui fait la différence
    // entre une carte et une nébuleuse.
    ctx.textAlign = 'center';
    for (const g of this.groups) {
      const p = this.project({ x: g.cx, y: g.cy, z: g.cz });
      if (!p || p.k < 0.25) continue;
      const dimmed = hoverId && this.hover.group.id !== g.id;
      ctx.globalAlpha = Math.min(0.92, p.k * 1.3) * (dimmed ? 0.35 : 1);
      ctx.font = `600 ${Math.round(10 + p.k * 3)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = g.color;
      ctx.fillText(`${g.label} · ${g.count}`, p.x, p.y - 6);
    }
    ctx.globalAlpha = 1;

    // Le titre de l'étoile survolée, et rien d'autre : afficher deux cents
    // libellés reviendrait à n'en afficher aucun.
    if (this.hover) {
      const i = this.index.get(this.hover.node.id);
      const p = proj[i];
      if (p) {
        const r = Math.max(0.8, this.nodes[i].r * p.k);
        ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
        const text = this.hover.node.title.slice(0, 40);
        const wdt = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(8,10,26,.82)';
        ctx.fillRect(p.x - wdt / 2 - 7, p.y - r - 28, wdt + 14, 21);
        ctx.fillStyle = '#eef1ff';
        ctx.fillText(text, p.x, p.y - r - 13);
      }
    }

    this.setHover(this.pointer ? best : null);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    const c = this.canvas;
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisible);
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointerleave', this.onLeave);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('dblclick', this.onDbl);
    c.removeEventListener('keydown', this.onKey);
  }
}

/** Applique une opacité à une couleur hexadécimale. */
function withAlpha(color, a) {
  const hex = String(color || '').replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (full.length !== 6) return `rgba(160, 180, 255, ${a})`;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Chaque famille s'ouvre là où elle vit réellement. */
function pickNode(node) {
  if (node.layer === 'notes') {
    if (node.stub) { openNoteModal(null, { title: node.title }); return; }
    const note = S.notes.find((n) => n.id === node.id);
    if (!note) return;
    api('POST', `/api/notes/${note.id}/touch`).catch(() => {});
    openNoteModal(note);
    return;
  }
  if (node.layer === 'agents') {
    const agent = agentById(node.id);
    if (agent) openAgentModal(agent);
    return;
  }
  if (node.layer === 'channels') {
    if (channelById(node.id)) openChannel(node.id);
    return;
  }
  if (node.layer === 'tasks') {
    if (node.channel_id && channelById(node.channel_id)) openChannel(node.channel_id);
    else toast(`Tâche « ${node.title} » — ${node.subtitle}`, { kind: 'info' });
    return;
  }
  if (node.layer === 'skills') openSkillModal(node);
}

/**
 * Fiche d'un skill Hermes.
 *
 * On n'installe rien depuis ici : l'installation écrit dans les fichiers
 * d'Hermes et passe par ses propres contrôles — analyse de sécurité,
 * provenance, épinglage. AgentHub montre et donne la commande exacte.
 */
function openSkillModal(node) {
  openModal(node.title, (b) => {
    b.innerHTML = `
      <div class="skill-head">
        <span class="pill ${node.installed ? 'done' : 'pending'}">${node.installed ? 'actif dans Hermes' : 'disponible'}</span>
        ${node.version ? `<span class="muted">v${escapeHtml(node.version)}</span>` : ''}
        ${node.author ? `<span class="muted">par ${escapeHtml(node.author)}</span>` : ''}
        ${node.license ? `<span class="muted">${escapeHtml(node.license)}</span>` : ''}
      </div>
      <p style="line-height:1.7;margin:14px 0">${escapeHtml(node.subtitle || 'Pas de description.')}</p>
      ${(node.tags || []).length ? `<div class="tag-row">${node.tags.map((t) => `<span class="tag sm">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      ${node.installed ? `
        <div class="field-hint" style="margin-top:16px;line-height:1.7">
          Ce skill est déjà actif : tes agents branchés sur Hermes peuvent s'en servir.
        </div>`
      : `
        <div class="field" style="margin-top:16px">
          <label>Pour l'activer, dans Hermes</label>
          <div class="cmd-row">
            <code id="skill-cmd">hermes skills install ${escapeHtml(node.name)}</code>
            <button class="btn sm" id="skill-copy" type="button">Copier</button>
          </div>
          <div class="field-hint" style="margin-top:8px;line-height:1.7">
            L'installation se fait côté Hermes, qui applique ses propres contrôles
            (analyse de sécurité, provenance, épinglage). AgentHub ne touche pas à ses fichiers.
          </div>
        </div>`}`;

    const copy = $('#skill-copy', b);
    if (copy) copy.onclick = async () => {
      const cmd = $('#skill-cmd', b).textContent;
      try { await navigator.clipboard.writeText(cmd); toast('Commande copiée.', { kind: 'success' }); }
      catch { toast(cmd, { kind: 'info', title: 'Copie refusée — voici la commande' }); }
    };
  });
}

function noteCardHTML(n) {
  const preview = (n.content || '').replace(/\s+/g, ' ').trim();
  const tags = n.tags || [];
  return `<div class="note-card ${n.pinned ? 'pinned' : ''}">
    <button class="note-open" type="button" data-note="${escapeAttr(n.id)}">
      <span class="note-title">${escapeHtml(n.title)}</span>
      <span class="note-preview">${escapeHtml(preview || 'Note vide')}</span>
      ${tags.length ? `<span class="tag-row">${tags.map((t) => `<span class="tag sm">#${escapeHtml(t)}</span>`).join('')}</span>` : ''}
      <span class="note-meta">${(n.content || '').length.toLocaleString('fr-FR')} caractères · modifiée ${agoText(n.updated_at)}</span>
    </button>
    <button class="note-pin ${n.pinned ? 'on' : ''}" type="button" data-pin="${escapeAttr(n.id)}"
            aria-label="${n.pinned ? 'Désépingler' : 'Épingler'}" title="${n.pinned ? 'Désépingler' : 'Épingler'}">${IC.pin}</button>
  </div>`;
}

function openNoteModal(note, prefill = {}) {
  const isEdit = !!note;
  const title0 = isEdit ? note.title : (prefill.title || '');
  const tags0 = (isEdit ? note.tags : prefill.tags) || [];

  openModal(isEdit ? 'Modifier la note' : 'Nouvelle note', (b) => {
    b.innerHTML = `
      <div class="field">
        <label for="n-title">Titre</label>
        <input id="n-title" maxlength="120" value="${escapeAttr(title0)}"
               placeholder="ex: Contexte de l'organisation">
      </div>
      <div class="field">
        <label for="n-content">Contenu</label>
        <textarea id="n-content" rows="14" maxlength="40000"
                  placeholder="Ce que tous tes agents doivent savoir…">${isEdit ? escapeHtml(note.content) : ''}</textarea>
        <div class="field-hint">
          <span id="n-count">0</span> / 40 000 caractères ·
          écris <code>[[Titre d'une note]]</code> pour la relier dans la galaxie
        </div>
        <div class="link-preview" id="n-links"></div>
      </div>
      <div class="field">
        <label for="n-tags">Tags</label>
        <input id="n-tags" maxlength="200" value="${escapeAttr(tags0.join(', '))}"
               placeholder="client, ton, process">
        <div class="field-hint">Séparés par des virgules. Servent à filtrer, pas au contexte des agents.</div>
      </div>
      <label class="checklist-item" style="padding:0">
        <input type="checkbox" id="n-pin" ${isEdit && note.pinned ? 'checked' : ''}>
        <span>Épingler — cette note passe en premier dans le contexte</span>
      </label>
      <button class="primary" id="n-save" type="button">${isEdit ? 'Enregistrer' : 'Créer la note'}</button>
      ${isEdit ? '<button class="del-link" id="n-del" type="button">Supprimer cette note</button>' : ''}`;

    const content = $('#n-content', b);
    const count = $('#n-count', b);
    const linkBox = $('#n-links', b);

    // Montre tout de suite ce que la note va relier, et ce qui n'existe pas
    // encore : sans ça, une faute dans un [[titre]] ne se voit que dans le graphe.
    const sync = () => {
      count.textContent = content.value.length.toLocaleString('fr-FR');
      const wanted = [...content.value.matchAll(/\[\[([^\]|\n]{1,120})(?:\|[^\]\n]*)?\]\]/g)]
        .map((m) => m[1].trim()).filter(Boolean);
      const seen = new Set();
      const uniq = wanted.filter((t) => {
        const k = t.toLowerCase();
        return seen.has(k) ? false : (seen.add(k), true);
      });
      linkBox.innerHTML = uniq.length ? `Liens : ${uniq.map((t) => {
        const exists = S.notes.some((n) => n.title.toLowerCase() === t.toLowerCase()
          && (!isEdit || n.id !== note.id));
        return `<span class="link-chip ${exists ? '' : 'missing'}">${escapeHtml(t)}${exists ? '' : ' · à créer'}</span>`;
      }).join('')}` : '';
    };
    content.addEventListener('input', sync);
    sync();

    $('#n-save', b).onclick = async (ev) => {
      const payload = {
        title: $('#n-title', b).value.trim() || 'Sans titre',
        content: content.value,
        pinned: $('#n-pin', b).checked ? 1 : 0,
        tags: $('#n-tags', b).value.split(',').map((t) => t.trim()).filter(Boolean),
      };
      ev.currentTarget.disabled = true;
      const r = await tryApi(
        isEdit ? api('PUT', `/api/notes/${note.id}`, payload) : api('POST', '/api/notes', payload),
        'Enregistrement');
      ev.currentTarget.disabled = false;
      if (r) {
        S.graph = null;                 // les arêtes ont bougé
        closeModal();
        toast(isEdit ? 'Note mise à jour.' : 'Note ajoutée à la mémoire.', { kind: 'success' });
      }
    };

    const del = $('#n-del', b);
    if (del) del.onclick = () => confirmModal(
      `Supprimer « ${note.title} » ?`,
      'Cette information disparaîtra du contexte de tous tes agents.',
      async () => {
        const r = await tryApi(api('DELETE', `/api/notes/${note.id}`), 'Suppression');
        if (r) { S.graph = null; closeModal(); toast('Note supprimée.', { kind: 'success' }); }
      });
  });
}

// ---- Modèle d'une conversation ---------------------------------------------
const EFFORT_LABEL = { '': 'automatique', low: 'rapide', medium: 'équilibré', high: 'approfondi' };

/** The chip in the composer: what this conversation actually runs on. */
function modelChip(c) {
  const p = c.provider_override ? S.providers.find((x) => x.id === c.provider_override) : null;
  const label = p
    ? `${p.label} · ${c.model_override || p.defaultModel}`
    : 'Modèle de chaque agent';
  const effort = c.effort ? ` · ${EFFORT_LABEL[c.effort]}` : '';
  return `<button class="model-chip ${c.provider_override ? 'on' : ''}" id="model-chip" type="button"
    title="Changer le modèle de cette conversation">
    ${IC.spark}<span>${escapeHtml(label + effort)}</span></button>`;
}

function openChannelModelModal(c) {
  openModal(`Modèle · ${c.name}`, (b) => {
    const usable = S.providers.filter((p) => p.enabled);
    const curProv = c.provider_override || '';

    b.innerHTML = `
      <p style="margin:0;color:var(--muted);line-height:1.65">
        Ce réglage ne vaut que pour <strong>cette conversation</strong>. Il remplace le modèle
        propre à chaque agent, sans modifier leur fiche.
      </p>
      <div class="field">
        <label for="cm-prov">Service</label>
        <select id="cm-prov">
          <option value="">Laisser chaque agent décider</option>
          ${usable.map((p) => `<option value="${escapeAttr(p.id)}" ${p.id === curProv ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
        </select>
      </div>
      <div class="field" id="cm-model-wrap" ${curProv ? '' : 'hidden'}>
        <label for="cm-model">Modèle</label>
        <select id="cm-model"></select>
      </div>
      <div class="field">
        <label for="cm-effort">Effort de raisonnement</label>
        <select id="cm-effort">
          ${['', 'low', 'medium', 'high'].map((e) => `<option value="${e}" ${e === (c.effort || '') ? 'selected' : ''}>${EFFORT_LABEL[e]}${e === '' ? ' (ne rien envoyer)' : ''}</option>`).join('')}
        </select>
        <div class="field-hint">
          Envoyé au service sous le nom <code>reasoning_effort</code>. Tous ne le gèrent pas —
          si le tien le refuse, tu verras une erreur explicite et il suffira de revenir sur
          « automatique ».
        </div>
      </div>
      <button class="primary" id="cm-save" type="button">Appliquer</button>
      ${c.provider_override || c.effort ? '<button class="del-link" id="cm-reset" type="button">Revenir aux réglages des agents</button>' : ''}`;

    const provSel = $('#cm-prov', b);
    const wrap = $('#cm-model-wrap', b);
    const modelSel = $('#cm-model', b);

    const syncModels = () => {
      const p = usable.find((x) => x.id === provSel.value);
      if (!p) { wrap.setAttribute('hidden', ''); return; }
      wrap.removeAttribute('hidden');
      const wanted = c.model_override && p.models.includes(c.model_override) ? c.model_override : p.defaultModel;
      modelSel.innerHTML = p.models.length
        ? p.models.map((m) => `<option value="${escapeAttr(m)}" ${m === wanted ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')
        : '<option value="">— aucun modèle listé, teste le service dans Réglages —</option>';
    };
    provSel.onchange = syncModels;
    syncModels();

    const apply = async (payload, ev) => {
      ev.currentTarget.disabled = true;
      const r = await tryApi(api('PUT', `/api/channels/${c.id}/model`, payload), 'Changement de modèle');
      ev.currentTarget.disabled = false;
      if (!r) return;
      const i = S.channels.findIndex((x) => x.id === c.id);
      if (i >= 0) S.channels[i] = r;
      closeModal();
      renderView();
      toast(payload.provider
        ? `Cette conversation tourne sur ${payload.model || payload.provider}.`
        : 'Retour aux modèles de chaque agent.', { kind: 'success' });
    };

    $('#cm-save', b).onclick = (ev) => apply({
      provider: provSel.value,
      model: provSel.value ? modelSel.value : '',
      effort: $('#cm-effort', b).value,
    }, ev);

    const reset = $('#cm-reset', b);
    if (reset) reset.onclick = (ev) => apply({ provider: '', model: '', effort: '' }, ev);
  });
}

// ---- Fournisseurs : éditeur partagé ----------------------------------------
/**
 * Add or re-key a service. Used by both the first-run wizard and Réglages.
 * The key is write-only: the server never sends it back, and an empty field
 * means "keep what is stored".
 */
function openProviderModal(provider, preset, onSaved) {
  const p = provider || {};
  const pre = preset || {};
  const isNew = !provider;
  const id = p.id || pre.id || '';
  const needsKey = p.needsKey !== undefined ? p.needsKey : (pre.needs_key !== false);

  openModal(isNew ? `Connecter ${pre.label || 'un service'}` : `Configurer ${p.label}`, (b) => {
    b.innerHTML = `
      <div class="field-row">
        <div class="field"><label for="pv-label">Nom</label>
          <input id="pv-label" maxlength="60" value="${escapeAttr(p.label || pre.label || '')}"></div>
        <div class="field" style="max-width:150px"><label for="pv-id">Identifiant</label>
          <input id="pv-id" maxlength="40" value="${escapeAttr(id)}" ${isNew ? '' : 'disabled'}></div>
      </div>
      <div class="field">
        <label for="pv-base">URL de base</label>
        <input id="pv-base" maxlength="300" placeholder="https://…/v1"
               value="${escapeAttr(p.base || pre.base_url || '')}">
        <div class="field-hint">Endpoint compatible OpenAI. Le suffixe <code>/v1</code> est ajouté s'il manque.</div>
      </div>
      <div class="field">
        <label for="pv-key">Clé API ${needsKey ? '' : '(facultative)'}</label>
        <input id="pv-key" type="password" autocomplete="off" placeholder="${p.keyConfigured ? `déjà enregistrée (${escapeAttr(p.keyHint || '••••')}) — laisser vide pour la conserver` : 'sk-…'}">
        <div class="field-hint">Stockée sur ton serveur uniquement, jamais renvoyée au navigateur.</div>
        ${keyHelpHTML(id)}
      </div>

      <!-- Certains endpoints compatibles OpenAI exigent des en-têtes en plus de
           la clé. Sans ce champ, il fallait monter un proxy juste pour en
           ajouter un — ce qui est beaucoup pour une ligne. -->
      <details class="pv-extra" ${Object.keys(p.headers || {}).length ? 'open' : ''}>
        <summary>En-têtes supplémentaires${Object.keys(p.headers || {}).length ? ` (${Object.keys(p.headers).length})` : ''}</summary>
        <div class="field" style="margin-top:10px">
          <label for="pv-headers">Un par ligne, au format <code>Nom: valeur</code></label>
          <textarea id="pv-headers" rows="3" placeholder="X-Mon-Entete: valeur">${escapeHtml(
            Object.entries(p.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'))}</textarea>
          <div class="field-hint">
            Envoyés à chaque appel. <code>Authorization</code> et <code>Host</code> sont
            ignorés : la clé ci-dessus fait foi, et détourner l'hôte n'aurait pas de sens.
          </div>
        </div>
      </details>

      <button class="btn ghost" id="pv-test" type="button">${IC.spark} Tester et lister les modèles</button>
      <div id="pv-result"></div>

      <!-- Une liste, et rien qu'une liste : on choisit parmi ce que le service
           déclare réellement servir. Un champ libre laissait saisir un modèle
           inexistant, dont l'erreur ne se découvrait qu'au premier message. -->
      <div class="field" id="pv-model-wrap">
        <label for="pv-model">Modèle par défaut</label>
        <select id="pv-model" ${(p.models && p.models.length) ? '' : 'disabled'}>
          ${(p.models && p.models.length)
            ? (p.models || []).map((m) => `<option value="${escapeAttr(m)}" ${m === p.defaultModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')
            : '<option value="">— teste la connexion pour voir les modèles —</option>'}
        </select>
        <div class="field-hint" id="pv-model-hint">
          ${(p.models && p.models.length)
            ? `${p.models.length} modèle${p.models.length > 1 ? 's' : ''} proposé${p.models.length > 1 ? 's' : ''} par ce service.`
            : 'La liste se remplit quand la connexion aboutit.'}
        </div>
      </div>

      <button class="primary" id="pv-save" type="button">${isNew ? 'Connecter le service' : 'Enregistrer'}</button>
      ${!isNew ? '<button class="del-link" id="pv-del" type="button">Retirer ce service</button>' : ''}`;

    const result = $('#pv-result', b);
    const modelSel = $('#pv-model', b);
    const modelHint = $('#pv-model-hint', b);

    const currentId = () => slugify($('#pv-id', b).value || id);

    // « Nom: valeur » par ligne. Le serveur re-filtre de toute facon : ce
    // decoupage n'est qu'une commodite de saisie.
    const readHeaders = () => {
      const out = {};
      for (const line of ($('#pv-headers', b)?.value || '').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const name = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (name && value) out[name] = value;
      }
      return out;
    };

    $('#pv-test', b).onclick = async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      result.innerHTML = '<div class="probe testing">Connexion…</div>';
      // Persist first when the provider is new, so the server has something to
      // attach the discovered models to.
      if (isNew) {
        await tryApi(api('PUT', `/api/providers/${currentId()}`, {
          label: $('#pv-label', b).value.trim() || currentId(),
          base_url: $('#pv-base', b).value.trim(),
          api_key: $('#pv-key', b).value,
          headers: readHeaders(),
          hint: pre.hint || '',
          session_header: pre.session_header || '',
          needs_key: needsKey,
        }), 'Enregistrement');
      }
      // Les en-tetes saisis sont enregistres avant le test : sinon on testerait
      // sans eux et le resultat ne dirait rien de la configuration voulue.
      if (!isNew) {
        await api('PUT', `/api/providers/${currentId()}`, { headers: readHeaders() }).catch(() => {});
      }
      const r = await tryApi(api('POST', `/api/providers/${currentId()}/test`, {
        base_url: $('#pv-base', b).value.trim(),
        api_key: $('#pv-key', b).value,
        needs_key: needsKey,
      }), 'Test');
      btn.disabled = false;
      if (!r) { result.innerHTML = ''; return; }

      if (!r.ok) {
        result.innerHTML = `<div class="probe ${r.missingKey ? 'warn' : 'bad'}">
          ${r.missingKey ? '⚠' : '✕'} ${escapeHtml(r.error || 'Échec')}</div>`;
        if (r.missingKey) $('#pv-key', b).focus();
        return;
      }
      // A green tick must not claim more than was actually verified.
      result.innerHTML = `<div class="probe good">✓ Connecté — ${r.models.length} modèle${r.models.length > 1 ? 's' : ''} disponible${r.models.length > 1 ? 's' : ''}${r.keyVerified ? ' · clé validée' : ''}</div>
        ${r.keyNote ? `<div class="probe warn" style="margin-top:6px">⚠ ${escapeHtml(r.keyNote)}</div>` : ''}`;
      if (r.models.length) {
        // Le choix déjà fait est conservé s'il figure toujours dans la liste.
        const keep = modelSel.value || p.defaultModel;
        modelSel.disabled = false;
        modelSel.innerHTML = r.models
          .map((m) => `<option value="${escapeAttr(m)}" ${m === keep ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
        modelHint.textContent = `${r.models.length} modèle${r.models.length > 1 ? 's' : ''} proposé${r.models.length > 1 ? 's' : ''} par ce service.`;
      }
    };

    $('#pv-save', b).onclick = async (ev) => {
      const base = $('#pv-base', b).value.trim();
      if (!base) { result.innerHTML = '<div class="probe bad">Une URL de base est nécessaire.</div>'; return; }
      ev.currentTarget.disabled = true;
      const r = await tryApi(api('PUT', `/api/providers/${currentId()}`, {
        label: $('#pv-label', b).value.trim() || currentId(),
        base_url: base,
        api_key: $('#pv-key', b).value,
        default_model: modelSel && modelSel.value ? modelSel.value : undefined,
        headers: readHeaders(),
        hint: p.hint || pre.hint || '',
        session_header: pre.session_header || undefined,
        needs_key: needsKey,
        enabled: true,
      }), 'Enregistrement');
      ev.currentTarget.disabled = false;
      if (!r) return;
      S.providers = r.providers;
      closeModal();
      toast(`${$('#pv-label', b).value.trim() || currentId()} enregistré.`, { kind: 'success' });
      if (onSaved) onSaved(r.providers);
      else renderView();
    };

    const del = $('#pv-del', b);
    if (del) del.onclick = () => confirmModal(
      `Retirer ${p.label} ?`,
      'Les agents qui l\'utilisaient basculeront sur un autre fournisseur disponible.',
      async () => {
        const r = await tryApi(api('DELETE', `/api/providers/${p.id}`), 'Suppression');
        if (r) {
          S.providers = r.providers;
          closeModal();
          toast('Service retiré.', { kind: 'success' });
          if (onSaved) onSaved(r.providers); else renderView();
        }
      });
  });
}

const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);

/**
 * Où trouver la clé de ce service.
 *
 * Le formulaire demandait une clé sans jamais dire où la chercher. Pour Hermes
 * c'est le pire cas : la clé n'est pas sur un site, elle est dans SA propre
 * configuration, ce qu'on ne devine pas — d'où des clés d'autres services
 * collées là par dépit.
 */
const KEY_HELP = {
  hermes: {
    where: 'Ce n\'est pas une clé achetée en ligne : c\'est la valeur de <code>API_SERVER_KEY</code> '
         + 'dans la configuration de <strong>ton</strong> Hermes — son <code>.env</code> ou son '
         + '<code>docker-compose.yml</code>. Récupère-la avec :',
    cmd: 'docker exec <conteneur-hermes> printenv API_SERVER_KEY',
    link: 'https://github.com/NousResearch/hermes-agent',
    linkLabel: 'Documentation Hermes Agent',
  },
  openrouter: { where: 'Crée une clé sur ton tableau de bord OpenRouter.', link: 'https://openrouter.ai/keys', linkLabel: 'openrouter.ai/keys' },
  openai: { where: 'Crée une clé dans la console OpenAI.', link: 'https://platform.openai.com/api-keys', linkLabel: 'platform.openai.com/api-keys' },
  gemini: { where: 'Clé gratuite sur Google AI Studio.', link: 'https://aistudio.google.com/apikey', linkLabel: 'aistudio.google.com/apikey' },
  groq: { where: 'Crée une clé dans la console Groq.', link: 'https://console.groq.com/keys', linkLabel: 'console.groq.com/keys' },
  together: { where: 'Crée une clé dans les réglages Together AI.', link: 'https://api.together.xyz/settings/api-keys', linkLabel: 'api.together.xyz' },
  agentrouter: {
    where: "Ta clé AgentRouter. Attention : ce service refuse la clé seule et exige aussi un "
         + "en-tête identifiant le client — c'est ce que fait un proxy placé devant. Si tu n'en "
         + "as pas, renseigne-le dans « En-têtes supplémentaires » et pointe l'URL directement "
         + "sur <code>https://agentrouter.org/v1</code>.",
  },
};

function keyHelpHTML(id) {
  const h = KEY_HELP[id];
  if (!h) return '';
  return `<div class="key-help">
    <div>${h.where}</div>
    ${h.cmd ? `<code class="key-cmd">${escapeHtml(h.cmd)}</code>` : ''}
    ${h.link ? `<a href="${escapeAttr(h.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(h.linkLabel)} ↗</a>` : ''}
  </div>`;
}

// ---- Assistant de première configuration -----------------------------------
const WIZ_STEPS = ['Bienvenue', 'Hermes', 'Services', 'Modèle', 'Images'];

// Services dont on sait qu'ils servent des modèles d'images, et par quel nom
// commencer. Une aide au démarrage, pas une liste fermée : le champ reste libre.
const IMAGE_SUGGESTIONS = [
  {
    id: 'openrouter', label: 'OpenRouter', model: 'google/gemini-2.5-flash-image',
    why: 'Une seule clé pour le texte et les images. C\'est la voie que je recommande.',
    price: '~0,04 € l\'image',
  },
  {
    id: 'gemini', label: 'Google Gemini', model: 'gemini-2.5-flash-image',
    why: 'Clé gratuite sur Google AI Studio, avec un quota de départ confortable.',
    price: 'gratuit puis facturé',
  },
  {
    id: 'openai', label: 'OpenAI', model: 'gpt-image-1',
    why: 'Si tu as déjà une clé OpenAI.',
    price: '~0,04 € l\'image',
  },
];

async function checkSetup(force = false) {
  const s = await tryApi(api('GET', '/api/setup'), 'Vérification de la configuration');
  if (!s) return;
  S.setup = s;
  if (force || !s.done) openWizard();
}

function openWizard() {
  if ($('#wizard')) return;
  S.wizStep = 0;
  const w = el('div', 'wizard');
  w.id = 'wizard';
  w.setAttribute('role', 'dialog');
  w.setAttribute('aria-modal', 'true');
  w.setAttribute('aria-label', 'Configuration de AgentHub');
  document.body.appendChild(w);
  renderWizard();
}

function closeWizard(markDone) {
  if (markDone) tryApi(api('POST', '/api/setup/complete'), 'Configuration');
  $('#wizard')?.remove();
  renderAll();
}

function renderWizard() {
  const w = $('#wizard');
  if (!w) return;
  const s = S.setup || {};
  const step = S.wizStep;
  const usable = (S.providers || []).filter((p) => p.enabled);

  const body = [wizWelcome, wizHermes, wizServices, wizModel, wizImages][step](s, usable);

  w.innerHTML = `
    <div class="wiz-card">
      <div class="wiz-head">
        <span class="wiz-mark" aria-hidden="true">${MARK}</span>
        <ol class="wiz-steps">
          ${WIZ_STEPS.map((label, i) => `<li class="${i === step ? 'on' : i < step ? 'done' : ''}">
            <span class="wiz-num">${i < step ? '✓' : i + 1}</span>${escapeHtml(label)}</li>`).join('')}
        </ol>
      </div>
      <div class="wiz-body">${body.html}</div>
      <div class="wiz-foot">
        ${step > 0 ? '<button class="btn ghost" id="wiz-back" type="button">Retour</button>' : ''}
        <span style="flex:1"></span>
        <button class="btn ghost" id="wiz-skip" type="button">Configurer plus tard</button>
        <button class="btn" id="wiz-next" type="button" ${body.nextDisabled ? 'disabled' : ''}>${body.nextLabel}</button>
      </div>
    </div>`;

  if (body.wire) body.wire(w);
  const back = $('#wiz-back', w);
  if (back) back.onclick = () => { S.wizStep--; renderWizard(); };
  $('#wiz-skip', w).onclick = () => closeWizard(true);
  $('#wiz-next', w).onclick = async () => {
    if (body.onNext && (await body.onNext()) === false) return;
    if (step === WIZ_STEPS.length - 1) closeWizard(true);
    else { S.wizStep++; renderWizard(); }
  };
}

function wizWelcome(s) {
  return {
    nextLabel: 'Commencer',
    html: `
      <h2 class="wiz-title">Bienvenue dans AgentHub.</h2>
      <p class="wiz-lede">Quatre étapes pour que ton organisation d'agents se mette au
        travail. Compte trois minutes.</p>
      <ul class="wiz-list">
        <li><span class="wiz-li-ic">1</span><div><strong>Hermes</strong> — on vérifie qu'il répond et ce qu'il propose.</div></li>
        <li><span class="wiz-li-ic">2</span><div><strong>Services</strong> — AgentRouter, OpenRouter, Gemini, OpenAI, Ollama… tu choisis.</div></li>
        <li><span class="wiz-li-ic">3</span><div><strong>Modèle</strong> — celui que tes agents utiliseront pour écrire.</div></li>
        <li><span class="wiz-li-ic">4</span><div><strong>Images</strong> — le modèle qui dessinera, si tu veux que tes agents illustrent.</div></li>
      </ul>
      <p class="wiz-note">
        <strong>Ce qu'il te faut :</strong> au moins une clé API. Une seule clé
        <strong>OpenRouter</strong> couvre à la fois le texte et les images — c'est le plus
        simple pour démarrer. Sinon, une clé <strong>Google Gemini</strong> (gratuite sur AI
        Studio) fait aussi les deux.
      </p>
      ${s.agents ? `<p class="wiz-note muted-note">Ton organisation compte déjà ${s.agents} agent${s.agents > 1 ? 's' : ''} et ${s.channels} salon${s.channels > 1 ? 's' : ''}.</p>` : ''}`,
  };
}

function wizHermes(s) {
  const h = s.hermes || {};

  /*
   * Trois pannes distinctes, trois dépannages différents.
   *
   * Tout ce qui n'était pas joignable s'annonçait « Hermes ne répond pas »,
   * suivi d'une liste de vérifications réseau — alors que la cause la plus
   * fréquente au premier démarrage est simplement qu'aucune clé n'a encore été
   * saisie. On envoyait donc l'utilisateur inspecter ses réseaux Docker pour un
   * champ vide.
   */
  const noKey = h.configured && !h.keyConfigured;
  const state = h.reachable ? 'good' : noKey || !h.configured ? 'warn' : 'bad';
  const title = h.reachable ? 'Hermes répond'
    : !h.configured ? "Hermes n'est pas configuré"
    : noKey ? "Il manque la clé d'Hermes"
    : 'Hermes ne répond pas';

  return {
    nextLabel: 'Suivant',
    html: `
      <h2 class="wiz-title">Hermes Agent</h2>
      <p class="wiz-lede">Hermes apporte la continuité de session, ses outils et sa mémoire
        persistante. AgentHub fonctionne sans, mais c'est mieux avec.</p>
      <div class="check-row ${state}">
        <span class="check-ic">${h.reachable ? '✓' : state === 'bad' ? '✕' : '!'}</span>
        <div class="check-main">
          <div class="check-title">${title}</div>
          <div class="check-detail">
            ${h.configured ? `<code>${escapeHtml(h.base)}</code>` : 'Aucune URL enregistrée.'}
            ${h.reachable ? ` · ${h.models.length} modèle${h.models.length > 1 ? 's' : ''}` : ''}
            ${h.error && !noKey ? `<br>${escapeHtml(h.error)}` : ''}
          </div>
        </div>
      </div>

      ${h.reachable ? '' : noKey ? `
        <div class="wiz-help">
          <strong>C'est la seule chose qui manque.</strong>
          <p style="margin:8px 0 0;line-height:1.75">
            Ce n'est pas une clé achetée en ligne : c'est la valeur de
            <code>API_SERVER_KEY</code> dans la configuration de <strong>ton</strong> Hermes.
            Récupère-la en une commande&nbsp;:
          </p>
          <code class="key-cmd" style="margin-top:8px">docker exec &lt;conteneur-hermes&gt; printenv API_SERVER_KEY</code>
          <p style="margin:10px 0 0;line-height:1.75">
            <a href="https://github.com/NousResearch/hermes-agent" target="_blank" rel="noopener noreferrer">Documentation Hermes Agent ↗</a>
          </p>
          <p style="margin:10px 0 0;line-height:1.75">
            Tu peux aussi passer cette étape : AgentHub marche très bien sans Hermes,
            avec n'importe quel autre service.
          </p>
        </div>` : `
        <div class="wiz-help">
          <strong>Dans l'ordre :</strong>
          <ol style="margin:8px 0 0;padding-left:20px;line-height:1.75">
            <li>Hermes tourne-t-il ? <code>docker ps | grep hermes</code></li>
            <li><strong>Les deux conteneurs partagent-ils un réseau ?</strong> C'est la
              cause la plus fréquente : sans réseau commun, le nom
              <code>hermes-agent</code> ne résout pas. Décommente le bloc
              <code>networks:</code> de <code>docker-compose.yml</code> avec le nom
              renvoyé par&nbsp;:<br>
              <code>docker inspect &lt;conteneur-hermes&gt; --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}'</code></li>
            <li>L'URL correspond-elle au nom réel du conteneur et à son port&nbsp;?</li>
            <li>La clé correspond-elle à <code>API_SERVER_KEY</code> côté Hermes&nbsp;?</li>
          </ol>
        </div>`}
      <div id="wiz-h-scan"></div>

      <div class="btn-row" style="margin-top:14px">
        ${h.reachable ? '' : '<button class="btn" id="wiz-h-detect" type="button">Détecter Hermes automatiquement</button>'}
        <button class="btn ghost" id="wiz-h-edit" type="button">Configurer à la main</button>
        <button class="btn ghost" id="wiz-h-retry" type="button">Revérifier</button>
      </div>`,
    wire: (w) => {
      const scan = $('#wiz-h-scan', w);
      const detect = $('#wiz-h-detect', w);
      if (detect) detect.onclick = (e) => runHermesDetection(e.currentTarget, scan);

      $('#wiz-h-retry', w).onclick = async (e) => {
        e.currentTarget.disabled = true;
        await checkSetupSilently();
        renderWizard();
      };
      $('#wiz-h-edit', w).onclick = () => {
        const prov = (S.providers || []).find((p) => p.id === 'hermes');
        openProviderModal(prov, (S.presets || []).find((x) => x.id === 'hermes'), async () => {
          await checkSetupSilently();
          renderWizard();
        });
      };
    },
  };
}

function wizServices(s, usable) {
  const known = S.presets || [];
  const connected = new Set((S.providers || []).map((p) => p.id));
  return {
    nextLabel: 'Suivant',
    nextDisabled: usable.length === 0,
    html: `
      <h2 class="wiz-title">Connecte tes services</h2>
      <p class="wiz-lede">Chaque agent pourra ensuite utiliser le service et le modèle de ton
        choix. Il en faut au moins un pour continuer.</p>
      <div class="service-grid">
        ${(S.providers || []).map((p) => `
          <button class="service-card ${p.enabled ? 'on' : ''}" data-edit="${escapeAttr(p.id)}" type="button">
            <span class="service-top">
              <span class="provider-state ${p.enabled ? 'on' : 'off'}"></span>
              <span class="service-name">${escapeHtml(p.label)}</span>
              ${p.enabled ? `<span class="pill done">${p.models.length} modèle${p.models.length > 1 ? 's' : ''}</span>`
                : `<span class="pill failed">${p.needsKey && !p.keyConfigured ? 'clé requise' : 'à configurer'}</span>`}
            </span>
            <span class="service-hint">${escapeHtml(p.hint || p.base)}</span>
          </button>`).join('')}
        ${known.filter((k) => !connected.has(k.id)).map((k) => `
          <button class="service-card add" data-add="${escapeAttr(k.id)}" type="button">
            <span class="service-top">
              <span class="service-plus">+</span>
              <span class="service-name">${escapeHtml(k.label)}</span>
              ${k.local ? '<span class="pill pending">local</span>' : ''}
            </span>
            <span class="service-hint">${escapeHtml(k.hint)}</span>
          </button>`).join('')}
      </div>
      <button class="btn ghost" id="wiz-custom" type="button" style="margin-top:16px">${IC.plus} Service compatible OpenAI…</button>`,
    wire: (w) => {
      const refresh = async (providers) => {
        if (providers) S.providers = providers;
        await checkSetupSilently();
        renderWizard();
      };
      $$('[data-edit]', w).forEach((n) => n.onclick = () => {
        const prov = (S.providers || []).find((p) => p.id === n.dataset.edit);
        openProviderModal(prov, known.find((k) => k.id === n.dataset.edit), refresh);
      });
      $$('[data-add]', w).forEach((n) => n.onclick = () => {
        openProviderModal(null, known.find((k) => k.id === n.dataset.add), refresh);
      });
      $('#wiz-custom', w).onclick = () => openProviderModal(null, { id: '', label: '', needs_key: true }, refresh);
    },
  };
}

function wizModel(s, usable) {
  const chosen = S.wizProvider && usable.find((p) => p.id === S.wizProvider) ? S.wizProvider : (usable[0] || {}).id;
  const prov = usable.find((p) => p.id === chosen);
  return {
    nextLabel: 'Suivant',
    nextDisabled: !prov,
    html: `
      <h2 class="wiz-title">Le modèle par défaut</h2>
      <p class="wiz-lede">Il sera appliqué à tes agents existants. Tu pourras toujours en
        changer agent par agent depuis sa fiche.</p>
      ${!prov ? emptyBox('🔌', 'Aucun service utilisable. Reviens à l\'étape précédente.') : `
        <div class="field-row">
          <div class="field"><label for="wz-prov">Service</label>
            <select id="wz-prov">${usable.map((p) => `<option value="${escapeAttr(p.id)}" ${p.id === chosen ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}</select>
          </div>
          <div class="field"><label for="wz-model">Modèle</label>
            <select id="wz-model" ${prov.models.length ? '' : 'disabled'}>
              ${prov.models.length
                ? prov.models.map((m) => `<option value="${escapeAttr(m)}" ${m === prov.defaultModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')
                : '<option value="">— aucun modèle listé —</option>'}
            </select>
            ${prov.models.length ? '' : `<div class="field-hint">Ce service n'a listé aucun modèle.
              Retourne à l'étape précédente et teste la connexion.</div>`}
          </div>
        </div>
        <label class="checklist-item" style="padding:0;margin-top:12px">
          <input type="checkbox" id="wz-apply" checked>
          <span>Appliquer à mes ${s.agents || 0} agent${(s.agents || 0) > 1 ? 's' : ''} existant${(s.agents || 0) > 1 ? 's' : ''}</span>
        </label>`}`,
    wire: (w) => {
      const sel = $('#wz-prov', w);
      if (sel) sel.onchange = () => { S.wizProvider = sel.value; renderWizard(); };
    },
    onNext: async () => {
      const sel = $('#wz-prov');
      const mod = $('#wz-model');
      const apply = $('#wz-apply');
      if (!sel || !apply || !apply.checked) return true;
      const payload = { provider: sel.value, model: mod && mod.value ? mod.value : undefined };
      for (const a of S.agents) {
        await tryApi(api('PUT', `/api/agents/${a.id}`, payload), 'Application du modèle');
      }
      toast(`Modèle appliqué à ${S.agents.length} agent${S.agents.length > 1 ? 's' : ''}.`, { kind: 'success' });
      return true;
    },
  };
}

/**
 * Cherche Hermes sur le serveur, puis propose ce qui a du sens.
 *
 * Trois issues : il est là et sa clé est lisible — un clic suffit ; il est là
 * mais la clé n'est pas accessible d'ici — on demande juste la clé ; il n'y est
 * pas — on propose de l'installer, automatiquement si AgentHub en a le droit,
 * à la main sinon.
 */
async function runHermesDetection(btn, box) {
  btn.disabled = true;
  box.innerHTML = '<div class="probe testing">Recherche d\'Hermes sur ton serveur…</div>';

  const r = await tryApi(api('GET', '/api/hermes/discover'), 'Détection');
  btn.disabled = false;
  if (!r) { box.innerHTML = ''; return; }

  if (r.found.length) {
    const f = r.found[0];
    box.innerHTML = `
      <div class="probe good">✓ Hermes trouvé — <code>${escapeHtml(f.name)}</code>${f.image ? ` (${escapeHtml(f.image)})` : ''}</div>
      <div class="scan-detail">
        ${escapeHtml(f.base_url)}
        ${f.shared === false ? `<br>Il tourne sur le réseau <code>${escapeHtml(f.networks[0] || '?')}</code>, qu'AgentHub ne partage pas${r.docker.available ? " — il s'y raccordera tout seul." : '. Sans accès au moteur Docker, il faudra les relier à la main.'}` : ''}
        ${f.key ? '<br>Sa clé a été lue directement dans sa configuration : rien à copier.' : '<br>Sa clé n\'est pas lisible d\'ici — il faudra la saisir.'}
      </div>
      <button class="primary" id="scan-adopt" type="button" style="margin-top:10px">
        ${f.key ? 'Utiliser cet Hermes' : 'Saisir la clé et l\'utiliser'}</button>`;

    $('#scan-adopt', box).onclick = async (e) => {
      if (!f.key) {
        // Pas de clé lisible : on ouvre la fiche, déjà remplie de l'URL trouvée.
        const prov = (S.providers || []).find((p) => p.id === 'hermes');
        openProviderModal({ ...(prov || {}), id: 'hermes', label: 'Hermes', base: f.base_url },
          (S.presets || []).find((k) => k.id === 'hermes'),
          async () => { await checkSetupSilently(); renderWizard(); });
        return;
      }
      e.currentTarget.disabled = true;
      const a = await tryApi(api('POST', '/api/hermes/adopt', { name: f.name }), 'Enregistrement');
      if (!a) { e.currentTarget.disabled = false; return; }
      if (a.joined) toast(`AgentHub raccordé au réseau ${a.joined}.`, { kind: 'info' });

      if (a.reachable) {
        toast(`Hermes branché — ${a.models.length} modèle(s).`, { kind: 'success' });
        await checkSetupSilently();
        renderWizard();
        return;
      }

      // Enregistré mais muet. « Il ne répond pas encore » est vrai et inutile :
      // on cherche pourquoi, et on propose de le réparer quand c'est possible.
      toast('Hermes enregistré, mais sa passerelle ne répond pas. Diagnostic…', { kind: 'warn' });
      await showGatewayDiagnosis(f.name, box);
    };
    return;
  }

  // Rien trouvé.
  box.innerHTML = `
    <div class="probe warn">⚠ Aucune passerelle Hermes sur ce serveur.</div>
    ${r.canInstall ? `
      <div class="scan-detail">AgentHub peut l'installer pour toi : il téléchargera l'image officielle
        Nous Research, créera le conteneur sur un réseau partagé et se branchera dessus.
        Compte plusieurs minutes — l'image fait près de 4 Go.</div>
      <button class="primary" id="scan-install" type="button" style="margin-top:10px">Installer Hermes</button>
      <div id="scan-log" class="scan-log hidden"></div>`
    : `
      <div class="scan-detail">
        AgentHub ne peut pas l'installer lui-même : cela demanderait de lui donner accès au
        socket Docker, ce qui revient à lui donner les droits root sur ton serveur.
        Ce n'est pas activé par défaut, et c'est délibéré.<br><br>
        Lance plutôt ceci sur ton serveur — c'est exactement ce qu'AgentHub ferait :
      </div>
      <div class="cmd-row" style="margin-top:10px">
        <code id="scan-plan">${escapeHtml((r.plan?.commands || []).join('\n'))}</code>
        <button class="btn sm" id="scan-copy" type="button">Copier</button>
      </div>
      <details class="scan-compose" style="margin-top:10px">
        <summary>Voir le fichier <code>hermes-agent.yml</code></summary>
        <pre>${escapeHtml(r.plan?.compose || '')}</pre>
      </details>`}`;

  const copy = $('#scan-copy', box);
  if (copy) copy.onclick = async () => {
    const text = `${r.plan.compose}\n\n# puis :\n${r.plan.commands.join('\n')}`;
    try { await navigator.clipboard.writeText(text); toast('Fichier et commandes copiés.', { kind: 'success' }); }
    catch { toast('Copie refusée par le navigateur.', { kind: 'warn' }); }
  };

  const install = $('#scan-install', box);
  if (install) install.onclick = () => streamHermesInstall(install, $('#scan-log', box));
}

/**
 * Explique pourquoi la passerelle se tait, et propose de la démarrer.
 *
 * Le cas courant, rencontré sur une installation neuve : l'image d'Hermes
 * distribuée par certains hébergeurs ne lance sa passerelle que si un fichier
 * de configuration existe déjà. Il n'existe pas encore, donc l'API n'écoute
 * jamais — alors qu'elle démarrerait très bien sans lui.
 */
async function showGatewayDiagnosis(name, box) {
  const d = await tryApi(api('GET', `/api/hermes/diagnose?name=${encodeURIComponent(name)}`), 'Diagnostic');
  if (!d) return;

  box.innerHTML = `
    <div class="probe ${d.fixable ? 'warn' : 'bad'}">${d.fixable ? '⚠' : '✕'} ${escapeHtml(d.detail)}</div>
    ${d.fixable ? `
      <div class="scan-detail">AgentHub peut la démarrer pour toi. C'est instantané, et sans effet
        sur la configuration d'Hermes.</div>
      <button class="primary" id="gw-start" type="button" style="margin-top:10px">Démarrer la passerelle</button>
      <div id="gw-log" class="scan-log hidden"></div>`
    : `<div class="scan-detail">Une fois corrigé, reviens ici et clique <strong>Revérifier</strong>.</div>`}`;

  const btn = $('#gw-start', box);
  if (btn) btn.onclick = () => streamGatewayStart(name, btn, $('#gw-log', box));
}

/** Démarrage de la passerelle, progression en direct. */
async function streamGatewayStart(name, btn, log) {
  btn.disabled = true;
  log.classList.remove('hidden');
  log.textContent = '';
  const line = (t) => { log.textContent += (log.textContent ? '\n' : '') + t; log.scrollTop = log.scrollHeight; };

  let resp;
  try {
    resp = await fetch('/api/hermes/start-gateway', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
  } catch (err) { line(`Échec : ${err.message}`); btn.disabled = false; return; }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = null;
  for (;;) {
    const { done: fin, value } = await reader.read();
    if (fin) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!raw) continue;
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.type === 'progress') line(ev.message);
      else { done = ev; }
    }
  }

  btn.disabled = false;
  if (done && done.type === 'done') {
    line(done.already
      ? `La passerelle répondait déjà — ${done.models.length} modèle(s).`
      : `La passerelle répond après ${done.seconds} s — ${done.models.length} modèle(s).`);
    // Honnêteté sur la durée de vie : sur les images qui n'attendent qu'un
    // fichier de configuration pour lancer la passerelle, un redémarrage du
    // conteneur la remettra à l'arrêt. Autant le dire tout de suite.
    line('\nNote : tant qu\'Hermes n\'a pas été configuré depuis son propre tableau de bord,'
      + ' un redémarrage de son conteneur arrêtera de nouveau la passerelle. Il suffira de'
      + ' recliquer ici, ou de terminer sa configuration pour que ce soit définitif.');
    toast('Hermes est opérationnel.', { kind: 'success' });
    await checkSetupSilently();
    renderWizard();
  } else if (done) {
    line(done.detail || 'Échec.');
    // Le journal d'Hermes dit précisément ce qui a coincé.
    if (done.log) line(`\n--- journal d'Hermes ---\n${done.log}`);
  }
}

/**
 * Installation, avec la progression en direct.
 *
 * Le serveur répond en NDJSON plutôt qu'en une seule fois : télécharger quatre
 * gigaoctets prend plusieurs minutes, et un écran figé pendant ce temps se lit
 * comme une panne.
 */
async function streamHermesInstall(btn, log) {
  btn.disabled = true;
  log.classList.remove('hidden');
  log.textContent = '';
  const line = (t) => {
    log.textContent += (log.textContent ? '\n' : '') + t;
    log.scrollTop = log.scrollHeight;
  };

  let resp;
  try {
    resp = await fetch('/api/hermes/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch (err) {
    line(`Échec : ${err.message}`);
    btn.disabled = false;
    return;
  }

  if (!resp.ok && resp.headers.get('content-type')?.includes('json')) {
    const j = await resp.json().catch(() => ({}));
    line(j.error || `HTTP ${resp.status}`);
    btn.disabled = false;
    return;
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = null;
  for (;;) {
    const { done: fin, value } = await reader.read();
    if (fin) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!raw) continue;
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.type === 'progress') line(ev.message);
      else if (ev.type === 'error') { line(`Échec : ${ev.error}`); done = ev; }
      else if (ev.type === 'done') { done = ev; }
    }
  }

  btn.disabled = false;
  if (done && done.type === 'done') {
    line(done.reachable ? `Hermes répond — ${done.models.length} modèle(s).` : (done.warning || 'Conteneur démarré.'));
    toast('Hermes installé et branché.', { kind: 'success' });
    await checkSetupSilently();
    renderWizard();
  }
}

/**
 * Dernière étape : le modèle qui dessine.
 *
 * C'est le point le plus opaque de l'installation — les services de texte ne
 * servent pas forcément d'images, et rien dans un catalogue ne dit lesquels le
 * font. On propose donc des couples service + modèle connus pour marcher,
 * plutôt que de laisser deux champs vides devant l'utilisateur.
 */
function wizImages(s, usable) {
  const current = S.settings.image_provider && S.settings.image_model
    ? { id: S.settings.image_provider, model: S.settings.image_model } : null;
  const connected = new Set(usable.map((p) => p.id));
  const label = (id) => (S.providers || []).find((p) => p.id === id)?.label || id;

  // Les modèles au nom évocateur trouvés chez les services déjà branchés.
  const found = [];
  for (const p of usable) {
    for (const m of p.models) {
      if (/image|dall|flux|imagen|nano-banana/i.test(m)) found.push({ id: p.id, label: p.label, model: m });
    }
  }

  return {
    nextLabel: 'Terminer',
    html: `
      <h2 class="wiz-title">Faire dessiner tes agents</h2>
      <p class="wiz-lede">Si tu veux qu'ils produisent des illustrations, des logos ou des
        maquettes dans les conversations, il leur faut un modèle d'image. C'est facultatif —
        tout le reste fonctionne sans.</p>

      ${current ? `
        <div class="check-row good">
          <span class="check-ic">✓</span>
          <div class="check-main">
            <div class="check-title">${escapeHtml(label(current.id))} · ${escapeHtml(current.model)}</div>
            <div class="check-detail">Tes agents peuvent créer des images.</div>
          </div>
        </div>` : `
        <div class="check-row warn">
          <span class="check-ic">!</span>
          <div class="check-main">
            <div class="check-title">Aucun modèle d'image</div>
            <div class="check-detail">L'outil de dessin restera indisponible, et tes agents
              le diront au lieu de promettre une image qui n'arrivera pas.</div>
          </div>
        </div>`}

      ${found.length ? `
        <div class="wiz-sub">Trouvé chez tes services déjà connectés</div>
        <div class="pick-grid">
          ${found.slice(0, 6).map((f) => `
            <button class="pick-card ${current && current.id === f.id && current.model === f.model ? 'on' : ''}"
                    type="button" data-pick="${escapeAttr(f.id)}" data-model="${escapeAttr(f.model)}">
              <span class="pick-name">${escapeHtml(f.model)}</span>
              <span class="pick-why">chez ${escapeHtml(f.label)}</span>
            </button>`).join('')}
        </div>` : ''}

      <div class="wiz-sub">${found.length ? 'Ou connecte un service dédié' : 'Choisis un service'}</div>
      <div class="pick-grid">
        ${IMAGE_SUGGESTIONS.map((sug) => `
          <button class="pick-card ${connected.has(sug.id) ? '' : 'todo'}" type="button" data-sug="${escapeAttr(sug.id)}">
            <span class="pick-name">${escapeHtml(sug.label)}
              ${connected.has(sug.id) ? '<span class="pill done">connecté</span>' : '<span class="pill pending">clé requise</span>'}</span>
            <span class="pick-why">${escapeHtml(sug.why)}</span>
            <span class="pick-meta"><code>${escapeHtml(sug.model)}</code> · ${escapeHtml(sug.price)}</span>
          </button>`).join('')}
      </div>

      <div class="wiz-help" style="margin-top:16px">
        Tu peux revenir là-dessus n'importe quand dans <strong>Réglages → Images</strong>,
        et changer de modèle sans rien casser.
      </div>`,
    wire: (w) => {
      // Un modèle déjà disponible : un clic suffit.
      $$('[data-pick]', w).forEach((b) => b.onclick = async () => {
        const res = await tryApi(api('PUT', '/api/settings', {
          image_provider: b.dataset.pick, image_model: b.dataset.model,
        }), 'Enregistrement');
        if (res) {
          S.settings = res;
          toast('Tes agents peuvent maintenant dessiner.', { kind: 'success' });
          renderWizard();
        }
      });

      // Un service à connecter : on ouvre sa fiche, puis on retient le modèle
      // suggéré dès que la clé est acceptée.
      $$('[data-sug]', w).forEach((b) => b.onclick = () => {
        const sug = IMAGE_SUGGESTIONS.find((x) => x.id === b.dataset.sug);
        const prov = (S.providers || []).find((p) => p.id === sug.id);
        openProviderModal(prov, (S.presets || []).find((k) => k.id === sug.id), async (providers) => {
          if (providers) S.providers = providers;
          await checkSetupSilently();
          const now = (S.providers || []).find((p) => p.id === sug.id);
          if (now && now.enabled) {
            const model = now.models.includes(sug.model) ? sug.model
              : now.models.find((m) => /image|dall|flux|imagen/i.test(m)) || sug.model;
            const res = await tryApi(api('PUT', '/api/settings', {
              image_provider: sug.id, image_model: model,
            }), 'Enregistrement');
            if (res) S.settings = res;
          }
          renderWizard();
        });
      });
    },
  };
}

async function checkSetupSilently() {
  const s = await tryApi(api('GET', '/api/setup'), 'Vérification');
  if (s) { S.setup = s; S.providers = s.providers; }
}

// ---- Consommation ----------------------------------------------------------
const RANGES = [['24h', '24 heures'], ['7d', '7 jours'], ['30d', '30 jours']];
const fmtTokens = (n) => (n >= 1000000 ? (n / 1000000).toFixed(1) + ' M'
  : n >= 1000 ? (n / 1000).toFixed(1) + ' k' : String(n || 0));

function renderUsage(v) {
  const u = S.usage;
  const totalTokens = u ? u.tokensIn + u.tokensOut : 0;

  v.innerHTML = `<div class="page">
    <div class="page-head"><h1>Consommation</h1>
      <div class="tabs" style="margin:0">
        ${RANGES.map(([k, lb]) => `<button class="tab ${S.usageRange === k ? 'active' : ''}"
          data-range="${k}" type="button">${lb}</button>`).join('')}
      </div>
    </div>
    <p class="page-lede">Ce que tes agents ont réellement consommé auprès des fournisseurs.</p>

    ${!u ? '<div class="sk sk-stat"></div>' : `
      <div class="stat-grid">
        ${statCard('Dépense', IC.spark, fmtMoney(u.cost), costCaption(u))}
        ${statCard('Tokens envoyés', IC.arrow, fmtTokens(u.tokensIn), 'contexte + instructions')}
        ${statCard('Tokens reçus', IC.chat, fmtTokens(u.tokensOut), 'réponses des agents')}
        ${statCard('Appels modèle', IC.bolt, u.calls, 'requêtes envoyées')}
      </div>

      ${u.unpricedCalls && u.calls ? `<div class="price-warn">
        ${u.unpricedCalls} appel${u.unpricedCalls > 1 ? 's' : ''} sur ${u.calls} tourne${u.unpricedCalls > 1 ? 'nt' : ''} sur un modèle sans tarif renseigné —
        la dépense affichée est donc un plancher, pas un total.
        <button class="link-btn" id="go-prices" type="button">Renseigner les prix</button>
      </div>` : ''}

      ${u.calls === 0 ? emptyBox('📊', "Aucun appel sur cette période. Écris à un pôle et les compteurs se rempliront.") : `
        <div class="section-title">Évolution
          <small>${u.bucketMs < 86400000 ? 'heure par heure' : 'jour par jour'}</small></div>
        ${usageChart(u.series, u.bucketMs)}

        <div class="section-title">Par modèle</div>
        <div class="usage-table">
          ${u.byModel.map((r) => usageRow(
            `${escapeHtml(r.provider)} · ${escapeHtml(r.model)}`,
            r.calls, r.tokens_in + r.tokens_out, totalTokens, null,
            r.priced ? r.cost : null)).join('')}
        </div>

        <div class="section-title">Par agent</div>
        <div class="usage-table">
          ${u.byAgent.map((r) => {
            const a = agentById(r.agent_id);
            return usageRow(a ? escapeHtml(a.name) : 'agent supprimé',
              r.calls, r.tokens_in + r.tokens_out, totalTokens, a, r.cost);
          }).join('') || '<div class="muted" style="padding:12px">Aucun agent sur la période.</div>'}
        </div>

        ${u.byChannel && u.byChannel.length ? `
          <div class="section-title">Par salon</div>
          <div class="usage-table">
            ${u.byChannel.map((r) => {
              const c = channelById(r.channel_id);
              return usageRow(c ? `${c.emoji || ''} ${escapeHtml(c.name)}`.trim() : 'salon supprimé',
                r.calls, r.tokens_in + r.tokens_out, totalTokens, null, r.cost);
            }).join('')}
          </div>` : ''}
      `}

      <div class="field-hint" style="margin-top:22px;line-height:1.7">
        ${u.estimated
          ? "Les fournisseurs branchés ne renvoient pas de décompte par requête : ces chiffres sont estimés à environ 4 caractères par token. L'ordre de grandeur et les tendances sont fiables, pas le chiffre exact."
          : 'Chiffres renvoyés directement par le fournisseur.'}
      </div>
    `}
  </div>`;

  $$('[data-range]', v).forEach((n) => n.onclick = () => { S.usageRange = n.dataset.range; loadUsage(); });
  const goPrices = $('#go-prices', v);
  if (goPrices) goPrices.onclick = () => openPricesModal();
  if (u && u.series) wireChart(v, u.series, u.bucketMs);
}

/**
 * Tarifs par modèle, en euros par million de tokens.
 *
 * Rien n'est pré-rempli : les grilles bougent, et un prix inventé par l'app
 * serait pire que pas de prix du tout — il aurait l'air juste. Les modèles
 * réellement appelés sont proposés, à toi de coller les tarifs de ton contrat.
 */
async function openPricesModal() {
  const data = await tryApi(api('GET', '/api/prices'), 'Chargement des tarifs');
  if (!data) return;

  openModal('Tarifs des modèles', (b) => {
    const known = new Map(data.prices.map((p) => [p.id, p]));
    // Tout ce qui a déjà consommé, plus tout ce qui est déjà tarifé.
    const rows = [...data.seen];
    for (const p of data.prices) {
      if (!rows.some((r) => r.provider === p.provider && r.model === p.model)) {
        rows.push({ provider: p.provider, model: p.model });
      }
    }

    b.innerHTML = `
      <p class="field-hint" style="margin-bottom:14px;line-height:1.7">
        En <strong>euros par million de tokens</strong>, comme les fournisseurs les publient.
        Un modèle laissé à zéro est compté comme non tarifé : sa dépense n'est pas inventée,
        elle est signalée comme manquante.
      </p>
      ${rows.length ? `<div class="price-table">
        <div class="price-head"><span>Modèle</span><span>Entrée</span><span>Sortie</span></div>
        ${rows.map((r) => {
          const id = `${r.provider}:${String(r.model).toLowerCase()}`;
          const p = known.get(id);
          return `<div class="price-row" data-provider="${escapeAttr(r.provider)}" data-model="${escapeAttr(r.model)}">
            <span class="price-name"><strong>${escapeHtml(r.model)}</strong><small>${escapeHtml(r.provider)}</small></span>
            <input type="number" min="0" step="0.01" class="price-in" value="${p ? p.in_per_m : ''}" placeholder="0">
            <input type="number" min="0" step="0.01" class="price-out" value="${p ? p.out_per_m : ''}" placeholder="0">
          </div>`;
        }).join('')}
      </div>` : '<div class="empty">Aucun modèle appelé pour l\'instant.</div>'}
      <div class="field" style="margin-top:18px">
        <label for="p-budget">Alerte de dépense quotidienne (€)</label>
        <input id="p-budget" type="number" min="0" step="1" value="${escapeAttr(S.settings.daily_budget || '')}" placeholder="ex : 5">
        <div class="field-hint">Laisse vide pour ne pas être prévenu. L'alerte n'arrête rien, elle avertit.</div>
      </div>
      <button class="primary" id="p-save" type="button">Enregistrer</button>`;

    $('#p-save', b).onclick = async (ev) => {
      ev.currentTarget.disabled = true;
      for (const row of $$('.price-row', b)) {
        const inV = Number($('.price-in', row).value) || 0;
        const outV = Number($('.price-out', row).value) || 0;
        // Une ligne laissée vide reste non tarifée : on ne crée pas un prix à zéro,
        // qui ferait passer le modèle pour gratuit dans les totaux.
        if (!inV && !outV) continue;
        await api('PUT', '/api/prices', {
          provider: row.dataset.provider, model: row.dataset.model,
          in_per_m: inV, out_per_m: outV,
        }).catch(() => {});
      }
      await tryApi(api('PUT', '/api/settings', { daily_budget: $('#p-budget', b).value.trim() }), 'Budget');
      ev.currentTarget.disabled = false;
      closeModal();
      toast('Tarifs enregistrés.', { kind: 'success' });
      loadUsage();
    };
  });
}

function usageRow(label, calls, tokens, total, agent, cost) {
  const pct = total ? Math.round((tokens / total) * 100) : 0;
  return `<div class="usage-row">
    ${agent ? avatarHTML(agent, { size: 26 }) : '<span class="usage-dot"></span>'}
    <span class="usage-label">${label}</span>
    <span class="usage-bar"><span style="width:${pct}%"></span></span>
    ${cost === null || cost === undefined
      ? '<span class="usage-cost muted" title="Aucun tarif renseigné pour ce modèle">— €</span>'
      : `<span class="usage-cost">${fmtMoney(cost)}</span>`}
    <span class="usage-num">${fmtTokens(tokens)}</span>
    <span class="usage-calls">${calls} appel${calls > 1 ? 's' : ''}</span>
  </div>`;
}

/**
 * Euros with a precision that matches the amount: 0,0043 € is a real figure at
 * this scale, and rounding it to 0,00 € would read as free.
 */
function fmtMoney(v) {
  const n = Number(v) || 0;
  if (n === 0) return '0 €';
  const digits = n < 0.01 ? 4 : n < 1 ? 3 : 2;
  return n.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + ' €';
}

const costCaption = (u) => {
  if (!u.calls) return 'aucun appel';
  if (u.fullyPriced) return u.estimated ? 'sur des tokens estimés' : 'sur des tokens comptés';
  return u.cost > 0 ? 'au moins — tarifs incomplets' : 'aucun tarif renseigné';
};

/**
 * Monotone cubic interpolation (Fritsch–Carlson).
 *
 * Chosen over Catmull-Rom because it provably cannot overshoot: a run of zeros
 * stays pinned to the baseline instead of dipping below it, and a spike does
 * not ring afterwards. That is what makes the curve read as data rather than
 * decoration.
 */
function monotonePath(pts) {
  const n = pts.length;
  if (n < 2) return '';
  const r = (v) => Math.round(v * 100) / 100;

  const dx = [], delta = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    delta[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
  }

  const m = [delta[0]];
  for (let i = 1; i < n - 1; i++) {
    m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
  }
  m[n - 1] = delta[n - 2];

  // Clamp the tangents into the Fritsch–Carlson monotonicity region.
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / delta[i];
    const b = m[i + 1] / delta[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * delta[i];
      m[i + 1] = tau * b * delta[i];
    }
  }

  let d = `M${r(pts[0][0])},${r(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${r(pts[i][0] + h)},${r(pts[i][1] + m[i] * h)}`
       + ` ${r(pts[i + 1][0] - h)},${r(pts[i + 1][1] - m[i + 1] * h)}`
       + ` ${r(pts[i + 1][0])},${r(pts[i + 1][1])}`;
  }
  return d;
}

function usageChart(series, bucketMs) {
  if (!series || series.length < 2) return '';

  const W = 800, H = 200, TOP = 14, BOTTOM = 2;
  const values = series.map((d) => d.tokens_in + d.tokens_out);
  const max = Math.max(...values, 1);
  const xAt = (i) => (i / (series.length - 1)) * W;
  const yAt = (v) => TOP + (1 - v / max) * (H - TOP - BOTTOM);

  const line = monotonePath(values.map((v, i) => [xAt(i), yAt(v)]));
  const area = `${line}L${W},${H}L0,${H}Z`;

  const hourly = bucketMs < 86400000;
  const label = (t) => {
    const d = new Date(t);
    return hourly
      ? `${String(d.getHours()).padStart(2, '0')} h`
      : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  };
  const full = (t) => {
    const d = new Date(t);
    return hourly
      ? d.toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
      : d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  };

  // Roughly six evenly spaced labels. The final one is only added when it would
  // not sit right on top of the previous tick.
  const last = series.length - 1;
  const step = Math.max(1, Math.round(last / 5));
  const ticks = [];
  for (let i = 0; i <= last; i += step) ticks.push(series[i]);
  if (last - (ticks.length - 1) * step >= step / 2) ticks.push(series[last]);

  const peak = values.indexOf(max);

  return `<div class="chart">
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
         aria-label="Évolution des tokens consommés, maximum ${fmtTokens(max)}">
      <defs>
        <linearGradient id="usage-grad" x1="0" y1="0" x2="0" y2="1">
          <stop class="grad-top" offset="0%"/>
          <stop class="grad-bottom" offset="100%"/>
        </linearGradient>
      </defs>
      <path class="chart-grid" d="M0,${yAt(max)}H${W}M0,${yAt(max / 2)}H${W}M0,${H - BOTTOM}H${W}"/>
      <path class="chart-area" d="${area}" fill="url(#usage-grad)"/>
      <path class="chart-line" d="${line}" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="chart-guide" aria-hidden="true"><span class="chart-dot"></span></div>
    <div class="chart-tip" role="status" aria-live="polite"></div>
    <div class="chart-hit" tabindex="0" role="slider" aria-label="Parcourir la consommation"
         aria-valuemin="0" aria-valuemax="${series.length - 1}" aria-valuenow="${peak}"></div>
    <div class="chart-axis">
      ${ticks.map((d) => `<span>${escapeHtml(label(d.t))}</span>`).join('')}
    </div>
  </div>`;
}

/**
 * Hover/keyboard readout for the chart. Kept out of the markup because the SVG
 * is stretched: positions have to be measured from the live element rather than
 * baked into viewBox coordinates.
 */
function wireChart(root, series, bucketMs) {
  const chart = $('.chart', root);
  if (!chart || !series || series.length < 2) return;
  const svg = $('.chart-svg', chart);
  const guide = $('.chart-guide', chart);
  const dot = $('.chart-dot', chart);
  const tip = $('.chart-tip', chart);
  const hit = $('.chart-hit', chart);

  const values = series.map((d) => d.tokens_in + d.tokens_out);
  const max = Math.max(...values, 1);
  const TOP = 14, BOTTOM = 2, VB = 200;
  const hourly = bucketMs < 86400000;

  const stamp = (t) => {
    const d = new Date(t);
    return hourly
      ? d.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  };

  let shown = -1;
  const show = (i) => {
    if (i < 0 || i >= series.length) return;
    const box = svg.getBoundingClientRect();
    const chartBox = chart.getBoundingClientRect();
    const offsetTop = box.top - chartBox.top;

    const x = (i / (series.length - 1)) * box.width;
    const yVb = TOP + (1 - values[i] / max) * (VB - TOP - BOTTOM);
    const y = offsetTop + (yVb / VB) * box.height;

    guide.style.transform = `translateX(${x}px)`;
    guide.style.opacity = '1';
    dot.style.transform = `translateY(${y - offsetTop}px)`;

    const d = series[i];
    tip.innerHTML = `<span class="tip-when">${escapeHtml(stamp(d.t))}</span>
      <span class="tip-tokens">${values[i].toLocaleString('fr-FR')} <em>tokens</em></span>
      <span class="tip-split">${d.tokens_in.toLocaleString('fr-FR')} envoyés · ${d.tokens_out.toLocaleString('fr-FR')} reçus</span>
      <span class="tip-calls">${d.calls} appel${d.calls > 1 ? 's' : ''}</span>`;
    tip.classList.add('on');

    // Keep the card inside the chart instead of letting it clip at the edges.
    const tipW = tip.offsetWidth || 180;
    const left = Math.min(Math.max(x - tipW / 2, 6), chartBox.width - tipW - 6);
    tip.style.transform = `translate(${left}px, ${Math.max(offsetTop + 6, y - tip.offsetHeight - 14)}px)`;

    hit.setAttribute('aria-valuenow', String(i));
    hit.setAttribute('aria-valuetext', `${stamp(d.t)} : ${values[i]} tokens, ${d.calls} appels`);
    shown = i;
  };

  const hide = () => {
    guide.style.opacity = '0';
    tip.classList.remove('on');
    shown = -1;
  };

  const indexFromEvent = (e) => {
    const box = hit.getBoundingClientRect();
    const frac = (e.clientX - box.left) / Math.max(box.width, 1);
    return Math.round(Math.min(Math.max(frac, 0), 1) * (series.length - 1));
  };

  hit.addEventListener('pointermove', (e) => {
    const i = indexFromEvent(e);
    if (i !== shown) show(i);
  });
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('focus', () => show(shown < 0 ? values.indexOf(max) : shown));
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const base = shown < 0 ? values.indexOf(max) : shown;
    show(Math.min(Math.max(base + (e.key === 'ArrowRight' ? 1 : -1), 0), series.length - 1));
  });
}

// ---- Réglages --------------------------------------------------------------
function renderSettings(v) {
  const counts = {};
  for (const a of S.agents) counts[a.provider || 'hermes'] = (counts[a.provider || 'hermes'] || 0) + 1;

  v.innerHTML = `<div class="page">
    <div class="page-head"><h1>Réglages</h1></div>
    <div class="agent-grid" style="grid-template-columns:1fr">
      <div class="agent-card">
        <h3 style="margin:0 0 14px;font-size:14px">Identité de l'organisation</h3>
        <div class="field">
          <label for="set-owner">Ton nom (affiché dans « Salut … »)</label>
          <input id="set-owner" maxlength="60" value="${escapeAttr(S.settings.owner_name || '')}">
        </div>
        <div class="field" style="margin-top:12px">
          <label for="set-org">Nom de l'organisation</label>
          <input id="set-org" maxlength="60" value="${escapeAttr(S.settings.org_name || '')}">
        </div>
        <button class="btn" id="save-settings" type="button" style="margin-top:16px">Enregistrer</button>
      </div>

      <div class="agent-card">
        <h3 style="margin:0 0 14px;font-size:14px">Mot de passe</h3>
        ${S.auth.envPassword ? `
          <div class="price-warn" style="margin-top:0">
            Ton mot de passe ne vient que de la variable <code>APP_PASSWORD</code> : <strong>rien n'est stocké en base</strong>.
            Perdre ce fichier <code>.env</code> verrouillerait l'instance pour de bon — elle se sait revendiquée,
            mais n'aurait plus aucun mot de passe à vérifier.
            Enregistre-le ici (le mot de passe actuel est celui de la variable) : il passera en base,
            et tu pourras retirer la variable ensuite.
          </div>` : ''}
          <div class="field">
            <label for="pw-current">Mot de passe actuel</label>
            <input id="pw-current" type="password" autocomplete="current-password">
          </div>
          <div class="field" style="margin-top:12px">
            <label for="pw-new">Nouveau mot de passe</label>
            <input id="pw-new" type="password" autocomplete="new-password" minlength="${S.auth.minPassword}">
          </div>
          <div class="field" style="margin-top:12px">
            <label for="pw-confirm">Confirmation</label>
            <input id="pw-confirm" type="password" autocomplete="new-password">
          </div>
          <div class="field-err" id="pw-err" style="margin-top:8px"></div>
          <button class="btn" id="save-password" type="button" style="margin-top:12px">
            ${S.auth.envPassword ? 'Enregistrer le mot de passe en base' : 'Changer le mot de passe'}</button>
          <div class="field-hint" style="margin-top:10px">
            ${S.auth.minPassword} caractères minimum. Aucune récupération possible : note-le.
            Toutes les autres sessions seront fermées.
          </div>
      </div>

      <div class="agent-card">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
          <h3 style="margin:0;font-size:14px;flex:1">Fournisseurs de modèles</h3>
          <button class="btn ghost" id="run-wizard" type="button">Relancer l'assistant</button>
        </div>
        <div class="provider-list">
          ${S.providers.map((p) => `
            <button class="provider-row" data-provider="${escapeAttr(p.id)}" type="button">
              <span class="provider-state ${p.enabled ? 'on' : 'off'}" aria-hidden="true"></span>
              <span class="provider-main">
                <span class="provider-name">${escapeHtml(p.label)}
                  <span class="provider-count">${counts[p.id] ? counts[p.id] + ' agent' + (counts[p.id] > 1 ? 's' : '') : 'inutilisé'}</span>
                </span>
                <span class="provider-hint">${escapeHtml(p.hint || '')}</span>
                <span class="provider-meta"><code>${escapeHtml(p.base)}</code>${p.models.length ? ` · ${p.models.length} modèle${p.models.length > 1 ? 's' : ''}` : ''}${p.keyConfigured ? ` · clé ${escapeHtml(p.keyHint)}` : ''}</span>
              </span>
              <span class="pill ${p.enabled ? 'done' : 'failed'}">${p.enabled ? 'actif' : p.needsKey && !p.keyConfigured ? 'clé manquante' : 'à configurer'}</span>
            </button>`).join('')}
        </div>
        <div class="service-grid" style="margin-top:12px">
          ${(S.presets || []).filter((k) => !S.providers.some((p) => p.id === k.id)).map((k) => `
            <button class="service-card add" data-add-provider="${escapeAttr(k.id)}" type="button">
              <span class="service-top"><span class="service-plus">+</span>
                <span class="service-name">${escapeHtml(k.label)}</span>
                ${k.local ? '<span class="pill pending">local</span>' : ''}</span>
              <span class="service-hint">${escapeHtml(k.hint)}</span>
            </button>`).join('')}
        </div>
        <div class="field-hint" style="margin-top:14px;line-height:1.7">
          Le fournisseur et le modèle se choisissent <strong>par agent</strong> (fiche de l'agent → Modèle).
          Les clés sont stockées sur le serveur et ne sont jamais renvoyées au navigateur.
        </div>
      </div>

      <div class="agent-card">
        <h3 style="margin:0 0 14px;font-size:14px">Outils des agents</h3>
        <label class="checklist-item" style="padding:0">
          <input type="checkbox" id="set-tools" ${S.settings.tools_enabled !== '' ? 'checked' : ''}>
          <span>Autoriser les agents à agir — recherche web, lecture de pages, fouille de la mémoire, calcul</span>
        </label>
        <div class="field-hint" style="margin-top:10px;line-height:1.7">
          Sans ça, tes agents ne peuvent que produire du texte à partir de ce qu'ils savent déjà.
          Les appels sortants sont restreints à l'Internet public : une adresse interne
          (<code>127.0.0.1</code>, réseau Docker, métadonnées cloud) est refusée, redirections comprises.
          Un fournisseur qui n'accepte pas les outils est détecté et l'agent répond quand même.
        </div>
        <button class="btn" id="open-prices" type="button" style="margin-top:14px">Tarifs des modèles et alerte de dépense</button>
      </div>

      <div class="agent-card">
        <h3 style="margin:0 0 4px;font-size:14px">Images</h3>
        <div class="field-hint" style="margin-bottom:14px;line-height:1.7">
          Quel service tes agents utilisent pour <strong>créer une image</strong> dans une conversation.
          Il faut un service compatible OpenAI exposant <code>/v1/images/generations</code>.
          Sans ça, l'outil de dessin reste indisponible et les agents le disent au lieu de faire semblant.
        </div>
        <div class="field-row">
          <div class="field">
            <label for="img-provider">Service</label>
            <select id="img-provider">
              <option value="">— aucun —</option>
              ${S.providers.map((p) => `<option value="${escapeAttr(p.id)}" ${S.settings.image_provider === p.id ? 'selected' : ''}
                ${p.enabled ? '' : 'disabled'}>${escapeHtml(p.label)}${p.enabled ? '' : ' (inactif)'}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="img-model">Modèle d'image</label>
            <select id="img-model">${imageModelOptions()}</select>
            <div class="field-hint">Les modèles de ce service dont le nom évoque une image.</div>
          </div>
        </div>
        <button class="btn" id="save-image" type="button" style="margin-top:14px">Enregistrer</button>
        <div class="field-hint" style="margin-top:12px;line-height:1.7">
          Deux protocoles existent et AgentHub essaie les deux : <code>/v1/images/generations</code>
          d'abord, puis la complétion de chat avec <code>modalities</code> — par laquelle passent les
          modèles d'images d'OpenRouter. Tu n'as pas à savoir lequel ton service parle.
          Chaque image est comptée dans la consommation.
        </div>
      </div>

      <div class="agent-card">
        <h3 style="margin:0 0 4px;font-size:14px">Sauvegardes</h3>
        <div class="field-hint" style="margin-bottom:12px;line-height:1.7">
          Instantané cohérent de la base, pris au démarrage puis une fois par jour, ${'' /* */}
          les 14 derniers étant conservés. Copier <code>agenthub.db</code> à la main ne suffirait pas :
          en mode WAL l'essentiel des écritures récentes vit dans le journal.
        </div>
        <div id="backup-list" class="backup-list"><div class="muted">Chargement…</div></div>
        <button class="btn" id="make-backup" type="button" style="margin-top:12px">Sauvegarder maintenant</button>
      </div>

      <div class="agent-card">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
          <h3 style="margin:0;font-size:14px;flex:1">Déclenchements programmés</h3>
          <button class="btn ghost" id="add-schedule" type="button">Ajouter</button>
        </div>
        <div class="field-hint" style="margin-bottom:12px">Un agent lancé à heure fixe dans un salon.</div>
        <div id="schedule-list"><div class="muted">Chargement…</div></div>
      </div>

      <div class="agent-card">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
          <h3 style="margin:0;font-size:14px;flex:1">Déclencheurs entrants</h3>
          <button class="btn ghost" id="add-webhook" type="button">Ajouter</button>
        </div>
        <div class="field-hint" style="margin-bottom:12px;line-height:1.7">
          Une URL secrète qui poste un message dans un salon et lance les agents.
          Quiconque détient le lien peut déclencher : traite-le comme un mot de passe.
        </div>
        <div id="webhook-list"><div class="muted">Chargement…</div></div>
      </div>

      <div class="agent-card">
        <h3 style="margin:0 0 14px;font-size:14px">Notifications et sessions</h3>
        <label class="checklist-item" style="padding:0">
          <input type="checkbox" id="set-notif" ${S.notifyOn ? 'checked' : ''}>
          <span>M'avertir dans le navigateur quand un long traitement se termine</span>
        </label>
        <div class="field-hint" style="margin-top:8px">Seulement lorsque l'onglet est en arrière-plan.</div>
        <button class="btn" id="revoke-sessions" type="button" style="margin-top:16px">Déconnecter les autres navigateurs</button>
        <div class="field-hint" style="margin-top:8px">
          Ta session actuelle est conservée. Utile si tu as ouvert AgentHub sur une machine que tu ne contrôles plus.
        </div>
      </div>
    </div>
  </div>`;

  loadAutomation(v);

  const savePw = $('#save-password', v);
  if (savePw) savePw.onclick = async (e) => {
    const err = $('#pw-err', v);
    const cur = $('#pw-current', v).value;
    const nw = $('#pw-new', v).value;
    const cf = $('#pw-confirm', v).value;
    err.textContent = '';
    if (nw.length < S.auth.minPassword) { err.textContent = `Au moins ${S.auth.minPassword} caractères.`; return; }
    if (nw !== cf) { err.textContent = 'La confirmation ne correspond pas.'; return; }
    e.currentTarget.disabled = true;
    const r = await tryApi(api('POST', '/api/password', { current: cur, password: nw }), 'Changement de mot de passe');
    e.currentTarget.disabled = false;
    if (r) {
      $('#pw-current', v).value = ''; $('#pw-new', v).value = ''; $('#pw-confirm', v).value = '';
      toast('Mot de passe changé.', { kind: 'success' });
    }
  };

  $('#run-wizard', v).onclick = () => checkSetup(true);
  $$('[data-provider]', v).forEach((n) => n.onclick = () =>
    openProviderModal(S.providers.find((p) => p.id === n.dataset.provider),
      (S.presets || []).find((k) => k.id === n.dataset.provider)));
  $$('[data-add-provider]', v).forEach((n) => n.onclick = () =>
    openProviderModal(null, (S.presets || []).find((k) => k.id === n.dataset.addProvider)));

  $('#save-settings', v).onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const res = await tryApi(api('PUT', '/api/settings', {
      owner_name: $('#set-owner', v).value.trim(),
      org_name: $('#set-org', v).value.trim(),
    }), 'Enregistrement');
    btn.disabled = false;
    if (res) {
      S.settings = res;
      renderSidebar();
      toast('Identité mise à jour.', { kind: 'success' });
    }
  };

  $('#open-prices', v).onclick = () => openPricesModal();

  // Changer de service change la liste des modèles proposés.
  $('#img-provider', v).onchange = () => {
    const sel = $('#img-model', v);
    if (sel) sel.innerHTML = imageModelOptions($('#img-provider', v).value);
  };

  $('#save-image', v).onclick = async (e) => {
    e.currentTarget.disabled = true;
    const res = await tryApi(api('PUT', '/api/settings', {
      image_provider: $('#img-provider', v).value,
      image_model: $('#img-model', v).value.trim(),
    }), 'Enregistrement');
    e.currentTarget.disabled = false;
    if (res) {
      S.settings = res;
      toast(res.image_provider && res.image_model
        ? 'Tes agents peuvent maintenant créer des images.'
        : 'Génération d\'images désactivée.', { kind: 'success' });
    }
  };

  $('#set-tools', v).onchange = async (e) => {
    const on = e.currentTarget.checked;
    const res = await tryApi(api('PUT', '/api/settings', { tools_enabled: on ? '1' : '' }), 'Enregistrement');
    if (res) {
      S.settings = res;
      toast(on ? 'Les agents peuvent agir.' : 'Les agents ne produisent plus que du texte.', { kind: 'success' });
    } else e.currentTarget.checked = !on;
  };

  $('#set-notif', v).onchange = async (e) => {
    if (!e.currentTarget.checked) { S.notifyOn = false; localStorage.removeItem('ah_notify'); return; }
    // La permission doit être demandée depuis un geste de l'utilisateur, ce
    // que ce clic est ; la demander au chargement se fait refuser d'office.
    const perm = await Notification.requestPermission().catch(() => 'denied');
    if (perm !== 'granted') {
      e.currentTarget.checked = false;
      toast('Le navigateur a refusé les notifications.', { kind: 'warn' });
      return;
    }
    S.notifyOn = true;
    localStorage.setItem('ah_notify', '1');
    toast('Notifications activées.', { kind: 'success' });
  };

  $('#revoke-sessions', v).onclick = async (e) => {
    e.currentTarget.disabled = true;
    const r = await tryApi(api('POST', '/api/sessions/revoke-others'), 'Révocation');
    e.currentTarget.disabled = false;
    if (r) toast(r.revoked ? `${r.revoked} session(s) fermée(s).` : 'Aucune autre session ouverte.', { kind: 'success' });
  };

  $('#make-backup', v).onclick = async (e) => {
    e.currentTarget.disabled = true;
    const r = await tryApi(api('POST', '/api/backups'), 'Sauvegarde');
    e.currentTarget.disabled = false;
    if (r) { toast('Sauvegarde effectuée.', { kind: 'success' }); loadAutomation(v); }
  };

  $('#add-schedule', v).onclick = () => openScheduleModal(null, () => loadAutomation(v));
  $('#add-webhook', v).onclick = () => openWebhookModal(() => loadAutomation(v));
}

/**
 * Les modèles du service dont le nom évoque une image.
 *
 * Une heuristique sur le nom, pas une vérité : aucun catalogue compatible
 * OpenAI ne déclare quels modèles savent dessiner. Quand elle ne trouve rien,
 * on montre tout le catalogue plutôt qu'une liste vide — mieux vaut un choix
 * large qu'un menu qui ne s'ouvre pas.
 */
function imageModelOptions(providerId) {
  const id = providerId ?? S.settings.image_provider;
  const p = S.providers.find((x) => x.id === id);
  if (!p) return '<option value="">— choisis d\'abord un service —</option>';

  const rx = /image|dall|flux|imagen|sd3|stable-diffusion|midjourney|nano-banana/i;
  const likely = p.models.filter((m) => rx.test(m));
  const list = likely.length ? likely : p.models;
  if (!list.length) return '<option value="">— ce service n\'a listé aucun modèle —</option>';

  const opt = (m) => `<option value="${escapeAttr(m)}" ${m === S.settings.image_model ? 'selected' : ''}>${escapeHtml(m)}</option>`;
  return `<option value="">— aucun —</option>${list.slice(0, 60).map(opt).join('')}`;
}

// ---- automatisation : sauvegardes, planificateur, webhooks ------------------
const DAY_LABELS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
const DAY_FULL = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

async function loadAutomation(root) {
  const [backups, schedules, hooks] = await Promise.all([
    api('GET', '/api/backups').catch(() => null),
    api('GET', '/api/schedules').catch(() => null),
    api('GET', '/api/webhooks').catch(() => null),
  ]);
  // La vue a pu changer pendant les requêtes.
  if (!document.body.contains(root)) return;

  const bl = $('#backup-list', root);
  if (bl) {
    bl.innerHTML = backups?.backups?.length
      ? backups.backups.slice(0, 6).map((b) => `<div class="backup-row">
          <span>${new Date(b.at).toLocaleString('fr-FR')}</span>
          <span class="muted">${fmtBytes(b.bytes)}</span>
          <a class="link-btn" href="/api/backups/${encodeURIComponent(b.file)}" download>Télécharger</a>
        </div>`).join('')
      : '<div class="muted">Aucune sauvegarde pour l\'instant.</div>';
  }

  const sl = $('#schedule-list', root);
  if (sl) {
    sl.innerHTML = schedules?.schedules?.length
      ? schedules.schedules.map((s) => {
        const c = channelById(s.channel_id);
        const a = s.agent_id ? agentById(s.agent_id) : null;
        return `<div class="auto-row">
          <span class="auto-main">
            <strong>${escapeHtml(s.label)}</strong>
            <small>${String(s.hour).padStart(2, '0')}h${String(s.minute).padStart(2, '0')} ·
              ${s.days.length === 7 ? 'tous les jours' : s.days.map((d) => DAY_LABELS[d]).join(' ')} ·
              ${c ? escapeHtml(c.name) : 'salon supprimé'}${a ? ` · ${escapeHtml(a.name)}` : ''}</small>
          </span>
          <span class="pill ${s.enabled ? 'done' : 'pending'}">${s.enabled ? 'actif' : 'en pause'}</span>
          <button class="link-btn" data-run-sched="${escapeAttr(s.id)}" type="button">Tester</button>
          <button class="link-btn" data-edit-sched="${escapeAttr(s.id)}" type="button">Modifier</button>
        </div>`;
      }).join('')
      : '<div class="muted">Aucun déclenchement programmé.</div>';

    $$('[data-edit-sched]', sl).forEach((b) => b.onclick = () =>
      openScheduleModal(schedules.schedules.find((s) => s.id === b.dataset.editSched), () => loadAutomation(root)));
    $$('[data-run-sched]', sl).forEach((b) => b.onclick = async () => {
      b.disabled = true;
      const r = await tryApi(api('POST', `/api/schedules/${b.dataset.runSched}/run`), 'Test');
      b.disabled = false;
      if (r) toast(r.ok ? 'Déclenché — regarde le salon.' : 'Rien à déclencher (salon ou consigne vide).', { kind: r.ok ? 'success' : 'warn' });
    });
  }

  const wl = $('#webhook-list', root);
  if (wl) {
    wl.innerHTML = hooks?.webhooks?.length
      ? hooks.webhooks.map((w) => {
        const c = channelById(w.channel_id);
        return `<div class="auto-row">
          <span class="auto-main">
            <strong>${escapeHtml(w.label)}</strong>
            <small>${c ? escapeHtml(c.name) : 'salon supprimé'} · ${w.calls} appel${w.calls > 1 ? 's' : ''}${w.last_call ? ` · dernier ${agoText(w.last_call)}` : ''}</small>
          </span>
          <button class="link-btn" data-copy-hook="${escapeAttr(location.origin + w.url)}" type="button">Copier l'URL</button>
          <button class="link-btn danger" data-del-hook="${escapeAttr(w.id)}" type="button">Supprimer</button>
        </div>`;
      }).join('')
      : '<div class="muted">Aucun déclencheur.</div>';

    $$('[data-copy-hook]', wl).forEach((b) => b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copyHook);
        toast('URL copiée. Traite-la comme un mot de passe.', { kind: 'success' });
      } catch { toast(b.dataset.copyHook, { kind: 'info', title: 'Copie refusée — voici l\'URL' }); }
    });
    $$('[data-del-hook]', wl).forEach((b) => b.onclick = () => confirmModal(
      'Supprimer ce déclencheur ?', 'Son URL cessera immédiatement de fonctionner.',
      async () => {
        const r = await tryApi(api('DELETE', `/api/webhooks/${b.dataset.delHook}`), 'Suppression');
        if (r) { closeModal(); loadAutomation(root); }
      }));
  }
}

function openScheduleModal(sched, onDone) {
  const isEdit = !!sched;
  const days = isEdit ? sched.days : [1, 2, 3, 4, 5];
  openModal(isEdit ? 'Modifier le déclenchement' : 'Nouveau déclenchement', (b) => {
    b.innerHTML = `
      <div class="field">
        <label for="s-label">Nom</label>
        <input id="s-label" maxlength="80" value="${isEdit ? escapeAttr(sched.label) : ''}" placeholder="ex : Veille du matin">
      </div>
      <div class="field-row" style="margin-top:12px">
        <div class="field"><label for="s-channel">Salon</label>
          <select id="s-channel">${S.channels.map((c) =>
            `<option value="${escapeAttr(c.id)}" ${isEdit && sched.channel_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select>
        </div>
        <div class="field"><label for="s-agent">Agent (facultatif)</label>
          <select id="s-agent"><option value="">le plus haut placé du salon</option>${S.agents.map((a) =>
            `<option value="${escapeAttr(a.id)}" ${isEdit && sched.agent_id === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}</select>
        </div>
      </div>
      <div class="field-row" style="margin-top:12px">
        <div class="field"><label for="s-hour">Heure</label>
          <input id="s-hour" type="number" min="0" max="23" value="${isEdit ? sched.hour : 8}"></div>
        <div class="field"><label for="s-min">Minute</label>
          <input id="s-min" type="number" min="0" max="59" value="${isEdit ? sched.minute : 30}"></div>
      </div>
      <div class="field" style="margin-top:12px">
        <label>Jours</label>
        <div class="day-picker">${DAY_LABELS.map((d, i) =>
          `<button type="button" class="day-btn ${days.includes(i) ? 'on' : ''}" data-day="${i}"
                   aria-pressed="${days.includes(i)}" aria-label="${DAY_FULL[i]}">${d}</button>`).join('')}</div>
      </div>
      <div class="field" style="margin-top:12px">
        <label for="s-prompt">Consigne envoyée</label>
        <textarea id="s-prompt" rows="4" maxlength="4000" placeholder="ex : Fais-moi la veille du secteur, 5 points maximum, avec les sources.">${isEdit ? escapeHtml(sched.prompt) : ''}</textarea>
      </div>
      <label class="checklist-item" style="padding:0;margin-top:12px">
        <input type="checkbox" id="s-on" ${!isEdit || sched.enabled ? 'checked' : ''}><span>Actif</span>
      </label>
      <div class="field-hint" style="margin-top:8px">Heure du serveur, pas celle de ton navigateur.</div>
      <button class="primary" id="s-save" type="button">${isEdit ? 'Enregistrer' : 'Créer'}</button>
      ${isEdit ? '<button class="del-link" id="s-del" type="button">Supprimer</button>' : ''}`;

    $$('[data-day]', b).forEach((d) => d.onclick = () => {
      const on = d.classList.toggle('on');
      d.setAttribute('aria-pressed', String(on));
    });

    $('#s-save', b).onclick = async (ev) => {
      const payload = {
        label: $('#s-label', b).value.trim() || 'Sans nom',
        channel_id: $('#s-channel', b).value,
        agent_id: $('#s-agent', b).value || null,
        prompt: $('#s-prompt', b).value,
        hour: Number($('#s-hour', b).value),
        minute: Number($('#s-min', b).value),
        days: $$('.day-btn.on', b).map((d) => Number(d.dataset.day)),
        enabled: $('#s-on', b).checked ? 1 : 0,
      };
      if (!payload.prompt.trim()) { toast('La consigne ne peut pas être vide.', { kind: 'warn' }); return; }
      if (!payload.days.length) { toast('Choisis au moins un jour.', { kind: 'warn' }); return; }
      ev.currentTarget.disabled = true;
      const r = await tryApi(isEdit ? api('PUT', `/api/schedules/${sched.id}`, payload)
        : api('POST', '/api/schedules', payload), 'Enregistrement');
      ev.currentTarget.disabled = false;
      if (r) { closeModal(); toast('Déclenchement enregistré.', { kind: 'success' }); onDone?.(); }
    };

    const del = $('#s-del', b);
    if (del) del.onclick = async () => {
      const r = await tryApi(api('DELETE', `/api/schedules/${sched.id}`), 'Suppression');
      if (r) { closeModal(); onDone?.(); }
    };
  });
}

function openWebhookModal(onDone) {
  openModal('Nouveau déclencheur entrant', (b) => {
    b.innerHTML = `
      <div class="field">
        <label for="w-label">Nom</label>
        <input id="w-label" maxlength="80" placeholder="ex : Formulaire du site">
      </div>
      <div class="field" style="margin-top:12px">
        <label for="w-channel">Salon destinataire</label>
        <select id="w-channel">${S.channels.map((c) =>
          `<option value="${escapeAttr(c.id)}">${escapeHtml(c.name)}</option>`).join('')}</select>
      </div>
      <div class="field-hint" style="margin-top:12px;line-height:1.7">
        Une fois créé, poste dessus :<br>
        <code>curl -X POST &lt;url&gt; -H "Content-Type: application/json" -d '{"text":"…"}'</code><br>
        Le message arrive dans le salon et les agents répondent comme si tu l'avais écrit.
      </div>
      <button class="primary" id="w-save" type="button">Créer</button>`;

    $('#w-save', b).onclick = async (ev) => {
      ev.currentTarget.disabled = true;
      const r = await tryApi(api('POST', '/api/webhooks', {
        label: $('#w-label', b).value.trim(), channel_id: $('#w-channel', b).value,
      }), 'Création');
      ev.currentTarget.disabled = false;
      if (r) { closeModal(); toast('Déclencheur créé — copie son URL.', { kind: 'success' }); onDone?.(); }
    };
  });
}

// ---- Chat ------------------------------------------------------------------
function renderChat(v) {
  const c = channelById(S.current);
  if (!c) {
    v.innerHTML = `<div class="page">${emptyBox('🔍', 'Salon introuvable.')}</div>`;
    return;
  }
  const members = c.members.map(agentById).filter(Boolean).sort(byRank);
  const canEdit = c.kind === 'pole';

  v.innerHTML = `
    <div class="chat">
      <div class="chat-main">
        <div class="chat-head">
          <div style="min-width:0">
            <div class="chat-title">
              <span class="pole-ic" style="width:28px;height:28px;font-size:15px;border-radius:9px;background:${softColor(c.color)};color:${safeColor(c.color, '#3e5faf')}">${escapeHtml(c.emoji || '#')}</span>
              <span>${c.kind === 'hermes' ? '' : 'Pôle '}${escapeHtml(c.name)}</span>
            </div>
            ${c.topic ? `<div class="chat-topic">${escapeHtml(c.topic)}</div>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <div class="chat-members">${members.map((a) => avatarHTML(a, { status: true })).join('')}</div>
            <button class="icon-btn" id="export-chat" type="button"
                    aria-label="Exporter en Markdown" title="Exporter en Markdown">${IC.download}</button>
            <button class="icon-btn" id="clear-chat" type="button"
                    aria-label="Vider la conversation" title="Vider la conversation">${IC.broom}</button>
            ${canEdit ? `<button class="icon-btn" id="edit-pole" type="button" aria-label="Modifier le pôle" title="Modifier le pôle">${IC.edit}</button>` : ''}
          </div>
        </div>

        <div class="messages" id="messages" role="log" aria-label="Messages du salon" aria-live="polite"></div>

        <div class="composer-wrap">
          <button class="scroll-down hidden-soft" id="scroll-down" type="button" aria-label="Revenir en bas">${IC.down}</button>
          <div id="mention-pop" class="mention-pop hidden" role="listbox" aria-label="Mentionner un agent"></div>
          <div id="attach-tray" class="attach-tray hidden"></div>
          <div class="composer">
            <input type="file" id="file-input" class="sr-only" multiple>
            <button class="icon-btn attach-btn" id="attach-btn" type="button"
                    aria-label="Joindre un fichier" title="Joindre un fichier">${IC.clip}</button>
            <div class="composer-box">
              <label for="composer-input" class="sr-only">Message</label>
              <textarea id="composer-input" rows="1" placeholder="Écris un message…  (@ pour appeler un agent)"></textarea>
            </div>
            <button id="send-btn" type="button" aria-label="Envoyer" disabled>${IC.send}</button>
          </div>
          <div class="composer-hint">
            ${modelChip(c)}
            <span><kbd>Entrée</kbd> envoie · <kbd>Maj+Entrée</kbd> saute une ligne</span>
            <span id="run-controls"></span>
          </div>
        </div>
      </div>

      <aside class="chat-rail ${S.railOpen ? 'open' : ''}" aria-label="Tâches déléguées">
        <div class="rail-title"><span>Tâches déléguées</span><span>${S.tasks.length || ''}</span></div>
        <div class="task-list" id="task-list"></div>
      </aside>
    </div>`;

  const box = $('#messages', v);
  if (!S.messages.length) {
    renderChatEmptyState(box);
  } else {
    S.messages.forEach((m, i) => box.appendChild(renderMessage(m, S.messages[i - 1])));
  }
  wireMessageActions(box);
  renderThinking();
  renderTasks();
  wireComposer();

  const ep = $('#edit-pole', v);
  if (ep) ep.onclick = () => openPoleModal(c);

  $('#model-chip', v).onclick = () => openChannelModelModal(c);

  // L'export passe par une navigation plutôt que par fetch : le navigateur
  // gère le téléchargement, et le cookie de session part avec la requête.
  $('#export-chat', v).onclick = () => {
    if (!S.messages.length) { toast('Rien à exporter dans ce salon.', { kind: 'warn' }); return; }
    window.location.href = `/api/channels/${c.id}/export`;
  };

  wireAttachments(v, c);

  $('#clear-chat', v).onclick = () => {
    if (!S.messages.length && !S.tasks.length) { toast('La conversation est déjà vide.', { kind: 'warn' }); return; }
    confirmModal(
      `Vider « ${c.name} » ?`,
      `Les ${S.messages.length} message(s) et ${S.tasks.length} tâche(s) de ce salon seront définitivement effacés. Les agents et le pôle lui-même sont conservés.`,
      async () => {
        const r = await tryApi(api('DELETE', `/api/channels/${c.id}/messages`), 'Vidage');
        if (r) { closeModal(); toast(`Conversation vidée (${r.messages} message(s)).`, { kind: 'success' }); }
      });
  };

  box.addEventListener('scroll', updateScrollButton, { passive: true });
  $('#scroll-down', v).onclick = () => scrollToBottom(true);
  requestAnimationFrame(() => scrollToBottom(true));
}

// ---- pièces jointes --------------------------------------------------------
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' Mo'
  : n >= 1024 ? Math.round(n / 1024) + ' Ko' : n + ' o');

/**
 * Le fichier est envoyé brut, avec son nom et son type en paramètres d'URL.
 * Coder un parseur multipart pour un seul champ coûterait plus que ça ne
 * rapporte, et la liste de dépendances du projet reste à trois.
 */
async function uploadFile(channelId, file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    toast(`« ${file.name} » dépasse 10 Mo.`, { kind: 'warn' });
    return null;
  }
  try {
    const r = await fetch(
      `/api/channels/${channelId}/attachments?name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type || '')}`,
      { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return await r.json();
  } catch (err) {
    toast(`Envoi de « ${file.name} » impossible : ${err.message}`, { kind: 'error' });
    return null;
  }
}

function renderAttachTray() {
  const tray = $('#attach-tray');
  if (!tray) return;
  const list = S.pendingFiles || [];
  tray.classList.toggle('hidden', !list.length);
  tray.innerHTML = list.map((f) => `<span class="attach-chip">
    ${IC.clip}<span>${escapeHtml(f.name)}</span><small>${fmtBytes(f.bytes)}</small>
    ${f.readable ? '' : '<small title="Les agents ne peuvent pas lire ce format">non lisible</small>'}
    <button type="button" data-unattach="${escapeAttr(f.id)}" aria-label="Retirer ${escapeAttr(f.name)}">${IC.trash}</button>
  </span>`).join('');

  $$('[data-unattach]', tray).forEach((b) => b.onclick = async () => {
    const id = b.dataset.unattach;
    S.pendingFiles = (S.pendingFiles || []).filter((f) => f.id !== id);
    renderAttachTray();
    await api('DELETE', `/api/attachments/${id}`).catch(() => {});
  });
}

function wireAttachments(root, channel) {
  // Les fichiers en attente appartiennent au salon : changer de salon ne doit
  // pas traîner une pièce jointe dans une autre conversation.
  if (S.pendingChannel !== channel.id) { S.pendingFiles = []; S.pendingChannel = channel.id; }
  renderAttachTray();

  const input = $('#file-input', root);
  const btn = $('#attach-btn', root);
  if (!input || !btn) return;

  const take = async (files) => {
    for (const file of [...files].slice(0, 10)) {
      const up = await uploadFile(channel.id, file);
      if (up) {
        S.pendingFiles = [...(S.pendingFiles || []), up];
        renderAttachTray();
      }
    }
  };

  btn.onclick = () => input.click();
  input.onchange = async () => { await take(input.files); input.value = ''; };

  const zone = $('.chat-main', root);
  if (!zone) return;
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', (e) => {
    if (e.target === zone) zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) await take(e.dataTransfer.files);
  });
}

// Formats que le serveur accepte de rendre en ligne. SVG en est absent des deux
// côtés : c'est un document exécutable, pas une image inerte.
const INLINE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Les fichiers portés par un message : les images s'affichent, le reste se télécharge. */
function attachmentsHTML(m) {
  const files = m.attachments || [];
  if (!files.length) return '';
  const images = files.filter((f) => INLINE_MIME.has(f.mime));
  const others = files.filter((f) => !INLINE_MIME.has(f.mime));

  return `<div class="msg-files" data-files="${escapeAttr(m.id)}">
    ${images.length ? `<div class="msg-images">${images.map(imageHTML).join('')}</div>` : ''}
    ${others.map((f) => `<a class="attach-chip" href="/api/attachments/${escapeAttr(f.id)}?download=1" download>
      ${IC.clip}<span>${escapeHtml(f.name)}</span><small>${fmtBytes(f.bytes)}</small>
    </a>`).join('')}
  </div>`;
}

const imageHTML = (f) => `<figure class="msg-image">
  <img src="/api/attachments/${escapeAttr(f.id)}" alt="${escapeAttr(f.name)}" loading="lazy" decoding="async">
  <figcaption>
    <span>${escapeHtml(f.name)}</span>
    <a href="/api/attachments/${escapeAttr(f.id)}?download=1" download>${fmtBytes(f.bytes)} · télécharger</a>
  </figcaption>
</figure>`;

/**
 * Une image arrivée pendant que le message s'écrit.
 * Le message est encore en streaming : le re-rendre entièrement effacerait le
 * texte déjà affiché, on greffe donc l'image dans la zone des fichiers.
 */
function appendAttachment(id, att) {
  const m = S.messages.find((x) => x.id === id);
  if (m) m.attachments = [...(m.attachments || []).filter((f) => f.id !== att.id), att];

  const body = $('#messages')?.querySelector(`[data-id="${CSS.escape(id)}"] .msg-body`);
  if (!body) return;
  let zone = body.querySelector('.msg-files');
  if (!zone) {
    zone = el('div', 'msg-files');
    body.appendChild(zone);
  }
  if (zone.querySelector(`[src$="/${att.id}"]`)) return;      // déjà greffée

  if (INLINE_MIME.has(att.mime)) {
    let grid = zone.querySelector('.msg-images');
    if (!grid) { grid = el('div', 'msg-images'); zone.prepend(grid); }
    grid.insertAdjacentHTML('beforeend', imageHTML(att));
  } else {
    zone.insertAdjacentHTML('beforeend',
      `<a class="attach-chip" href="/api/attachments/${escapeAttr(att.id)}?download=1" download>
        ${IC.clip}<span>${escapeHtml(att.name)}</span><small>${fmtBytes(att.bytes)}</small></a>`);
  }
  if (isNearBottom()) scrollToBottom();
}

// Consecutive messages from the same author within this window are visually
// grouped: no repeated avatar or header, tighter spacing.
const GROUP_WINDOW_MS = 5 * 60 * 1000;
function groupsWith(m, prev) {
  if (!prev || !m) return false;
  if (m.author_type !== prev.author_type) return false;
  if (m.author_type === 'system') return false;
  if ((m.author_id || null) !== (prev.author_id || null)) return false;
  if (m.author_name !== prev.author_name) return false;
  return m.created_at - prev.created_at < GROUP_WINDOW_MS;
}

const deleteBtn = (id) => `<button class="msg-del" type="button" data-del="${escapeAttr(id)}"
  aria-label="Supprimer ce message" title="Supprimer ce message">
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>`;

function renderMessage(m, prev) {
  const grouped = groupsWith(m, prev);

  if (m.author_type === 'system') {
    const w = el('div', 'msg system');
    w.dataset.id = m.id;
    w.innerHTML = `<span class="av square" style="background:var(--line-soft);color:var(--muted)" aria-hidden="true">⚙</span>
      <div class="msg-body"><div class="msg-content">${renderMarkdown(m.content)}</div></div>
      ${deleteBtn(m.id)}`;
    return w;
  }

  const isUser = m.author_type === 'user';
  const agent = m.author_id ? agentById(m.author_id) : null;
  const color = safeColor(m.author_color, isUser ? '#8a8f83' : '#8a8f9a');
  const w = el('div', 'msg'
    + (isUser ? ' from-user' : '')
    + (m.status === 'error' ? ' error' : '')
    + (grouped ? ' grouped' : ''));
  w.dataset.id = m.id;

  const av = agent && !isUser
    ? avatarHTML(agent)
    : `<span class="av" style="background:${color}">${escapeHtml(initials(m.author_name))}</span>`;

  w.innerHTML = `${grouped ? '<span class="av-spacer" aria-hidden="true"></span>' : av}
    <div class="msg-body">
      ${grouped ? '' : `<div class="msg-head">
        <span class="msg-author" style="color:${isUser ? 'var(--text)' : color}">${escapeHtml(m.author_name)}</span>
        ${agent && agent.title ? `<span class="msg-title">${escapeHtml(agent.title)}</span>` : ''}
        <span class="msg-time">${fmtTime(m.created_at)}</span>
      </div>`}
      ${toolTraceHTML(m)}
      ${reasoningHTML(m)}
      <div class="msg-content ${m.status === 'streaming' ? 'cursor' : ''}">${renderMarkdown(m.content)}</div>
      ${attachmentsHTML(m)}
    </div>
    ${m.status === 'streaming' ? '' : deleteBtn(m.id)}`;
  return w;
}

/**
 * What the agent actually did before answering.
 * Kept above the reply and visually distinct: a claim backed by a real web
 * search must be distinguishable from the same sentence invented outright.
 */
function toolTraceHTML(m) {
  let calls = [];
  try { calls = JSON.parse(m.tools || '[]'); } catch { calls = []; }
  if (!Array.isArray(calls) || !calls.length) return '';
  return `<div class="tool-trace">${calls.map((c) =>
    `<span class="tool-chip ${c.ok ? '' : 'failed'}">${IC.spark}${escapeHtml(c.label || c.name)}</span>`).join('')}</div>`;
}

/** Folded away by default — it is working-out, not the answer. */
function reasoningHTML(m) {
  const r = m.reasoning || '';
  if (!r.trim()) return '<div class="reasoning-slot"></div>';
  return `<details class="reasoning"><summary>Raisonnement<span class="muted"> · ${r.length.toLocaleString('fr-FR')} caractères</span></summary>
    <div class="reasoning-body">${escapeHtml(r)}</div></details>`;
}

function applyReasoning(id, delta) {
  const m = S.messages.find((x) => x.id === id);
  if (!m) return;
  m.reasoning = (m.reasoning || '') + delta;

  const row = $('#messages')?.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  let box = row.querySelector('.reasoning');
  if (!box) {
    // First reasoning delta of this message: swap the placeholder for a real
    // block rather than re-render the row and lose the streaming cursor.
    const slot = row.querySelector('.reasoning-slot');
    if (!slot) return;
    slot.outerHTML = `<details class="reasoning" open><summary>Raisonnement<span class="muted"></span></summary>
      <div class="reasoning-body"></div></details>`;
    box = row.querySelector('.reasoning');
  }
  const body = box.querySelector('.reasoning-body');
  const count = box.querySelector('summary .muted');
  if (body) body.textContent = m.reasoning;
  if (count) count.textContent = ` · ${m.reasoning.length.toLocaleString('fr-FR')} caractères`;
}

/** A transient line under the message while a tool runs or a retry is waiting. */
function showToolActivity(id, label, isNotice = false) {
  const row = $('#messages')?.querySelector(`[data-id="${CSS.escape(id)}"] .msg-body`);
  if (!row) return;
  let zone = row.querySelector('.tool-live');
  if (!zone) {
    zone = el('div', 'tool-live');
    const content = row.querySelector('.msg-content');
    row.insertBefore(zone, content);
  }
  zone.className = 'tool-live' + (isNotice ? ' notice' : '');
  zone.innerHTML = `<span class="tool-live-dot" aria-hidden="true"></span>${escapeHtml(label)}`;
  if (isNearBottom()) scrollToBottom();
}

// Delegated from the message list so it survives re-renders and streaming.
function wireMessageActions(box) {
  box.addEventListener('click', (e) => {
    // Fold / unfold a finished code block.
    const head = e.target.closest('[data-code-toggle]');
    if (head) {
      const block = head.closest('.codeblock');
      const open = block.classList.toggle('open');
      head.setAttribute('aria-expanded', String(open));
      const label = head.querySelector('.code-open');
      if (label) label.textContent = open ? 'Masquer' : 'Afficher';
      return;
    }

    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    const id = btn.dataset.del;
    const msg = S.messages.find((x) => x.id === id);
    confirmModal(
      'Supprimer ce message ?',
      msg && msg.author_type === 'user'
        ? "Le message est retiré de la conversation et du contexte envoyé aux agents. Les réponses qu'il a déclenchées, elles, restent."
        : "Le message est retiré de la conversation et du contexte envoyé aux agents.",
      async () => {
        const r = await tryApi(api('DELETE', `/api/messages/${id}`), 'Suppression');
        if (r) { closeModal(); toast('Message supprimé.', { kind: 'success' }); }
      });
  });
}

function removeMessageLocally(id) {
  const i = S.messages.findIndex((x) => x.id === id);
  if (i >= 0) S.messages.splice(i, 1);
  const node = $('#messages')?.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (node) node.remove();
  // Grouping depends on neighbours, so the surrounding run must be redrawn.
  repaintMessages();
}

// Full repaint of the message list, preserving scroll position.
function repaintMessages() {
  const box = $('#messages');
  if (!box) return;
  const near = isNearBottom();
  const zone = $('#thinking-zone');
  box.querySelectorAll('.msg').forEach((n) => n.remove());
  const frag = document.createDocumentFragment();
  S.messages.forEach((m, i) => frag.appendChild(renderMessage(m, S.messages[i - 1])));
  box.insertBefore(frag, zone || null);
  if (!S.messages.length) renderChatEmptyState(box);
  if (near) scrollToBottom(true);
}

function renderChatEmptyState(box) {
  const c = channelById(S.current);
  if (!c || box.querySelector('.empty')) return;
  const empty = el('div', 'empty');
  empty.style.margin = 'auto';
  empty.innerHTML = `<div class="empty-ic" aria-hidden="true">${c.kind === 'hermes' ? '🪽' : '💬'}</div>${
    escapeHtml(c.kind === 'hermes'
      ? 'Parle directement à Hermes.'
      : `Écris ici pour lancer le pôle ${c.name}. Utilise @ pour viser un agent précis.`)}`;
  box.insertBefore(empty, box.firstChild);
}

function upsertMessage(m) {
  const i = S.messages.findIndex((x) => x.id === m.id);
  if (i >= 0) S.messages[i] = m; else S.messages.push(m);
  const box = $('#messages');
  if (!box) return;
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();

  const near = isNearBottom();
  const idx = S.messages.findIndex((x) => x.id === m.id);
  const existing = box.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
  const node = renderMessage(m, S.messages[idx - 1]);
  if (existing) existing.replaceWith(node);
  else box.insertBefore(node, $('#thinking-zone') || null);
  if (near) scrollToBottom();
  updateScrollButton();
}

function applyDelta(id, delta) {
  const m = S.messages.find((x) => x.id === id);
  if (!m) return;
  m.content += delta;
  const node = $('#messages')?.querySelector(`[data-id="${CSS.escape(id)}"] .msg-content`);
  if (!node) return;
  const near = isNearBottom();
  node.innerHTML = renderMarkdown(m.content);
  node.classList.add('cursor');
  if (near) scrollToBottom();
}

// A lightweight "X réfléchit…" row for agents with no streaming message yet.
function renderThinking() {
  const box = $('#messages');
  if (!box) return;
  let zone = $('#thinking-zone');
  if (!zone) {
    zone = el('div', 'studio');
    zone.id = 'thinking-zone';
    zone.style.gap = '12px';
    box.appendChild(zone);
  }
  const c = channelById(S.current);
  if (!c) return;
  const streamingIds = new Set(S.messages.filter((m) => m.status === 'streaming').map((m) => m.author_id));
  const busy = c.members
    .map(agentById).filter(Boolean)
    .filter((a) => (S.status[a.id] || 'idle') !== 'idle' && !streamingIds.has(a.id));

  zone.innerHTML = busy.map((a) => `
    <div class="thinking-row">
      ${avatarHTML(a, { status: true })}
      <span class="thinking-bubble">
        <span>${escapeHtml(a.name)} ${S.status[a.id] === 'working' ? 'recherche' : 'réfléchit'}</span>
        ${S.status[a.id] === 'working'
          ? `<span class="search-anim" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/><circle cx="11" cy="11" r="3" class="search-pulse"/></svg></span>`
          : `<span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>`}
      </span>
    </div>`).join('');

  // While anything runs, the send button turns into a stop button. Putting it
  // where your hand already is beats a second control hidden under the field.
  const anyBusy = c.members.some((id) => (S.status[id] || 'idle') !== 'idle');
  const sendBtn = $('#send-btn');
  const input = $('#composer-input');
  if (sendBtn) {
    sendBtn.classList.toggle('is-stop', anyBusy);
    sendBtn.innerHTML = anyBusy ? IC.stop : IC.send;
    sendBtn.setAttribute('aria-label', anyBusy ? 'Arrêter la réponse' : 'Envoyer');
    sendBtn.title = anyBusy ? 'Arrêter la réponse' : 'Envoyer';
    sendBtn.disabled = anyBusy ? false : !(input && input.value.trim());
  }

  const controls = $('#run-controls');
  if (controls) {
    controls.innerHTML = anyBusy
      ? '<span class="run-note">Une réponse est en cours — <kbd>Échap</kbd> pour l\'arrêter</span>' : '';
  }
}

async function stopRun() {
  const channelId = S.current;
  if (!channelId) return;
  const r = await tryApi(api('POST', `/api/channels/${channelId}/stop`), 'Arrêt');
  if (r) toast(r.stopped ? 'Réponse arrêtée.' : 'Plus rien ne tournait.', { kind: 'warn' });
}

const channelBusy = () => {
  const c = channelById(S.current);
  return Boolean(c && c.members.some((id) => (S.status[id] || 'idle') !== 'idle'));
};

function renderTasks() {
  const list = $('#task-list');
  if (!list) return;
  list.innerHTML = '';
  if (!S.tasks.length) {
    list.appendChild(el('div', 'muted', 'Aucune tâche déléguée pour l’instant.'));
    return;
  }
  for (const t of S.tasks) {
    const asg = agentById(t.assignee_id);
    const by = agentById(t.assigner_id);
    const card = el('div', `task-card ${t.status}`);
    card.innerHTML = `
      <div class="task-title">${escapeHtml(t.title)}</div>
      <div class="task-meta">
        <span class="pill ${escapeAttr(t.status)}">${escapeHtml(statusLabel(t.status))}</span>
        <span class="task-flow">${escapeHtml(by ? by.name : '?')} → ${escapeHtml(asg ? asg.name : '?')}</span>
      </div>`;
    list.appendChild(card);
  }
}

function isNearBottom() {
  const b = $('#messages');
  if (!b) return true;
  return b.scrollHeight - b.scrollTop - b.clientHeight < 220;
}
function scrollToBottom(instant = false) {
  const b = $('#messages');
  if (!b) return;
  if (instant) b.scrollTop = b.scrollHeight;
  else b.scrollTo({ top: b.scrollHeight, behavior: 'smooth' });
  updateScrollButton();
}
function updateScrollButton() {
  const btn = $('#scroll-down');
  if (btn) btn.classList.toggle('hidden-soft', isNearBottom());
}

function wireComposer() {
  const input = $('#composer-input');
  const pop = $('#mention-pop');
  const btn = $('#send-btn');
  if (!input) return;

  input.value = S.drafts[S.current] || '';
  autoGrow(input);
  btn.disabled = !input.value.trim();

  input.addEventListener('input', () => {
    S.drafts[S.current] = input.value;
    autoGrow(input);
    // An empty field must not disable the button while it means "stop".
    btn.disabled = channelBusy() ? false : !input.value.trim();
    updateMentionPop(input, pop);
  });

  input.addEventListener('keydown', (e) => {
    if (!pop.classList.contains('hidden')) {
      const items = $$('.mention-item', pop);
      const active = pop.querySelector('.mention-item.active');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        let i = items.indexOf(active);
        i = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items.forEach((x) => x.classList.remove('active'));
        items[i]?.classList.add('active');
        items[i]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); active?.click(); return; }
      if (e.key === 'Escape') { e.preventDefault(); pop.classList.add('hidden'); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (channelBusy()) return;      // don't queue a message onto a live run
      send(input);
    }
  });

  input.addEventListener('blur', () => setTimeout(() => pop.classList.add('hidden'), 140));

  // Same button, two jobs — never send while a reply is being written.
  btn.onclick = () => (channelBusy() ? stopRun() : send(input));

  // Escape stops the run without leaving the keyboard.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && channelBusy() && pop.classList.contains('hidden')) {
      e.preventDefault();
      stopRun();
    }
  });
}

function autoGrow(input) {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 220) + 'px';
}

function updateMentionPop(input, pop) {
  const upToCaret = input.value.slice(0, input.selectionStart);
  const m = upToCaret.match(/@([\p{L}0-9_-]*)$/u);
  const c = channelById(S.current);
  if (!m || !c) { pop.classList.add('hidden'); return; }
  const q = m[1].toLowerCase();
  const members = c.members.map(agentById).filter(Boolean)
    .filter((a) => a.name.toLowerCase().replace(/\s+/g, '').startsWith(q));
  if (!members.length) { pop.classList.add('hidden'); return; }

  pop.innerHTML = '';
  members.forEach((a, i) => {
    const it = el('button', 'mention-item' + (i === 0 ? ' active' : ''));
    it.type = 'button';
    it.setAttribute('role', 'option');
    it.innerHTML = `${avatarHTML(a)}<span class="mention-name">${escapeHtml(a.name)}</span>
      <span class="rank-tag ${escapeAttr(a.rank)}">${escapeHtml(RANK_LABEL[a.rank] || '')}</span>`;
    it.onmousedown = (e) => e.preventDefault(); // keep focus in the textarea
    it.onclick = () => {
      const caret = input.selectionStart;
      const before = input.value.slice(0, caret).replace(/@([\p{L}0-9_-]*)$/u, '@' + a.name.replace(/\s+/g, '') + ' ');
      const after = input.value.slice(caret);
      input.value = before + after;
      S.drafts[S.current] = input.value;
      pop.classList.add('hidden');
      input.focus();
      input.setSelectionRange(before.length, before.length);
      $('#send-btn').disabled = !input.value.trim();
      autoGrow(input);
    };
    pop.appendChild(it);
  });
  pop.classList.remove('hidden');
}

async function send(input) {
  const text = input.value.trim();
  const channelId = S.current;
  if (!text || !channelId) return;

  const files = (S.pendingChannel === channelId ? S.pendingFiles : []) || [];
  const ids = files.map((f) => f.id);

  input.value = '';
  S.drafts[channelId] = '';
  S.pendingFiles = [];
  renderAttachTray();
  autoGrow(input);
  $('#send-btn').disabled = true;
  $('#mention-pop')?.classList.add('hidden');

  try {
    await api('POST', `/api/channels/${channelId}/messages`,
      ids.length ? { text, attachments: ids } : { text });
  } catch (err) {
    // Never lose what the user typed — nor the files already uploaded.
    if (S.current === channelId) {
      input.value = text;
      S.drafts[channelId] = text;
      S.pendingFiles = files;
      renderAttachTray();
      autoGrow(input);
      $('#send-btn').disabled = false;
    }
    if (err.status !== 401) toast(err.message, { kind: 'error', title: 'Envoi impossible' });
  }
}

// ============================ blocs de code =================================
/**
 * A wall of streaming code is noise: you cannot read it as it arrives, and it
 * pushes the conversation off screen. So while an agent writes, we show a live
 * pill — a rotating verb plus the running line count — and only reveal the code
 * once it is finished, folded behind a one-line summary.
 */
const CODING_VERBS = [
  'En train de coder',
  'Écrit le code',
  'Assemble la logique',
  'Compose la fonction',
  'Structure le fichier',
  'Aligne les accolades',
  "Affine l'implémentation",
  'Pose les fondations',
];
let codingVerb = 0;

// One ticker for the whole page: the markup is re-rendered on every token, so
// per-element timers would restart constantly and never advance.
setInterval(() => {
  const live = $$('.code-verb');
  if (!live.length) return;
  codingVerb = (codingVerb + 1) % CODING_VERBS.length;
  for (const n of live) {
    n.style.opacity = '0';
    setTimeout(() => { n.textContent = CODING_VERBS[codingVerb]; n.style.opacity = '1'; }, 180);
  }
}, 2600);

/**
 * Count what changed. A real diff gets real numbers; plain code only ever adds,
 * so claiming a removal count there would be inventing it.
 */
function codeStats(code) {
  const lines = String(code || '').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const add = lines.filter((l) => /^\+(?!\+\+)/.test(l)).length;
  const del = lines.filter((l) => /^-(?!--)/.test(l)).length;
  if (add + del > 0 && (add + del) >= lines.length * 0.5) return { add, del, diff: true };
  return { add: lines.length, del: 0, diff: false };
}

function renderCodeBlock(fence) {
  if (!fence) return '';
  const { code = '', lang = '', open = false } = fence;
  const { add, del, diff } = codeStats(code);

  if (open) {
    // Still streaming: no code, just a sense of progress.
    return `<div class="codeblock coding">
      <span class="code-spark" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="code-verb">${escapeHtml(CODING_VERBS[codingVerb])}</span>
      <span class="code-counts"><span class="code-add">+${add}</span>${del ? `<span class="code-del">−${del}</span>` : ''}</span>
    </div>`;
  }

  const label = lang ? lang.toLowerCase() : 'code';
  return `<div class="codeblock">
    <button class="code-head" type="button" data-code-toggle aria-expanded="false">
      <span class="code-caret" aria-hidden="true">${IC.chev}</span>
      <span class="code-lang">${escapeHtml(label)}</span>
      <span class="code-counts">
        <span class="code-add">+${add}</span>${del ? `<span class="code-del">−${del}</span>` : ''}
      </span>
      <span class="code-open">Afficher</span>
    </button>
    <div class="code-body"><div class="code-inner"><pre><code>${escapeHtml(code)}</code></pre></div></div>
  </div>`;
}

// ============================ markdown ======================================
/**
 * Minimal, safe markdown renderer.
 *
 * Order matters: code is pulled out of the RAW text first (so markdown inside
 * code is never interpreted), then everything else is HTML-escaped, then block
 * and inline rules run, then the code is put back escaped. Placeholders use
 * NUL sentinels — unlike the previous `  <n>  ` scheme, they cannot collide
 * with ordinary prose such as "il reste 3 points".
 */
function renderMarkdown(src) {
  const raw = String(src == null ? '' : src);
  if (!raw) return '';

  const fences = [];
  const inlines = [];
  const links = [];

  // 1. fenced code blocks (closed)
  let s = raw.replace(/```[ \t]*([\w+#.-]*)[ \t]*\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
    fences.push({ code: code.replace(/\n$/, ''), lang, open: false });
    return `\n\n\u0000F${fences.length - 1}\u0000\n\n`;
  });

  // 2. an unterminated fence (happens constantly while streaming) — render the
  //    tail as an open code block instead of leaking raw backticks.
  const open = s.indexOf('```');
  if (open !== -1) {
    const head = s.slice(0, open);
    const rest = s.slice(open + 3);
    const nl = rest.indexOf('\n');
    const lang = (nl === -1 ? rest : rest.slice(0, nl)).trim();
    const code = nl === -1 ? '' : rest.slice(nl + 1);
    fences.push({ code, lang, open: true });
    s = `${head}\n\n\u0000F${fences.length - 1}\u0000\n\n`;
  }

  // 3. inline code
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    inlines.push(c);
    return `\u0000C${inlines.length - 1}\u0000`;
  });

  // 4. markdown links — http(s) only, never javascript:/data:
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
    links.push({ label, href });
    return `\u0000L${links.length - 1}\u0000`;
  });

  // 5. escape everything that is left
  s = escapeHtml(s);

  // 6. inline emphasis — the delimited run may not start or end with a space,
  //    otherwise arithmetic like "a * b * c" would turn into italics.
  s = s.replace(/\*\*(\S(?:[^*\n]*\S)?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
  s = s.replace(/~~(\S(?:[^~\n]*\S)?)~~/g, '<del>$1</del>');

  // 7. bare URLs (escaped text, so &amp; may appear inside — that is fine)
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g,
    (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

  // 8. block-level assembly
  const out = [];
  for (const block of s.split(/\n{2,}/)) {
    const chunk = block.trim();
    if (!chunk) continue;

    if (/^\u0000F\d+\u0000$/.test(chunk)) { out.push(chunk); continue; }

    const lines = chunk.split('\n');

    if (lines.every((l) => /^\s*(?:[-*•]\s+)/.test(l))) {
      out.push(`<ul>${lines.map((l) => `<li>${l.replace(/^\s*[-*•]\s+/, '')}</li>`).join('')}</ul>`);
      continue;
    }
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      out.push(`<ol>${lines.map((l) => `<li>${l.replace(/^\s*\d+[.)]\s+/, '')}</li>`).join('')}</ol>`);
      continue;
    }
    if (lines.every((l) => /^&gt;\s?/.test(l))) {
      out.push(`<blockquote>${lines.map((l) => l.replace(/^&gt;\s?/, '')).join('<br>')}</blockquote>`);
      continue;
    }
    if (/^#{1,6}\s/.test(chunk) && lines.length === 1) {
      out.push(`<h4>${chunk.replace(/^#{1,6}\s+/, '')}</h4>`);
      continue;
    }
    out.push(`<p>${lines.join('<br>')}</p>`);
  }
  s = out.join('');

  // 9. restore extracted content, escaped
  s = s.replace(/\u0000F(\d+)\u0000/g, (_, i) => renderCodeBlock(fences[Number(i)]));
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(inlines[Number(i)] ?? '')}</code>`);
  s = s.replace(/\u0000L(\d+)\u0000/g, (_, i) => {
    const l = links[Number(i)];
    if (!l) return '';
    return `<a href="${escapeAttr(l.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.label)}</a>`;
  });
  return s;
}

// ============================ websocket =====================================
function connectWS() {
  clearTimeout(S.wsTimer);
  if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) return;

  setWsState(S.wsTries ? 'offline' : 'connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  try { ws = new WebSocket(`${proto}://${location.host}/ws`); }
  catch { scheduleReconnect(); return; }
  S.ws = ws;

  ws.onopen = () => {
    const wasDown = S.wsTries > 0;
    S.wsTries = 0;
    setWsState('online');
    // We may have missed events while disconnected — resync.
    if (wasDown) resync();
  };
  ws.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    handleEvent(e);
  };
  ws.onclose = (ev) => {
    S.ws = null;
    if (ev.code === 4401) { showLogin(); return; }
    setWsState('offline');
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function scheduleReconnect() {
  S.wsTries = Math.min(S.wsTries + 1, 8);
  const delay = Math.min(1000 * 2 ** (S.wsTries - 1), 20000);
  clearTimeout(S.wsTimer);
  S.wsTimer = setTimeout(connectWS, delay);
}

function setWsState(state) {
  if (S.wsState === state) return;
  S.wsState = state;
  const conn = $('.conn');
  if (conn) {
    conn.className = `conn ${state}`;
    const label = conn.querySelector('span:last-child');
    if (label) label.textContent =
      state === 'online' ? 'Temps réel actif' : state === 'offline' ? 'Reconnexion…' : 'Connexion…';
  }
}

async function resync() {
  try {
    const st = await api('GET', '/api/state');
    S.agents = st.agents || [];
    S.channels = st.channels || [];
    S.settings = st.settings || {};
    renderSidebar();
    if (S.view === 'chat' && S.current) {
      const data = await api('GET', `/api/channels/${S.current}/messages`);
      S.messages = data.messages || [];
      S.tasks = data.tasks || [];
      renderView();
    } else {
      refreshDashboard();
    }
  } catch { /* best effort */ }
}

const inChat = (channelId) => S.view === 'chat' && channelId === S.current;

function handleEvent(e) {
  switch (e.type) {
    case 'message.new':
      if (inChat(e.message.channel_id)) { upsertMessage(e.message); renderThinking(); }
      bumpChannelActivity(e.message.channel_id);
      break;

    case 'message.delta':
      if (inChat(e.channelId)) applyDelta(e.id, e.delta);
      break;

    case 'message.reasoning':
      if (inChat(e.channelId)) applyReasoning(e.id, e.delta);
      break;

    case 'message.tools': {
      const m = S.messages.find((x) => x.id === e.id);
      if (m) m.tools = JSON.stringify(e.tools);
      if (inChat(e.channelId)) repaintMessages();
      break;
    }

    case 'tool.call':
      if (inChat(e.channelId)) showToolActivity(e.id, e.label);
      break;

    case 'message.attachment':
      if (inChat(e.channelId)) appendAttachment(e.id, e.attachment);
      break;

    case 'message.notice':
      if (inChat(e.channelId)) showToolActivity(e.id, e.notice, true);
      break;

    case 'proposal.new':
      S.proposals = [e.proposal, ...S.proposals.filter((p) => p.id !== e.proposal.id)];
      if (S.view === 'brain') renderView();
      else toast(`${e.proposal.agent_name || 'Un agent'} propose une note : « ${e.proposal.title} »`, { kind: 'info' });
      break;

    case 'memory.learned':
      // Écriture directe en mémoire : la note arrive par note.change, ce
      // message-ci ne sert qu'à ce que ça ne se fasse pas dans ton dos.
      toast(`${e.agent} a retenu : « ${e.title} »`, { kind: 'success', title: 'Mémoire enrichie' });
      break;

    case 'proposals.update':
      loadProposals();
      break;

    case 'run.done':
      // Sous 12 s on est encore devant l'écran à attendre : prévenir n'aurait
      // aucun sens, et une notification par message serait vite insupportable.
      if (e.ms > 12000) {
        notify(`${e.channelName} — terminé`,
          `${e.turns} exécution${e.turns > 1 ? 's' : ''} en ${Math.round(e.ms / 1000)} s.`);
      }
      break;

    case 'budget.alert':
      toast(e.message, { kind: 'warn', title: 'Seuil de dépense atteint' });
      notify('Seuil de dépense atteint', e.message);
      break;

    case 'graph.dirty':
      // The layout is derived from the edges, so a stale graph would draw the
      // old constellation until the next full reload.
      S.graph = null;
      if (S.view === 'brain' && S.brainTab === 'graph') renderView();
      break;

    case 'message.update':
      if (inChat(e.channelId)) {
        const m = S.messages.find((x) => x.id === e.id);
        if (m) { m.content = e.content; m.status = e.status; upsertMessage(m); }
        renderThinking();
      }
      break;

    case 'agent.status': {
      const prev = S.status[e.agentId];
      S.status[e.agentId] = e.status;
      if (prev !== e.status) {
        applyStatusDots(e.agentId);
        if (S.view === 'chat') renderThinking();
        else if (S.view === 'home') scheduleDashRender();
        renderSidebarBadgesSoon();
      }
      break;
    }

    case 'message.remove':
      if (inChat(e.channelId)) removeMessageLocally(e.id);
      break;

    case 'channel.cleared':
      if (inChat(e.channelId)) {
        S.messages = [];
        S.tasks = [];
        renderView();
      }
      if (S.view === 'home') refreshDashboard();
      break;

    case 'task.update':
      if (inChat(e.task.channel_id)) {
        const i = S.tasks.findIndex((t) => t.id === e.task.id);
        if (i >= 0) S.tasks[i] = e.task; else S.tasks.unshift(e.task);
        renderTasks();
      }
      break;

    case 'agent.new':
      if (!agentById(e.agent.id)) S.agents.push(e.agent);
      renderSidebar();
      if (S.view === 'team') renderView();
      break;

    case 'agent.update': {
      const i = S.agents.findIndex((a) => a.id === e.agent.id);
      if (i >= 0) S.agents[i] = e.agent;
      renderSidebar();
      if (S.view === 'team' || S.view === 'chat') renderView();
      break;
    }

    case 'agent.remove':
      S.agents = S.agents.filter((a) => a.id !== e.id);
      renderSidebar();
      if (S.view === 'team' || S.view === 'chat') renderView();
      break;

    case 'channel.new':
      if (!channelById(e.channel.id)) S.channels.push(e.channel);
      renderSidebar();
      break;

    case 'channel.update': {
      const i = S.channels.findIndex((c) => c.id === e.channel.id);
      if (i >= 0) S.channels[i] = e.channel;
      renderSidebar();
      if (inChat(e.channel.id)) renderView();
      break;
    }

    case 'channel.remove':
      S.channels = S.channels.filter((c) => c.id !== e.id);
      renderSidebar();
      if (S.current === e.id) navigate('home');
      break;

    case 'note.change': {
      const i = S.notes.findIndex((n) => n.id === e.note.id);
      if (i >= 0) S.notes[i] = e.note; else S.notes.push(e.note);
      S.notes.sort((a, b) => (b.pinned - a.pinned) || (b.updated_at - a.updated_at));
      S.graph = null;
      // Re-rendering the graph tab on every note edit would restart the layout
      // and yank the map from under the cursor; the other tabs are cheap.
      if (S.view === 'brain' && S.brainTab !== 'graph') renderView();
      break;
    }

    case 'note.remove':
      S.notes = S.notes.filter((n) => n.id !== e.id);
      S.graph = null;
      if (S.view === 'brain' && S.brainTab !== 'graph') renderView();
      break;

    case 'providers.update':
      S.providers = e.providers || S.providers;
      if (S.view === 'settings' || S.view === 'team') renderView();
      if ($('#wizard')) renderWizard();
      break;

    case 'agents.reload':
      S.agents = e.agents || S.agents;
      renderSidebar();
      if (S.view === 'team') renderView();
      break;

    case 'settings.update':
      S.settings = e.settings || S.settings;
      renderSidebar();
      if (S.view === 'settings' || S.view === 'home') renderView();
      break;
  }
}

// Keep the sidebar "live" dots fresh without hammering it on every token.
let sidebarTimer = null;
function renderSidebarBadgesSoon() {
  if (sidebarTimer) return;
  sidebarTimer = setTimeout(() => { sidebarTimer = null; renderSidebar(); }, 600);
}
let dashTimer = null;
function scheduleDashRender() {
  if (dashTimer) return;
  dashTimer = setTimeout(() => { dashTimer = null; if (S.view === 'home') renderView(); }, 500);
}
function bumpChannelActivity(channelId) {
  const c = channelById(channelId);
  if (c) c.last_activity = Date.now();
}

// ============================ modals ========================================
let modalRestoreFocus = null;
let modalKeydown = null;

function openModal(title, build) {
  const modal = $('#modal');
  const body = $('#modal-body');
  // A modal can replace another (e.g. a confirm opened from the agent form):
  // drop the previous trap first, and keep the focus target of the outermost one.
  const alreadyOpen = !modal.classList.contains('hidden');
  if (modalKeydown) {
    document.removeEventListener('keydown', modalKeydown, true);
    modalKeydown = null;
  }
  $('#modal-title').textContent = title;
  body.innerHTML = '';
  build(body);
  modal.classList.remove('hidden');
  if (!alreadyOpen) modalRestoreFocus = document.activeElement;

  // Focus the first meaningful control.
  const first = body.querySelector('input:not([type="hidden"]), textarea, select, button');
  setTimeout(() => (first || $('#modal-close')).focus(), 40);

  // Trap Tab inside the dialog and close on Escape.
  modalKeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
    if (e.key !== 'Tab') return;
    const f = $$('button, input, textarea, select, a[href]', modal)
      .filter((n) => !n.disabled && n.offsetParent !== null);
    if (!f.length) return;
    const firstEl = f[0];
    const lastEl = f[f.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  };
  document.addEventListener('keydown', modalKeydown, true);
}

function closeModal() {
  $('#modal').classList.add('hidden');
  if (modalKeydown) { document.removeEventListener('keydown', modalKeydown, true); modalKeydown = null; }
  if (modalRestoreFocus && modalRestoreFocus.isConnected) modalRestoreFocus.focus();
  modalRestoreFocus = null;
}

$('#modal-close').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

const EMOJI_PRESET = ['🤖', '🧠', '💻', '🔎', '✍️', '💬', '🎬', '🛠️', '📊', '🎨', '⚙️', '🪽'];
const COLOR_PRESET = ['#3e5faf', '#5878c4', '#4f7cf5', '#2f9e63', '#a87f33', '#c4809a', '#7c5cbf', '#0f9b9b'];

function openAgentModal(agent) {
  const isEdit = !!agent;
  openModal(isEdit ? `Modifier ${agent.name}` : 'Nouvel agent', (b) => {
    b.innerHTML = `
      <div class="field-row">
        <div class="field" style="flex:2">
          <label for="f-name">Nom (un seul mot, sert aux @mentions)</label>
          <input id="f-name" maxlength="40" value="${isEdit ? escapeAttr(agent.name) : ''}" placeholder="ex: Nova">
          <div class="field-err" id="f-name-err"></div>
        </div>
        <div class="field" style="max-width:110px">
          <label for="f-emoji">Emoji</label>
          <input id="f-emoji" maxlength="8" value="${isEdit ? escapeAttr(agent.emoji) : '🤖'}">
        </div>
      </div>
      <div class="emoji-row" id="emoji-row">
        ${EMOJI_PRESET.map((e2) => `<button class="emoji-chip" type="button" data-emoji="${escapeAttr(e2)}">${e2}</button>`).join('')}
      </div>

      <div class="field">
        <label for="f-color">Couleur</label>
        <div style="display:flex;gap:10px;align-items:center">
          <input id="f-color" type="color" style="max-width:90px" value="${isEdit ? safeColor(agent.color) : '#3e5faf'}">
          <div class="swatch-row" id="swatch-row">
            ${COLOR_PRESET.map((c) => `<button class="swatch" type="button" data-color="${c}" style="background:${c}" aria-label="Couleur ${c}"></button>`).join('')}
          </div>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label for="f-rank">Rang</label>
          <select id="f-rank">
            <option value="ceo" ${isEdit && agent.rank === 'ceo' ? 'selected' : ''}>CEO — pilote tout, délègue aux managers</option>
            <option value="manager" ${isEdit && agent.rank === 'manager' ? 'selected' : ''}>Manager — délègue aux workers</option>
            <option value="worker" ${!isEdit || agent.rank === 'worker' ? 'selected' : ''}>Worker — exécute</option>
          </select>
        </div>
        <div class="field">
          <label for="f-title">Poste</label>
          <input id="f-title" maxlength="60" value="${isEdit ? escapeAttr(agent.title || '') : ''}" placeholder="ex: Community Manager">
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label for="f-provider">Fournisseur</label>
          <select id="f-provider">
            ${S.providers.map((p) => `<option value="${escapeAttr(p.id)}"
              ${(isEdit ? agent.provider : 'hermes') === p.id ? 'selected' : ''}
              ${p.enabled ? '' : 'disabled'}>${escapeHtml(p.label)}${p.enabled ? '' : ' — indisponible'}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="f-model">Modèle</label>
          <select id="f-model"></select>
        </div>
      </div>
      <div class="field-hint" id="provider-hint" style="margin-top:-6px"></div>

      <div class="field">
        <label for="f-role">Rôle / instructions (system prompt)</label>
        <textarea id="f-role" rows="5" maxlength="4000" placeholder="Tu es …">${isEdit ? escapeHtml(agent.role_prompt) : ''}</textarea>
        <div class="field-hint">Décris sa mission, son ton et ses limites. C'est ce qui définit l'agent.</div>
      </div>

      <button class="primary" id="f-save" type="button">${isEdit ? 'Enregistrer' : "Créer l'agent"}</button>
      ${isEdit && !agent.is_system ? '<button class="del-link" id="f-del" type="button">Supprimer cet agent</button>' : ''}`;

    $$('#emoji-row [data-emoji]', b).forEach((n) => n.onclick = () => { $('#f-emoji', b).value = n.dataset.emoji; });
    $$('#swatch-row [data-color]', b).forEach((n) => n.onclick = () => { $('#f-color', b).value = n.dataset.color; });

    // The model list depends on the provider, so it is rebuilt on every change.
    const provSel = $('#f-provider', b);
    const modelSel = $('#f-model', b);
    const hintBox = $('#provider-hint', b);
    const syncModels = (keepCurrent) => {
      const p = S.providers.find((x) => x.id === provSel.value) || S.providers[0];
      if (!p) return;
      const wanted = keepCurrent && isEdit && p.models.includes(agent.model) ? agent.model : p.defaultModel;
      modelSel.innerHTML = p.models
        .map((m) => `<option value="${escapeAttr(m)}" ${m === wanted ? 'selected' : ''}>${escapeHtml(m)}</option>`)
        .join('');
      hintBox.textContent = p.hint || '';
    };
    provSel.onchange = () => syncModels(false);
    syncModels(true);

    $('#f-save', b).onclick = async (ev) => {
      const name = $('#f-name', b).value.trim();
      const errBox = $('#f-name-err', b);
      errBox.textContent = '';
      if (!name) { errBox.textContent = 'Le nom est obligatoire.'; $('#f-name', b).focus(); return; }
      const clash = S.agents.find((a) => a.name.toLowerCase() === name.toLowerCase() && (!isEdit || a.id !== agent.id));
      if (clash) { errBox.textContent = 'Un agent porte déjà ce nom — les @mentions seraient ambiguës.'; return; }

      const payload = {
        name,
        emoji: $('#f-emoji', b).value.trim() || '🤖',
        color: $('#f-color', b).value,
        rank: $('#f-rank', b).value,
        title: $('#f-title', b).value.trim(),
        role_prompt: $('#f-role', b).value,
        provider: $('#f-provider', b).value,
        model: $('#f-model', b).value,
      };
      ev.currentTarget.disabled = true;
      const res = await tryApi(
        isEdit ? api('PUT', `/api/agents/${agent.id}`, payload) : api('POST', '/api/agents', payload),
        isEdit ? 'Modification' : 'Création');
      ev.currentTarget.disabled = false;
      if (res) {
        closeModal();
        toast(isEdit ? `${res.name} mis à jour.` : `${res.name} rejoint l'équipe.`, { kind: 'success' });
      }
    };

    const del = $('#f-del', b);
    if (del) del.onclick = () => confirmModal(
      `Supprimer ${agent.name} ?`,
      "L'agent est retiré de tous les pôles. Les messages déjà postés sont conservés.",
      async () => {
        const r = await tryApi(api('DELETE', `/api/agents/${agent.id}`), 'Suppression');
        if (r) { closeModal(); toast(`${agent.name} supprimé.`, { kind: 'success' }); }
      });
  });
}

function openPoleModal(pole) {
  const isEdit = !!pole;
  openModal(isEdit ? `Modifier le pôle ${pole.name}` : 'Nouveau pôle', (b) => {
    b.innerHTML = `
      <div class="field-row">
        <div class="field" style="flex:2">
          <label for="p-name">Nom du pôle</label>
          <input id="p-name" maxlength="40" value="${isEdit ? escapeAttr(pole.name) : ''}" placeholder="ex: Marketing">
          <div class="field-err" id="p-name-err"></div>
        </div>
        <div class="field" style="max-width:110px">
          <label for="p-emoji">Emoji</label>
          <input id="p-emoji" maxlength="8" value="${isEdit ? escapeAttr(pole.emoji) : '🗂️'}">
        </div>
        <div class="field" style="max-width:90px">
          <label for="p-color">Couleur</label>
          <input id="p-color" type="color" value="${isEdit ? safeColor(pole.color, '#3e5faf') : '#3e5faf'}">
        </div>
      </div>
      <div class="field">
        <label for="p-topic">Sujet</label>
        <input id="p-topic" maxlength="140" value="${isEdit ? escapeAttr(pole.topic || '') : ''}" placeholder="À quoi sert ce pôle ?">
      </div>
      <div class="field">
        <label>Membres</label>
        <div class="checklist" id="p-members"></div>
        <div class="field-hint">Le membre le plus haut placé reçoit les messages du salon et délègue aux autres.</div>
      </div>
      <button class="primary" id="p-save" type="button">${isEdit ? 'Enregistrer' : 'Créer le pôle'}</button>
      ${isEdit ? '<button class="del-link" id="p-del" type="button">Supprimer ce pôle</button>' : ''}`;

    const cl = $('#p-members', b);
    const current = new Set(isEdit ? pole.members : []);
    for (const a of [...S.agents].sort(byRank)) {
      const it = el('label', 'checklist-item');
      it.innerHTML = `<input type="checkbox" value="${escapeAttr(a.id)}" ${current.has(a.id) ? 'checked' : ''}>
        ${avatarHTML(a, { size: 24 })}
        <span class="checklist-name">${escapeHtml(a.name)}</span>
        <span class="rank-tag ${escapeAttr(a.rank)}">${escapeHtml(RANK_LABEL[a.rank] || '')}</span>`;
      cl.appendChild(it);
    }

    $('#p-save', b).onclick = async (ev) => {
      const name = $('#p-name', b).value.trim();
      const errBox = $('#p-name-err', b);
      errBox.textContent = '';
      if (!name) { errBox.textContent = 'Le nom est obligatoire.'; $('#p-name', b).focus(); return; }
      const members = $$('input:checked', cl).map((i) => i.value);
      const payload = {
        name,
        emoji: $('#p-emoji', b).value.trim() || '🗂️',
        color: $('#p-color', b).value,
        topic: $('#p-topic', b).value.trim(),
      };
      ev.currentTarget.disabled = true;
      if (isEdit) {
        const r1 = await tryApi(api('PUT', `/api/channels/${pole.id}`, payload), 'Modification');
        if (r1) await tryApi(api('PUT', `/api/channels/${pole.id}/members`, { members }), 'Membres');
        ev.currentTarget.disabled = false;
        if (r1) { closeModal(); toast('Pôle mis à jour.', { kind: 'success' }); }
      } else {
        const c = await tryApi(api('POST', '/api/channels', { ...payload, kind: 'pole', members }), 'Création');
        ev.currentTarget.disabled = false;
        if (c) { closeModal(); toast(`Pôle ${c.name} créé.`, { kind: 'success' }); openChannel(c.id); }
      }
    };

    const del = $('#p-del', b);
    if (del) del.onclick = () => confirmModal(
      `Supprimer le pôle ${pole.name} ?`,
      'Tous les messages et toutes les tâches de ce salon seront définitivement effacés. Les agents, eux, sont conservés.',
      async () => {
        const r = await tryApi(api('DELETE', `/api/channels/${pole.id}`), 'Suppression');
        if (r) { closeModal(); toast('Pôle supprimé.', { kind: 'success' }); navigate('home'); }
      });
  });
}

// Replaces window.confirm — styled, focus-managed, and non-blocking.
function confirmModal(title, text, onConfirm) {
  openModal(title, (b) => {
    b.innerHTML = `
      <p style="margin:0;color:var(--muted);line-height:1.6">${escapeHtml(text)}</p>
      <div style="display:flex;gap:10px;margin-top:6px">
        <button class="btn ghost" id="c-cancel" type="button" style="flex:1">Annuler</button>
        <button class="btn danger" id="c-ok" type="button" style="flex:1">Supprimer</button>
      </div>`;
    $('#c-cancel', b).onclick = closeModal;
    $('#c-ok', b).onclick = async (ev) => { ev.currentTarget.disabled = true; await onConfirm(); };
  });
}

// ============================ command palette ===============================
function openPalette() {
  const p = $('#palette');
  p.classList.remove('hidden');
  const input = $('#palette-input');
  input.value = '';
  setTimeout(() => input.focus(), 30);

  // Recherche plein texte côté serveur, en plus du filtrage local.
  //
  // `seq` est là parce que deux frappes rapprochées lancent deux requêtes : sans
  // ce jeton, une réponse lente à « ac » pourrait écraser les résultats de
  // « acme » arrivés avant elle.
  let seq = 0;
  let debounce = null;

  const runSearch = (q) => {
    clearTimeout(debounce);
    const box = $('#palette-deep');
    if (q.length < 2) { if (box) box.innerHTML = ''; return; }
    const mine = ++seq;
    debounce = setTimeout(async () => {
      let r;
      try { r = await api('GET', `/api/search?q=${encodeURIComponent(q)}`); }
      catch { return; }
      if (mine !== seq) return;                 // une frappe plus récente a gagné
      const target = $('#palette-deep');
      if (!target) return;
      target.innerHTML = deepResultsHTML(r);
      $$('[data-goto-channel]', target).forEach((n) => n.onclick = () => {
        closePalette();
        openChannel(n.dataset.gotoChannel);
      });
      $$('[data-goto-note]', target).forEach((n) => n.onclick = () => {
        const note = S.notes.find((x) => x.id === n.dataset.gotoNote);
        closePalette();
        if (note) openNoteModal(note);
        else navigate('brain');
      });
    }, 220);
  };

  const render = () => {
    const q = input.value.toLowerCase().trim();
    runSearch(q);
    const items = [
      ...S.channels.map((c) => ({
        type: 'pôle', label: c.kind === 'hermes' ? c.name : 'Pôle ' + c.name,
        color: c.color, emoji: c.emoji, go: () => { closePalette(); openChannel(c.id); },
      })),
      ...S.agents.map((a) => ({
        type: 'agent', label: a.name, color: a.color, initials: initials(a.name),
        go: () => { closePalette(); openAgentModal(a); },
      })),
      ...[['home', 'Accueil'], ['team', 'Mon équipe'], ['brain', 'Second cerveau'], ['usage', 'Consommation'], ['journal', 'Journal'], ['settings', 'Réglages']]
        .map(([v, lb]) => ({ type: 'page', label: lb, color: '#3e5faf', initials: '›', go: () => { closePalette(); navigate(v); } })),
    ].filter((x) => !q || x.label.toLowerCase().includes(q));

    const res = $('#palette-results');
    res.innerHTML = '';
    if (!items.length) {
      res.innerHTML = `<div class="palette-empty">Rien ne porte ce nom${q.length >= 2 ? ' — recherche dans le contenu en cours…' : ''}</div>`;
      ensureDeepBox(res);
      return;
    }
    items.forEach((x, i) => {
      const it = el('button', 'palette-item' + (i === 0 ? ' active' : ''));
      it.type = 'button';
      it.setAttribute('role', 'option');
      const av = x.emoji
        ? `<span class="av square" style="background:${softColor(x.color)};color:${safeColor(x.color, '#3e5faf')}">${escapeHtml(x.emoji)}</span>`
        : `<span class="av" style="background:${safeColor(x.color, '#3e5faf')}">${escapeHtml(x.initials)}</span>`;
      it.innerHTML = `${av}<span class="palette-label">${escapeHtml(x.label)}</span><span class="palette-kind">${x.type}</span>`;
      it.onclick = x.go;
      res.appendChild(it);
    });
    ensureDeepBox(res);
  };

  input.oninput = render;
  input.onkeydown = (e) => {
    const res = $('#palette-results');
    const nodes = $$('.palette-item', res);
    const active = res.querySelector('.palette-item.active');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!nodes.length) return;
      let i = nodes.indexOf(active);
      i = e.key === 'ArrowDown' ? (i + 1) % nodes.length : (i - 1 + nodes.length) % nodes.length;
      nodes.forEach((n) => n.classList.remove('active'));
      nodes[i].classList.add('active');
      nodes[i].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); active?.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  };
  render();
}
function closePalette() { $('#palette').classList.add('hidden'); }

/** Conteneur des résultats plein texte, sous la liste de navigation. */
function ensureDeepBox(res) {
  if (res.querySelector('#palette-deep')) return;
  const box = el('div', 'palette-deep');
  box.id = 'palette-deep';
  res.appendChild(box);
}

/**
 * FTS5 renvoie ses extraits avec `<<` et `>>` autour des mots trouvés — des
 * marqueurs choisis parce qu'ils survivent à l'échappement HTML, contrairement
 * à des balises que `escapeHtml` neutraliserait.
 */
const markExcerpt = (s) => escapeHtml(String(s || ''))
  .replace(/&lt;&lt;/g, '<mark>').replace(/&gt;&gt;/g, '</mark>');

function deepResultsHTML(r) {
  const parts = [];
  if (r.notes?.length) {
    parts.push('<div class="palette-group">Dans la mémoire</div>');
    for (const n of r.notes.slice(0, 6)) {
      parts.push(`<button class="palette-item deep" type="button" role="option" data-goto-note="${escapeAttr(n.id)}">
        <span class="av square" style="background:var(--accent-soft);color:var(--accent-ink)">🧠</span>
        <span class="palette-label"><strong>${escapeHtml(n.title)}</strong><small>${markExcerpt(n.excerpt)}</small></span>
      </button>`);
    }
  }
  if (r.messages?.length) {
    parts.push('<div class="palette-group">Dans les conversations</div>');
    for (const m of r.messages.slice(0, 8)) {
      const c = channelById(m.channel_id);
      parts.push(`<button class="palette-item deep" type="button" role="option" data-goto-channel="${escapeAttr(m.channel_id)}">
        <span class="av" style="background:${safeColor(m.author_color, '#8a8f9a')}">${escapeHtml(m.author_emoji || initials(m.author_name))}</span>
        <span class="palette-label"><strong>${escapeHtml(m.author_name)}${c ? ` · ${escapeHtml(c.name)}` : ''}</strong><small>${markExcerpt(m.excerpt)}</small></span>
        <span class="palette-kind">${new Date(m.created_at).toLocaleDateString('fr-FR')}</span>
      </button>`);
    }
  }
  if (!parts.length) return '<div class="palette-group">Rien dans le contenu non plus.</div>';
  return parts.join('');
}
$('#palette').onclick = (e) => { if (e.target.id === 'palette') closePalette(); };

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('#app').classList.contains('hidden')) return;
    $('#palette').classList.contains('hidden') ? openPalette() : closePalette();
  }
});

// ============================ theme =========================================
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
}

// ============================ init ==========================================
// Refresh relative timestamps without touching anything else.
setInterval(() => {
  if (S.view === 'home' && !S.loading) renderView();
}, 60000);

// Reconnect faster when the tab comes back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.booted && !S.ws) { S.wsTries = 0; connectWS(); }
});

// Fall back to the OS preference before any explicit choice has been stored.
function preferredTheme() {
  const saved = localStorage.getItem('ah_theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Follow the OS while the user has not picked a theme themselves.
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', (e) => {
  if (!localStorage.getItem('ah_theme')) { applyTheme(e.matches ? 'dark' : 'light'); renderTopbar(); }
});

(async function init() {
  applyTheme(preferredTheme());
  let me = { authed: false, claimed: true };
  try { me = await (await fetch('/api/me')).json(); } catch { /* offline */ }
  S.auth = {
    claimed: me.claimed !== false,
    envPassword: Boolean(me.envPassword),
    minPassword: me.minPassword || 8,
  };
  if (me.authed) { showApp(); await boot(); } else { showLogin(); }
})();
