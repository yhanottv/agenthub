// Streaming client for OpenAI-compatible chat endpoints.
//
// Providers are stored in the database (see db.js `Providers`) so they can be
// added and re-keyed from the UI at runtime. Environment variables are only
// used to seed the table on first boot.

import { Providers, Settings } from './db.js';

const IDLE_TIMEOUT_MS = Number(process.env.LLM_IDLE_TIMEOUT_MS || 120000);

/**
 * Délai avant le PREMIER octet, pas délai d'établissement de connexion.
 *
 * Il était à 30 s, ce qui paraissait large. Mesuré en production sur
 * AgentRouter, avec des requêtes quasi identiques : 2,7 s, 3,2 s, 15,4 s,
 * 3,2 s. La latence d'une passerelle qui répartit vers plusieurs fournisseurs
 * est erratique par nature, et un modèle à raisonnement peut légitimement
 * réfléchir longtemps avant d'émettre quoi que ce soit. 30 s coupait des
 * requêtes parfaitement saines.
 */
const CONNECT_TIMEOUT_MS = Number(process.env.LLM_CONNECT_TIMEOUT_MS || 90000);
const PROBE_TIMEOUT_MS = Number(process.env.LLM_PROBE_TIMEOUT_MS || 15000);

/** Known services offered in the setup wizard. Purely descriptive. */
export const PRESETS = [
  {
    id: 'hermes', label: 'Hermes', base_url: 'http://hermes-agent:8642',
    hint: "Ton gateway local. Continuité de session et outils Hermes, mémoire persistante.",
    session_header: 'X-Hermes-Session-Key', needs_key: true, local: true,
  },
  {
    id: 'agentrouter', label: 'AgentRouter', base_url: 'http://agentrouter-proxy:8318/v1',
    hint: "Modèles Claude. Suppose un conteneur proxy `agentrouter-proxy` que tu fais "
        + "tourner toi-même — adapte l'URL si le tien est ailleurs.",
    needs_key: true,
  },
  {
    id: 'openrouter', label: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1',
    hint: 'Passerelle vers des centaines de modèles (Claude, GPT, Llama, Mistral…).',
    needs_key: true,
  },
  {
    id: 'openai', label: 'OpenAI', base_url: 'https://api.openai.com/v1',
    hint: 'Modèles GPT officiels, et génération d\'images avec gpt-image-1.', needs_key: true,
  },
  {
    // Google expose une façade compatible OpenAI devant l'API Gemini, ce qui
    // permet de s'y brancher sans client dédié.
    id: 'gemini', label: 'Google Gemini',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    hint: 'Modèles Gemini, dont ceux qui dessinent. Clé gratuite sur Google AI Studio.',
    needs_key: true,
  },
  {
    id: 'groq', label: 'Groq', base_url: 'https://api.groq.com/openai/v1',
    hint: 'Inférence très rapide sur modèles ouverts.', needs_key: true,
  },
  {
    id: 'together', label: 'Together AI', base_url: 'https://api.together.xyz/v1',
    hint: 'Large catalogue de modèles ouverts.', needs_key: true,
  },
  {
    id: 'ollama', label: 'Ollama', base_url: 'http://host.docker.internal:11434/v1',
    hint: 'Modèles tournant en local, sans clé ni connexion sortante.',
    needs_key: false, local: true,
  },
];

/**
 * Seed the provider table from env the first time the app boots.
 *
 * Only Hermes is created unconditionally: it is the companion this app is
 * designed to sit next to, and the setup wizard needs an entry to probe and
 * configure. Everything else is created ONLY when actually configured —
 * otherwise a fresh install on someone else's VPS would inherit a dead
 * provider pointing at a container that exists nowhere but the author's box.
 */
export function seedProvidersFromEnv() {
  if (Providers.count() > 0) return 0;
  let n = 0;
  const seed = (id, apiKey, baseUrl, model) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    Providers.upsert({
      ...preset,
      base_url: baseUrl || preset.base_url,
      api_key: apiKey || '',
      default_model: model || '',
      models: model ? [model] : [],
      sort: n,
    });
    n++;
  };

  seed('hermes', process.env.HERMES_API_KEY, process.env.HERMES_API_URL,
    process.env.HERMES_MODEL || 'hermes-agent');

  if (process.env.AGENTROUTER_API_KEY) {
    seed('agentrouter', process.env.AGENTROUTER_API_KEY, process.env.AGENTROUTER_API_URL,
      process.env.AGENTROUTER_MODEL);
  }
  return n;
}

export const providerCatalog = () => Providers.publicAll();

const usable = (p) => Boolean(p && p.enabled && p.base_url && (!p.needs_key || p.api_key));

/**
 * Pick the provider + model actually used for an agent, with sane fallbacks.
 * `override` comes from the conversation ({provider, model}) and wins over the
 * agent's own setting when it points at a usable provider.
 */
