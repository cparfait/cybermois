import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import statique from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import cron from 'node-cron';

import { config } from './lib/config.js';
import { db } from './lib/db.js';
import { purgerSessions } from './lib/session.js';
import { importerContenus } from './lib/seed.js';
import { envoyerRelances, envoyerResultats } from './lib/mail.js';
import { verifierModeDemo, estModeDemo, motDePasseDemo } from './lib/annuaire-demo.js';
import { verifierChiffrement } from './lib/ldap.js';
import { appliquerParametres, configurationUtilisable } from './lib/parametres.js';
import { amorcerAdminLocal } from './lib/admin-local.js';
import { enregistrerStatiques } from './lib/statiques.js';

import routesAuth from './routes/auth.js';
import routesJeu from './routes/jeu.js';
import routesAdmin from './routes/admin.js';
import routesUtilisateurs from './routes/utilisateurs.js';
import routesConfiguration from './routes/configuration.js';
import routesCorrections from './routes/corrections.js';

const app = Fastify({
  logger: {
    level: config.env === 'production' ? 'info' : 'debug',
    // Ne jamais journaliser un mot de passe, meme en cas d'erreur
    redact: ['req.body.motDePasse', 'req.headers.cookie', 'req.headers.authorization'],
  },
  trustProxy: true, // Nginx Proxy Manager en frontal
  bodyLimit: 4 * 1024 * 1024, // marge pour l'import d'un effectif complet en CSV
});

await app.register(cookie, { secret: config.sessionSecret });
await app.register(formbody);
// hook 'preHandler' : indispensable pour que la limitation par compte puisse lire
// le login dans le corps de la requete, qui n'est pas encore analyse en 'onRequest'.
await app.register(rateLimit, { global: false, hook: 'preHandler' });

// En-tetes de securite
app.addHook('onSend', async (requete, reponse) => {
  reponse.header('X-Content-Type-Options', 'nosniff');
  reponse.header('X-Frame-Options', 'DENY');
  reponse.header('Referrer-Policy', 'same-origin');
  reponse.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  reponse.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join('; ')
  );
});

await app.register(statique, {
  root: path.resolve(process.cwd(), 'public'),
  prefix: '/',
  index: false,
  cacheControl: false,
  // Ne sert plus que les images et ressources annexes : elles changent rarement,
  // d'ou un cache long. Le HTML, le JavaScript et les styles passent par
  // enregistrerStatiques, qui fait figurer une empreinte du code dans leur URL.
  setHeaders: (reponse) => {
    reponse.setHeader('Cache-Control', 'public, max-age=604800');
  },
});

await app.register(routesAuth);
await app.register(routesJeu);
await app.register(routesAdmin);
await app.register(routesUtilisateurs);
await app.register(routesConfiguration);
await app.register(routesCorrections);

/* ------------------------------------------------------------------ Pages */

enregistrerStatiques(app, {
  '/': 'index.html',
  '/accueil': 'accueil.html',
  '/defi/:semaine': 'defi.html',
  '/classement': 'classement.html',
  '/profil': 'profil.html',
  '/attestation': 'attestation.html',
  '/mentions': 'mentions.html',
  '/administration': 'admin.html',
  '/configuration': 'admin.html',
});

app.get('/sante', async () => ({
  ok: true,
  version: '1.0.0',
  agents: db.prepare('SELECT COUNT(*) AS n FROM agents').get().n,
  participations: db.prepare('SELECT COUNT(*) AS n FROM participations').get().n,
}));

app.setNotFoundHandler(async (requete, reponse) => {
  if (requete.url.startsWith('/api/')) return reponse.code(404).send({ erreur: 'Route inconnue.' });
  return reponse.code(404).sendFile('404.html');
});

app.setErrorHandler((erreur, requete, reponse) => {
  requete.log.error(erreur);
  const code = erreur.statusCode && erreur.statusCode < 500 ? erreur.statusCode : 500;
  const message = code < 500 ? erreur.message : 'Une erreur interne est survenue.';
  if (requete.url.startsWith('/api/')) return reponse.code(code).send({ erreur: message });
  return reponse.code(code).type('text/html; charset=utf-8').send(`<p>${message}</p>`);
});

