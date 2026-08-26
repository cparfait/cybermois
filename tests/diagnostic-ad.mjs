/**
 * Diagnostic Active Directory et SMTP.
 *
 *   node tests/diagnostic-ad.mjs
 *   node tests/diagnostic-ad.mjs --ou      (detail de l'arborescence des OU)
 *   node tests/diagnostic-ad.mjs --agent p.dupont
 *
 * Lit la configuration depuis .env. N'ecrit rien, ne modifie rien.
 * Aucun mot de passe n'est affiche, ni journalise.
 */
import net from 'node:net';
import tls from 'node:tls';
import { Client } from 'ldapts';
import { config } from '../src/lib/config.js';
import { chaineOu } from '../src/lib/services.js';

const OPTIONS = process.argv.slice(2);
const detailOu = OPTIONS.includes('--ou');
const agentCible = OPTIONS[OPTIONS.indexOf('--agent') + 1];

const vert = (s) => `\x1b[32m${s}\x1b[0m`;
const rouge = (s) => `\x1b[31m${s}\x1b[0m`;
const jaune = (s) => `\x1b[33m${s}\x1b[0m`;
const gris = (s) => `\x1b[90m${s}\x1b[0m`;

const ok = (s) => console.log(`  ${vert('OK')}      ${s}`);
const ko = (s) => console.log(`  ${rouge('ECHEC')}   ${s}`);
const attention = (s) => console.log(`  ${jaune('ATTENTION')} ${s}`);
const info = (s) => console.log(`  ${gris(s)}`);

const titre = (s) => console.log(`\n\x1b[1m${s}\x1b[0m\n${'-'.repeat(s.length)}`);

let erreurs = 0;

/* ------------------------------------------------------- 1. Configuration */

titre('1. Configuration lue');

if (config.ldap.url === 'demo') {
  console.log(rouge('\n  LDAP_URL=demo : vous etes en mode demonstration.'));
  console.log('  Renseignez LDAP_URL, LDAP_BIND_DN, LDAP_BIND_PASSWORD et LDAP_BASE_DN');
  console.log('  dans le fichier .env, puis relancez ce diagnostic.\n');
  process.exit(1);
}

info(`URL             : ${config.ldap.url}`);
info(`Compte de service : ${config.ldap.bindDn || rouge('(non renseigne)')}`);
info(`Mot de passe    : ${config.ldap.bindPassword ? '(renseigne, non affiche)' : rouge('(non renseigne)')}`);
info(`Base de recherche : ${config.ldap.baseDn || rouge('(non renseignee)')}`);
info(`Filtre          : ${config.ldap.userFilter}`);
info(`Groupe requis   : ${config.ldap.requiredGroup || '(aucun)'}`);
info(`Source du service : ${config.service.source === 'ou' ? `OU du DN, profondeur ${config.service.ouDepth}` : `attribut ${config.service.attribut}`}`);

const manquants = [];
if (!config.ldap.bindDn) manquants.push('LDAP_BIND_DN');
if (!config.ldap.bindPassword) manquants.push('LDAP_BIND_PASSWORD');
if (!config.ldap.baseDn) manquants.push('LDAP_BASE_DN');
if (manquants.length) {
  ko(`Variables manquantes dans .env : ${manquants.join(', ')}`);
  process.exit(1);
}

const chiffre = config.ldap.url.startsWith('ldaps://');
if (!chiffre) attention('Liaison NON CHIFFREE : les mots de passe circuleront en clair. A corriger avant ouverture.');

/* ------------------------------------------------- 2. Joignabilite reseau */

titre('2. Joignabilite du contrôleur de domaine');

const url = new URL(config.ldap.url.replace(/^ldaps?:/, 'http:'));
const hote = url.hostname;
const port = Number(url.port) || (chiffre ? 636 : 389);

const testerPort = () => new Promise((resoudre) => {
  const prise = net.createConnection({ host: hote, port, timeout: 5000 });
  prise.on('connect', () => { prise.destroy(); resoudre(true); });
  prise.on('timeout', () => { prise.destroy(); resoudre(false); });
  prise.on('error', () => resoudre(false));
});

if (await testerPort()) {
  ok(`${hote}:${port} repond`);
} else {
  ko(`${hote}:${port} injoignable — verifiez le nom DNS, le pare-feu et le port`);
  erreurs++;
  process.exit(1);
}

