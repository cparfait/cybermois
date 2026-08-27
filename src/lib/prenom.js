/**
 * Le prenom d'usage, pour s'adresser a l'agent.
 *
 * « Bonjour DUPONT » est un debut de courrier administratif, pas un accueil.
 * On prenait jusqu'ici le premier mot du nom complet, ce qui marche quand
 * l'annuaire ecrit « Prenom NOM » et se retourne exactement quand il ecrit
 * « NOM Prenom » - la convention la plus repandue dans les annuaires de
 * collectivite, et celle de la Ville.
 *
 * L'attribut givenName de l'annuaire tranche la question sans deviner : c'est
 * lui qu'on utilise des qu'il est renseigne. Le reste n'est qu'un filet de
 * securite pour les fiches importees d'un fichier, ou creees a la main.
 */

/**
 * Un mot ecrit tout en majuscules est un nom de famille.
 *
 * On ne se fie pas a la position : « MARTIN Claire » et « Claire MARTIN »
 * doivent donner le meme resultat. Les particules (de, du, van) restent avec
 * le nom, et un mot d'une seule lettre - une initiale - ne compte pas.
 */
const enMajuscules = (mot) => {
  const lettres = mot.replace(/[^\p{L}]/gu, '');
  return lettres.length > 1 && lettres === lettres.toLocaleUpperCase('fr');
};

export function prenomUsuel(nomComplet, prenom) {
  const donne = String(prenom ?? '').trim();
  if (donne) return donne.split(/\s+/)[0];

  const mots = String(nomComplet ?? '').trim().split(/\s+/).filter(Boolean);
  if (!mots.length) return '';

  // Ce qui n'est pas en majuscules est, par elimination, le prenom.
  const restants = mots.filter((m) => !enMajuscules(m));

  // Aucune casse distinctive - « claire martin », ou « CLAIRE MARTIN » : on
  // retombe sur la convention « Prenom Nom », faute de mieux. C'est le cas ou
  // l'annuaire ne dit rien, et ou deviner juste est impossible.
  return (restants.length ? restants[0] : mots[0]);
}
