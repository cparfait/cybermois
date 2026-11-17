import { classementServices, classementAgents } from './scoring.js';
import { aujourdhui } from './dates.js';
import { ecrireClasseur, STYLE } from './tableur.js';

/**
 * Le classement en classeur Excel, limite aux N premiers.
 *
 * Les colonnes sont celles de la page Classement : ce qu'on imprime pour
 * l'afficher dans un couloir ou le joindre a un compte rendu doit se lire
 * comme ce que chacun voit a l'ecran. Les noms suivent les memes regles - un
 * agent qui a demande l'anonymat reste « Agent anonyme ».
 */

export const CLASSEMENTS = {
  services: { onglet: 'Directions', titre: 'Classement par direction', unite: ['direction', 'directions'] },
  agents: { onglet: 'Agents', titre: 'Classement individuel', unite: ['agent', 'agents'] },
};

/**
 * Lit le nombre de lignes demande : un entier positif, ou rien / « tous »
 * pour l'ensemble. Renvoie null si la valeur n'a pas de sens.
 */
export function lireNombre(valeur) {
  if (valeur === undefined || valeur === null || valeur === '' || valeur === 'tous') return Infinity;
  const n = Number(valeur);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

const dateFr = (iso) => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
  .format(new Date(`${iso}T12:00:00`));

const pourcent = (n) => ({ v: (Number(n) || 0) / 100, style: STYLE.pourcentage });

/** { nom de fichier, contenu } pour le classement demande. */
export function classeurClassement(classement, nombre = Infinity) {
  const def = CLASSEMENTS[classement];
  if (!def) throw new Error(`Classement inconnu : ${classement}`);

  const tous = classement === 'services' ? classementServices() : classementAgents(100000);
  const retenus = tous.slice(0, nombre);
  const jour = aujourdhui();
  const portee = retenus.length < tous.length
    ? `${retenus.length} premier${retenus.length > 1 ? 's' : ''} sur ${tous.length} ${def.unite[1]}`
    : `${tous.length} ${def.unite[tous.length > 1 ? 1 : 0]}`;

  const feuille = classement === 'services'
    ? {
      entetes: ['Rang', 'Direction', 'Défis terminés par agent', 'Défis parus', 'Réussite',
        'Points', 'Points possibles', 'Participation', 'Agents ayant joué', 'Agents inscrits'],
      largeurs: [7, 42, 14, 11, 11, 10, 10, 13, 12, 12],
      lignes: retenus.map((s, i) => [
        i + 1, s.service, { v: s.defis_par_agent, style: STYLE.decimal }, s.defis_parus,
        pourcent(s.pourcentage_moyen), s.score_total, s.score_max_joue,
        pourcent(s.taux_participation), s.joueurs, s.inscrits,
      ]),
    }
    : {
      entetes: ['Rang', 'Agent', 'Direction', 'Points', 'Défis terminés', 'Défis parus', 'Réussite'],
      largeurs: [7, 32, 42, 10, 12, 11, 11],
      lignes: retenus.map((a, i) => [
        i + 1, a.nom_complet, a.service, a.score_total, a.defis_joues, a.defis_parus, pourcent(a.pourcentage),
      ]),
    };

  feuille.titre = [`Cybermois — ${def.titre}`, `${portee} — édité le ${dateFr(jour)}`];

  const suffixe = Number.isFinite(nombre) && retenus.length < tous.length ? `-top${retenus.length}` : '';
  return {
    nomFichier: `cybermois-classement-${def.onglet.toLowerCase()}${suffixe}-${jour}.xlsx`,
    contenu: ecrireClasseur(def.onglet, feuille),
    lignes: retenus.length,
  };
}
