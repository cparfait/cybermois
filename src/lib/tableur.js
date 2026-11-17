import zlib from 'node:zlib';

/**
 * Ecriture d'un classeur Excel (.xlsx), sans bibliotheque.
 *
 * Pendant de classeur.js, qui en lit un : un .xlsx est une archive ZIP de
 * quelques fichiers XML. On n'y ecrit qu'une feuille, ce qui suffit aux
 * exports du classement.
 *
 * Les textes sont ecrits en « chaines en ligne » (t="inlineStr") : une telle
 * cellule n'est jamais lue comme une formule, quel que soit son premier
 * caractere. Un nom d'agent venu de l'annuaire et commencant par « = » reste
 * donc du texte, sans le prefixe d'apostrophe que le CSV doit ajouter.
 */

/** Styles declares dans styles.xml, dans cet ordre. */
export const STYLE = { normal: 0, entete: 1, pourcentage: 2, decimal: 3, titre: 4 };

const xml = (s) => String(s ?? '')
  // Les caracteres de controle sont interdits en XML 1.0 : Excel refuserait le fichier.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 0 -> « A », 27 -> « AB ». */
const lettre = (i) => (i < 26 ? String.fromCharCode(65 + i) : lettre(Math.floor(i / 26) - 1) + lettre(i % 26));

/**
 * Une cellule : une valeur brute (texte ou nombre), ou { v, style }.
 * Un nombre non fini (NaN, Infinity) s'ecrit vide : Excel le refuserait.
 */
function cellule(valeur, ref) {
  const { v, style } = valeur !== null && typeof valeur === 'object' ? valeur : { v: valeur, style: 0 };
  const s = style ? ` s="${style}"` : '';
  if (v === null || v === undefined || v === '') return style ? `<c r="${ref}"${s}/>` : '';
  if (typeof v === 'number') {
    return Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : `<c r="${ref}"${s}/>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
}

/**
 * La feuille.
 * @param {object} feuille
 * @param {string[]} [feuille.titre]   lignes de titre, au-dessus du tableau
 * @param {string[]} feuille.entetes   en-tetes de colonnes
 * @param {Array<Array>} feuille.lignes valeurs, une liste par ligne
 * @param {number[]} [feuille.largeurs] largeur de chaque colonne, en caracteres
 */
function feuilleXml({ titre = [], entetes, lignes, largeurs = [] }) {
  const rangees = [];
  titre.forEach((t, i) => rangees.push([{ v: t, style: i === 0 ? STYLE.titre : STYLE.normal }]));
  if (titre.length) rangees.push([]);
  const ligneEntete = rangees.length + 1;
  rangees.push(entetes.map((e) => ({ v: e, style: STYLE.entete })));
  rangees.push(...lignes);

  const corps = rangees.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cellule(v, `${lettre(j)}${i + 1}`)).join('')}</row>`).join('');
  const derniere = `${lettre(entetes.length - 1)}${rangees.length}`;
  const cols = largeurs.length
    ? `<cols>${largeurs.map((l, i) => `<col min="${i + 1}" max="${i + 1}" width="${l}" customWidth="1"/>`).join('')}</cols>`
    : '';

  // Les en-tetes restent visibles au defilement, et le filtre automatique
  // permet de trier ou filtrer par direction sans rien preparer.
  const contenu = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    // A l'impression depuis Excel, le tableau tient dans la largeur de la page.
    + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
    + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${ligneEntete}" topLeftCell="A${ligneEntete + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + cols
    + `<sheetData>${corps}</sheetData>`
    + (lignes.length ? `<autoFilter ref="A${ligneEntete}:${derniere}"/>` : '')
    + '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
    + '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0" paperSize="9"/>'
    + '</worksheet>';
  return { contenu, ligneEntete };
}

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>'
  + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="14"/><name val="Calibri"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFDCEFE6"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left/><right/><top/><bottom style="thin"><color rgb="FF006E46"/></bottom><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="5">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>'
  + '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/** Archive ZIP (methode « deflate ») des fichiers fournis : { nom: Buffer|string }. */
function zip(fichiers) {
  const locaux = [];
  const central = [];
  let position = 0;
  for (const [nom, contenu] of Object.entries(fichiers)) {
    const brut = Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu, 'utf8');
    const compresse = zlib.deflateRawSync(brut);
    const crc = zlib.crc32(brut);
    const n = Buffer.from(nom, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version requise
    local.writeUInt16LE(0x0800, 6);       // noms en UTF-8
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt32LE(0, 10);           // heure et date : sans objet
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compresse.length, 18);
    local.writeUInt32LE(brut.length, 22);
    local.writeUInt16LE(n.length, 26);
    local.writeUInt16LE(0, 28);
    locaux.push(local, n, compresse);

    const entree = Buffer.alloc(46);
    entree.writeUInt32LE(0x02014b50, 0);
    entree.writeUInt16LE(20, 4);
    entree.writeUInt16LE(20, 6);
    entree.writeUInt16LE(0x0800, 8);
    entree.writeUInt16LE(8, 10);
    entree.writeUInt32LE(0, 12);
    entree.writeUInt32LE(crc, 16);
    entree.writeUInt32LE(compresse.length, 20);
    entree.writeUInt32LE(brut.length, 24);
    entree.writeUInt16LE(n.length, 28);
    entree.writeUInt32LE(position, 42);   // position de l'en-tete local
    central.push(entree, n);

    position += local.length + n.length + compresse.length;
  }
  const repertoire = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(Object.keys(fichiers).length, 8);
  fin.writeUInt16LE(Object.keys(fichiers).length, 10);
  fin.writeUInt32LE(repertoire.length, 12);
  fin.writeUInt32LE(position, 16);
  return Buffer.concat([...locaux, repertoire, fin]);
}

/**
 * Un classeur d'une feuille, pret a envoyer.
 * @param {string} nom nom de l'onglet (31 caracteres au plus, sans []:*?/\)
 * @returns {Buffer}
 */
export function ecrireClasseur(nom, feuille) {
  const onglet = String(nom).replace(/[[\]:*?/\\']/g, ' ').trim().slice(0, 31) || 'Feuille 1';
  const { contenu, ligneEntete } = feuilleXml(feuille);
  // Imprime depuis Excel, chaque page repete la ligne d'en-tetes.
  const titres = '<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'
    + `'${xml(onglet)}'!$${ligneEntete}:$${ligneEntete}</definedName></definedNames>`;
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<sheets><sheet name="${xml(onglet)}" sheetId="1" r:id="rId1"/></sheets>${titres}`
      + '</workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>',
    'xl/styles.xml': STYLES,
    'xl/worksheets/sheet1.xml': contenu,
  });
}
