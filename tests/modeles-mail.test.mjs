/**
 * Textes de mail modifiables : ce que l'editeur enregistre, ce que le serveur
 * en garde, et ce qui part vraiment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('modeles-mail', import.meta.url);

const { db } = await import('../src/lib/db.js');
const { enregistrerProgramme } = await import('../src/lib/modules.js');
const { importerContenus } = await import('../src/lib/seed.js');
const mail = await import('../src/lib/mail.js');
const modeles = await import('../src/lib/modeles-mail.js');
nettoyerALaFin(db);

enregistrerProgramme([
  { module_code: 'mots-de-passe', ouvre_le: '2026-10-05' },
  { module_code: 'hameconnage', ouvre_le: '2026-10-12' },
], 'test');
importerContenus();
const defi = db.prepare("SELECT * FROM defis WHERE module_code = 'hameconnage'").get();
const agent = { nom_complet: 'Alice ASSIDUE', service: 'Finances' };

test('le nettoyage ne garde que la mise en forme d’un mail', () => {
  const propre = modeles.nettoyerHtml(
    '<div style="color:red">Bonjour <b>à tous</b><script>alert(1)</script></div>'
    + '<p onclick="x()"><span style="font-size:40px">texte</span> <a href="javascript:alert(1)">piège</a>'
    + ' <a href="https://exemple.fr" target="_blank">lien</a></p><img src=x onerror=alert(1)>',
  );
  assert.equal(propre,
    '<p>Bonjour <strong>à tous</strong></p><p>texte <a>piège</a> <a href="https://exemple.fr">lien</a></p>');
});

test('un repère inconnu ou un bloc glissé dans une phrase est refusé', () => {
  assert.match(modeles.verifierModele('relance', { objet: 'x', corps: '<p>{{inexistant}}</p>' }).join(),
    /inconnue/);
  assert.match(modeles.verifierModele('relance', { objet: 'x', corps: '<p>Voici {{bouton}} ici</p>' }).join(),
    /seul sur sa ligne/);
  assert.match(modeles.verifierModele('relance', { objet: '{{bouton}}', corps: '<p>ok</p>' }).join(),
    /objet/);
  assert.deepEqual(modeles.verifierModele('relance', {
    objet: 'Le défi {{titre_defi}}', corps: '<p>{{salutation}}</p><p>{{bouton}}</p>',
  }), []);
});

test('le texte enregistré est celui qui part, données remplacées', () => {
  modeles.enregistrerModele('relance', {
    objet: 'Rappel : {{titre_defi}}',
    corps: '<p>Coucou {{prenom}} !</p><p>{{bouton}}</p><p>Signé <strong>la DSI</strong></p>',
  }, 'test');
  const m = mail.mailRelance(agent, defi.id);
  assert.equal(m.objet, `Rappel : ${defi.titre}`);
  assert.match(m.texte, /Coucou Alice !/);
  assert.match(m.html, /Faire le défi maintenant/, 'le bloc bouton est remplacé');
  assert.doesNotMatch(m.html, /\{\{/);
  assert.doesNotMatch(m.html, /<a style="color:#006e46[^>]*>Faire le défi/,
    'le style des liens du texte ne touche pas le bouton');

  modeles.reinitialiserModele('relance', 'test');
  assert.match(mail.mailRelance(agent, defi.id).texte, /vous attend toujours/, "retour au texte d'origine");
});

test('un brouillon ne sert que le temps de l’aperçu', () => {
  const apercu = modeles.avecBrouillon('relance', { objet: 'Brouillon', corps: '<p>Essai</p>' },
    () => mail.mailRelance(agent, defi.id));
  assert.equal(apercu.objet, 'Brouillon');
  assert.notEqual(mail.mailRelance(agent, defi.id).objet, 'Brouillon');
});

test("une donnée n'est jamais interprétée comme du HTML", () => {
  modeles.enregistrerModele('relance', { objet: 'x', corps: '<p>{{prenom}}</p>' }, 'test');
  const m = mail.mailRelance({ nom_complet: '<b>Bob</b> PIEGE', prenom: '<b>Bob</b>', service: 'X' }, defi.id);
  assert.doesNotMatch(m.html, /<b>Bob<\/b>/);
  modeles.reinitialiserModele('relance', 'test');
});
