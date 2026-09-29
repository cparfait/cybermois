import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { dossierVideos, enregistrerVideo, supprimerVideo, placeOccupee, QUOTA_TOTAL, TAILLE_MAX } from './videos.js';
import { reconnaitreVideo } from '../../public/js/video.js';

/**
 * Recuperation sur le serveur d'une video YouTube ou Dailymotion.
 *
 * Dailymotion refuse desormais son lecteur insere sans identifiant de
 * lecteur : les agents voyaient « Forbidden ». Et une video YouTube, c'est
 * cinq cents agents qui la tirent d'Internet la meme semaine. Coller le lien
 * dans l'editeur et laisser le serveur rapatrier le fichier regle les deux :
 * la video est ensuite servie par le portail, comme un fichier depose.
 *
 * Le telechargement est confie a yt-dlp, installe dans l'image Docker. Trois
 * precautions l'encadrent :
 *   - l'adresse transmise n'est jamais celle saisie, mais une adresse
 *     reconstruite a partir du seul identifiant de la video : rien de ce que
 *     l'on colle ne parvient a yt-dlp, qui ne peut donc pas etre detourne vers
 *     une adresse du reseau interne ;
 *   - yt-dlp est borne a l'extracteur de la plateforme : son extracteur
 *     generique, qui suit n'importe quelle page, reste hors d'atteinte ;
 *   - un seul telechargement a la fois, borne en duree et en taille.
 *
 * L'operation dure de quelques secondes a quelques minutes : elle tourne en
 * tache de fond, que l'editeur interroge. Une requete qui attendrait la fin
 * serait coupee par le reverse proxy.
 */

// Plateformes admises, et l'extracteur yt-dlp de chacune.
const PLATEFORMES = {
  YouTube: { extracteur: 'youtube', adresse: (id) => `https://www.youtube.com/watch?v=${id}` },
  // Sans se presenter comme un navigateur, Dailymotion coupe la connexion des
  // la demande de jeton (curl-cffi, installe avec yt-dlp).
  Dailymotion: {
    extracteur: 'dailymotion',
    adresse: (id) => `https://www.dailymotion.com/video/${id}`,
    options: ['--impersonate', 'chrome'],
  },
};

const DUREE_MAX_MS = 15 * 60 * 1000;

/**
 * Adresse canonique a transmettre a yt-dlp, ou `null` si le lien n'est pas
 * une video YouTube ou Dailymotion reconnue.
 */
export function adresseCanonique(lien) {
  const v = reconnaitreVideo(String(lien || '').trim());
  const plateforme = v && PLATEFORMES[v.hebergeur];
  if (!plateforme) return null;
  return { hebergeur: v.hebergeur, id: v.id, adresse: plateforme.adresse(v.id), plateforme };
}

