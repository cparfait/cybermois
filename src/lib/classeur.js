import zlib from 'node:zlib';

/**
 * Les lignes d'un classeur Excel (.xlsx), sans bibliotheque.
 *
 * Un .xlsx est une archive ZIP de fichiers XML : les textes vivent dans
 * xl/sharedStrings.xml, la grille dans xl/worksheets/sheet1.xml. On lit le
 * repertoire central de l'archive, on decompresse ces deux fichiers, et l'on
 * rend la premiere feuille sous forme de CSV - que l'import lit ensuite
 * comme n'importe quel export. Lu comme du texte, un fichier compresse ne
 * contenait aucune adresse.
 */

/** Vrai si le contenu commence comme une archive ZIP (« PK »). */
export const estArchiveZip = (octets) => octets.length > 4 && octets[0] === 0x50 && octets[1] === 0x4b;

/** Les fichiers d'une archive ZIP : { nom: Buffer }, pour ceux que `garder` retient. */
function extraireZip(octets, garder) {
  // Fin du repertoire central : signature 0x06054b50, dans les derniers 64 Ko.
  let fin = -1;
  for (let i = octets.length - 22; i >= Math.max(0, octets.length - 65557); i--) {
    if (octets.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  }
  if (fin < 0) throw new Error('Archive illisible : ce fichier n’est pas un classeur Excel valide.');

  const nombre = octets.readUInt16LE(fin + 10);
  let position = octets.readUInt32LE(fin + 16);
  const fichiers = {};
  for (let n = 0; n < nombre; n++) {
    if (octets.readUInt32LE(position) !== 0x02014b50) break;
    const methode = octets.readUInt16LE(position + 10);
    const tailleCompressee = octets.readUInt32LE(position + 20);
    const longueurNom = octets.readUInt16LE(position + 28);
    const longueurExtra = octets.readUInt16LE(position + 30);
    const longueurCommentaire = octets.readUInt16LE(position + 32);
    const enTeteLocal = octets.readUInt32LE(position + 42);
    const nom = octets.toString('utf8', position + 46, position + 46 + longueurNom);
    position += 46 + longueurNom + longueurExtra + longueurCommentaire;
    if (!garder(nom)) continue;

    // L'en-tete local a sa propre longueur de nom et d'extra.
    const debut = enTeteLocal + 30 + octets.readUInt16LE(enTeteLocal + 26) + octets.readUInt16LE(enTeteLocal + 28);
    const donnees = octets.subarray(debut, debut + tailleCompressee);
    if (methode === 0) fichiers[nom] = donnees;
    else if (methode === 8) fichiers[nom] = zlib.inflateRawSync(donnees);
  }
  return fichiers;
}

const entites = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decoder = (xml) => xml.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => entites[e])
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

/** Le texte d'un element XML, balises de mise en forme comprises (<r><t>…</t></r>). */
const texteDe = (xml) => decoder([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

/** « D » -> 3 : le rang de la colonne d'une reference de cellule. */
const colonneDe = (ref) => [...String(ref).replace(/\d+/g, '')]
  .reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

/** La premiere feuille du classeur, en CSV (virgules, valeurs entre guillemets). */
export function csvDuClasseur(octets) {
  const fichiers = extraireZip(octets, (nom) => nom === 'xl/sharedStrings.xml'
    || /^xl\/worksheets\/sheet\d+\.xml$/.test(nom));
  const feuille = Object.keys(fichiers).filter((n) => n.startsWith('xl/worksheets/'))
    .sort((a, b) => Number(a.match(/\d+/g).pop()) - Number(b.match(/\d+/g).pop()))[0];
  if (!feuille) throw new Error('Aucune feuille trouvée dans ce classeur.');

  const partages = fichiers['xl/sharedStrings.xml']
    ? [...fichiers['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texteDe(m[1]))
    : [];

  const lignes = [];
  for (const [, ligne] of fichiers[feuille].toString('utf8').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const valeurs = [];
    for (const [, attributs, contenu = ''] of ligne.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+\d+)"/.exec(attributs)?.[1];
      const type = /\bt="(\w+)"/.exec(attributs)?.[1];
      const brut = /<v>([\s\S]*?)<\/v>/.exec(contenu)?.[1];
      let valeur = '';
      if (type === 's') valeur = partages[Number(brut)] ?? '';
      else if (type === 'inlineStr') valeur = texteDe(contenu);
      else if (brut !== undefined) valeur = decoder(brut);
      valeurs[ref ? colonneDe(ref) : valeurs.length] = valeur;
    }
    lignes.push(Array.from(valeurs, (v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  }
  return lignes.join('\n');
}
