// Serveurs MCP d'Hermes : le catalogue approuvé, et ceux qui sont branchés.
//
// MCP est la façon dont Hermes se connecte à un logiciel qui tourne ailleurs —
// Blender, Unreal, n8n, Linear. Chaque entrée du catalogue est un manifeste YAML
// dans `optional-mcps/`, et les serveurs réellement configurés vivent sous la
// clé `mcp_servers` de `config.yaml`, dans le dossier personnel d'Hermes.
//
// Deux chemins de lecture, dans cet ordre :
//
// - un montage en lecture seule, s'il existe : instantané, aucun appel ;
// - sinon le socket Docker, déjà utilisé pour détecter Hermes. Le catalogue vit
//   dans l'image d'Hermes, à un chemin qu'aucun montage d'AgentHub ne couvre par
//   défaut — passer par là évite de demander une modification de compose pour
//   voir quelque chose.
//
// Rien n'est installé ni modifié depuis ici. Brancher un serveur MCP donne à un
// agent le droit d'agir sur une machine ; cela passe par Hermes, qui applique ses
// propres contrôles. AgentHub montre ce qui existe et rend la commande exacte.

import fs from 'node:fs';
import path from 'node:path';
import { dockerStatus, discover, execIn } from './hermes.js';

const CATALOGUE_MOUNT = process.env.HERMES_MCP_DIR || '/hermes-src/optional-mcps';
const HOME_MOUNT = process.env.HERMES_HOME_DIR || '/hermes-home';

// Chemins dans le conteneur d'Hermes, quand on lit par le socket.
const CATALOGUE_IN_HERMES = '/opt/hermes/optional-mcps';
const MAX_MANIFEST_BYTES = 64 * 1024;
const CACHE_MS = 5 * 60 * 1000;

let cache = null;

/* ============================================================================
   Un lecteur YAML du strict nécessaire.

   Les manifestes n'emploient que quatre formes : des scalaires, des listes
   `- valeur`, des maps imbriquées à l'indentation, et un bloc `|` pour les
   textes longs. Une bibliothèque complète coûterait une quatrième dépendance
   au projet pour lire quatre formes ; tout ce qui sort de là est ignoré plutôt
   que devine.
   ========================================================================== */

const unquote = (v) => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
};

export function parseYaml(text) {
  const lines = String(text || '').split(/\r?\n/);
  const root = {};
  // Pile de contextes ouverts, du moins indenté au plus indenté.
  const stack = [{ indent: -1, node: root }];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    i++;
    if (!raw.trim() || /^\s*#/.test(raw)) continue;

    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;

    // Élément de liste.
    if (line.startsWith('- ') || line === '-') {
      if (!Array.isArray(parent)) continue;
      parent.push(unquote(line.slice(1)));
      continue;
    }

    const m = line.match(/^([\w.-]+)\s*:\s*(.*)$/);
    if (!m || Array.isArray(parent)) continue;
    const [, key, rest] = m;

    // Bloc littéral : tout ce qui est plus indenté lui appartient.
    if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
      const body = [];
      let base = null;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() && (l.length - l.trimStart().length) <= indent) break;
        if (base === null && l.trim()) base = l.length - l.trimStart().length;
        body.push(l.slice(base ?? 0));
        i++;
      }
      parent[key] = body.join('\n').replace(/\n+$/, '');
      continue;
    }

    if (rest === '') {
      // Une map ou une liste s'ouvre : on décide en regardant la ligne suivante.
      let next = i;
      while (next < lines.length && (!lines[next].trim() || /^\s*#/.test(lines[next]))) next++;
      const nextLine = lines[next] || '';
      const nextIndent = nextLine.length - nextLine.trimStart().length;
      const opensList = nextIndent > indent && nextLine.trim().startsWith('- ');
      parent[key] = opensList ? [] : {};
      stack.push({ indent, node: parent[key] });
      continue;
    }

    parent[key] = unquote(rest);
  }
  return root;
}

/* ============================================================================
   Lecture
   ========================================================================== */

/** Le conteneur Hermes courant, ou null. */
async function hermesContainer() {
  const docker = await dockerStatus();
  if (!docker.available) return null;
  try {
    const r = await discover();
    const hit = (r.found || []).find((f) => f.running) || (r.found || [])[0];
    return hit ? hit.name : null;
  } catch { return null; }
}

/** Découpe la sortie d'un `cat` groupé en fichiers nommés. */
function splitFiles(output) {
  const out = new Map();
  for (const block of String(output).split('===AH-FILE:')) {
    const nl = block.indexOf('\n');
    if (nl === -1) continue;
    const name = block.slice(0, nl).trim();
    if (name) out.set(name, block.slice(nl + 1));
  }
  return out;
}

