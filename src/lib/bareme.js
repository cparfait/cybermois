/**
 * Bareme d'un defi : dix questions, cent points, toujours.
 *
 * La table des niveaux et les fonctions qui l'exploitent vivent dans
 * public/js/bareme.js, parce que l'editeur du back-office en a besoin dans le
 * navigateur autant que le serveur en a besoin ici. Deux copies auraient
 * derive : l'ecran aurait propose des points que le serveur aurait refuses.
 *
 * Ce module n'est donc qu'une porte d'entree, pour que le code serveur
 * continue d'ecrire `from './bareme.js'`.
 */
export {
  NIVEAUX, QUESTIONS_PAR_DEFI, TOTAL_DEFI,
  niveauDe, pointsDe, libelleNiveau, verifierBareme, resumeBareme,
} from '../../public/js/bareme.js';
