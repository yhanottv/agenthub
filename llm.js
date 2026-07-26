// Streaming client for OpenAI-compatible chat endpoints.
//
// Providers are stored in the database (see db.js `Providers`) so they can be
// added and re-keyed from the UI at runtime. Environment variables are only
// used to seed the table on first boot.

import { Providers } from './db.js';

const IDLE_TIMEOUT_MS = Number(process.env.LLM_IDLE_TIMEOUT_MS || 120000);
const CONNECT_TIMEOUT_MS = Number(process.env.LLM_CONNECT_TIMEOUT_MS || 30000);
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
    hint: 'Modèles Claude via ton proxy local. Rapide, sans la couche Hermes.',
    needs_key: true, local: true,
  },
  {
    id: 'openrouter', label: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1',
    hint: 'Passerelle vers des centaines de modèles (Claude, GPT, Llama, Mistral…).',
    needs_key: true,
  },
  {
    id: 'openai', label: 'OpenAI', base_url: 'https://api.openai.com/v1',
    hint: 'Modèles GPT officiels.', needs_key: true,
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

/** Seed the provider table from env the first time the app boots. */
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
  seed('hermes', process.env.HERMES_API_KEY, process.env.HERMES_API_URL, process.env.HERMES_MODEL || 'hermes-agent');
  seed('agentrouter', process.env.AGENTROUTER_API_KEY, process.env.AGENTROUTER_API_URL, process.env.AGENTROUTER_MODEL);
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

// Providers are configured either with or without the /v1 suffix.
function endpoint(baseUrl, path) {
  const base = String(baseUrl).replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? `${base}/${path}` : `${base}/v1/${path}`;
}

/** One GET {base}/v1/models, optionally authenticated. */
async function fetchModels(baseUrl, apiKey) {
  const headers = { Accept: 'application/json' };
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
        : `Injoignable : ${err.message}`,
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

  const authed = await fetchModels(baseUrl, apiKey);
  if (!authed.ok) return authed;

  // Was the key actually what got us in? Repeat the call anonymously.
  let keyVerified = null;
  if (apiKey) {
    const anon = await fetchModels(baseUrl, '');
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

/**
 * Stream a chat completion.
 * @returns {Promise<{text:string, error:string|null, aborted?:boolean}>}
 */
export async function streamChat(opts) {
  const {
    agent = {}, override = null, effort = '', sessionKey, messages,
    onDelta = () => {}, onReasoning = () => {}, signal,
  } = opts;

  const { provider, model } = resolveForAgent(agent, override);
  if (!provider) {
    return { text: '', error: "Aucun fournisseur de modèles n'est configuré. Ouvre Réglages → Fournisseurs." };
  }

  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;
  if (provider.session_header && sessionKey) headers[provider.session_header] = sessionKey;

  const payload = { model, stream: true, messages };
  // Only sent when explicitly chosen: providers that do not know the field can
  // reject the whole request, so we never add it behind the user's back.
  if (effort) payload.reasoning_effort = effort;
  const body = JSON.stringify(payload);

  const ctrl = new AbortController();
  const abortByCaller = () => ctrl.abort('caller');
  if (signal) {
    if (signal.aborted) return { text: '', error: null, aborted: true };
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
    if (signal?.aborted) return { text: '', error: null, aborted: true };
    if (timedOut) return { text: '', error: `${provider.label} n'a pas répondu en ${Math.round(CONNECT_TIMEOUT_MS / 1000)} s.` };
    return { text: '', error: `${provider.label} injoignable: ${err.message}` };
  }

  if (!resp.ok) {
    cleanup();
    let detail = '';
    try { detail = await resp.text(); } catch {}
    return { text: '', error: describeHttpError(provider, resp.status, detail) };
  }
  if (!resp.body) { cleanup(); return { text: '', error: `Réponse de ${provider.label} sans corps.` }; }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let error = null;
  let reportedUsage = null;

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
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      onReasoning(delta.reasoning_content);
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
    if (signal?.aborted) return { text, error: null, aborted: true };
    if (timedOut) {
      return { text, error: `Flux interrompu: aucune donnée pendant ${Math.round(IDLE_TIMEOUT_MS / 1000)} s.` };
    }
    return { text, error: `Flux interrompu: ${err.message}` };
  }

  cleanup();
  return {
    text, error,
    usage: reportedUsage || estimateUsage(messages, text),
    provider: provider.id, model,
  };
}

/**
 * Fallback accounting when the provider reports nothing.
 * ~4 characters per token is the usual rough figure for mixed French and code —
 * good enough to see trends, and always flagged as an estimate in the UI.
 */
const CHARS_PER_TOKEN = 4;
function estimateUsage(messages, text) {
  const promptChars = (messages || []).reduce((n, m) => n + String(m.content || '').length, 0);
  return {
    tokensIn: Math.round(promptChars / CHARS_PER_TOKEN),
    tokensOut: Math.round(String(text || '').length / CHARS_PER_TOKEN),
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