/** Le catalogue, lu par montage si possible, par Docker sinon. */
async function readCatalogue() {
  // 1. Montage.
  if (fs.existsSync(CATALOGUE_MOUNT)) {
    const files = new Map();
    for (const entry of fs.readdirSync(CATALOGUE_MOUNT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const f = path.join(CATALOGUE_MOUNT, entry.name, 'manifest.yaml');
      try {
        if (fs.statSync(f).size <= MAX_MANIFEST_BYTES) files.set(entry.name, fs.readFileSync(f, 'utf8'));
      } catch { /* entrée illisible : ignorée */ }
    }
    if (files.size) return { via: 'montage', files };
  }

  // 2. Socket Docker : un seul exec pour tous les manifestes.
  const container = await hermesContainer();
  if (!container) return { via: 'indisponible', files: new Map() };
  try {
    const { output } = await execIn(container, ['sh', '-lc',
      `for f in ${CATALOGUE_IN_HERMES}/*/manifest.yaml; do `
      + '[ -f "$f" ] || continue; echo "===AH-FILE:$(basename $(dirname $f))"; cat "$f"; done']);
    const files = splitFiles(output);
    return { via: files.size ? 'docker' : 'indisponible', files, container };
  } catch (err) {
    console.warn('Catalogue MCP illisible par Docker :', err.message);
    return { via: 'indisponible', files: new Map() };
  }
}

/** Les serveurs branchés, sous la clé `mcp_servers` de config.yaml. */
async function readConfigured() {
  const local = path.join(HOME_MOUNT, 'config.yaml');
  let text = null;

  if (fs.existsSync(local)) {
    try { text = fs.readFileSync(local, 'utf8'); } catch { /* illisible */ }
  } else if (fs.existsSync(HOME_MOUNT)) {
    // Le dossier d'Hermes est là et le fichier n'y est pas : ce n'est pas un
    // échec de lecture, c'est qu'aucun serveur MCP n'est configuré. Les deux
    // situations se ressemblent et ne se disent pas de la même façon.
    return { via: 'aucune-config', servers: {} };
  }
  if (text === null) {
    const container = await hermesContainer();
    if (!container) return { via: 'indisponible', servers: {} };
    try {
      const { output } = await execIn(container, ['sh', '-lc',
        'cat "${HERMES_HOME:-/opt/data}/config.yaml" 2>/dev/null || true']);
      text = output;
    } catch { return { via: 'indisponible', servers: {} }; }
  }

  if (!String(text).trim()) return { via: 'aucune-config', servers: {} };
  const doc = parseYaml(text);
  const servers = doc.mcp_servers && typeof doc.mcp_servers === 'object' ? doc.mcp_servers : {};
  return { via: 'lu', servers };
}

/* ============================================================================
   Catalogue présenté
   ========================================================================== */

const asList = (v) => (Array.isArray(v) ? v : (v == null ? [] : [String(v)]));

function shape(name, manifest, configured) {
  const t = manifest.transport && typeof manifest.transport === 'object' ? manifest.transport : {};
  const auth = manifest.auth && typeof manifest.auth === 'object' ? manifest.auth : {};
  const tools = manifest.tools && typeof manifest.tools === 'object' ? manifest.tools : {};
  const live = configured[name];

  const install = manifest.install && typeof manifest.install === 'object' ? manifest.install : {};
  // Deux transports coexistent : un programme lancé en local (stdio) ou une
  // adresse à joindre (http). Le second n'a pas de commande, le premier n'a pas
  // d'URL — afficher « rien » dans l'un des deux cas serait un trou.
  const endpoint = t.type === 'http'
    ? (t.url || '')
    : [t.command, ...asList(t.args)].filter(Boolean).join(' ');

  return {
    name: manifest.name || name,
    id: name,
    description: manifest.description || '',
    source: manifest.source || '',
    transport: t.type || '',
    endpoint,
    // `auth.env` est une liste de maps (`- name: N8N_API_KEY`) : on n'en garde
    // que les noms, jamais une valeur.
    authEnv: asList(auth.env)
      .map((e) => String(typeof e === 'object' ? (e.name || '') : e).replace(/^name:\s*/, '').trim())
      .filter(Boolean),
    install: install.type || '',
    version: t.version || '',
    // Les valeurs d'environnement d'un manifeste ne sont pas des secrets (le
    // catalogue est public), mais on ne renvoie que les noms : une clé n'a
    // jamais de raison de traverser vers le navigateur.
    envKeys: t.env && typeof t.env === 'object' ? Object.keys(t.env) : [],
    auth: auth.type || 'none',
    defaultTools: asList(tools.default_enabled),
    notes: manifest.post_install || '',
    // État réel : branché, et actif ou mis en pause.
    installed: Boolean(live),
    enabled: live ? String(live.enabled ?? 'true') !== 'false' : false,
  };
}

/**
 * Le catalogue MCP de cette installation.
 *
 * @returns {Promise<{via:string, configVia:string, servers:Array, counts:object}>}
 */
export async function mcpCatalogue() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;

  const [cat, conf] = await Promise.all([readCatalogue(), readConfigured()]);
  const servers = [];
  for (const [name, text] of cat.files) {
    let manifest;
    try { manifest = parseYaml(text); } catch { continue; }
    servers.push(shape(name, manifest, conf.servers));
  }
  // Un serveur branché à la main n'est pas forcément au catalogue : il doit
  // apparaître quand même, sinon la page mentirait sur ce qui tourne. Il passe
  // par la même mise en forme — deux chemins produisant deux formes, c'est un
  // consommateur qui trouve un champ absent et s'arrête.
  for (const [name, live] of Object.entries(conf.servers)) {
    if (servers.some((s) => s.id === name)) continue;
    servers.push({
      ...shape(name, {
        description: 'Ajouté à la main, hors catalogue.',
        transport: (live && typeof live.transport === 'object') ? live.transport : {},
        auth: { type: 'inconnu' },
      }, conf.servers),
      offCatalogue: true,
    });
  }
  servers.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name, 'fr'));

  // La commande à copier se lance dans le conteneur d'Hermes. Lue par montage,
  // on n'a pas eu besoin de son nom — mais la commande le réclame, sinon elle
  // n'est utilisable que pour qui se trouve déjà à l'intérieur.
  const container = cat.container || await hermesContainer();

  const data = {
    via: cat.via,
    configVia: conf.via,
    container: container || null,
    servers,
    counts: {
      total: servers.length,
      installed: servers.filter((s) => s.installed).length,
      enabled: servers.filter((s) => s.enabled).length,
    },
  };
  cache = { at: Date.now(), data };
  return data;
}

export function invalidateMcp() { cache = null; }
