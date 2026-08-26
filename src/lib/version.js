import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * De quelle version l'application tourne-t-elle ?
 *
 * Node charge les modules une fois pour toutes : apres une modification du
 * code, le serveur continue de servir l'ancienne version jusqu'au redemarrage,
 * pendant que le navigateur, lui, recoit deja les fichiers neufs. On obtient
 * alors une interface qui appelle des routes inexistantes - un « Route
 * inconnue » que rien n'explique a l'ecran.
 *
 * Ce module compare la date de demarrage a celle des fichiers sur disque et
 * le dit franchement.
 */

const RACINE = process.cwd();
const DEMARRE_LE = new Date();

/** Le commit courant, quand le depot est disponible. Silencieux sinon. */
function commit() {
  try {
    const court = execFileSync('git', ['rev-parse', '--short', 'HEAD'],
      { cwd: RACINE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const sujet = execFileSync('git', ['log', '-1', '--format=%s'],
      { cwd: RACINE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const date = execFileSync('git', ['log', '-1', '--format=%cI'],
      { cwd: RACINE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { court, sujet, date };
  } catch {
    // Image Docker sans depot, ou git absent : ce n'est pas une anomalie.
    return null;
  }
}

/** Date de modification la plus recente sous un dossier, sans le parcourir en entier. */
function plusRecent(dossier, profondeur = 3) {
  let recent = 0;
  const parcourir = (chemin, reste) => {
    let entrees;
    try { entrees = fs.readdirSync(chemin, { withFileTypes: true }); } catch { return; }
    for (const e of entrees) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const complet = path.join(chemin, e.name);
      if (e.isDirectory()) { if (reste > 0) parcourir(complet, reste - 1); continue; }
      try {
        const t = fs.statSync(complet).mtimeMs;
        if (t > recent) recent = t;
      } catch { /* fichier disparu entre-temps */ }
    }
  };
  parcourir(dossier, profondeur);
  return recent;
}

export function versionApplication() {
  const paquet = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8'));

  // Seul le code serveur compte ici : le front est relu a chaque requete,
  // c'est justement ce decalage qui cree la confusion.
  const codeServeur = plusRecent(path.join(RACINE, 'src'));
  const perime = codeServeur > DEMARRE_LE.getTime();

  return {
    version: paquet.version,
    node: process.version,
    commit: commit(),
    demarreLe: DEMARRE_LE.toISOString(),
    codeModifieLe: codeServeur ? new Date(codeServeur).toISOString() : null,
    perime,
    message: perime
      ? 'Le code serveur a été modifié depuis le démarrage. Redémarrez : Node ne recharge '
        + 'pas les modules à chaud, et l’interface appelle peut-être déjà des routes que '
        + 'ce processus ne connaît pas.'
      : null,
  };
}
