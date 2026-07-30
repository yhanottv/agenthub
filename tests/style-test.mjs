/**
 * Une règle CSS abandonnée en écrase-t-elle une autre en silence ?
 *
 * Ce défaut s'est produit deux fois en deux jours, et à chaque fois il a coûté
 * plusieurs allers-retours à comprendre : une ancienne règle laissée plus bas dans
 * la feuille gagne sur la nouvelle, sans erreur, sans avertissement, et l'élément
 * s'affiche avec une couleur ou une forme dont plus rien dans le code récent ne
 * rend compte. On lit dix fois la bonne règle en se demandant pourquoi elle ne
 * s'applique pas.
 *
 * Le test ne juge pas le style. Il signale une seule chose : deux règles portant
 * exactement le même sélecteur, au même niveau, qui déclarent la même propriété
 * avec deux valeurs différentes. Une répétition volontaire — `.x` puis `.x:hover`,
 * ou une surcharge dans un `@media` — n'est pas concernée.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.REPO_DIR || '/app';
let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}${extra ? '\n    ' + extra : ''}`); fail++; }
};

const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

/**
 * Les règles de premier niveau, `@media` et `@keyframes` exclus.
 *
 * Un vrai analyseur CSS serait excessif : on suit la profondeur des accolades et
 * on ne retient que ce qui est à la racine, en sautant les blocs `@`.
 */
function topLevelRules(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    // Commentaires
    if (text.startsWith('/*', i)) { i = text.indexOf('*/', i + 2) + 2 || text.length; continue; }

    const brace = text.indexOf('{', i);
    if (brace === -1) break;
    const selector = text.slice(i, brace).replace(/\/\*[\s\S]*?\*\//g, '').trim();

    // Fin du bloc, en suivant l'imbrication.
    let depth = 1, j = brace + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const body = text.slice(brace + 1, j - 1);
    if (selector && !selector.startsWith('@')) out.push({ selector, body });
    i = j;
  }
  return out;
}

const rules = topLevelRules(css);
ok('la feuille se relit', rules.length > 200, `${rules.length} règle(s) de premier niveau`);

/** Les déclarations d'un corps de règle, dernière valeur gagnante. */
function declarations(body) {
  const out = {};
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i === -1) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    if (prop && value && !prop.startsWith('--')) out[prop] = value;
  }
  return out;
}

const vues = new Map();
const conflits = [];
for (const { selector, body } of rules) {
  const clef = selector.replace(/\s+/g, ' ');
  const decls = declarations(body);
  if (vues.has(clef)) {
    const avant = vues.get(clef);
    for (const [prop, val] of Object.entries(decls)) {
      if (prop in avant && avant[prop] !== val) {
        conflits.push(`${clef} → ${prop} : « ${avant[prop] }» puis « ${val} »`);
      }
    }
    vues.set(clef, { ...avant, ...decls });
  } else {
    vues.set(clef, decls);
  }
}

ok('AUCUNE RÈGLE N\'EN ÉCRASE UNE AUTRE EN SILENCE', conflits.length === 0,
  conflits.slice(0, 8).join('\n    '));

// Les sélecteurs répétés sans conflit sont légitimes, mais au-delà d'un seuil
// c'est le signe d'une feuille qu'on a cessé de ranger.
const repetes = [...vues.keys()].filter((k) =>
  rules.filter((r) => r.selector.replace(/\s+/g, ' ') === k).length > 2);
ok('aucun sélecteur n\'est défini plus de deux fois', repetes.length === 0, repetes.join(', '));

// ---- les deux thèmes définissent les mêmes couleurs ------------------------
// Une couleur définie d'un seul côté donne une teinte du thème clair sur un fond
// sombre — illisible, et sans erreur pour le signaler. Seules les couleurs sont
// comparées : les espacements, rayons et durées n'ont aucune raison de changer
// avec le thème, et exiger qu'ils soient répétés serait du bruit.
const estCouleur = (v) => /^(#|rgb|hsl)/i.test(v.trim());
const couleursDe = (sel) => {
  const r = rules.find((x) => x.selector.replace(/\s+/g, ' ') === sel);
  if (!r) return [];
  return [...r.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)]
    .filter(([, , v]) => estCouleur(v)).map(([, n]) => n);
};
const clair = couleursDe(':root');
const sombre = couleursDe(':root[data-theme="dark"]');
ok('les deux thèmes sont trouvés', clair.length > 15 && sombre.length > 15,
  `clair ${clair.length} · sombre ${sombre.length}`);
const manquantes = clair.filter((v) => !sombre.includes(v));
ok('CHAQUE COULEUR DU THÈME CLAIR EXISTE EN SOMBRE', manquantes.length === 0,
  manquantes.join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
