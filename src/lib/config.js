import fs from 'node:fs';
import path from 'node:path';

// Chargement d'un .env sans dependance externe
const envPath = process.env.ENV_FILE || path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const ligne of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = ligne.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let valeur = m[2].trim();
    if (/^".*"$/.test(valeur) || /^'.*'$/.test(valeur)) valeur = valeur.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = valeur;
  }
}

const bool = (v, defaut = false) => (v === undefined || v === '' ? defaut : /^(true|1|oui|yes)$/i.test(v));
const num = (v, defaut) => (v === undefined || v === '' ? defaut : Number(v));
const liste = (v) => (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * Valeur de repli du secret de session.
 *
 * Elle n'existe que pour qu'un poste de developpement demarre sans ceremonie.
 * En production, le serveur REFUSE de demarrer tant qu'elle n'a pas ete
 * remplacee : cette cle signe les cookies de session ET derive la cle qui
 * chiffre les mots de passe du compte de service Active Directory et du relais
 * SMTP. La laisser en place reviendrait a publier ces deux mots de passe avec
 * la premiere sauvegarde de la base.
 */
export const SECRET_DEFAUT = 'secret-de-developpement-a-remplacer-absolument';

/** Longueur minimale exigee en production. */
export const SECRET_LONGUEUR_MIN = 32;

export const config = {
  port: num(process.env.PORT, 3000),
  env: process.env.NODE_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET || SECRET_DEFAUT,
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',

  /**
   * Reverse proxy autorise a renseigner X-Forwarded-For et X-Forwarded-Proto.
   *
   * Avant, ces en-tetes etaient acceptes de n'importe qui : il suffisait
   * d'atteindre le conteneur sans passer par le proxy pour se choisir une
   * adresse IP, donc pour contourner la limitation de tentatives indexee sur
   * l'IP et pour falsifier la trace laissee dans le journal.
   *
   * Vide = aucune confiance, l'adresse vue est celle de la connexion. Sinon,
   * une liste d'adresses ou de reseaux CIDR separes par des virgules.
   */
  proxyDeConfiance: (process.env.PROXY_DE_CONFIANCE || '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  /**
   * Echecs de connexion toleres avant blocage. Voir src/lib/limitation-connexion.js.
   * Par compte : rester SOUS le seuil de verrouillage de l'Active Directory,
   * sans quoi un tiers verrouille la session Windows d'un agent depuis le
   * portail. Par adresse IP : freiner l'essai d'un meme mot de passe sur tous
   * les comptes.
   */
  connexion: {
    echecsMaxCompte: num(process.env.CONNEXION_ECHECS_MAX_COMPTE, 3),
    echecsMaxIp: num(process.env.CONNEXION_ECHECS_MAX_IP, 20),
  },

  /** Durees de conservation, en jours. Voir src/lib/retention.js. */
  retention: {
    journalJours: num(process.env.RETENTION_JOURNAL_JOURS, 180),
    resultatsJours: num(process.env.RETENTION_RESULTATS_JOURS, 456),
    preuvesJours: num(process.env.RETENTION_PREUVES_JOURS, 1095),
  },

  ldap: {
    url: process.env.LDAP_URL || 'ldap://localhost:389',
    bindDn: process.env.LDAP_BIND_DN || '',
    bindPassword: process.env.LDAP_BIND_PASSWORD || '',
    baseDn: process.env.LDAP_BASE_DN || '',
    // Identifiant OU adresse : les agents saisissent l'un pour l'autre, et un
    // refus a ce moment-la se solde par un appel a la DSI, pas par une
    // seconde tentative.
    userFilter: process.env.LDAP_USER_FILTER || '(&(objectClass=user)(objectCategory=person)(|(sAMAccountName={{login}})(userPrincipalName={{login}})(mail={{login}})))',
    requiredGroup: process.env.LDAP_REQUIRED_GROUP || '',
    adminGroup: process.env.LDAP_ADMIN_GROUP || '',
    caFile: process.env.LDAP_CA_FILE || '',
    caBase64: process.env.LDAP_CA_BASE64 || '',
    rejectUnauthorized: bool(process.env.LDAP_TLS_REJECT_UNAUTHORIZED, true),
    autoriserNonChiffre: bool(process.env.LDAP_AUTORISER_NON_CHIFFRE, false),
  },

  service: {
    source: process.env.SERVICE_SOURCE || 'ou',
    attribut: process.env.SERVICE_ATTRIBUTE || 'department',
    ouDepth: num(process.env.SERVICE_OU_DEPTH, 1),
  },

  // Adresse de la deleguee a la protection des donnees, citee dans les
  // mentions legales. Elle change de personne plus souvent que le code.
  contactDpo: process.env.CONTACT_DPO || 'dpo@chatillon92.fr',

  // Colonnes sur la page des defis. Quatre cartes sur une ligne se lisent mal ;
  // deux les presentent par paires, ce qui epouse le rythme d'une campagne de
  // quatre semaines.
  defisParLigne: num(process.env.DEFIS_PAR_LIGNE, 2),

  // Les defis a venir figurent sur la page des defis, sous forme de carte
  // fermee. Se regle dans le programme de la campagne.
  afficherDefisAVenir: bool(process.env.AFFICHER_DEFIS_A_VENIR, true),

  // Hebergeurs autorises a fournir une video d'introduction. La liste alimente
  // la politique de securite de contenu : un domaine absent d'ici verra son
  // lecteur bloque par le navigateur. Elle se modifie dans l'administration -
  // ajouter une plateforme ne doit pas demander un redeploiement.
  videoDomaines: liste(process.env.VIDEO_DOMAINES)
    .filter(Boolean)
    .concat(process.env.VIDEO_DOMAINES ? [] : [
      'www.youtube-nocookie.com',
      'www.dailymotion.com',
      'geo.dailymotion.com',
    ]),

  adminLogins: liste(process.env.ADMIN_LOGINS),

  sync: {
    // Un agent sans adresse ne recoit ni lancement ni relance : il ne jouera
    // jamais, tout en pesant sur le taux de participation de son service.
    exigerEmail: bool(process.env.SYNC_EXIGER_EMAIL, true),
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 25),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.SMTP_FROM || 'Cybermois <cybermois@localhost>',
    groupeDiffusion: process.env.MAIL_GROUPE_DIFFUSION || '',
    copie: process.env.MAIL_COPIE || '',
    actif: bool(process.env.MAIL_ENVOI_ACTIF, false),
    // Microsoft 365 n'accepte que 30 messages par minute d'un meme compte :
    // 25 laisse une marge. 0 = sans limite, pour un relais interne.
    parMinute: num(process.env.SMTP_PAR_MINUTE, 25),
  },

  // Chaque mail automatique s'active ou se coupe seul, sous l'interrupteur
  // general smtp.actif. Couper un envoi automatique n'empeche pas de le faire
  // a la main depuis l'onglet Mails.
  mails: {
    ouverture: bool(process.env.MAIL_AUTO_OUVERTURE, true),
    annonce: bool(process.env.MAIL_AUTO_ANNONCE, true),
    relance: bool(process.env.MAIL_AUTO_RELANCE, true),
    resultats: bool(process.env.MAIL_AUTO_RESULTATS, true),
  },

  cron: {
    timezone: process.env.TIMEZONE || 'Europe/Paris',
    // Passages de la tache d'ouverture. Le mail ne part que le jour du premier
    // defi, et une seule fois : les passages suivants rattrapent un serveur
    // arrete a 8 h ce jour-la.
    ouverture: process.env.CRON_OUVERTURE || '0 8-17 * * *',
    // Annonce des defis de la semaine, les lundis suivants. Meme principe :
    // plusieurs passages, un seul envoi.
    annonce: process.env.CRON_ANNONCE || '0 8-17 * * 1',
    relance: process.env.CRON_RELANCE || '0 9 * * 3',
    resultats: process.env.CRON_RESULTATS || '0 16 * * 5',
  },

  campagne: {
    debut: process.env.CAMPAGNE_DEBUT || '2026-10-05',
    fin: process.env.CAMPAGNE_FIN || '2026-10-31',
  },

  dbFile: process.env.DB_FILE || path.resolve(process.cwd(), 'data', 'cybermois.db'),
};

/**
 * Annuaire simule actif ? Jamais en production, quelle que soit ldap.url :
 * l'adresse se regle aussi depuis le back-office, et « demo » y ouvrait quinze
 * comptes fictifs au mot de passe public, capables de jouer et de fausser le
 * classement. Source unique : chaque controle du mode demonstration passe ici.
 */
export const modeDemoActif = () => config.ldap.url === 'demo' && config.env !== 'production';
