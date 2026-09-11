/**
 * Le classement collectif ne retient que les directions du referentiel.
 *
 * Sans ce filtre, chaque libelle d'annuaire non rattache formait sa propre
 * ligne : le classement annoncait cinquante « directions » la ou la
 * collectivite en compte cinq, et la premiere place se jouait entre des
 * services de trois agents.
 *
 * Deux graphies d'une meme direction doivent aussi se rejoindre sous
 * l'orthographe du referentiel, qui fait foi.
 */
process.env.DB_FILE = new URL('./.classement-ref-test.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.SESSION_SECRET = 'test-classement-ref-0123456789';

import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

fs.rmSync(process.env.DB_FILE, { force: true });
const { db } = await import('../src/lib/db.js');
const { classementServices, rangService, statistiquesGlobales } = await import('../src/lib/scoring.js');
const { enregistrerReferentiel } = await import('../src/lib/referentiel.js');

db.prepare(`INSERT INTO defis (id, titre, accroche, intro, duree_minutes, ouvre_le, publie)
            VALUES (1, 'Defi', 'a', 'i', 5, date('now', '-1 day'), 1)`).run();
db.prepare("INSERT INTO questions (defi_id, enonce, explication, points, ordre) VALUES (1, 'q', 'e', 10, 1)").run();

const agent = (id, service) => db
  .prepare('INSERT INTO agents (id, login, nom_complet, service) VALUES (?, ?, ?, ?)')
  .run(id, `a${id}`, `AGENT Prenom${id}`, service);

const jouer = (agentId, score) => db
  .prepare(`INSERT INTO participations (agent_id, defi_id, score, score_max, bonnes, total_questions, entrainement)
            VALUES (?, 1, ?, 10, 1, 1, 0)`).run(agentId, score);

// Deux directions du referentiel, dont une ecrite autrement dans l'annuaire,
// et deux libelles qui n'y figurent pas du tout.
agent(1, 'Finances');
agent(2, 'Finances');
agent(3, 'Population et Citoyennete'); // graphie du referentiel
agent(4, 'Population & Citoyenneté');  // meme direction, autre graphie
agent(5, 'Elus de la Majorite');       // hors referentiel
agent(6, 'Kid Club');                  // hors referentiel
jouer(1, 10);
jouer(3, 5);
jouer(5, 10);

test('sans referentiel, toutes les directions sont classees', () => {
  assert.equal(classementServices().length, 5);
});

test('avec un referentiel, seules ses directions paraissent', () => {
  enregistrerReferentiel(['Finances', 'Population et Citoyennete'], 'test');

  const noms = classementServices().map((s) => s.service).sort();
  assert.deepEqual(noms, ['Finances', 'Population et Citoyennete']);
});

test('deux graphies d une meme direction se rejoignent sous celle du referentiel', () => {
  const pop = classementServices().find((s) => s.service === 'Population et Citoyennete');
  // Les agents 3 et 4 comptent pour la meme direction, pas pour deux lignes
  assert.equal(pop.inscrits, 2);
  assert.equal(pop.joueurs, 1);
  assert.equal(pop.score_total, 5);
});

test('les agents hors referentiel ne comptent ni au numerateur ni au denominateur', () => {
  const lignes = classementServices();
  const inscrits = lignes.reduce((n, s) => n + s.inscrits, 0);
  const points = lignes.reduce((n, s) => n + s.score_total, 0);

  // Six agents en base, mais seuls les quatre rattaches entrent au classement
  assert.equal(inscrits, 4);
  // Les 10 points de l'agent 5, hors referentiel, ne gonflent aucune direction
  assert.equal(points, 15);
});

test('une direction hors referentiel n a pas de rang, et le dit', () => {
  assert.deepEqual(
    { rang: rangService('Finances').rang, hors: rangService('Finances').horsReferentiel },
    { rang: 1, hors: false }
  );

  const absente = rangService('Kid Club');
  assert.equal(absente.rang, null);
  assert.equal(absente.horsReferentiel, true);
});

test('le nombre de directions annonce est celui du tableau', () => {
  assert.equal(statistiquesGlobales().services, classementServices().length);
});
