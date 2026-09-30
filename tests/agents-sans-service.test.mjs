/**
 * « Agents sans service » repondait par une erreur 500 : la requete citait
 * la constante SERVICE_NON_RATTACHE par son nom, au lieu de sa valeur, et
 * SQLite y cherchait une colonne. L'export CSV avait le meme defaut.
 *
 * Les routes sont appelees par inject() : aucun serveur n'est a lancer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('agents-sans-service', import.meta.url);

const { db, SERVICE_NON_RATTACHE } = await import('../src/lib/db.js');
const { creerSession, COOKIE } = await import('../src/lib/session.js');
const { config } = await import('../src/lib/config.js');
const { default: Fastify } = await import('fastify');
const { default: cookie } = await import('@fastify/cookie');
const { default: routesUtilisateurs } = await import('../src/routes/utilisateurs.js');
nettoyerALaFin(db);

const app = Fastify({ logger: false });
await app.register(cookie, { secret: config.sessionSecret });
await app.register(routesUtilisateurs);
await app.ready();

const creer = db.prepare('INSERT INTO agents (login, nom_complet, email, service, service_brut, est_admin) VALUES (?, ?, ?, ?, ?, ?)');
const admin = Number(creer.run('zz-admin', 'ADMIN', 'a@test.local', 'DSI', null, 1).lastInsertRowid);
creer.run('orphelin', 'Paul ORPHELIN', 'p@test.local', SERVICE_NON_RATTACHE,
  'CN=Paul ORPHELIN,OU=Finances,OU=Agents,DC=test,DC=local', 0);
creer.run('range', 'Anne RANGEE', 'r@test.local', 'Finances', null, 0);
const entete = { cookie: `${COOKIE}=${creerSession(admin)}` };

test('la liste des agents sans service se charge', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/admin/agents/non-rattaches', headers: entete });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.total, 1);
  assert.equal(d.groupes[0].proposition, 'Finances', "l'OU du DN retombe sur le service existant");
  assert.ok(d.services.some((s) => s.service === 'Finances'));
});

test("l'export CSV des agents sans service se charge", async () => {
  const r = await app.inject({ method: 'GET', url: '/api/admin/agents/non-rattaches.csv', headers: entete });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(r.body, /orphelin/);
});
