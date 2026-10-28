/**
 * Le classement recompense d'abord la participation.
 *
 * La reussite se lit sur les defis faits. Classe a la reussite d'abord, un
 * agent qui n'avait fait que deux defis, sans faute, passait devant un
 * collegue qui les avait tous faits a 90 %. Ces tests reproduisent ce cas,
 * pour les agents comme pour les directions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('classement-participation', import.meta.url);
const { db } = await import('../src/lib/db.js');
const { classementAgents, classementServices, rangAgent, defisParus } = await import('../src/lib/scoring.js');
nettoyerALaFin(db);

const defi = (id, jours) => {
  db.prepare(`INSERT INTO defis (id, titre, accroche, intro, duree_minutes, ouvre_le, publie)
              VALUES (?, ?, 'a', 'i', 5, date('now', ?), 1)`)
    .run(id, `Defi ${id}`, `${jours} day`);
  db.prepare("INSERT INTO questions (defi_id, enonce, explication, points, ordre) VALUES (?, 'q', 'e', 100, 1)")
    .run(id);
};

const agent = (id, service) => db
  .prepare('INSERT INTO agents (id, login, nom_complet, service) VALUES (?, ?, ?, ?)')
  .run(id, `a${id}`, `AGENT Prenom${id}`, service);

const jouer = (agentId, defiId, score) => db
  .prepare(`INSERT INTO participations (agent_id, defi_id, score, score_max, bonnes, total_questions, entrainement)
            VALUES (?, ?, ?, 100, 1, 1, 0)`)
  .run(agentId, defiId, score);

// Quatre defis parus, et un a venir.
defi(1, -21);
defi(2, -14);
defi(3, -7);
defi(4, -1);
defi(5, +7);

// A ne fait que deux defis, sans faute : 100 % de reussite.
agent(1, 'Direction A');
jouer(1, 1, 100);
jouer(1, 3, 100);

// B fait les quatre, a 90 % : 90 % de reussite.
agent(2, 'Direction B');
for (const d of [1, 2, 3, 4]) jouer(2, d, 90);

test('seuls les defis deja parus comptent dans le nombre de defis', () => {
  assert.equal(defisParus(), 4);
});

test('deux defis sans faute ne passent plus devant quelqu un qui a tout fait', () => {
  const [premier, second] = classementAgents();
  assert.equal(premier.id, 2);
  assert.equal(second.id, 1);
  // Le cas n'a de sens que si A a la meilleure reussite
  assert.ok(second.pourcentage > premier.pourcentage);
  assert.deepEqual(
    [premier.defis_joues, premier.defis_parus, second.defis_joues, second.defis_parus],
    [4, 4, 2, 4],
  );
  assert.equal(rangAgent(2).rang, 1);
});

test('a nombre de defis egal, la reussite departage', () => {
  // C fait deux defis, comme A, mais moins bien
  agent(3, 'Direction C');
  jouer(3, 1, 50);
  jouer(3, 3, 60);
  assert.deepEqual(classementAgents().map((a) => a.id), [2, 1, 3]);
});

test('par direction, la participation passe aussi avant la reussite', () => {
  // Direction A : deux agents, chacun deux defis sans faute.
  // Direction B : deux agents, chacun les quatre a 90 %.
  agent(4, 'Direction A');
  jouer(4, 1, 100);
  jouer(4, 3, 100);
  agent(5, 'Direction B');
  for (const d of [1, 2, 3, 4]) jouer(5, d, 90);

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
  // agents, soit 2 par agent, a egalite avec A - et la reussite departage.
  agent(6, 'Direction B');
  agent(7, 'Direction B');
  const s = Object.fromEntries(classementServices().map((x) => [x.service, x]));
  assert.equal(s['Direction B'].defis_par_agent, 2);
  const ordre = classementServices().map((x) => x.service);
  assert.ok(ordre.indexOf('Direction A') < ordre.indexOf('Direction B'));
});

test('le classement individuel suit les points, pas le nombre de defis', () => {
  // D : un seul defi mais 100 points ; E : quatre defis a 10 points.
  agent(20, 'Direction D');
  jouer(20, 1, 100);
  agent(21, 'Direction E');
  for (const d of [1, 2, 3, 4]) jouer(21, d, 10);
  const ordre = classementAgents().map((a) => a.id);
  assert.ok(ordre.indexOf(20) < ordre.indexOf(21));
});

test('les sans-faute listent les agents et les defis a 100 %', async () => {
  const { agentsSansFaute } = await import('../src/lib/scoring.js');
  const par = Object.fromEntries(agentsSansFaute().map((a) => [a.id, a]));
  assert.equal(par[1].nombre, 2); // A : defis 1 et 3 a 100 %
  assert.deepEqual(par[1].defis, ['Defi 1', 'Defi 3']);
  assert.equal(par[2], undefined); // B : 90 % partout
});
