/**
 * Detection des familles de services sur les libelles reels de l'annuaire
 * de la collectivite : tiret separateur, prefixe partage, orthographes
 * divergentes du meme prefixe.
 */
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

// Ce test ne touche a aucune donnee, mais src/lib/services.js charge db.js :
// l'importer creait et ouvrait data/cybermois.db, la base de PRODUCTION.
baseJetable('familles', import.meta.url);
const { db } = await import('../src/lib/db.js');
const { detecterFamilles, cleComparaison } = await import('../src/lib/services.js');
nettoyerALaFin(db);

const SOURCES = [
  'Services Techniques - Parcs et Jardins',
  'Service Techniques - Voirie et Mobilité',
  'Service Technique - Propreté Urbaine',
  'Services Techniques - Bâtiments - Magasin Général',
  'Services Techniques - Parcs et Jardins - Serres',
  'Jeunesse', 'Jeunesse - Club 6-12', 'Jeunesse - Kid Club', 'Jeunesse - Le Chat', 'Jeunesse - BIJ',
  'Crêche Flûte Enchantée', 'Crêche Ile aux Trésors', 'Crêche La Cigogne',
  'Crêche Petit Poucet', 'Crêche Pierrelais', 'Crêche Sablons', 'Crêche Petit Prince',
  'Centre de Loisirs Gambetta Elementaire', 'Centre de Loisirs Gay Lussac Maternelle',
  'Centre de Loisirs Joliot Curie Maternelle', 'Centre de Loisirs Sablons Elementaire',
  'Ressources Humaines', 'Ressources Humaines Carrières', 'Ressources Humaines Formation',
  'Population & Citoyenneté', 'Population et Citoyenneté',
  'Police Municipale', 'Finances', 'CMS', 'Sports',
];

let echecs = 0;
const verifier = (obtenu, attendu, libelle) => {
  const ok = obtenu === attendu;
  if (!ok) echecs++;
  console.log(`${ok ? '  OK  ' : ' ECHEC'} ${libelle.padEnd(46)} -> ${obtenu === undefined ? '(aucune)' : obtenu}`);
};

console.log('Cle de comparaison (casse, accents, pluriel, esperluette) :');
verifier(cleComparaison('Services Techniques'), cleComparaison('Service Technique'), 'pluriel indifferent');
verifier(cleComparaison('Population & Citoyenneté'), cleComparaison('Population et Citoyenneté'), 'esperluette = et');

const f = detecterFamilles(SOURCES);

console.log('\nOrthographes divergentes ramenees a la graphie la plus repandue :');
verifier(f.get('Services Techniques - Parcs et Jardins'), 'Services Techniques', 'Parcs et Jardins');
verifier(f.get('Service Techniques - Voirie et Mobilité'), 'Services Techniques', 'Voirie (orthographe fautive)');
verifier(f.get('Service Technique - Propreté Urbaine'), 'Services Techniques', 'Propreté (autre faute)');

console.log('\nTiret separateur :');
verifier(f.get('Jeunesse - Kid Club'), 'Jeunesse', 'Kid Club');
verifier(f.get('Jeunesse - BIJ'), 'Jeunesse', 'BIJ');

console.log('\nPrefixe partage, sans tiret :');
verifier(f.get('Crêche La Cigogne'), 'Crêche', 'La Cigogne');
verifier(f.get('Crêche Petit Poucet'), 'Crêche', 'Petit Poucet');
verifier(f.get('Centre de Loisirs Gambetta Elementaire'), 'Centre de Loisirs', 'Gambetta');
verifier(f.get('Ressources Humaines Carrières'), 'Ressources Humaines', 'RH Carrières');

console.log('\nDoublon d orthographe entre deux libelles complets :');
// Le libelle retenu comme reference n'a pas de proposition : il EST la cible.
const aboutit = (s) => f.get(s) || s;
verifier(aboutit('Population & Citoyenneté'), aboutit('Population et Citoyenneté'),
  'les deux aboutissent au meme service');

console.log('\nLibelles deja au bon niveau : aucune proposition :');
verifier(f.get('Police Municipale'), undefined, 'Police Municipale');
verifier(f.get('Finances'), undefined, 'Finances');
verifier(f.get('CMS'), undefined, 'CMS');

const distincts = new Set(SOURCES.map((s) => f.get(s) || s));
console.log(`\n  ${SOURCES.length} libelles -> ${distincts.size} services apres regroupement automatique`);

process.exit(echecs ? 1 : 0);
