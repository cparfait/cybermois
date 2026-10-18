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
  + '<li>Une phrase ajoutée par la DSI.</li>\n</ul>\n'
  + '<p>Bonne campagne,<br>La déléguée à la protection des données<br>Ville de Châtillon</p>');
db.prepare('INSERT INTO modeles_mail (type, objet, corps) VALUES (?, ?, ?)').run('lancement', 'Objet',
  // Une des signatures essayees un temps, publiee quelques minutes.
  '<p>Un nouveau défi.</p>\n<p>Bonne chance,<br>Hélène MANTHEY<br>Délégué à la protection des données personnelles (DPO)<br>Ville de Châtillon</p>');
// Une annonce modifiee, encore signee de la DSI.
db.prepare('INSERT INTO modeles_mail (type, objet, corps) VALUES (?, ?, ?)').run('annonce', 'Objet',
  "<p>Une annonce retouchée.</p>\n<p>Bonne semaine,<br>La Direction des systèmes d'information</p>");
// L'ancien mail aux elus, enregistre depuis l'editeur sans retouche.
db.prepare('INSERT INTO modeles_mail (type, objet, corps) VALUES (?, ?, ?)').run('elus',
  'Cybermois : comment participer depuis la mairie', `<p>{{salutation}}</p>
<p>La Ville de Châtillon organise le <strong>Cybermois</strong>, {{periode}} : des défis courts pour tester ses réflexes face aux pièges numériques du quotidien. Vous pouvez y participer.</p>
<h3>Comment participer</h3>
<p>L'application n'est accessible que <strong>depuis le réseau interne de la mairie</strong>. Deux possibilités :</p>
<ul>
<li>utiliser un <strong>PC en libre service du bureau des élus</strong> ;</li>
<li>si vous avez un <strong>PC de la mairie</strong>, vous connecter au <strong>VPN</strong>, puis ouvrir le portail.</li>
</ul>
<p>{{bouton}}</p>
<p>Connectez-vous avec vos identifiants Windows habituels. Pour toute question, la Direction des systèmes d'information reste à votre disposition.</p>
<p>La Direction des systèmes d'information</p>`);

// Un mail de resultats retouche, qui annonce l'ancien ordre du classement.
db.prepare('INSERT INTO modeles_mail (type, objet, corps) VALUES (?, ?, ?)').run('resultats', 'Objet',
  '<p>Des résultats retouchés.</p>\n<p>Le classement suit la réussite, puis la participation.</p>\n<p>{{classement_services}}</p>');

const modeles = await import('../src/lib/modeles-mail.js');

test('le texte enregistre perd la phrase et prend les nouvelles formulations', () => {
  const { corps } = modeles.lireModele('ouverture');
  assert.doesNotMatch(corps, /pas un examen/);
  assert.match(corps, /Le lundi, un mail annonce les défis de la semaine\. Le mercredi, un rappel part si vous n'avez pas fait vos défis\./);
  assert.match(corps, /Les défis non réalisés restent ouverts \{\{jusqu_a_la_fin\}\}\./);
  assert.doesNotMatch(corps, /manqué reste ouvert/);
  assert.match(corps, /Une phrase ajoutée par la DSI/, 'le reste du texte demeure');
});

const SIGNATURE = 'Hélène MANTHEY<br>Déléguée à la Protection des Données<br>Ville de Châtillon';

test('les textes enregistres prennent la nouvelle signature de la DPO', () => {
  assert.ok(modeles.lireModele('ouverture').corps.includes(`<p>Bonne campagne,<br>${SIGNATURE}</p>`));
  assert.ok(modeles.lireModele('lancement').corps.includes(`<p>Bonne chance,<br>${SIGNATURE}</p>`));
  for (const type of ['ouverture', 'lancement']) {
    assert.doesNotMatch(modeles.lireModele(type).corps, /La déléguée|personnelles \(DPO\)/);
    assert.ok(modeles.MODELES[type].corps.includes(SIGNATURE), `texte d'origine : ${type}`);
  }
});

test('le texte d’origine porte les nouvelles formulations', () => {
  const { corps } = modeles.MODELES.ouverture;
  assert.doesNotMatch(corps, /pas un examen/);
  assert.match(corps, /Le lundi, un mail annonce les défis de la semaine\. Le mercredi, un rappel part si vous n'avez pas fait vos défis\./);
  assert.match(corps, /Les défis non réalisés restent ouverts \{\{jusqu_a_la_fin\}\}\./);
});

test("un mail aux elus enregistre sans retouche revient au texte d'origine", () => {
  assert.equal(modeles.lireModele('elus').personnalise, false);
  assert.match(modeles.lireModele('elus').corps, /Comment participer/);
  assert.match(modeles.lireModele('elus').corps, /\{\{defis_semaine\}\}/);
});

test('tous les mails sont signes de la DPO, textes enregistres compris', () => {
  for (const [type, m] of Object.entries(modeles.MODELES)) {
    assert.ok(m.corps.includes(modeles.SIGNATURE), `texte d'origine : ${type}`);
  }
  const annonce = modeles.lireModele('annonce').corps;
  assert.ok(annonce.includes(`<p>Bonne semaine,<br>${modeles.SIGNATURE}</p>`));
  assert.match(annonce, /Une annonce retouchée/, 'le reste du texte demeure');
  assert.doesNotMatch(annonce, /La Direction des systèmes/);
});

test('un mail de resultats enregistre annonce que les defis termines passent d abord', () => {
  const { corps } = modeles.lireModele('resultats');
  assert.match(corps, /Le classement suit les défis par agent, puis la réussite, puis la participation\./);
  assert.doesNotMatch(corps, /suit la réussite, puis/);
  assert.match(corps, /Des résultats retouchés/, 'le reste du texte demeure');
  assert.match(modeles.MODELES.resultats.corps, /Le classement suit les défis par agent/);
});
