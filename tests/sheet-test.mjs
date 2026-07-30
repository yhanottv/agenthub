/**
 * L'écriture des .xlsx.
 *
 * Un classeur mal formé ne rate pas franchement : Excel l'ouvre en proposant
 * « réparer », ce qui perd les données sans erreur côté serveur. Aucun test
 * unitaire sur les valeurs ne verrait ça — ce qui se vérifie ici, c'est la forme
 * du paquet : les parties présentes, l'ordre imposé par le schéma, et le fait que
 * ce qui vient d'un modèle ne peut pas produire du XML invalide.
 *
 * Le classeur est relu avec `readZip`, le lecteur du projet : si l'un des deux
 * dérive, le test tombe.
 */
import { readZip } from '/app/archive.js';
import {
  makeXlsx, prepareSheets, colName, safeSheetName, MAX_ROWS, MAX_SHEETS,
} from '/app/sheet.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}${extra ? '\n    ' + extra : ''}`); fail++; }
};

const parts = (buf) => Object.fromEntries(
  readZip(buf).map((e) => [e.path, e.data.toString('utf8')]));

/**
 * Bien-formation : les balises se referment dans l'ordre, et aucun `&` ou `<`
 * ne subsiste hors balise. Sans dépendance, c'est ce qui approche le mieux ce
 * que ferait un parseur.
 */
function xmlWellFormed(src) {
  // Le prologue est retiré d'abord : `<?xml …?>` n'est pas une balise, et le
  // laisser passer le ferait compter comme du texte contenant un « < ».
  const s = src.replace(/^\s*<\?xml[^>]*\?>\s*/, '');
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    const text = s.slice(last, m.index);
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) return `& nu : ${text.slice(0, 40)}`;
    if (text.includes('<')) return `< nu : ${text.slice(0, 40)}`;
    last = m.index + m[0].length;
    if (m[3].trim().endsWith('/') || m[2] === '?xml') continue;
    if (m[1]) {
      if (stack.pop() !== m[2]) return `fermeture inattendue : ${m[2]}`;
    } else stack.push(m[2]);
  }
  if (stack.length) return `non fermé : ${stack.join(', ')}`;
  return null;
}

// ---- les briques ------------------------------------------------------------
ok('une colonne se nomme A', colName(1) === 'A');
ok('LA 27e COLONNE EST AA, PAS [', colName(27) === 'AA', colName(27));
ok('la 52e est AZ', colName(52) === 'AZ', colName(52));
ok('la 703e est AAA', colName(703) === 'AAA', colName(703));

ok('UN NOM DE FEUILLE PERD LES CARACTÈRES INTERDITS',
  safeSheetName('État/des:lieux[2]', 0) === 'État des lieux 2', safeSheetName('État/des:lieux[2]', 0));
ok('un nom trop long est coupé à 31', safeSheetName('x'.repeat(60), 0).length === 31);
ok('un nom vide reçoit un nom par défaut', safeSheetName('   ', 3) === 'Feuille4');
const pris = new Set();
ok('DEUX FEUILLES NE PEUVENT PAS PORTER LE MÊME NOM',
  safeSheetName('Sortie', 0, pris) === 'Sortie' && safeSheetName('Sortie', 1, pris) === 'Sortie (2)');

// ---- ce qu'un modèle envoie -------------------------------------------------
const p = prepareSheets([
  { nom: 'Cuisine', colonnes: ['Élément', 'État', 'Note'], lignes: [['Évier', 'Bon', 4], ['Plaque', '', '']] },
  { nom: 'Vide', colonnes: [], lignes: [] },
  'pas un objet',
  { nom: 'Scalaire', colonnes: ['Q'], lignes: ['une ligne donnée à plat'] },
]);
ok('une feuille correcte passe', p.sheets[0]?.name === 'Cuisine');
ok('une feuille vide est écartée, pas fatale', p.skipped.some((s) => s.includes('Vide')));
ok('une entrée illisible est écartée', p.skipped.some((s) => s.includes('illisible')));
ok('UNE LIGNE DONNÉE À PLAT DEVIENT UNE LIGNE D\'UNE CELLULE',
  p.sheets.find((s) => s.name === 'Scalaire')?.rows[0]?.[0] === 'une ligne donnée à plat');
ok('un nombre reste un nombre', p.sheets[0].rows[0][2] === 4);
ok('les cellules sont comptées', p.cells === 7, String(p.cells));

const trop = prepareSheets([{ nom: 'T', colonnes: ['a'], lignes: Array.from({ length: MAX_ROWS + 50 }, (_, i) => [i]) }]);
ok(`au-delà de ${MAX_ROWS} lignes, la feuille est tronquée`, trop.sheets[0].rows.length === MAX_ROWS);
ok('ET LA TRONCATURE EST DITE, PAS SILENCIEUSE', trop.skipped.some((s) => s.includes('tronquée')),
  JSON.stringify(trop.skipped));
const tropF = prepareSheets(Array.from({ length: MAX_SHEETS + 3 },
  (_, i) => ({ nom: `F${i}`, colonnes: ['a'], lignes: [[1]] })));
ok(`au-delà de ${MAX_SHEETS} feuilles, le reste est écarté et signalé`,
  tropF.sheets.length === MAX_SHEETS && tropF.skipped.length === 3);

