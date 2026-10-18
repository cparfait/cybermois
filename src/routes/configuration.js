import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { Client } from 'ldapts';
import nodemailer from 'nodemailer';

import { config, SECRET_DEFAUT } from '../lib/config.js';
import { db, journaliser, SERVICE_NON_RATTACHE } from '../lib/db.js';
import { exigerAdmin } from '../lib/session.js';
import {
  DESCRIPTEUR, lireParametres, enregistrerParametres, validerParametres,
  reinitialiserParametre, configurationUtilisable,
} from '../lib/parametres.js';
import {
  listerAdminsLocaux, definirAdminLocal, supprimerAdminLocal,
} from '../lib/admin-local.js';
import { chaineOu } from '../lib/services.js';
import { construireFiltre } from '../lib/ldap.js';
import { normaliserUrlLdap } from '../lib/url-ldap.js';

/** Un booleen lu depuis un formulaire arrive souvent sous forme de chaine. */
const booleen = (v, defaut) => {
  if (v === undefined || v === null || v === '') return defaut;
  if (typeof v === 'boolean') return v;
  // « !!'false' » vaut vrai : le test validait alors le certificat alors que
  // l'enregistrement, lui, allait desactiver la validation. Le test rassurait
  // sur une configuration differente de celle qui serait appliquee.
  return /^(true|1|oui|yes)$/i.test(String(v));
};

/** L'hote vise par une URL d'annuaire, sans le schema ni le chemin. */
function hoteLdap(url) {
  try {
    const u = new URL(String(url).replace(/^ldaps?:/, 'http:'));
    return `${u.hostname}:${u.port || (String(url).startsWith('ldaps://') ? '636' : '389')}`;
  } catch {
    return null;
  }
}

/**
 * Les tests utilisent les valeurs SOUMISES, pas celles enregistrees :
 * on veut pouvoir verifier une configuration avant de l'appliquer, et donc
 * avant de risquer de se couper l'acces a l'annuaire.
 *
 * MAIS le mot de passe enregistre n'est repris que si l'hote vise est bien
 * celui deja enregistre.
 *
 * Sans cette condition, un champ « mot de passe » laisse vide - ce qui est le
 * cas normal, l'interface ne le recoit jamais - suffisait a faire partir le
 * mot de passe du compte de service Active Directory vers l'adresse de son
 * choix : il suffisait de soumettre « ldap://mon-serveur » et de le lire en
 * clair a l'arrivee. Un administrateur pouvait ainsi extraire un secret qu'il
 * n'avait pas, et rien n'en gardait trace.
 *
 * Viser un autre serveur exige donc de ressaisir le mot de passe.
 */
function fusionner(propositions) {
  const v = (cle, defaut) => {
    const p = propositions?.[cle];
    if (p === undefined || p === null || p === '') return defaut;
    return p;
  };

  // L'ecran fournit un hote nu et une case de chiffrement : le test doit voir
  // la meme URL que celle qui sera enregistree, sans quoi il reproche une
  // adresse invalide a une saisie parfaitement correcte.
  const chiffre = propositions?.['ldap.chiffre'];
  const url = normaliserUrlLdap(
    v('ldap.url', config.ldap.url),
    chiffre === undefined ? null : booleen(chiffre, false)
  );

  const memeHote = hoteLdap(url) !== null && hoteLdap(url) === hoteLdap(config.ldap.url);
  const motDePasseSoumis = propositions?.['ldap.bindPassword'];
  const secretFourni = motDePasseSoumis !== undefined && motDePasseSoumis !== null && motDePasseSoumis !== '';

  return {
    url,
    bindDn: v('ldap.bindDn', config.ldap.bindDn),
    // Secret repris seulement si l'hote ne change pas.
    bindPassword: secretFourni
      ? motDePasseSoumis
      : (memeHote ? config.ldap.bindPassword : ''),
    secretManquant: !secretFourni && !memeHote,
    memeHote,
    baseDn: v('ldap.baseDn', config.ldap.baseDn),
    userFilter: v('ldap.userFilter', config.ldap.userFilter),
    // Le certificat de l'AC n'est pas un secret d'authentification : il se
    // reprend sans condition, il ne fuit rien.
    caBase64: v('ldap.caBase64', config.ldap.caBase64),
    rejectUnauthorized: booleen(propositions?.['ldap.rejectUnauthorized'], config.ldap.rejectUnauthorized),
    ouDepth: Number(propositions?.['service.ouDepth'] ?? config.service.ouDepth),
  };
}

