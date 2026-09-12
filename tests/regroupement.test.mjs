/**
 * Verifie que la proposition de regroupement saute les conteneurs techniques
 * et retient la bonne OU intermediaire, y compris quand les branches n'ont pas
 * la meme profondeur.
 */
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

// Ce test ne touche a aucune donnee, mais src/lib/services.js charge db.js :
// l'importer creait et ouvrait data/cybermois.db, la base de PRODUCTION.
baseJetable('regroupement', import.meta.url);
const { db } = await import('../src/lib/db.js');
const { chaineOu } = await import('../src/lib/services.js');
nettoyerALaFin(db);

let echecs = 0;
const verifier = (obtenu, attendu, libelle) => {
  const ok = JSON.stringify(obtenu) === JSON.stringify(attendu);
  if (!ok) echecs++;
  console.log(`${ok ? '  OK  ' : ' ECHEC'} ${libelle} -> ${JSON.stringify(obtenu)}${ok ? '' : ` (attendu ${JSON.stringify(attendu)})`}`);
};

console.log("Lecture de l'arborescence des OU :");
verifier(
  chaineOu('CN=Marie X,OU=Creches,OU=Petite enfance,OU=Population,OU=Agents,DC=ville,DC=local'),
  ['Creches', 'Petite enfance', 'Population', 'Agents'],
  'chaine complete, de la plus proche a la plus haute'
);
verifier(chaineOu('CN=Y,OU=Finances,DC=ville,DC=local'), ['Finances'], 'une seule OU');
verifier(chaineOu('CN=Z,CN=Users,DC=ville,DC=local'), [], 'aucune OU');
verifier(
  chaineOu(String.raw`CN=A,OU=Finances\, budget,OU=Agents,DC=ville,DC=local`),
  ['Finances, budget', 'Agents'],
  'virgule echappee dans le nom d OU'
);

// Simulation de la logique de proposition sur une arborescence realiste
console.log("\nProposition de regroupement (le conteneur technique doit etre ignore) :");
const dns = {
  'Creches':               'CN=a,OU=Creches,OU=Petite enfance,OU=Agents,DC=v,DC=l',
  'Multi-accueil':         'CN=b,OU=Multi-accueil,OU=Petite enfance,OU=Agents,DC=v,DC=l',
  'Ecoles maternelles':    'CN=c,OU=Ecoles maternelles,OU=Affaires scolaires,OU=Agents,DC=v,DC=l',
  'Restauration scolaire': 'CN=d,OU=Restauration scolaire,OU=Affaires scolaires,OU=Agents,DC=v,DC=l',
  'Finances':              'CN=e,OU=Finances,OU=Agents,DC=v,DC=l',
};

const chaines = Object.values(dns).map(chaineOu);
const avecOu = chaines.filter((c) => c.length).length;
const frequence = new Map();
for (const c of chaines) for (const ou of new Set(c)) frequence.set(ou, (frequence.get(ou) || 0) + 1);
const estGenerique = (ou) => avecOu > 1 && frequence.get(ou) >= avecOu;

const propositions = {};
Object.entries(dns).forEach(([source], i) => {
  const ous = chaines[i];
  let p = null;
  for (let n = 1; n < ous.length; n++) {
    if (ous[n] !== source && !estGenerique(ous[n])) { p = ous[n]; break; }
  }
  propositions[source] = p;
});

verifier(propositions['Creches'], 'Petite enfance', 'Creches');
verifier(propositions['Multi-accueil'], 'Petite enfance', 'Multi-accueil');
verifier(propositions['Ecoles maternelles'], 'Affaires scolaires', 'Ecoles maternelles');
verifier(propositions['Restauration scolaire'], 'Affaires scolaires', 'Restauration scolaire');
verifier(propositions['Finances'], null, 'Finances, deja au bon niveau, pas de proposition');
console.log(`  (« Agents » present dans les ${avecOu} branches : correctement ignore)`);

process.exit(echecs ? 1 : 0);
