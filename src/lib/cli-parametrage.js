import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  exporterParametrage, importerParametrage, lireFichier, ecrireFichier,
} from './parametrage.js';

/**
 * Transport du parametrage de classement d'une instance a l'autre.
 *
 *   npm run parametrage -- exporter [fichier] [--collectivite "Ville de X"]
 *   npm run parametrage -- importer <fichier> [--completer]
 *   npm run parametrage -- resumer  <fichier>
 *
 * L'usage prevu : exporter depuis la recette, deployer, synchroniser
 * l'annuaire, puis importer. L'ordre compte - l'import ne cree pas d'agent,
 * il applique des decisions a des fiches qui doivent deja exister.
 */

const DEFAUT = 'parametrage/classement.json';

const args = process.argv.slice(2);
const commande = args[0];
const options = new Set(args.filter((a) => a.startsWith('--')));
const positions = args.slice(1).filter((a) => !a.startsWith('--'));

function valeurOption(nom) {
  const i = args.indexOf(`--${nom}`);
  return i >= 0 ? args[i + 1] : '';
}

function aide() {
  console.log(`Parametrage du classement : referentiel, regroupements, exclusions.

  exporter [fichier]        Ecrit le parametrage courant (defaut : ${DEFAUT})
           --collectivite   Nom porte dans le fichier, a titre documentaire
           --note           Commentaire libre

  importer <fichier>        Applique un parametrage. Remplace le referentiel et
                            les regroupements existants.
           --completer      Complete au lieu de remplacer : rien n'est efface.

  resumer  <fichier>        Affiche ce que contient un fichier, sans rien ecrire.

Ordre a respecter en production : deployer, synchroniser l'annuaire, PUIS
importer. L'import ne cree aucun agent - il applique des decisions a des fiches
qui doivent deja exister.`);
}

function resume(p) {
  console.log(`  collectivite   ${p.collectivite || '(non renseignee)'}`);
  if (p.note) console.log(`  note           ${p.note}`);
  console.log(`  referentiel    ${p.referentiel.length} service(s)`);
  console.log(`  regroupements  ${p.regroupements.length} regle(s)`);
  console.log(`  exclusions     ${p.exclusionsSync.length} regle(s) de synchronisation`);
  const exclus = p.agents.filter((a) => a.exclu).length;
  const rattaches = p.agents.filter((a) => a.service).length;
  const anonymes = p.agents.filter((a) => a.anonyme).length;
  console.log(`  agents         ${p.agents.length} fiche(s) : ${exclus} exclu(s), `
    + `${rattaches} rattachement(s) force(s), ${anonymes} masque(s)`);
}

switch (commande) {
  case 'exporter': {
    const cible = positions[0] || DEFAUT;
    const p = exporterParametrage({
      collectivite: valeurOption('collectivite'),
      note: valeurOption('note'),
    });
    const ecrit = ecrireFichier(cible, p);
    console.log(`Parametrage exporte vers ${path.relative(process.cwd(), ecrit)}\n`);
    resume(p);
    break;
  }

  case 'importer': {
    if (!positions[0]) { console.error('Indiquez le fichier a importer.'); process.exit(1); }
    const p = lireFichier(positions[0]);
    console.log('Fichier lu :\n');
    resume(p);

    const remplacer = !options.has('--completer');
    console.log(`\nMode : ${remplacer ? 'remplacement' : 'complement'}\n`);

    const r = importerParametrage(p, { parQui: 'cli', remplacer });
    console.log(`  referentiel    ${r.referentiel} service(s)`);
    console.log(`  regroupements  ${r.regroupements} regle(s)`);
    console.log(`  exclusions     ${r.exclusionsSync} regle(s) de synchronisation`);
    console.log(`  agents         ${r.exclus} exclu(s), ${r.rattaches} rattache(s), ${r.anonymes} masque(s)`);
    console.log(`  classement     ${r.deplaces} agent(s) ont change de service`);

    if (r.inconnus.length) {
      console.log(`\n  ${r.inconnus.length} identifiant(s) absent(s) de la base, ignore(s) :`);
      for (const l of r.inconnus.slice(0, 30)) console.log(`    ${l}`);
      if (r.inconnus.length > 30) console.log(`    … et ${r.inconnus.length - 30} autre(s)`);
      console.log('\n  Si vous ne les attendiez pas absents, verifiez que la synchronisation');
      console.log("  de l'annuaire a bien tourne AVANT cet import.");
    }
    break;
  }

  case 'resumer': {
    if (!positions[0]) { console.error('Indiquez le fichier a resumer.'); process.exit(1); }
    resume(lireFichier(positions[0]));
    break;
  }

  default:
    aide();
    if (commande) process.exit(1);
}

void pathToFileURL;
