/**
 * Reconstruction de l'index de recherche sur une base déjà remplie.
 *
 * Le piège que ce test fige : sur une table FTS5 à contenu externe,
 * `SELECT COUNT(*) FROM messages_fts` traverse jusqu'à la table source et
 * renvoie le nombre de messages même lorsque l'index est vide. Une condition
 * « reconstruire si l'index est à zéro » ne se déclenche donc jamais, et toutes
 * les conversations antérieures à la mise à jour restent introuvables — un
 * défaut invisible sur une base neuve, où les déclencheurs remplissent l'index
 * au fil des insertions.
 *
 * La seconde phase tourne dans un processus séparé : le rattrapage a lieu au
 * chargement du module, et un module déjà importé ne se recharge pas.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const DATA_DIR = '/tmp/ah-search-' + Date.now();
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}${extra ? '\n    ' + extra : ''}`); fail++; }
};

const db = await import('/app/db.js');

// ---- phase 1 : une base peuplée, puis ramenée à l'état d'avant la mise à jour
const channel = db.Channels.create({ name: 'Archives', members: [] });
const LINES = [
  "Salut à l'équipe, on parle du dossier Acme ce matin.",
  'Deuxième message, sans le mot recherché.',
  'Le dossier Acme avance bien, livraison mardi.',
];
for (const content of LINES) {
  db.Messages.create({ channel_id: channel.id, author_type: 'user', author_name: 'Toi', content });
}
db.Notes.create({ title: 'Client Acme', content: 'Secteur industriel, contact direction marketing.' });

ok('la recherche fonctionne sur ce qui vient d\'être écrit', db.Search.run('acme').messages.length === 2);

db.db.exec('DROP TABLE messages_fts; DROP TABLE notes_fts;');
db.db.prepare("DELETE FROM settings WHERE key='fts_built'").run();
ok('l\'index a bien été supprimé', !db.db.prepare(
  "SELECT name FROM sqlite_master WHERE name='messages_fts'").get());

// ---- phase 2 : un nouveau démarrage doit rattraper l'historique -------------
const script = `
  import('/app/db.js').then((m) => {
    const r = m.Search.run('acme');
    const notes = m.Search.run('industriel');
    process.stdout.write(JSON.stringify({
      engine: r.engine,
      messages: r.messages.length,
      excerpt: r.messages[0] ? r.messages[0].excerpt : '',
      notes: notes.notes.length,
    }));
  });
`;
const raw = execFileSync(process.execPath, ['-e', script], {
  env: { ...process.env, DATA_DIR },
  encoding: 'utf8',
});
const out = JSON.parse(raw.slice(raw.indexOf('{')));

ok('le moteur reste FTS5', out.engine === 'fts5', `moteur = ${out.engine}`);
ok('L\'HISTORIQUE EST RÉINDEXÉ AU DÉMARRAGE', out.messages === 2,
  `${out.messages} message(s) retrouvé(s) au lieu de 2 — l'index n'a pas été reconstruit`);
ok('les termes trouvés sont marqués dans l\'extrait', /<<.+>>/.test(out.excerpt), out.excerpt);
ok('les notes sont réindexées aussi', out.notes === 1);

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* verrou Windows */ }
process.exit(fail ? 1 : 0);