export function resolveForAgent(agent = {}, override = null) {
  const wantedId = override && override.provider ? override.provider : agent.provider;
  const wantedModel = override && override.provider ? override.model : agent.model;

  let provider = Providers.get(wantedId);
  let fellBack = null;
  if (!usable(provider)) {
    const alt = Providers.all().find(usable);
    if (alt) { fellBack = provider ? provider.id : wantedId; provider = alt; }
  }
  if (!provider) return { provider: null, model: '', fellBack: wantedId || null };

  const model = wantedModel && provider.models.includes(wantedModel)
    ? wantedModel
    : (provider.default_model || provider.models[0] || '');
  return { provider, model, fellBack };
}

const slugOf = (s) => String(s || '').toLowerCase().trim();

/**
 * Traduit un échec réseau en phrase actionnable.
 *
 * `fetch` échoue toujours avec le même « fetch failed » ; la cause réelle est
 * dans `err.cause.code`. Sans ce démêlage, un nom d'hôte qui ne résout pas et
 * un service qui refuse la connexion produisaient le même message inutile — et
 * l'utilisateur n'avait aucun moyen de savoir qu'il lui manquait un conteneur.
 */
export function describeNetworkError(err, baseUrl) {
  const code = err?.cause?.code || err?.code || '';
  let host = '';
  try { host = new URL(baseUrl).host; } catch { host = String(baseUrl || ''); }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    const internal = !host.includes('.');
    return `Le nom « ${host} » ne résout pas.`
      + (internal
        ? ' C\'est un nom de conteneur Docker : soit le conteneur n\'existe pas, soit il n\'est '
          + 'pas sur le même réseau qu\'AgentHub. Vérifie avec `docker ps` qu\'il tourne, et que '
          + 'le bloc `networks:` de docker-compose.yml les relie.'
        : ' Vérifie l\'orthographe du domaine, ou la résolution DNS du serveur.');
  }
  if (code === 'ECONNREFUSED') {
    return `Rien n'écoute sur ${host}. Le service est peut-être arrêté, ou sur un autre port.`;
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return `${host} a coupé la connexion en cours de route.`;
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return `Le certificat TLS de ${host} n'est pas valide (${code}).`;
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `${host} n'a pas répondu à temps.`;
  }
  return `Injoignable : ${err?.message || 'erreur réseau'}${code ? ` (${code})` : ''}`;
}

// Providers are configured either with or without the /v1 suffix.
function endpoint(baseUrl, path) {
  const base = String(baseUrl).replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? `${base}/${path}` : `${base}/v1/${path}`;
}

/** One GET {base}/v1/models, optionally authenticated. */
async function fetchModels(baseUrl, apiKey, extraHeaders) {
  const headers = { Accept: 'application/json', ...(extraHeaders || {}) };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), PROBE_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(endpoint(baseUrl, 'models'), { headers, signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      error: ctrl.signal.aborted
        ? `Pas de réponse en ${Math.round(PROBE_TIMEOUT_MS / 1000)} s.`
        : describeNetworkError(err, baseUrl),
    };
  }
  clearTimeout(timer);

  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, status: resp.status, unauthorized: true, error: 'La clé API est refusée par le service.' };
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 160); } catch {}
    return { ok: false, status: resp.status, error: `HTTP ${resp.status}. ${detail}` };
  }

  let payload;
  try { payload = await resp.json(); } catch { return { ok: false, error: 'Réponse illisible (JSON attendu).' }; }

  const list = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models : [];
  const models = list
    .map((m) => (typeof m === 'string' ? m : m?.id || m?.name))
    .filter((m) => typeof m === 'string' && m)
    .sort((a, b) => a.localeCompare(b));

  return { ok: true, status: resp.status, models };
}

/**
 * Check a service is reachable and list the models it offers.
 *
 * Careful: several services (OpenRouter among them) serve /v1/models WITHOUT
 * authentication. A successful listing therefore proves nothing about the key,
 * so we refuse to test a key-requiring service with no key, and we probe a
 * second time anonymously to find out whether the key was actually needed.
 */
export async function probeProvider(cfg) {
  const baseUrl = String(cfg.base_url || '').trim();
  if (!baseUrl) return { ok: false, error: 'Aucune URL de base.' };
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: "L'URL doit commencer par http:// ou https://." };

  const apiKey = String(cfg.api_key || '').trim();
  const needsKey = cfg.needs_key !== false && cfg.needs_key !== 0;

  if (needsKey && !apiKey) {
    return {
      ok: false,
      missingKey: true,
      error: "Aucune clé API renseignée. Ce service en demande une — et comme certains publient "
           + "leur catalogue de modèles sans authentification, une liste obtenue sans clé ne prouverait rien.",
    };
  }

  const extra = cfg.headers || {};
  const authed = await fetchModels(baseUrl, apiKey, extra);
  if (!authed.ok) {
    // « La clé API est refusée » ne dit pas quoi faire. La cause la plus
    // fréquente est une clé collée dans le mauvais formulaire : les clés ne
    // sont pas interchangeables d'un service à l'autre, et rien ne le rappelle
    // au moment où l'on colle.
    if (authed.unauthorized) {
      const named = Boolean(cfg.label);
      const who = cfg.label || 'Ce service';
      const hermes = cfg.session_header || slugOf(cfg.id) === 'hermes';
      return {
        ...authed,
        // Texte brut : il est échappé à l'affichage, du markdown y ressortirait
        // tel quel avec ses étoiles et ses accents graves.
        error: hermes
          ? `${who} refuse cette clé. Hermes attend sa propre clé — la valeur de `
            + `API_SERVER_KEY dans sa configuration — et non celle d'un autre service `
            + `comme AgentRouter ou OpenRouter. Tu peux aussi passer cette étape : `
            + `AgentHub fonctionne sans Hermes.`
          : `${who} refuse cette clé. Vérifie qu'elle vient bien ${named ? `de ${who}` : 'de ce service-là'} : `
            + `une clé d'un autre service ne fonctionnera pas ici.`,
      };
    }
    return authed;
  }

  // Was the key actually what got us in? Repeat the call anonymously.
  let keyVerified = null;
  if (apiKey) {
    const anon = await fetchModels(baseUrl, '', extra);
    keyVerified = !anon.ok;
  }

  return {
    ok: true,
    status: authed.status,
    models: authed.models,
    keyVerified,
    // Surfaced in the UI so a green tick never overstates what was proven.
    keyNote: keyVerified === false
      ? "Ce service liste ses modèles sans authentification : la validité de ta clé n'est donc pas confirmée par ce test. Elle le sera au premier message envoyé."
      : null,
  };
}

