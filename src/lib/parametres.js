import crypto from 'node:crypto';
import { db, journaliser } from './db.js';
import { config } from './config.js';
import cron from 'node-cron';
import { normaliserUrlLdap } from './url-ldap.js';

/**
 * Parametres modifiables depuis le back-office.
 *
 * Ordre de resolution : base de donnees > variable d'environnement > defaut.
 * Les variables d'environnement restent donc valables - elles servent
 * d'amorcage - mais tout reglage saisi dans l'interface les emporte.
 *
 * Les secrets (mot de passe du compte de service, mot de passe SMTP) sont
 * chiffres en AES-256-GCM avant stockage : une sauvegarde de la base ne
 * divulgue pas le compte de service Active Directory.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS parametres (
  cle       TEXT PRIMARY KEY,
  valeur    TEXT,
  chiffre   INTEGER NOT NULL DEFAULT 0,
  maj_le    TEXT NOT NULL DEFAULT (datetime('now')),
  maj_par   TEXT
);
`);

/* ------------------------------------------------------------ Chiffrement */

// La cle derive de SESSION_SECRET : changer ce dernier rend les secrets
// stockes illisibles, il faudra les ressaisir. C'est documente.
const cleChiffrement = () => crypto.scryptSync(config.sessionSecret, 'cybermois-parametres', 32);

function chiffrer(texte) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cleChiffrement(), iv);
  const donnees = Buffer.concat([c.update(String(texte), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), donnees.toString('base64')].join('.');
}

function dechiffrer(stocke) {
  try {
    const [iv, tag, donnees] = String(stocke).split('.');
    const d = crypto.createDecipheriv('aes-256-gcm', cleChiffrement(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(donnees, 'base64')), d.final()]).toString('utf8');
  } catch {
    // SESSION_SECRET a change, ou la valeur est corrompue
    return null;
  }
}

/* -------------------------------------------------------------- Descripteur */

const bool = (v) => /^(true|1|oui|yes)$/i.test(String(v));

/**
 * chemin : ou ecrire la valeur dans l'objet config
 * type   : texte | secret | entier | booleen | liste
 */