let commande;
/** yt-dlp en commande, ou en module Python. Cherche une fois. `null` s'il manque. */
export function ytDlp() {
  if (commande !== undefined) return commande;
  commande = null;
  for (const [cmd, prefixe] of [['yt-dlp', []], ['python3', ['-m', 'yt_dlp']], ['python', ['-m', 'yt_dlp']]]) {
    const r = spawnSync(cmd, [...prefixe, '--version'], { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0) { commande = { cmd, prefixe, version: r.stdout.trim() }; break; }
  }
  return commande;
}

export const telechargementDisponible = () => !!ytDlp();

const taches = new Map();
let enCours = null;

/** Etat d'une tache, tel que l'editeur l'affiche. */
export const lireTache = (id) => {
  const t = taches.get(id);
  if (!t) return null;
  const { enfant, ...visible } = t;
  return visible;
};

/**
 * Lance le telechargement. Renvoie la tache ; `fin` est appelee une fois
 * termine, reussi ou non - c'est la que l'appelant journalise.
 */
export function lancerTelechargement(lien, { fin } = {}) {
  const cible = adresseCanonique(lien);
  if (!cible) {
    throw Object.assign(new Error('Seul un lien de vidéo YouTube ou Dailymotion peut être téléchargé.'),
      { code: 'LIEN_REFUSE' });
  }
  const outil = ytDlp();
  if (!outil) {
    throw Object.assign(new Error("yt-dlp n'est pas installé sur le serveur : reconstruisez l'image Docker."),
      { code: 'OUTIL_ABSENT' });
  }
  if (enCours) {
    throw Object.assign(new Error('Un téléchargement est déjà en cours. Attendez qu’il se termine.'),
      { code: 'ENVOI_EN_COURS' });
  }
  if (placeOccupee() >= QUOTA_TOTAL) {
    throw Object.assign(new Error('Les vidéos occupent déjà tout l’espace prévu : supprimez un fichier inutilisé.'),
      { code: 'QUOTA_ATTEINT' });
  }

  const tache = {
    id: crypto.randomUUID(),
    hebergeur: cible.hebergeur,
    adresse: cible.adresse,
    etat: 'en cours',
    progression: 0,
    message: 'Démarrage…',
    titre: null,
    resultat: null,
  };
  taches.set(tache.id, tache);
  enCours = tache.id;

  executer(tache, cible, outil)
    .catch((err) => { tache.etat = 'echec'; tache.message = err.message; })
    .finally(() => {
      enCours = null;
      delete tache.enfant;
      // Une heure pour venir lire le resultat, puis on oublie.
      setTimeout(() => taches.delete(tache.id), 60 * 60 * 1000).unref();
      try { fin?.(lireTache(tache.id)); } catch { /* la journalisation ne doit rien casser */ }
    });

  return lireTache(tache.id);
}

async function executer(tache, cible, outil) {
  const dossier = dossierVideos();
  const base = `.telechargement-${tache.id}`;
  const nettoyer = () => {
    for (const f of fs.readdirSync(dossier)) if (f.startsWith(base)) fs.rmSync(path.join(dossier, f), { force: true });
  };

  const args = [
    ...outil.prefixe,
    '--use-extractors', cible.plateforme.extracteur,
    ...(cible.plateforme.options || []),
    '--no-playlist', '--newline', '--no-colors', '--no-mtime', '--encoding', 'utf-8',
    // 720p au plus, en H.264 de preference : lisible par tous les navigateurs,
    // et une video de deux minutes reste loin du plafond du portail.
    '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
    '-S', 'vcodec:h264,acodec:aac',
    '--merge-output-format', 'mp4', '--remux-video', 'mp4',
    '--max-filesize', String(TAILLE_MAX),
    '--no-simulate', '--print', 'before_dl:TITRE %(title)s',
    '-o', path.join(dossier, `${base}.%(ext)s`),
    '--', cible.adresse,
  ];

  const erreurs = [];
  const code = await new Promise((resoudre) => {
    // UTF-8 impose : sans cela, sous Windows, un titre accentue arrivait
    // en « hame�onnage ».
    const enfant = spawn(outil.cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    tache.enfant = enfant;
    const delai = setTimeout(() => { erreurs.push('Délai dépassé : téléchargement interrompu.'); enfant.kill(); }, DUREE_MAX_MS);

    const lire = (flux, surLigne) => {
      let reste = '';
      flux.on('data', (morceau) => {
        const lignes = (reste + morceau.toString('utf8')).split(/\r?\n/);
        reste = lignes.pop();
        lignes.forEach(surLigne);
      });
    };
    lire(enfant.stdout, (ligne) => {
      const titre = ligne.match(/^TITRE (.+)$/);
      if (titre) { tache.titre = titre[1].trim(); return; }
      const pct = ligne.match(/^\[download\]\s+([\d.]+)%/);
      if (pct) { tache.progression = Math.min(99, Math.round(Number(pct[1]))); tache.message = 'Téléchargement…'; return; }
      if (/^\[(Merger|VideoRemuxer|FixupM3u8|VideoConvertor)\]/.test(ligne)) tache.message = 'Assemblage de la vidéo…';
      if (/max-filesize|larger than max/i.test(ligne)) erreurs.push('Vidéo trop volumineuse pour le portail (300 Mo au plus).');
    });
    lire(enfant.stderr, (ligne) => { if (/^ERROR:/.test(ligne)) erreurs.push(ligne.replace(/^ERROR:\s*/, '')); });

    enfant.on('error', (err) => { erreurs.push(err.message); });
    enfant.on('close', (c) => { clearTimeout(delai); resoudre(c); });
  });

  const produit = fs.readdirSync(dossier).find((f) => f.startsWith(base) && f.endsWith('.mp4'));
  if (code !== 0 || !produit) {
    nettoyer();
    tache.etat = 'echec';
    tache.message = (erreurs.at(-1) || `yt-dlp a échoué (code ${code}).`).slice(0, 400);
    return;
  }

  // Meme chemin qu'un fichier depose : nom tire du contenu, meme plafond. Le
  // quota est reverifie, la video pouvant etre plus lourde que prevu.
  tache.message = 'Enregistrement…';
  const fichier = path.join(dossier, produit);
  try {
    // Le fichier provisoire commence par un point : placeOccupee() l'ignore.
    if (placeOccupee() + fs.statSync(fichier).size > QUOTA_TOTAL) {
      throw new Error('Espace réservé aux vidéos dépassé : fichier non conservé.');
    }
    const resultat = await enregistrerVideo(fs.createReadStream(fichier), 'video/mp4');
    tache.resultat = resultat;
  } catch (err) {
    if (tache.resultat) supprimerVideo(tache.resultat.nom);
    throw err;
  } finally {
    nettoyer();
  }
  tache.progression = 100;
  tache.etat = 'termine';
  tache.message = 'Vidéo enregistrée sur le serveur.';
}
