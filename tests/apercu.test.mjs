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
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('apercu', import.meta.url);
const { db } = await import('../src/lib/db.js');
const { creerJetonApercu, revoquerJetonApercu, jetonValide, lienApercu } = await import('../src/lib/apercu.js');
const { repondre, progression, effacerTentatives } = await import('../src/lib/tentatives.js');
const { enregistrerProgramme } = await import('../src/lib/modules.js');
const { importerContenus } = await import('../src/lib/seed.js');
nettoyerALaFin(db);

// La base jetable est vide. Ces tests supposent une campagne programmee - ils
// prennent « le premier defi » - et tournaient jusqu'ici sur la base de
// production, ou un defi finissait toujours par exister. On monte donc le
// decor comme le fait le demarrage du serveur : le programme d'abord, les
// contenus ensuite. importerContenus() seul ne creerait rien.
enregistrerProgramme([{ module_code: 'mots-de-passe', ouvre_le: '2026-10-05' }], 'test');
importerContenus();

const PREFIXE = 'zz-test-apercu-';
const defiDe = (id) => db.prepare('SELECT * FROM defis WHERE id = ?').get(id);
const premierDefi = db.prepare('SELECT id FROM defis ORDER BY ouvre_le, id LIMIT 1').get()?.id;
assert.ok(premierDefi, 'le decor doit avoir cree un defi : sans lui ces tests ne verifient rien');

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
  db.prepare('UPDATE defis SET jeton_apercu = ? WHERE id = ?').run(jetonInitial ?? null, premierDefi);
  db.prepare("DELETE FROM journal WHERE action LIKE 'apercu_%'").run();
}

const jetonInitial = defiDe(premierDefi)?.jeton_apercu ?? null;

test('un jeton cree ouvre le defi, un autre non', () => {
  try {
    const cree = creerJetonApercu(premierDefi, 'test');
    assert.ok(cree.jeton, 'un jeton doit etre rendu');

    const defi = defiDe(premierDefi);
    assert.equal(jetonValide(defi, cree.jeton), true);
    assert.equal(jetonValide(defi, 'jeton-invente'), false, 'un jeton quelconque ne doit pas ouvrir');
    assert.equal(jetonValide(defi, ''), false);
    assert.equal(jetonValide(defi, null), false);
  } finally { nettoyer(jetonInitial); }
});

test('regenerer invalide le lien precedent', () => {
  try {
    const premier = creerJetonApercu(premierDefi, 'test').jeton;
    const second = creerJetonApercu(premierDefi, 'test').jeton;
    assert.notEqual(premier, second);
    assert.equal(jetonValide(defiDe(premierDefi), premier), false,
      'un lien qui a trop circule doit pouvoir etre repris');
  } finally { nettoyer(jetonInitial); }
});

test('revoquer ferme la porte', () => {
  try {
    const jeton = creerJetonApercu(premierDefi, 'test').jeton;
    assert.equal(revoquerJetonApercu(premierDefi, 'test'), true);
    assert.equal(jetonValide(defiDe(premierDefi), jeton), false);
  } finally { nettoyer(jetonInitial); }
});

test('un defi sans jeton n’ouvre pour personne', () => {
  try {
    revoquerJetonApercu(premierDefi, 'test');
    assert.equal(jetonValide(defiDe(premierDefi), 'nimporte-quoi'), false);
    // Le piege serait qu'un jeton vide en base accepte un jeton vide presente.
    assert.equal(jetonValide(defiDe(premierDefi), ''), false);
    assert.equal(jetonValide(defiDe(premierDefi), null), false);
  } finally { nettoyer(jetonInitial); }
});

test("les reponses d'apercu ne preremplissent pas le parcours reel", () => {
  try {
    const id = agent('trace');
    const defi = defiDe(premierDefi);
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
    const defi = defiDe(premierDefi);
    const question = db.prepare('SELECT * FROM questions WHERE defi_id = ? ORDER BY ordre LIMIT 1').get(defi.id);

    repondre(id, defi.id, { ...question }, [], { apercu: false });
    effacerTentatives(id, defi.id, { apercuSeulement: true });
    assert.equal(progression(id, defi.id).length, 1, 'le nettoyage ne doit viser que les apercus');
  } finally { nettoyer(jetonInitial); }
});

test('le lien porte le defi et le jeton', () => {
  const lien = lienApercu('https://cybermois.chatillon92.fr/', 3, 'abc');
  assert.equal(lien, 'https://cybermois.chatillon92.fr/defi/3?apercu=abc');
});
