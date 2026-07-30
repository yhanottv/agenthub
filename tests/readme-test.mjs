/**
 * Le README promet-il des choses qui existent ?
 *
 * Un README qui a dérivé est pire qu'un README absent : il envoie chercher une
 * option retirée, annonce quatre suites de tests quand il y en a huit, ou cite un
 * fichier renommé. Celui qui installe le projet n'a aucun moyen de savoir laquelle
 * des deux sources mentir.
 *
 * Ce test confronte donc chaque affirmation vérifiable au code. Il ne juge pas la
 * prose : il vérifie les faits qu'elle avance.
 */
import fs from 'node:fs';
import path from 'node:path';

// Ce test lit le dépôt, pas l'image : le README et le compose n'ont aucune raison
// d'être embarqués dans un conteneur d'exécution. Le dépôt est donc monté à part.
const ROOT = process.env.REPO_DIR || '/app';
let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}${extra ? '\n    ' + extra : ''}`); fail++; }
};

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readme = read('README.md');
const compose = read('docker-compose.yml');   // seulement pour le port publié
const pkg = JSON.parse(read('package.json'));

/** Les lignes d'un tableau Markdown dont l'en-tête contient `heading`. */
function tableRows(md, heading) {
  const at = md.indexOf(heading);
  if (at === -1) return [];
  const rest = md.slice(at + heading.length);
  const end = rest.search(/\n\s*\n/);
  return (end === -1 ? rest : rest.slice(0, end))
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*-+/.test(l));
}

// ---- les fichiers cités existent ------------------------------------------
const fileRows = tableRows(readme, '| Fichier | Rôle |');
const files = fileRows.map((l) => l.match(/^\|\s*`([^`]+)`/)?.[1]).filter(Boolean);
ok('le tableau d\'architecture est trouvé', files.length >= 8, `${files.length} ligne(s)`);
const absents = files.filter((f) => !fs.existsSync(path.join(ROOT, f.replace(/\/$/, ''))));
ok('CHAQUE FICHIER CITÉ EXISTE', absents.length === 0, absents.join(', '));

// Et l'inverse : un module du projet passé sous silence.
const modules = fs.readdirSync(ROOT).filter((f) => /\.js$/.test(f));
const tus = modules.filter((m) => !files.includes(m));
ok('AUCUN MODULE N\'EST PASSÉ SOUS SILENCE', tus.length === 0, tus.join(', '));

// ---- le nombre de suites annoncé --------------------------------------------
const suites = [...pkg.scripts.test.matchAll(/\/test\/([a-z0-9-]+)-test\.mjs/g)].map((m) => m[1]);
const MOTS = { Quatre: 4, Cinq: 5, Six: 6, Sept: 7, Huit: 8, Neuf: 9, Dix: 10 };
const annonce = Object.entries(MOTS).find(([mot]) => readme.includes(`${mot} suites`));
ok('le README annonce un nombre de suites', Boolean(annonce));
ok('LE NOMBRE ANNONCÉ EST LE VRAI', annonce && annonce[1] === suites.length,
  `annoncé ${annonce?.[1]} · réel ${suites.length} (${suites.join(', ')})`);

// ---- chaque suite documentée existe, et l'inverse ---------------------------
const suiteRows = tableRows(readme, "| Suite | Ce qu'elle empêche de casser |");
const documentees = suiteRows.map((l) => l.match(/^\|\s*`([^`]+)`/)?.[1]).filter(Boolean);
ok('le tableau des suites est trouvé', documentees.length >= 4, `${documentees.length}`);
const suitesAbsentes = documentees.filter((n) => !fs.existsSync(path.join(ROOT, 'tests', `${n}-test.mjs`)));
ok('chaque suite documentée existe', suitesAbsentes.length === 0, suitesAbsentes.join(', '));
const suitesTues = suites.filter((n) => !documentees.includes(n));
ok('AUCUNE SUITE N\'EST PASSÉE SOUS SILENCE', suitesTues.length === 0, suitesTues.join(', '));

// ---- les dépendances ---------------------------------------------------------
const deps = Object.keys(pkg.dependencies || {});
ok('le compte de dépendances est juste',
  readme.includes('Trois dépendances') && deps.length === 3, deps.join(', '));
for (const d of deps) ok(`la dépendance ${d} est citée`, readme.includes(`\`${d}\``));

