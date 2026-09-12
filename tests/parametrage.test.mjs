/**
 * Transport du parametrage de classement.
 *
 * Le scenario reel : la recette produit un fichier, la production est deployee
 * vierge, l'annuaire y est synchronise, puis le fichier est importe. Ce qui
 * doit tenir, c'est que l'aller-retour ne perde rien et qu'un import rejoue
 * deux fois donne le meme resultat - on rejouera apres chaque synchronisation.
 *
 * Les fixtures portent un prefixe reserve et sont nettoyees dans un finally :
 * importerParametrage() ouvre sa propre transaction, on ne peut donc pas
 * l'englober dans une transaction annulee.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('parametrage', import.meta.url);
const { db } = await import('../src/lib/db.js');
const { exporterParametrage, importerParametrage } = await import('../src/lib/parametrage.js');
// Le schema n'est pas tout entier dans db.js : la table « tentatives » est
// creee par le module qui s'en sert, et le nettoyage des fixtures y passe.
await import('../src/lib/tentatives.js');
nettoyerALaFin(db);

const PREFIXE = 'zz-test-param-';

function agent(suffixe, { service = 'Libellé Brut', ...reste } = {}) {
  const login = PREFIXE + suffixe;
  db.prepare(`
    INSERT INTO agents (login, nom_complet, email, service, service_ad, service_brut, origine)
    VALUES (?, ?, ?, ?, ?, 'CN=test', 'annuaire')
  `).run(login, `TEST ${suffixe}`, `${login}@test.local`, service, service);
  const id = db.prepare('SELECT id FROM agents WHERE login = ?').get(login).id;

  if (reste.exclu) {
    db.prepare("UPDATE agents SET exclu = 1, exclu_motif = 'manuel', note = ? WHERE id = ?")
      .run(reste.motif || 'Compte fonctionnel', id);
  }
  if (reste.force) {
    db.prepare('UPDATE agents SET service = ?, service_force = 1 WHERE id = ?').run(reste.force, id);
  }
  return { login, id };
}

const lire = (login) => db.prepare(
  'SELECT service, exclu, exclu_motif, service_force, anonyme FROM agents WHERE login = ?'
).get(login);

function nettoyer() {
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
  db.prepare("DELETE FROM journal WHERE action = 'parametrage_importe' AND detail LIKE '%zz-test%'").run();
}

test("l'export ne retient que les decisions prises a la main", () => {
  try {
    agent('ordinaire');
    const ecarte = agent('ecarte', { exclu: true, motif: 'Boîte fonctionnelle' });
    const force = agent('force', { force: 'Petite Enfance' });

    const p = exporterParametrage({ collectivite: 'Test' });
    const logins = p.agents.map((a) => a.login);

    assert.ok(logins.includes(ecarte.login), 'une exclusion manuelle doit voyager');
    assert.ok(logins.includes(force.login), 'un rattachement force doit voyager');
    assert.ok(!logins.includes(PREFIXE + 'ordinaire'),
      "un agent sans decision n'a rien a faire dans le parametrage");

    const fiche = p.agents.find((a) => a.login === ecarte.login);
    assert.equal(fiche.exclu, true);
    assert.equal(fiche.motif, 'Boîte fonctionnelle');
  } finally { nettoyer(); }
});

test("l'export ne transporte ni scores ni participations", () => {
  try {
    agent('sobre', { exclu: true });
    const p = exporterParametrage();
    const texte = JSON.stringify(p);
    for (const interdit of ['participation', 'score', 'badge', 'session']) {
      assert.ok(!texte.toLowerCase().includes(interdit),
        `un parametrage n'est pas une sauvegarde : « ${interdit} » ne doit pas y figurer`);
    }
  } finally { nettoyer(); }
});

test('un import applique exclusions, rattachements et regroupements', () => {
  try {
    const brut = agent('a-regrouper', { service: 'Crêche Zzz Test' });
    const aEcarter = agent('a-ecarter');
    const aRattacher = agent('a-rattacher', { service: 'Non rattache' });

    const r = importerParametrage({
      version: 1,
      referentiel: [{ nom: 'Petite Enfance Test' }],
      regroupements: [{ source: 'Crêche Zzz Test', cible: 'Petite Enfance Test' }],
      exclusionsSync: [],
      agents: [
        { login: aEcarter.login, exclu: true, motif: 'Compte de service' },
        { login: aRattacher.login, service: 'Petite Enfance Test' },
        { login: 'zz-test-param-inexistant' },
      ],
    }, { parQui: 'test', remplacer: false });

    assert.equal(lire(brut.login).service, 'Petite Enfance Test',
      'le regroupement doit deplacer la fiche');
    assert.equal(lire(aEcarter.login).exclu, 1);
    assert.equal(lire(aEcarter.login).exclu_motif, 'manuel',
      "l'exclusion importee doit resister a la synchronisation");
    assert.equal(lire(aRattacher.login).service, 'Petite Enfance Test');
    assert.equal(lire(aRattacher.login).service_force, 1);

    assert.deepEqual(r.inconnus, ['zz-test-param-inexistant'],
      'un identifiant absent doit etre rapporte, pas cree');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM agents WHERE login = ?')
      .get('zz-test-param-inexistant').n, 0, "l'import ne cree aucun agent");
  } finally {
    db.prepare("DELETE FROM regroupements_service WHERE source = 'Crêche Zzz Test'").run();
    db.prepare("DELETE FROM referentiel_services WHERE nom = 'Petite Enfance Test'").run();
    nettoyer();
  }
});

test('rejouer le meme import ne change rien de plus', () => {
  try {
    const a = agent('idempotent', { service: 'Crêche Zzz Test' });
    const p = {
      version: 1,
      referentiel: [{ nom: 'Petite Enfance Test' }],
      regroupements: [{ source: 'Crêche Zzz Test', cible: 'Petite Enfance Test' }],
      exclusionsSync: [],
      agents: [],
    };

    importerParametrage(p, { parQui: 'test', remplacer: false });
    const apresUn = lire(a.login);

    const deuxieme = importerParametrage(p, { parQui: 'test', remplacer: false });
    assert.deepEqual(lire(a.login), apresUn, 'un second import doit etre sans effet');
    assert.equal(deuxieme.deplaces, 0, 'plus aucun agent ne doit bouger au second passage');
  } finally {
    db.prepare("DELETE FROM regroupements_service WHERE source = 'Crêche Zzz Test'").run();
    db.prepare("DELETE FROM referentiel_services WHERE nom = 'Petite Enfance Test'").run();
    nettoyer();
  }
});

test('un fichier de version inconnue est refuse', () => {
  assert.throws(
    () => importerParametrage({ version: 99, referentiel: [], regroupements: [], exclusionsSync: [], agents: [] }),
    /version/i
  );
  assert.throws(() => importerParametrage({ version: 1, referentiel: [] }), /regroupements/i);
});
