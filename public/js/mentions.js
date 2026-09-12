import { contactsPublics, anneeDeCampagne } from '/js/commun.js';

/**
 * Valeurs de configuration dans les mentions légales.
 *
 * L'adresse de la déléguée à la protection des données, l'année de campagne et
 * la durée de vie du cookie de session viennent toutes du serveur : écrites en
 * dur, elles finissaient par démentir ce que l'application applique réellement
 * — et une mention légale fausse n'est pas un détail de présentation.
 *
 * Ce code vivait dans un <script> en ligne, où la politique de sécurité de
 * contenu — « script-src 'self' » — l'empêchait de s'exécuter : la page
 * affichait donc les points de suspension du gabarit, et l'adresse enregistrée
 * n'apparaissait jamais. Un fichier servi par le site passe, une balise en
 * ligne non ; c'est tout l'objet de cette règle.
 */

const reglages = await contactsPublics();

/* ---------------------------------------------------- Déléguée aux données */

const lien = document.getElementById('contact-dpo');
if (lien) {
  if (reglages.dpo) {
    lien.href = `mailto:${reglages.dpo}`;
    lien.textContent = reglages.dpo;
  } else {
    lien.replaceWith(document.createTextNode('adresse disponible auprès de la DSI'));
  }
}

/* ------------------------------------------------------ Année de campagne */

const annee = anneeDeCampagne(reglages.campagne);
const marque = document.getElementById('marque-campagne');
if (marque) marque.textContent = `Cybermois ${annee}`;
const pied = document.getElementById('pied-campagne');
if (pied) {
  pied.textContent =
    `Cybermois ${annee} — Ville de Châtillon, Direction des systèmes d'information.`;
}

/* --------------------------------------------------- Durée de la session */

const duree = document.getElementById('duree-session');
const heures = Number(reglages.dureeSessionHeures);
if (duree && Number.isFinite(heures) && heures > 0) {
  duree.textContent = `${heures} heure${heures > 1 ? 's' : ''}`;
}
