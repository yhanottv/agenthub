// Catalogue des skills Hermes.
//
// Hermes Agent range ses skills en fichiers SKILL.md : ceux qui sont actifs
// dans `~/.hermes/skills/`, et le catalogue officiel Nous Research — 104 skills
// répartis en 19 catégories — dans `optional-skills/` du dépôt hermes-agent.
//
// AgentHub ne peut pas entrer dans le conteneur voisin, mais les deux dossiers
// vivent dans des volumes Docker. Il suffit de les monter en LECTURE SEULE
// (voir docker-compose.yml) pour lire le catalogue exact de cette installation,
// sans appel réseau, sans clé, et sans rien deviner.
//
// Aucun skill n'est installé depuis ici : l'installation touche au système de
// fichiers d'Hermes et passe par ses propres garde-fous (analyse de sécurité,
// provenance, épinglage). AgentHub montre ce qui existe et renvoie la commande.

import fs from 'node:fs';
import path from 'node:path';

// Points de montage par défaut, alignés sur docker-compose.yml : le dossier
// personnel d'Hermes porte les skills actifs, son dépôt porte le catalogue.
const INSTALLED_DIR = process.env.HERMES_SKILLS_DIR || '/hermes-home/skills';
const CATALOGUE_DIR = process.env.HERMES_OPTIONAL_SKILLS_DIR || '/hermes-src/optional-skills';

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_DEPTH = 4;

/**
 * Front-matter YAML d'un SKILL.md, lu au strict nécessaire.
 *
 * Écrit à la main plutôt qu'avec une bibliothèque : le projet tient à trois
 * dépendances, et on n'a besoin que de chaînes, de listes en ligne et de deux
 * niveaux d'imbrication. Tout ce qui sort de là est ignoré, jamais deviné.
 */
export function parseFrontMatter(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};

  const out = {};
  const stack = [{ indent: -1, obj: out }];

  for (const raw of m[1].split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    const kv = line.match(/^([\w.-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;

    const value = rawValue.trim();
    if (!value) {
      // Clé sans valeur : soit un objet imbriqué, soit une liste à tirets.
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
      continue;
    }
    parent[key] = parseScalar(value);
  }
  return out;
}

function parseScalar(v) {
  const s = v.replace(/\s+#.*$/, '').trim();
  if (/^\[.*\]$/.test(s)) {
    return s.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  return unquote(s);
}
const unquote = (s) => s.replace(/^['"]|['"]$/g, '').trim();

/** Le paragraphe qui suit le titre, quand la description est absente. */
function firstParagraph(text) {
  const body = String(text || '').replace(/^---[\s\S]*?\n---\r?\n?/, '');
  const lines = body.split('\n');
  const out = [];
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('#') || (!t && !out.length)) continue;
    if (!t) break;
    out.push(t);
    if (out.join(' ').length > 200) break;
  }
  return out.join(' ').slice(0, 240);
}

function readSkill(file, { installed, rootDir }) {
  let text;
  try {
    if (fs.statSync(file).size > MAX_SKILL_BYTES) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch { return null; }

  const fm = parseFrontMatter(text);
  const dir = path.dirname(file);
  const rel = path.relative(rootDir, dir).split(path.sep);
  // optional-skills/<catégorie>/<skill>/SKILL.md — la catégorie du chemin fait
  // foi quand le front-matter n'en déclare pas.
  const fromPath = rel.length > 1 ? rel[0] : '';
  const hermes = (fm.metadata && fm.metadata.hermes) || {};

  const name = String(fm.name || path.basename(dir));
  const tags = Array.isArray(hermes.tags) ? hermes.tags.map(String).slice(0, 12) : [];

  return {
    id: `${installed ? 'i' : 'o'}_${name}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
    name,
    title: name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    description: String(fm.description || firstParagraph(text) || ''),
    version: String(fm.version || ''),
    author: String(fm.author || ''),
    license: String(fm.license || ''),
    category: String(hermes.category || fromPath || 'divers'),
    tags,
    installed,
    // Ce que l'utilisateur tapera dans Hermes pour l'activer.
    install: installed ? '' : `hermes skills install ${name}`,
  };
}

function walk(dir, depth, acc) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1, acc);
    else if (e.isFile() && e.name.toUpperCase() === 'SKILL.MD') acc.push(full);
  }
}

function scan(rootDir, installed) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const files = [];
  walk(rootDir, 0, files);
  const out = [];
  for (const f of files) {
    const s = readSkill(f, { installed, rootDir });
    if (s) out.push(s);
  }
  return out;
}

// Relire 104 fichiers à chaque affichage serait absurde : le catalogue ne
// change qu'au moment où l'on installe un skill dans Hermes.
let cache = null;
let cachedAt = 0;
const TTL_MS = 5 * 60 * 1000;

export function skillsCatalogue(force = false) {
  if (cache && !force && Date.now() - cachedAt < TTL_MS) return cache;

  const installed = scan(INSTALLED_DIR, true);
  const installedNames = new Set(installed.map((s) => s.name.toLowerCase()));
  // Un skill déjà actif ne doit pas réapparaître comme « à installer ».
  const available = scan(CATALOGUE_DIR, false)
    .filter((s) => !installedNames.has(s.name.toLowerCase()));

  const all = [...installed, ...available];
  const byCategory = new Map();
  for (const s of all) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, { category: s.category, total: 0, installed: 0 });
    const c = byCategory.get(s.category);
    c.total++;
    if (s.installed) c.installed++;
  }

  cache = {
    skills: all.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name)),
    categories: [...byCategory.values()].sort((a, b) => b.total - a.total || a.category.localeCompare(b.category)),
    counts: { installed: installed.length, available: available.length, total: all.length },
    // Dit franchement d'où viennent ces chiffres, plutôt que d'afficher zéro
    // comme si Hermes n'avait aucun skill.
    sources: {
      installed: { dir: INSTALLED_DIR, present: fs.existsSync(INSTALLED_DIR) },
      catalogue: { dir: CATALOGUE_DIR, present: fs.existsSync(CATALOGUE_DIR) },
    },
    mounted: fs.existsSync(INSTALLED_DIR) || fs.existsSync(CATALOGUE_DIR),
  };
  cachedAt = Date.now();
  return cache;
}

export const invalidateSkills = () => { cache = null; };
