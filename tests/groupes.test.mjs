import { appartientAuGroupe } from '../src/lib/ldap.js';

let echecs = 0;
const verifier = (obtenu, attendu, libelle) => {
  const ok = obtenu === attendu;
  if (!ok) echecs++;
  console.log(`${ok ? '  OK  ' : ' ECHEC'} ${libelle} -> ${obtenu}`);
};

const memberOf = [
  'CN=GG-Cybermois-Admins,OU=zzzGroupes,OU=Utilisateurs,OU=CHATILLON,DC=chatillon,DC=lan',
  'CN=GRP_DSI,OU=zzzGroupes,OU=Utilisateurs,OU=CHATILLON,DC=chatillon,DC=lan',
  'CN=Domain Users,CN=Users,DC=chatillon,DC=lan',
];

console.log('Appartenance par nom court :');
verifier(appartientAuGroupe(memberOf, 'GG-Cybermois-Admins'), true, 'nom exact');
verifier(appartientAuGroupe(memberOf, 'gg-cybermois-admins'), true, 'casse differente');
verifier(appartientAuGroupe(memberOf, '  GG-Cybermois-Admins  '), true, 'espaces autour');
verifier(appartientAuGroupe(memberOf, 'GG-Cybermois-Lecteurs'), false, 'groupe absent');

console.log('\nAppartenance par DN complet :');
verifier(appartientAuGroupe(memberOf, memberOf[0]), true, 'DN exact');
verifier(appartientAuGroupe(memberOf, memberOf[0].toUpperCase()), true, 'DN en majuscules');
verifier(appartientAuGroupe(memberOf, 'CN=GG-Cybermois-Admins,OU=Autre,DC=chatillon,DC=lan'), false, 'DN d une autre OU');

console.log('\nCas particuliers :');
verifier(appartientAuGroupe(memberOf, ''), true, 'aucun groupe exige = tout le monde passe');
verifier(appartientAuGroupe([], 'GG-Cybermois-Admins'), false, 'agent sans aucun groupe');
verifier(appartientAuGroupe([String.raw`CN=Groupe\, avec virgule,OU=G,DC=x`], 'Groupe, avec virgule'), true,
  'virgule echappee dans le nom du groupe');

process.exit(echecs ? 1 : 0);