// How many times a call is retried, and how long we wait between attempts.
// Only failures that happened before a single token was emitted are retried —
// replaying a half-written answer would duplicate text in the channel.
const MAX_ATTEMPTS = Number(process.env.LLM_MAX_ATTEMPTS || 3);
const RETRY_BASE_MS = Number(process.env.LLM_RETRY_BASE_MS || 800);

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * Stream a chat completion, retrying transient upstream failures.
 *
 * @returns {Promise<{text:string, reasoning:string, toolCalls:Array,
 *                    error:string|null, aborted?:boolean, usage:object,
 *                    provider:string, model:string, attempts:number}>}
 */
export async function streamChat(opts) {
  const {
    agent = {}, override = null, effort = '', sessionKey, messages,
    tools = null, toolChoice = null,
    onDelta = () => {}, onReasoning = () => {}, onRetry = () => {}, signal,
  } = opts;

  const { provider, model } = resolveForAgent(agent, override);
  if (!provider) {
    return {
      text: '', reasoning: '', toolCalls: [], error: "Aucun fournisseur de modèles n'est configuré. Ouvre Réglages → Fournisseurs.",
      usage: null, provider: null, model: '', attempts: 0,
    };
  }

  // Les en-tetes libres du fournisseur d'abord : Authorization est pose ensuite
  // et ne peut donc pas etre ecrase depuis ce champ.
  const headers = { ...(provider.headers || {}), 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;
  if (provider.session_header && sessionKey) headers[provider.session_header] = sessionKey;

  const payload = { model, stream: true, messages };
  // Only sent when explicitly chosen: providers that do not know the field can
  // reject the whole request, so we never add it behind the user's back.
  if (effort) payload.reasoning_effort = effort;
  if (tools && tools.length) {
    payload.tools = tools;
    payload.tool_choice = toolChoice || 'auto';
  }
  const body = JSON.stringify(payload);

  let last = null;
  for (let attempt = 1; attempt <= Math.max(1, MAX_ATTEMPTS); attempt++) {
    last = await attemptStream({
      provider, model, headers, body, onDelta, onReasoning, signal,
      messages, hasTools: Boolean(tools && tools.length),
    });
    last.attempts = attempt;

    if (last.aborted || !last.error || !last.retryable) break;
    // Anything already shown to the user makes a replay worse than the error.
    if (last.text || last.reasoning) break;
    if (attempt >= MAX_ATTEMPTS) break;
    if (signal?.aborted) { last.aborted = true; break; }

    const wait = RETRY_BASE_MS * 2 ** (attempt - 1);
    onRetry({ attempt, of: MAX_ATTEMPTS, wait, error: last.error });
    console.warn(`${provider.label}: tentative ${attempt}/${MAX_ATTEMPTS} échouée (${last.error}) — nouvel essai dans ${wait} ms.`);
    await sleep(wait, signal);
    if (signal?.aborted) { last.aborted = true; break; }
  }
  return last;
}

async function attemptStream({ provider, model, headers, body, onDelta, onReasoning, signal, messages, hasTools }) {
  const ctrl = new AbortController();
  const abortByCaller = () => ctrl.abort('caller');
  // Shape shared by every exit below, so a caller never has to guess whether a
  // field is present on the failure path.
  const out = (extra) => ({
    text: '', reasoning: '', toolCalls: [], error: null, aborted: false,
    retryable: false, usage: null, provider: provider.id, model, ...extra,
  });

  if (signal) {
    if (signal.aborted) return out({ aborted: true });
    signal.addEventListener('abort', abortByCaller, { once: true });
  }

  let timedOut = false;
  let timer = null;
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; ctrl.abort('timeout'); }, ms);
  };
  const cleanup = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abortByCaller);
  };

  let resp;
  arm(CONNECT_TIMEOUT_MS);
  try {
    resp = await fetch(endpoint(provider.base_url, 'chat/completions'), {
      method: 'POST', headers, body, signal: ctrl.signal,
    });
  } catch (err) {
    cleanup();
    if (signal?.aborted) return out({ aborted: true });
    // A connection that never opened is the textbook case worth retrying.
    if (timedOut) {
      return out({ error: `${provider.label} n'a pas répondu en ${Math.round(CONNECT_TIMEOUT_MS / 1000)} s pour « ${model} ». Ce service met parfois un modèle en file d'attente : essaie un autre modèle.`, retryable: true });
    }
    return out({ error: `${provider.label} — ${describeNetworkError(err, provider.base_url)}`, retryable: true });
  }

  if (!resp.ok) {
    cleanup();
    let detail = '';
    try { detail = await resp.text(); } catch {}
    // 429 and 5xx are the provider being busy or broken, not us being wrong.
    // 401/402/404 would fail identically however many times we ask.
    const retryable = resp.status === 429 || resp.status === 408 || resp.status >= 500;
    return out({ error: describeHttpError(provider, resp.status, detail), retryable });
  }
  if (!resp.body) { cleanup(); return out({ error: `Réponse de ${provider.label} sans corps.`, retryable: true }); }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let error = null;
  let reportedUsage = null;
  // Tool calls arrive spread across deltas: an index, then a name, then the
  // arguments in fragments. They are reassembled by index.
  const toolAcc = new Map();

  const processLine = (line) => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    // `[DONE]` ends the stream; `null` is AgentRouter's non-standard filler.
    if (!payload || payload === '[DONE]' || payload === 'null') return;
    let obj;
    try { obj = JSON.parse(payload); } catch { return; }
    if (!obj || typeof obj !== 'object') return;

    if (obj.error && obj.error.message) error = summariseUpstream(obj.error.message);
    if (obj.hermes && obj.hermes.failed && obj.hermes.error && !error) {
      error = summariseUpstream(obj.hermes.error);
    }
    if (obj.usage && (obj.usage.prompt_tokens || obj.usage.completion_tokens)) {
      reportedUsage = {
        tokensIn: obj.usage.prompt_tokens || 0,
        tokensOut: obj.usage.completion_tokens || 0,
        estimated: false,
      };
    }

    const choice = (obj.choices && obj.choices[0]) || null;
    if (!choice) return;
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      onDelta(delta.content);
    }
    // Providers disagree on the field name for chain-of-thought; accept both.
    const think = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (think) {
      reasoning += think;
      onReasoning(think);
    }
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? toolAcc.size;
      const cur = toolAcc.get(idx) || { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments;
      toolAcc.set(idx, cur);
    }
    if (choice.finish_reason === 'error' && !error) {
      error = 'Le modèle a renvoyé une erreur (finish_reason=error).';
    }
  };

  try {
    arm(IDLE_TIMEOUT_MS);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(IDLE_TIMEOUT_MS);
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        processLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    }
    if (buffer) processLine(buffer);
  } catch (err) {
    cleanup();
    if (signal?.aborted) return out({ text, reasoning, aborted: true });
    if (timedOut) {
      return out({ text, reasoning, retryable: true,
        error: `Flux interrompu: aucune donnée pendant ${Math.round(IDLE_TIMEOUT_MS / 1000)} s.` });
    }
    return out({ text, reasoning, error: `Flux interrompu: ${err.message}`, retryable: true });
  }

  cleanup();

  const toolCalls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t)
    .filter((t) => t.name);

  // A model that answers absolutely nothing usually means the upstream dropped
  // the stream — worth one more attempt, unless it was busy calling tools.
  const empty = !text.trim() && !reasoning.trim() && !toolCalls.length && !error;

  return out({
    text, reasoning, toolCalls,
    error: empty ? `${provider.label} a renvoyé une réponse vide.` : error,
    retryable: empty,
    usage: reportedUsage || estimateUsage(messages, text, reasoning, toolCalls),
  });
}

