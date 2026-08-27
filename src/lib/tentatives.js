import { db, ajouterColonne } from './db.js';
import { noterQuestion } from './scoring.js';

/**
 * Reponses en cours de saisie, question par question.
 *
 * Le defi se joue desormais une question a la fois, avec correction immediate :
 * on ne peut donc plus attendre la fin pour tout enregistrer. Chaque reponse
 * est conservee ici jusqu'a ce que le defi soit termine, moment ou l'ensemble
 * bascule dans participations.
 *
 * Cela rend aussi le parcours reprenable : une session perdue, un navigateur
 * ferme par megarde, et l'agent retrouve sa progression.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS tentatives (
  agent_id     INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  defi_id      INTEGER NOT NULL REFERENCES defis(id) ON DELETE CASCADE,
  question_id  INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  choix        TEXT NOT NULL,
  points       INTEGER NOT NULL DEFAULT 0,
  points_max   INTEGER NOT NULL DEFAULT 0,
  parfaite     INTEGER NOT NULL DEFAULT 0,
  repondu_le   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, defi_id, question_id)
);
`);

/** Questions deja repondues dans la tentative en cours. */
// Cette migration vit ici, et non dans db.js : la table est creee par ce
// module, qui est charge apres.
// Distingue l'agent qui a oublie une bonne reponse de celui qui s'est trompe.
ajouterColonne('tentatives', 'a_tort', 'INTEGER NOT NULL DEFAULT 0');

// Une reponse donnee en apercu ne doit pas preremplir la vraie tentative :
// on la marque, et le parcours reel efface ces lignes avant de commencer.
ajouterColonne('tentatives', 'apercu', 'INTEGER NOT NULL DEFAULT 0');

export function progression(agentId, defiId) {
  return db.prepare(
    'SELECT question_id, points, points_max, parfaite FROM tentatives WHERE agent_id = ? AND defi_id = ?'
  ).all(agentId, defiId);
}

/** Corrige une question, enregistre la reponse, et renvoie de quoi l'expliquer. */
export function repondre(agentId, defiId, question, choix, { apercu = false } = {}) {
  question.reponses = db.prepare(
    'SELECT id, libelle, correcte FROM reponses WHERE question_id = ? ORDER BY ordre'
  ).all(question.id);

  const note = noterQuestion(question, choix);
  const choisis = [...new Set((choix || []).map(Number))];

  const bonnes = question.reponses.filter((r) => r.correcte);
  const oubliees = bonnes.filter((r) => !choisis.includes(r.id));
  const tort = question.reponses.filter((r) => !r.correcte && choisis.includes(r.id));

  db.prepare(`
    INSERT INTO tentatives (agent_id, defi_id, question_id, choix, points, points_max, parfaite, a_tort, apercu)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, defi_id, question_id) DO UPDATE SET
      choix = excluded.choix, points = excluded.points,
      points_max = excluded.points_max, parfaite = excluded.parfaite,
      a_tort = excluded.a_tort, apercu = excluded.apercu, repondu_le = datetime('now')
  `).run(agentId, defiId, question.id, JSON.stringify(choisis),
    note.points, question.points, note.parfaite ? 1 : 0, tort.length ? 1 : 0, apercu ? 1 : 0);

  return {
    questionId: question.id,
    points: note.points,
    pointsMax: question.points,
    parfaite: note.parfaite,
    explication: question.explication,
    choixAgent: choisis,
    reponses: question.reponses.map((r) => ({
      id: r.id,
      libelle: r.libelle,
      correcte: !!r.correcte,
      choisie: choisis.includes(r.id),
    })),
    // De quoi rediger un retour precis plutot qu'un simple « faux »
    bilan: {
      bonnesTrouvees: bonnes.length - oubliees.length,
      bonnesTotal: bonnes.length,
      oubliees: oubliees.map((r) => r.libelle),
      aTort: tort.map((r) => r.libelle),
    },
  };
}

/** Totaux de la tentative en cours. */
export function totaux(agentId, defiId) {
  return db.prepare(`
    SELECT COUNT(*) AS repondues,
           COALESCE(SUM(points), 0)     AS score,
           COALESCE(SUM(points_max), 0) AS scoreMax,
           COALESCE(SUM(parfaite), 0)   AS parfaites,
           COALESCE(SUM(a_tort), 0)     AS erreurs
    FROM tentatives WHERE agent_id = ? AND defi_id = ?
  `).get(agentId, defiId);
}

export function effacerTentative(agentId, defiId) {
  db.prepare('DELETE FROM tentatives WHERE agent_id = ? AND defi_id = ?').run(agentId, defiId);
}

/** Detail des reponses, pour l'archivage dans reponses_agent. */
export function detailTentative(agentId, defiId) {
  return db.prepare(
    'SELECT question_id, choix, points, parfaite FROM tentatives WHERE agent_id = ? AND defi_id = ?'
  ).all(agentId, defiId);
}

/**
 * Efface les tentatives d'un agent sur un defi.
 *
 * `apercuSeulement` sert avant un parcours reel : les reponses donnees en
 * apercu ne doivent pas le preremplir, sans quoi l'agent trouverait son defi
 * a moitie fait le lundi de l'ouverture.
 */
export function effacerTentatives(agentId, defiId, { apercuSeulement = false } = {}) {
  const condition = apercuSeulement ? ' AND apercu = 1' : '';
  return db.prepare(
    `DELETE FROM tentatives WHERE agent_id = ? AND defi_id = ?${condition}`
  ).run(agentId, defiId).changes;
}
