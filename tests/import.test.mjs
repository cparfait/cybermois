import { preparerImport, analyserCsv } from '../src/lib/import-csv.js';

let echecs = 0;
const verifier = (condition, libelle, detail = '') => {
  if (!condition) echecs++;
  console.log(`${condition ? '  OK  ' : ' ECHEC'} ${libelle}${detail ? ` -> ${detail}` : ''}`);
};

console.log('Export PowerShell classique (separateur ; en-tetes AD) :');
const ps = `"SamAccountName";"DisplayName";"Mail";"Department"
"s.leroy";"Sophie LEROY";"s.leroy@ville-chatillon.fr";"Etat civil"
"p.martin";"Paul MARTIN";"p.martin@ville-chatillon.fr";"Etat civil"
"f.lambert";"Fatou LAMBERT";"";"Services techniques"`;
let r = preparerImport(ps);
verifier(r.ok, 'analyse reussie');
verifier(r.agents.length === 3, '3 agents retenus', r.agents.length);
verifier(r.agents[0].service === 'Etat civil', 'service lu', r.agents[0].service);
verifier(r.agents[2].email === null, 'adresse vide -> null');
verifier(r.resume.sansEmail === 1, '1 agent sans adresse');

console.log('\nExport Excel avec BOM, virgule et colonnes francaises :');
const excel = `﻿Identifiant,Prénom,Nom,Courriel,Direction
j.dubois,Julien,DUBOIS,j.dubois@ville-chatillon.fr,Ressources humaines
n.moreau,Nadia,MOREAU,n.moreau@ville-chatillon.fr,Ressources humaines`;
r = preparerImport(excel);
verifier(r.separateur === ',', 'separateur virgule detecte', r.separateur);
verifier(r.agents[0].nomComplet === 'Julien DUBOIS', 'prenom + nom recomposes', r.agents[0].nomComplet);

console.log('\nService deduit du DN quand aucune colonne service :');
const avecDn = `login;DistinguishedName
a.bernard;"CN=Alice BERNARD,OU=Etat civil,OU=Agents,DC=ville,DC=local"`;
r = preparerImport(avecDn, { ouDepth: 1 });
verifier(r.agents[0].service === 'Etat civil', 'service extrait du DN', r.agents[0].service);

console.log('\nCas sales : doublons, login prefixe par le domaine, ligne vide, mail invalide :');
const sale = String.raw`login;nom complet;mail;service
VILLE\L.PETIT;Lucas PETIT;l.petit@ville-chatillon.fr;Affaires scolaires
l.petit;Lucas PETIT (doublon);l.petit@ville-chatillon.fr;Affaires scolaires
;Sans identifiant;x@y.fr;Finances

e.roux;Emma ROUX;pas-une-adresse;Affaires scolaires`;
r = preparerImport(sale);
verifier(r.agents.length === 2, '2 agents retenus', r.agents.length);
verifier(r.agents[0].login === 'l.petit', 'prefixe DOMAINE retire', r.agents[0].login);
verifier(r.rejets.length === 2, '2 rejets (doublon + identifiant vide)', r.rejets.length);
verifier(r.agents[1].email === null, 'adresse invalide ecartee');

console.log('\nChamps entre guillemets contenant le separateur :');
const guillemets = `login;service
v.chevalier;"Finances, budget et commande publique"`;
r = preparerImport(guillemets);
verifier(r.agents[0].service === 'Finances, budget et commande publique', 'virgule protegee', r.agents[0].service);

console.log('\nFichier sans colonne identifiant :');
r = preparerImport('nom;service\nDupont;Finances');
verifier(!r.ok, 'refus explicite');
verifier(/identifiant/i.test(r.erreur), 'message explicite');

console.log('\nFichier vide :');
verifier(!preparerImport('').ok, 'refus');
verifier(analyserCsv('').entetes.length === 0, 'analyse vide sans plantage');

process.exit(echecs ? 1 : 0);