if (chiffre) {
  await new Promise((resoudre) => {
    const prise = tls.connect({ host: hote, port, rejectUnauthorized: false, timeout: 5000 }, () => {
      const cert = prise.getPeerCertificate();
      ok(`Certificat presente : ${cert.subject?.CN || '(sans CN)'}`);
      info(`Emis par        : ${cert.issuer?.CN || '(inconnu)'}`);
      info(`Valide jusqu'au : ${cert.valid_to}`);
      info(`C'est cette autorite qu'il faut exporter et fournir en LDAP_CA_BASE64.`);
      prise.destroy(); resoudre();
    });
    prise.on('error', (e) => { attention(`Lecture du certificat impossible : ${e.message}`); resoudre(); });
    prise.on('timeout', () => { prise.destroy(); resoudre(); });
  });
}

/* --------------------------------------------------- 3. Compte de service */

titre('3. Compte de service');

const client = new Client({
  url: config.ldap.url,
  timeout: 10000,
  connectTimeout: 10000,
  tlsOptions: chiffre ? { rejectUnauthorized: config.ldap.rejectUnauthorized } : undefined,
});

try {
  await client.bind(config.ldap.bindDn, config.ldap.bindPassword);
  ok('Authentification du compte de service reussie');
} catch (e) {
  ko(`Authentification refusee : ${e.message}`);
  if (/invalid credentials|data 52e/i.test(e.message)) {
    info('Identifiant ou mot de passe incorrect. Le DN doit etre complet, par exemple :');
    info('  CN=svc-cybermois,OU=Comptes de service,DC=ville,DC=local');
  }
  if (/data 773/i.test(e.message)) info('Le mot de passe doit etre change a la prochaine connexion.');
  if (/data 532|data 701/i.test(e.message)) info('Le mot de passe du compte de service a expire.');
  if (/self.signed|unable to verify/i.test(e.message)) {
    info("Certificat non validable : fournissez l'AC interne via LDAP_CA_BASE64.");
  }
  process.exit(1);
}

/* ------------------------------------------------------- 4. Lecture des agents */

titre('4. Lecture de l\'annuaire');

let entrees = [];
try {
  const res = await client.search(config.ldap.baseDn, {
    scope: 'sub',
    filter: '(&(objectClass=user)(objectCategory=person))',
    attributes: ['dn', 'sAMAccountName', 'displayName', 'mail', 'department',
                 'physicalDeliveryOfficeName', 'userAccountControl'],
    sizeLimit: 5000,
    paged: { pageSize: 500 },
  });
  entrees = res.searchEntries;
  ok(`${entrees.length} compte(s) utilisateur lu(s) sous ${config.ldap.baseDn}`);
} catch (e) {
  ko(`Recherche impossible : ${e.message}`);
  if (/no such object/i.test(e.message)) info('LDAP_BASE_DN ne correspond a aucun conteneur existant.');
  await client.unbind().catch(() => {});
  process.exit(1);
}

const actifs = entrees.filter((e) => !(Number(e.userAccountControl || 0) & 2));
const desactives = entrees.length - actifs.length;
info(`dont ${actifs.length} actif(s) et ${desactives} desactive(s)`);

const sansMail = actifs.filter((e) => !e.mail).length;
if (sansMail) attention(`${sansMail} compte(s) actif(s) sans adresse mail : ils ne recevront aucune relance`);
else ok('Tous les comptes actifs ont une adresse mail');

const sansDepartment = actifs.filter((e) => !e.department).length;
const tauxDepartment = actifs.length ? Math.round((actifs.length - sansDepartment) * 100 / actifs.length) : 0;
if (tauxDepartment >= 90) ok(`Attribut department renseigne pour ${tauxDepartment} % des comptes actifs`);
else attention(`Attribut department renseigne pour seulement ${tauxDepartment} % des comptes actifs`
  + ' — preferez SERVICE_SOURCE=ou');

/* ------------------------------------------------ 5. Rattachement au service */

titre('5. Rattachement au service');

const parProfondeur = new Map();
for (let p = 1; p <= 4; p++) parProfondeur.set(p, new Map());
const parDepartment = new Map();

for (const e of actifs) {
  const ous = chaineOu(e.dn);
  for (let p = 1; p <= 4; p++) {
    const nom = ous[p - 1] || '(aucune)';
    const m = parProfondeur.get(p);
    m.set(nom, (m.get(nom) || 0) + 1);
  }
  const d = e.department || '(vide)';
  parDepartment.set(d, (parDepartment.get(d) || 0) + 1);
}

