/**
 * Le classement s'exprime en pourcentage de reussite, pas en points bruts.
 *
 * « 27 pts » ne veut rien dire sans son maximum : le meme chiffre vaut un
 * sans-faute sur un defi et un resultat mediocre sur quatre. Ces tests
 * fixent le denominateur - les defis DEJA PARUS - et verifient que le
 * changement d'unite ne bouscule pas l'ordre du classement, qui reposait
 * jusqu'ici sur la moyenne par agent inscrit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('classement', import.meta.url);
const { db } = await import('../src/lib/db.js');
const { classementServices, classementAgents, pointsPossibles } = await import('../src/lib/scoring.js');
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

defi(1, -1, 100);  // paru hier
defi(2, +7, 500);  // parait dans sept jours

// Service A : cinq agents, un seul joue, sans-faute.
for (let i = 1; i <= 5; i++) agent(i, 'A');
// Service B : deux agents, tous deux jouent a moitie.
for (let i = 6; i <= 7; i++) agent(i, 'B');

jouer(1, 1, 100, 100);
jouer(6, 1, 50, 100);
jouer(7, 1, 50, 100);

test('seuls les defis deja parus entrent dans le total', () => {
  // Compter un defi a venir ferait chuter tout le monde a chaque
  // parution, sans que personne ait demerite.
  assert.equal(pointsPossibles(), 100);
});

test('la reussite d un service est la moyenne de ceux qui ont joue', () => {
  // Rapportee aux points de TOUS ses agents, la reussite de A tombait a 20 % :
  // un seul de ses cinq agents a joue, mais il a fait un sans-faute.
  const s = Object.fromEntries(classementServices().map((x) => [x.service, x]));
  assert.equal(s.A.pourcentage_moyen, 100); // 100 / 100
  assert.equal(s.A.taux_participation, 20); // 1 joueur sur 5
  assert.equal(s.B.pourcentage_moyen, 50); // (50 + 50) / 200
  assert.equal(s.B.taux_participation, 100);
});

test('le classement suit les defis termines par agent inscrit, puis la reussite', () => {
  // A : 1 defi pour 5 inscrits, malgre son sans-faute ; B : 1 defi par agent.
  assert.deepEqual(classementServices().map((s) => s.service), ['B', 'A']);

  // A egalite de defis par agent, la meilleure reussite passe devant.
  agent(8, 'C');
  agent(9, 'C');
  jouer(8, 1, 30, 100);
  jouer(9, 1, 30, 100); // C : 1 defi par agent, 30 % de reussite
  assert.deepEqual(classementServices().map((s) => s.service), ['B', 'C', 'A']);
});

test('un agent voit ses points sur le total atteignable', () => {
  const a = classementAgents();
  assert.equal(a[0].pourcentage, 100);
  assert.equal(a[0].points_possibles, 100);
  assert.equal(a[1].pourcentage, 50);
});

test('la reussite individuelle se lit sur les defis faits, et range le classement', () => {
  // Un deuxieme defi paru : l'agent 10 fait les deux a 70 %, l'agent 11 un
  // seul a 90 %. Rapportee aux defis parus, sa reussite tombait a 45 %.
  db.prepare("UPDATE defis SET ouvre_le = date('now', '-1 day')").run();
  agent(10, 'D'); agent(11, 'D');
  jouer(10, 1, 70, 100); jouer(10, 2, 70, 100);
  jouer(11, 1, 90, 100);
  const a = Object.fromEntries(classementAgents().map((x) => [x.id, x]));
  assert.equal(a[11].pourcentage, 90);
  assert.equal(a[11].score_max_joue, 100);
  assert.equal(a[10].pourcentage, 70);
  // Le classement, lui, compte d'abord les defis faits : voir
  // tests/classement-participation.test.mjs.
  const ordre = classementAgents().map((x) => x.id);
  assert.ok(ordre.indexOf(10) < ordre.indexOf(11), 'deux defis passent devant un seul');

  // A nombre de defis egal, la meilleure reussite passe devant.
  agent(12, 'D');
  jouer(12, 1, 70, 100);
  const ordre2 = classementAgents().map((x) => x.id);
  assert.ok(ordre2.indexOf(11) < ordre2.indexOf(12));
});

test('sans aucun defi paru, aucun pourcentage ne part en division par zero', () => {
  db.prepare("UPDATE defis SET ouvre_le = date('now', '+30 day')").run();
  assert.equal(pointsPossibles(), 0);
  for (const s of classementServices()) assert.equal(s.pourcentage_moyen, 0);
  for (const a of classementAgents()) assert.equal(a.pourcentage, 0);
});
