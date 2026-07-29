// Outils exécutables par les agents (function calling).
//
// Jusqu'ici les agents produisaient du texte et rien d'autre : ils ne pouvaient
// ni consulter une page, ni retrouver ce qu'ils avaient écrit la semaine
// dernière. Ce module leur donne un petit jeu d'actions, décrites au modèle au
// format OpenAI et exécutées ici, côté serveur.
//
// Toute la surface d'attaque du projet tient dans ce fichier : c'est le seul
// endroit où le contenu d'une conversation décide d'une action. D'où les
// garde-fous ci-dessous — en particulier `assertPublicUrl`, sans quoi il
// suffirait de demander à un agent de lire http://agentrouter-proxy:8318 pour
// se faire recracher les clés API des services voisins.

import dns from 'node:dns/promises';
import net from 'node:net';
import { Notes, NoteProposals, Search, Attachments } from './db.js';

const FETCH_TIMEOUT_MS = Number(process.env.TOOL_FETCH_TIMEOUT_MS || 15000);
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 12000;
const MAX_REDIRECTS = 3;

// ---- garde-fou réseau ------------------------------------------------------

/**
 * Toute adresse qui ne sort pas sur l'Internet public.
 * Le conteneur partage un réseau Docker avec le gateway Hermes et le proxy
 * AgentRouter : sans ce filtre, « lis cette URL » devient une lecture de la
 * configuration des voisins, clés comprises.
 */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;                                  // 10/8
    if (p[0] === 127) return true;                                 // boucle locale
    if (p[0] === 0) return true;                                   // 0/8
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;     // 172.16/12
    if (p[0] === 192 && p[1] === 168) return true;                 // 192.168/16
    if (p[0] === 169 && p[1] === 254) return true;                 // link-local, métadonnées cloud
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;    // CGNAT
    if (p[0] >= 224) return true;                                  // multicast et au-delà
    return false;
  }
  if (net.isIPv6(ip)) {
    const a = ip.toLowerCase();
    if (a === '::1' || a === '::') return true;
    if (a.startsWith('fe80')) return true;                         // link-local
    if (a.startsWith('fc') || a.startsWith('fd')) return true;     // unique local
    // ::ffff:10.0.0.1 — une adresse v4 privée déguisée en v6.
    const m = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateAddress(m[1]);
    return false;
  }
  return true;   // illisible ⇒ refusé
}

/**
 * Valide une URL et renvoie l'adresse à joindre.
 *
 * La résolution DNS est faite ici, et toutes les adresses renvoyées sont
 * vérifiées : un nom qui pointe sur 127.0.0.1 est refusé même s'il ressemble à
 * un domaine public.
 */
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error("URL illisible."); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Seuls http:// et https:// sont autorisés.');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');

  // Une adresse IP littérale se vérifie sans passer par le résolveur.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('Adresse réseau interne refusée.');
    return u;
  }
  if (/^localhost$/i.test(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error('Adresse réseau interne refusée.');
  }

  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { throw new Error(`Nom de domaine introuvable : ${host}`); }
  if (!addrs.length) throw new Error(`Nom de domaine introuvable : ${host}`);
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error('Ce domaine pointe vers le réseau interne — refusé.');
  }
  return u;
}

/**
 * fetch qui refuse de suivre une redirection vers le réseau interne.
 * `redirect: 'manual'` est indispensable : sinon un service public peut
 * rediriger vers 169.254.169.254 et le contrôle initial ne sert plus à rien.
 */
