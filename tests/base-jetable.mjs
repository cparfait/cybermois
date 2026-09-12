/**
 * Base SQLite jetable, propre a chaque fichier de test.
 *
 * Sans DB_FILE, src/lib/config.js retombe sur data/cybermois.db : les tests
 * creaient et modifiaient la base de PRODUCTION. Deux fichiers lances en
 * parallele - ce que fait « node --test » - s'y marchaient en plus dessus,
 * d'ou des echecs qui ne se reproduisaient jamais isolement.
 *
 * Une contrainte de modules ES pilote la forme de ce fichier : les imports
 * sont hisses, donc « process.env.DB_FILE = ... » ecrit au-dessus d'un import
 * s'execute APRES lui. Il faut donc appeler baseJetable() avant d'importer
 * quoi que ce soit de src/, et importer src/ dynamiquement :
 *
 *   import test from 'node:test';
 *   import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';
 *
 *   baseJetable('apercu', import.meta.url);
 *   const { db } = await import('../src/lib/db.js');
 *   nettoyerALaFin(db);
 */
import fs from 'node:fs';

/** Le .db et ses deux compagnons laisses par le mode WAL. */
const compagnons = (fichier) => [fichier, `${fichier}-wal`, `${fichier}-shm`];

const effacer = (fichier) => {
  for (const f of compagnons(fichier)) {
    // Un fichier encore verrouille par SQLite ne s'efface pas sous Windows :
    // ce n'est pas une raison pour faire echouer le test. Le .gitignore du
    // depot couvre tests/.*.db, le residu ne partira donc jamais au commit.
    try { fs.rmSync(f, { force: true }); } catch { /* base encore ouverte */ }
  }
};

/**
 * Positionne DB_FILE et SESSION_SECRET sur une base dediee au fichier de test,
 * et efface le residu d'une execution precedente. A appeler AVANT tout import
 * de src/.
 *
 * @param {string} nom  Nom du test, qui donne son nom a la base : « apercu »
 *                      pour tests/.apercu-test.db.
 * @param {string} url  import.meta.url du fichier de test appelant.
 * @returns {string}    Chemin absolu de la base jetable.
 */
export function baseJetable(nom, url) {
  // Sous Windows, URL.pathname rend « /C:/... » : le slash de tete doit sauter.
  const fichier = new URL(`./.${nom}-test.db`, url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  process.env.DB_FILE = fichier;
  process.env.SESSION_SECRET = `test-${nom}-0123456789abcdef`;
  effacer(fichier);
  return fichier;
}

/**
 * Ferme la base et efface ses fichiers quand le processus se termine.
 *
 * Le crochet « exit » est retenu plutot que after() de node:test : plusieurs
 * fichiers de tests sont de simples scripts qui appellent process.exit(), ce
 * qui n'attendrait aucun crochet de node:test.
 */
export function nettoyerALaFin(db) {
  const fichier = process.env.DB_FILE;
  process.on('exit', () => {
    try { db.close(); } catch { /* deja fermee */ }
    effacer(fichier);
  });
}
