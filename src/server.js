import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import statique from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import cron from 'node-cron';

import { config, SECRET_DEFAUT, SECRET_LONGUEUR_MIN } from './lib/config.js';
import { db } from './lib/db.js';
import { purgerSessions, exigerAdmin, DUREE_HEURES } from './lib/session.js';
import { appliquerRetention } from './lib/retention.js';
import { SEUIL_BADGE_DEFI } from './lib/scoring.js';
import { importerContenus } from './lib/seed.js';
import { envoyerRelances, envoyerResultats } from './lib/mail.js';
import { verifierModeDemo, estModeDemo, motDePasseDemo } from './lib/annuaire-demo.js';
import { verifierChiffrement } from './lib/ldap.js';
import { appliquerParametres, configurationUtilisable } from './lib/parametres.js';
import { amorcerAdminLocal } from './lib/admin-local.js';
import { enregistrerStatiques, designeUnFichierHtml } from './lib/statiques.js';
import { dossierVideos, TAILLE_MAX } from './lib/videos.js';

import routesAuth from './routes/auth.js';
import routesJeu from './routes/jeu.js';
import routesAdmin from './routes/admin.js';
import routesUtilisateurs from './routes/utilisateurs.js';
import routesConfiguration from './routes/configuration.js';
import routesCorrections from './routes/corrections.js';

/**
 * Sans secret propre a l'installation, les cookies de session se forgent et
 * les mots de passe enregistres - compte de service Active Directory, relais
 * SMTP - se dechiffrent avec une cle publiee dans le depot. On refuse de
 * demarrer plutot que de servir une campagne dans cet etat.
 *
 * Le refus ne vaut qu'en production : un poste de developpement doit pouvoir
 * demarrer sans ceremonie.
 */
if (config.env === 'production') {
  const secret = config.sessionSecret;
  const probleme = secret === SECRET_DEFAUT
    ? 'SESSION_SECRET n\'est pas renseigne : la valeur de developpement, publique, serait utilisee.'
    : (secret.length < SECRET_LONGUEUR_MIN
      ? `SESSION_SECRET ne fait que ${secret.length} caracteres, ${SECRET_LONGUEUR_MIN} au minimum.`
      : null);

  if (probleme) {
    console.error(`[cybermois] DEMARRAGE REFUSE : ${probleme}`);
    console.error('[cybermois] Cette cle signe les cookies de session et chiffre les mots de passe');
    console.error('[cybermois] Active Directory et SMTP enregistres depuis le back-office.');
    console.error('[cybermois] Generez-la une fois, puis conservez-la :');
    console.error('[cybermois]   node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
    process.exit(1);
  }
}

const app = Fastify({
  logger: {
    level: config.env === 'production' ? 'info' : 'debug',
    // Ne jamais journaliser un mot de passe, meme en cas d'erreur
    redact: ['req.body.motDePasse', 'req.headers.cookie', 'req.headers.authorization'],
  },
  // Les en-tetes X-Forwarded-* ne sont crus que s'ils viennent du reverse
  // proxy declare. « true » les acceptait de n'importe qui : il suffisait
  // d'atteindre le conteneur sans passer par le proxy pour se choisir une
  // adresse IP, donc pour echapper a la limitation de tentatives et falsifier
  // la trace laissee dans le journal.
  trustProxy: config.proxyDeConfiance.length ? config.proxyDeConfiance : false,
  bodyLimit: 4 * 1024 * 1024, // marge pour l'import d'un effectif complet en CSV
});

await app.register(cookie, { secret: config.sessionSecret });
// @fastify/formbody n'est volontairement PAS enregistre.
//
// Le portail ne parle que JSON. Analyser en plus les corps de formulaire
// ouvrait la seule breche que « SameSite=lax » ne ferme pas : un formulaire
// pose sur un site tiers - ou sur un sous-domaine voisin, que « lax » considere
// comme le meme site - pouvait declencher une action d'administration sans
// requete preparatoire, donc sans que le navigateur demande la permission.
// Sans ce greffon, une telle requete est refusee avant d'atteindre la route.
//
// hook 'preHandler' : indispensable pour que la limitation par compte puisse lire
// le login dans le corps de la requete, qui n'est pas encore analyse en 'onRequest'.
await app.register(rateLimit, { global: false, hook: 'preHandler' });
// Televersement des videos. La limite vaut pour ce seul usage : le reste des
// requetes reste borne par bodyLimit, bien plus bas.
await app.register(multipart, { limits: { fileSize: TAILLE_MAX, files: 1 } });

/**
 * Hebergeurs video autorises, pour la politique de securite de contenu.
 *
 * Un nom qui n'est pas un domaine plausible est ecarte : la liste se saisit
 * dans l'administration, et une valeur fantaisiste - un joker, un chemin, un
 * schema autre que https - elargirait la politique bien au-dela de l'intention.
 */
function domainesVideo() {
  const propres = (config.videoDomaines || [])
    .map((d) => String(d).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))
    .filter((d) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(d));

  return propres.length ? propres.map((d) => `https://${d}`).join(' ') : "'none'";
}

