/**
 * Annuaire simule pour la demonstration et la recette.
 * Active uniquement si LDAP_URL=demo. Refuse de demarrer si NODE_ENV=production,
 * pour qu'il soit impossible de mettre ce mode en service par inadvertance.
 */
import { config, modeDemoActif } from './config.js';
import { serviceDepuisDn, normaliserService } from './ldap.js';

const MOT_DE_PASSE = process.env.DEMO_MOT_DE_PASSE || 'demo2026';

const COMPTES = [
  ['c.parfait', 'Claire PARFAIT', 'Direction des systemes d information'],
  ['m.durand', 'Marc DURAND', 'Direction des systemes d information'],
  ['s.leroy', 'Sophie LEROY', 'Etat civil'],
  ['p.martin', 'Paul MARTIN', 'Etat civil'],
  ['a.bernard', 'Alice BERNARD', 'Etat civil'],
  ['j.dubois', 'Julien DUBOIS', 'Ressources humaines'],
  ['n.moreau', 'Nadia MOREAU', 'Ressources humaines'],
  ['l.petit', 'Lucas PETIT', 'Affaires scolaires'],
  ['e.roux', 'Emma ROUX', 'Affaires scolaires'],
  ['t.girard', 'Thomas GIRARD', 'Affaires scolaires'],
  ['f.lambert', 'Fatou LAMBERT', 'Services techniques'],
  ['k.fontaine', 'Karim FONTAINE', 'Services techniques'],
  ['v.chevalier', 'Valerie CHEVALIER', 'Finances'],
  ['d.robin', 'David ROBIN', 'Finances'],
  ['i.masson', 'Ines MASSON', 'Finances'],
].map(([login, nomComplet, service]) => ({
  login,
  nomComplet,
  service,
  email: `${login}@ville-chatillon.fr`,
  dn: `CN=${nomComplet},OU=${service},OU=Agents,DC=ville,DC=local`,
}));

// Jamais en production : voir modeDemoActif.
export const estModeDemo = modeDemoActif;

/**
 * Controle de demarrage. Renvoie un avertissement, ou leve une erreur.
 *
 * LDAP_URL=demo en production est une erreur de deploiement : on refuse de
 * demarrer. La meme valeur venue de la base - une recette reprise telle quelle
 * - ne bloque pas le demarrage : le compte local doit pouvoir entrer pour
 * saisir le vrai annuaire, et estModeDemo() neutralise deja les comptes fictifs.
 */
export function verifierModeDemo() {
  if (config.ldap.url !== 'demo' || config.env !== 'production') return null;
  if (String(process.env.LDAP_URL || '').trim() === 'demo') {
    throw new Error(
      'LDAP_URL=demo est incompatible avec NODE_ENV=production. ' +
      'Renseignez une URL ldaps:// reelle avant la mise en service.'
    );
  }
  return "L'adresse de l'annuaire enregistree dans le back-office vaut « demo » : en production, "
    + 'le mode demonstration reste desactive et seuls les comptes locaux peuvent se connecter. '
    + "Saisissez l'adresse du controleur de domaine dans Administration > Configuration.";
}

export async function authentifierDemo(login, motDePasse) {
  if (!estModeDemo()) return { ok: false, motif: 'annuaire_indisponible' };
  if (!login || !motDePasse) return { ok: false, motif: 'identifiants_vides' };

  const compte = COMPTES.find((c) => c.login === String(login).trim().toLowerCase());
  if (!compte) return { ok: false, motif: 'compte_inconnu' };
  if (motDePasse !== MOT_DE_PASSE) return { ok: false, motif: 'mot_de_passe_invalide' };

  // On passe volontairement par la meme extraction que l'annuaire reel,
  // pour que le mode demo teste bien le code de production.
  const service = config.service.source === 'ou'
    ? serviceDepuisDn(compte.dn, config.service.ouDepth)
    : compte.service;

  return {
    ok: true,
    agent: {
      login: compte.login,
      nomComplet: compte.nomComplet,
      email: compte.email,
      service: normaliserService(service),
      serviceBrut: compte.dn,
    },
  };
}

export const comptesDemo = () => COMPTES.map((c) => ({ login: c.login, nom: c.nomComplet, service: c.service }));
export const motDePasseDemo = () => MOT_DE_PASSE;
