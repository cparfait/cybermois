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

test('la reussite d un service rapporte ses points a ceux de TOUS ses agents', () => {
  const s = Object.fromEntries(classementServices().map((x) => [x.service, x]));
  assert.equal(s.A.points_possibles, 500); // 5 agents x 100 points
  assert.equal(s.A.pourcentage_moyen, 20); // 100 / 500
  assert.equal(s.B.points_possibles, 200);
  assert.equal(s.B.pourcentage_moyen, 50); // 100 / 200
});

test('l ordre du classement des services est inchange', () => {
  // Le denominateur est proportionnel au nombre d'inscrits : le pourcentage
  // classe donc exactement comme la moyenne par agent qu'il remplace.
  assert.deepEqual(classementServices().map((s) => s.service), ['B', 'A']);
});

test('un agent voit ses points sur le total atteignable', () => {
  const a = classementAgents();
  assert.equal(a[0].pourcentage, 100);
  assert.equal(a[0].points_possibles, 100);
  assert.equal(a[1].pourcentage, 50);
});

test('sans aucun defi paru, aucun pourcentage ne part en division par zero', () => {
  db.prepare("UPDATE defis SET ouvre_le = date('now', '+30 day')").run();
  assert.equal(pointsPossibles(), 0);
  for (const s of classementServices()) assert.equal(s.pourcentage_moyen, 0);
  for (const a of classementAgents()) assert.equal(a.pourcentage, 0);
});
