import test from 'node:test';
import assert from 'node:assert/strict';
import { prenomUsuel } from '../src/lib/prenom.js';

test('l attribut de l annuaire fait foi', () => {
  assert.equal(prenomUsuel('DUPONT Claire', 'Claire'), 'Claire');
  assert.equal(prenomUsuel('nimporte quoi', 'Jean-Luc'), 'Jean-Luc');
});

test('un prenom compose sur deux mots se reduit au premier', () => {
  assert.equal(prenomUsuel('MARTIN Anne Sophie', 'Anne Sophie'), 'Anne');
});

test('sans attribut, le nom en majuscules est ecarte', () => {
  assert.equal(prenomUsuel('DUPONT Claire', null), 'Claire');
  assert.equal(prenomUsuel('Claire DUPONT', null), 'Claire');
  assert.equal(prenomUsuel('BOISROND-CANAL Laurent-Jude', ''), 'Laurent-Jude');
});

test('les particules restent avec le nom', () => {
  assert.equal(prenomUsuel('DE LA TOUR Marie', null), 'Marie');
  assert.equal(prenomUsuel('Marie VAN DEN BERG', null), 'Marie');
});

test('une initiale ne passe pas pour un nom de famille', () => {
  assert.equal(prenomUsuel('DUPONT Claire M', null), 'Claire');
});

test('sans casse distinctive, on retombe sur Prenom Nom', () => {
  assert.equal(prenomUsuel('claire dupont', null), 'claire');
  assert.equal(prenomUsuel('CLAIRE DUPONT', null), 'CLAIRE');
});

test('un identifiant seul se rend tel quel', () => {
  assert.equal(prenomUsuel('c.dupont', null), 'c.dupont');
});

test('une fiche sans nom ne fait pas planter l accueil', () => {
  assert.equal(prenomUsuel(null, null), '');
  assert.equal(prenomUsuel('', ''), '');
  assert.equal(prenomUsuel('   ', undefined), '');
});
