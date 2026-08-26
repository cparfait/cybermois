import { authentifier } from '../lib/ldap.js';
import { estModeDemo, authentifierDemo } from '../lib/annuaire-demo.js';
import { resoudreService } from '../lib/services.js';
import { db, journaliser } from '../lib/db.js';
import { config } from '../lib/config.js';
import { creerSession, detruireSession, lireSession, COOKIE, optionsCookie } from '../lib/session.js';

const MESSAGES = {
  identifiants_vides: 'Merci de saisir votre identifiant et votre mot de passe.',
  compte_inconnu: 'Identifiant ou mot de passe incorrect.',
  compte_ambigu: 'Identifiant ou mot de passe incorrect.',
  mot_de_passe_invalide: 'Identifiant ou mot de passe incorrect.',
  compte_desactive: 'Ce compte est désactivé. Contactez la DSI.',
  hors_perimetre: "Votre compte n'est pas inclus dans le périmètre du Cybermois.",
  exclu: "Votre compte n'est pas inclus dans la campagne. Contactez la DSI si c'est une erreur.",
  annuaire_indisponible: "L'annuaire est momentanément injoignable. Réessayez dans quelques instants.",
};

export default async function routesAuth(app) {
  // Limitation des tentatives, indexee sur le COMPTE et non sur l'adresse IP.
  // Derriere le reverse proxy, tous les agents peuvent partager une meme IP :
  // limiter par IP bloquerait des agents legitimes des la 9e connexion du matin.
  // Indexer par compte protege chaque compte du bourrage d'identifiants sans
  // penaliser les autres agents.
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

    const resultat = estModeDemo()
      ? await authentifierDemo(login, motDePasse)
      : await authentifier(login, motDePasse);

    if (!resultat.ok) {
      journaliser(login, 'connexion_echec', resultat.motif + (resultat.erreur ? ` (${resultat.erreur})` : ''), ip);
      requete.log.warn({ login, motif: resultat.motif }, 'echec de connexion');
      return reponse.code(401).send({ erreur: MESSAGES[resultat.motif] || 'Connexion impossible.' });
    }

    const a = resultat.agent;

    // Un agent explicitement exclu par l'administration ne doit pas pouvoir
    // recreer sa fiche en se reconnectant.
    const fiche = db.prepare('SELECT exclu FROM agents WHERE login = ?').get(a.login);
    if (fiche?.exclu) {
      journaliser(a.login, 'connexion_refusee', 'agent exclu de la campagne', ip);
      return reponse.code(403).send({ erreur: MESSAGES.exclu });
    }

    const estAdmin = config.adminLogins.includes(a.login) ? 1 : 0;

    // Creation ou mise a jour de la fiche agent : le service est resynchronise a chaque connexion
    // Le libelle lu dans l'annuaire est conserve tel quel dans service_ad ;
    // service porte le regroupement retenu pour la campagne.
    const serviceAffiche = resoudreService(a.service);

    db.prepare(`
      INSERT INTO agents (login, nom_complet, email, service, service_ad, service_brut, est_admin, vu_le)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(login) DO UPDATE SET
        nom_complet = excluded.nom_complet,
        email       = excluded.email,
        service     = excluded.service,
        service_ad  = excluded.service_ad,
        service_brut= excluded.service_brut,
        est_admin   = excluded.est_admin,
        vu_le       = datetime('now')
    `).run(a.login, a.nomComplet, a.email, serviceAffiche, a.service, a.serviceBrut, estAdmin);

    const agent = db.prepare('SELECT * FROM agents WHERE login = ?').get(a.login);
    const token = creerSession(agent.id);
    journaliser(a.login, 'connexion_ok', `service=${serviceAffiche} (annuaire: ${a.service})`, ip);

    return reponse
      .setCookie(COOKIE, token, optionsCookie())
      .send({
        ok: true,
        agent: { nomComplet: agent.nom_complet, service: agent.service, estAdmin: !!agent.est_admin },
      });
  });

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
      login: agent.login,
      service: agent.service,
      estAdmin: !!agent.est_admin,
    };
  });
}
