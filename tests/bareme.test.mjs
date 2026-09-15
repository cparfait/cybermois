/**
 * Le bareme : dix questions, cent points, pour tous les defis.
 *
 * Ce qui est verifie ici n'est pas une preference d'affichage. Un defi qui
 * pese 115 points quand un autre en pese 70 decide du classement a la place
 * des agents : celui qui a manque la semaine lourde ne rattrape plus.
 *
 *   node --test tests/bareme.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NIVEAUX, QUESTIONS_PAR_DEFI, TOTAL_DEFI, niveauDe, verifierBareme,
} from '../src/lib/bareme.js';

const defiConforme = () => [
  ...Array.from({ length: 3 }, () => ({ difficulte: 'facile' })),
  ...Array.from({ length: 4 }, () => ({ difficulte: 'moyen' })),
  ...Array.from({ length: 3 }, () => ({ difficulte: 'difficile' })),
];

test('la repartition prevue donne exactement le total annonce', () => {
  assert.equal(QUESTIONS_PAR_DEFI, 10);
  assert.equal(TOTAL_DEFI, 100);
  assert.equal(NIVEAUX.reduce((n, x) => n + x.attendues * x.points, 0), TOTAL_DEFI);
});

test('un defi conforme est accepte', () => {
  const v = verifierBareme(defiConforme());
  assert.equal(v.ok, true, v.ecarts.join(', '));
  assert.equal(v.total, 100);
});

test('un defi qui ne tient pas le bareme dit ce qui manque', () => {
  const questions = defiConforme();
  questions[0].difficulte = 'difficile'; // une facile de moins, une difficile de trop
  const v = verifierBareme(questions);
  assert.equal(v.ok, false);
  assert.equal(v.total, 110);
  assert.ok(v.ecarts.some((e) => e.includes('Facile')), v.ecarts.join(', '));
  assert.ok(v.ecarts.some((e) => e.includes('Difficile')), v.ecarts.join(', '));
});

test('neuf questions ne font pas un defi', () => {
  const v = verifierBareme(defiConforme().slice(0, 9));
  assert.equal(v.ok, false);
  assert.ok(v.ecarts[0].includes('9 question'));
});

test('une question ecrite avant le bareme est traduite, pas rejetee', () => {
  assert.equal(niveauDe({ points: 15 }).cle, 'difficile');
  assert.equal(niveauDe({ points: 10 }).cle, 'moyen');
  assert.equal(niveauDe({ points: 5 }).cle, 'facile');
  assert.equal(niveauDe({ points: 20 }).cle, 'difficile', 'le niveau le plus proche');
  assert.equal(niveauDe({}).cle, 'moyen', 'sans indice, la question vaut le niveau median');
  assert.equal(niveauDe({ difficulte: 'FACILE', points: 15 }).cle, 'facile',
    'la difficulte declaree prime sur les points d\'origine');
});
