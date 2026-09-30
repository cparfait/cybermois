/**
 * Les trois mails de campagne envoyes a chaque agent.
 *
 *   - l'ouverture, le jour de parution du premier defi, une seule fois ;
 *   - l'annonce du lundi, a partir de la deuxieme semaine, avec les defis
 *     precedents que l'agent n'a pas faits ;
 *   - la relance du mercredi, sur tous les defis des sept derniers jours et
 *     non plus sur le seul dernier paru.
 *
 * Aucun serveur SMTP n'est joint : on verifie qui serait destinataire, et ce
 * que dit le message.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('mails-campagne', import.meta.url);
process.env.CAMPAGNE_FIN = '2099-12-31';

const { db } = await import('../src/lib/db.js');
const { enregistrerProgramme } = await import('../src/lib/modules.js');
const { importerContenus } = await import('../src/lib/seed.js');
const mail = await import('../src/lib/mail.js');
nettoyerALaFin(db);

// Semaine 1 : deux defis (lundi 5 et jeudi 8). Semaine 2 : un defi le lundi 12.
enregistrerProgramme([
  { module_code: 'mots-de-passe', ouvre_le: '2026-10-05' },
  { module_code: 'hameconnage', ouvre_le: '2026-10-08' },
  { module_code: 'messagerie', ouvre_le: '2026-10-12' },
], 'test');
importerContenus();
const defi = (code) => db.prepare('SELECT * FROM defis WHERE module_code = ?').get(code);

const agent = db.prepare(`INSERT INTO agents (login, nom_complet, email, service, origine)
                          VALUES (?, ?, ?, 'Finances', ?)`);
const assidu = agent.run('assidu', 'Alice ASSIDUE', 'alice@test.local', 'connexion').lastInsertRowid;
const retard = agent.run('retard', 'Bruno RETARD', 'bruno@test.local', 'connexion').lastInsertRowid;
agent.run('admin-local', 'Administration', 'admin@test.local', 'local');

const jouer = (agentId, code) => db.prepare(`
  INSERT INTO participations (agent_id, defi_id, score, score_max, bonnes, total_questions)
  VALUES (?, ?, 100, 100, 10, 10)`).run(agentId, defi(code).id);

test("l'ouverture ne part que le jour du premier defi", async () => {
  assert.equal(await mail.ouvertureDuJour('2026-10-04'), null, 'la veille : rien');
  assert.equal(await mail.ouvertureDuJour('2026-10-06'), null, 'le lendemain : rien, le jour est passe');
  assert.equal(mail.premierDefi().ouvre_le, '2026-10-05');
});

test("l'ouverture vise les agents, pas le compte d'administration locale", async () => {
  const r = await mail.envoyerOuverture({ simulation: true });
  assert.equal(r.destinataires, 2);
  assert.ok(!r.apercu.includes('admin@test.local'));
});

test("l'ouverture annonce la premiere semaine, pas le programme", () => {
  const m = mail.mailBienvenue({ nom_complet: 'Alice ASSIDUE', service: 'Finances' });
  assert.match(m.texte, /Bonjour Alice/);
  assert.match(m.texte, /Comment ça marche/);
  assert.match(m.texte, /mercredi/i);
  assert.match(m.texte, new RegExp(defi('mots-de-passe').titre));
  assert.match(m.texte, new RegExp(defi('hameconnage').titre), 'les defis de la semaine y figurent');
  assert.match(m.texte, /En ligne à partir du jeudi 8 octobre/, 'un defi du jeudi donne sa date');
  assert.doesNotMatch(m.texte, new RegExp(defi('messagerie').titre), 'la semaine suivante reste secrete');
  assert.doesNotMatch(m.texte, /lundi 12 octobre/);
});

test("l'ouverture deja partie ne repart pas sans le demander", async () => {
  db.prepare("INSERT INTO envois (type, defi_id, destinataires, succes) VALUES ('ouverture', ?, 2, 2)")
    .run(defi('mots-de-passe').id);
  assert.equal(await mail.ouvertureDuJour('2026-10-05'), null, 'la tache repasse : rien');
  const r = await mail.envoyerOuverture();
  assert.equal(r.code, 'DEJA_ENVOYE');
});

test("pas d'annonce la premiere semaine : l'ouverture en tient lieu", async () => {
  const r = await mail.envoyerAnnonce({ simulation: true, jour: '2026-10-05' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'OUVERTURE');
});

test("l'annonce du lundi rappelle a chacun les defis qu'il n'a pas faits", async () => {
  jouer(assidu, 'mots-de-passe');
  jouer(assidu, 'hameconnage');
  jouer(retard, 'mots-de-passe');

  const r = await mail.envoyerAnnonce({ simulation: true, jour: '2026-10-12' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.defis, [defi('messagerie').titre]);

  const anciens = [defi('hameconnage')];
  const pourRetard = mail.mailAnnonce({ nom_complet: 'Bruno RETARD', service: 'Finances' },
    mail.defisAVenir('2026-10-12'), anciens, '2026-10-12');
  assert.match(pourRetard.texte, /toujours ouverts/);
  assert.match(pourRetard.texte, new RegExp(defi('hameconnage').titre));

  const pourAssidu = mail.mailAnnonce({ nom_complet: 'Alice ASSIDUE', service: 'Finances' },
    mail.defisAVenir('2026-10-12'), [], '2026-10-12');
  assert.match(pourAssidu.texte, /Vous êtes à jour/);
});

test('un defi annonce avant sa date donne sa date, pas un lien mort', () => {
  const m = mail.mailAnnonce(null, [defi('messagerie')], [], '2026-10-10');
  assert.match(m.texte, /En ligne à partir du lundi 12 octobre/);
});

test('la relance du mercredi reprend tous les defis deja parus', async () => {
  // Mercredi 14 : les trois defis ont au moins deux jours. Alice n'a pas fait celui du 12,
  // Bruno n'a fait que le premier : tous deux sont relances.
  let r = await mail.envoyerRelancesSemaine({ simulation: true, jour: '2026-10-14' });
  assert.deepEqual(r.defis, [defi('mots-de-passe').titre, defi('hameconnage').titre, defi('messagerie').titre]);
  assert.equal(r.destinataires, 2);

  // Samedi 10 : les defis du 5 et du 8 ont deux jours. Bruno a fait le
  // premier, pas le second : il est relance. Alice a tout fait : elle ne
  // l'est pas.
  r = await mail.envoyerRelancesSemaine({ simulation: true, jour: '2026-10-10' });
  assert.equal(r.defis.length, 2);
  assert.equal(r.destinataires, 1);
  assert.deepEqual(r.apercu, ['bruno@test.local']);
});

test('deux defis manquants tiennent dans un seul message', () => {
  const m = mail.mailRelanceSemaine({ nom_complet: 'Bruno RETARD', service: 'Finances' },
    [defi('mots-de-passe'), defi('hameconnage')]);
  assert.match(m.objet, /2 défis/);
  assert.match(m.texte, new RegExp(defi('mots-de-passe').titre));
  assert.match(m.texte, new RegExp(defi('hameconnage').titre));
});

test('ni annonce ni relance apres la fin de la campagne', async () => {
  const fin = (await import('../src/lib/config.js')).config.campagne.fin;
  assert.equal((await mail.envoyerRelancesSemaine({ simulation: true, jour: '2100-01-06' })).ok, false, fin);
  assert.equal((await mail.envoyerAnnonce({ simulation: true, jour: '2100-01-05' })).ok, false);
});

test("l'adresse de test n'accepte qu'un seul destinataire", () => {
  assert.equal(mail.adresseValide('alice@chatillon92.fr'), true);
  assert.equal(mail.adresseValide(''), false);
  assert.equal(mail.adresseValide('alice'), false);
  assert.equal(mail.adresseValide('alice@chatillon92.fr, bob@chatillon92.fr'), false,
    'une liste ferait du champ de test un envoi groupe');
  assert.equal(mail.adresseValide('alice@chatillon92.fr;bob@chatillon92.fr'), false);
  assert.equal(mail.adresseValide('Alice <alice@chatillon92.fr>'), false);
});

test("un envoi de test refuse une adresse invalide avant tout appel SMTP", async () => {
  await assert.rejects(() => mail.envoyerTest('a@b.fr, c@d.fr', { objet: 'x', html: '', texte: '' }), /Adresse invalide/);
});

test('les resultats du vendredi nomment tous les defis de la semaine', () => {
  // Semaine du lundi 5 : deux defis, le 5 et le 8.
  const m = mail.mailResultats(defi('hameconnage').id);
  assert.match(m.texte, new RegExp(`${defi('mots-de-passe').titre} et ${defi('hameconnage').titre}`));

  // Envoi du vendredi 23 : rien de paru depuis le 17, pas de vieux titres.
  const creux = mail.mailResultats(defi('messagerie').id, { jour: '2026-10-23' });
  assert.match(creux.texte, /pas de nouveau défi/);
  assert.doesNotMatch(creux.texte, new RegExp(defi('messagerie').titre));
});

test("les mails d'une semaine suivent les regles de l'envoi reel", () => {
  const alice = { nom_complet: 'Alice ASSIDUE', service: 'Finances' };
  const premiere = mail.mailsDeLaSemaine('2026-10-05', alice);
  assert.deepEqual(premiere.map((m) => [m.type, m.jour]), [
    ['ouverture', '2026-10-05'], ['annonce', '2026-10-05'],
    ['relance-semaine', '2026-10-07'], ['resultats', '2026-10-09'],
  ]);
  assert.match(premiere.find((m) => m.type === 'annonce').absent, /ouverture en tient lieu/);
  assert.ok(premiere.find((m) => m.type === 'ouverture').mail);

  const seconde = mail.mailsDeLaSemaine('2026-10-12', alice);
  assert.ok(!seconde.some((m) => m.type === 'ouverture'));
  assert.match(seconde.find((m) => m.type === 'annonce').mail.texte, new RegExp(defi('messagerie').titre));
  const relance = seconde.find((m) => m.type === 'relance-semaine').mail;
  assert.match(relance.texte, new RegExp(defi('hameconnage').titre));
  assert.match(relance.texte, new RegExp(defi('messagerie').titre));

  const semaines = mail.semainesDeCampagne();
  assert.equal(semaines[0].lundi, '2026-10-05');
  assert.deepEqual(semaines[0].defis, [defi('mots-de-passe').titre, defi('hameconnage').titre]);
});
