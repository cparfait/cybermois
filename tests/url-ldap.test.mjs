/**
 * Composition de l'URL de l'annuaire.
 *
 * Ce test existe a cause d'une confusion reelle en production :
 * « ldap://10.0.0.1:636 » - le port du LDAPS, le schema du LDAP. La
 * negociation TLS n'a jamais lieu, et les mots de passe circulent en clair
 * sur le port cense les proteger.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decomposerUrlLdap, composerUrlLdap, normaliserUrlLdap } from '../src/lib/url-ldap.js';

test('une IP seule devient une URL chiffree', () => {
  assert.equal(composerUrlLdap('10.0.0.1'), 'ldaps://10.0.0.1:636');
  assert.equal(normaliserUrlLdap('10.0.0.1'), 'ldaps://10.0.0.1:636');
});

test('un FQDN seul devient une URL chiffree', () => {
  assert.equal(composerUrlLdap('dc01.exemple.lan'), 'ldaps://dc01.exemple.lan:636');
});

test('decocher le chiffrement bascule schema et port', () => {
  assert.equal(composerUrlLdap('10.0.0.1', { chiffre: false }), 'ldap://10.0.0.1:389');
});

test('le port est toujours ecrit, standard ou non', () => {
  // Une URL complete se relit sans connaitre le defaut de la bibliotheque.
  assert.equal(composerUrlLdap('10.0.0.1', { chiffre: true, port: 636 }), 'ldaps://10.0.0.1:636');
  assert.equal(composerUrlLdap('10.0.0.1', { chiffre: true, port: 3269 }), 'ldaps://10.0.0.1:3269');
});

test('une URL complete existante est relue sans etre abimee', () => {
  const u = decomposerUrlLdap('ldaps://dc01.exemple.lan:636');
  assert.equal(u.hote, 'dc01.exemple.lan');
  assert.equal(u.chiffre, true);
  assert.equal(u.port, 636);
  assert.equal(normaliserUrlLdap('ldaps://dc01.exemple.lan:636'), 'ldaps://dc01.exemple.lan:636');
});

test('le schema demande l’emporte sur celui de la saisie', () => {
  // Le cas de production : le port etait bon, le schema non.
  assert.equal(normaliserUrlLdap('ldap://10.0.0.1:636', true), 'ldaps://10.0.0.1:636');
});

test('une saisie sans schema est consideree comme chiffree', () => {
  // L'inverse exposerait les mots de passe de cinq cents agents sur une omission.
  assert.equal(decomposerUrlLdap('10.0.0.1').chiffre, true);
});

test('les scories de copier-coller sont retirees', () => {
  assert.equal(normaliserUrlLdap('  ldaps://10.0.0.1/  '), 'ldaps://10.0.0.1:636');
  assert.equal(normaliserUrlLdap('LDAPS://DC01.exemple.lan'), 'ldaps://DC01.exemple.lan:636');
});

test('le mode demonstration traverse sans transformation', () => {
  assert.equal(normaliserUrlLdap('demo'), 'demo');
  assert.equal(composerUrlLdap('demo'), 'demo');
  assert.equal(decomposerUrlLdap('demo').demo, true);
});

test('une saisie vide reste vide', () => {
  assert.equal(normaliserUrlLdap(''), '');
  assert.equal(composerUrlLdap('   '), '');
});
