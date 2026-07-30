/**
 * Higgsfield : images et vidéos, par le CLI installé dans le conteneur Hermes.
 *
 * AgentHub n'a pas ce CLI et n'en veut pas : il vit chez Hermes, avec les
 * identifiants de l'utilisateur. On l'appelle donc par le socket Docker, comme
 * `mcp.js` lit déjà le catalogue MCP.
 *
 * SÉCURITÉ — la commande est toujours passée en TABLEAU d'arguments, jamais en
 * chaîne confiée à un shell. Le prompt vient d'un modèle, donc d'une
 * conversation : un `sh -c "… --prompt \"$p\""` laisserait n'importe quel texte
 * ouvrir un `; rm -rf /` dans le conteneur d'Hermes. Avec `Cmd: [...]`, Docker
 * exécute le binaire directement et le prompt n'est jamais interprété.
 *
 * Un job vidéo dure plusieurs minutes alors que `execIn` coupe à 60 s : on crée
 * donc le job, puis on interroge son état par appels courts, ce qui donne en
 * prime l'annulation en cours de route.
 */
import { dockerStatus, discover, execIn } from './hermes.js';

const CLI = 'higgsfield';

/** Modèles proposés aux agents. La liste complète vient du CLI, pas d'ici. */
export const DEFAULT_VIDEO = 'kling3_0_turbo';
export const DEFAULT_IMAGE = 'nano_banana_2';

const POLL_MS = 6000;
const MAX_WAIT_MS = 12 * 60 * 1000;

let containerCache = { name: null, at: 0 };

async function hermesContainer() {
  if (containerCache.name && Date.now() - containerCache.at < 60000) return containerCache.name;
  const docker = await dockerStatus();
  if (!docker.available) return null;
  try {
    const r = await discover();
    const hit = (r.found || []).find((f) => f.running);
    containerCache = { name: hit ? hit.name : null, at: Date.now() };
    return containerCache.name;
  } catch { return null; }
}

/** Lance le CLI. `args` est un tableau : rien n'est passé à un shell. */
async function run(args) {
  const container = await hermesContainer();
  if (!container) return { ok: false, text: "Hermes est injoignable : Higgsfield passe par son conteneur." };
  try {
    const { output } = await execIn(container, [CLI, ...args]);
    return { ok: true, text: String(output || '') };
  } catch (err) {
    return { ok: false, text: `Appel du CLI Higgsfield impossible : ${err.message}` };
  }
}

/**
 * Le CLI mêle parfois une ligne d'avertissement au JSON. On isole donc le
 * premier objet ou tableau complet plutôt que de parser la sortie entière.
 */
