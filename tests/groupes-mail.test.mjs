/**
 * Destinataires des mails : directions actives du referentiel, groupes
 * exclus par type de mail, et mail aux elus cible sur un groupe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('groupes-mail', import.meta.url);
process.env.CAMPAGNE_FIN = '2099-12-31';

const { db } = await import('../src/lib/db.js');
const { enregistrerProgramme } = await import('../src/lib/modules.js');
const { importerContenus } = await import('../src/lib/seed.js');
const { enregistrerReferentiel } = await import('../src/lib/referentiel.js');
const groupes = await import('../src/lib/groupes.js');
const mail = await import('../src/lib/mail.js');
nettoyerALaFin(db);

enregistrerProgramme([{ module_code: 'mots-de-passe', ouvre_le: '2026-10-05' }], 'test');
importerContenus();

const creer = db.prepare(`INSERT INTO agents (login, nom_complet, email, service, origine)
                          VALUES (?, ?, ?, ?, 'connexion')`);
const agent = (login, service, grp = []) => {
  const id = creer.run(login, `${login} NOM`, `${login}@test.local`, service).lastInsertRowid;
  groupes.enregistrerGroupes(id, grp.map((g) => `CN=${g},OU=Groupes,DC=test,DC=local`));
  return id;
};
agent('agent1', 'Finances', ['GG-Agents']);
agent('agent2', 'Direction inactive', ['GG-Agents']);
agent('elu1', 'Elus', ['GG-Elus']);
agent('elu2', 'Finances', ['GG-Elus', 'GG-Agents']);

test('le nom court du groupe se lit dans le DN', () => {
  assert.equal(groupes.nomCourt('CN=GG-Elus,OU=Groupes,DC=x'), 'GG-Elus');
  assert.equal(groupes.nomCourt(String.raw`CN=Elus\, adjoints,OU=G,DC=x`), 'Elus, adjoints');
  assert.equal(groupes.nomCourt('GG-Elus'), 'GG-Elus');
});

test('sans referentiel ni exclusion, tout agent joignable recoit le mail', async () => {
  const r = await mail.envoyerOuverture({ simulation: true });
  assert.equal(r.destinataires, 4);
});

test('seules les directions actives du referentiel recoivent les mails', async () => {
  enregistrerReferentiel(['Finances', 'Elus', 'Direction inactive'], 'test');
  db.prepare("UPDATE referentiel_services SET actif = 0 WHERE nom = 'Direction inactive'").run();
  const r = await mail.envoyerOuverture({ simulation: true });
  assert.equal(r.destinataires, 3);
  assert.ok(!r.apercu.includes('agent2@test.local'));
});

test("un groupe exclu d'un mail n'en recoit pas, mais recoit les autres", async () => {
  groupes.enregistrerExclusionsMail('ouverture', ['GG-Elus'], 'test');
  const ouverture = await mail.envoyerOuverture({ simulation: true });
  assert.deepEqual(ouverture.apercu, ['agent1@test.local'], 'elu2 est aussi dans GG-Agents : exclu quand meme');
  const relance = await mail.envoyerRelancesSemaine({ simulation: true, jour: '2026-10-07' });
  assert.equal(relance.destinataires, 3, "l'exclusion ne vaut que pour l'ouverture");
  groupes.enregistrerExclusionsMail('ouverture', [], 'test');
});

test('le mail aux elus part aux membres du groupe, direction ou non', async () => {
  const r = await mail.envoyerElus('gg-elus', { simulation: true });
  assert.equal(r.destinataires, 2, 'la casse du nom ne compte pas');
  const m = mail.mailElus({ nom_complet: 'Helene LEMAIRE', service: 'Elus' });
  assert.match(m.texte, /réseau interne de la mairie/);
  assert.match(m.texte, /VPN/);
  assert.match(m.texte, /bureau des élus/);
});

test('les groupes connus se listent avec leurs membres', () => {
  const liste = groupes.listerGroupes();
  assert.deepEqual(liste.map((g) => [g.groupe, g.membres]), [['GG-Agents', 3], ['GG-Elus', 2]]);
});
