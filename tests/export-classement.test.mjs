/**
 * Le classement s'exporte en Excel, limite aux N premiers.
 *
 * Le classeur est relu avec le lecteur du portail (classeur.js) : s'il le
 * lit, l'archive et le XML sont bien formes. On verifie aussi qu'un nom
 * commencant par « = » reste du texte, et que l'anonymat tient dans l'export.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('export-classement', import.meta.url);
const { db } = await import('../src/lib/db.js');
const { classeurClassement, lireNombre } = await import('../src/lib/export-classement.js');
const { csvDuClasseur } = await import('../src/lib/classeur.js');
nettoyerALaFin(db);

db.prepare(`INSERT INTO defis (id, titre, accroche, intro, duree_minutes, ouvre_le, publie)
            VALUES (1, 'Defi 1', 'a', 'i', 5, date('now', '-1 day'), 1)`).run();
db.prepare("INSERT INTO questions (defi_id, enonce, explication, points, ordre) VALUES (1, 'q', 'e', 100, 1)").run();

const agent = (id, nom, service, anonyme = 0) => db
  .prepare('INSERT INTO agents (id, login, nom_complet, service, anonyme) VALUES (?, ?, ?, ?, ?)')
  .run(id, `a${id}`, nom, service, anonyme);
const jouer = (agentId, score) => db
  .prepare(`INSERT INTO participations (agent_id, defi_id, score, score_max, bonnes, total_questions, entrainement)
            VALUES (?, 1, ?, 100, 1, 1, 0)`).run(agentId, score);

agent(1, 'DUPONT Alice', 'Finances');
agent(2, '=HYPERLINK("http://x")', 'Finances');
agent(3, 'MARTIN Paul', 'Culture', 1);
agent(4, 'DURAND Lea', 'Culture');
jouer(1, 90); jouer(2, 80); jouer(3, 70); jouer(4, 60);

const lire = (classement, nombre) => csvDuClasseur(classeurClassement(classement, nombre).contenu);

test('lireNombre : vide ou « tous » pour tout, sinon un entier positif', () => {
  assert.equal(lireNombre(undefined), Infinity);
  assert.equal(lireNombre('tous'), Infinity);
  assert.equal(lireNombre('3'), 3);
  assert.equal(lireNombre('0'), null);
  assert.equal(lireNombre('2.5'), null);
  assert.equal(lireNombre('abc'), null);
});

test('le classement individuel se limite aux N premiers, dans l’ordre', () => {
  const csv = lire('agents', 2);
  assert.match(csv, /Cybermois/);
  assert.match(csv, /2 premiers sur 4 agents/);
  assert.match(csv, /DUPONT Alice/);
  assert.doesNotMatch(csv, /DURAND Lea/);
  assert.ok(csv.indexOf('DUPONT Alice') < csv.indexOf('HYPERLINK'));
});

test('sans limite, tout le classement ; l’anonymat est respecte', () => {
  const csv = lire('agents', Infinity);
  assert.match(csv, /DURAND Lea/);
  assert.match(csv, /Agent anonyme/);
  assert.doesNotMatch(csv, /MARTIN Paul/);
});

/** Le XML de la feuille, lu dans l'archive en suivant les en-tetes locaux. */
function feuilleXml(octets) {
  for (let p = 0; octets.readUInt32LE(p) === 0x04034b50;) {
    const taille = octets.readUInt32LE(p + 18);
    const lgNom = octets.readUInt16LE(p + 26);
    const nom = octets.toString('utf8', p + 30, p + 30 + lgNom);
    const debut = p + 30 + lgNom + octets.readUInt16LE(p + 28);
    if (nom === 'xl/worksheets/sheet1.xml') return zlib.inflateRawSync(octets.subarray(debut, debut + taille)).toString('utf8');
    p = debut + taille;
  }
  return '';
}

test('une valeur commencant par « = » est ecrite en texte, pas en formule', () => {
  const xml = feuilleXml(classeurClassement('agents', Infinity).contenu);
  assert.match(xml, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK\(&quot;http:\/\/x&quot;\)<\/t>/);
  assert.doesNotMatch(xml, /<f>/);
});

test('le classement par direction s’exporte, avec son nom de fichier', () => {
  const { nomFichier } = classeurClassement('services', 1);
  assert.match(nomFichier, /^cybermois-classement-directions-top1-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const csv = lire('services', Infinity);
  assert.match(csv, /Direction/);
  assert.match(csv, /Finances/);
});