// ---- génération d'images ---------------------------------------------------

const IMAGE_TIMEOUT_MS = Number(process.env.LLM_IMAGE_TIMEOUT_MS || 180000);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** Le service et le modèle choisis pour les images, s'ils sont utilisables. */
export function imageProvider() {
  const id = Settings.get('image_provider', '');
  const model = Settings.get('image_model', '');
  if (!id || !model) return { provider: null, model: '', reason: 'non configuré' };
  const provider = Providers.get(id);
  if (!provider) return { provider: null, model: '', reason: `le service « ${id} » n'existe plus` };
  if (!usable(provider)) return { provider: null, model: '', reason: `le service ${provider.label} n'est pas utilisable (clé ou URL manquante)` };
  return { provider, model, reason: '' };
}

/**
 * Génère une image.
 *
 * Deux protocoles coexistent dans la nature et aucun ne couvre tout le monde :
 *
 * - `/v1/images/generations`, la voie OpenAI historique ;
 * - une complétion de chat avec `modalities: ["image","text"]`, par laquelle
 *   passent les modèles d'images d'OpenRouter (Gemini Image, GPT Image…), qui
 *   renvoient l'image en data-URL dans `message.images`.
 *
 * Par défaut on essaie le premier, et on bascule sur le second quand le service
 * répond 404 — c'est exactement ce que fait OpenRouter, qui expose bien
 * l'endpoint mais n'y connaît aucun modèle. L'utilisateur n'a donc pas à savoir
 * lequel des deux son fournisseur parle.
 *
 * @returns {Promise<{ok:boolean, buffer?:Buffer, mime?:string, error?:string, usage?:object}>}
 */
