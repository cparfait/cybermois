/**
 * Le classement recompense d'abord la participation.
 *
 * Classe aux seuls points, un agent qui n'avait fait que les deux defis les
 * mieux dotes, sans faute, passait devant un collegue qui les avait tous
 * faits : les baremes vont de 70 a 115 points selon le defi. Ces tests
 * reproduisent ce cas, pour les agents comme pour les directions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('classement-participation', import.meta.url);
const { db } = await import('../src/lib/db.js');
const { classementAgents, classementServices, rangAgent, defisParus } = await import('../src/lib/scoring.js');
nettoyerALaFin(db);

const defi = (id, jours, points) => {
  db.prepare(`INSERT INTO defis (id, titre, accroche, intro, duree_minutes, ouvre_le, publie)
              VALUES (?, ?, 'a', 'i', 5, date('now', ?), 1)`)
    .run(id, `Defi ${id}`, `${jours} day`);
  db.prepare('INSERT INTO questions (defi_id, enonce, explication, points, ordre) VALUES (?, ?, ?, ?, 1)')
    .run(id, 'q', 'e', points);
};

const agent = (id, service) => db
  .prepare('INSERT INTO agents (id, login, nom_complet, service) VALUES (?, ?, ?, ?)')
  .run(id, `a${id}`, `AGENT Prenom${id}`, service);

const jouer = (agentId, defiId, score, max) => db
  .prepare(`INSERT INTO participations (agent_id, defi_id, score, score_max, bonnes, total_questions, entrainement)
            VALUES (?, ?, ?, ?, 1, 1, 0)`)
  .run(agentId, defiId, score, max);

// Quatre defis parus, aux baremes de la campagne reelle, et un a venir.
defi(1, -21, 105); // Hameconnage
defi(2, -14, 80);  // Mots de passe
defi(3, -7, 115);  // Ingenierie sociale
defi(4, -1, 70);   // Messagerie
defi(5, +7, 70);   // pas encore paru

// A ne fait que les deux defis lourds, sans faute : 220 points.
agent(1, 'Direction A');
jouer(1, 1, 105, 105);
jouer(1, 3, 115, 115);

// B fait les quatre, a 55 % environ : 203 points.
agent(2, 'Direction B');
jouer(2, 1, 58, 105);
jouer(2, 2, 44, 80);
jouer(2, 3, 63, 115);
jouer(2, 4, 38, 70);

test('seuls les defis deja parus comptent dans le nombre de defis', () => {
  assert.equal(defisParus(), 4);
});

test('deux defis sans faute ne passent plus devant quelqu un qui a tout fait', () => {
  const [premier, second] = classementAgents();
  assert.equal(premier.id, 2);
  assert.equal(second.id, 1);
  // Le cas n'a de sens que si A a bien plus de points que B
  assert.ok(second.score_total > premier.score_total);
  assert.deepEqual(
    [premier.defis_joues, premier.defis_parus, second.defis_joues, second.defis_parus],
    [4, 4, 2, 4],
  );
  assert.equal(rangAgent(2).rang, 1);
});

test('a nombre de defis egal, les points departagent', () => {
  // C fait les deux memes defis que A, moins bien
  agent(3, 'Direction C');
  jouer(3, 1, 50, 105);
  jouer(3, 3, 60, 115);
  assert.deepEqual(classementAgents().map((a) => a.id), [2, 1, 3]);
});

test('par direction, la participation passe aussi avant les points', () => {
  // Direction A : deux agents, chacun sur les deux defis lourds sans faute.
  // Direction B : deux agents, chacun sur les quatre a 55 %.
  agent(4, 'Direction A');
  jouer(4, 1, 105, 105);
  jouer(4, 3, 115, 115);
  agent(5, 'Direction B');
  jouer(5, 1, 58, 105);
  jouer(5, 2, 44, 80);
  jouer(5, 3, 63, 115);
  jouer(5, 4, 38, 70);

  const s = Object.fromEntries(classementServices().map((x) => [x.service, x]));
  assert.equal(s['Direction A'].defis_par_agent, 2);
  assert.equal(s['Direction B'].defis_par_agent, 4);
  assert.equal(s['Direction B'].defis_parus, 4);
  assert.ok(s['Direction A'].pourcentage_moyen > s['Direction B'].pourcentage_moyen);

  const ordre = classementServices().map((x) => x.service);
  assert.ok(ordre.indexOf('Direction B') < ordre.indexOf('Direction A'));
});

test('un inscrit qui ne joue pas fait baisser la moyenne de sa direction', () => {
  // Deux inscrits sans participation : Direction B tombe a 8 defis pour 4
  // agents, soit 2 par agent, a egalite avec A - et les points departagent.
  agent(6, 'Direction B');
  agent(7, 'Direction B');
  const s = Object.fromEntries(classementServices().map((x) => [x.service, x]));
  assert.equal(s['Direction B'].defis_par_agent, 2);
  const ordre = classementServices().map((x) => x.service);
  assert.ok(ordre.indexOf('Direction A') < ordre.indexOf('Direction B'));
});