// ---- le paquet --------------------------------------------------------------
const buf = makeXlsx(prepareSheets([
  { nom: 'Sortie', colonnes: ['Pièce', 'Constat'], lignes: [['Salon', 'Rien à signaler'], ['Cave', 42]] },
  { nom: 'Compteurs', colonnes: ['Type', 'Index'], lignes: [['Eau', 1234]] },
]).sheets);
const f = parts(buf);

for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml',
  'xl/worksheets/sheet2.xml']) {
  ok(`la partie ${part} est présente`, part in f);
}
ok('AUCUNE PARTIE EN TROP', Object.keys(f).length === 7, Object.keys(f).join(', '));

for (const [name, body] of Object.entries(f)) {
  const err = xmlWellFormed(body);
  ok(`${name} est du XML bien formé`, err === null, err || '');
}

const s1 = f['xl/worksheets/sheet1.xml'];
// L'ordre des enfants de <worksheet> est imposé : bon contenu, mauvais ordre,
// et Excel propose de réparer.
const ordre = ['<dimension', '<sheetViews', '<cols', '<sheetData', '<autoFilter']
  .map((t) => s1.indexOf(t));
ok('L\'ORDRE DES ENFANTS DE <worksheet> SUIT LE SCHÉMA',
  ordre.every((v, i) => v > 0 && (i === 0 || v > ordre[i - 1])), JSON.stringify(ordre));
ok('le filtre vient après les données, jamais avant',
  s1.indexOf('<autoFilter') > s1.indexOf('</sheetData>'));
ok('l\'en-tête est figé au défilement', s1.includes('state="frozen"'));
ok('les largeurs de colonnes sont posées', /<col min="1" max="1" width="\d+"/.test(s1));
ok('la dimension couvre trois lignes sur deux colonnes', s1.includes('ref="A1:B3"'), s1.slice(0, 300));

ok('UN NOMBRE EST ÉCRIT COMME NOMBRE', s1.includes('<c r="B3" s="2"><v>42</v></c>'), s1);
ok('un texte passe en chaîne littérale', s1.includes('>Rien à signaler<'));
ok('l\'en-tête porte le style gras', /<c r="A1" s="1"/.test(s1));

// Excel considère le fichier corrompu si la seconde entrée de <fills> manque.
ok('LES DEUX REMPLISSAGES OBLIGATOIRES SONT LÀ',
  f['xl/styles.xml'].includes('patternType="none"') && f['xl/styles.xml'].includes('patternType="gray125"'));
const nbXf = (f['xl/styles.xml'].match(/<xf /g) || []).length - 1; // hors cellStyleXfs
ok('le nombre de styles annoncé est le vrai',
  f['xl/styles.xml'].includes(`<cellXfs count="${nbXf}">`), `${nbXf}`);

ok('chaque feuille est reliée au classeur',
  f['xl/_rels/workbook.xml.rels'].includes('worksheets/sheet1.xml')
  && f['xl/_rels/workbook.xml.rels'].includes('worksheets/sheet2.xml'));
ok('ET LES STYLES AUSSI, SINON LE GRAS EST IGNORÉ',
  f['xl/_rels/workbook.xml.rels'].includes('Target="styles.xml"'));
ok('les deux onglets sont déclarés',
  f['xl/workbook.xml'].includes('name="Sortie"') && f['xl/workbook.xml'].includes('name="Compteurs"'));

// ---- ce qui vient d'un modèle ne doit pas pouvoir casser le XML -------------
const sale = makeXlsx(prepareSheets([{
  nom: 'A&B <script>',
  colonnes: ['<b>gras</b>', 'guillemet "x"'],
  lignes: [['a & b', 'fin\u0000de\u0007ligne'], ['</sheetData>', "apostrophe ' ici"]],
}]).sheets);
const fs2 = parts(sale);
for (const [name, body] of Object.entries(fs2)) {
  ok(`injection : ${name} reste bien formé`, xmlWellFormed(body) === null, xmlWellFormed(body) || '');
}
const s3 = fs2['xl/worksheets/sheet1.xml'];
ok('UNE BALISE DANS UNE CELLULE EST ÉCHAPPÉE, PAS INTERPRÉTÉE',
  s3.includes('&lt;/sheetData&gt;') && (s3.match(/<\/sheetData>/g) || []).length === 1);
ok('une esperluette est échappée', s3.includes('a &amp; b'));
ok('UN CARACTÈRE DE CONTRÔLE EST RETIRÉ : XML 1.0 L\'INTERDIT MÊME ENCODÉ',
  !s3.includes('\u0000') && !s3.includes('\u0007') && s3.includes('findeligne'), s3.slice(0, 200));
// Excel n'interdit que `: \ / ? * [ ]` dans un nom d'onglet : `<` et `>` y sont
// légaux, donc les garder est juste — ce qui compte est qu'ils soient échappés
// dans l'attribut, sinon le classeur entier devient illisible.
ok('UN NOM DE FEUILLE HOSTILE EST ÉCHAPPÉ DANS L\'ATTRIBUT',
  fs2['xl/workbook.xml'].includes('name="A&amp;B &lt;script&gt;"'), fs2['xl/workbook.xml']);

// ---- un classeur sans feuille ----------------------------------------------
let jete = false;
try { makeXlsx([]); } catch { jete = true; }
ok('un classeur sans feuille est refusé plutôt que produit vide', jete);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