console.log('\n  Repartition selon SERVICE_OU_DEPTH :\n');
for (let p = 1; p <= 4; p++) {
  const m = parProfondeur.get(p);
  const aucune = m.get('(aucune)') || 0;
  if (aucune === actifs.length) continue;
  const marque = p === config.service.ouDepth ? jaune(' <- valeur actuelle') : '';
  console.log(`  profondeur ${p} : ${m.size} valeur(s) distincte(s)${marque}`);
  const tries = [...m.entries()].sort((a, b) => b[1] - a[1]);
  for (const [nom, n] of tries.slice(0, detailOu ? 100 : 8)) {
    console.log(`      ${String(n).padStart(4)} agents  ${nom}`);
  }
  if (!detailOu && tries.length > 8) console.log(gris(`      … ${tries.length - 8} autre(s), relancez avec --ou`));
  console.log('');
}

console.log(`  Attribut department : ${parDepartment.size} valeur(s) distincte(s)\n`);
for (const [nom, n] of [...parDepartment.entries()].sort((a, b) => b[1] - a[1]).slice(0, detailOu ? 100 : 8)) {
  console.log(`      ${String(n).padStart(4)} agents  ${nom}`);
}

const actuelle = parProfondeur.get(config.service.ouDepth);
console.log('');
if (actuelle && actuelle.size > 60) {
  attention(`Avec SERVICE_OU_DEPTH=${config.service.ouDepth}, vous obtiendriez ${actuelle.size} services : c'est beaucoup.`);
  info('Utilisez l\'ecran Administration > Agents > Regrouper les services pour les rassembler,');
  info('ou testez une profondeur superieure ci-dessus.');
} else if (actuelle) {
  ok(`Avec SERVICE_OU_DEPTH=${config.service.ouDepth}, vous obtiendriez ${actuelle.size} services`);
}

/* --------------------------------------------------- 6. Agent en particulier */

if (agentCible) {
  titre(`6. Recherche du compte « ${agentCible} »`);
  const filtre = config.ldap.userFilter.replace('{{login}}', agentCible.replace(/[\\*()]/g, ''));
  try {
    const { searchEntries } = await client.search(config.ldap.baseDn, {
      scope: 'sub', filter: filtre, attributes: ['dn', 'sAMAccountName', 'displayName', 'mail', 'department'],
    });
    if (!searchEntries.length) {
      ko('Aucun compte trouve — verifiez LDAP_USER_FILTER et LDAP_BASE_DN');
      erreurs++;
    } else if (searchEntries.length > 1) {
      ko(`${searchEntries.length} comptes trouves : le filtre n'est pas assez selectif`);
      erreurs++;
    } else {
      const e = searchEntries[0];
      ok('Compte trouve');
      info(`DN         : ${e.dn}`);
      info(`Nom        : ${e.displayName || '(vide)'}`);
      info(`Adresse    : ${e.mail || '(vide)'}`);
      info(`department : ${e.department || '(vide)'}`);
      const ous = chaineOu(e.dn);
      info(`OU         : ${ous.join(' < ') || '(aucune)'}`);
      const retenu = config.service.source === 'ou'
        ? ous[config.service.ouDepth - 1] : e.department;
      console.log(`\n  Service qui serait retenu : ${vert(retenu || 'Non rattache')}`);
    }
  } catch (e) {
    ko(`Recherche impossible : ${e.message}`);
    erreurs++;
  }
}

await client.unbind().catch(() => {});

/* --------------------------------------------------------------- 7. SMTP */

titre('7. Relais SMTP');

if (!config.smtp.host) {
  info('SMTP_HOST non renseigne : les relances et resultats ne pourront pas partir.');
} else {
  const { testerSmtp } = await import('../src/lib/mail.js');
  const r = await testerSmtp();
  if (r.ok) ok(r.message); else { ko(r.message); erreurs++; }
  info(`Expediteur : ${config.smtp.from}`);
  info(`Groupe de diffusion : ${config.smtp.groupeDiffusion || '(non renseigne)'}`);
  info(`Envoi automatique : ${config.smtp.actif ? 'ACTIF' : 'desactive'}`);
}

/* ------------------------------------------------------------ Conclusion */

titre('Conclusion');
if (erreurs) {
  console.log(rouge(`  ${erreurs} point(s) a corriger avant d'aller plus loin.\n`));
  process.exit(1);
}
console.log(vert('  Configuration exploitable.\n'));
console.log('  Etapes suivantes :');
console.log('    1. Ajuster SERVICE_OU_DEPTH selon la repartition ci-dessus');
console.log('    2. Demarrer l\'application : npm start');
console.log('    3. Se connecter avec son compte AD, puis Administration > Agents');
console.log('    4. Importer l\'effectif, puis regrouper les services\n');