// ---- les variables d'environnement documentées existent quelque part --------
// Deux familles : celles que le code lit, et celles que compose traduit en
// variables internes. Ces dernières sont cherchées dans `.env.example`, versionné
// et identique partout — pas dans le compose, qu'un utilisateur adapte à son
// serveur. Un test de documentation ne doit pas échouer parce qu'il a configuré
// sa machine autrement.
const code = ['server.js', 'db.js', 'llm.js', 'tools.js', 'hermes.js', 'skills.js',
  'mcp.js', 'archive.js', 'orchestrator.js', '.env.example'].map(read).join('\n');
const vars = [...new Set([...readme.matchAll(/^\|\s*`([A-Z][A-Z0-9_]{3,})`/gm)].map((m) => m[1]))];
ok('des variables sont documentées', vars.length >= 5, `${vars.length}`);
const fantomes = vars.filter((v) => !code.includes(v));
ok('AUCUNE VARIABLE DOCUMENTÉE N\'EST FANTÔME', fantomes.length === 0, fantomes.join(', '));

// ---- toute variable lue est documentée --------------------------------------
// L'inverse du contrôle précédent, et le plus utile des deux : une variable que
// le code lit sans que le modèle la mentionne n'existe que pour qui lit les
// sources. Vingt-et-une s'étaient accumulées ainsi, chacune arrivée avec sa
// fonctionnalité, aucune passée par la documentation — parce que rien ne le
// signalait.
const modulesJs = fs.readdirSync(ROOT).filter((f) => /\.js$/.test(f) && f !== 'eslint.config.js');
const sources = modulesJs.map(read).join('\n');
const lues = [...new Set([...sources.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]))];
const exemple = read('.env.example');
ok('des variables sont lues par le code', lues.length >= 10, `${lues.length}`);

// Ces deux-là ne sont lues qu'en test, ou fournies par l'environnement lui-même.
const HORS_MODELE = new Set(['NODE_ENV', 'REPO_DIR']);
const tues = lues.filter((v) => !HORS_MODELE.has(v) && !exemple.includes(v));
ok('CHAQUE VARIABLE LUE EST DOCUMENTÉE DANS .env.example', tues.length === 0,
  `${tues.length} muette(s) : ${tues.join(', ')}`);

// Et les lignes du modèle doivent rester inactives : le fichier est facultatif,
// un `cp .env.example .env` ne doit rien imposer.
const actives = exemple.split('\n')
  .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l.trim()))
  .map((l) => l.split('=')[0].trim());
const imposees = actives.filter((v) => !['HERMES_API_URL', 'HERMES_API_KEY', 'HERMES_MODEL',
  'AGENTROUTER_API_URL', 'AGENTROUTER_API_KEY', 'AGENTROUTER_MODEL', 'TRAEFIK_HOST'].includes(v));
ok('aucune ligne active inattendue dans le modèle', imposees.length === 0, imposees.join(', '));

// ---- les onglets promis existent -------------------------------------------
const app = read('public/app.js');
const onglets = [...new Set([...app.matchAll(/navItem\('([a-z]+)'/g)].map((m) => m[1]))];
ok('la navigation est lisible', onglets.length >= 6, onglets.join(', '));
for (const nom of ['MCP', 'Skills']) {
  ok(`l'onglet ${nom} promis par le README existe`,
    readme.includes(`**${nom}**`) && app.includes(`, '${nom}')`), onglets.join(', '));
}

// ---- les liens internes du sommaire tombent juste --------------------------
const titres = new Set([...readme.matchAll(/^#{2,3} (.+)$/gm)].map(([, t]) => t
  .toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-')));
const casses = [...readme.matchAll(/- \[([^\]]+)\]\(#([^)]+)\)/g)]
  .filter(([, , anchor]) => !titres.has(anchor)).map(([, label]) => label);
ok('AUCUN LIEN DU SOMMAIRE NE TOMBE DANS LE VIDE', casses.length === 0, casses.join(', '));

// ---- la commande d'installation est celle du projet ------------------------
ok('la commande de test citée est celle de package.json', readme.includes('npm test'));
ok('le port publié cité correspond au compose',
  !/8090/.test(readme) || compose.includes('8090'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
