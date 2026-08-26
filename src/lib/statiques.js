import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Versionnement des fichiers statiques.
 *
 * Le probleme : apres une mise a jour, le navigateur charge le nouveau HTML
 * mais reutilise l'ancien JavaScript garde en cache. Les nouveaux elements
 * s'affichent sans reagir, sans la moindre erreur visible - une panne
 * silencieuse, particulierement penible a diagnostiquer a distance.
 *
 * La parade : faire figurer une empreinte du code dans l'URL des fichiers.
 * A chaque livraison l'URL change, le navigateur ne peut donc pas servir une
 * version perimee. En contrepartie ces URL deviennent immuables et se mettent
 * en cache pour un an, ce qui allege les chargements suivants.
 *
 * Les imports entre modules sont reecrits eux aussi : sans cela, commun.js
 * resterait figé dans sa version en cache.
 */

const RACINE = path.resolve(process.cwd(), 'public');

function calculerEmpreinte() {
  const hachage = crypto.createHash('sha256');
  for (const dossier of ['js', 'css']) {
    const chemin = path.join(RACINE, dossier);
    if (!fs.existsSync(chemin)) continue;
    for (const fichier of fs.readdirSync(chemin).sort()) {
      const infos = fs.statSync(path.join(chemin, fichier));
      hachage.update(`${fichier}:${infos.size}:${infos.mtimeMs}`);
    }
  }
  return hachage.digest('hex').slice(0, 10);
}

let empreinte = calculerEmpreinte();

/** En developpement l'empreinte est recalculee, pour voir ses modifications sans redemarrer. */
export function empreinteCourante() {
  if (config.env !== 'production') empreinte = calculerEmpreinte();
  return empreinte;
}

/** Ajoute l'empreinte aux references de scripts et de feuilles de style. */
export function versionnerHtml(contenu, version) {
  return contenu
    .replace(/(<script[^>]+src=")(\/js\/[^"?]+)(")/g, `$1$2?v=${version}$3`)
    .replace(/(<link[^>]+href=")(\/css\/[^"?]+)(")/g, `$1$2?v=${version}$3`);
}

/** Ajoute l'empreinte aux imports entre modules. */
export function versionnerJs(contenu, version) {
  return contenu.replace(
    /(\bfrom\s+['"])(\/js\/[^'"?]+)(['"])/g,
    `$1$2?v=${version}$3`
  );
}

const CACHE = new Map();

function lireEtTransformer(cheminRelatif, transformer) {
  const version = empreinteCourante();
  const cle = `${cheminRelatif}|${version}`;
  if (CACHE.has(cle)) return CACHE.get(cle);

  const complet = path.join(RACINE, cheminRelatif);
  const contenu = transformer(fs.readFileSync(complet, 'utf8'), version);
  CACHE.set(cle, contenu);
  return contenu;
}

/** Enregistre les routes servant le HTML, le JavaScript et les styles versionnes. */
export function enregistrerStatiques(app, pages) {
  const sansTraversee = (nom) => /^[A-Za-z0-9._-]+$/.test(nom) && !nom.includes('..');

  for (const [route, fichier] of Object.entries(pages)) {
    app.get(route, async (requete, reponse) => reponse
      .type('text/html; charset=utf-8')
      // Le HTML se revalide a chaque fois : c'est lui qui porte les URL versionnees
      .header('Cache-Control', 'no-cache')
      .send(lireEtTransformer(fichier, versionnerHtml)));
  }

  app.get('/js/:fichier', async (requete, reponse) => {
    const { fichier } = requete.params;
    if (!sansTraversee(fichier) || !fichier.endsWith('.js')) {
      return reponse.code(404).send({ erreur: 'Fichier inconnu.' });
    }
    if (!fs.existsSync(path.join(RACINE, 'js', fichier))) {
      return reponse.code(404).send({ erreur: 'Fichier inconnu.' });
    }
    return reponse
      .type('application/javascript; charset=utf-8')
      .header('Cache-Control', requete.query.v ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(lireEtTransformer(path.join('js', fichier), versionnerJs));
  });

  app.get('/css/:fichier', async (requete, reponse) => {
    const { fichier } = requete.params;
    if (!sansTraversee(fichier) || !fichier.endsWith('.css')) {
      return reponse.code(404).send({ erreur: 'Fichier inconnu.' });
    }
    const complet = path.join(RACINE, 'css', fichier);
    if (!fs.existsSync(complet)) return reponse.code(404).send({ erreur: 'Fichier inconnu.' });
    return reponse
      .type('text/css; charset=utf-8')
      .header('Cache-Control', requete.query.v ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(fs.readFileSync(complet, 'utf8'));
  });
}