/* ---------------------------------------------------------- Planification */

// Taches en cours, pour pouvoir les remplacer quand les horaires changent
// depuis le back-office sans redemarrer le conteneur.
let tachesPlanifiees = [];

export function planifier() {
  for (const t of tachesPlanifiees) { try { t.stop(); } catch { /* deja arretee */ } }
  tachesPlanifiees = [];

  const semaineCourante = () => {
    const debut = new Date(`${config.campagne.debut}T00:00:00`);
    const jours = Math.floor((Date.now() - debut.getTime()) / 86_400_000);
    return Math.min(4, Math.max(1, Math.floor(jours / 7) + 1));
  };

  if (!config.smtp.actif) {
    app.log.warn('Envoi de mails desactive : relances et resultats non planifies.');
    return;
  }

  if (!cron.validate(config.cron.relance) || !cron.validate(config.cron.resultats)) {
    app.log.error(`Expression de planification invalide : relances "${config.cron.relance}", resultats "${config.cron.resultats}". Aucune tache planifiee.`);
    return;
  }

  tachesPlanifiees.push(cron.schedule(config.cron.relance, async () => {
    const s = semaineCourante();
    app.log.info(`Relance automatique - semaine ${s}`);
    const res = await envoyerRelances(s);
    app.log.info(res, 'relances envoyees');
  }, { timezone: config.cron.timezone }));

  tachesPlanifiees.push(cron.schedule(config.cron.resultats, async () => {
    const s = semaineCourante();
    app.log.info(`Resultats automatiques - semaine ${s}`);
    const res = await envoyerResultats(s);
    app.log.info(res, 'resultats envoyes');
  }, { timezone: config.cron.timezone }));

  app.log.info(`Planification active - relances "${config.cron.relance}", resultats "${config.cron.resultats}" (${config.cron.timezone})`);
}

// Permet aux routes de configuration de replanifier apres modification
app.decorate('replanifier', planifier);

// Purge des sessions expirees toutes les heures
cron.schedule('0 * * * *', () => purgerSessions(), { timezone: config.cron.timezone });

/* ------------------------------------------------------------- Demarrage */

try {
  // Les parametres saisis dans le back-office l'emportent sur l'environnement :
  // ils doivent donc etre appliques avant toute verification de configuration.
  const nbParametres = appliquerParametres();
  if (nbParametres) app.log.info(`${nbParametres} parametre(s) charge(s) depuis la base.`);

  // Sans compte local, personne ne pourrait entrer pour configurer l'annuaire.
  const amorce = amorcerAdminLocal();
  if (amorce) {
    app.log.warn('================= COMPTE ADMINISTRATEUR LOCAL CREE =================');
    app.log.warn(`  Identifiant  : ${amorce.login}`);
    app.log.warn(`  Mot de passe : ${amorce.motDePasse}`);
    app.log.warn(amorce.genere
      ? '  Mot de passe genere aleatoirement, affiche une seule fois. Notez-le,'
      : '  Mot de passe repris de ADMIN_LOCAL_MOT_DE_PASSE.');
    app.log.warn('  puis changez-le dans Administration > Configuration.');
    app.log.warn('===================================================================');
  }

  verifierModeDemo();
  if (estModeDemo()) {
    app.log.warn(`MODE DEMONSTRATION actif : annuaire simule, mot de passe commun "${motDePasseDemo()}". Ne jamais utiliser en production.`);
  }

  const avertissement = verifierChiffrement();
  if (avertissement) app.log.warn(avertissement);

  const etat = configurationUtilisable();
  if (!etat.ok) {
    app.log.warn(`Configuration incomplete (${etat.manquants.join(', ')}). `
      + 'Connectez-vous avec le compte local, puis Administration > Configuration.');
  }

  const rapport = importerContenus();
  app.log.info({ rapport }, 'contenus des defis charges');
  planifier();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`Cybermois demarre sur le port ${config.port} - ${config.publicUrl}`);
} catch (erreur) {
  app.log.error(erreur);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    app.log.info('Arret en cours...');
    await app.close();
    db.close();
    process.exit(0);
  });
}
