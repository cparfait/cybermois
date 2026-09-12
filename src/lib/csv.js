/**
 * Generation de CSV pour les exports du back-office.
 *
 * L'echappement ne se limite pas aux guillemets et aux separateurs.
 *
 * Un tableur traite toute cellule commencant par « = », « + », « - » ou « @ »
 * comme une FORMULE, et non comme du texte. Or ces exports contiennent des
 * valeurs que l'application n'a pas choisies : le nom d'un agent lu dans
 * l'annuaire, une direction saisie a l'import, et surtout - dans l'export du
 * journal - l'identifiant tape sur la page de connexion, qui n'exige aucune
 * authentification. N'importe qui pouvait donc deposer
 * « =HYPERLINK("http://…") » dans le journal et attendre qu'un administrateur
 * ouvre l'export dans Excel.
 *
 * La parade retenue est celle de l'OWASP : prefixer la cellule d'une
 * apostrophe, que le tableur consomme en la lisant comme du texte. Le contenu
 * reste lisible, et aucune formule ne s'evalue.
 */

// Caracteres qui, en tete de cellule, declenchent l'interpretation en formule.
// La tabulation et le retour chariot y figurent : ils sont ignores a la lecture
// et laissent le caractere suivant en premiere position.
const DEBUTS_DANGEREUX = /^[=+\-@\t\r]/;

/** Neutralise une cellule susceptible d'etre lue comme une formule. */
export function neutraliserFormule(valeur) {
  const s = valeur === null || valeur === undefined ? '' : String(valeur);
  return DEBUTS_DANGEREUX.test(s) ? `'${s}` : s;
}

/** Echappe une cellule : neutralisation de formule, puis guillemets si besoin. */
export function cellule(valeur) {
  const s = neutraliserFormule(valeur);
  return /["；;,\n\r\t]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Construit un CSV complet.
 * Le BOM en tete fait ouvrir le fichier en UTF-8 par Excel sous Windows, sans
 * quoi les accents des noms d'agents arrivent illisibles.
 */
export function csv(lignes, entetes) {
  const corps = lignes.map((l) => entetes.map((e) => cellule(l[e])).join(';'));
  return '﻿' + [entetes.map(cellule).join(';'), ...corps].join('\r\n');
}
