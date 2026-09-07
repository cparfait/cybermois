/**
 * Aller-retour de l'editeur de defi.
 *
 * L'ecran remplit ses champs avec ce que rend exporterDefi(), puis renvoie ce
 * qu'il affiche. Tout champ absent de l'export revient donc vide - et pour une
 * case a cocher, « vide » vaut « decoche » : ouvrir un defi publie et
 * l'enregistrer sans y toucher le depubliait, en effacant sa date au passage.
 *
 * Ce test verifie que ce que l'ecran lit suffit a le reecrire a l'identique.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { exporterDefi } from '../src/lib/seed.js';

const defiId = db.prepare('SELECT id FROM defis ORDER BY ouvre_le, id LIMIT 1').get()?.id;

test("l'export porte tout ce que l'editeur affiche", { skip: !defiId }, () => {
  const d = exporterDefi(defiId);

  for (const champ of ['titre', 'accroche', 'intro', 'duree_minutes', 'ouvre_le', 'publie']) {
    assert.ok(champ in d, `« ${champ} » manque : le champ reviendrait vide a l'enregistrement`);
  }
  assert.ok(Array.isArray(d.questions) && d.questions.length > 0);
});

test("l'etat de publication est fidele, pas simplement present", { skip: !defiId }, () => {
  const enBase = db.prepare('SELECT publie, ouvre_le FROM defis WHERE id = ?').get(defiId);
  const d = exporterDefi(defiId);

  assert.equal(d.publie, !!enBase.publie,
    'un defi publie doit ressortir publie, sinon la case revient decochee');
  assert.equal(d.ouvre_le, enBase.ouvre_le);
});

test('la video suit le defi, presente ou absente', { skip: !defiId }, () => {
  const avant = db.prepare('SELECT video_url, video_titre FROM defis WHERE id = ?').get(defiId);
  try {
    db.prepare('UPDATE defis SET video_url = ?, video_titre = ? WHERE id = ?')
      .run('https://www.dailymotion.com/video/x8rkmth', 'Mots de passe', defiId);
    assert.deepEqual(exporterDefi(defiId).video,
      { url: 'https://www.dailymotion.com/video/x8rkmth', titre: 'Mots de passe' });

    db.prepare('UPDATE defis SET video_url = NULL, video_titre = NULL WHERE id = ?').run(defiId);
    assert.equal(exporterDefi(defiId).video, null,
      'sans video, l’editeur doit afficher un champ vide et non une adresse fantome');
  } finally {
    db.prepare('UPDATE defis SET video_url = ?, video_titre = ? WHERE id = ?')
      .run(avant.video_url, avant.video_titre, defiId);
  }
});
