/**
 * Le service d'un agent ne doit pas disparaitre a la synchronisation.
 *
 * Deux regressions observees en production, toutes deux du meme cote : un
 * annuaire ne renseigne jamais tout le monde. Des centaines de fiches ont un
 * « department » vide alors que leur DN dit dans quelle OU elles sont, et
 * quelques-unes ne disent rien du tout. Dans les deux cas, la synchronisation
 * versait l'agent dans « Non rattache » - c'est-a-dire nulle part.
 *
 *   node --test tests/service-annuaire.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/lib/config.js';
import { serviceDepuisAnnuaire } from '../src/lib/ldap.js';
import { db } from '../src/lib/db.js';
import { appliquerSynchronisation } from '../src/lib/synchronisation.js';

const DN = 'CN=Jean Dupont,OU=Etat civil,OU=Population,OU=Utilisateurs,DC=ville,DC=local';

function avec(source, attribut, fn) {
  const memoire = { ...config.service };
  Object.assign(config.service, { source, attribut });
  try { return fn(); } finally { Object.assign(config.service, memoire); }
}

test("l'attribut vide se rabat sur l'OU du DN", () => {
  avec('attr', 'department', () => {
    assert.equal(serviceDepuisAnnuaire({ dn: DN, department: 'Finances' }), 'Finances');
    assert.equal(serviceDepuisAnnuaire({ dn: DN }), 'Etat civil', "l'OU prend le relais");
    assert.equal(serviceDepuisAnnuaire({ dn: DN, department: '' }), 'Etat civil');
    assert.equal(
      serviceDepuisAnnuaire({ dn: 'CN=X,CN=Users,DC=ville,DC=local' }), null,
      'aucune source : null, et surtout pas « Non rattache »'
    );
  });
});

test("l'OU absente se rabat sur l'attribut", () => {
  avec('ou', 'department', () => {
    assert.equal(serviceDepuisAnnuaire({ dn: DN, department: 'Finances' }), 'Etat civil', "l'OU reste prioritaire");
    assert.equal(
      serviceDepuisAnnuaire({ dn: 'CN=X,CN=Users,DC=ville,DC=local', department: 'Finances' }),
      'Finances', "le compte hors OU garde le service de l'attribut"
    );
  });
});

test('un attribut multivalue ne donne pas un service compose', () => {
  avec('attr', 'department', () => {
    assert.equal(serviceDepuisAnnuaire({ dn: DN, department: ['Finances', 'Budget'] }), 'Finances');
  });
});

/* ------------------------------------------------------------ En base */

const PREFIXE = 'zz-test-service-';
const nettoyer = () => {
  db.prepare('DELETE FROM agents WHERE login LIKE ?').run(`${PREFIXE}%`);
  db.prepare("DELETE FROM journal WHERE action LIKE 'synchronisation%' AND detail LIKE '%zz-test-service%'").run();
};
const serviceDe = (login) => db.prepare('SELECT service, service_ad FROM agents WHERE login = ?').get(login);

test("l'annuaire muet sur le service ne vide pas les fiches", async () => {
  try {
    nettoyer();
    const connu = `${PREFIXE}connu`;
    const force = `${PREFIXE}force`;
    db.prepare(`
      INSERT INTO agents (login, nom_complet, email, service, service_ad, service_brut, origine, service_force)
      VALUES (?, 'TEST Connu', ?, 'Etat civil', 'Etat civil', 'CN=test', 'annuaire', 0),
             (?, 'TEST Force', ?, 'Finances', 'Finances', 'CN=test', 'annuaire', 1)
    `).run(connu, `${connu}@test.local`, force, `${force}@test.local`);

    const resultat = await appliquerSynchronisation({
      annuaire: [
        { login: connu, nomComplet: 'TEST Connu', email: `${connu}@test.local`, serviceAd: null, dn: 'CN=test', actif: true },
        { login: force, nomComplet: 'TEST Force', email: `${force}@test.local`, serviceAd: 'Autre OU', dn: 'CN=test', actif: true },
      ],
    }, 'test');

    assert.equal(resultat.ok, true, resultat.message);
    assert.equal(serviceDe(connu).service, 'Etat civil', 'le service connu survit au silence de l\'annuaire');
    assert.equal(serviceDe(connu).service_ad, 'Etat civil', 'le libelle d\'annuaire aussi');
    assert.equal(serviceDe(force).service, 'Finances', 'un rattachement force reste force');
  } finally {
    nettoyer();
  }
});

test("l'annuaire qui parle met bien le service a jour", async () => {
  try {
    nettoyer();
    const login = `${PREFIXE}deplace`;
    db.prepare(`
      INSERT INTO agents (login, nom_complet, email, service, service_ad, service_brut, origine, service_force)
      VALUES (?, 'TEST Deplace', ?, 'Etat civil', 'Etat civil', 'CN=test', 'annuaire', 0)
    `).run(login, `${login}@test.local`);

    await appliquerSynchronisation({
      annuaire: [{
        login, nomComplet: 'TEST Deplace', email: `${login}@test.local`,
        serviceAd: 'Finances', dn: 'CN=test', actif: true,
      }],
    }, 'test');

    assert.equal(serviceDe(login).service, 'Finances');
  } finally {
    nettoyer();
  }
});
