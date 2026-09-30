import { SERVICE_NON_RATTACHE } from './db.js';
import fs from 'node:fs';
import { Client } from 'ldapts';
import { config } from './config.js';

// Echappement RFC 4515 : empeche l'injection de filtre LDAP depuis le formulaire
const CARACTERES_FILTRE = { '\\': '\\5c', '*': '\\2a', '(': '\\28', ')': '\\29', '\0': '\\00' };
function echapperFiltre(valeur) {
  return String(valeur).replace(/[\\*()\0]/g, (c) => CARACTERES_FILTRE[c]);
}

/**
 * Filtre de recherche d'un compte a partir de la saisie de l'agent.
 *
 * replaceAll, et pas replace : le filtre porte le marqueur une fois par
 * attribut accepte - sAMAccountName, userPrincipalName, mail - et n'en
 * substituer qu'un laissait les autres a l'etat de texte litteral. Se
 * connecter avec son adresse echouait alors sans autre explication qu'un
 * compte introuvable.
 *
 * La forme fonction en second argument evite en prime qu'un $ dans la
 * saisie soit interprete comme un motif de remplacement.
 */
export function construireFiltre(modele, login) {
  const saisie = echapperFiltre(String(login ?? '').trim());
  return String(modele ?? '').replaceAll('{{login}}', () => saisie);
}

