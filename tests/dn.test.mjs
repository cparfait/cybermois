import { serviceDepuisDn } from '../src/lib/ldap.js';
const dn = 'CN=Jean Dupont,OU=Etat civil,OU=Population,OU=Agents,DC=ville,DC=local';
console.log('profondeur 1 :', serviceDepuisDn(dn, 1));
console.log('profondeur 2 :', serviceDepuisDn(dn, 2));
console.log('profondeur 9 :', serviceDepuisDn(dn, 9));
console.log('sans OU      :', serviceDepuisDn('CN=X,DC=ville,DC=local', 1));
