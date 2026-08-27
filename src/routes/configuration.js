import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { Client } from 'ldapts';
import nodemailer from 'nodemailer';

import { config } from '../lib/config.js';
import { journaliser } from '../lib/db.js';
import { exigerAdmin } from '../lib/session.js';
import {
  DESCRIPTEUR, lireParametres, enregistrerParametres,
  reinitialiserParametre, configurationUtilisable,
} from '../lib/parametres.js';
import {
  listerAdminsLocaux, definirAdminLocal, supprimerAdminLocal,
} from '../lib/admin-local.js';
import { chaineOu } from '../lib/services.js';

/**
 * Les tests utilisent les valeurs SOUMISES, pas celles enregistrees :
 * on veut pouvoir verifier une configuration avant de l'appliquer, et donc
 * avant de risquer de se couper l'acces a l'annuaire.
 */
function fusionner(propositions) {
  const secretsConnus = {
    'ldap.bindPassword': config.ldap.bindPassword,
    'ldap.caBase64': config.ldap.caBase64,
    'smtp.password': config.smtp.password,
  };
  const v = (cle, defaut) => {
    const p = propositions?.[cle];
    // Un secret laisse vide signifie « ne pas changer » : on reprend l'existant
    if (p === undefined || p === null || p === '') return secretsConnus[cle] ?? defaut;
    return p;
  };

  return {
    url: v('ldap.url', config.ldap.url),
    bindDn: v('ldap.bindDn', config.ldap.bindDn),
    bindPassword: v('ldap.bindPassword', config.ldap.bindPassword),
    baseDn: v('ldap.baseDn', config.ldap.baseDn),
    userFilter: v('ldap.userFilter', config.ldap.userFilter),
    caBase64: v('ldap.caBase64', config.ldap.caBase64),
    rejectUnauthorized: propositions?.['ldap.rejectUnauthorized'] ?? config.ldap.rejectUnauthorized,
    ouDepth: Number(propositions?.['service.ouDepth'] ?? config.service.ouDepth),
  };
}

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
      sessionSecretDefini: config.sessionSecret !== 'secret-de-developpement-a-remplacer-absolument',
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

    const cles = new Set(DESCRIPTEUR.map((d) => d.cle));
    const inconnues = Object.keys(valeurs).filter((c) => !cles.has(c));
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

    try {
      const n = enregistrerParametres(valeurs, requete.agent.login);
      const etat = configurationUtilisable();

      // Les horaires et l'activation des envois changent la planification :
      // on la reconstruit sans redemarrer le conteneur.
      if (Object.keys(valeurs).some((c) => c.startsWith('cron.') || c === 'smtp.actif')) {
        app.replanifier?.();
      }
      return {
        ok: true,
        message: `${n} paramètre(s) enregistré(s) et appliqué(s) immédiatement.`
          + (etat.ok ? '' : ` Configuration encore incomplète : ${etat.manquants.join(', ')}.`),
        etat,
        replanifier: Object.keys(valeurs).some((c) => c.startsWith('cron.') || c === 'smtp.actif'),
      };
    } catch (err) {
      return reponse.code(500).send({ erreur: `Enregistrement impossible : ${err.message}` });
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

  app.post('/api/admin/configuration/test-ldap', async (requete) => {
    const p = fusionner(requete.body?.valeurs);
    const etapes = [];
    const ajouter = (libelle, ok, detail) => etapes.push({ libelle, ok, detail });

    if (p.url === 'demo') {
      return { ok: true, etapes: [{ libelle: 'Mode démonstration', ok: true, detail: 'Annuaire simulé, aucun serveur interrogé.' }] };
    }
    if (!p.url || !p.bindDn || !p.bindPassword || !p.baseDn) {
      return { ok: false, etapes: [{ libelle: 'Configuration', ok: false, detail: 'Serveur, compte de service, mot de passe et base de recherche sont tous nécessaires.' }] };
    }

    // 1. Joignabilite
    let hote; let port; let chiffre;
    try {
      const u = new URL(p.url.replace(/^ldaps?:/, 'http:'));
      chiffre = p.url.startsWith('ldaps://');
      hote = u.hostname;
      port = Number(u.port) || (chiffre ? 636 : 389);
    } catch {
      return { ok: false, etapes: [{ libelle: 'Adresse du serveur', ok: false, detail: `« ${p.url} » n'est pas une URL valide. Attendu : ldaps://serveur:636` }] };
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

  app.post('/api/admin/configuration/test-agent', async (requete) => {
    const p = fusionner(requete.body?.valeurs);
    const login = String(requete.body?.login || '').trim();
    if (!login) return { ok: false, message: 'Indiquez un identifiant à rechercher.' };
    if (p.url === 'demo') return { ok: false, message: 'Indisponible en mode démonstration.' };

    const client = clientLdap(p);
    try {
      await client.bind(p.bindDn, p.bindPassword);
      const filtre = (p.userFilter || '').replace('{{login}}', login.replace(/[\\*()\0]/g, ''));
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
      const service = config.service.source === 'ou' ? ous[p.ouDepth - 1] : e.department;

      return {
        ok: true,
        agent: {
          dn: e.dn,
          login: e.sAMAccountName,
          nomComplet: e.displayName || null,
          email: e.mail || null,
          department: e.department || null,
          chaineOu: ous,
          serviceRetenu: service || 'Non rattache',
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

  app.post('/api/admin/configuration/test-smtp', async (requete) => {
    const v = requete.body?.valeurs || {};
    const hote = v['smtp.host'] ?? config.smtp.host;
    const port = Number(v['smtp.port'] ?? config.smtp.port);
    const secure = v['smtp.secure'] ?? config.smtp.secure;
    const utilisateur = v['smtp.user'] ?? config.smtp.user;
    const motDePasse = v['smtp.password'] || config.smtp.password;
    const destinataire = String(requete.body?.destinataire || '').trim();

    if (!hote) return { ok: false, message: 'Aucun serveur SMTP renseigné.' };

    const transport = nodemailer.createTransport({
      host: hote, port, secure,
      auth: utilisateur ? { user: utilisateur, pass: motDePasse } : undefined,
      requireTLS: !secure,
      tls: { rejectUnauthorized: false },
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
