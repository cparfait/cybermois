import { authentifier } from '../lib/ldap.js';
import { enregistrerGroupes } from '../lib/groupes.js';
import { estModeDemo, authentifierDemo } from '../lib/annuaire-demo.js';
import { resoudreService } from '../lib/services.js';
import { verifierAdminLocal, existeAdminLocal } from '../lib/admin-local.js';
import { db, journaliser, SERVICE_NON_RATTACHE } from '../lib/db.js';
import { config } from '../lib/config.js';
import { creerSession, detruireSession, lireSession, COOKIE, optionsCookie } from '../lib/session.js';
import { prenomUsuel } from '../lib/prenom.js';
import {
  attenteCompte, attenteIp, noterEchecCompte, noterEchecIp, oublierCompte,
} from '../lib/limitation-connexion.js';

const MESSAGES = {
  identifiants_vides: 'Merci de saisir votre identifiant et votre mot de passe.',
  compte_inconnu: 'Identifiant ou mot de passe incorrect.',
  compte_ambigu: 'Identifiant ou mot de passe incorrect.',
  mot_de_passe_invalide: 'Identifiant ou mot de passe incorrect.',
  compte_desactive: 'Ce compte est désactivé. Contactez la DSI.',
  hors_perimetre: "Votre compte n'est pas inclus dans le périmètre du Cybermois.",
  exclu: "Votre compte n'est pas inclus dans la campagne. Contactez la DSI si c'est une erreur.",
  annuaire_indisponible: "L'annuaire est momentanément injoignable. Réessayez dans quelques instants.",
  liaison_non_chiffree: "La liaison avec l'annuaire n'est pas chiffrée : la connexion "
    + 'est refusée par sécurité. Prévenez la DSI.',
};

// Echecs qui disent qu'on cherche un couple identifiant / mot de passe, par
// opposition a un annuaire injoignable ou a un compte hors campagne.
const ECHECS_IDENTIFICATION = new Set(['compte_inconnu', 'compte_ambigu', 'mot_de_passe_invalide']);

const minutes = (secondes) => Math.max(1, Math.ceil(secondes / 60));

/** Refus commun : trop d'echecs depuis cette adresse. */
function refusIp(requete, reponse, attente) {
  requete.log.warn({ ip: requete.ip }, 'connexion refusee : trop d echecs depuis cette adresse');
  return reponse.code(429).header('Retry-After', attente).send({
    erreur: `Trop de tentatives de connexion depuis ce poste. Réessayez dans ${minutes(attente)} minute(s).`,
    code: 'TROP_DE_TENTATIVES',
  });
}

