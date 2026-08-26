import fs from 'node:fs';
import { Client } from 'ldapts';
import { config } from './config.js';

// Echappement RFC 4515 : empeche l'injection de filtre LDAP depuis le formulaire
const CARACTERES_FILTRE = { '\\': '\\5c', '*': '\\2a', '(': '\\28', ')': '\\29', '\0': '\\00' };
function echapperFiltre(valeur) {
  return String(valeur).replace(/[\\*()\0]/g, (c) => CARACTERES_FILTRE[c]);
}

function optionsTls() {
  if (!config.ldap.url.startsWith('ldaps://')) return undefined;
  const tls = { rejectUnauthorized: config.ldap.rejectUnauthorized };
  if (config.ldap.caFile && fs.existsSync(config.ldap.caFile)) {
    tls.ca = [fs.readFileSync(config.ldap.caFile)];
  }
  return tls;
}

function nouveauClient() {
  return new Client({
    url: config.ldap.url,
    timeout: 8000,
    connectTimeout: 8000,
    tlsOptions: optionsTls(),
  });
}

/**
 * Deduit le service depuis le DN de l'utilisateur.
 * CN=Jean Dupont,OU=Etat civil,OU=Population,OU=Agents,DC=ville,DC=local
 *   profondeur 1 -> "Etat civil"   profondeur 2 -> "Population"
 */
export function serviceDepuisDn(dn, profondeur = 1) {
  if (!dn) return null;
  const ous = [];
  // Decoupage respectant les virgules echappees dans les RDN
  for (const rdn of String(dn).split(/(?<!\\),/)) {
    const m = rdn.trim().match(/^OU=(.+)$/i);
    if (m) ous.push(m[1].replace(/\\(.)/g, '$1').trim());
  }
  if (!ous.length) return null;
  return ous[Math.min(profondeur, ous.length) - 1] || null;
}

export function normaliserService(nom) {
  if (!nom) return 'Non rattache';
  return String(nom).replace(/\s+/g, ' ').trim();
}

const ATTRIBUTS = [
  'dn', 'sAMAccountName', 'displayName', 'givenName', 'sn',
  'mail', 'department', 'physicalDeliveryOfficeName', 'memberOf', 'userAccountControl',
];

/**
 * Authentifie un agent : bind du compte de service -> recherche -> bind de verification.
 * Renvoie { ok: true, agent } ou { ok: false, motif }
 */
export async function authentifier(login, motDePasse) {
  // Un mot de passe vide provoque un "unauthenticated bind" accepte par l'AD : on refuse en amont.
  if (!login || !motDePasse) return { ok: false, motif: 'identifiants_vides' };

  const clientService = nouveauClient();
  let entree;
  try {
    await clientService.bind(config.ldap.bindDn, config.ldap.bindPassword);
    const filtre = config.ldap.userFilter.replace('{{login}}', echapperFiltre(login.trim()));
    const { searchEntries } = await clientService.search(config.ldap.baseDn, {
      scope: 'sub',
      filter: filtre,
      attributes: ATTRIBUTS,
      sizeLimit: 2,
    });
    if (searchEntries.length !== 1) {
      return { ok: false, motif: searchEntries.length ? 'compte_ambigu' : 'compte_inconnu' };
    }
    entree = searchEntries[0];
  } catch (err) {
    return { ok: false, motif: 'annuaire_indisponible', erreur: err.message };
  } finally {
    await clientService.unbind().catch(() => {});
  }

  // Compte desactive : bit 2 de userAccountControl
  const uac = Number(entree.userAccountControl || 0);
  if (uac & 2) return { ok: false, motif: 'compte_desactive' };

  // Appartenance a un groupe obligatoire
  if (config.ldap.requiredGroup) {
    const groupes = [].concat(entree.memberOf || []).map((g) => String(g).toLowerCase());
    if (!groupes.includes(config.ldap.requiredGroup.toLowerCase())) {
      return { ok: false, motif: 'hors_perimetre' };
    }
  }

  // Verification du mot de passe par bind sur le DN trouve
  const clientAgent = nouveauClient();
  try {
    await clientAgent.bind(entree.dn, motDePasse);
  } catch {
    return { ok: false, motif: 'mot_de_passe_invalide' };
  } finally {
    await clientAgent.unbind().catch(() => {});
  }

  const brut = config.service.source === 'attr'
    ? entree[config.service.attribut] || entree.physicalDeliveryOfficeName
    : serviceDepuisDn(entree.dn, config.service.ouDepth);

  const prenomNom = [entree.givenName, entree.sn].filter(Boolean).join(' ');

  return {
    ok: true,
    agent: {
      login: String(entree.sAMAccountName || login).toLowerCase(),
      nomComplet: String(entree.displayName || prenomNom || login),
      email: entree.mail ? String(entree.mail) : null,
      service: normaliserService(brut),
      serviceBrut: String(entree.dn),
    },
  };
}

/** Test de connectivite pour le back-office */
export async function testerConnexion() {
  if (config.ldap.url === 'demo') {
    return { ok: true, message: 'Mode demonstration : annuaire simule, aucun serveur LDAP interroge.' };
  }
  const client = nouveauClient();
  try {
    await client.bind(config.ldap.bindDn, config.ldap.bindPassword);
    const { searchEntries } = await client.search(config.ldap.baseDn, {
      scope: 'sub', filter: '(objectClass=user)', attributes: ['dn'], sizeLimit: 1,
    });
    return { ok: true, message: `Connexion LDAPS etablie, ${searchEntries.length} entree(s) lue(s).` };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    await client.unbind().catch(() => {});
  }
}
