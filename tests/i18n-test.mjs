/**
 * Le dictionnaire anglais est-il encore branché sur l'interface ?
 *
 * La traduction se fait par remplacement dans le DOM : une entrée est utilisée
 * si, et seulement si, sa clé française apparaît telle quelle à l'écran. Le jour
 * où un libellé est reformulé dans app.js, l'entrée correspondante ne casse
 * rien — elle devient simplement morte, et la phrase repasse en français sans
 * que personne ne s'en aperçoive.
 *
 * Ce test relit donc chaque clé du noyau et exige de la retrouver dans les
 * sources. Il ne juge pas la qualité des traductions ; il signale celles qui ne
 * s'appliquent plus à rien.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/app';
let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}${extra ? '\n    ' + extra : ''}`); fail++; }
};

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const i18nSrc = read('public/i18n.js');

// ---- les clés du noyau, lues dans le fichier plutôt qu'importées ------------
// i18n.js est un script classique destiné au navigateur : il n'exporte rien et
// touche à `localStorage`. On lit donc le littéral.
const coreBlock = i18nSrc.slice(
  i18nSrc.indexOf('const CORE_EN = {'),
  i18nSrc.indexOf('\nconst DICTS'),
);
ok('le noyau est bien délimité dans public/i18n.js', coreBlock.length > 1000);

const keys = [];
const dupes = [];
const seen = new Set();
for (const m of coreBlock.matchAll(/^ {2}'((?:[^'\\]|\\.)*)':/gm)) {
  const key = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  if (seen.has(key)) dupes.push(key);
  seen.add(key);
  keys.push(key);
}
ok('le noyau contient au moins 200 libellés', keys.length >= 200, `${keys.length} trouvé(s)`);
ok('aucune clé en double', dupes.length === 0, dupes.join(' | '));

// ---- les clés doivent exister dans ce qui s'affiche -------------------------
// Les sources écrivent les apostrophes échappées (\') et parfois des entités
// HTML ; on les ramène à ce que le navigateur finira par afficher.
// Les blancs sont écrasés comme le fait `lookup` : une phrase coupée sur deux
// lignes dans un gabarit reste la même phrase à l'écran.
const haystack = ['public/app.js', 'public/index.html', 'server.js', 'skills.js', 'graph.js',
  'orchestrator.js', 'mcp.js']
  .map(read).join('\n')
  .replace(/\s+/g, ' ')
  .replace(/\\'/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&#39;/g, "'");

// Libellés qui n'existent pas littéralement dans le code : soit ils sont
// assemblés à l'exécution, soit ils viennent d'un fournisseur. Les traduire
// reste utile, mais ce test ne peut pas les vérifier.
const COMPOSES = new Set([
  'Hermes', 'Skills', 'Notes', 'Agents', 'Tags', 'Message', 'Pause', 'Graph',
  'Titre', 'Contenu', 'Nom', 'Service', 'Modèle', 'Langue', 'Heure', 'Minute',
  'Jours', 'Actif', 'actif', 'local', 'connecté', 'disponible', 'aucun', 'tout',
  'toutes', 'envoie', 'saute une ligne', 'réfléchit', 'recherche', 'travaille',
  'estimation', '24 heures', '7 jours', '30 jours',
]);

const orphans = keys.filter((k) => !COMPOSES.has(k) && !haystack.includes(k));
ok('CHAQUE LIBELLÉ TRADUIT EXISTE ENCORE DANS L\'INTERFACE', orphans.length === 0,
  orphans.length
    ? `${orphans.length} entrée(s) morte(s) :\n    - ` + orphans.map((o) => JSON.stringify(o)).join('\n    - ')
    : '');

// ---- garde-fous sur les valeurs --------------------------------------------
const values = [...coreBlock.matchAll(/':\s*\n?\s*'((?:[^'\\]|\\.)*)',/g)].map((m) => m[1]);
ok('autant de traductions que de clés', values.length === keys.length,
  `${values.length} valeur(s) pour ${keys.length} clé(s)`);
ok('aucune traduction vide', values.every((v) => v.trim().length > 0));

const stillFrench = values.filter((v) => /\b(le|la|les|une|des|tes|ton|pour|avec|dans|aucun)\b/i.test(v));
ok('aucune traduction laissée en français', stillFrench.length === 0,
  stillFrench.slice(0, 6).map((v) => JSON.stringify(v)).join(' | '));

// ---- le vocabulaire maison doit être le même des deux côtés -----------------
// Le serveur impose un glossaire au modèle pour les libellés qu'il traduit à la
// volée. S'il dit « hub » là où le noyau dit « unit », l'interface se contredit
// d'un écran à l'autre.
const glossary = read('server.js').match(/const I18N_GLOSSARY = \{[\s\S]*?\n\};/)?.[0] || '';
ok('le serveur impose un vocabulaire au modèle', /pôle = unit/.test(glossary), glossary.slice(0, 80));
ok('le noyau emploie le même mot pour « pôle »', /'Pôles': 'Units'/.test(coreBlock));
ok('le noyau emploie le même mot pour « salon »',
  /'Par salon': 'By channel'/.test(coreBlock));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
