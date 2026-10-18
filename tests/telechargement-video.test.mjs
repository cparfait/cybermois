/**
 * Telechargement de videos par le serveur : seule une adresse reconstruite a
 * partir de l'identifiant d'une video YouTube ou Dailymotion parvient a
 * yt-dlp. Tout le reste - adresse interne, autre site, parametres ajoutes,
 * options deguisees - est refuse ou neutralise avant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('telechargement-video', import.meta.url);
const { db } = await import('../src/lib/db.js');
const { adresseCanonique, lancerTelechargement } = await import('../src/lib/telechargement-video.js');
nettoyerALaFin(db);

test('une video YouTube est ramenee a son adresse canonique', () => {
  for (const lien of [
    'https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=PL123&t=42',
    'https://youtu.be/aqz-KE-bpKQ?si=abc',
    'https://www.youtube.com/shorts/aqz-KE-bpKQ',
  ]) {
    const c = adresseCanonique(lien);
    assert.equal(c.hebergeur, 'YouTube', lien);
    assert.equal(c.adresse, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', 'playlist et horodatage ne passent pas');
  }
});

test('une video Dailymotion est ramenee a son adresse canonique', () => {
  const c = adresseCanonique('https://www.dailymotion.com/video/x8rvpgc?playlist=x6hynp');
  assert.equal(c.hebergeur, 'Dailymotion');
  assert.equal(c.adresse, 'https://www.dailymotion.com/video/x8rvpgc');
  assert.equal(adresseCanonique('https://dai.ly/x8rvpgc').adresse, 'https://www.dailymotion.com/video/x8rvpgc');
});

test('tout autre lien est refuse avant yt-dlp', () => {
  for (const lien of [
    'http://192.168.1.10/interne.mp4',
    'http://localhost:3000/api/admin/export/participations.csv',
    'https://exemple.fr/video.mp4',
    'https://vimeo.com/123456',
    '/videos/abc.mp4',
    '--exec whoami',
    '',
  ]) {
    assert.equal(adresseCanonique(lien), null, lien);
    assert.throws(() => lancerTelechargement(lien), (e) => e.code === 'LIEN_REFUSE', lien);
  }
});

test("un domaine piege qui contient « youtube.com » n'obtient qu'une adresse YouTube", () => {
  // La reconnaissance cherche un identifiant de video : l'adresse transmise
  // est reconstruite, le domaine saisi n'est jamais repris.
  const c = adresseCanonique('https://attaquant.example/youtube.com/watch?v=aqz-KE-bpKQ');
  assert.ok(!c || c.adresse === 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
});
