'use strict';

/* ============================================================================
   Écriture d'archives ZIP.

   Le projet tient à trois dépendances et ce n'est pas pour en ajouter une
   quatrième qui sait déjà tout faire : ici on n'écrit qu'un ZIP, sans lecture,
   sans chiffrement, sans Zip64. Le format tient en trois structures — un
   en-tête par fichier, un répertoire central, une fin d'archive — et `zlib`,
   qui est dans Node, fait la compression.

   Ce que ça garantit : les chemins venus d'un modèle ne peuvent pas sortir de
   l'archive, un fichier qui gonflerait en compressant est stocké tel quel, et
   les noms accentués s'ouvrent correctement partout (drapeau UTF-8).
   ========================================================================== */

import zlib from 'node:zlib';

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Date et heure au format MS-DOS, seul format que connaisse un ZIP. */
function dosStamp(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31),
    date: (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

export const MAX_ENTRIES = 200;
export const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * Chemin utilisable dans une archive, ou chaîne vide s'il n'en reste rien.
 *
 * Un chemin proposé par un modèle est une entrée non fiable comme une autre :
 * `../`, une lettre de lecteur, un début par `/` doivent disparaître, sinon
 * l'archive écrirait hors de son dossier chez celui qui l'ouvre.
 */
export function safeEntryPath(raw) {
  const parts = String(raw || '')
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..');

  return parts
    .map((p) => p.replace(/[\p{Cc}<>:"|?*]/gu, '_').slice(0, 80))
    .filter(Boolean)
    .slice(0, 8)
    .join('/')
    .slice(0, 200);
}

/**
 * Assemble une archive.
 *
 * @param {Array<{path: string, data: Buffer|string}>} entries
 * @returns {Buffer}
 */
export function makeZip(entries, now = new Date()) {
  const { time, date } = dosStamp(now);
  const bodies = [];
  const central = [];
  let offset = 0;
  let count = 0;

  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Un fichier déjà compressé grossit en le recompressant : dans ce cas on le
    // stocke tel quel, ce qui est légal et plus petit.
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version minimale pour lire
    local.writeUInt16LE(0x0800, 6);    // bit 11 : le nom est en UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);        // pas de champ « extra »
    bodies.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);          // version d'écriture
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + body.length;
    count++;
  }

  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);            // un seul disque
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);           // pas de commentaire

  return Buffer.concat([...bodies, dirBuf, end]);
}

/**
 * Relit une archive.
 *
 * Écrire un ZIP suffisait tant que l'archive ne servait qu'à être téléchargée.
 * Mais un agent qui livre un site en archive ne laisse aucun bloc de code dans
 * la conversation, donc rien à prévisualiser : pour afficher ce site, il faut
 * savoir rouvrir ce qu'on a fermé.
 *
 * La lecture passe par le répertoire central, jamais par un balayage des
 * en-têtes locaux : c'est le répertoire qui fait autorité sur ce que contient
 * une archive, et un en-tête local peut mentir sur les tailles.
 *
 * @returns {Array<{path: string, data: Buffer}>}
 */
export function readZip(buf, { maxEntries = MAX_ENTRIES, maxTotal = 12 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Fichier trop court pour être une archive.');

  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1 || eocd + 22 > buf.length) throw new Error("Ce n'est pas une archive ZIP.");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('Archive Zip64 : non prise en charge.');
  if (p >= buf.length) throw new Error('Archive tronquée (répertoire hors du fichier).');

  const out = [];
  let total = 0;
  for (let i = 0; i < Math.min(count, maxEntries); i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`Archive corrompue à l'entrée ${i + 1}.`);
    }
    const method = buf.readUInt16LE(p + 10);
    const packed = buf.readUInt32LE(p + 20);
    const plain = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const at = buf.readUInt32LE(p + 42);
    const rawName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    // Un dossier est une entrée de taille nulle dont le nom finit par « / ».
    if (rawName.endsWith('/')) continue;
    // Le nom vient du fichier, donc d'ailleurs : on le rassainit comme à
    // l'écriture, sinon rouvrir une archive rouvrirait aussi ses pièges.
    const path = safeEntryPath(rawName);
    if (!path) continue;

    if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) {
      throw new Error(`Entrée « ${path} » introuvable dans l'archive.`);
    }
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    if (start + packed > buf.length) throw new Error(`Entrée « ${path} » tronquée.`);

    // Une archive peut annoncer une taille décompressée énorme pour un tout
    // petit contenu : on refuse avant de décompresser, pas après.
    total += plain;
    if (total > maxTotal) throw new Error(`Archive trop volumineuse (plus de ${Math.round(maxTotal / 1048576)} Mo décompressés).`);

    const body = buf.subarray(start, start + packed);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) {
      try { data = zlib.inflateRawSync(body, { maxOutputLength: maxTotal }); }
      catch { throw new Error(`Entrée « ${path} » illisible (décompression échouée).`); }
    } else continue;   // méthode exotique : on l'ignore plutôt que d'échouer

    out.push({ path, data });
  }
  return out;
}

/**
 * Prépare une liste de fichiers venue d'un modèle.
 *
 * Renvoie les entrées retenues et ce qui a été écarté, pour que l'agent puisse
 * le dire au lieu de croire que tout est passé.
 */
export function prepareEntries(list) {
  const kept = [];
  const skipped = [];
  const seen = new Set();
  let total = 0;

  for (const item of Array.isArray(list) ? list : []) {
    if (kept.length >= MAX_ENTRIES) { skipped.push(`${item?.chemin || '?'} (plus de ${MAX_ENTRIES} fichiers)`); continue; }

    const path = safeEntryPath(item?.chemin ?? item?.path);
    if (!path) { skipped.push(`${item?.chemin || '?'} (chemin inutilisable)`); continue; }
    if (seen.has(path)) { skipped.push(`${path} (déjà présent)`); continue; }

    const data = Buffer.from(String(item?.contenu ?? item?.content ?? ''), 'utf8');
    if (data.length > MAX_ENTRY_BYTES) { skipped.push(`${path} (dépasse 2 Mo)`); continue; }
    if (total + data.length > MAX_TOTAL_BYTES) { skipped.push(`${path} (l'archive dépasserait 8 Mo)`); continue; }

    seen.add(path);
    total += data.length;
    kept.push({ path, data });
  }

  return { kept, skipped, bytes: total };
}
