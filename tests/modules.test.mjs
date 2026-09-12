/**
 * Verifie que le catalogue de modules est jouable.
 *
 * Un questionnaire sans bonne reponse, ou dont toutes les propositions sont
 * justes, ne se detecte qu'au moment ou un agent le joue - c'est-a-dire trop
 * tard. Ce test lit les fichiers du catalogue, sans serveur ni base.
 *
 *   node --test tests/modules.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

// Le catalogue se lit sur disque, mais src/lib/modules.js charge db.js :
// l'importer creait et ouvrait data/cybermois.db, la base de PRODUCTION.
baseJetable('modules', import.meta.url);
const { db } = await import('../src/lib/db.js');
const { listerModules, lireModule } = await import('../src/lib/modules.js');
nettoyerALaFin(db);

const modules = listerModules();

test('le catalogue n\'est pas vide', () => {
  assert.ok(modules.length >= 4, `${modules.length} module(s) seulement`);
});

test('les codes sont uniques', () => {
  const codes = modules.map((m) => m.code);
  assert.equal(new Set(codes).size, codes.length);
});

test('les badges ne se marchent pas dessus', () => {
  const badges = modules.map((m) => m.badge?.code).filter(Boolean);
  assert.equal(new Set(badges).size, badges.length, 'deux modules partagent un code de badge');
});

for (const meta of modules) {
  test(`module ${meta.code}`, () => {
    const m = lireModule(meta.code);
    assert.ok(m.titre && m.accroche && m.intro, 'titre, accroche et intro sont attendus');
    assert.ok(m.badge?.code && m.badge.libelle && m.badge.emoji, 'badge incomplet');
    assert.ok(m.questions.length >= 5, `${m.questions.length} question(s)`);

    m.questions.forEach((q, i) => {
      const ou = `Q${i + 1}`;
      assert.ok(q.enonce, `${ou} sans énoncé`);
      assert.ok(q.explication, `${ou} sans explication`);
      assert.ok(q.reponses.length >= 4, `${ou} : moins de 4 propositions`);

      const bonnes = q.reponses.filter((r) => r.correcte).length;
      assert.ok(bonnes > 0, `${ou} : aucune bonne réponse, la question est injouable`);
      assert.ok(bonnes < q.reponses.length, `${ou} : tout est correct, la question n'apprend rien`);
      if (!q.multiple) assert.equal(bonnes, 1, `${ou} : choix unique avec ${bonnes} bonnes réponses`);
    });
  });
}