/**
 * Verrou d'origine sur toute requete qui modifie quelque chose.
 *
 * « SameSite=lax » empeche un autre SITE de poster ici, mais traite
 * cybermois.chatillon92.fr et n'importe quel autre sous-domaine de
 * chatillon92.fr comme un meme site : une application voisine compromise
 * pouvait donc agir au nom d'un administrateur connecte.
 *
 * Sec-Fetch-Site est envoye par tous les navigateurs a jour et n'est pas
 * falsifiable depuis une page : il dit d'ou part la requete. Quand il manque -
 * client en ligne de commande, script de recette - on se rabat sur Origin. Une
 * requete qui ne porte ni l'un ni l'autre ne vient pas d'un navigateur, et ne
 * peut donc pas etre une requete forgee a l'insu d'un agent.
 */
const METHODES_SURES = new Set(['GET', 'HEAD', 'OPTIONS']);

app.addHook('onRequest', async (requete, reponse) => {
  if (METHODES_SURES.has(requete.method)) return;

  const provenance = requete.headers['sec-fetch-site'];
  if (provenance) {
    if (provenance === 'same-origin' || provenance === 'none') return;
    requete.log.warn({ url: requete.url, provenance }, 'requete refusee : origine croisee');
    return reponse.code(403).send({
      erreur: "Requête refusée : elle ne provient pas du portail.",
      code: 'ORIGINE_REFUSEE',
    });
  }

  const origine = requete.headers.origin;
  if (!origine) return; // ni navigateur, ni victime possible

  const attendues = new Set([config.publicUrl.replace(/\/+$/, '')]);
  if (requete.headers.host) {
    attendues.add(`https://${requete.headers.host}`);
    attendues.add(`http://${requete.headers.host}`);
  }
  if (attendues.has(origine.replace(/\/+$/, ''))) return;

  requete.log.warn({ url: requete.url, origine }, 'requete refusee : origine inattendue');
  return reponse.code(403).send({
    erreur: "Requête refusée : elle ne provient pas du portail.",
    code: 'ORIGINE_REFUSEE',
  });
});

/**
 * Les pages HTML ne se servent que par leurs adresses propres.
 *
 * Le greffon de fichiers statiques publiait aussi public/admin.html : l'ecran
 * d'administration s'ouvrait donc pour tout agent connecte - et meme pour un
 * visiteur - des lors qu'il demandait le fichier par son nom. Ses appels d'API
 * echouaient bien en 403, mais un ecran d'administration qui s'affiche ne se
 * distingue pas, vu de l'utilisateur, d'un droit accorde. Les adresses
 * publiques (/administration, /accueil...) restent servies par
 * enregistrerStatiques, avec leur garde.
 */
// Le controle porte sur le chemin decode : voir designeUnFichierHtml.
app.addHook('onRequest', async (requete, reponse) => {
  if (designeUnFichierHtml(requete.url)) {
    return reponse.code(404).type('text/html; charset=utf-8').send('<p>Page introuvable.</p>');
  }
});