// Les échecs qui valent une nouvelle tentative. Le texte est examiné en plus du
// code HTTP : les passerelles relaient souvent le message du modèle avec un 200,
// et « Our servers are currently overloaded » arrivait ainsi jusqu'à l'écran sans
// qu'aucune reprise ne soit tentée.
const IMAGE_TRANSIENT =
  /satur|overload|capacity|unavailable|try again|rate.?limit|temporair|temporarily|injoignable|\b(429|500|502|503|504)\b/i;

const imageRetryable = (r) => Boolean(r) && !r.ok && !r.aborted
  && (r.retryable === true || IMAGE_TRANSIENT.test(String(r.error || '')));

/** Un essai complet : endpoint dédié, puis complétion de chat en repli. */
async function attemptImage({ provider, model, prompt, size, signal, mode }) {
  if (mode !== 'chat') {
    const r = await imageViaEndpoint({ provider, model, prompt, size, signal });
    if (r.ok || !r.tryChat || mode === 'images') return r;
    console.log(`${provider.label} : pas de /images/generations pour « ${model} », essai par complétion de chat.`);
  }
  return imageViaChat({ provider, model, prompt, size, signal });
}

export async function generateImage({ prompt, size = '1024x1024', signal } = {}) {
  const { provider, model, reason } = imageProvider();
  if (!provider) {
    return { ok: false, error: `Aucun service d'images configuré (${reason}). Réglages → Images.` };
  }
  const mode = Settings.get('image_mode', 'auto');

  let last;
  for (let attempt = 1; attempt <= Math.max(1, MAX_ATTEMPTS); attempt++) {
    last = await attemptImage({ provider, model, prompt, size, signal, mode });
    if (last.ok || signal?.aborted) return last;

    if (!imageRetryable(last) || attempt >= MAX_ATTEMPTS) break;

    const wait = RETRY_BASE_MS * 2 ** (attempt - 1);
    console.warn(`${provider.label} image : tentative ${attempt}/${MAX_ATTEMPTS} échouée `
      + `(${last.error}) — nouvel essai dans ${wait} ms.`);
    await new Promise((r) => setTimeout(r, wait));
    if (signal?.aborted) return { ok: false, error: 'Génération interrompue.', aborted: true };
  }

  // Sans cette ligne, l'échec n'existait que dans la conversation : rien dans les
  // journaux, donc rien à diagnostiquer après coup.
  if (!last?.ok) console.error(`${provider.label} image « ${model} » : échec définitif — ${last?.error}`);
  return last;
}

async function imageViaEndpoint({ provider, model, prompt, size, signal }) {
  const headers = { ...(provider.headers || {}), 'Content-Type': 'application/json', Accept: 'application/json' };
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), IMAGE_TIMEOUT_MS);
  const onAbort = () => ctrl.abort('caller');
  signal?.addEventListener('abort', onAbort, { once: true });

  let resp;
  try {
    resp = await fetch(endpoint(provider.base_url, 'images/generations'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, prompt, n: 1, size, response_format: 'b64_json' }),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) return { ok: false, error: 'Génération interrompue.' };
    return { ok: false, error: `${provider.label} injoignable : ${err.message}` };
  }
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);

  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 300); } catch { /* corps illisible */ }
    // 404 = ni cet endpoint, ni ce modèle ici. C'est le signal qu'il faut
    // tenter l'autre protocole plutôt que d'abandonner.
    if (resp.status === 404) {
      return {
        ok: false, tryChat: true,
        error: `${provider.label} n'expose pas de génération d'images, ou ne connaît pas le modèle « ${model} ».`,
      };
    }
    return { ok: false, error: describeHttpError(provider, resp.status, detail) };
  }

  let payload;
  try { payload = await resp.json(); } catch { return { ok: false, error: 'Réponse illisible (JSON attendu).' }; }
  const first = payload?.data?.[0];
  if (!first) {
    const msg = payload?.error?.message ? summariseUpstream(payload.error.message) : 'réponse sans image';
    return { ok: false, error: `${provider.label} n'a renvoyé aucune image (${msg}).` };
  }

  if (first.b64_json) {
    const buffer = Buffer.from(first.b64_json, 'base64');
    if (!buffer.length) return { ok: false, error: 'Image vide.' };
    if (buffer.length > MAX_IMAGE_BYTES) return { ok: false, error: 'Image trop lourde.' };
    return { ok: true, buffer, mime: sniffImage(buffer) || 'image/png', revised: first.revised_prompt || '',
      provider: provider.id, model, usage: usageOf(payload) };
  }

  if (first.url) {
    try {
      const img = await fetch(first.url, { signal });
      if (!img.ok) return { ok: false, error: `Image inaccessible (HTTP ${img.status}).` };
      const buffer = Buffer.from(await img.arrayBuffer());
      if (buffer.length > MAX_IMAGE_BYTES) return { ok: false, error: 'Image trop lourde.' };
      const mime = sniffImage(buffer);
      if (!mime) return { ok: false, error: "Le fichier renvoyé n'est pas une image reconnue." };
      return { ok: true, buffer, mime, revised: first.revised_prompt || '',
        provider: provider.id, model, usage: usageOf(payload) };
    } catch (err) {
      return { ok: false, error: `Téléchargement de l'image impossible : ${err.message}` };
    }
  }

  return { ok: false, error: "Réponse sans image exploitable." };
}

