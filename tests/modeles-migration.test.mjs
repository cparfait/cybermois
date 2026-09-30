/**
 * La phrase « Ce n'est pas un examen… » quitte aussi un mail d'ouverture deja
 * modifie, une seule fois : la remettre ensuite reste possible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('modeles-migration', import.meta.url);
const { db } = await import('../src/lib/db.js');
nettoyerALaFin(db);

// Le texte tel qu'il a pu etre enregistre avant la mise a jour.
db.exec(`CREATE TABLE IF NOT EXISTS modeles_mail (
  type TEXT PRIMARY KEY, objet TEXT NOT NULL, corps TEXT NOT NULL,
  maj_le TEXT NOT NULL DEFAULT (datetime('now')), maj_par TEXT)`);
db.prepare('INSERT INTO modeles_mail (type, objet, corps) VALUES (?, ?, ?)').run('ouverture', 'Objet',
  "<ul>\n<li>Le lundi, un mail annonce les défis de la semaine. Le mercredi, un rappel part si vous en avez manqué un.</li>\n"
  + "<li>Un défi manqué reste ouvert {{jusqu_a_la_fin}}.</li>\n"
  + "<li>Ce n'est pas un examen : aucun résultat individuel n'est transmis à votre hiérarchie.</li>\n"
  + '<li>Une phrase ajoutée par la DSI.</li>\n</ul>');

const modeles = await import('../src/lib/modeles-mail.js');

test('le texte enregistre perd la phrase et prend les nouvelles formulations', () => {
  const { corps } = modeles.lireModele('ouverture');
  assert.doesNotMatch(corps, /pas un examen/);
  assert.match(corps, /les deux défis de la semaine/);
  assert.match(corps, /Les défis non réalisés restent ouverts \{\{jusqu_a_la_fin\}\}\./);
  assert.doesNotMatch(corps, /manqué reste ouvert/);
  assert.match(corps, /Une phrase ajoutée par la DSI/, 'le reste du texte demeure');
});

test('le texte d’origine porte les nouvelles formulations', () => {
  const { corps } = modeles.MODELES.ouverture;
  assert.doesNotMatch(corps, /pas un examen/);
  assert.match(corps, /les deux défis de la semaine/);
  assert.match(corps, /Les défis non réalisés restent ouverts \{\{jusqu_a_la_fin\}\}\./);
});