export const DESCRIPTEUR = [
  { cle: 'publicUrl', chemin: ['publicUrl'], type: 'texte', groupe: 'general',
    libelle: 'Adresse du portail', aide: "Telle que les agents la voient. Alimente les liens des mails et le drapeau securise du cookie de session." },
  { cle: 'defisParLigne', chemin: ['defisParLigne'], type: 'entier', groupe: 'general',
    libelle: 'Défis par ligne',
    aide: "Sur la page des défis. Quatre defis sur une seule ligne se lisent mal ; "
      + 'deux colonnes les presentent par paires. Valeur ignoree sur un ecran '
      + "etroit, ou l'affichage repasse sur une colonne quoi qu'il arrive." },
  // Groupe a part : le reglage se fait depuis l'onglet Programme, pas depuis
  // la page de configuration, qui n'affiche que ses propres groupes.
  { cle: 'afficherDefisAVenir', chemin: ['afficherDefisAVenir'], type: 'booleen', groupe: 'programme',
    libelle: 'Afficher les défis pas encore ouverts' },
  { cle: 'videoDomaines', chemin: ['videoDomaines'], type: 'liste', groupe: 'general',
    libelle: 'Hébergeurs vidéo autorisés',
    aide: "Séparés par des virgules. Un hébergeur absent d'ici verra son lecteur bloqué "
      + 'par le navigateur. Nom de domaine seul, sans https:// ni chemin. '
      + 'Exemple : www.youtube-nocookie.com, geo.dailymotion.com, medias.ssi.gouv.fr' },
  { cle: 'contactDpo', chemin: ['contactDpo'], type: 'texte', groupe: 'general',
    libelle: 'Adresse de la DPO',
    aide: 'Figure dans les mentions légales, pour l’exercice des droits. '
      + 'Un changement de personne se règle ici, sans toucher au code.' },

  { cle: 'ldap.url', chemin: ['ldap', 'url'], type: 'ldap-hote', groupe: 'ldap',
    libelle: "Adresse du controleur de domaine", aide: "L'IP ou le nom : 10.0.0.1, ou dc01.exemple.lan. "
      + 'Ni schema ni port : la case ci-contre les determine.' },
  { cle: 'ldap.bindDn', chemin: ['ldap', 'bindDn'], type: 'texte', groupe: 'ldap',
    libelle: 'DN du compte de service', aide: 'ad.cybermois@exemple.lan (ou le DN complet)' },
  { cle: 'ldap.bindPassword', chemin: ['ldap', 'bindPassword'], type: 'secret', groupe: 'ldap',
    libelle: 'Mot de passe du compte de service', aide: 'Chiffre en base. Jamais renvoye au navigateur.' },
  { cle: 'ldap.baseDn', chemin: ['ldap', 'baseDn'], type: 'texte', groupe: 'ldap',
    libelle: 'Base de recherche', aide: 'DC=exemple,DC=lan, ou une OU precise pour restreindre le perimetre.' },
  { cle: 'ldap.userFilter', chemin: ['ldap', 'userFilter'], type: 'texte', groupe: 'ldap',
    libelle: 'Filtre de recherche',
    aide: '{{login}} est remplace par la saisie de l agent. Le filtre par defaut accepte '
      + "l'identifiant comme l'adresse mail : sAMAccountName, userPrincipalName et mail." },
  { cle: 'ldap.requiredGroup', chemin: ['ldap', 'requiredGroup'], type: 'texte', groupe: 'ldap',
    libelle: 'Groupe obligatoire', aide: 'DN complet d\'un groupe de securite. Laisser vide pour n\'exclure personne.' },
  { cle: 'ldap.adminGroup', chemin: ['ldap', 'adminGroup'], type: 'texte', groupe: 'ldap',
    libelle: 'Groupe des administrateurs', aide: 'Nom court (GG-Cybermois-Admins) ou DN complet. Ses membres accedent au back-office.' },
  { cle: 'ldap.caBase64', chemin: ['ldap', 'caBase64'], type: 'secret', groupe: 'ldap',
    libelle: "Certificat de l'AC interne (base64)", aide: "A laisser vide si un fichier est monte dans le conteneur : "
      + 'LDAP_CA_FILE le designe alors, et il suffit. Ce champ est la solution de repli '
      + "quand on ne peut rien monter ; renseigne, il prend le dessus sur le fichier. "
      + 'Sous Windows : [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\\temp\\ca.cer"))' },
  { cle: 'ldap.rejectUnauthorized', chemin: ['ldap', 'rejectUnauthorized'], type: 'booleen', groupe: 'ldap',
    libelle: 'Valider le certificat du serveur', aide: 'A laisser actif. Le desactiver expose a une interception.' },
  { cle: 'ldap.autoriserNonChiffre', chemin: ['ldap', 'autoriserNonChiffre'], type: 'booleen', groupe: 'ldap',
    libelle: 'Autoriser une liaison non chiffree en production', aide: 'Les mots de passe des agents circuleraient en clair. A n\'activer que temporairement.' },

  { cle: 'service.source', chemin: ['service', 'source'], type: 'texte', groupe: 'service',
    libelle: 'Origine du service', aide: 'ou = deduit du DN (recommande) · attr = lu dans un attribut.' },
  { cle: 'service.attribut', chemin: ['service', 'attribut'], type: 'texte', groupe: 'service',
    libelle: 'Attribut', aide: 'Utilise seulement si l\'origine est attr. En general department.' },
  { cle: 'service.ouDepth', chemin: ['service', 'ouDepth'], type: 'entier', groupe: 'service',
    libelle: 'Profondeur d\'OU', aide: '1 = l\'OU contenant directement l\'agent. Les sous-OU se traitent ensuite par regroupement.' },

  { cle: 'sync.exigerEmail', chemin: ['sync', 'exigerEmail'], type: 'booleen', groupe: 'service',
    libelle: "N'importer que les comptes ayant une adresse mail",
    aide: 'Un agent sans adresse ne recoit ni lancement ni relance : il ne jouera jamais et fausserait le taux de participation de son service.' },

  { cle: 'adminLogins', chemin: ['adminLogins'], type: 'liste', groupe: 'general',
    libelle: 'Administrateurs', aide: 'Identifiants AD separes par des virgules.' },

  { cle: 'smtp.host', chemin: ['smtp', 'host'], type: 'texte', groupe: 'smtp', libelle: 'Serveur SMTP' },
  { cle: 'smtp.port', chemin: ['smtp', 'port'], type: 'entier', groupe: 'smtp', libelle: 'Port' },
  { cle: 'smtp.secure', chemin: ['smtp', 'secure'], type: 'booleen', groupe: 'smtp',
    libelle: 'Connexion chiffree d\'emblee', aide: 'Actif pour le port 465. Le port 587 utilise STARTTLS : laisser inactif.' },
  { cle: 'smtp.user', chemin: ['smtp', 'user'], type: 'texte', groupe: 'smtp',
    libelle: 'Identifiant', aide: 'Vide si le relais interne accepte l\'adresse IP sans authentification.' },
  { cle: 'smtp.password', chemin: ['smtp', 'password'], type: 'secret', groupe: 'smtp', libelle: 'Mot de passe' },
  { cle: 'smtp.from', chemin: ['smtp', 'from'], type: 'texte', groupe: 'smtp',
    libelle: 'Expediteur', aide: 'Cybermois <cybermois@chatillon92.fr>' },
  { cle: 'smtp.groupeDiffusion', chemin: ['smtp', 'groupeDiffusion'], type: 'texte', groupe: 'smtp',
    libelle: 'Groupe de diffusion', aide: 'Destinataire du mail de resultats du vendredi.' },
  { cle: 'smtp.copie', chemin: ['smtp', 'copie'], type: 'texte', groupe: 'smtp', libelle: 'En copie' },
  { cle: 'smtp.actif', chemin: ['smtp', 'actif'], type: 'booleen', groupe: 'smtp',
    libelle: 'Envois automatiques actifs',
    aide: 'Interrupteur general des envois planifies. A laisser inactif jusqu\'a la fin de la '
      + 'recette. Les envois faits a la main depuis l\'onglet Mails restent possibles.' },

  { cle: 'mails.ouverture', chemin: ['mails', 'ouverture'], type: 'booleen', groupe: 'planification',
    libelle: "Mail d'ouverture automatique", aide: 'Le premier jour, a chaque agent.' },
  { cle: 'mails.annonce', chemin: ['mails', 'annonce'], type: 'booleen', groupe: 'planification',
    libelle: 'Annonce du lundi automatique', aide: 'Les lundis suivants, a chaque agent.' },
  { cle: 'mails.relance', chemin: ['mails', 'relance'], type: 'booleen', groupe: 'planification',
    libelle: 'Relance du mercredi automatique', aide: 'Aux agents en retard sur la semaine.' },
  { cle: 'mails.resultats', chemin: ['mails', 'resultats'], type: 'booleen', groupe: 'planification',
    libelle: 'Resultats du vendredi automatiques', aide: 'Au groupe de diffusion.' },
  { cle: 'cron.ouverture', chemin: ['cron', 'ouverture'], type: 'texte', groupe: 'planification',
    libelle: "Mail d'ouverture",
    aide: '0 8-17 * * * = chaque heure de 8h a 17h. Le mail ne part que le jour du premier '
      + 'defi, une seule fois : les passages suivants rattrapent un serveur arrete a 8h.' },
  { cle: 'cron.annonce', chemin: ['cron', 'annonce'], type: 'texte', groupe: 'planification',
    libelle: 'Annonce des defis de la semaine',
    aide: '0 8-17 * * 1 = le lundi, chaque heure de 8h a 17h. Un seul envoi par semaine, '
      + 'a partir de la deuxieme : la premiere est annoncee par le mail d\'ouverture.' },
  { cle: 'cron.relance', chemin: ['cron', 'relance'], type: 'texte', groupe: 'planification',
    libelle: 'Relance des non-joueurs',
    aide: '0 9 * * 3 = mercredi a 9h. Porte sur les defis parus les sept derniers jours.' },
  { cle: 'cron.resultats', chemin: ['cron', 'resultats'], type: 'texte', groupe: 'planification',
    libelle: 'Envoi des resultats', aide: '0 16 * * 5 = vendredi a 16h.' },

  { cle: 'campagne.debut', chemin: ['campagne', 'debut'], type: 'texte', groupe: 'planification',
    libelle: 'Debut de campagne',
    aide: 'AAAA-MM-JJ. Date de reference affichee aux agents. Chaque defi porte '
      + 'sa propre date de parution, fixee dans le programme.' },
  { cle: 'campagne.fin', chemin: ['campagne', 'fin'], type: 'texte', groupe: 'planification',
    libelle: 'Fin de campagne',
    aide: "AAAA-MM-JJ. Dernier jour de saisie : le lendemain, plus aucune reponse "
      + "n'est enregistree et le classement devient definitif. Les defis restent "
      + 'consultables, les corrections relisibles.' },
];

