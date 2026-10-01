/**
 * Envois en nombre : en arriere-plan, au debit regle, avec reprise apres un
 * refus passager, et sans jamais servir deux fois le meme agent.
 *
 * Un petit serveur SMTP tourne dans le test : il note chaque destinataire et
 * peut refuser un message, comme Microsoft 365 au-dela de sa limite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('envois-nombre', import.meta.url);
process.env.CAMPAGNE_FIN = '2099-12-31';

/* ---- Serveur SMTP minimal */
const recus = [];
let refusesAVenir = 0;
const serveur = net.createServer((s) => {
  let donnees = false; let tampon = ''; let destinataire = null;
  s.write('220 test\r\n');
  s.on('data', (d) => {
    tampon += d.toString('utf8');
    let i;
    while ((i = tampon.indexOf('\r\n')) >= 0) {
      const ligne = tampon.slice(0, i); tampon = tampon.slice(i + 2);
      if (donnees) {
        if (ligne === '.') {
          donnees = false;
          if (refusesAVenir > 0) { refusesAVenir--; s.write('451 4.7.500 Server busy, rate limit exceeded\r\n'); }
          else { recus.push(destinataire); s.write('250 ok\r\n'); }
        }
        continue;
      }
      const cmd = ligne.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') s.write('250-test\r\n250 OK\r\n');
      else if (cmd === 'RCPT') { destinataire = /<([^>]+)>/.exec(ligne)?.[1]; s.write('250 ok\r\n'); }
      else if (cmd === 'DATA') { donnees = true; s.write('354 go\r\n'); }
      else if (cmd === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
      else s.write('250 ok\r\n');
    }
  });
});
await new Promise((r) => { serveur.listen(0, '127.0.0.1', r); });
test.after(() => serveur.close());

const { config } = await import('../src/lib/config.js');
Object.assign(config.smtp, { host: '127.0.0.1', port: serveur.address().port, secure: false, user: '', parMinute: 0 });

const { db } = await import('../src/lib/db.js');
const { enregistrerProgramme } = await import('../src/lib/modules.js');
const { importerContenus } = await import('../src/lib/seed.js');
const mail = await import('../src/lib/mail.js');
nettoyerALaFin(db);
mail.reglagesReprise.attente = 20;

enregistrerProgramme([{ module_code: 'mots-de-passe', ouvre_le: '2026-10-01' }], 'test');
importerContenus();
const creer = db.prepare(`INSERT INTO agents (login, nom_complet, email, service, origine)
                          VALUES (?, ?, ?, 'Finances', 'connexion')`);
for (const n of [1, 2, 3]) creer.run(`agent${n}`, `Agent ${n}`, `agent${n}@test.local`);

/** Attend la fin des envois en arriere-plan. */
async function fin() {
  for (let i = 0; i < 200 && mail.envoisEnCoursDetail().length; i++) {
    await new Promise((r) => { setTimeout(r, 25); });
  }
}

test("l'ouverture part en arriere-plan et rend la main aussitot", async () => {
  const r = await mail.envoyerOuverture({ attendre: false });
  assert.equal(r.lance, true);
  assert.equal(r.destinataires, 3);
  assert.match(r.message, /Envoi lancé : 3 mail\(s\)/);
  await fin();
  assert.deepEqual([...recus].sort(), ['agent1@test.local', 'agent2@test.local', 'agent3@test.local']);
});

test("un nouvel envoi ne part qu'aux agents qui ne l'ont pas recu", async () => {
  let r = await mail.envoyerOuverture({ attendre: false });
  assert.equal(r.code, 'TOUS_SERVIS', 'tous servis : rien ne repart');

  creer.run('agent4', 'Agent 4', 'agent4@test.local');
  r = await mail.envoyerOuverture({ attendre: false });
  assert.equal(r.code, 'DEJA_ENVOYE');
  assert.equal(r.restants, 1);

  recus.length = 0;
  r = await mail.envoyerOuverture({ forcer: true, attendre: false });
  assert.equal(r.destinataires, 1);
  await fin();
  assert.deepEqual(recus, ['agent4@test.local'], 'seul le nouvel agent le recoit');
});

test('un refus pour cause de limite est reessaye, pas perdu', async () => {
  recus.length = 0;
  refusesAVenir = 1;

  // La relance du jour : le premier message est refuse une fois (451), puis passe.
  db.prepare("UPDATE defis SET ouvre_le = '2026-09-01'").run();
  const res = await mail.envoyerRelancesSemaine({ jour: '2026-10-07' });
  assert.equal(res.succes, 4, res.erreur || '');
  assert.equal(recus.length, 4);
  assert.equal(refusesAVenir, 0, 'le refus a bien eu lieu');
});

test('le debit regle espace les messages', () => {
  config.smtp.parMinute = 25;
  assert.equal(mail.intervalleEnvoi(), 2400);
  config.smtp.parMinute = 0;
  assert.equal(mail.intervalleEnvoi(), 0);
});

test("l'export de la messagerie declare les recus, et le rattrapage vise les autres", async () => {
  // Le format reel de l'export : chaque ligne entre guillemets, ceux de
  // l'interieur doubles, l'expediteur sur chaque ligne.
  const exporte = [
    'Date & Time,Sender,Sender Header,To,Subject,URL,Attachments,Status,Action,Folder,Remediation',
    '"10/01/2026 07:20 AM,cybermois@chatillon92.fr,Cybermois <cybermois@chatillon92.fr>,agent1@test.local,Le Cybermois commence aujourd’hui,""https://x/defi/11, https://x/defi/2"",,LEGIT,NOTHING,,initial"',
    '"10/01/2026 07:20 AM,cybermois@chatillon92.fr,Cybermois <cybermois@chatillon92.fr>,AGENT2@test.local,Le Cybermois commence aujourd’hui,""https://x/defi/2"",,LEGIT,NOTHING,,initial"',
    '"10/01/2026 07:21 AM,cybermois@chatillon92.fr,Cybermois <cybermois@chatillon92.fr>,agent2@test.local,Le Cybermois commence aujourd’hui,,,LEGIT,NOTHING,,initial"',
    '"10/01/2026 07:21 AM,cybermois@chatillon92.fr,Cybermois <cybermois@chatillon92.fr>,inconnu@test.local,Le Cybermois commence aujourd’hui,,,LEGIT,NOTHING,,initial"',
  ].join('\r\n');
  assert.deepEqual(mail.adressesDeLExport(exporte).sort(),
    ['agent1@test.local', 'agent2@test.local', 'inconnu@test.local'], "l'expediteur n'est pas un destinataire");

  db.prepare("DELETE FROM envois_agents WHERE lot = 'ouverture'").run();
  const r = mail.importerRecus('ouverture', exporte);
  assert.equal(r.reconnus, 2);
  assert.deepEqual(r.inconnues, ['inconnu@test.local']);

  const etat = mail.etatRattrapage('ouverture');
  assert.equal(etat.recus, 2);
  assert.deepEqual(etat.manquants.map((a) => a.email), ['agent3@test.local', 'agent4@test.local']);

  recus.length = 0;
  const envoi = await mail.envoyerOuverture({ forcer: true, attendre: false });
  assert.equal(envoi.destinataires, 2);
  await fin();
  assert.deepEqual(recus.sort(), ['agent3@test.local', 'agent4@test.local'], 'seuls ceux qui ne l’avaient pas');
  assert.equal(mail.etatRattrapage('ouverture').manquants.length, 0);
});

test('une adresse portee par deux comptes ne recoit qu’un mail', async () => {
  // Une boite partagee, portee par deux comptes de l'annuaire.
  creer.run('relais1', 'Relais UN', 'relais@test.local');
  creer.run('relais2', 'Relais DEUX', 'RELAIS@test.local');
  recus.length = 0;
  const r = await mail.envoyerOuverture({ forcer: true, attendre: false });
  assert.equal(r.destinataires, 1, 'une adresse, un mail');
  await fin();
  assert.deepEqual(recus, ['relais@test.local']);

  const etat = mail.etatRattrapage('ouverture');
  assert.equal(etat.manquants.length, 0, 'les deux comptes sont servis');
  assert.deepEqual(etat.partagees, [{ email: 'relais@test.local', noms: ['Relais UN', 'Relais DEUX'] }]);
});

test('un export enregistre dans Excel (.xlsx) se lit aussi', async () => {
  const fs = await import('node:fs');
  const { estArchiveZip, csvDuClasseur } = await import('../src/lib/classeur.js');
  const octets = fs.readFileSync(new URL('./fixtures/export-messagerie.xlsx', import.meta.url));
  assert.ok(estArchiveZip(octets));
  const adresses = mail.adressesDeLExport(csvDuClasseur(octets));
  assert.ok(adresses.includes('agent1@test.local'));
  assert.ok(adresses.includes('agent2@test.local'));

  db.prepare("DELETE FROM envois_agents WHERE lot = 'ouverture'").run();
  const r = mail.importerRecus('ouverture', csvDuClasseur(octets));
  assert.equal(r.reconnus, 2, "l'expediteur, inconnu, est simplement ignore");
  assert.deepEqual(mail.etatRattrapage('ouverture').manquants.map((a) => a.email).slice(0, 2),
    ['agent3@test.local', 'agent4@test.local']);
});

test("l'import ne retient que l'envoi du jour : ni tests, ni reponses, ni autres jours", () => {
  const ligne = (date, de, a, objet) => `${date},${de},X <${de}>,${a},${objet},,,LEGIT,NOTHING,,initial`;
  const exporte = [
    'Date & Time,Sender,Sender Header,To,Subject,URL,Attachments,Status,Action,Folder,Remediation',
    ligne('10/01/2026 07:20 AM', 'cybermois@x.fr', 'agent1@test.local', 'Le Cybermois commence aujourd’hui'),
    ligne('10/01/2026 07:21 AM', 'cybermois@x.fr', 'agent2@test.local', 'Le Cybermois commence aujourd’hui'),
    ligne('09/30/2026 05:57 AM', 'cybermois@x.fr', 'agent3@test.local', 'Le Cybermois commence aujourd’hui'),
    ligne('10/01/2026 09:00 AM', 'cybermois@x.fr', 'agent3@test.local', '[TEST] Le Cybermois commence aujourd’hui'),
    ligne('10/01/2026 11:54 AM', 'informatique@x.fr', 'agent4@test.local', 'RE: [REPORTING] Le Cybermois commence aujourd’hui'),
    ligne('10/01/2026 12:05 PM', 'agent1@test.local', 'cybermois@x.fr', 'Réponse automatique : Le Cybermois commence aujourd’hui'),
    ligne('10/01/2026 10:00 AM', 'com@x.fr', 'agent4@test.local', 'Cybermois 2026 : découvrez les visuels'),
  ].join('\r\n');

  const r = mail.lireExport(exporte, { jour: '2026-10-01' });
  assert.deepEqual(r.adresses.sort(), ['agent1@test.local', 'agent2@test.local']);
  assert.deepEqual(r.ecartees, { date: 1, objet: 3, expediteur: 1 });
});