/** Refus commun aux deux tests d'annuaire quand le mot de passe manque. */
const REFUS_SECRET = {
  ok: false,
  code: 'SECRET_REQUIS',
  etapes: [{
    libelle: 'Mot de passe du compte de service',
    ok: false,
    detail: "Vous visez un autre serveur que celui enregistré : le mot de passe déjà "
      + 'enregistré ne lui sera pas transmis. Ressaisissez-le pour tester cette adresse.',
  }],
};

/** L'annuaire simule n'existe pas en production : un test ne doit pas le dire joignable. */
const REFUS_DEMO = {
  libelle: 'Mode démonstration',
  ok: false,
  detail: "Le mode démonstration est désactivé en production : ses comptes fictifs, au mot de "
    + 'passe public, fausseraient le classement. Indiquez le contrôleur de domaine.',
};

function clientLdap(p) {
  const tlsOptions = p.url.startsWith('ldaps://')
    ? { rejectUnauthorized: !!p.rejectUnauthorized }
    : undefined;
  if (tlsOptions && p.caBase64) {
    try { tlsOptions.ca = [Buffer.from(String(p.caBase64).replace(/\s+/g, ''), 'base64')]; } catch { /* ignore */ }
  } else if (tlsOptions && config.ldap.caFile && fs.existsSync(config.ldap.caFile)) {
    tlsOptions.ca = [fs.readFileSync(config.ldap.caFile)];
  }
  return new Client({ url: p.url, timeout: 10000, connectTimeout: 10000, tlsOptions });
}

/**
 * Ce que l'application sait de l'autorite de certification.
 *
 * Elle peut venir d'un fichier monte - le cas d'un deploiement en conteneur -
 * ou d'une chaine base64 saisie ici. Sans ce retour, un fichier correctement
 * monte laissait le champ base64 vide, et rien ne distinguait cet etat d'une
 * absence de certificat.
 */
function etatCertificat() {
  if (config.ldap.caBase64) {
    return { source: 'base64', ok: true, detail: 'Certificat saisi dans ce formulaire.' };
  }
  if (!config.ldap.caFile) {
    return {
      source: 'aucun', ok: false,
      detail: 'Aucun certificat fourni. La validation utilisera les autorites publiques, '
        + "ce qui echoue avec une autorite interne.",
    };
  }
  if (!fs.existsSync(config.ldap.caFile)) {
    return {
      source: 'fichier', ok: false, chemin: config.ldap.caFile,
      detail: 'Fichier introuvable dans le conteneur. Verifiez le montage de volume.',
    };
  }
  const taille = fs.statSync(config.ldap.caFile).size;
  return {
    source: 'fichier', ok: true, chemin: config.ldap.caFile,
    detail: `Certificat lu depuis le conteneur (${taille} octets). Rien a saisir ici.`,
  };
}

/**
 * Limitation appliquee aux tests de connexion.
 *
 * Chacun ouvre une connexion reseau vers un hote choisi dans la requete, avec
 * cinq a dix secondes d'attente : enchaines, ils font de la page de
 * configuration un scanner de ports du reseau interne, et un moyen de
 * pilonner un service tiers depuis l'adresse du serveur. Un administrateur
 * qui met au point sa configuration en lance quelques-uns par minute, pas
 * plusieurs par seconde.
 */
const LIMITE_TESTS = {
  rateLimit: {
    max: 12,
    timeWindow: '1 minute',
    keyGenerator: (requete) => `test:${requete.agent?.login || requete.ip}`,
    errorResponseBuilder: () => ({
      statusCode: 429,
      erreur: 'Trop de tests de connexion en peu de temps. Patientez une minute.',
      code: 'TROP_DE_TESTS',
    }),
  },
};

