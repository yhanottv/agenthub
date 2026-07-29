/**
 * Archives ZIP écrites à la main.
 *
 * Deux risques, très différents :
 *
 * - le format. Un octet mal placé et l'archive s'ouvre nulle part, ou pire,
 *   s'ouvre à moitié. Le test relit donc l'archive par le répertoire central,
 *   décompresse chaque entrée et vérifie son CRC — la lecture ne fait pas
 *   confiance à l'écriture ;
 * - les chemins. Ils viennent d'un modèle, donc d'une conversation. `../../` ou
 *   `C:\Windows\` doivent être neutralisés avant d'entrer dans l'archive, sinon
 *   la décompression écrit hors de son dossier chez celui qui la reçoit.
 */
import zlib from 'node:zlib';
import {
  makeZip, prepareEntries, safeEntryPath,
  MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES,
} from '/app/archive.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}${extra ? '\n    ' + extra : ''}`); fail++; }
};

// ---- un lecteur indépendant -------------------------------------------------
const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC[n] = c;
}
const crc32 = (b) => {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

/** Relit une archive par son répertoire central, comme le fait un vrai outil. */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) throw new Error('fin d\'archive introuvable');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`entrée ${i} : signature invalide`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const plain = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // On repart de l'en-tête local, pas du répertoire : c'est là que sont les
    // octets, et les deux doivent concorder.
    if (buf.readUInt32LE(at) !== 0x04034b50) throw new Error(`${name} : en-tête local invalide`);
    const localNameLen = buf.readUInt16LE(at + 26);
    const localExtraLen = buf.readUInt16LE(at + 28);
    const start = at + 30 + localNameLen + localExtraLen;
    const body = buf.subarray(start, start + packed);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;

    out.push({ name, method, packed, plain, utf8: Boolean(flags & 0x0800), data, crcOk: crc32(data) === crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---- chemins ---------------------------------------------------------------
ok('une remontée de dossier est neutralisée', safeEntryPath('../../etc/passwd') === 'etc/passwd',
  safeEntryPath('../../etc/passwd'));
ok('un chemin absolu perd sa racine', safeEntryPath('/usr/bin/truc') === 'usr/bin/truc',
  safeEntryPath('/usr/bin/truc'));
ok('UN CHEMIN WINDOWS PERD SON LECTEUR',
  safeEntryPath('C:\\Windows\\System32\\evil.txt') === 'Windows/System32/evil.txt',
  safeEntryPath('C:\\Windows\\System32\\evil.txt'));
ok('les antislashs deviennent des séparateurs', safeEntryPath('src\\jeu\\index.js') === 'src/jeu/index.js',
  safeEntryPath('src\\jeu\\index.js'));
ok('un chemin vide ne donne rien', safeEntryPath('   ') === '' && safeEntryPath('../..') === '');
ok('les caractères interdits par les systèmes de fichiers sont remplacés',
  safeEntryPath('a<b>c:d.txt') === 'a_b_c_d.txt', safeEntryPath('a<b>c:d.txt'));
ok('un caractère de contrôle ne passe pas',
  !/[\u0000-\u001f]/.test(safeEntryPath('nom\u0000avec\u0007controle.txt')),
  JSON.stringify(safeEntryPath('nom\u0000avec\u0007controle.txt')));
ok('la profondeur est plafonnée',
  safeEntryPath('a/b/c/d/e/f/g/h/i/j/k.txt').split('/').length <= 8,
  safeEntryPath('a/b/c/d/e/f/g/h/i/j/k.txt'));
ok('les accents sont conservés', safeEntryPath('notes/été.md') === 'notes/été.md');

// ---- tri des entrées -------------------------------------------------------
const trie = prepareEntries([
  { chemin: 'index.html', contenu: '<h1>a</h1>' },
  { chemin: 'index.html', contenu: 'doublon' },
  { chemin: '../evade.txt', contenu: 'x' },
  { chemin: '   ', contenu: 'vide' },
  { chemin: 'gros.bin', contenu: 'x'.repeat(MAX_ENTRY_BYTES + 10) },
]);
ok('un doublon est écarté une fois seulement',
  trie.kept.filter((e) => e.path === 'index.html').length === 1);
ok('le premier contenu gagne', trie.kept[0].data.toString() === '<h1>a</h1>');
ok('un chemin inutilisable est signalé, pas ignoré en silence',
  trie.skipped.some((s) => /inutilisable/.test(s)), trie.skipped.join(' | '));
ok('un fichier trop gros est refusé nommément',
  trie.skipped.some((s) => /gros\.bin/.test(s) && /2 Mo/.test(s)), trie.skipped.join(' | '));
ok('la remontée de dossier est retenue mais assainie',
  trie.kept.some((e) => e.path === 'evade.txt'), trie.kept.map((e) => e.path).join(', '));

const trop = prepareEntries(
  Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => ({ chemin: `f${i}.txt`, contenu: 'x' })));
ok('le nombre de fichiers est plafonné', trop.kept.length === MAX_ENTRIES, String(trop.kept.length));
ok('et le dépassement est dit', trop.skipped.length === 5, String(trop.skipped.length));

const lourd = prepareEntries([
  { chemin: 'a.bin', contenu: 'a'.repeat(MAX_ENTRY_BYTES) },
  { chemin: 'b.bin', contenu: 'b'.repeat(MAX_ENTRY_BYTES) },
  { chemin: 'c.bin', contenu: 'c'.repeat(MAX_ENTRY_BYTES) },
  { chemin: 'd.bin', contenu: 'd'.repeat(MAX_ENTRY_BYTES) },
  { chemin: 'e.bin', contenu: 'e'.repeat(MAX_ENTRY_BYTES) },
]);
ok('le total est plafonné', lourd.bytes <= MAX_TOTAL_BYTES, `${lourd.bytes} octets`);
ok('le fichier qui aurait fait déborder est nommé',
  lourd.skipped.some((s) => /8 Mo/.test(s)), lourd.skipped.join(' | '));

// ---- l'archive elle-même ---------------------------------------------------
const REPETE = 'const c = document.getElementById("c");\n'.repeat(200);
// Que des octets différents : il n'y a rien à factoriser, donc compresser ne
// peut que faire grossir. C'est le cas qui doit basculer en « stocké ».
const INCOMPRESSIBLE = Array.from({ length: 96 }, (_, i) => String.fromCharCode(32 + i)).join('');
const { kept } = prepareEntries([
  { chemin: 'index.html', contenu: '<!doctype html><title>Jeu</title><canvas id="c"></canvas>' },
  { chemin: 'src/jeu.js', contenu: REPETE },
  { chemin: 'notes/été-2026.md', contenu: '# Accents é à ç\nUn accent dans le nom.' },
  { chemin: 'alea.bin', contenu: INCOMPRESSIBLE },
]);
const zip = makeZip(kept, new Date(Date.UTC(2026, 6, 29, 14, 30, 20)));

let lu;
try { lu = readZip(zip); } catch (err) { lu = null; console.log(`    lecture impossible : ${err.message}`); }
ok('L\'ARCHIVE SE RELIT ENTIÈREMENT', Array.isArray(lu) && lu.length === 4, `${lu ? lu.length : 'echec'} entrée(s)`);

if (lu) {
  const par = Object.fromEntries(lu.map((e) => [e.name, e]));
  ok('CHAQUE FICHIER A UN CRC VALIDE', lu.every((e) => e.crcOk),
    lu.filter((e) => !e.crcOk).map((e) => e.name).join(', '));
  ok('les noms et l\'ordre sont conservés',
    lu.map((e) => e.name).join('|') === 'index.html|src/jeu.js|notes/été-2026.md|alea.bin',
    lu.map((e) => e.name).join('|'));
  ok('le contenu revient identique',
    par['src/jeu.js'].data.toString('utf8') === REPETE
    && /Accents é à ç/.test(par['notes/été-2026.md'].data.toString('utf8')));
  ok('les tailles annoncées sont les bonnes', lu.every((e) => e.plain === e.data.length));
  ok('les noms sont marqués UTF-8', lu.every((e) => e.utf8));
  ok('un fichier répétitif est bien compressé',
    par['src/jeu.js'].method === 8 && par['src/jeu.js'].packed < par['src/jeu.js'].plain / 10,
    `${par['src/jeu.js'].plain} -> ${par['src/jeu.js'].packed}`);
  ok('UN FICHIER QUI NE GAGNE RIEN EST STOCKÉ TEL QUEL',
    par['alea.bin'].method === 0 && par['alea.bin'].packed === par['alea.bin'].plain,
    `methode=${par['alea.bin'].method} ${par['alea.bin'].plain} -> ${par['alea.bin'].packed}`);
}

// Une archive vide reste une archive valide : mieux vaut un fichier qu'un lecteur
// ouvre et trouve vide qu'un fichier tronqué.
const vide = makeZip([]);
ok('une archive sans fichier reste lisible', readZip(vide).length === 0 && vide.length === 22,
  `${vide.length} octets`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