const PAR_CLE = Object.fromEntries(DESCRIPTEUR.map((d) => [d.cle, d]));
const EST_SECRET = (cle) => PAR_CLE[cle]?.type === 'secret';

/* ------------------------------------------------------------- Lecture */

function convertir(descripteur, brut) {
  switch (descripteur.type) {
    case 'entier': return Number(brut);
    case 'booleen': return bool(brut);
    case 'liste': return String(brut).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    default: return String(brut);
  }
}

function ecrire(cible, chemin, valeur) {
  let noeud = cible;
  for (let i = 0; i < chemin.length - 1; i++) noeud = noeud[chemin[i]];
  noeud[chemin[chemin.length - 1]] = valeur;
}

function lire(source, chemin) {
  return chemin.reduce((noeud, c) => (noeud === undefined ? undefined : noeud[c]), source);
}

/**
 * Instantane des valeurs issues de l'environnement, pris avant toute
 * application des parametres stockes.
 * Sans lui, retirer un parametre de la base ne suffirait pas a revenir a la
 * valeur d'environnement : l'objet config conserverait la derniere valeur
 * appliquee jusqu'au prochain redemarrage.
 */
const VALEURS_ENVIRONNEMENT = Object.fromEntries(
  DESCRIPTEUR.map((d) => {
    const v = lire(config, d.chemin);
    return [d.cle, Array.isArray(v) ? [...v] : v];
  })
);

