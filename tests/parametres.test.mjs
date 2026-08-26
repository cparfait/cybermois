/**
 * Verifie que la configuration en base se superpose bien a l'environnement,
 * et surtout qu'un retrait restaure la valeur d'environnement SANS redemarrage.
 * C'est ce point qui avait echoue : l'objet config conservait la derniere
 * valeur appliquee.
 */
process.env.DB_FILE = new URL('./.parametres-test.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.LDAP_URL = 'demo';
process.env.SMTP_HOST = 'relais-environnement.local';
process.env.ADMIN_LOGINS = 'depuis.environnement';

import fs from 'node:fs';
const { config } = await import('../src/lib/config.js');
const { enregistrerParametres, reinitialiserParametre, appliquerParametres } = await import('../src/lib/parametres.js');

let echecs = 0;
const verifier = (obtenu, attendu, libelle) => {
  const ok = JSON.stringify(obtenu) === JSON.stringify(attendu);
  if (!ok) echecs++;
  console.log(`${ok ? '  OK  ' : ' ECHEC'} ${libelle} -> ${JSON.stringify(obtenu)}${ok ? '' : ` (attendu ${JSON.stringify(attendu)})`}`);
};

console.log("Valeurs issues de l'environnement :");
verifier(config.ldap.url, 'demo', 'ldap.url');
verifier(config.smtp.host, 'relais-environnement.local', 'smtp.host');

console.log('\nLa base prend le pas :');
enregistrerParametres({
  'ldap.url': 'ldaps://dc.exemple.local:636',
  'smtp.host': 'relais-interface.local',
  'smtp.port': '2525',
  'smtp.actif': true,
  'adminLogins': 'depuis.interface, autre.admin',
  'ldap.bindPassword': 'secret-a-chiffrer',
}, 'test');
verifier(config.ldap.url, 'ldaps://dc.exemple.local:636', 'ldap.url remplace');
verifier(config.smtp.port, 2525, 'smtp.port converti en entier');
verifier(config.smtp.actif, true, 'smtp.actif converti en booleen');
verifier(config.adminLogins, ['depuis.interface', 'autre.admin'], 'adminLogins converti en liste');
verifier(config.ldap.bindPassword, 'secret-a-chiffrer', 'secret dechiffre correctement');

console.log("\nRetrait d'un parametre : retour a l'environnement, sans redemarrage :");
reinitialiserParametre('ldap.url', 'test');
verifier(config.ldap.url, 'demo', 'ldap.url revenu a la valeur d environnement');
verifier(config.smtp.host, 'relais-interface.local', 'smtp.host toujours celui de la base');

reinitialiserParametre('smtp.host', 'test');
verifier(config.smtp.host, 'relais-environnement.local', 'smtp.host revenu a l environnement');

console.log('\nRejouer l application donne le meme resultat :');
appliquerParametres();
verifier(config.ldap.url, 'demo', 'ldap.url stable');
verifier(config.smtp.port, 2525, 'smtp.port stable');

console.log('\nUn secret est bien chiffre en base :');
const { db } = await import('../src/lib/db.js');
const ligne = db.prepare('SELECT valeur, chiffre FROM parametres WHERE cle = ?').get('ldap.bindPassword');
verifier(ligne.chiffre, 1, 'marque comme chiffre');
verifier(ligne.valeur.includes('secret-a-chiffrer'), false, 'valeur illisible en base');

db.close();
for (const suffixe of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(config.dbFile + suffixe); } catch { /* deja absent */ }
}
process.exit(echecs ? 1 : 0);
