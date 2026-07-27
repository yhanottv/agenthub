'use strict';

/* ============================================================================
   AgentHub — SPA client
   Vanilla JS, no build step. Sections: state → utils → toasts → api → icons →
   router → renders → markdown → websocket → modals → palette → init.
   ========================================================================== */

// ============================ state =========================================
const VIEWS = ['home', 'team', 'brain', 'usage', 'journal', 'settings'];

const S = {
  agents: [], channels: [], settings: {}, providers: [],
  stats: null, activity: [],
  notes: [], usage: null, usageRange: '7d',
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
};

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
  if (S.view === 'brain') renderView();
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
  else if (S.view === 'brain') loadNotes();
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

  if (S.loading) return renderSkeleton(v);
  if (S.view === 'chat') return renderChat(v);
  if (S.view === 'team') return renderTeam(v);
  if (S.view === 'brain') return renderBrain(v);
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

// ---- Second cerveau --------------------------------------------------------
const NOTES_BUDGET = 6000;   // must match NOTES_CONTEXT_BUDGET server-side

function notesUsedChars() {
  return S.notes.reduce((n, x) => n + (x.content.trim() ? x.title.length + x.content.trim().length + 5 : 0), 0);
}

function renderBrain(v) {
  const used = notesUsedChars();
  const pct = Math.min(100, Math.round((used / NOTES_BUDGET) * 100));
  const over = used > NOTES_BUDGET;

  v.innerHTML = `<div class="page">
    <div class="page-head">
      <h1>Second cerveau</h1>
      <button class="btn" id="note-new" type="button">${IC.plus} Nouvelle note</button>
    </div>
    <p class="page-lede">
      La mémoire commune de ton organisation. Tout ce qui est écrit ici est ajouté au
      prompt de <strong>chaque agent</strong>, dans chaque salon — c'est ce qu'ils savent
      sans que tu aies à le répéter.
    </p>

    <div class="budget">
      <div class="budget-head">
        <span>${used.toLocaleString('fr-FR')} / ${NOTES_BUDGET.toLocaleString('fr-FR')} caractères injectés</span>
        <span class="${over ? 'budget-over' : 'muted'}">${over ? 'au-delà : les dernières notes seront tronquées' : `${pct} %`}</span>
      </div>
      <div class="budget-bar"><span style="width:${pct}%" class="${over ? 'over' : ''}"></span></div>
      <div class="field-hint" style="margin-top:8px">Les notes épinglées passent en premier et sont donc les dernières à être coupées.</div>
    </div>

    ${S.notes.length ? `<div class="note-grid">${S.notes.map(noteCardHTML).join('')}</div>` : `
      <div class="empty" style="text-align:left;padding:28px;line-height:1.75">
        <div class="empty-ic" aria-hidden="true">🧠</div>
        <strong>Rien en mémoire pour l'instant.</strong><br>
        Écris ici ce que tes agents doivent toujours savoir : le ton de ta marque, tes
        clients, tes contraintes, tes décisions déjà prises. Une bonne première note :
        « Contexte de l'organisation » — qui tu es et ce que tu fais.
      </div>`}
  </div>`;

  $('#note-new', v).onclick = () => openNoteModal(null);
  $$('[data-note]', v).forEach((n) => n.onclick = () => openNoteModal(S.notes.find((x) => x.id === n.dataset.note)));
  $$('[data-pin]', v).forEach((n) => n.onclick = async (e) => {
    e.stopPropagation();
    const note = S.notes.find((x) => x.id === n.dataset.pin);
    await tryApi(api('PUT', `/api/notes/${note.id}`, { pinned: note.pinned ? 0 : 1 }), 'Épinglage');
  });
}

function noteCardHTML(n) {
  const preview = (n.content || '').replace(/\s+/g, ' ').trim();
  return `<div class="note-card ${n.pinned ? 'pinned' : ''}">
    <button class="note-open" type="button" data-note="${escapeAttr(n.id)}">
      <span class="note-title">${escapeHtml(n.title)}</span>
      <span class="note-preview">${escapeHtml(preview || 'Note vide')}</span>
      <span class="note-meta">${(n.content || '').length.toLocaleString('fr-FR')} caractères · modifiée ${agoText(n.updated_at)}</span>
    </button>
    <button class="note-pin ${n.pinned ? 'on' : ''}" type="button" data-pin="${escapeAttr(n.id)}"
            aria-label="${n.pinned ? 'Désépingler' : 'Épingler'}" title="${n.pinned ? 'Désépingler' : 'Épingler'}">${IC.pin}</button>
  </div>`;
}