// En-tetes de securite
app.addHook('onSend', async (requete, reponse) => {
  reponse.header('X-Content-Type-Options', 'nosniff');
  reponse.header('X-Frame-Options', 'DENY');
  // Le portail n'est joignable qu'en HTTPS : l'annoncer evite qu'une premiere
  // requete en clair, tapee a la main ou suivie depuis un lien ancien, ne
  // transporte le cookie de session avant la redirection.
  if (config.publicUrl.startsWith('https://')) {
    reponse.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // « same-origin » n'envoyait aucun referent a un tiers : les lecteurs video
  // ne pouvaient donc pas verifier d'ou venait l'insertion, et YouTube la
  // refusait - erreur 153. « strict-origin-when-cross-origin » ne transmet que
  // l'origine, jamais le chemin : le lecteur sait qu'il est appele par
  // cybermois.chatillon92.fr, sans apprendre quel defi un agent est en train
  // de jouer. C'est aussi le defaut des navigateurs modernes.
  reponse.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reponse.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  reponse.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      // Les polices sont servies par le portail. Elles venaient de Google, ce
      // qui transmettait l'adresse IP de chaque agent a un tiers a chaque page
      // - en contradiction avec les mentions legales - et bloquait le rendu
      // sur un reseau interne sans acces Internet.
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      // Le lecteur video n'est insere qu'apres un clic explicite : la page
      // elle-meme n'appelle jamais Google.
      // Hebergeurs video, regles dans l'administration : ajouter une plateforme
      // - l'ANSSI, une autre collectivite - ne doit pas demander un
      // redeploiement. Chaque nom est filtre a l'enregistrement.
      `frame-src ${domainesVideo()}`,
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
  // @fastify/static v10 passe la reponse Fastify, et non la reponse HTTP
  // brute : « setHeader » n'existe plus dessus, c'est « header ».
  setHeaders: (reponse) => {
    reponse.header('Cache-Control', 'public, max-age=604800');
  },
});

// Videos deposees par la collectivite. Elles vivent dans le volume monte, a
// cote de la base : servies d'ici, elles ne sortent pas du reseau interne -
// c'est tout l'interet par rapport a un hebergeur public quand cinq cents
// agents regardent la meme video la meme semaine.
await app.register(statique, {
  root: dossierVideos(),
  prefix: '/videos/',
  decorateReply: false,
  index: false,
  // Le nom du fichier derive de son contenu : une video ne change jamais sous
  // la meme adresse, on peut donc la mettre en cache sans reserve.
  setHeaders: (reponse) => {
    reponse.header('Cache-Control', 'public, max-age=31536000, immutable');
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
  '/defi/:id': 'defi.html',
  // Relire ses reponses sans rejouer : « revoir les corrections » renvoyait
  // au questionnaire, qui repartait en entrainement.
  '/revoir/:id': 'revoir.html',
  '/classement': 'classement.html',
  '/profil': 'profil.html',
  '/attestation': 'attestation.html',
  '/mentions': 'mentions.html',
  // La page d'administration se garde comme ses API. Sans cela elle s'ouvrait
  // pour tout agent connecte : les panneaux echouaient en 403, mais l'ecran
  // etait la, ce qui ressemble a s'y meprendre a un droit accorde.
  '/administration': { fichier: 'admin.html', garde: exigerAdmin },
  '/configuration': { fichier: 'admin.html', garde: exigerAdmin },
});

// Les mentions legales se consultent sans etre connecte : l'adresse de la DPO
// doit donc etre accessible librement. Elle est de toute facon publique - c'est
// meme son objet.
app.get('/api/public/contacts', async () => ({
  dpo: config.contactDpo || null,
  // Reprises par les mentions legales et l'attestation, qui affichaient
  // jusqu'ici des valeurs recopiees a la main - fausses des qu'un reglage
  // changeait.
  dureeSessionHeures: DUREE_HEURES,
  campagne: config.campagne,
  seuilBadgeDefi: Math.round(SEUIL_BADGE_DEFI * 100),
}));

/**
 * Sonde de vie, interrogee par Docker.
 *
 * Elle ne renvoie plus l'effectif ni le nombre de participations : cette route
 * n'exige aucune authentification, et l'etat de mobilisation d'une collectivite
 * n'a pas a se lire depuis le reseau. Le nombre repondait de toute facon a une
 * question que la sonde ne pose pas.
 */
const VERSION = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')
).version;

app.get('/sante', async () => ({ ok: true, version: VERSION }));

app.setNotFoundHandler(async (requete, reponse) => {
  if (requete.url.startsWith('/api/')) return reponse.code(404).send({ erreur: 'Route inconnue.' });
  return reponse.code(404).sendFile('404.html');
});

const echapperHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

app.setErrorHandler((erreur, requete, reponse) => {
  requete.log.error(erreur);
  const code = erreur.statusCode && erreur.statusCode < 500 ? erreur.statusCode : 500;
  const message = code < 500 ? erreur.message : 'Une erreur interne est survenue.';
  if (requete.url.startsWith('/api/')) return reponse.code(code).send({ erreur: message });
  // Le message est echappe : il peut contenir un fragment de l'URL demandee,
  // et une page d'erreur qui renvoie la saisie telle quelle est un script
  // qui s'execute dans le portail.
  return reponse.code(code).type('text/html; charset=utf-8')
    .send(`<p>${echapperHtml(message)}</p>`);
});

/* ---------------------------------------------------------- Planification */

// Taches en cours, pour pouvoir les remplacer quand les horaires changent
// depuis le back-office sans redemarrer le conteneur.
let tachesPlanifiees = [];

export function planifier() {
  for (const t of tachesPlanifiees) { try { t.stop(); } catch { /* deja arretee */ } }
  tachesPlanifiees = [];

  // Le defi que les mails automatiques annoncent : le dernier paru. Un rang
  // calcule sur le calendrier ne veut plus rien dire des lors que les dates de
  // parution sont libres - deux defis peuvent sortir le meme jour, ou aucun de
  // la semaine.
  const defiCourant = () => db.prepare(
    "SELECT id FROM defis WHERE publie = 1 AND ouvre_le <= date('now') ORDER BY ouvre_le DESC, id DESC LIMIT 1"
  ).get()?.id || null;

  if (!config.smtp.actif) {
    app.log.warn('Envoi de mails desactive : relances et resultats non planifies.');
    return;
  }

  if (!cron.validate(config.cron.relance) || !cron.validate(config.cron.resultats)) {
    app.log.error(`Expression de planification invalide : relances "${config.cron.relance}", resultats "${config.cron.resultats}". Aucune tache planifiee.`);
    return;
  }

  tachesPlanifiees.push(cron.schedule(config.cron.relance, async () => {
    const id = defiCourant();
    if (!id) return app.log.warn('Relance automatique ignoree : aucun defi paru.');
    app.log.info(`Relance automatique - defi ${id}`);
    const res = await envoyerRelances(id);
    app.log.info(res, 'relances envoyees');
  }, { timezone: config.cron.timezone }));

  tachesPlanifiees.push(cron.schedule(config.cron.resultats, async () => {
    const id = defiCourant();
    if (!id) return app.log.warn('Resultats automatiques ignores : aucun defi paru.');
    app.log.info(`Resultats automatiques - defi ${id}`);
    const res = await envoyerResultats(id);
    app.log.info(res, 'resultats envoyes');
  }, { timezone: config.cron.timezone }));

  app.log.info(`Planification active - relances "${config.cron.relance}", resultats "${config.cron.resultats}" (${config.cron.timezone})`);
}

// Permet aux routes de configuration de replanifier apres modification
app.decorate('replanifier', planifier);

// Purge des sessions expirees toutes les heures
cron.schedule('0 * * * *', () => purgerSessions(), { timezone: config.cron.timezone });

/**
 * Durees de conservation annoncees dans les mentions legales.
 * Elles n'etaient appliquees nulle part : la page promettait un effacement qui
 * ne se produisait jamais. Une fois par nuit suffit largement.
 */
cron.schedule('30 3 * * *', () => {
  try {
    const rapport = appliquerRetention();
    if (rapport.journal || rapport.participations || rapport.preuves) {
      app.log.info(rapport, 'durees de conservation appliquees');
    }
  } catch (err) {
    app.log.error(err, 'purge des donnees echouee');
  }
}, { timezone: config.cron.timezone });

/* ------------------------------------------------------------- Demarrage */

try {
  // Les parametres saisis dans le back-office l'emportent sur l'environnement :
  // ils doivent donc etre appliques avant toute verification de configuration.
  const nbParametres = appliquerParametres();
  if (nbParametres) app.log.info(`${nbParametres} parametre(s) charge(s) depuis la base.`);

  // Sans compte local, personne ne pourrait entrer pour configurer l'annuaire.
  // Le mot de passe ne figure jamais dans le journal : voir fichierAmorce().
  const amorce = amorcerAdminLocal();
  if (amorce) {
    app.log.warn('================= COMPTE ADMINISTRATEUR LOCAL CREE =================');
    app.log.warn(`  Identifiant  : ${amorce.login}`);
    if (amorce.genere) {
      app.log.warn('  Mot de passe genere aleatoirement, enregistre dans :');
      app.log.warn(`    ${amorce.fichier}`);
      app.log.warn('  Lisez-le depuis la console du conteneur, connectez-vous, puis');
      app.log.warn('  changez-le dans Administration > Configuration : le fichier sera efface.');
    } else {
      app.log.warn('  Mot de passe repris de ADMIN_LOCAL_MOT_DE_PASSE.');
      app.log.warn('  Changez-le dans Administration > Configuration.');
    }
    app.log.warn('===================================================================');
  }

  const demoNeutralise = verifierModeDemo();
  if (demoNeutralise) app.log.error(demoNeutralise);
  if (estModeDemo()) {
    app.log.warn(`MODE DEMONSTRATION actif : annuaire simule, mot de passe commun "${motDePasseDemo()}". Ne jamais utiliser en production.`);
  }

  const avertissement = verifierChiffrement();
  if (avertissement) app.log.warn(avertissement);

  // Le drapeau « Secure » du cookie de session se deduit de cette adresse :
  // en http, le cookie voyage en clair et se lit sur le reseau.
  if (config.env === 'production' && !config.publicUrl.startsWith('https://')) {
    app.log.warn(`PUBLIC_URL=${config.publicUrl} n'est pas en https : le cookie de session `
      + "circulera sans le drapeau Secure, et l'en-tete HSTS n'est pas emis. "
      + 'Corrigez-le dans Administration > Configuration.');
  }

  if (!config.proxyDeConfiance.length) {
    app.log.info("Aucun PROXY_DE_CONFIANCE declare : les en-tetes X-Forwarded-* sont ignores "
      + "et l'adresse vue est celle de la connexion. Derriere un reverse proxy, declarez son "
      + 'adresse, sans quoi toutes les connexions paraissent venir de lui.');
  }

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
