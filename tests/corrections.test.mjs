/**
 * Correction d'une reponse par l'administration, et sa tracabilite.
 *
 * Ce test existe a cause d'un incident reel : en 2025, des questionnaires
 * corriges en cours de campagne ont laisse des participants avec un resultat
 * faux, sans que personne ne puisse dire qui avait change quoi.
 *
 * On verifie les trois garanties attendues :
 *   - corriger une reponse renote la participation ;
 *   - la correction est tracee avec son auteur, l'avant et l'apres ;
 *   - un administrateur ne peut pas corriger sa propre copie.
 *
 * Les fixtures ne peuvent pas vivre dans une transaction annulee :
 * corrigerReponse() ouvre la sienne, et SQLite n'imbrique pas. On nettoie donc
 * a la main, dans un finally, ce qui porte le prefixe de test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { participationsAgent, corrigerReponse, recalculerDefi } from '../src/lib/corrections.js';

const PREFIXE = 'zz-test-correction-';

/** Monte un agent, une participation et une reponse fausse sur le premier defi. */
function decor(suffixe) {
  const login = PREFIXE + suffixe;
  const defi = db.prepare('SELECT id FROM defis ORDER BY ouvre_le, id LIMIT 1').get();
  const question = db.prepare('SELECT id, points FROM questions WHERE defi_id = ? ORDER BY ordre LIMIT 1')
    .get(defi.id);
  const bonnes = db.prepare('SELECT id FROM reponses WHERE question_id = ? AND correcte = 1')
    .all(question.id).map((r) => r.id);
  const fausses = db.prepare('SELECT id FROM reponses WHERE question_id = ? AND correcte = 0')
    .all(question.id).map((r) => r.id);

  const agent = db.prepare(`
    INSERT INTO agents (login, nom_complet, email, service, service_ad, service_brut, origine, exclu)
    VALUES (?, ?, ?, 'Test technique', 'Test technique', 'CN=test', 'annuaire', 1)
  `).run(login, `TEST ${suffixe}`, `${login}@test.local`);

  const participation = db.prepare(`
    INSERT INTO participations (agent_id, defi_id, score, score_max, bonnes, total_questions, entrainement)
    VALUES (?, ?, 0, ?, 0, 1, 0)
  `).run(agent.lastInsertRowid, defi.id, question.points);

  const reponse = db.prepare(`
    INSERT INTO reponses_agent (participation_id, question_id, choix, correcte, points_obtenus)
    VALUES (?, ?, ?, 0, 0)
  `).run(participation.lastInsertRowid, question.id, JSON.stringify(fausses.slice(0, 1)));

  return {
    login,
    agentId: agent.lastInsertRowid,
    defiId: defi.id,
    reponseId: reponse.lastInsertRowid,
    bonnes,
    pointsQuestion: question.points,
  };
}

function nettoyer() {
  const ids = db.prepare('SELECT id FROM agents WHERE login LIKE ?').all(`${PREFIXE}%`).map((a) => a.id);
  for (const id of ids) {
    db.prepare(`
      DELETE FROM reponses_agent
      WHERE participation_id IN (SELECT id FROM participations WHERE agent_id = ?)
    `).run(id);
    for (const t of ['participations', 'tentatives', 'badges_agent', 'sessions']) {
      db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(id);
    }
    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }
  db.prepare('DELETE FROM corrections WHERE agent_login LIKE ?').run(`${PREFIXE}%`);
  db.prepare('DELETE FROM journal WHERE detail LIKE ?').run(`${PREFIXE}%`);
}

test('une reponse fausse corrigee renote la participation', () => {
  try {
    const d = decor('score');
    const avant = participationsAgent(d.agentId);
    assert.equal(avant.participations.length, 1);
    assert.equal(avant.participations[0].score, 0);

    const r = corrigerReponse(d.reponseId, d.bonnes, {
      parQui: 'zz.admin', ip: '127.0.0.1', motif: 'Question mal formulée',
    });
    assert.equal(r.ok, true, r.message);

    const apres = participationsAgent(d.agentId);
    assert.equal(apres.participations[0].score, d.pointsQuestion,
      'le score doit refleter la correction');
    assert.equal(apres.participations[0].reponses[0].correcte, 1);
  } finally { nettoyer(); }
});

test('la correction laisse une trace nominative', () => {
  try {
    const d = decor('trace');
    corrigerReponse(d.reponseId, d.bonnes, {
      parQui: 'zz.admin', ip: '10.0.0.1', motif: 'Barème revu',
    });

    const trace = db.prepare('SELECT * FROM corrections WHERE agent_login = ? ORDER BY id DESC LIMIT 1')
      .get(d.login);
    assert.ok(trace, 'la correction doit etre tracee');
    assert.equal(trace.par_qui, 'zz.admin');
    assert.equal(trace.motif, 'Barème revu');
    assert.equal(trace.defi_id, d.defiId);
    assert.ok(trace.avant && trace.apres, "l'avant et l'apres doivent etre conserves");
    assert.notEqual(trace.avant, trace.apres);
  } finally { nettoyer(); }
});

test('un administrateur ne peut pas corriger sa propre copie', () => {
  try {
    const d = decor('juge-et-partie');
    const r = corrigerReponse(d.reponseId, d.bonnes, { parQui: d.login, motif: 'Erreur' });

    assert.equal(r.ok, false, 'la correction de sa propre reponse doit etre refusee');
    assert.match(r.message, /propres résultats/i);
    assert.equal(participationsAgent(d.agentId).participations[0].score, 0,
      'le refus ne doit rien avoir modifie');
  } finally { nettoyer(); }
});

test('un choix vide ou invalide est refuse', () => {
  try {
    const d = decor('choix-vide');
    assert.equal(corrigerReponse(d.reponseId, [], { parQui: 'zz.admin' }).ok, false);
    assert.equal(corrigerReponse(d.reponseId, [999999], { parQui: 'zz.admin' }).ok, false,
      'un identifiant de proposition etranger a la question doit etre ecarte');
  } finally { nettoyer(); }
});

test('le recalcul en simulation ne modifie rien', () => {
  try {
    const d = decor('simulation');
    const avant = participationsAgent(d.agentId).participations[0].score;

    const rapport = recalculerDefi(d.defiId, { simulation: true, parQui: 'zz.admin' });
    assert.ok(rapport, 'le recalcul doit rendre un rapport');

    assert.equal(participationsAgent(d.agentId).participations[0].score, avant,
      'une simulation qui ecrit ne serait plus une simulation');
  } finally { nettoyer(); }
});
