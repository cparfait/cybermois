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
import { verifierBareme, QUESTIONS_PAR_DEFI, TOTAL_DEFI, NIVEAUX } from '../src/lib/bareme.js';

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

    // Le bareme n'est pas negociable module par module : deux defis de poids
    // differents faussent le classement de toute la campagne.
    const bareme = verifierBareme(m.questions);
    assert.ok(bareme.ok,
      `${m.questions.length} question(s) pour ${bareme.total} points, attendu `
      + `${QUESTIONS_PAR_DEFI} pour ${TOTAL_DEFI} — ${bareme.ecarts.join(', ')}`);

    const niveaux = new Set(NIVEAUX.map((n) => n.cle));
    m.questions.forEach((q, i) => {
      assert.ok(niveaux.has(String(q.difficulte)),
        `Q${i + 1} : difficulté « ${q.difficulte} » inconnue`);
    });

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
