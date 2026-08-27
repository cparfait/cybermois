import test from 'node:test';
import assert from 'node:assert/strict';
import { construireFiltre } from '../src/lib/ldap.js';

const MODELE = '(&(objectClass=user)(objectCategory=person)'
  + '(|(sAMAccountName={{login}})(userPrincipalName={{login}})(mail={{login}})))';

test('les trois marqueurs du filtre sont substitues', () => {
  const filtre = construireFiltre(MODELE, 'p.dupont@chatillon92.fr');
  assert.ok(!filtre.includes('{{login}}'),
    'un marqueur non substitue empeche de se connecter par cet attribut');
  assert.equal(filtre.split('p.dupont@chatillon92.fr').length - 1, 3);
});

test('la connexion par adresse interroge bien l attribut mail', () => {
  const filtre = construireFiltre(MODELE, 'p.dupont@chatillon92.fr');
  assert.ok(filtre.includes('(mail=p.dupont@chatillon92.fr)'));
});

test('la connexion par identifiant reste possible', () => {
  const filtre = construireFiltre(MODELE, 'p.dupont');
  assert.ok(filtre.includes('(sAMAccountName=p.dupont)'));
});

test('les espaces autour de la saisie sont ignores', () => {
  assert.ok(construireFiltre(MODELE, '  p.dupont  ').includes('(mail=p.dupont)'));
});

test('une injection de filtre est echappee partout', () => {
  const filtre = construireFiltre(MODELE, 'a)(objectClass=*');
  assert.ok(!filtre.includes('a)(objectClass=*'));
  assert.equal(filtre.split('a\\29\\28objectClass=\\2a').length - 1, 3);
});

test('un dollar dans la saisie n est pas lu comme un motif de remplacement', () => {
  // '$&' rejouerait la chaine trouvee si le remplacement etait une chaine.
  assert.ok(construireFiltre(MODELE, 'a$&b').includes('(mail=a$&b)'));
});

test('un filtre sans marqueur passe tel quel', () => {
  const fige = '(&(objectClass=user)(sAMAccountName=admin))';
  assert.equal(construireFiltre(fige, 'p.dupont'), fige);
});