export function extractJson(text) {
  const s = String(text || '');
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = s.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === open) depth++;
      else if (s[i] === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

// La forme exacte du JSON de `generate create` n'est pas documentée et varie
// selon les modèles : on cherche donc les valeurs utiles par leur nature plutôt
// que par un chemin figé, ce qui évite de casser au premier renommage de champ.
const ID_KEYS = ['job_id', 'jobId', 'id', 'job', 'generation_id'];
const URL_RE = /^https?:\/\/[^\s"']+$/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Un identifiant plausible : ni URL, ni phrase. Le motif UUID d'abord, parce que
 * c'est ce que le CLI rend réellement ; le motif large ensuite, pour ne pas
 * dépendre d'un format qui changerait.
 */
const isId = (s) => typeof s === 'string' && !URL_RE.test(s) && !/\s/.test(s)
  && (UUID_RE.test(s) || /^[A-Za-z0-9][A-Za-z0-9_-]{11,79}$/.test(s));

export function findJobId(data) {
  const seen = new Set();
  const walk = (v) => {
    // `generate create` répond par un tableau nu d'identifiants — pas par un
    // objet. Ne chercher que dans les clés laissait passer ce cas, le seul que
    // le CLI produise vraiment.
    if (typeof v === 'string') return isId(v) ? v : null;
    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = walk(item);
        if (hit) return hit;
      }
      return null;
    }
    if (!v || typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    for (const k of ID_KEYS) {
      if (isId(v[k])) return v[k];
    }
    for (const child of Object.values(v)) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(data);
}

// Les champs qui portent le résultat, par ordre de préférence. `params` est
// exclu du balayage : sur une animation d'image il contient l'image d'ENTRÉE, et
// une recherche naïve d'URL republierait la source au lieu du rendu.
const RESULT_KEYS = ['result_url', 'min_result_url', 'output_url', 'video_url', 'image_url', 'url'];
const IGNORE_SUBTREE = new Set(['params', 'input', 'inputs', 'request']);

/** Les URL du résultat, dans l'ordre de rencontre. */
export function findMediaUrls(data) {
  const out = [];
  const seen = new Set();
  const push = (v) => { if (URL_RE.test(v) && !out.includes(v)) out.push(v); };

  // Premier passage : uniquement les champs de résultat déclarés.
  const declared = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    for (const k of RESULT_KEYS) if (typeof v[k] === 'string') push(v[k]);
    for (const [k, child] of Object.entries(v)) {
      if (!IGNORE_SUBTREE.has(k)) declared(child);
    }
  };
  declared(data);
  if (out.length) return out;

  // Rien de déclaré : on balaie, toujours sans les sous-arbres d'entrée.
  seen.clear();
  const walk = (v) => {
    if (typeof v === 'string') { push(v); return; }
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    for (const [k, child] of Object.entries(v)) {
      if (!IGNORE_SUBTREE.has(k)) walk(child);
    }
  };
  walk(data);
  return out;
}

// `in_progress` est le statut que le CLI rend réellement pendant le rendu.
const DONE = ['completed', 'complete', 'succeeded', 'success', 'done', 'finished'];
const FAILED = ['failed', 'error', 'cancelled', 'canceled', 'rejected', 'nsfw'];
const PENDING = ['in_progress', 'in-progress', 'queued', 'pending', 'processing', 'running', 'starting'];

/** `queued` | `running` | `done` | `failed` */
export function jobState(data) {
  const s = String(
    data?.status ?? data?.state ?? data?.job?.status ?? data?.job?.state ?? '',
  ).toLowerCase();
  if (DONE.includes(s)) return 'done';
  if (FAILED.includes(s)) return 'failed';
  if (PENDING.includes(s)) return s === 'queued' || s === 'pending' ? 'queued' : 'running';
  // Un statut inconnu accompagné d'un résultat vaut « terminé » : mieux vaut
  // livrer le média que d'attendre un mot qu'on ne connaît pas.
  if (findMediaUrls(data).length) return 'done';
  return s ? 'running' : 'queued';
}

/** Coût en crédits, sans rien engager. */
export async function cost(model, prompt) {
  const r = await run(['generate', 'cost', model, '--prompt', prompt, '--json']);
  if (!r.ok) return { ok: false, text: r.text };
  const data = extractJson(r.text);
  const credits = Number(data?.credits ?? data?.cost ?? NaN);
  if (!Number.isFinite(credits)) return { ok: false, text: `Coût illisible : ${r.text.slice(0, 200)}` };
  return { ok: true, credits };
}

/** État de l'intégration : CLI présent, compte connecté, workspace, crédits. */
export async function status() {
  const container = await hermesContainer();
  if (!container) return { available: false, reason: 'hermes-injoignable' };

  const v = await run(['version']);
  if (!v.ok || !/\d+\.\d+\.\d+/.test(v.text)) {
    return { available: false, reason: 'cli-absent', container };
  }
  const version = (v.text.match(/\d+\.\d+\.\d+/) || [''])[0];

  const ws = await run(['workspace', 'status']);
  const authenticated = ws.ok && !/not (signed|logged)|unauthenticated|no credentials/i.test(ws.text);
  const noWorkspace = /no workspace selected/i.test(ws.text);
  const credits = Number((ws.text.match(/([\d.]+)\s*credits?/i) || [])[1] ?? NaN);
  const workspace = (ws.text.match(/^\s*([^\n—]+?)\s+—/m) || [])[1]?.trim() || null;

  return {
    available: authenticated && !noWorkspace,
    reason: !authenticated ? 'non-connecte' : noWorkspace ? 'workspace-non-choisi' : null,
    container,
    version,
    workspace,
    credits: Number.isFinite(credits) ? credits : null,
  };
}

/** La liste des modèles, par type. */
export async function models() {
  const r = await run(['model', 'list']);
  if (!r.ok) return { ok: false, text: r.text };
  const byType = {};
  for (const line of r.text.split('\n').slice(1)) {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 3) continue;
    const [id, name, type] = [parts[0], parts[1], parts[parts.length - 1]];
    if (!/^[a-z0-9_]+$/.test(id)) continue;
    (byType[type] ||= []).push({ id, name });
  }
  return { ok: true, byType };
}

/** L'état d'un job. Exporté pour pouvoir reprendre une génération déjà payée. */
export async function getJob(jobId) {
  const r = await run(['generate', 'get', jobId, '--json']);
  if (!r.ok) return { ok: false, text: r.text };
  const job = extractJson(r.text);
  if (!job) return { ok: false, text: `Réponse illisible : ${r.text.slice(0, 200)}` };
  return { ok: true, job, state: jobState(job), urls: findMediaUrls(job) };
}

/** Attend un job existant. Séparé de `generate` pour être réutilisable. */
export async function waitJob(jobId, { signal, onTick = () => {} } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < MAX_WAIT_MS) {
    if (signal?.aborted) return { ok: false, text: 'Génération annulée.', jobId };
    const got = await getJob(jobId);
    if (got.ok) {
      if (got.state !== last) { last = got.state; onTick(got.state, Math.round((Date.now() - started) / 1000)); }
      if (got.state === 'done') {
        if (got.urls.length) return { ok: true, urls: got.urls, jobId };
        return { ok: false, text: 'Job terminé sans aucun média.', jobId };
      }
      if (got.state === 'failed') {
        const why = got.job?.error || got.job?.message || got.job?.detail || got.job?.status || 'raison non précisée';
        return { ok: false, text: `Génération échouée : ${String(why).slice(0, 300)}`, jobId };
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return { ok: false, text: `Toujours pas terminé après ${Math.round(MAX_WAIT_MS / 60000)} minutes.`, jobId };
}

/**
 * Crée le job puis attend son résultat. `onTick` sert à tenir l'interface au
 * courant : sans elle, une vidéo de quatre minutes ressemble à un blocage.
 */
export async function generate(model, prompt, { signal, onTick = () => {}, extra = [] } = {}) {
  const created = await run(['generate', 'create', model, '--prompt', prompt, '--json', ...extra]);
  if (!created.ok) return { ok: false, text: created.text };

  const data = extractJson(created.text);
  if (!data) return { ok: false, text: `Réponse illisible du CLI : ${created.text.slice(0, 300)}` };

  // Certains modèles rendent le média directement : inutile d'attendre.
  const direct = findMediaUrls(data);
  const jobId = findJobId(data);
  if (jobState(data) === 'done' && direct.length) return { ok: true, urls: direct, jobId };
  if (!jobId) return { ok: false, text: `Aucun identifiant de job dans la réponse : ${created.text.slice(0, 300)}` };

  return waitJob(jobId, { signal, onTick });
}
