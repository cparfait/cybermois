/**
 * Points releves par l'audit de securite.
 *
 * - Le mode demonstration s'activait en production en saisissant « demo »
 *   comme adresse d'annuaire : quinze comptes fictifs au mot de passe public
 *   pouvaient alors jouer et fausser le classement.
 * - La connexion n'etait limitee que par compte : on essayait un meme mot de
 *   passe sur tous les comptes depuis une seule adresse, et les essais sur un
 *   compte depassaient le seuil de verrouillage de l'Active Directory.
 * - Le blocage des pages .html se contournait par /admin%2Ehtml.
 * - Le mot de passe genere pour l'administrateur local s'ecrivait dans les
 *   journaux du conteneur.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('durcissement-audit', import.meta.url);
const { db } = await import('../src/lib/db.js');
const { config } = await import('../src/lib/config.js');
const { estModeDemo, authentifierDemo, verifierModeDemo } = await import('../src/lib/annuaire-demo.js');
const { validerParametres } = await import('../src/lib/parametres.js');
const { designeUnFichierHtml } = await import('../src/lib/statiques.js');
const limitation = await import('../src/lib/limitation-connexion.js');
const { amorcerAdminLocal, definirAdminLocal, fichierAmorce, verifierAdminLocal } = await import('../src/lib/admin-local.js');
nettoyerALaFin(db);
process.on('exit', () => fs.rmSync(fichierAmorce(), { force: true }));

/** Execute fn avec un environnement et une adresse d'annuaire donnes, puis restaure. */
async function avec({ env, url }, fn) {
  const avant = { env: config.env, url: config.ldap.url };
  config.env = env;
  config.ldap.url = url;
  try { return await fn(); } finally {
    config.env = avant.env;
    config.ldap.url = avant.url;
  }
}

/* ------------------------------------------------------- Mode demonstration */

test('le mode demonstration ne s\'active jamais en production', async () => {
  await avec({ env: 'production', url: 'demo' }, async () => {
    assert.equal(estModeDemo(), false);
    const r = await authentifierDemo('c.parfait', 'demo2026');
    assert.equal(r.ok, false, 'un compte fictif ne doit pas ouvrir de session');
  });
  await avec({ env: 'development', url: 'demo' }, async () => {
    assert.equal(estModeDemo(), true);
    assert.equal((await authentifierDemo('c.parfait', 'demo2026')).ok, true);
  });
});

test('« demo » se refuse a l\'enregistrement en production, pas en recette', async () => {
  await avec({ env: 'production', url: 'ldaps://dc01.exemple.lan:636' }, () => {
    for (const saisie of ['demo', ' demo ']) {
      const erreurs = validerParametres({ 'ldap.url': saisie });
      assert.equal(erreurs.length, 1, `« ${saisie} » aurait du etre refuse`);
      assert.match(erreurs[0], /demonstration/);
    }
    assert.deepEqual(validerParametres({ 'ldap.url': 'dc01.exemple.lan' }), []);
  });
  await avec({ env: 'development', url: 'demo' }, () => {
    assert.deepEqual(validerParametres({ 'ldap.url': 'demo' }), []);
  });
});

test('une base de recette reprise en production demarre, demo neutralise', async () => {
  const avant = process.env.LDAP_URL;
  try {
    delete process.env.LDAP_URL;
    await avec({ env: 'production', url: 'demo' }, () => {
      assert.match(verifierModeDemo(), /desactive/);
    });
    process.env.LDAP_URL = 'demo';
    await avec({ env: 'production', url: 'demo' }, () => {
      assert.throws(() => verifierModeDemo(), /incompatible/);
    });
  } finally {
    if (avant === undefined) delete process.env.LDAP_URL; else process.env.LDAP_URL = avant;
  }
});

/* ------------------------------------------------ Limitation des connexions */

test('par compte : bloque au seuil, avant l\'annuaire, puis se libere', () => {
  limitation.reinitialiserLimitation();
  const t0 = 1_000_000;
  for (let i = 0; i < config.connexion.echecsMaxCompte; i++) {
    assert.equal(limitation.attenteCompte('C.Parfait', t0 + i), 0);
    limitation.noterEchecCompte('c.parfait', t0 + i);
  }
  assert.ok(limitation.attenteCompte(' c.parfait ', t0 + 10) > 0, 'la casse et les espaces ne changent pas le compte');
  assert.equal(limitation.attenteCompte('m.durand', t0 + 10), 0, 'les autres comptes ne sont pas touches');
  assert.equal(limitation.attenteCompte('c.parfait', t0 + limitation.FENETRE_COMPTE_MS + 1), 0);

  limitation.noterEchecCompte('m.durand', t0);
  limitation.oublierCompte('m.durand');
  assert.equal(limitation.attenteCompte('m.durand', t0), 0);
});

