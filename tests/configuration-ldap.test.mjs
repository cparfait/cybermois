/**
 * Enregistrement de l'adresse de l'annuaire depuis l'ecran de configuration.
 *
 * L'ecran envoie deux valeurs pour un seul parametre : l'hote et une case
 * « liaison chiffree ». La seconde n'est pas stockee, elle sert a composer
 * l'URL. Un controle des cles inconnues l'a fait rejeter, et l'enregistrement
 * echouait en entier - toutes les modifications de la page etaient perdues,
 * sur un message qui ne designait rien d'anormal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { enregistrerParametres, lireParametres } from '../src/lib/parametres.js';

const valeurStockee = (cle) =>
  db.prepare('SELECT valeur FROM parametres WHERE cle = ?').get(cle)?.valeur ?? null;

const memoire = valeurStockee('ldap.url');
const restaurer = () => {
  if (memoire === null) db.prepare("DELETE FROM parametres WHERE cle = 'ldap.url'").run();
  else db.prepare("UPDATE parametres SET valeur = ? WHERE cle = 'ldap.url'").run(memoire);
};

test("un hote nu et la case cochee composent une URL chiffree", () => {
  try {
    enregistrerParametres({ 'ldap.url': 'srv-dc01.chatillon.lan', 'ldap.chiffre': true }, 'test');
    assert.equal(valeurStockee('ldap.url'), 'ldaps://srv-dc01.chatillon.lan:636');
  } finally { restaurer(); }
});

test('la case decochee bascule en clair, sur le port correspondant', () => {
  try {
    enregistrerParametres({ 'ldap.url': 'srv-dc01.chatillon.lan', 'ldap.chiffre': false }, 'test');
    assert.equal(valeurStockee('ldap.url'), 'ldap://srv-dc01.chatillon.lan:389');
  } finally { restaurer(); }
});

test("la case l'emporte sur un schema saisi a la main", () => {
  try {
    // Le cas de production : le port etait bon, le schema non.
    enregistrerParametres({ 'ldap.url': 'ldap://192.168.2.9:636', 'ldap.chiffre': true }, 'test');
    assert.equal(valeurStockee('ldap.url'), 'ldaps://192.168.2.9:636');
  } finally { restaurer(); }
});

test("la case absente laisse le schema de la saisie decider", () => {
  try {
    enregistrerParametres({ 'ldap.url': 'ldaps://srv-dc01.chatillon.lan' }, 'test');
    assert.equal(valeurStockee('ldap.url'), 'ldaps://srv-dc01.chatillon.lan:636');
  } finally { restaurer(); }
});

test("l'ecran relit ce qu'il a enregistre", () => {
  try {
    enregistrerParametres({ 'ldap.url': 'srv-dc01.chatillon.lan', 'ldap.chiffre': true }, 'test');
    const d = lireParametres().find((x) => x.cle === 'ldap.url');
    assert.equal(d.valeur, 'ldaps://srv-dc01.chatillon.lan:636');
    assert.equal(d.type, 'ldap-hote', "le type pilote l'affichage hote + case");
  } finally { restaurer(); }
});