/**
 * Génération par complétion de chat, avec `modalities`.
 *
 * L'image revient en data-URL dans `message.images`. Les proportions ne sont
 * pas un paramètre de l'API ici : elles sont demandées dans le texte, ce qui
 * est une consigne et non une garantie — autant le savoir.
 */
async function imageViaChat({ provider, model, prompt, size, signal }) {
  const headers = { ...(provider.headers || {}), 'Content-Type': 'application/json', Accept: 'application/json' };
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;

  const ratio = { '1536x1024': 'au format paysage (16:9)', '1024x1536': 'au format portrait (9:16)' }[size]
    || 'au format carré (1:1)';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), IMAGE_TIMEOUT_MS);
  const onAbort = () => ctrl.abort('caller');
  signal?.addEventListener('abort', onAbort, { once: true });

  let resp;
  try {
    resp = await fetch(endpoint(provider.base_url, 'chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        modalities: ['image', 'text'],
        messages: [{ role: 'user', content: `${prompt}\n\nProduis une image ${ratio}.` }],
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) return { ok: false, error: 'Génération interrompue.' };
    return { ok: false, error: `${provider.label} injoignable : ${err.message}` };
  }
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);

  let payload;
  try { payload = await resp.json(); } catch { return { ok: false, error: 'Réponse illisible (JSON attendu).' }; }
  if (!resp.ok) {
    const msg = payload?.error?.message ? summariseUpstream(payload.error.message) : `HTTP ${resp.status}`;
    return { ok: false, error: `${provider.label} : ${msg}` };
  }

  const message = payload?.choices?.[0]?.message || {};
  const images = Array.isArray(message.images) ? message.images : [];
  const url = images[0]?.image_url?.url || images[0]?.url || '';
  if (!url.startsWith('data:image/')) {
    const said = String(message.content || '').trim().slice(0, 200);
    return {
      ok: false,
      error: said
        ? `« ${model} » a répondu du texte au lieu d'une image : « ${said} ». Ce modèle ne génère peut-être pas d'images.`
        : `« ${model} » n'a renvoyé aucune image. Vérifie que ce modèle en produit.`,
    };
  }

  const buffer = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  if (!buffer.length) return { ok: false, error: 'Image vide.' };
  if (buffer.length > MAX_IMAGE_BYTES) return { ok: false, error: 'Image trop lourde.' };
  const mime = sniffImage(buffer);
  if (!mime) return { ok: false, error: "Le contenu renvoyé n'est pas une image reconnue." };

  const u = payload.usage || {};
  return {
    ok: true, buffer, mime, revised: '',
    provider: provider.id, model,
    usage: { tokensIn: u.prompt_tokens || 0, tokensOut: u.completion_tokens || 0, estimated: !u.total_tokens },
  };
}

/** Consommation déclarée par le service, quand il en déclare une. */
const usageOf = (payload) => {
  const u = payload?.usage || {};
  if (!u.prompt_tokens && !u.completion_tokens) return null;
  return { tokensIn: u.prompt_tokens || 0, tokensOut: u.completion_tokens || 0, estimated: false };
};

// ---- transcription ---------------------------------------------------------
// La dictée passait par l'API vocale du navigateur, qui envoie l'audio au
// service du navigateur : hors de notre portée, indisponible sur plusieurs
// Chromium, et incapable de viser une entrée audio précise. Transcrire nous-même
// supprime les trois problèmes d'un coup — et l'audio ne quitte le serveur que
// vers le service que l'utilisateur a déjà choisi.

const TRANSCRIBE_TIMEOUT_MS = Number(process.env.LLM_TRANSCRIBE_TIMEOUT_MS || 120000);
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

/**
 * Les modèles de transcription ne sont pas toujours dans `/models` : `whisper-1`
 * répond chez OpenRouter sans y figurer. Chercher dans le catalogue ne suffit
 * donc pas — on essaie cette liste, du plus répandu au plus spécifique.
 */
const TRANSCRIBE_CANDIDATES = [
  'whisper-1',
  'whisper-large-v3',
  'whisper-large-v3-turbo',
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe',
  'mistralai/voxtral-small-24b-2507',
];

/**
 * Services dont la transcription est gratuite dans un quota d'usage courant.
 *
 * Groq donne Whisper large v3 sans facturer l'audio ; c'est la seule voie
 * réellement gratuite parmi les services compatibles OpenAI, et une clé s'y crée
 * en une minute. La détection les essaie donc en premier : à qualité comparable,
 * personne ne veut payer la dictée à la seconde.
 */
const FREE_TRANSCRIBERS = new Set(['groq']);

