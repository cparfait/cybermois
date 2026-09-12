/**
 * Une correction faite dans le back-office survit au redemarrage.
 *
 * Le rechargement des contenus rejoue les fichiers du catalogue dans les
 * defis, et il s'execute a chaque demarrage du serveur. Une question corrigee
 * a la main sur un defi que personne n'avait encore joue etait donc effacee au
 * redemarrage suivant : on retrouvait le texte du module sans que rien ne
 * l'explique, et on croyait avoir mal enregistre.
 *
 * Ces tests fixent la regle : le back-office l'emporte sur le fichier, et
 * seul un rechargement force revient en arriere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('contenus', import.meta.url);
const { db } = await import('../src/lib/db.js');
const {
  enregistrerProgramme, lireModule, marquerLesDefisDejaRetouches,
} = await import('../src/lib/modules.js');
const { importerContenus } = await import('../src/lib/seed.js');
nettoyerALaFin(db);

const CORRIGE = 'ÉNONCÉ CORRIGÉ DANS LE BACK-OFFICE';
const premiereQuestion = (defiId) =>
  db.prepare('SELECT enonce FROM questions WHERE defi_id = ? ORDER BY ordre LIMIT 1').get(defiId)?.enonce;

enregistrerProgramme([
  { module_code: 'mots-de-passe', ouvre_le: '2026-10-05' },
  { module_code: 'hameconnage', ouvre_le: '2026-10-12' },
], 'test');
importerContenus();

const protege = db.prepare("SELECT id FROM defis WHERE module_code = 'mots-de-passe'").get().id;
const intact = db.prepare("SELECT id FROM defis WHERE module_code = 'hameconnage'").get().id;

// Ce que fait l'editeur du back-office : reecrire la question, et poser le drapeau.
db.prepare('UPDATE questions SET enonce = ? WHERE defi_id = ? AND ordre = 1').run(CORRIGE, protege);
db.prepare('UPDATE defis SET contenu_modifie = 1 WHERE id = ?').run(protege);

test('un defi modifie a la main survit au rechargement', () => {
  const rapport = importerContenus();
  assert.equal(premiereQuestion(protege), CORRIGE,
    'sans cela, la correction disparait au redemarrage suivant');
  assert.equal(rapport.find((r) => r.module === 'mots-de-passe').statut, 'protege');
});

test('les defis non touches continuent de suivre leur module', () => {
  // La protection ne doit pas figer tout le catalogue : un module corrige dans
  // Git doit encore pouvoir entrer en base.
  assert.equal(premiereQuestion(intact), lireModule('hameconnage').questions[0].enonce);
});

test('la date reste appliquee sur un defi protege', () => {
  // Repousser une parution ne touche pas au questionnaire : rien ne justifie
  // que la protection bloque aussi le calendrier.
  enregistrerProgramme([
    { module_code: 'mots-de-passe', ouvre_le: '2026-10-19' },
    { module_code: 'hameconnage', ouvre_le: '2026-10-12' },
  ], 'test');
  importerContenus();

  assert.equal(db.prepare('SELECT ouvre_le FROM defis WHERE id = ?').get(protege).ouvre_le, '2026-10-19');
  assert.equal(premiereQuestion(protege), CORRIGE);
});

test('forcer revient au module, et leve la protection', () => {
  importerContenus({ force: true });

  assert.equal(premiereQuestion(protege), lireModule('mots-de-passe').questions[0].enonce,
    'forcer doit bien ecraser : c\'est le seul moyen de revenir au fichier');
  assert.equal(db.prepare('SELECT contenu_modifie FROM defis WHERE id = ?').get(protege).contenu_modifie, 0,
    'le defi est de nouveau conforme a son module : il ne doit plus etre annonce protege');
});

test('un defi qui differe deja de son module est rattrape', () => {
  // Les corrections faites avant l'existence du drapeau doivent etre reconnues,
  // sinon la protection ne servirait qu'aux suivantes.
  db.prepare('UPDATE questions SET enonce = ? WHERE defi_id = ? AND ordre = 1').run(CORRIGE, protege);
  db.exec('ALTER TABLE defis DROP COLUMN contenu_modifie');

  // Ce que fait le premier demarrage de la nouvelle version, avec la vraie
  // fonction de rattrapage - la reecrire ici la laisserait passer cassee.
  db.exec('ALTER TABLE defis ADD COLUMN contenu_modifie INTEGER NOT NULL DEFAULT 0');
  marquerLesDefisDejaRetouches();

  assert.equal(db.prepare('SELECT contenu_modifie FROM defis WHERE id = ?').get(protege).contenu_modifie, 1,
    'la correction anterieure au drapeau doit etre reconnue');
  assert.equal(db.prepare('SELECT contenu_modifie FROM defis WHERE id = ?').get(intact).contenu_modifie, 0,
    'un defi conforme a son module ne doit pas etre marque a tort');
  importerContenus();
  assert.equal(premiereQuestion(protege), CORRIGE);
});