async function safeFetch(url, opts = {}) {
  let current = await assertPublicUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('timeout'), FETCH_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(current, {
        ...opts,
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'AgentHub/1.0 (+https://github.com/yhanottv/agenthub)',
          'Accept-Language': 'fr,en;q=0.8',
          ...(opts.headers || {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
      current = await assertPublicUrl(new URL(resp.headers.get('location'), current).href);
      continue;
    }
    return { resp, url: current };
  }
  throw new Error('Trop de redirections.');
}

/** Lit un corps de réponse en s'arrêtant net au-delà de la taille permise. */
async function readCapped(resp) {
  const reader = resp.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PAGE_BYTES) { try { await reader.cancel(); } catch {} break; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---- HTML vers texte -------------------------------------------------------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', ccedil: 'ç',
  ugrave: 'ù', ocirc: 'ô', icirc: 'î', euro: '€', hellip: '…',
  laquo: '«', raquo: '»', rsquo: '’', ndash: '–', mdash: '—',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * Extraction de texte volontairement simple : on retire ce qui n'est pas du
 * contenu, on garde les sauts de blocs, on décode les entités.
 */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(nav|footer|aside|header)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '• ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

function pageTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

// ---- calcul ----------------------------------------------------------------

/**
 * Évaluateur arithmétique par descente récursive.
 *
 * Écrit à la main plutôt que confié à `eval` ou à `new Function` : l'expression
 * vient d'un modèle, donc indirectement de n'importe qui sachant écrire dans un
 * salon. Ici la pire entrée possible ne produit qu'une erreur de syntaxe.
 */
export function evalMath(expr) {
  const src = String(expr || '').replace(/\s+/g, '').replace(/,(\d)/g, '.$1');
  if (!src) throw new Error('Expression vide.');
  if (!/^[0-9+\-*/%^().e]+$/i.test(src)) throw new Error('Caractère non autorisé dans l\'expression.');
  let i = 0;

  const peek = () => src[i];
  const eat = (c) => (src[i] === c ? (i++, true) : false);

  function number() {
    const start = i;
    while (i < src.length && /[0-9.]/.test(src[i])) i++;
    // Notation scientifique : 1.5e-3
    if (/[eE]/.test(src[i] || '') && /[0-9]/.test(src[start] || '')) {
      i++;
      if (src[i] === '+' || src[i] === '-') i++;
      while (i < src.length && /[0-9]/.test(src[i])) i++;
    }
    const raw = src.slice(start, i);
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`Nombre invalide : « ${raw || peek() || 'fin'} »`);
    return v;
  }

  function atom() {
    if (eat('(')) {
      const v = sum();
      if (!eat(')')) throw new Error('Parenthèse fermante manquante.');
      return v;
    }
    if (eat('-')) return -atom();
    if (eat('+')) return atom();
    return number();
  }

  function power() {
    const base = atom();
    if (eat('^')) return base ** power();     // associatif à droite
    return base;
  }

  function product() {
    let v = power();
    for (;;) {
      if (eat('*')) v *= power();
      else if (eat('/')) {
        const d = power();
        if (d === 0) throw new Error('Division par zéro.');
        v /= d;
      } else if (eat('%')) {
        const d = power();
        if (d === 0) throw new Error('Modulo par zéro.');
        v %= d;
      } else return v;
    }
  }

  function sum() {
    let v = product();
    for (;;) {
      if (eat('+')) v += product();
      else if (eat('-')) v -= product();
      else return v;
    }
  }

  const result = sum();
  if (i < src.length) throw new Error(`Expression mal formée à « ${src.slice(i, i + 8)} »`);
  if (!Number.isFinite(result)) throw new Error('Résultat non fini.');
  return result;
}

// ---- recherche web ---------------------------------------------------------

/**
 * DuckDuckGo en version HTML, sans clé.
 *
 * C'est un compromis assumé : pas d'inscription ni de quota, mais du balisage
 * qui peut changer sans prévenir. Quand la mise en page bouge, la fonction
 * renvoie une liste vide plutôt que du charabia, et l'agent le voit.
 */
async function duckduckgo(query, limit) {
  const { resp } = await safeFetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=fr-fr`,
    { method: 'GET' });
  if (!resp.ok) throw new Error(`Moteur de recherche indisponible (HTTP ${resp.status}).`);
  const html = await readCapped(resp);

  const results = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && results.length < limit) {
    let href = decodeEntities(m[1]);
    // DuckDuckGo enrobe les liens dans /l/?uddg=<url encodée>.
    const wrapped = href.match(/[?&]uddg=([^&]+)/);
    if (wrapped) href = decodeURIComponent(wrapped[1]);
    if (!/^https?:\/\//i.test(href)) continue;
    const title = htmlToText(m[2]).slice(0, 200);
    if (title) results.push({ title, url: href, snippet: '' });
  }

  // Les extraits vivent dans un bloc séparé ; on les apparie par ordre.
  const snippets = [];
  const sre = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = sre.exec(html)) !== null) snippets.push(htmlToText(m[1]).slice(0, 300));
  results.forEach((r, idx) => { r.snippet = snippets[idx] || ''; });

  return results;
}

// ---- définitions exposées au modèle ---------------------------------------

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'recherche_web',
      description: "Cherche sur le web et renvoie des résultats avec titre, URL et extrait. "
        + "À utiliser dès qu'une information est postérieure à ton entraînement, ou que tu n'en es pas certain.",
      parameters: {
        type: 'object',
        properties: {
          requete: { type: 'string', description: 'Les mots-clés à chercher.' },
          nombre: { type: 'integer', description: 'Nombre de résultats (1 à 10, défaut 5).' },
        },
        required: ['requete'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lire_url',
      description: "Récupère une page web et renvoie son texte. Sert à lire vraiment une source "
        + "trouvée par recherche_web, au lieu de te fier à son extrait.",
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL complète, http(s) uniquement.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'chercher_memoire',
      description: "Cherche dans la mémoire de l'organisation (second cerveau) et dans l'historique "
        + "des conversations. À utiliser avant d'affirmer que tu ne sais pas quelque chose.",
      parameters: {
        type: 'object',
        properties: { requete: { type: 'string', description: 'Les mots à retrouver.' } },
        required: ['requete'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'proposer_note',
      description: "Propose d'ajouter une information durable à la mémoire de l'organisation. "
        + "Réservé à ce qui restera vrai demain — une décision, une préférence, un fait sur "
        + "l'activité. Jamais pour un détail de la conversation en cours. La note passe par "
        + "une validation humaine avant d'entrer en mémoire.",
      parameters: {
        type: 'object',
        properties: {
          titre: { type: 'string', description: 'Titre court et parlant.' },
          contenu: { type: 'string', description: "L'information, formulée pour être comprise seule." },
          tags: { type: 'array', items: { type: 'string' }, description: 'Quelques mots-clés.' },
        },
        required: ['titre', 'contenu'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculer',
      description: 'Évalue une expression arithmétique exactement. Utilise-le plutôt que de calculer de tête.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'Ex. « (1520 * 1.2) / 3 ».' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lire_piece_jointe',
      description: "Lit le contenu texte d'un fichier déposé dans ce salon.",
      parameters: {
        type: 'object',
        properties: { nom: { type: 'string', description: 'Nom du fichier tel qu\'affiché.' } },
        required: ['nom'],
      },
    },
  },
];

export const TOOL_LABELS = {
  recherche_web: 'recherche sur le web',
  lire_url: 'lit une page',
  chercher_memoire: 'fouille la mémoire',
  proposer_note: 'propose une note',
  calculer: 'calcule',
  lire_piece_jointe: 'lit un fichier',
};

/** Court résumé de l'appel, affiché dans le fil de la conversation. */
export function describeCall(name, args) {
  const label = TOOL_LABELS[name] || name;
  if (name === 'recherche_web') return `${label} : « ${String(args.requete || '').slice(0, 80)} »`;
  if (name === 'lire_url') return `${label} : ${String(args.url || '').slice(0, 100)}`;
  if (name === 'chercher_memoire') return `${label} : « ${String(args.requete || '').slice(0, 80)} »`;
  if (name === 'proposer_note') return `${label} : « ${String(args.titre || '').slice(0, 80)} »`;
  if (name === 'calculer') return `${label} : ${String(args.expression || '').slice(0, 80)}`;
  if (name === 'lire_piece_jointe') return `${label} : ${String(args.nom || '').slice(0, 80)}`;
  return label;
}

// ---- exécution -------------------------------------------------------------

/**
 * Exécute un appel d'outil et renvoie le texte rendu au modèle.
 * Une erreur n'est jamais levée : elle est renvoyée comme résultat, pour que
 * l'agent puisse s'adapter au lieu de voir son tour s'interrompre.
 */
export async function runTool(name, rawArgs, ctx = {}) {
  let args = {};
  if (rawArgs) {
    try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs; }
    catch { return { ok: false, text: `Arguments illisibles (JSON attendu) : ${String(rawArgs).slice(0, 200)}` }; }
  }
  if (!args || typeof args !== 'object') args = {};

  try {
    switch (name) {
      case 'recherche_web': {
        const q = String(args.requete || '').trim();
        if (!q) return { ok: false, text: 'Requête vide.' };
        const n = Math.min(10, Math.max(1, Number(args.nombre) || 5));
        const results = await duckduckgo(q, n);
        if (!results.length) {
          return { ok: true, text: `Aucun résultat exploitable pour « ${q} ». La mise en page du moteur a pu changer — reformule, ou lis directement une URL que tu connais.` };
        }
        return {
          ok: true,
          text: results.map((r, idx) =>
            `${idx + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n\n'),
          meta: { count: results.length },
        };
      }

      case 'lire_url': {
        const { resp, url } = await safeFetch(String(args.url || ''), { method: 'GET' });
        if (!resp.ok) return { ok: false, text: `La page a répondu HTTP ${resp.status}.` };
        const type = resp.headers.get('content-type') || '';
        const raw = await readCapped(resp);
        if (!/html|text|json|xml/i.test(type)) {
          return { ok: false, text: `Ce document n'est pas du texte (${type || 'type inconnu'}).` };
        }
        const body = /html/i.test(type) ? htmlToText(raw) : raw;
        const title = /html/i.test(type) ? pageTitle(raw) : '';
        const clipped = body.length > MAX_TEXT_CHARS;
        return {
          ok: true,
          text: `${title ? `# ${title}\n` : ''}Source : ${url.href}\n\n`
            + body.slice(0, MAX_TEXT_CHARS)
            + (clipped ? `\n\n[…] Page tronquée à ${MAX_TEXT_CHARS} caractères.` : ''),
        };
      }

      case 'chercher_memoire': {
        const q = String(args.requete || '').trim();
        if (q.length < 2) return { ok: false, text: 'Requête trop courte.' };
        const r = Search.run(q, 12);
        const parts = [];
        if (r.notes.length) {
          parts.push('Notes du second cerveau :');
          for (const n of r.notes) {
            const note = Notes.get(n.id);
            parts.push(`### ${n.title}\n${(note?.content || n.excerpt || '').slice(0, 900)}`);
          }
        }
        if (r.messages.length) {
          parts.push('\nExtraits de conversations :');
          for (const m of r.messages.slice(0, 8)) {
            const when = new Date(m.created_at).toLocaleDateString('fr-FR');
            parts.push(`- [${when}] ${m.author_name} : ${String(m.excerpt || '').replace(/\s+/g, ' ').slice(0, 240)}`);
          }
        }
        if (!parts.length) return { ok: true, text: `Rien en mémoire au sujet de « ${q} ».` };
        return { ok: true, text: parts.join('\n') };
      }

      case 'proposer_note': {
        const titre = String(args.titre || '').trim();
        const contenu = String(args.contenu || '').trim();
        if (!titre || !contenu) return { ok: false, text: 'Titre et contenu sont requis.' };
        if (NoteProposals.isDuplicate(titre)) {
          return { ok: true, text: `« ${titre} » est déjà en mémoire ou déjà proposé — rien à ajouter.` };
        }
        const r = NoteProposals.submit({
          title: titre, content: contenu, tags: args.tags,
          agent_id: ctx.agent?.id, agent_name: ctx.agent?.name, channel_id: ctx.channel?.id,
        });
        ctx.onProposal?.(r);
        return {
          ok: true,
          text: r.auto
            ? `Note « ${titre} » ajoutée à la mémoire de l'organisation. Tous les agents la verront désormais.`
            : `Note « ${titre} » proposée. Elle entrera en mémoire après validation.`,
        };
      }

      case 'calculer': {
        const expr = String(args.expression || '');
        const v = evalMath(expr);
        return { ok: true, text: `${expr} = ${v}` };
      }

      case 'lire_piece_jointe': {
        if (!ctx.channel?.id) return { ok: false, text: 'Aucun salon en contexte.' };
        const wanted = String(args.nom || '').trim().toLowerCase();
        const files = Attachments.list(ctx.channel.id);
        if (!files.length) return { ok: false, text: 'Aucun fichier dans ce salon.' };
        const hit = files.find((f) => f.name.toLowerCase() === wanted)
          || files.find((f) => f.name.toLowerCase().includes(wanted));
        if (!hit) {
          return { ok: false, text: `Fichier introuvable. Disponibles : ${files.map((f) => f.name).join(', ')}` };
        }
        const full = Attachments.get(hit.id);
        if (!full?.text) return { ok: false, text: `« ${hit.name} » n'est pas un fichier texte lisible.` };
        const clipped = full.text.length > MAX_TEXT_CHARS;
        return {
          ok: true,
          text: `# ${hit.name}\n\n${full.text.slice(0, MAX_TEXT_CHARS)}`
            + (clipped ? `\n\n[…] Tronqué à ${MAX_TEXT_CHARS} caractères.` : ''),
        };
      }

      default:
        return { ok: false, text: `Outil inconnu : ${name}` };
    }
  } catch (err) {
    return { ok: false, text: `Échec de l'outil ${name} : ${err.message}` };
  }
}
