/**
 * Une video remplacee ou retiree quitte le disque.
 *
 * Changer l'adresse de la video d'un defi laissait l'ancien fichier dans le
 * dossier des videos, et rien a l'ecran ne permettait de l'effacer : chaque
 * essai ajoutait quelques dizaines de Mo, jusqu'au quota. Desormais,
 * l'enregistrement du defi efface le fichier qu'il n'utilise plus - sauf si
 * un autre defi s'en sert encore.
 *
 * Les routes sont appelees par inject() : aucun serveur n'est a lancer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseJetable } from './base-jetable.mjs';

baseJetable('videos-orphelines', import.meta.url);
// Le dossier des videos se place a cote de la base : une base dans tests/
// y aurait cree tests/videos. Un dossier temporaire garde le depot propre.
const dossierTest = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermois-videos-'));
process.env.DB_FILE = path.join(dossierTest, 'base.db');

const { db } = await import('../src/lib/db.js');
const { dossierVideos } = await import('../src/lib/videos.js');
const { enregistrerProgramme } = await import('../src/lib/modules.js');
const { importerContenus, exporterDefi } = await import('../src/lib/seed.js');
const { creerSession, COOKIE } = await import('../src/lib/session.js');
const { config } = await import('../src/lib/config.js');
const { default: Fastify } = await import('fastify');
const { default: cookie } = await import('@fastify/cookie');
const { default: routesAdmin } = await import('../src/routes/admin.js');

process.on('exit', () => {
  try { db.close(); } catch { /* deja fermee */ }
  try { fs.rmSync(dossierTest, { recursive: true, force: true }); } catch { /* verrou Windows */ }
});

const app = Fastify({ logger: false });
await app.register(cookie, { secret: config.sessionSecret });
await app.register(routesAdmin);
await app.ready();

const admin = Number(db.prepare(
  "INSERT INTO agents (login, nom_complet, email, service, est_admin) VALUES ('zz-admin', 'TEST', 'a@test.local', 'DSI', 1)"
).run().lastInsertRowid);
const entete = { cookie: `${COOKIE}=${creerSession(admin)}` };

enregistrerProgramme([
  { module_code: 'mots-de-passe', ouvre_le: '2026-10-05' },
  { module_code: 'hameconnage', ouvre_le: '2026-10-12' },
], 'test');
importerContenus();
const defiA = db.prepare("SELECT id FROM defis WHERE module_code = 'mots-de-passe'").get().id;
const defiB = db.prepare("SELECT id FROM defis WHERE module_code = 'hameconnage'").get().id;

const dossier = dossierVideos();
const fichier = (nom) => path.join(dossier, nom);
function deposer(nom, { ageHeures = 0 } = {}) {
  fs.writeFileSync(fichier(nom), 'video');
  if (ageHeures) {
    const date = new Date(Date.now() - ageHeures * 3600 * 1000);
    fs.utimesSync(fichier(nom), date, date);
  }
  return `/videos/${nom}`;
}
const present = (nom) => fs.existsSync(fichier(nom));
const attacher = (defiId, url) => db.prepare('UPDATE defis SET video_url = ? WHERE id = ?').run(url, defiId);

/** Ce que fait l'editeur : relire le defi, changer la video, enregistrer. */
async function enregistrerVideo(defiId, url) {
  const corps = exporterDefi(defiId);
  corps.video = { ...(corps.video || {}), url };
  const r = await app.inject({ method: 'POST', url: `/api/admin/defis/${defiId}`, headers: entete, payload: corps });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}

test("remplacer la video d'un defi efface l'ancien fichier", async () => {
  attacher(defiA, deposer('ancienne.mp4'));
  const nouvelle = deposer('nouvelle.mp4');

  const r = await enregistrerVideo(defiA, nouvelle);
  assert.equal(present('ancienne.mp4'), false, "l'ancien fichier doit quitter le disque");
  assert.equal(present('nouvelle.mp4'), true);
  assert.match(r.message, /effacée du serveur/);
});

test('retirer la video efface son fichier', async () => {
  attacher(defiA, deposer('a-retirer.mp4'));
  await enregistrerVideo(defiA, '');
  assert.equal(present('a-retirer.mp4'), false);
  assert.equal(db.prepare('SELECT video_url FROM defis WHERE id = ?').get(defiA).video_url, null);
});

test("un fichier encore utilise par un autre defi reste", async () => {
  const partagee = deposer('partagee.mp4');
  attacher(defiA, partagee);
  attacher(defiB, partagee);
  await enregistrerVideo(defiA, '');
  assert.equal(present('partagee.mp4'), true, 'le defi B la montre encore');
});

test('un depot recent pas encore enregistre survit, un orphelin ancien part', async () => {
  // Un administrateur peut deposer une video pour un defi pendant qu'un autre
  // en enregistre un second : son fichier n'est pas encore reference.
  deposer('depot-en-cours.mp4');
  deposer('abandonne.mp4', { ageHeures: 48 });
  attacher(defiA, deposer('avant.mp4'));

  await enregistrerVideo(defiA, '');
  assert.equal(present('depot-en-cours.mp4'), true);
  assert.equal(present('abandonne.mp4'), false);
});

test("enregistrer sans toucher a la video n'efface rien", async () => {
  const gardee = deposer('gardee.mp4');
  attacher(defiA, gardee);
  deposer('vieil-orphelin.mp4', { ageHeures: 48 });
  await enregistrerVideo(defiA, gardee);
  assert.equal(present('gardee.mp4'), true);
  assert.equal(present('vieil-orphelin.mp4'), true, 'le menage ne se fait que quand la video change');
});

test('supprimer un defi efface sa video', async () => {
  attacher(defiB, deposer('du-defi-supprime.mp4'));
  const r = await app.inject({ method: 'DELETE', url: `/api/admin/defis/${defiB}`, headers: entete, payload: {} });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(present('du-defi-supprime.mp4'), false);
});
