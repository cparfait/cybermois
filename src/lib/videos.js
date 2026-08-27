import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Videos hebergees par la collectivite.
 *
 * Une video YouTube ou Dailymotion, ce sont cinq cents agents qui la
 * telechargent depuis Internet la meme semaine. Sur le lien d'une commune, cela
 * se remarque - et rien n'oblige a sortir du reseau pour montrer deux minutes
 * de sensibilisation. Un fichier depose ici est servi depuis le serveur : le
 * trafic reste interne, et aucun tiers n'est appele.
 *
 * Le dossier vit dans le volume monte, a cote de la base : il survit aux
 * redeploiements et part avec la sauvegarde, sans traitement particulier.
 */

const DOSSIER = path.join(path.dirname(config.dbFile), 'videos');

// Formats que tout navigateur recent sait lire sans extension ni greffon.
const FORMATS = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
};

export const TAILLE_MAX = 300 * 1024 * 1024;

export function dossierVideos() {
  fs.mkdirSync(DOSSIER, { recursive: true });
  return DOSSIER;
}

/** Le nom est tire du contenu : deposer deux fois le meme fichier n'en fait qu'un. */
export function nomFichier(empreinte, typeMime) {
  return `${empreinte.slice(0, 16)}${FORMATS[typeMime] || '.mp4'}`;
}

export const formatAccepte = (typeMime) => Object.hasOwn(FORMATS, String(typeMime || ''));
export const formatsLisibles = () => Object.values(FORMATS).join(', ');

/**
 * Enregistre un flux dans le dossier des videos.
 *
 * L'ecriture passe par un fichier temporaire puis un renommage : une coupure
 * en cours de televersement laisserait sinon un fichier tronque portant un nom
 * valide, que l'application servirait sans se douter de rien.
 */
export async function enregistrerVideo(flux, typeMime) {
  if (!formatAccepte(typeMime)) {
    throw new Error(`Format ${typeMime} non pris en charge. Attendu : ${formatsLisibles()}.`);
  }

  const dossier = dossierVideos();
  const provisoire = path.join(dossier, `.envoi-${crypto.randomUUID()}`);
  const hachage = crypto.createHash('sha256');
  let octets = 0;

  const sortie = fs.createWriteStream(provisoire);
  try {
    for await (const morceau of flux) {
      octets += morceau.length;
      if (octets > TAILLE_MAX) throw new Error('Fichier trop volumineux.');
      hachage.update(morceau);
      if (!sortie.write(morceau)) {
        await new Promise((r) => sortie.once('drain', r));
      }
    }
    await new Promise((r, j) => sortie.end((e) => (e ? j(e) : r())));
  } catch (err) {
    sortie.destroy();
    fs.rmSync(provisoire, { force: true });
    throw err;
  }

  if (!octets) {
    fs.rmSync(provisoire, { force: true });
    throw new Error('Fichier vide.');
  }

  const nom = nomFichier(hachage.digest('hex'), typeMime);
  fs.renameSync(provisoire, path.join(dossier, nom));
  return { nom, octets, url: `/videos/${nom}` };
}

/** Une video locale se reconnait a son chemin : c'est ce qui evite d'appeler un tiers. */
export const estVideoLocale = (url) => /^\/videos\/[A-Za-z0-9._-]+$/.test(String(url || ''));

export function listerVideos() {
  const dossier = dossierVideos();
  return fs.readdirSync(dossier)
    .filter((f) => !f.startsWith('.'))
    .map((f) => {
      const infos = fs.statSync(path.join(dossier, f));
      return { nom: f, url: `/videos/${f}`, octets: infos.size, depose_le: infos.mtime.toISOString() };
    })
    .sort((a, b) => b.depose_le.localeCompare(a.depose_le));
}

/**
 * Supprime un fichier, a condition qu'aucun defi ne s'en serve encore.
 * Le controle appartient a l'appelant, qui seul connait la base.
 */
export function supprimerVideo(nom) {
  if (!/^[A-Za-z0-9._-]+$/.test(nom)) throw new Error('Nom de fichier invalide.');
  const complet = path.join(dossierVideos(), nom);
  if (!fs.existsSync(complet)) return false;
  fs.rmSync(complet);
  return true;
}
