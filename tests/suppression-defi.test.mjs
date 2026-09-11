/**
 * Supprimer un defi doit tenir.
 *
 * Deux mecanismes le defaisaient :
 *
 *   - le module restait au programme, et importerContenus() - qui s'execute a
 *     chaque demarrage du serveur, donc a chaque deploiement - recreait le
 *     defi. Il revenait seul, et « Supprimer » ne voulait rien dire.
 *   - la deprogrammation comptait les parties d'ENTRAINEMENT comme de vraies
 *     participations : essayer un defi avant l'ouverture le rendait
 *     indeprogrammable a jamais.
 */
process.env.DB_FILE = new URL('./.suppression-defi-test.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.SESSION_SECRET = 'test-suppression-defi-0123456789';

import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

fs.rmSync(process.env.DB_FILE, { force: true });
const { db } = await import('../src/lib/db.js');
const { enregistrerProgramme, lireProgramme } = await import('../src/lib/modules.js');
const { importerContenus } = await import('../src/lib/seed.js');

const MODULE = 'hameconnage';
const AUTRE = 'mots-de-passe';

const defiDu = (code) => db.prepare('SELECT id FROM defis WHERE module_code = ?').get(code);

const jouer = (defiId, entrainement) => db
  .prepare(`INSERT INTO participations (agent_id, defi_id, score, score_max, bonnes, total_questions, entrainement)
            VALUES (1, ?, 5, 10, 1, 1, ?)`).run(defiId, entrainement);

db.prepare("INSERT INTO agents (id, login, nom_complet, service) VALUES (1, 'a1', 'AGENT Un', 'Finances')").run();
enregistrerProgramme([{ module_code: MODULE, ouvre_le: '2026-10-01' }, { module_code: AUTRE, ouvre_le: '2026-10-08' }], 'test');
importerContenus();

test('les modules programmes donnent des defis', () => {
  assert.ok(defiDu(MODULE), `le defi ${MODULE} doit exister`);
  assert.ok(defiDu(AUTRE), `le defi ${AUTRE} doit exister`);
});

test('un defi seulement essaye en entrainement se deprogramme', () => {
  jouer(defiDu(MODULE).id, 1);

  const restant = [{ module_code: AUTRE, ouvre_le: '2026-10-08' }];
  assert.doesNotThrow(() => enregistrerProgramme(restant, 'test'));
  assert.deepEqual(lireProgramme().map((p) => p.module_code), [AUTRE]);
});

test('un defi retire du programme ne revient pas au rechargement des contenus', () => {
  // C'est ce qui fait tenir la suppression : le defi efface reste efface
  db.prepare('DELETE FROM defis WHERE module_code = ?').run(MODULE);
  importerContenus();

  assert.equal(defiDu(MODULE), undefined);
  assert.ok(defiDu(AUTRE), "les autres defis du programme sont intacts");
});

test('un defi vraiment joue reste indeprogrammable', () => {
  jouer(defiDu(AUTRE).id, 0);

  assert.throws(
    () => enregistrerProgramme([], 'test'),
    /deja ete joue pour de vrai/,
    'une vraie participation doit toujours proteger le defi'
  );
});

test('le module supprime reste au catalogue, donc reprogrammable', () => {
  assert.doesNotThrow(
    () => enregistrerProgramme([{ module_code: AUTRE, ouvre_le: '2026-10-08' }, { module_code: MODULE, ouvre_le: '2026-11-02' }], 'test')
  );
  importerContenus();
  assert.ok(defiDu(MODULE), 'le defi reparait quand on reprogramme son module');
});