export default async function routesAuth(app) {
  // Deux limitations se superposent. Celle-ci borne le nombre de REQUETES par
  // compte, succes compris. Celle de limitation-connexion.js compte les ECHECS,
  // par compte (sous le seuil de verrouillage AD) et par adresse IP (contre
  // l'essai d'un meme mot de passe sur tous les comptes) : compter les echecs
  // et non les requetes evite de bloquer un etage entier derriere une meme IP
  // a l'heure ou tout le monde se connecte.
  app.post('/api/connexion', {
    config: {
      rateLimit: {
        max: 8,
        timeWindow: '5 minutes',
        keyGenerator: (requete) => {
          const login = String(requete.body?.login || '').trim().toLowerCase();
          return login ? `compte:${login}` : `ip:${requete.ip}`;
        },
        errorResponseBuilder: () => ({
          statusCode: 429,
          erreur: 'Trop de tentatives sur ce compte. Réessayez dans quelques minutes ou contactez la DSI.',
        }),
      },
    },
  }, async (requete, reponse) => {
    const { login, motDePasse } = requete.body || {};
    const ip = requete.ip;

    // Avant tout controle : une adresse qui essaie un mot de passe sur tous
    // les comptes ne doit plus rien apprendre, compte local compris.
    const attenteAdresse = attenteIp(ip);
    if (attenteAdresse) return refusIp(requete, reponse, attenteAdresse);

    // Comptes locaux d'abord : la verification est locale et immediate, et cela
    // evite d'exiger de l'administrateur qu'il pense a basculer le formulaire.
    // Meme principe que dans les autres applications de la collectivite.
    const local = verifierAdminLocal(login, motDePasse);
    if (local.ok) {
      const token = creerSession(local.agent.id);
      journaliser(local.agent.login, 'connexion_locale_ok', 'via le formulaire commun', ip);
      return reponse
        .setCookie(COOKIE, token, optionsCookie())
        .send({
          ok: true,
          local: true,
          provisoire: local.provisoire,
          agent: { nomComplet: local.agent.nom_complet, service: local.agent.service, estAdmin: true },
        });
    }

    // Compte deja trop essaye : on n'interroge meme pas l'annuaire, chaque bind
    // refuse le rapprochant du verrouillage AD. authentifier() refait ce
    // controle sur l'identifiant canonique, quelle que soit la graphie saisie.
    const attenteSaisie = attenteCompte(login);
    const resultat = attenteSaisie
      ? { ok: false, motif: 'trop_de_tentatives', compte: login, attente: attenteSaisie }
      : (estModeDemo()
        ? await authentifierDemo(login, motDePasse)
        : await authentifier(login, motDePasse));

    if (!resultat.ok) {
      if (resultat.motif === 'trop_de_tentatives') {
        requete.log.warn({ login, ip }, 'connexion refusee : compte trop essaye');
        return reponse.code(429).header('Retry-After', resultat.attente).send({
          erreur: "Trop de mots de passe erronés sur ce compte. Pour éviter le verrouillage de "
            + `votre session Windows, réessayez dans ${minutes(resultat.attente)} minute(s).`,
          code: 'TROP_DE_TENTATIVES',
        });
      }
      if (ECHECS_IDENTIFICATION.has(resultat.motif) || local.motif === 'mot_de_passe_invalide') {
        noterEchecIp(ip);
      }
      if (resultat.motif === 'mot_de_passe_invalide') noterEchecCompte(resultat.compte || login);

      journaliser(login, 'connexion_echec', resultat.motif + (resultat.erreur ? ` (${resultat.erreur})` : ''), ip);
      requete.log.warn({ login, motif: resultat.motif }, 'echec de connexion');

      // Un identifiant connu comme compte local mais dont le mot de passe ne
      // passe pas : le dire, plutot que de laisser chercher du cote de l'annuaire.
      if (local.motif === 'mot_de_passe_invalide') {
        return reponse.code(401).send({
          erreur: "Mot de passe incorrect pour ce compte d'administration locale.",
        });
      }
      return reponse.code(401).send({ erreur: MESSAGES[resultat.motif] || 'Connexion impossible.' });
    }

    const a = resultat.agent;

    // Un agent explicitement exclu par l'administration ne doit pas pouvoir
    // recreer sa fiche en se reconnectant. Un administrateur y echappe : il
    // doit toujours pouvoir entrer, meme ecarte de la campagne.
    const fiche = db.prepare('SELECT exclu FROM agents WHERE login = ?').get(a.login);
    const adminConnecte = a.adminParGroupe || config.adminLogins.includes(a.login);
    if (fiche?.exclu && !adminConnecte) {
      journaliser(a.login, 'connexion_refusee', 'agent exclu de la campagne', ip);
      return reponse.code(403).send({ erreur: MESSAGES.exclu });
    }

    // Administrateur soit par appartenance au groupe AD dedie, soit par la
    // liste d'identifiants - qui reste utile pour un depannage ponctuel.
    const estAdmin = (a.adminParGroupe || config.adminLogins.includes(a.login)) ? 1 : 0;
    // On retient d'ou vient le droit : la configuration doit pouvoir revoquer
    // un identifiant retire de la liste sans toucher aux membres du groupe.
    const sourceAdmin = a.adminParGroupe ? 'groupe'
      : (config.adminLogins.includes(a.login) ? 'liste' : null);

    // Creation ou mise a jour de la fiche agent : le service est resynchronise a chaque connexion
    // Le libelle lu dans l'annuaire est conserve tel quel dans service_ad ;
    // service porte le regroupement retenu pour la campagne.
    // a.service vaut null quand l'annuaire ne dit rien : ni l'attribut, ni
    // l'OU du DN. Une premiere connexion cree alors la fiche en
    // « Non rattache », mais une connexion suivante ne doit pas y faire
    // retomber un agent deja rattache. C'est service_ad, laisse a NULL, qui
    // porte ce silence jusqu'au ON CONFLICT.
    const serviceAffiche = a.service ? resoudreService(a.service) : null;

    db.prepare(`
      INSERT INTO agents (login, nom_complet, prenom, email, service, service_ad, service_brut,
                          est_admin, admin_source, vu_le)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(login) DO UPDATE SET
        nom_complet = excluded.nom_complet,
        -- COALESCE : un annuaire sans givenName ne doit pas effacer un
        -- prenom deja connu par ailleurs.
        prenom      = COALESCE(excluded.prenom, agents.prenom),
        email       = excluded.email,
        -- Une direction affectee a la main dans le back-office ne se defait
        -- pas a la connexion suivante : l'annuaire ne fait foi que par defaut.
        -- Et un annuaire muet sur le service n'en est pas une : il laisse la
        -- fiche telle qu'elle est.
        service     = CASE WHEN agents.service_force = 1 OR excluded.service_ad IS NULL
                           THEN agents.service    ELSE excluded.service    END,
        service_ad  = CASE WHEN agents.service_force = 1 OR excluded.service_ad IS NULL
                           THEN agents.service_ad ELSE excluded.service_ad END,
        service_brut= excluded.service_brut,
        est_admin   = excluded.est_admin,
        -- D'ou vient le droit : la configuration peut ainsi revoquer un
        -- identifiant retire de la liste sans toucher aux membres du groupe.
        admin_source= excluded.admin_source,
        vu_le       = datetime('now')
    `).run(a.login, a.nomComplet, a.prenom || null, a.email,
           serviceAffiche || SERVICE_NON_RATTACHE, a.service || null, a.serviceBrut,
           estAdmin, sourceAdmin);

    oublierCompte(a.login);
    oublierCompte(login);

    const agent = db.prepare('SELECT * FROM agents WHERE login = ?').get(a.login);
    // Les groupes servent a cibler ou ecarter des mails : ceux de la connexion
    // sont les plus frais.
    if (Array.isArray(a.groupes)) enregistrerGroupes(agent.id, a.groupes);
    const token = creerSession(agent.id);
    journaliser(a.login, 'connexion_ok',
      `service=${agent.service} (annuaire: ${a.service || 'rien'})`, ip);

    return reponse
      .setCookie(COOKIE, token, optionsCookie())
      .send({
        ok: true,
        agent: { nomComplet: agent.nom_complet, service: agent.service, estAdmin: !!agent.est_admin },
      });
  });

  /**
   * Connexion par compte local, independante de l'annuaire.
   * Indispensable pour saisir la configuration LDAP avant qu'elle n'existe,
   * et pour reprendre la main si l'annuaire devient injoignable.
   */
  app.post('/api/connexion-locale', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '10 minutes',
        keyGenerator: (requete) => `local:${String(requete.body?.login || '').trim().toLowerCase() || requete.ip}`,
        errorResponseBuilder: () => ({
          statusCode: 429,
          erreur: 'Trop de tentatives sur ce compte local. Réessayez dans quelques minutes.',
        }),
      },
    },
  }, async (requete, reponse) => {
    const { login, motDePasse } = requete.body || {};
    const attenteAdresse = attenteIp(requete.ip);
    if (attenteAdresse) return refusIp(requete, reponse, attenteAdresse);

    const resultat = verifierAdminLocal(login, motDePasse);

    if (!resultat.ok) {
      if (resultat.motif !== 'identifiants_vides') noterEchecIp(requete.ip);
      journaliser(login, 'connexion_locale_echec', resultat.motif, requete.ip);
      requete.log.warn({ login, motif: resultat.motif }, 'echec de connexion locale');
      return reponse.code(401).send({ erreur: 'Identifiant ou mot de passe incorrect.' });
    }

    const token = creerSession(resultat.agent.id);
    journaliser(resultat.agent.login, 'connexion_locale_ok', null, requete.ip);

    return reponse
      .setCookie(COOKIE, token, optionsCookie())
      .send({
        ok: true,
        local: true,
        provisoire: resultat.provisoire,
        agent: { nomComplet: resultat.agent.nom_complet, service: resultat.agent.service, estAdmin: true },
      });
  });

  /** Indique au formulaire s'il doit proposer la connexion locale. */
  app.get('/api/mode-connexion', async () => ({
    annuaire: config.ldap.url !== 'demo' || true,
    demonstration: estModeDemo(),
    compteLocal: existeAdminLocal(),
  }));

  app.post('/api/deconnexion', async (requete, reponse) => {
    const agent = lireSession(requete.cookies?.[COOKIE]);
    if (agent) journaliser(agent.login, 'deconnexion', null, requete.ip);
    detruireSession(requete.cookies?.[COOKIE]);
    return reponse.clearCookie(COOKIE, { path: '/' }).send({ ok: true });
  });

  app.get('/api/moi', async (requete, reponse) => {
    const agent = lireSession(requete.cookies?.[COOKIE]);
    if (!agent) return reponse.code(401).send({ erreur: 'Non connecté' });
    return {
      nomComplet: agent.nom_complet,
      prenom: prenomUsuel(agent.nom_complet, agent.prenom),
      login: agent.login,
      service: agent.service,
      estAdmin: !!agent.est_admin,
    };
  });
}
