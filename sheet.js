/**
 * Écriture de fichiers .xlsx, sans dépendance.
 *
 * Un .xlsx est un zip de parties XML (OOXML SpreadsheetML). `makeZip` sait déjà
 * produire un zip correct — CRC, deflate, noms en UTF-8 — donc il ne manquait que
 * les parties elles-mêmes.
 *
 * Excel refuse d'ouvrir sans réparation un classeur dont les parties sont bonnes
 * mais mal ordonnées. Trois pièges tenus ici :
 *   - l'ordre des enfants de `<worksheet>` est imposé par le schéma
 *     (dimension, sheetViews, cols, sheetData, autoFilter) ;
 *   - `<fills>` doit compter au moins deux entrées, la seconde en `gray125`,
 *     même inutilisée ;
 *   - un caractère de contrôle interdit en XML 1.0 rend le fichier illisible,
 *     alors qu'aucun échappement ne le signale.
 */
import { makeZip } from './archive.js';

export const MAX_SHEETS = 12;
export const MAX_ROWS = 5000;
export const MAX_COLS = 64;
export const MAX_CELLS = 60000;
export const MAX_TEXT = 32767; // limite d'une cellule chez Excel

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** 1 → A, 26 → Z, 27 → AA. */
export function colName(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Les caractères de contrôle sont retirés avant échappement : XML 1.0 les
// interdit, y compris sous leur forme numérique, donc on ne peut pas les encoder.
const esc = (v) => String(v)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Un nom de feuille valide : 31 caractères, sans `: \ / ? * [ ]`, non vide. */
export function safeSheetName(name, index, taken) {
  let s = String(name ?? '').replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
  if (!s) s = `Feuille${index + 1}`;
  if (taken) {
    let base = s;
    let n = 2;
    while (taken.has(s.toLowerCase())) {
      const suffix = ` (${n++})`;
      base = base.slice(0, 31 - suffix.length);
      s = base + suffix;
    }
    taken.add(s.toLowerCase());
  }
  return s;
}

/**
 * Normalise ce qu'un modèle a envoyé, et dit ce qui a été écarté.
 * Rien ne jette : une feuille inutilisable est signalée, pas fatale.
 */
export function prepareSheets(input) {
  const skipped = [];
  const taken = new Set();
  const sheets = [];
  let cells = 0;

  const list = Array.isArray(input) ? input : [];
  for (const [i, raw] of list.entries()) {
    if (sheets.length >= MAX_SHEETS) { skipped.push(`feuille ${i + 1} (au-delà de ${MAX_SHEETS})`); continue; }
    if (!raw || typeof raw !== 'object') { skipped.push(`feuille ${i + 1} (illisible)`); continue; }

    const cols = (Array.isArray(raw.colonnes) ? raw.colonnes : [])
      .slice(0, MAX_COLS).map((c) => String(c ?? ''));
    const rowsIn = Array.isArray(raw.lignes) ? raw.lignes : [];

    // Une feuille sans en-tête ni ligne ne produirait qu'un onglet vide.
    if (!cols.length && !rowsIn.length) { skipped.push(`« ${raw.nom || `feuille ${i + 1}`} » (vide)`); continue; }

    const width = Math.min(MAX_COLS, Math.max(cols.length,
      ...rowsIn.map((r) => (Array.isArray(r) ? r.length : 1))));
    const rows = [];
    for (const r of rowsIn) {
      if (rows.length >= MAX_ROWS) { skipped.push(`« ${raw.nom || `feuille ${i + 1}`} » tronquée à ${MAX_ROWS} lignes`); break; }
      if (cells >= MAX_CELLS) break;
      // Une ligne donnée comme scalaire vaut une ligne d'une cellule : c'est une
      // erreur fréquente des modèles, et la refuser perdrait la donnée.
      const arr = Array.isArray(r) ? r : [r];
      const cellsRow = arr.slice(0, width).map((v) => {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (v === null || v === undefined) return '';
        if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
        return String(v).slice(0, MAX_TEXT);
      });
      cells += cellsRow.length;
      rows.push(cellsRow);
    }

    sheets.push({ name: safeSheetName(raw.nom, i, taken), cols: cols.map((c) => c.slice(0, MAX_TEXT)), rows, width });
  }

  return { sheets, skipped, cells };
}

function cellXml(ref, value, style) {
  const s = style ? ` s="${style}"` : '';
  if (typeof value === 'number') return `<c r="${ref}"${s}><v>${value}</v></c>`;
  if (value === '') return style ? `<c r="${ref}"${s}/>` : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function sheetXml(sheet) {
  const { cols, rows, width } = sheet;
  const total = rows.length + (cols.length ? 1 : 0);
  const lines = [];

  lines.push(HEAD);
  lines.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  if (total && width) lines.push(`<dimension ref="A1:${colName(width)}${total}"/>`);

  // L'en-tête reste visible au défilement : sur un questionnaire de cent lignes,
  // c'est la différence entre lisible et illisible.
  if (cols.length) {
    lines.push('<sheetViews><sheetView workbookViewId="0">'
      + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
      + '</sheetView></sheetViews>');
  }

  // Largeurs déduites du contenu : sans ça toutes les colonnes sortent à la
  // largeur par défaut et le texte long est coupé à l'affichage.
  if (width) {
    const parts = [];
    for (let c = 1; c <= width; c++) {
      let len = (cols[c - 1] || '').length;
      for (const r of rows) len = Math.max(len, String(r[c - 1] ?? '').length);
      parts.push(`<col min="${c}" max="${c}" width="${Math.min(70, Math.max(10, len + 2))}" customWidth="1"/>`);
    }
    lines.push(`<cols>${parts.join('')}</cols>`);
  }

  lines.push('<sheetData>');
  let n = 0;
  if (cols.length) {
    n = 1;
    const cs = cols.map((v, i) => cellXml(`${colName(i + 1)}1`, v, 1)).join('');
    lines.push(`<row r="1">${cs}</row>`);
  }
  for (const r of rows) {
    n++;
    const cs = r.map((v, i) => cellXml(`${colName(i + 1)}${n}`, v, 2)).join('');
    lines.push(`<row r="${n}">${cs}</row>`);
  }
  lines.push('</sheetData>');

  // Après `<sheetData>`, jamais avant : le schéma impose l'ordre.
  if (cols.length && rows.length) lines.push(`<autoFilter ref="A1:${colName(width)}${total}"/>`);
  lines.push('</worksheet>');
  return lines.join('');
}

const STYLES = HEAD
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  // La seconde entrée doit être `gray125` même si rien ne s'en sert : Excel
  // considère le fichier corrompu si elle manque.
  + '<fills count="3"><fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFE7EAF3"/>'
  + '<bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="1"><border/></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"'
  + ' applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">'
  + '<alignment vertical="top" wrapText="1"/></xf>'
  + '</cellXfs>'
  // Le style nommé « Normal » : sans lui, les lecteurs signalent un classeur sans
  // style par défaut et y substituent le leur.
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/** Construit le classeur. `sheets` sort de `prepareSheets`. */
export function makeXlsx(sheets, now = new Date()) {
  if (!sheets?.length) throw new Error('aucune feuille');

  const rels = sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/`
      + `officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('');

  const entries = [
    {
      path: '[Content_Types].xml',
      data: HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-'
        + 'officedocument.spreadsheetml.sheet.main+xml"/>'
        + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType=`
          + '"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-'
        + 'officedocument.spreadsheetml.styles+xml"/>'
        + '</Types>',
    },
    {
      path: '_rels/.rels',
      data: HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
        + 'relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      path: 'xl/workbook.xml',
      data: HEAD + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
        + sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
        + '</sheets></workbook>',
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      data: HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + rels
        + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/`
        + 'officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    },
    { path: 'xl/styles.xml', data: STYLES },
    ...sheets.map((s, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];

  return makeZip(entries, now);
}