/** Applique les parametres stockes sur l'objet config, en memoire. */
/**
 * Le filtre d'authentification d'origine n'acceptait que l'identifiant.
 *
 * Les agents saisissent leur adresse une fois sur deux, et un refus a ce
 * moment-la se solde par un appel a la DSI. Le defaut accepte desormais les
 * deux ; une instance deja configuree porte encore l'ancien en base, ou il
 * prime sur le defaut.
 *
 * On ne remplace que le filtre d'origine, mot pour mot : un filtre modifie a
 * la main traduit une intention, et l'ecraser serait pire que le laisser.
 */
const FILTRE_ORIGINE = '(&(objectClass=user)(objectCategory=person)(sAMAccountName={{login}}))';

function migrerFiltreAuthentification() {
  const stocke = db.prepare("SELECT valeur FROM parametres WHERE cle = 'ldap.userFilter'").get()?.valeur;
  if (stocke !== FILTRE_ORIGINE) return false;

  const nouveau = '(&(objectClass=user)(objectCategory=person)'
    + '(|(sAMAccountName={{login}})(userPrincipalName={{login}})(mail={{login}})))';
  db.prepare("UPDATE parametres SET valeur = ?, maj_le = datetime('now') WHERE cle = 'ldap.userFilter'")
    .run(nouveau);
  journaliser('migration', 'filtre_authentification_elargi',
    "l'adresse mail est acceptee comme identifiant", null);
  return true;
}