export default async function routesConfiguration(app) {
  app.addHook('preHandler', exigerAdmin);

  /* ------------------------------------------------------------- Lecture */

  app.get('/api/admin/configuration', async () => ({
    parametres: lireParametres(),
    groupes: [
      { cle: 'general', libelle: 'Général' },
      { cle: 'ldap', libelle: 'Active Directory' },
      { cle: 'service', libelle: 'Rattachement au service' },
      { cle: 'smtp', libelle: 'Messagerie' },
      { cle: 'planification', libelle: 'Planification et campagne' },
    ],
    etat: configurationUtilisable(),
    adminsLocaux: listerAdminsLocaux(),
    // Rappel de ce qui vient du fichier d'environnement et ne peut pas etre change ici
    environnement: {
      sessionSecretDefini: config.sessionSecret !== SECRET_DEFAUT,
      dbFile: config.dbFile,
      env: config.env,
      // Un certificat monte dans le conteneur ne se voit nulle part : le champ
      // base64 reste vide, et rien ne dit qu'une autorite est bien fournie.
      certificat: etatCertificat(),
    },
  }));

  /* --------------------------------------------------------- Enregistrement */

  app.put('/api/admin/configuration', async (requete, reponse) => {
    const valeurs = requete.body?.valeurs;
    if (!valeurs || typeof valeurs !== 'object') {
      return reponse.code(400).send({ erreur: 'Aucune valeur transmise.' });
    }

    // Certaines cles accompagnent un parametre sans etre stockees : la case
    // « liaison chiffree » sert a composer ldap.url, elle ne vit pas en base.
    // Sans cette tolerance, l'enregistrement echouait en entier sur un
    // « parametre inconnu » qui ne designait rien d'anormal.
    const ACCOMPAGNANTES = new Set(['ldap.chiffre']);
    const cles = new Set(DESCRIPTEUR.map((d) => d.cle));
    const inconnues = Object.keys(valeurs)
      .filter((c) => !cles.has(c) && !ACCOMPAGNANTES.has(c));
    if (inconnues.length) {
      return reponse.code(400).send({ erreur: `Paramètre inconnu : ${inconnues.join(', ')}` });
    }

    // Garde-fou : ne pas se retirer soi-meme les droits d'administration
    if (valeurs.adminLogins !== undefined) {
      const liste = String(valeurs.adminLogins).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const estLocal = listerAdminsLocaux().some((a) => a.login === requete.agent.login);
      if (!liste.includes(requete.agent.login) && !estLocal) {
        return reponse.code(400).send({
          erreur: `Votre identifiant « ${requete.agent.login} » ne figure plus dans la liste des administrateurs : `
            + 'vous perdriez l\'accès au back-office. Ajoutez-le, ou passez par un compte local.',
        });
      }
    }

    // Coherence des valeurs elles-memes. Ces reglages prennent effet
    // immediatement : une adresse en http, une date absurde ou une expression
    // de planification invalide n'attendaient aucun redeploiement pour agir,
    // et la planification invalide se contentait d'arreter silencieusement
    // les relances.
    const problemes = validerParametres(valeurs);
    if (problemes.length) {
      return reponse.code(400).send({ erreur: problemes.join(' '), problemes, code: 'VALEURS_INVALIDES' });
    }

    try {
      const n = enregistrerParametres(valeurs, requete.agent.login);

      /**
       * La liste des administrateurs ne se relisait qu'a la connexion : un
       * identifiant retire gardait ses droits jusqu'a huit heures.
       *
       * Seuls les droits VENANT DE CETTE LISTE sont revoques. Ceux qui
       * viennent du groupe Active Directory ne se verifient pas sans
       * interroger l'annuaire : les remettre a zero ici priverait de l'acces
       * tous les administrateurs du groupe jusqu'a leur reconnexion.
       */
      if (valeurs.adminLogins !== undefined) {
        const listes = config.adminLogins;
        const marques = listes.length ? listes.map(() => '?').join(',') : "''";
        const retires = db.prepare(`
          UPDATE agents SET est_admin = 0, admin_source = NULL
          WHERE admin_source = 'liste' AND login NOT IN (${marques})
        `).run(...listes).changes;

        for (const login of listes) {
          db.prepare(`
            UPDATE agents SET est_admin = 1,
              admin_source = COALESCE(NULLIF(admin_source, ''), 'liste')
            WHERE login = ? AND origine <> 'local'
          `).run(login);
        }
        if (retires) {
          journaliser(requete.agent.login, 'admins_revoques',
            `${retires} identifiant(s) retire(s) de la liste`, requete.ip);
        }
      }

      const etat = configurationUtilisable();

      // Les horaires et l'activation des envois changent la planification :
      // on la reconstruit sans redemarrer le conteneur.
      const planification = (c) => c.startsWith('cron.') || c.startsWith('mails.') || c === 'smtp.actif';
      if (Object.keys(valeurs).some(planification)) {
        app.replanifier?.();
      }
      return {
        ok: true,
        message: `${n} paramètre(s) enregistré(s) et appliqué(s) immédiatement.`
          + (etat.ok ? '' : ` Configuration encore incomplète : ${etat.manquants.join(', ')}.`),
        etat,
        replanifier: Object.keys(valeurs).some(planification),
      };
    } catch (err) {
      requete.log.error(err, 'enregistrement de configuration impossible');
      return reponse.code(500).send({ erreur: 'Enregistrement impossible : la configuration est restée inchangée.', code: 'ENREGISTREMENT_ECHOUE' });
    }
  });

  app.delete('/api/admin/configuration/:cle', async (requete, reponse) => {
    const cle = requete.params.cle;
    if (!DESCRIPTEUR.some((d) => d.cle === cle)) {
      return reponse.code(404).send({ erreur: 'Paramètre inconnu.' });
    }
    reinitialiserParametre(cle, requete.agent.login);
    return { ok: true, message: `« ${cle} » revient à sa valeur d'environnement.` };
  });

  /* --------------------------------------------------------- Test LDAP */

  app.post('/api/admin/configuration/test-ldap', { config: LIMITE_TESTS }, async (requete) => {
    const p = fusionner(requete.body?.valeurs);
    const etapes = [];
    const ajouter = (libelle, ok, detail) => etapes.push({ libelle, ok, detail });

    if (p.url === 'demo' && config.env === 'production') return { ok: false, etapes: [REFUS_DEMO] };
    if (p.url === 'demo') {
      return { ok: true, etapes: [{ libelle: 'Mode démonstration', ok: true, detail: 'Annuaire simulé, aucun serveur interrogé.' }] };
    }
    if (p.secretManquant) {
      journaliser(requete.agent.login, 'test_ldap_refuse',
        `hote vise ${hoteLdap(p.url)} : mot de passe non ressaisi`, requete.ip);
      return REFUS_SECRET;
    }
    if (!p.url || !p.bindDn || !p.bindPassword || !p.baseDn) {
      return { ok: false, etapes: [{ libelle: 'Configuration', ok: false, detail: 'Serveur, compte de service, mot de passe et base de recherche sont tous nécessaires.' }] };
    }

    // L'hote vise est journalise a CHAQUE test, et pas seulement en cas de
    // succes : c'est la seule trace qui dirait qu'un compte d'administration
    // a fait pointer l'application ailleurs que sur l'annuaire de la
    // collectivite.
    journaliser(requete.agent.login, 'test_ldap',
      `hote vise ${hoteLdap(p.url)}${p.memeHote ? '' : ' (different de la configuration enregistree)'}`,
      requete.ip);

    // 1. Joignabilite
    let hote; let port; let chiffre;
    try {
      const u = new URL(p.url.replace(/^ldaps?:/, 'http:'));
      chiffre = p.url.startsWith('ldaps://');
      hote = u.hostname;
      port = Number(u.port) || (chiffre ? 636 : 389);
    } catch {
      return {
        ok: false,
        etapes: [{
          libelle: 'Adresse du serveur', ok: false,
          detail: `« ${p.url} » n'est pas exploitable. Indiquez une IP ou un nom `
            + '(10.0.0.1, dc01.exemple.lan), sans schéma ni port.',
        }],
      };
    }

    const joignable = await new Promise((resoudre) => {
      const prise = net.createConnection({ host: hote, port, timeout: 5000 });
      prise.on('connect', () => { prise.destroy(); resoudre(true); });
      prise.on('timeout', () => { prise.destroy(); resoudre(false); });
      prise.on('error', () => resoudre(false));
    });
    ajouter(`Joignabilité de ${hote}:${port}`, joignable,
      joignable ? 'Le port répond.' : 'Aucune réponse : vérifiez le nom, le pare-feu et le port.');
    if (!joignable) return { ok: false, etapes };

    if (!chiffre) {
      ajouter('Chiffrement', true,
        'Liaison NON CHIFFRÉE : les mots de passe des agents circuleront en clair. Acceptable pour une mise au point, à corriger avant ouverture.');
    } else {
      const cert = await new Promise((resoudre) => {
        const prise = tls.connect({ host: hote, port, rejectUnauthorized: false, timeout: 5000 }, () => {
          const c = prise.getPeerCertificate(); prise.destroy(); resoudre(c);
        });
        prise.on('error', () => resoudre(null));
        prise.on('timeout', () => { prise.destroy(); resoudre(null); });
      });
      if (cert) {
        ajouter('Certificat présenté', true,
          `${cert.subject?.CN || '(sans CN)'}, émis par ${cert.issuer?.CN || '(inconnu)'}, valide jusqu'au ${cert.valid_to}.`
          + (p.rejectUnauthorized ? '' : ' Validation désactivée : la liaison est chiffrée mais non authentifiée.'));
      }
    }

    // 2. Compte de service
    const client = clientLdap(p);
    try {
      await client.bind(p.bindDn, p.bindPassword);
      ajouter('Compte de service', true, 'Authentification réussie.');
    } catch (e) {
      let detail = e.message;
      if (/invalid credentials|data 52e/i.test(detail)) detail = 'Identifiant ou mot de passe incorrect. Le DN complet ou la forme utilisateur@domaine sont acceptés.';
      else if (/data 532|data 701/i.test(detail)) detail = 'Le mot de passe du compte de service a expiré.';
      else if (/data 773/i.test(detail)) detail = 'Le mot de passe doit être changé à la prochaine connexion.';
      else if (/self.signed|unable to verify/i.test(detail)) detail = "Certificat non validable : fournissez l'AC interne, ou désactivez la validation le temps de la mise au point.";
      // Cas frequent : on se connecte par IP, le certificat porte un nom. Le
      // reflexe est alors de desactiver la validation, c'est-a-dire d'abandonner
      // la protection au lieu de corriger l'adresse.
      else if (/altnames|does not match certificate/i.test(detail)) {
        const nom = detail.match(/DNS:([^,\s]+)/)?.[1];
        detail = "Le certificat ne couvre pas cette adresse. Un certificat garantit un NOM, "
          + "pas une IP : remplacez l'adresse par le nom du contrôleur"
          + (nom ? ` (${nom})` : ' figurant dans le certificat')
          + ", à condition qu'il soit résolvable depuis le conteneur. "
          + 'Désactiver la validation ferait disparaître le message en supprimant la protection.';
      }
      ajouter('Compte de service', false, detail);
      await client.unbind().catch(() => {});
      return { ok: false, etapes };
    }

    // 3. Lecture et repartition des services
    try {
      const { searchEntries } = await client.search(p.baseDn, {
        scope: 'sub',
        filter: '(&(objectClass=user)(objectCategory=person))',
        attributes: ['dn', 'sAMAccountName', 'mail', 'department', 'userAccountControl'],
        sizeLimit: 3000,
        paged: { pageSize: 500 },
      });

      const actifs = searchEntries.filter((e) => !(Number(e.userAccountControl || 0) & 2));
      ajouter('Lecture de l\'annuaire', true,
        `${searchEntries.length} compte(s) lu(s), dont ${actifs.length} actif(s).`);

      const sansMail = actifs.filter((e) => !e.mail).length;
      if (sansMail) {
        ajouter('Adresses mail', true,
          `${sansMail} compte(s) actif(s) sans adresse : ils ne recevront pas de relance.`);
      }

      const repartition = {};
      for (let profondeur = 1; profondeur <= 3; profondeur++) {
        const m = new Map();
        for (const e of actifs) {
          const nom = chaineOu(e.dn)[profondeur - 1] || '(aucune)';
          m.set(nom, (m.get(nom) || 0) + 1);
        }
        if ((m.get('(aucune)') || 0) === actifs.length) continue;
        repartition[profondeur] = [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([nom, n]) => ({ nom, n }));
      }

      const retenue = repartition[p.ouDepth];
      if (retenue) {
        ajouter(`Rattachement au service (profondeur ${p.ouDepth})`, true,
          `${retenue.length} service(s) distinct(s).`
          + (retenue.length > 40 ? ' C\'est beaucoup : utilisez le regroupement des services.' : ''));
      }

      await client.unbind().catch(() => {});
      return { ok: true, etapes, repartition };
    } catch (e) {
      let detail = e.message;
      if (/no such object/i.test(detail)) detail = `« ${p.baseDn} » ne correspond à aucun conteneur existant.`;
      ajouter('Lecture de l\'annuaire', false, detail);
      await client.unbind().catch(() => {});
      return { ok: false, etapes };
    }
  });

  /* ----------------------------------------- Test d'authentification d'un agent */

  app.post('/api/admin/configuration/test-agent', { config: LIMITE_TESTS }, async (requete) => {
    const p = fusionner(requete.body?.valeurs);
    const login = String(requete.body?.login || '').trim();
    if (!login) return { ok: false, message: 'Indiquez un identifiant à rechercher.' };
    if (p.url === 'demo' && config.env === 'production') return { ok: false, message: REFUS_DEMO.detail };
    if (p.url === 'demo') return { ok: false, message: 'Indisponible en mode démonstration.' };
    if (p.secretManquant) {
      journaliser(requete.agent.login, 'test_agent_refuse',
        `hote vise ${hoteLdap(p.url)} : mot de passe non ressaisi`, requete.ip);
      return {
        ok: false,
        code: 'SECRET_REQUIS',
        message: "Vous visez un autre serveur que celui enregistré : ressaisissez le mot de "
          + 'passe du compte de service pour tester cette adresse.',
      };
    }

    journaliser(requete.agent.login, 'test_agent',
      `hote vise ${hoteLdap(p.url)}, identifiant ${login.slice(0, 64)}`, requete.ip);

    const client = clientLdap(p);
    try {
      await client.bind(p.bindDn, p.bindPassword);
      // Le filtre est construit par la MEME fonction que l'authentification.
      // Le test echappait les caracteres speciaux quand l'authentification,
      // elle, les protege selon la RFC 4515 : un identifiant contenant une
      // barre oblique inverse reussissait ici et echouait en vrai.
      const filtre = construireFiltre(p.userFilter, login);
      const { searchEntries } = await client.search(p.baseDn, {
        scope: 'sub', filter: filtre,
        attributes: ['dn', 'sAMAccountName', 'displayName', 'mail', 'department', 'memberOf'],
      });

      if (!searchEntries.length) {
        return { ok: false, message: `Aucun compte trouvé pour « ${login} ». Vérifiez le filtre et la base de recherche.` };
      }
      if (searchEntries.length > 1) {
        return { ok: false, message: `${searchEntries.length} comptes trouvés : le filtre n'est pas assez sélectif.` };
      }

      const e = searchEntries[0];
      const ous = chaineOu(e.dn);
      // Meme repli qu'a la connexion : la source configuree d'abord, l'autre
      // ensuite. Sans cela l'ecran de test annoncait « Non rattache » pour un
      // agent que l'application, elle, sait rattacher.
      const service = config.service.source === 'ou'
        ? (ous[p.ouDepth - 1] || e.department)
        : (e.department || ous[p.ouDepth - 1]);

      return {
        ok: true,
        agent: {
          dn: e.dn,
          login: e.sAMAccountName,
          nomComplet: e.displayName || null,
          email: e.mail || null,
          department: e.department || null,
          chaineOu: ous,
          serviceRetenu: service || SERVICE_NON_RATTACHE,
          nbGroupes: [].concat(e.memberOf || []).length,
        },
      };
    } catch (e) {
      return { ok: false, message: e.message };
    } finally {
      await client.unbind().catch(() => {});
    }
  });

  /* --------------------------------------------------------- Test SMTP */

  app.post('/api/admin/configuration/test-smtp', { config: LIMITE_TESTS }, async (requete) => {
    const v = requete.body?.valeurs || {};
    const hote = v['smtp.host'] ?? config.smtp.host;
    const port = Number(v['smtp.port'] ?? config.smtp.port);
    const secure = booleen(v['smtp.secure'], config.smtp.secure);
    const utilisateur = v['smtp.user'] ?? config.smtp.user;
    const destinataire = String(requete.body?.destinataire || '').trim();

    if (!hote) return { ok: false, message: 'Aucun serveur SMTP renseigné.' };

    // Meme regle que pour l'annuaire : le mot de passe enregistre ne part que
    // vers le relais deja enregistre. Sinon il faut le ressaisir.
    const memeRelais = String(hote) === String(config.smtp.host);
    const secretFourni = !!v['smtp.password'];
    const motDePasse = secretFourni ? v['smtp.password'] : (memeRelais ? config.smtp.password : '');

    if (utilisateur && !secretFourni && !memeRelais) {
      journaliser(requete.agent.login, 'test_smtp_refuse',
        `relais vise ${hote}:${port} : mot de passe non ressaisi`, requete.ip);
      return {
        ok: false,
        code: 'SECRET_REQUIS',
        message: "Vous visez un autre relais que celui enregistré : ressaisissez le mot de "
          + 'passe pour tester cette adresse.',
      };
    }

    journaliser(requete.agent.login, 'test_smtp',
      `relais vise ${hote}:${port}${memeRelais ? '' : ' (different de la configuration enregistree)'}`,
      requete.ip);

    const transport = nodemailer.createTransport({
      host: hote, port, secure,
      auth: utilisateur ? { user: utilisateur, pass: motDePasse } : undefined,
      requireTLS: !secure,
      // La validation reste active : un test qui accepte n'importe quel
      // certificat ne verifie pas la configuration qui sera reellement
      // utilisee, et invite a mettre en service une liaison non authentifiee.
      tls: { rejectUnauthorized: true },
      connectionTimeout: 10000,
    });

    try {
      await transport.verify();
    } catch (e) {
      return { ok: false, message: `Relais injoignable ou refusé : ${e.message}` };
    }

    if (!destinataire) {
      return { ok: true, message: `Relais ${hote}:${port} joignable. Indiquez une adresse pour envoyer un message de test.` };
    }

    try {
      await transport.sendMail({
        from: v['smtp.from'] ?? config.smtp.from,
        to: destinataire,
        subject: 'Cybermois — message de test',
        text: 'Si vous lisez ce message, la configuration SMTP du portail Cybermois est fonctionnelle.',
        html: '<p>Si vous lisez ce message, la configuration SMTP du portail Cybermois est fonctionnelle.</p>',
      });
      journaliser(requete.agent.login, 'test_smtp', destinataire, requete.ip);
      return { ok: true, message: `Message de test envoyé à ${destinataire}. Vérifiez la boîte de réception, et les indésirables.` };
    } catch (e) {
      return { ok: false, message: `Relais joignable, mais envoi refusé : ${e.message}` };
    }
  });

  /* ------------------------------------------------- Comptes locaux */

  app.post('/api/admin/configuration/admin-local', async (requete, reponse) => {
    const { login, motDePasse } = requete.body || {};
    try {
      definirAdminLocal(login, motDePasse, { parQui: requete.agent.login });
      return { ok: true, message: `Compte local « ${String(login).toLowerCase()} » enregistré.` };
    } catch (e) {
      return reponse.code(400).send({ erreur: e.message });
    }
  });

  app.delete('/api/admin/configuration/admin-local/:login', async (requete, reponse) => {
    try {
      supprimerAdminLocal(requete.params.login, requete.agent.login);
      return { ok: true, message: 'Compte local supprimé.' };
    } catch (e) {
      return reponse.code(400).send({ erreur: e.message });
    }
  });
}