test('par adresse IP : un mot de passe essaye sur tous les comptes finit bloque', () => {
  limitation.reinitialiserLimitation();
  const t0 = 2_000_000;
  for (let i = 0; i < config.connexion.echecsMaxIp; i++) limitation.noterEchecIp('10.0.0.66', t0);
  assert.ok(limitation.attenteIp('10.0.0.66', t0 + 1) > 0);
  assert.equal(limitation.attenteIp('10.0.0.67', t0 + 1), 0);
  assert.equal(limitation.attenteIp('10.0.0.66', t0 + limitation.FENETRE_IP_MS), 0);
});

test('route de connexion : pulverisation et compte trop essaye renvoient 429', async () => {
  const { default: Fastify } = await import('fastify');
  const { default: cookie } = await import('@fastify/cookie');
  const { default: routesAuth } = await import('../src/routes/auth.js');

  const app = Fastify();
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(routesAuth);

  await avec({ env: 'development', url: 'demo' }, async () => {
    const connexion = (login, motDePasse, ip = '10.1.1.1') => app.inject({
      method: 'POST', url: '/api/connexion', remoteAddress: ip, payload: { login, motDePasse },
    });

    // Compte : au-dela du seuil, meme le bon mot de passe est refuse sans
    // interroger l'annuaire - c'est ce qui protege du verrouillage AD.
    limitation.reinitialiserLimitation();
    for (let i = 0; i < config.connexion.echecsMaxCompte; i++) {
      assert.equal((await connexion('s.leroy', 'mauvais')).statusCode, 401);
    }
    const bloque = await connexion('s.leroy', 'demo2026');
    assert.equal(bloque.statusCode, 429);
    assert.ok(Number(bloque.headers['retry-after']) > 0);
    assert.equal((await connexion('p.martin', 'demo2026')).statusCode, 200, 'un autre compte se connecte');

    // IP : un mot de passe sur chaque compte, chaque compte n'etant essaye qu'une fois.
    limitation.reinitialiserLimitation();
    for (let i = 0; i < config.connexion.echecsMaxIp; i++) {
      assert.equal((await connexion(`inconnu${i}`, 'Printemps2026', '10.2.2.2')).statusCode, 401);
    }
    assert.equal((await connexion('a.bernard', 'demo2026', '10.2.2.2')).statusCode, 429);
    assert.equal((await connexion('a.bernard', 'demo2026', '10.3.3.3')).statusCode, 200, 'les autres postes passent');
  });
  await app.close();
  limitation.reinitialiserLimitation();
});

/* --------------------------------------------- Pages HTML par leur nom */

test('les pages HTML ne se servent pas par leur nom, encodage ou non', () => {
  for (const url of [
    '/admin.html', '/ADMIN.HTML', '/admin.htm', '/admin%2Ehtml', '/admin%2ehtml',
    '/admin.htm%6C', '/admin.html/', '/admin.html%2F', '/admin.html.', '/admin.html%20',
    '/admin%2Ehtml?x=1', '/js/../admin.html',
  ]) {
    assert.equal(designeUnFichierHtml(url), true, url);
  }
  for (const url of ['/administration', '/accueil', '/js/admin.js', '/img/logo.png', '/api/moi?page=a.html']) {
    assert.equal(designeUnFichierHtml(url), false, url);
  }
});

/* --------------------------------- Mot de passe de l'administrateur local */

test('le mot de passe genere ne sort pas de l\'amorcage, et son fichier s\'efface', () => {
  const avant = process.env.ADMIN_LOCAL_MOT_DE_PASSE;
  delete process.env.ADMIN_LOCAL_MOT_DE_PASSE;
  try {
    const amorce = amorcerAdminLocal();
    assert.ok(amorce, 'la base jetable n\'a pas de compte local');
    assert.equal(amorce.motDePasse, undefined, 'le mot de passe ne doit pas revenir a l\'appelant, qui le journalise');
    assert.equal(amorce.fichier, fichierAmorce());

    const contenu = fs.readFileSync(amorce.fichier, 'utf8');
    const motDePasse = contenu.match(/^Mot de passe : (\S+)$/m)?.[1];
    assert.ok(motDePasse);
    assert.equal(verifierAdminLocal(amorce.login, motDePasse).ok, true);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(amorce.fichier).mode & 0o777, 0o600);
    }

    definirAdminLocal(amorce.login, 'une phrase de passe choisie', { parQui: 'test' });
    assert.equal(fs.existsSync(amorce.fichier), false, 'un mot de passe change rend le fichier caduc');
  } finally {
    if (avant !== undefined) process.env.ADMIN_LOCAL_MOT_DE_PASSE = avant;
  }
});