function openNoteModal(note) {
  const isEdit = !!note;
  openModal(isEdit ? 'Modifier la note' : 'Nouvelle note', (b) => {
    b.innerHTML = `
      <div class="field">
        <label for="n-title">Titre</label>
        <input id="n-title" maxlength="120" value="${isEdit ? escapeAttr(note.title) : ''}"
               placeholder="ex: Contexte de l'organisation">
      </div>
      <div class="field">
        <label for="n-content">Contenu</label>
        <textarea id="n-content" rows="12" maxlength="8000"
                  placeholder="Ce que tous tes agents doivent savoir…">${isEdit ? escapeHtml(note.content) : ''}</textarea>
        <div class="field-hint"><span id="n-count">0</span> / 8000 caractères</div>
      </div>
      <label class="checklist-item" style="padding:0">
        <input type="checkbox" id="n-pin" ${isEdit && note.pinned ? 'checked' : ''}>
        <span>Épingler — cette note passe en premier dans le contexte</span>
      </label>
      <button class="primary" id="n-save" type="button">${isEdit ? 'Enregistrer' : 'Créer la note'}</button>
      ${isEdit ? '<button class="del-link" id="n-del" type="button">Supprimer cette note</button>' : ''}`;

    const content = $('#n-content', b);
    const count = $('#n-count', b);
    const sync = () => { count.textContent = content.value.length.toLocaleString('fr-FR'); };
    content.addEventListener('input', sync);
    sync();

    $('#n-save', b).onclick = async (ev) => {
      const payload = {
        title: $('#n-title', b).value.trim() || 'Sans titre',
        content: content.value,
        pinned: $('#n-pin', b).checked ? 1 : 0,
      };
      ev.currentTarget.disabled = true;
      const r = await tryApi(
        isEdit ? api('PUT', `/api/notes/${note.id}`, payload) : api('POST', '/api/notes', payload),
        'Enregistrement');
      ev.currentTarget.disabled = false;
      if (r) { closeModal(); toast(isEdit ? 'Note mise à jour.' : 'Note ajoutée à la mémoire.', { kind: 'success' }); }
    };

    const del = $('#n-del', b);
    if (del) del.onclick = () => confirmModal(
      `Supprimer « ${note.title} » ?`,
      'Cette information disparaîtra du contexte de tous tes agents.',
      async () => {
        const r = await tryApi(api('DELETE', `/api/notes/${note.id}`), 'Suppression');
        if (r) { closeModal(); toast('Note supprimée.', { kind: 'success' }); }
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
      </div>

      <button class="btn ghost" id="pv-test" type="button">${IC.spark} Tester et lister les modèles</button>
      <div id="pv-result"></div>

      <div class="field" id="pv-model-wrap" ${(p.models && p.models.length) ? '' : 'hidden'}>
        <label for="pv-model">Modèle par défaut</label>
        <select id="pv-model">
          ${(p.models || []).map((m) => `<option value="${escapeAttr(m)}" ${m === p.defaultModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
        </select>
      </div>

      <button class="primary" id="pv-save" type="button">${isNew ? 'Connecter le service' : 'Enregistrer'}</button>
      ${!isNew ? '<button class="del-link" id="pv-del" type="button">Retirer ce service</button>' : ''}`;

    const result = $('#pv-result', b);
    const modelWrap = $('#pv-model-wrap', b);
    const modelSel = $('#pv-model', b);

    const currentId = () => slugify($('#pv-id', b).value || id);

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
          hint: pre.hint || '',
          session_header: pre.session_header || '',
          needs_key: needsKey,
        }), 'Enregistrement');
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
        modelWrap.removeAttribute('hidden');
        const keep = modelSel.value;
        modelSel.innerHTML = r.models
          .map((m) => `<option value="${escapeAttr(m)}" ${m === keep || m === p.defaultModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
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

// ---- Assistant de première configuration -----------------------------------
const WIZ_STEPS = ['Bienvenue', 'Hermes', 'Services', 'Modèle'];

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

  const body = [wizWelcome, wizHermes, wizServices, wizModel][step](s, usable);

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
      <p class="wiz-lede">On va vérifier ton installation et connecter au moins un service
        de modèles. Trois minutes, et ton organisation d'agents est prête à travailler.</p>
      <ul class="wiz-list">
        <li><strong>Hermes</strong> — on vérifie qu'il répond et ce qu'il propose.</li>
        <li><strong>Services</strong> — AgentRouter, OpenRouter, OpenAI, Ollama… tu choisis.</li>
        <li><strong>Modèle</strong> — celui que tes agents utiliseront par défaut.</li>
      </ul>
      ${s.agents ? `<p class="wiz-note">Ton organisation compte déjà ${s.agents} agent${s.agents > 1 ? 's' : ''} et ${s.channels} salon${s.channels > 1 ? 's' : ''}.</p>` : ''}`,
  };
}

function wizHermes(s) {
  const h = s.hermes || {};
  const state = h.reachable ? 'good' : h.configured ? 'bad' : 'warn';
  return {
    nextLabel: 'Suivant',
    html: `
      <h2 class="wiz-title">Hermes Agent</h2>
      <p class="wiz-lede">Hermes apporte la continuité de session, ses outils et sa mémoire
        persistante. AgentHub fonctionne sans, mais c'est mieux avec.</p>
      <div class="check-row ${state}">
        <span class="check-ic">${h.reachable ? '✓' : h.configured ? '✕' : '!'}</span>
        <div class="check-main">
          <div class="check-title">${h.reachable ? 'Hermes répond' : h.configured ? 'Hermes ne répond pas' : 'Hermes n\'est pas configuré'}</div>
          <div class="check-detail">
            ${h.configured ? `<code>${escapeHtml(h.base)}</code>` : 'Aucune URL enregistrée.'}
            ${h.reachable ? ` · ${h.models.length} modèle${h.models.length > 1 ? 's' : ''}` : ''}
            ${h.error ? `<br>${escapeHtml(h.error)}` : ''}
          </div>
        </div>
      </div>
      ${h.reachable ? '' : `
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
      <button class="btn ghost" id="wiz-h-edit" type="button" style="margin-top:14px">Configurer Hermes</button>
      <button class="btn ghost" id="wiz-h-retry" type="button" style="margin-top:14px">Revérifier</button>`,
    wire: (w) => {
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
    nextLabel: 'Terminer',
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
            <select id="wz-model">${prov.models.map((m) => `<option value="${escapeAttr(m)}" ${m === prov.defaultModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
            ${prov.models.length ? '' : '<option value="">— aucun modèle listé —</option>'}</select>
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
      const payload = { provider: sel.value, model: mod ? mod.value : undefined };
      for (const a of S.agents) {
        await tryApi(api('PUT', `/api/agents/${a.id}`, payload), 'Application du modèle');
      }
      toast(`Modèle appliqué à ${S.agents.length} agent${S.agents.length > 1 ? 's' : ''}.`, { kind: 'success' });
      return true;
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
        ${statCard('Tokens envoyés', IC.arrow, fmtTokens(u.tokensIn), 'contexte + instructions')}
        ${statCard('Tokens reçus', IC.chat, fmtTokens(u.tokensOut), 'réponses des agents')}
        ${statCard('Total', IC.tokens, fmtTokens(totalTokens), u.estimated ? 'estimation' : 'compté par le fournisseur')}
        ${statCard('Appels modèle', IC.bolt, u.calls, 'requêtes envoyées')}
      </div>

      ${u.calls === 0 ? emptyBox('📊', "Aucun appel sur cette période. Écris à un pôle et les compteurs se rempliront.") : `
        <div class="section-title">Évolution
          <small>${u.bucketMs < 86400000 ? 'heure par heure' : 'jour par jour'}</small></div>
        ${usageChart(u.series, u.bucketMs)}

        <div class="section-title">Par modèle</div>
        <div class="usage-table">
          ${u.byModel.map((r) => usageRow(
            `${escapeHtml(r.provider)} · ${escapeHtml(r.model)}`,
            r.calls, r.tokens_in + r.tokens_out, totalTokens)).join('')}
        </div>

        <div class="section-title">Par agent</div>
        <div class="usage-table">
          ${u.byAgent.map((r) => {
            const a = agentById(r.agent_id);
            return usageRow(a ? escapeHtml(a.name) : 'agent supprimé',
              r.calls, r.tokens_in + r.tokens_out, totalTokens, a);
          }).join('') || '<div class="muted" style="padding:12px">Aucun agent sur la période.</div>'}
        </div>
      `}

      <div class="field-hint" style="margin-top:22px;line-height:1.7">
        ${u.estimated
          ? "Les fournisseurs branchés ne renvoient pas de décompte par requête : ces chiffres sont estimés à environ 4 caractères par token. L'ordre de grandeur et les tendances sont fiables, pas le chiffre exact."
          : 'Chiffres renvoyés directement par le fournisseur.'}
      </div>
    `}
  </div>`;

  $$('[data-range]', v).forEach((n) => n.onclick = () => { S.usageRange = n.dataset.range; loadUsage(); });
  if (u && u.series) wireChart(v, u.series, u.bucketMs);
}

function usageRow(label, calls, tokens, total, agent) {
  const pct = total ? Math.round((tokens / total) * 100) : 0;
  return `<div class="usage-row">
    ${agent ? avatarHTML(agent, { size: 26 }) : '<span class="usage-dot"></span>'}
    <span class="usage-label">${label}</span>
    <span class="usage-bar"><span style="width:${pct}%"></span></span>
    <span class="usage-num">${fmtTokens(tokens)}</span>
    <span class="usage-calls">${calls} appel${calls > 1 ? 's' : ''}</span>
  </div>`;
}

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
          <div class="field-hint" style="line-height:1.7">
            Le mot de passe est imposé par la variable d'environnement <code>APP_PASSWORD</code>.
            Retire-la de ta configuration pour pouvoir le gérer ici.
          </div>` : `
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
          <button class="btn" id="save-password" type="button" style="margin-top:12px">Changer le mot de passe</button>
          <div class="field-hint" style="margin-top:10px">
            ${S.auth.minPassword} caractères minimum. Aucune récupération possible : note-le.
          </div>`}
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
    </div>
  </div>`;

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
            <button class="icon-btn" id="clear-chat" type="button"
                    aria-label="Vider la conversation" title="Vider la conversation">${IC.broom}</button>
            ${canEdit ? `<button class="icon-btn" id="edit-pole" type="button" aria-label="Modifier le pôle" title="Modifier le pôle">${IC.edit}</button>` : ''}
          </div>
        </div>

        <div class="messages" id="messages" role="log" aria-label="Messages du salon" aria-live="polite"></div>

        <div class="composer-wrap">
          <button class="scroll-down hidden-soft" id="scroll-down" type="button" aria-label="Revenir en bas">${IC.down}</button>
          <div id="mention-pop" class="mention-pop hidden" role="listbox" aria-label="Mentionner un agent"></div>
          <div class="composer">
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
      <div class="msg-content ${m.status === 'streaming' ? 'cursor' : ''}">${renderMarkdown(m.content)}</div>
    </div>
    ${m.status === 'streaming' ? '' : deleteBtn(m.id)}`;
  return w;
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
        <span>${escapeHtml(a.name)} ${S.status[a.id] === 'working' ? 'travaille' : 'réfléchit'}</span>
        <span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
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

  input.value = '';
  S.drafts[channelId] = '';
  autoGrow(input);
  $('#send-btn').disabled = true;
  $('#mention-pop')?.classList.add('hidden');

  try {
    await api('POST', `/api/channels/${channelId}/messages`, { text });
  } catch (err) {
    // Never lose what the user typed.
    if (S.current === channelId) {
      input.value = text;
      S.drafts[channelId] = text;
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
      if (S.view === 'brain') renderView();
      break;
    }

    case 'note.remove':
      S.notes = S.notes.filter((n) => n.id !== e.id);
      if (S.view === 'brain') renderView();
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

  const render = () => {
    const q = input.value.toLowerCase().trim();
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
      res.innerHTML = `<div class="palette-empty">Aucun résultat pour « ${escapeHtml(input.value)} »</div>`;
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
