/**
 * Le programme reel de la campagne 2026 : deux defis le mercredi 30
 * septembre, deux le lundi 5 octobre. Chaque mail ne doit parler que de sa
 * semaine du calendrier.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('semaines-mails', import.meta.url);
process.env.CAMPAGNE_FIN = '2026-11-30';

const { db } = await import('../src/lib/db.js');
const { enregistrerProgramme } = await import('../src/lib/modules.js');
const { importerContenus } = await import('../src/lib/seed.js');
const mail = await import('../src/lib/mail.js');
nettoyerALaFin(db);

enregistrerProgramme([
  { module_code: 'mots-de-passe', ouvre_le: '2026-09-30' },
  { module_code: 'hameconnage', ouvre_le: '2026-09-30' },
  { module_code: 'messagerie', ouvre_le: '2026-10-05' },
  { module_code: 'reseaux-sociaux', ouvre_le: '2026-10-05' },
], 'test');
importerContenus();
const defis = db.prepare('SELECT * FROM defis ORDER BY ouvre_le, id').all();
const [s1a, s1b, s2a, s2b] = defis.map((d) => d.titre);
const agent = { nom_complet: 'Christophe TEST', service: 'Finances' };
const contient = (texte, titres) => titres.every((t) => texte.includes(t));
const aucun = (texte, titres) => titres.every((t) => !texte.includes(t));

test("l'ouverture du mercredi n'annonce que les deux defis de sa semaine", () => {
  const m = mail.mailBienvenue(agent);
  assert.ok(contient(m.texte, [s1a, s1b]));
  assert.ok(aucun(m.texte, [s2a, s2b]), 'les defis du lundi 5 sont ceux de la semaine suivante');
  assert.match(m.texte, /Voici les 2 défis de la semaine/);
  assert.match(m.texte, /Le mercredi, un rappel part si vous n'avez pas fait vos défis\./);
  assert.match(m.texte, /Les défis non réalisés restent ouverts jusqu'au lundi 30 novembre\./);
  assert.doesNotMatch(m.texte, /pas un examen/);
  assert.match(m.texte, /Bonne campagne,\nHélène MANTHEY\nDéléguée à la Protection des Données\nVille de Châtillon/);
});

test('semaine du 28 septembre : ouverture, pas de relance le jour meme, resultats des deux defis', () => {
  const semaine = mail.mailsDeLaSemaine('2026-09-28', agent);
  const par = Object.fromEntries(semaine.map((m) => [m.type, m]));
  assert.equal(par.ouverture.jour, '2026-09-30');
  assert.match(par.annonce.absent, /ouverture en tient lieu/);
  assert.ok(par['relance-semaine'].absent, "aucune relance le jour de l'ouverture");
  assert.ok(contient(par.resultats.mail.texte, [s1a, s1b]));
  assert.ok(aucun(par.resultats.mail.texte, [s2a, s2b]));
});

test('semaine du 5 octobre : annonce des deux nouveaux, relance de tout, resultats des deux nouveaux', () => {
  const semaine = mail.mailsDeLaSemaine('2026-10-05', agent);
  const par = Object.fromEntries(semaine.map((m) => [m.type, m]));
  assert.ok(!par.ouverture);

  const annonce = par.annonce.mail.texte;
  assert.match(annonce, /Voici les 2 défis de la semaine/);
  assert.ok(contient(annonce, [s2a, s2b]));
  assert.match(annonce, /Les défis précédents sont toujours ouverts/);

  assert.ok(contient(par['relance-semaine'].mail.texte, [s1a, s1b, s2a, s2b]),
    'la relance du mercredi 7 reprend tout ce qui a deux jours');

  const resultats = par.resultats.mail.texte;
  assert.ok(contient(resultats, [s2a, s2b]));
  assert.ok(aucun(resultats, [s1a, s1b]), 'deja nommes le vendredi precedent');
});

test('une annonce envoyee a la main en cours de semaine ne deborde pas non plus', () => {
  assert.deepEqual(mail.defisAVenir('2026-10-01').map((d) => d.titre), [], 'jeudi 1er : plus rien cette semaine');
  assert.deepEqual(mail.defisAVenir('2026-09-28').map((d) => d.titre), [s1a, s1b]);
});

test('un exemple de chaque mail : chacun dans la premiere semaine ou il part', () => {
  const exemples = mail.exemplesDeCampagne(agent);
  assert.deepEqual(exemples.map((m) => [m.type, m.jour]), [
    ['ouverture', '2026-09-30'],
    ['resultats', '2026-10-02'],
    ['annonce', '2026-10-05'],
    ['relance-semaine', '2026-10-07'],
    ['elus', null],
  ]);
  assert.ok(exemples.every((m) => m.mail?.html), 'chaque exemple a un contenu');
});

test("le mail aux elus reprend l'ouverture et dit comment participer depuis la mairie", () => {
  const ouverture = mail.mailBienvenue(agent);
  const elus = mail.mailElus(agent);
  assert.equal(elus.objet, ouverture.objet);
  assert.ok(contient(elus.texte, [s1a, s1b]), 'les defis de la premiere semaine');
  assert.ok(aucun(elus.texte, [s2a, s2b]));
  assert.match(elus.texte, /Comment participer/);
  assert.match(elus.texte, /réseau interne de la mairie/);
  assert.match(elus.texte, /PC en libre service du bureau des élus/);
  assert.match(elus.texte, /VPN/);
  assert.match(elus.texte, /Comment ça marche/);
  assert.match(elus.texte, /Hélène MANTHEY/);
  assert.doesNotMatch(elus.texte, /téléphone/, 'le portail ne s’atteint pas depuis un telephone');
  assert.doesNotMatch(ouverture.texte, /Comment participer/, "l'ouverture des agents ne change pas");
});

test('les resultats disent ce que mesurent leurs colonnes', () => {
  const m = mail.mailResultats(defis[1].id, { jour: '2026-10-02' });
  assert.match(m.html, />Défis par agent<\/th>/);
  assert.match(m.html, />Réussite<\/th>/);
  assert.match(m.html, />Participation<\/th>/);
  assert.match(m.texte, /Réussite : la moyenne des résultats des agents de la direction qui ont joué/);
  assert.match(m.texte, /Le classement suit les défis par agent, puis la réussite, puis la participation/);
  assert.match(m.texte, /Participation : la part des agents de la direction qui ont fait au moins un défi/);
});
