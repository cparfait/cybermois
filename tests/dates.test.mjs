import { dateOuverture } from '../src/lib/seed.js';
import { config } from '../src/lib/config.js';

let echecs = 0;
const verifier = (obtenu, attendu, libelle) => {
  const ok = obtenu === attendu;
  if (!ok) echecs++;
  console.log(`${ok ? '  OK  ' : ' ECHEC'} ${libelle} -> ${obtenu}${ok ? '' : ` (attendu ${attendu})`}`);
};

config.campagne.debut = '2026-10-05';
console.log('Campagne demarrant le lundi 5 octobre 2026 :');
verifier(dateOuverture(1), '2026-10-05', 'semaine 1');
verifier(dateOuverture(2), '2026-10-12', 'semaine 2');
verifier(dateOuverture(3), '2026-10-19', 'semaine 3');
verifier(dateOuverture(4), '2026-10-26', 'semaine 4');

console.log('\nPassage a l heure d hiver (dernier dimanche d octobre) :');
config.campagne.debut = '2026-10-26';
verifier(dateOuverture(1), '2026-10-26', 'semaine 1');
verifier(dateOuverture(2), '2026-11-02', 'semaine 2 apres changement d heure');

console.log('\nChangement de mois et d annee :');
config.campagne.debut = '2026-12-28';
verifier(dateOuverture(2), '2027-01-04', 'passage 2026 -> 2027');

process.exit(echecs ? 1 : 0);
