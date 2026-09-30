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
  "<ul>\n<li>Un défi manqué reste ouvert.</li>\n<li>Ce n'est pas un examen : aucun résultat individuel n'est transmis à votre hiérarchie.</li>\n</ul>");

const modeles = await import('../src/lib/modeles-mail.js');

test('la phrase disparait du texte enregistre, le reste demeure', () => {
  const { corps } = modeles.lireModele('ouverture');
  assert.doesNotMatch(corps, /pas un examen/);
  assert.match(corps, /Un défi manqué reste ouvert/);
});

test('le texte d’origine ne la porte plus non plus', () => {
  assert.doesNotMatch(modeles.MODELES.ouverture.corps, /pas un examen/);
});
