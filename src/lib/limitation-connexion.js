import { config } from './config.js';

/**
 * Limitation des echecs de connexion, par compte ET par adresse IP.
 *
 * La limitation par requetes (@fastify/rate-limit, sur la route) n'etait
 * indexee que sur le compte. Deux consequences :
 *
 * - depuis une meme adresse, on pouvait essayer un mot de passe courant sur
 *   chacun des cinq cents comptes sans jamais etre freine ;
 * - huit essais par compte toutes les cinq minutes depassent le seuil de
 *   verrouillage de l'Active Directory : n'importe qui pouvait verrouiller la
 *   session Windows d'un agent en tapant son identifiant dans le portail.
 *
 * On compte donc ici les ECHECS, pas les requetes : derriere un proxy, les
 * connexions reussies du matin ne penalisent personne. Par compte, le blocage
 * intervient avant d'interroger l'annuaire, sous le seuil de l'AD. Par IP, il
 * coupe la pulverisation d'un mot de passe sur tous les comptes.
 *
 * L'etat vit en memoire : le portail tourne en un seul conteneur, et un
 * redemarrage qui remet les compteurs a zero ne rend que quelques essais.
 */

export const FENETRE_COMPTE_MS = 30 * 60 * 1000;
export const FENETRE_IP_MS = 15 * 60 * 1000;

// Au-dela, les plus anciennes entrees sont oubliees : la memoire reste bornee
// meme si un attaquant invente des identifiants a la chaine.
const ENTREES_MAX = 50000;

const parCompte = new Map();
const parIp = new Map();

const cleCompte = (login) => String(login || '').trim().toLowerCase();

function recents(table, cle, fenetre, maintenant) {
  const liste = table.get(cle);
  if (!liste) return [];
  const gardes = liste.filter((t) => maintenant - t < fenetre);
  if (gardes.length) table.set(cle, gardes);
  else table.delete(cle);
  return gardes;
}

function noter(table, cle, maintenant) {
  if (!cle) return;
  const liste = table.get(cle) || [];
  liste.push(maintenant);
  // Supprimer puis reinserer place la cle en fin d'ordre d'insertion : la
  // premiere cle de la table est ainsi toujours la moins recemment touchee.
  table.delete(cle);
  table.set(cle, liste);
  while (table.size > ENTREES_MAX) table.delete(table.keys().next().value);
}

/** Secondes d'attente restantes, 0 si rien ne bloque. */
function attente(table, cle, max, fenetre, maintenant) {
  if (!cle) return 0;
  const liste = recents(table, cle, fenetre, maintenant);
  if (liste.length < max) return 0;
  // Debloque quand assez d'echecs sont sortis de la fenetre pour repasser sous le seuil
  const liberateur = liste[liste.length - max];
  return Math.max(1, Math.ceil((liberateur + fenetre - maintenant) / 1000));
}

export function attenteCompte(login, maintenant = Date.now()) {
  return attente(parCompte, cleCompte(login), config.connexion.echecsMaxCompte, FENETRE_COMPTE_MS, maintenant);
}

export function attenteIp(ip, maintenant = Date.now()) {
  return attente(parIp, String(ip || ''), config.connexion.echecsMaxIp, FENETRE_IP_MS, maintenant);
}

/** Un mot de passe refuse par l'annuaire : le compte s'approche du verrouillage AD. */
export function noterEchecCompte(login, maintenant = Date.now()) {
  noter(parCompte, cleCompte(login), maintenant);
}

/** Tout echec d'identification, compte connu ou non. */
export function noterEchecIp(ip, maintenant = Date.now()) {
  noter(parIp, String(ip || ''), maintenant);
}

/** Connexion reussie : les fautes de frappe precedentes ne comptent plus. */
export function oublierCompte(login) {
  parCompte.delete(cleCompte(login));
}

/** Pour les tests. */
export function reinitialiserLimitation() {
  parCompte.clear();
  parIp.clear();
}

// Purge periodique : un compte essaye une fois ne doit pas rester en memoire.
setInterval(() => {
  const maintenant = Date.now();
  for (const cle of [...parCompte.keys()]) recents(parCompte, cle, FENETRE_COMPTE_MS, maintenant);
  for (const cle of [...parIp.keys()]) recents(parIp, cle, FENETRE_IP_MS, maintenant);
}, 5 * 60 * 1000).unref();
