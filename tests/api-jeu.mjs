/**
 * Les routes du jeu, appelees sans serveur HTTP en marche.
 *
 * Les garanties a verifier ici - ce qu'on a le droit de cloturer, ce qu'on a
 * le droit d'effacer - vivent dans src/routes/jeu.js, pas dans src/lib. On ne
 * peut donc pas les atteindre en appelant une fonction de bibliotheque.
 *
 * Fastify sait repondre a une requete sans ecouter sur un port : inject()
 * traverse exactement les memes hooks, la meme authentification et les memes
 * gestionnaires que la production. Aucun port n'est ouvert, aucun serveur
 * n'est a lancer avant la suite.
 *
 * Ce fichier importe src/ : il doit donc etre importe DYNAMIQUEMENT, apres
 * l'appel a baseJetable(), sans quoi la base de production serait ouverte.
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

import { db } from '../src/lib/db.js';
import { config } from '../src/lib/config.js';
import { creerSession, COOKIE } from '../src/lib/session.js';
import routesJeu from '../src/routes/jeu.js';

/** Une instance Fastify portant les seules routes du jeu. */
export async function apiJeu() {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(routesJeu);
  await app.ready();
  return app;
}

/** Cree un agent et sa session, et rend l'en-tete cookie a presenter. */
export function agentConnecte(login, { service = 'Test technique' } = {}) {
  const res = db.prepare(
    'INSERT INTO agents (login, nom_complet, email, service) VALUES (?, ?, ?, ?)'
  ).run(login, `TEST ${login}`, `${login}@test.local`, service);

  const id = Number(res.lastInsertRowid);
  return { id, login, cookie: `${COOKIE}=${creerSession(id)}` };
}

/** Date locale au format de la base. Passer par toISOString reculerait d'un jour le soir. */
export function jour(decalage = 0) {
  const d = new Date();
  d.setDate(d.getDate() + decalage);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Cree un defi et ses questions. Chaque question porte deux propositions,
 * dont une seule est correcte.
 */
export function creerDefi({ titre, ouvreLe, publie = 1, questions = 1 }) {
  const res = db.prepare(`
    INSERT INTO defis (titre, accroche, intro, duree_minutes, ouvre_le, publie)
    VALUES (?, 'accroche', 'intro', 5, ?, ?)
  `).run(titre, ouvreLe, publie);
  const defiId = Number(res.lastInsertRowid);

  for (let i = 1; i <= questions; i++) {
    const q = db.prepare(
      'INSERT INTO questions (defi_id, ordre, enonce, points, explication) VALUES (?, ?, ?, 10, ?)'
    ).run(defiId, i, `Question ${i} ?`, 'explication');
    const questionId = Number(q.lastInsertRowid);
    const rep = db.prepare(
      'INSERT INTO reponses (question_id, ordre, libelle, correcte) VALUES (?, ?, ?, ?)'
    );
    rep.run(questionId, 1, 'Bonne', 1);
    rep.run(questionId, 2, 'Mauvaise', 0);
  }

  return defiId;
}

export const questionsDe = (defiId) =>
  db.prepare('SELECT id FROM questions WHERE defi_id = ? ORDER BY ordre').all(defiId);

export const bonneReponse = (questionId) =>
  db.prepare('SELECT id FROM reponses WHERE question_id = ? AND correcte = 1').get(questionId).id;

export const tentatives = (agentId, defiId) => db
  .prepare('SELECT COUNT(*) AS n FROM tentatives WHERE agent_id = ? AND defi_id = ?')
  .get(agentId, defiId).n;

export const participations = (agentId, defiId) => db
  .prepare('SELECT COUNT(*) AS n FROM participations WHERE agent_id = ? AND defi_id = ?')
  .get(agentId, defiId).n;
