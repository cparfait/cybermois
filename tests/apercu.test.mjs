/**
 * Aperçu d'un defi avant son ouverture.
 *
 * Deux exigences s'opposent : le lien doit fonctionner pour quelqu'un d'autre,
 * et rien de ce qui s'y joue ne doit compter. La seconde ne peut pas reposer
 * sur un reglage qu'on oublierait de mettre - elle doit tenir au chemin de
 * code lui-meme.
 *
 * On verifie donc que le jeton ouvre, qu'il se revoque, et surtout qu'un
 * apercu ne laisse ni participation ni trace susceptible de preremplir le
 * parcours reel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { creerJetonApercu, revoquerJetonApercu, jetonValide, lienApercu } from '../src/lib/apercu.js';
import { repondre, progression, effacerTentatives } from '../src/lib/tentatives.js';

const PREFIXE = 'zz-test-apercu-';
const defiDe = (semaine) => db.prepare('SELECT * FROM defis WHERE semaine = ?').get(semaine);
const premiereSemaine = db.prepare('SELECT semaine FROM defis ORDER BY semaine LIMIT 1').get()?.semaine;

function agent(suffixe) {
  const login = PREFIXE + suffixe;
  db.prepare(`
    INSERT INTO agents (login, nom_complet, email, service, service_ad, service_brut, origine, exclu)
    VALUES (?, ?, ?, 'Test technique', 'Test technique', 'CN=test', 'annuaire', 1)
  `).run(login, `TEST ${suffixe}`, `${login}@test.local`);
  return db.prepare('SELECT id FROM agents WHERE login = ?').get(login).id;
}

function nettoyer(jetonInitial) {
  for (const a of db.prepare('SELECT id FROM agents WHERE login LIKE ?').all(`${PREFIXE}%`)) {
    db.prepare(`
      DELETE FROM reponses_agent
      WHERE participation_id IN (SELECT id FROM participations WHERE agent_id = ?)
    `).run(a.id);
    for (const t of ['participations', 'tentatives', 'badges_agent', 'sessions']) {
      db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(a.id);
    }
    db.prepare('DELETE FROM agents WHERE id = ?').run(a.id);
  }
  db.prepare('UPDATE defis SET jeton_apercu = ? WHERE semaine = ?').run(jetonInitial ?? null, premiereSemaine);
  db.prepare("DELETE FROM journal WHERE action LIKE 'apercu_%'").run();
}

const jetonInitial = defiDe(premiereSemaine)?.jeton_apercu ?? null;

test('un jeton cree ouvre le defi, un autre non', () => {
  try {
    const cree = creerJetonApercu(premiereSemaine, 'test');
    assert.ok(cree.jeton, 'un jeton doit etre rendu');

    const defi = defiDe(premiereSemaine);
    assert.equal(jetonValide(defi, cree.jeton), true);
    assert.equal(jetonValide(defi, 'jeton-invente'), false, 'un jeton quelconque ne doit pas ouvrir');
    assert.equal(jetonValide(defi, ''), false);
    assert.equal(jetonValide(defi, null), false);
  } finally { nettoyer(jetonInitial); }
});

test('regenerer invalide le lien precedent', () => {
  try {
    const premier = creerJetonApercu(premiereSemaine, 'test').jeton;
    const second = creerJetonApercu(premiereSemaine, 'test').jeton;
    assert.notEqual(premier, second);
    assert.equal(jetonValide(defiDe(premiereSemaine), premier), false,
      'un lien qui a trop circule doit pouvoir etre repris');
  } finally { nettoyer(jetonInitial); }
});

test('revoquer ferme la porte', () => {
  try {
    const jeton = creerJetonApercu(premiereSemaine, 'test').jeton;
    assert.equal(revoquerJetonApercu(premiereSemaine, 'test'), true);
    assert.equal(jetonValide(defiDe(premiereSemaine), jeton), false);
  } finally { nettoyer(jetonInitial); }
});

test('un defi sans jeton n’ouvre pour personne', () => {
  try {
    revoquerJetonApercu(premiereSemaine, 'test');
    assert.equal(jetonValide(defiDe(premiereSemaine), 'nimporte-quoi'), false);
    // Le piege serait qu'un jeton vide en base accepte un jeton vide presente.
    assert.equal(jetonValide(defiDe(premiereSemaine), ''), false);
    assert.equal(jetonValide(defiDe(premiereSemaine), null), false);
  } finally { nettoyer(jetonInitial); }
});

test("les reponses d'apercu ne preremplissent pas le parcours reel", () => {
  try {
    const id = agent('trace');
    const defi = defiDe(premiereSemaine);
    const question = db.prepare('SELECT * FROM questions WHERE defi_id = ? ORDER BY ordre LIMIT 1').get(defi.id);

    repondre(id, defi.id, { ...question }, [], { apercu: true });
    assert.equal(progression(id, defi.id).length, 1, "l'apercu doit pouvoir repondre");

    // Ce que fait la lecture du defi hors apercu
    effacerTentatives(id, defi.id, { apercuSeulement: true });
    assert.equal(progression(id, defi.id).length, 0,
      "sans cela l'agent trouverait son defi a moitie fait le jour de l'ouverture");
  } finally { nettoyer(jetonInitial); }
});

test("une reponse reelle n'est pas effacee par le nettoyage des apercus", () => {
  try {
    const id = agent('reelle');
    const defi = defiDe(premiereSemaine);
    const question = db.prepare('SELECT * FROM questions WHERE defi_id = ? ORDER BY ordre LIMIT 1').get(defi.id);

    repondre(id, defi.id, { ...question }, [], { apercu: false });
    effacerTentatives(id, defi.id, { apercuSeulement: true });
    assert.equal(progression(id, defi.id).length, 1, 'le nettoyage ne doit viser que les apercus');
  } finally { nettoyer(jetonInitial); }
});

test('le lien porte la semaine et le jeton', () => {
  const lien = lienApercu('https://cybermois.chatillon92.fr/', 3, 'abc');
  assert.equal(lien, 'https://cybermois.chatillon92.fr/defi/3?apercu=abc');
});