export function appliquerParametres() {
  migrerFiltreAuthentification();

  // On repart systematiquement de l'environnement, puis on superpose la base :
  // le resultat ne depend donc pas de l'ordre des modifications passees.
  for (const d of DESCRIPTEUR) {
    const v = VALEURS_ENVIRONNEMENT[d.cle];
    ecrire(config, d.chemin, Array.isArray(v) ? [...v] : v);
  }

  const lignes = db.prepare('SELECT cle, valeur, chiffre FROM parametres').all();
  let appliques = 0;

  for (const ligne of lignes) {
    const d = PAR_CLE[ligne.cle];
    if (!d) continue;
    const brut = ligne.chiffre ? dechiffrer(ligne.valeur) : ligne.valeur;
    if (brut === null) continue; // secret illisible : on conserve la valeur d'environnement
    ecrire(config, d.chemin, convertir(d, brut));
    appliques++;
  }
  return appliques;
}

/** Etat courant, pour l'interface. Les secrets ne sont jamais renvoyes. */
export function lireParametres() {
  const stockes = new Set(db.prepare('SELECT cle FROM parametres').all().map((l) => l.cle));

  return DESCRIPTEUR.map((d) => {
    const valeur = lire(config, d.chemin);
    return {
      cle: d.cle,
      libelle: d.libelle,
      aide: d.aide || null,
      type: d.type,
      groupe: d.groupe,
      origine: stockes.has(d.cle) ? 'interface' : 'environnement',
      // Un secret n'est jamais renvoye : on indique seulement s'il est renseigne
      valeur: d.type === 'secret' ? null : (Array.isArray(valeur) ? valeur.join(', ') : valeur),
      renseigne: d.type === 'secret' ? !!valeur : undefined,
    };
  });
}

/**
 * Enregistre les parametres fournis, puis les applique immediatement.
 * Un secret dont la valeur est vide ou inchangee n'est pas ecrase :
 * l'interface n'ayant jamais recu l'ancienne valeur, elle ne peut pas la renvoyer.
 */
/**
 * Controles de coherence avant enregistrement.
 *
 * Ces reglages se saisissent depuis le back-office et prennent effet
 * immediatement : une valeur absurde n'attend pas un redeploiement pour faire
 * des degats. Deux cas justifient un refus plutot qu'un avertissement.
 *
 * L'adresse du portail commande le drapeau « Secure » du cookie de session :
 * la repasser en http ferait circuler le cookie en clair sur le reseau.
 *
 * Une expression de planification invalide n'arretait rien non plus : elle
 * etait acceptee, et les relances cessaient simplement d'etre envoyees, sans
 * que personne ne s'en apercoive avant la fin de la campagne.
 */
export function validerParametres(valeurs) {
  const erreurs = [];
  const v = (cle) => valeurs[cle];

  if (v('publicUrl') !== undefined) {
    const url = String(v('publicUrl')).trim();
    let hote = null;
    try { hote = new URL(url).hostname; } catch { /* invalide */ }
    if (!hote) erreurs.push("L'adresse du portail doit etre une URL complete, par exemple https://cybermois.exemple.fr");
    else if (config.env === 'production' && !url.startsWith('https://')) {
      erreurs.push("L'adresse du portail doit etre en https en production : le cookie de "
        + 'session perdrait son drapeau Secure et circulerait en clair.');
    }
  }

  for (const cle of ['campagne.debut', 'campagne.fin']) {
    if (v(cle) !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(v(cle)).trim())) {
      erreurs.push(`${PAR_CLE[cle].libelle} : date attendue au format AAAA-MM-JJ.`);
    }
  }

  if (v('campagne.debut') && v('campagne.fin')
      && String(v('campagne.debut')) > String(v('campagne.fin'))) {
    erreurs.push('La fin de campagne ne peut pas preceder son debut.');
  }

  for (const cle of ['cron.ouverture', 'cron.annonce', 'cron.relance', 'cron.resultats']) {
    if (v(cle) !== undefined && !cron.validate(String(v(cle)).trim())) {
      erreurs.push(`${PAR_CLE[cle].libelle} : expression de planification invalide `
        + '(exemple : « 0 9 * * 3 » pour le mercredi a 9 h).');
    }
  }

  if (v('service.ouDepth') !== undefined) {
    const n = Number(v('service.ouDepth'));
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      erreurs.push("La profondeur d'OU doit etre un entier entre 1 et 10.");
    }
  }

  return erreurs;
}