/** Le service et le modèle choisis pour la transcription, s'ils sont utilisables. */
export function transcribeProvider() {
  const id = Settings.get('transcribe_provider', '');
  const model = Settings.get('transcribe_model', '');
  if (!id || !model) return { provider: null, model: '', reason: 'non configuré' };
  const provider = Providers.get(id);
  if (!provider) return { provider: null, model: '', reason: `le service « ${id} » n'existe plus` };
  if (!usable(provider)) {
    return { provider: null, model: '', reason: `le service ${provider.label} n'est pas utilisable (clé ou URL manquante)` };
  }
  return { provider, model, reason: '', free: FREE_TRANSCRIBERS.has(provider.id) };
}

/** Les services gratuits que l'utilisateur n'a pas encore branchés. */
export function freeTranscribeOptions() {
  const have = new Set(Providers.all().filter(usable).map((p) => p.id));
  return PRESETS
    .filter((p) => FREE_TRANSCRIBERS.has(p.id) && !have.has(p.id))
    .map((p) => ({ id: p.id, label: p.label }));
}

async function postAudio({ provider, model, buffer, mime, filename, language, signal }) {
  // Les en-têtes maison passent avant Authorization : un en-tête libre ne doit
  // jamais pouvoir remplacer la clé.
  const headers = { ...(provider.headers || {}), Accept: 'application/json' };
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  form.append('model', model);
  if (language) form.append('language', language);
  form.append('response_format', 'json');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), TRANSCRIBE_TIMEOUT_MS);
  const onAbort = () => ctrl.abort('caller');
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const resp = await fetch(endpoint(provider.base_url, 'audio/transcriptions'), {
      method: 'POST', headers, body: form, signal: ctrl.signal,
    });
    const raw = await resp.text();
    return { status: resp.status, raw };
  } catch (err) {
    if (signal?.aborted) return { status: 0, raw: '', aborted: true };
    return { status: 0, raw: '', netError: describeNetworkError(err, provider.base_url) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Transcrit un enregistrement.
 *
 * @returns {Promise<{ok:boolean, text?:string, error?:string, needsSetup?:boolean, cost?:number}>}
 */
export async function transcribeAudio({ buffer, mime = 'audio/webm', filename = 'dictee.webm',
  language = 'fr', signal } = {}) {
  if (!buffer?.length) return { ok: false, error: 'Enregistrement vide.' };
  if (buffer.length > MAX_AUDIO_BYTES) {
    return { ok: false, error: `Enregistrement trop lourd (${Math.round(buffer.length / 1048576)} Mo, 24 Mo maximum).` };
  }

  const { provider, model, reason } = transcribeProvider();
  if (!provider) {
    return {
      ok: false, needsSetup: true,
      error: `Aucun service de transcription configuré (${reason}). Réglages → Microphone.`,
    };
  }

  const r = await postAudio({ provider, model, buffer, mime, filename, language, signal });
  if (r.aborted) return { ok: false, error: 'Transcription interrompue.' };
  if (r.netError) return { ok: false, error: r.netError };
  if (r.status !== 200) {
    if (r.status === 404) {
      return {
        ok: false, needsSetup: true,
        error: `${provider.label} ne transcrit pas, ou ne connaît pas « ${model} ». `
             + 'Relance la détection dans Réglages → Microphone.',
      };
    }
    return { ok: false, error: describeHttpError(provider, r.status, r.raw) };
  }

  let payload;
  try { payload = JSON.parse(r.raw); } catch { return { ok: false, error: 'Réponse illisible (JSON attendu).' }; }
  const text = String(payload?.text ?? '').trim();
  if (!text) return { ok: false, error: 'Rien n\'a été reconnu dans cet enregistrement.' };

  // Ces services facturent à la seconde d'audio, pas au token : le coût vient
  // donc de leur réponse, quand elle le donne, plutôt que d'une grille de prix.
  const cost = Number(payload?.usage?.cost);
  return {
    ok: true, text, provider: provider.id, model,
    cost: Number.isFinite(cost) && cost >= 0 ? cost : undefined,
    seconds: Number(payload?.usage?.seconds) || undefined,
  };
}

/** Un bip mono de 0,3 s : de quoi voir si un service accepte l'endpoint. */
function toneWav(seconds = 0.3, rate = 16000) {
  const n = Math.floor(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / rate)), 44 + i * 2);
  }
  return b;
}

/**
 * Cherche qui sait transcrire, et retient le premier qui répond.
 *
 * Demander à l'utilisateur de savoir que `whisper-1` marche chez OpenRouter mais
 * n'apparaît pas dans son catalogue serait absurde. On essaie donc pour lui, et
 * on enregistre le couple qui a fonctionné.
 */