function optionsTls() {
  if (!config.ldap.url.startsWith('ldaps://')) return undefined;
  const tls = { rejectUnauthorized: config.ldap.rejectUnauthorized };

  // Deux facons de fournir l'autorite de certification interne.
  // Le base64 est prioritaire : il se colle dans une variable d'environnement,
  // ce qui evite de monter un fichier - impraticable via Portainer.
  if (config.ldap.caBase64) {
    try {
      tls.ca = [Buffer.from(config.ldap.caBase64.replace(/\s+/g, ''), 'base64')];
    } catch {
      throw new Error('LDAP_CA_BASE64 illisible : verifiez le collage de la valeur.');
    }
  } else if (config.ldap.caFile && fs.existsSync(config.ldap.caFile)) {
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

/**
 * L'appartenance a un groupe se verifie sur les DN presents dans memberOf.
 * La valeur configuree est acceptee sous deux formes, parce que les deux
 * circulent en pratique :
 *   - le nom court du groupe      : GG-Cybermois-Admins
 *   - le DN complet               : CN=GG-Cybermois-Admins,OU=Groupes,DC=chatillon,DC=lan
 */
export function appartientAuGroupe(groupesDn, attendu) {
  const cible = String(attendu || '').trim().toLowerCase();
  if (!cible) return true;

  for (const dn of groupesDn) {
    const complet = String(dn).trim().toLowerCase();
    if (complet === cible) return true;
    // Nom court : on compare au premier RDN, en tenant compte des virgules echappees
    const cn = complet.split(/(?<!\\),/)[0].replace(/^cn=/, '').replace(/\\(.)/g, '$1').trim();
    if (cn === cible) return true;
  }
  return false;
}

export function normaliserService(nom) {
  if (!nom) return SERVICE_NON_RATTACHE;
  return String(nom).replace(/\s+/g, ' ').trim();
}

// Un attribut LDAP peut revenir en tableau des qu'il est multivalue : le
// prendre tel quel donnait un service nomme « Finances,Budget ».
const premiereValeur = (v) => (Array.isArray(v) ? v[0] : v);

/**
 * Service d'un compte, lu dans l'annuaire.
 *
 * Deux sources coexistent : l'attribut (« department », en general) et l'OU du
 * DN. La configuration dit laquelle fait foi, mais l'autre sert de repli -
 * c'est tout l'objet de cette fonction.
 *
 * Un annuaire de collectivite n'est jamais renseigne a 100 % : des centaines de
 * fiches ont un « department » vide alors que leur DN dit exactement dans quel
 * service elles sont. S'en tenir a la source configuree faisait basculer tous
 * ces agents dans « Non rattache », ou ils ne comptent plus pour personne.
 *
 * Renvoie null quand l'annuaire ne dit vraiment rien : cette absence doit
 * pouvoir se distinguer d'un service reellement nomme « Non rattache », faute
 * de quoi elle ecrase les rattachements deja connus.
 */
export function serviceDepuisAnnuaire(entree) {
  const attribut = premiereValeur(entree[config.service.attribut])
    || premiereValeur(entree.physicalDeliveryOfficeName);
  const ou = serviceDepuisDn(entree.dn, config.service.ouDepth);
  const brut = config.service.source === 'attr' ? (attribut || ou) : (ou || attribut);
  return brut ? normaliserService(brut) : null;
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

  // Le controle du chiffrement vaut au moment de l'usage, et pas seulement au
  // demarrage : l'URL de l'annuaire se saisit depuis la page de configuration,
  // et une liaison en clair y prendrait effet immediatement.
  if (config.env === 'production' && config.ldap.url.startsWith('ldap://')
      && !config.ldap.autoriserNonChiffre) {
    return { ok: false, motif: 'liaison_non_chiffree' };
  }

  const clientService = nouveauClient();
  let entree;
  try {
    await clientService.bind(config.ldap.bindDn, config.ldap.bindPassword);
    const filtre = construireFiltre(config.ldap.userFilter, login);
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

  const groupes = [].concat(entree.memberOf || []).map(String);

  // Appartenance a un groupe obligatoire
  if (config.ldap.requiredGroup && !appartientAuGroupe(groupes, config.ldap.requiredGroup)) {
    return { ok: false, motif: 'hors_perimetre' };
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

  const prenomNom = [entree.givenName, entree.sn].filter(Boolean).join(' ');

  return {
    ok: true,
    agent: {
      login: String(entree.sAMAccountName || login).toLowerCase(),
      nomComplet: String(entree.displayName || prenomNom || login),
      // Renvoye a part du nom complet : l'accueil s'adresse a l'agent par
      // son prenom, et displayName ne dit pas ou il commence.
      prenom: entree.givenName ? String(entree.givenName) : null,
      email: entree.mail ? String(entree.mail) : null,
      // null quand l'annuaire ne dit rien : l'appelant garde alors le service
      // deja connu plutot que de rattacher l'agent a « Non rattache ».
      service: serviceDepuisAnnuaire(entree),
      serviceBrut: String(entree.dn),
      groupes,
      // Administrateur par appartenance a un groupe dedie, en complement de
      // la liste d'identifiants : c'est plus simple a maintenir dans le temps.
      adminParGroupe: config.ldap.adminGroup
        ? appartientAuGroupe(groupes, config.ldap.adminGroup)
        : false,
    },
  };
}

/**
 * Garde-fou au demarrage.
 * En ldap:// simple, le mot de passe de l'agent transite en clair sur le reseau.
 * C'est acceptable le temps d'une mise au point locale, jamais en production :
 * on exige alors une autorisation explicite pour eviter la mise en service
 * par inadvertance d'une configuration de test.
 */
export function annuaireConfigure() {
  return !!(config.ldap.bindDn && config.ldap.baseDn);
}

export function verifierChiffrement() {
  if (config.ldap.url === 'demo' || config.ldap.url.startsWith('ldaps://')) return null;

  // Une instance qui vient d'etre deployee n'a pas encore d'annuaire : personne
  // ne peut s'authentifier dans cet etat, seul le compte local ouvre la porte.
  if (!annuaireConfigure()) {
    return 'Annuaire non configure : connectez-vous avec le compte local, '
      + 'puis Administration > Configuration.';
  }

  // On avertit, on ne fait plus echouer le demarrage. L'URL se saisit depuis la
  // page de configuration : une faute de frappe y rendait l'application
  // inaccessible, donc impossible a corriger - il fallait passer par une
  // variable d'environnement pour rouvrir la porte.
  //
  // La protection n'est pas perdue pour autant : authentifier() refuse toute
  // connexion d'agent tant que la liaison n'est pas chiffree. Le controle est
  // au bon endroit, celui ou le mot de passe circulerait.
  if (config.env === 'production' && !config.ldap.autoriserNonChiffre) {
    return `LDAP_URL=${config.ldap.url} n'est pas chiffre : les connexions des agents sont `
      + 'REFUSEES tant que la liaison reste en clair. Passez en ldaps:// (port 636) dans '
      + 'Administration > Configuration. Le compte local reste utilisable pour le faire.';
  }

  return 'Liaison LDAP NON CHIFFREE : les mots de passe transitent en clair. '
    + 'Acceptable en recette, a corriger avant ouverture.';
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
    const chiffre = config.ldap.url.startsWith('ldaps://');
    return {
      ok: true,
      chiffre,
      message: `Connexion ${chiffre ? 'LDAPS chiffree' : 'LDAP NON CHIFFREE'} etablie, `
        + `${searchEntries.length} entree(s) lue(s).`
        + (chiffre ? '' : ' Les mots de passe transitent en clair : a corriger avant ouverture.'),
    };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    await client.unbind().catch(() => {});
  }
}

/**
 * Liste tous les comptes utilisateurs de l'annuaire, pour la synchronisation.
 *
 * Les comptes desactives sont renvoyes eux aussi, avec leur etat : c'est ce qui
 * permet d'ecarter de la campagne un agent parti, plutot que de le laisser
 * compter indefiniment dans l'effectif de reference.
 */
export async function listerAgentsAnnuaire({ limite = 20000 } = {}) {
  if (config.ldap.url === 'demo') {
    const { comptesDemo } = await import('./annuaire-demo.js');
    return {
      ok: true,
      agents: comptesDemo().map((c) => ({
        login: c.login,
        nomComplet: c.nom,
        email: `${c.login}@ville-chatillon.fr`,
        serviceAd: c.service,
        dn: `CN=${c.nom},OU=${c.service},OU=Agents,DC=ville,DC=local`,
        actif: true,
        groupes: c.groupes,
      })),
    };
  }

  const client = nouveauClient();
  try {
    await client.bind(config.ldap.bindDn, config.ldap.bindPassword);
    const { searchEntries } = await client.search(config.ldap.baseDn, {
      scope: 'sub',
      filter: '(&(objectClass=user)(objectCategory=person))',
      attributes: ATTRIBUTS,
      sizeLimit: limite,
      paged: { pageSize: 500 },
    });

    const agents = searchEntries.map((e) => {
      const prenomNom = [e.givenName, e.sn].filter(Boolean).join(' ');

      return {
        login: String(e.sAMAccountName || '').toLowerCase(),
        nomComplet: String(e.displayName || prenomNom || e.sAMAccountName || ''),
        prenom: e.givenName ? String(e.givenName) : null,
        email: e.mail ? String(e.mail).toLowerCase() : null,
        serviceAd: serviceDepuisAnnuaire(e),
        dn: String(e.dn),
        // bit 2 de userAccountControl : compte desactive
        actif: !(Number(e.userAccountControl || 0) & 2),
        groupes: [].concat(e.memberOf || []).map(String),
      };
    }).filter((a) => a.login);

    return { ok: true, agents };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    await client.unbind().catch(() => {});
  }
}