export function enregistrerParametres(valeurs, login) {
  const inserer = db.prepare(`
    INSERT INTO parametres (cle, valeur, chiffre, maj_le, maj_par)
    VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(cle) DO UPDATE SET
      valeur = excluded.valeur, chiffre = excluded.chiffre,
      maj_le = datetime('now'), maj_par = excluded.maj_par
  `);
  const supprimer = db.prepare('DELETE FROM parametres WHERE cle = ?');

  const modifiees = [];
  db.exec('BEGIN');
  try {
    for (const [cle, valeur] of Object.entries(valeurs)) {
      const d = PAR_CLE[cle];
      if (!d) continue;

      if (EST_SECRET(cle)) {
        if (valeur === '' || valeur === null || valeur === undefined) continue; // inchange
        if (valeur === '__EFFACER__') { supprimer.run(cle); modifiees.push(cle); continue; }
        inserer.run(cle, chiffrer(valeur), 1, login || null);
        modifiees.push(cle);
        continue;
      }

      let texte = Array.isArray(valeur) ? valeur.join(',') : String(valeur ?? '');

      // L'adresse de l'annuaire se saisit sans schema ni port : l'ecran fournit
      // l'hote et une case « liaison chiffree », on en compose l'URL. Une URL
      // complete reste acceptee et se trouve simplement normalisee.
      if (cle === 'ldap.url') {
        const chiffre = valeurs['ldap.chiffre'];
        texte = normaliserUrlLdap(texte, chiffre === undefined ? null : chiffre === true || chiffre === 'true');
      }
      inserer.run(cle, texte, 0, login || null);
      modifiees.push(cle);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  appliquerParametres();
  // Les secrets ne sont pas nommes dans le journal, seulement comptes
  journaliser(login, 'parametres_modifies',
    modifiees.filter((c) => !EST_SECRET(c)).join(', ')
    + (modifiees.some(EST_SECRET) ? ` (+ ${modifiees.filter(EST_SECRET).length} secret(s))` : ''), null);

  return modifiees.length;
}

/** Remet une cle a sa valeur d'environnement. */
export function reinitialiserParametre(cle, login) {
  db.prepare('DELETE FROM parametres WHERE cle = ?').run(cle);
  journaliser(login, 'parametre_reinitialise', cle, null);
  appliquerParametres();
}

/** La configuration permet-elle a un agent de se connecter ? */
export function configurationUtilisable() {
  if (config.ldap.url === 'demo') return { ok: true, mode: 'demonstration' };
  const manquants = [];
  if (!config.ldap.url || config.ldap.url.startsWith('ldap') === false) manquants.push('serveur LDAP');
  // Une liaison en clair n'est pas une configuration incomplete mais inutilisable :
  // les connexions d'agents sont refusees. La page doit le dire, sans quoi le
  // symptome n'apparaitrait qu'au premier agent qui essaie.
  else if (config.env === 'production' && config.ldap.url.startsWith('ldap://')
    && !config.ldap.autoriserNonChiffre) {
    manquants.push('une liaison chiffree : ldaps:// (port 636) et non ldap://');
  }
  if (!config.ldap.bindDn) manquants.push('DN du compte de service');
  if (!config.ldap.bindPassword) manquants.push('mot de passe du compte de service');
  if (!config.ldap.baseDn) manquants.push('base de recherche');
  // Le compte local ne compte pas ici : il sert a entrer avant que l'annuaire
  // ne fonctionne, pas a administrer la campagne au quotidien. Sans identifiant
  // d'annuaire ni groupe dedie, aucun agent ne pourrait acceder au back-office.
  if (!config.adminLogins.length && !config.ldap.adminGroup) {
    manquants.push("un administrateur issu de l'annuaire, par identifiant ou par groupe");
  }
  return { ok: manquants.length === 0, mode: 'annuaire', manquants };
}