export async function findTranscriber({ onProgress = () => {} } = {}) {
  const tried = [];
  const audio = toneWav();

  // Le gratuit d'abord : l'ordre de la liste des fournisseurs sert à autre chose,
  // et laisser gagner un service payant alors qu'un gratuit répond serait un
  // choix pris à la place de l'utilisateur, sans le lui dire.
  const ordered = Providers.all()
    .filter(usable)
    .sort((a, b) => (FREE_TRANSCRIBERS.has(b.id) ? 1 : 0) - (FREE_TRANSCRIBERS.has(a.id) ? 1 : 0));

  for (const provider of ordered) {
    for (const model of TRANSCRIBE_CANDIDATES) {
      onProgress(`${provider.label} · ${model}`);
      const r = await postAudio({
        provider, model, buffer: audio, mime: 'audio/wav', filename: 'test.wav', language: 'fr',
      });
      if (r.status === 200) {
        Settings.set('transcribe_provider', provider.id);
        Settings.set('transcribe_model', model);
        const free = FREE_TRANSCRIBERS.has(provider.id);
        console.log(`Transcription : ${provider.label} répond avec « ${model} »${free ? ' (gratuit)' : ''}.`);
        return { ok: true, provider: provider.id, label: provider.label, model, free, tried };
      }
      tried.push({ provider: provider.id, model, status: r.status, note: r.netError || '' });
      // Un 401 ou un 402 ne se corrige pas en changeant de modèle : la clé ou le
      // crédit est en cause, on passe au service suivant.
      if (r.status === 401 || r.status === 403 || r.status === 402) break;
    }
  }
  return { ok: false, tried, error: 'Aucun de tes services ne propose de transcription audio.' };
}

/**
 * Type déduit des octets, jamais de ce que le service annonce.
 *
 * C'est ce qui garantit qu'un fichier stocké en `image/png` en est vraiment
 * un : le serveur le rend ensuite en ligne dans la conversation, et se fier à
 * une étiquette fournie par un tiers serait exactement la mauvaise idée.
 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return null;
}

/**
 * Fallback accounting when the provider reports nothing.
 * ~4 characters per token is the usual rough figure for mixed French and code —
 * good enough to see trends, and always flagged as an estimate in the UI.
 *
 * Reasoning and tool arguments are billed as output by every provider that
 * charges for them, so leaving them out would under-report what a thinking
 * model actually costs.
 */
const CHARS_PER_TOKEN = 4;
function estimateUsage(messages, text, reasoning = '', toolCalls = []) {
  const promptChars = (messages || []).reduce((n, m) => n + String(m.content || '').length, 0);
  const toolChars = (toolCalls || []).reduce((n, t) => n + t.name.length + t.args.length, 0);
  const outChars = String(text || '').length + String(reasoning || '').length + toolChars;
  return {
    tokensIn: Math.round(promptChars / CHARS_PER_TOKEN),
    tokensOut: Math.round(outChars / CHARS_PER_TOKEN),
    estimated: true,
  };
}

function describeHttpError(provider, status, detail) {
  const tail = detail ? ` ${detail.slice(0, 200)}` : '';
  if (status === 401 || status === 403) {
    return `${provider.label} a rejeté la requête (${status}). Vérifie la clé API dans Réglages → Fournisseurs.`;
  }
  if (status === 402) return `Crédit épuisé chez ${provider.label} (402).${tail}`;
  if (status === 404) return `${provider.label} ne connaît pas le modèle « ${provider.default_model} » (404).${tail}`;
  if (status === 429) return `${provider.label} est saturé (429). Réessaie dans un instant.`;
  if (status === 400 && /reasoning_effort|unknown|unsupported|unrecognized/i.test(detail || '')) {
    return `${provider.label} n'accepte pas le réglage d'effort de raisonnement. Repasse-le sur « automatique » dans le sélecteur de modèle.`;
  }
  if (status >= 500) return `${provider.label} a renvoyé une erreur ${status}.${tail}`;
  return `${provider.label} HTTP ${status}.${tail}`;
}

function summariseUpstream(raw) {
  const s = String(raw || '');
  if (/无效的令牌|invalid token/i.test(s)) {
    return 'Le fournisseur LLM a rejeté le token comme invalide. Renouvelle la clé API.';
  }
  // Vu en production : « 当前分组 default 下对于模型 kimi-k3 无可用渠道 ».
  // La passerelle n'a plus de fournisseur pour ce modèle — souvent parce qu'il
  // a été retiré du catalogue depuis que la liste a été mise en cache.
  if (/无可用渠道|no available channel/i.test(s)) {
    const m = s.match(/模型\s*([\w.\-/]+)/) || s.match(/model\s+([\w.\-/]+)/i);
    return `Ce modèle${m ? ` (${m[1]})` : ''} n'est plus desservi par la passerelle. `
         + 'Il a probablement été retiré de son catalogue : rouvre Réglages → Fournisseurs, '
         + 'teste le service pour rafraîchir la liste, et choisis un modèle encore proposé.';
  }
  if (/余额|insufficient|quota|balance/i.test(s)) {
    return 'Crédit/quota épuisé côté fournisseur LLM.';
  }
  if (/sensitive_words_detected|sensitive words/i.test(s)) {
    return 'AgentRouter a bloqué ce contenu via sa modération (sensitive words). Reformule la demande.';
  }
  if (/Panic detected|new-api|new_api/i.test(s)) {
    return 'Le fournisseur LLM a renvoyé une erreur 500 — token invalide ou modèle indisponible en amont.';
  }
  return s.slice(0, 300);
}
