/**
 * Gestion du compte administrateur local en ligne de commande.
 *
 * Indispensable quand le mot de passe a ete perdu : le compte n'etant cree
 * qu'une fois, il n'est plus affiche dans les journaux aux demarrages suivants.
 *
 *   npm run admin -- lister
 *   npm run admin -- definir admin "ma phrase de passe"
 *   npm run admin -- definir admin            (mot de passe genere)
 *   npm run admin -- supprimer ancien-compte
 *
 * En conteneur :
 *   docker compose exec cybermois npm run admin -- definir admin "ma phrase"
 */
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  listerAdminsLocaux, definirAdminLocal, supprimerAdminLocal, existeAdminLocal,
} from './admin-local.js';

function afficherAide() {
  console.log(`
Gestion du compte administrateur local

  lister                          Liste les comptes existants
  definir <login> [mot de passe]  Cree le compte ou remplace son mot de passe.
                                  Sans mot de passe, un mot de passe est genere.
  supprimer <login>               Supprime le compte (le dernier est protege)

Exemples
  npm run admin -- lister
  npm run admin -- definir admin "carotte-tabouret-pluie-42"
  npm run admin -- definir admin
`);
}

export function executer(arguments_) {
  const [commande, login, motDePasse] = arguments_;

  if (!commande || commande === 'aide' || commande === '--help') {
    afficherAide();
    return 0;
  }

  if (commande === 'lister') {
    const comptes = listerAdminsLocaux();
    if (!comptes.length) {
      console.log('Aucun compte local. Un compte sera cree au prochain demarrage.');
      return 0;
    }
    console.log(`\n${comptes.length} compte(s) local(aux) :\n`);
    for (const c of comptes) {
      console.log(`  ${c.login.padEnd(16)} cree le ${(c.cree_le || '').slice(0, 10)}`
        + `   derniere connexion : ${(c.vu_le || 'jamais').slice(0, 16)}`
        + (c.provisoire ? '   [mot de passe provisoire]' : ''));
    }
    console.log('');
    return 0;
  }

  if (commande === 'definir') {
    if (!login) { console.error('Identifiant manquant.\n'); afficherAide(); return 1; }
    const mdp = motDePasse || crypto.randomBytes(12).toString('base64url');
    try {
      definirAdminLocal(login, mdp, { provisoire: !motDePasse, parQui: 'ligne de commande' });
    } catch (e) {
      console.error(`Echec : ${e.message}`);
      return 1;
    }
    console.log('\n  Compte administrateur local enregistre.\n');
    console.log(`    Identifiant  : ${String(login).toLowerCase()}`);
    console.log(`    Mot de passe : ${mdp}`);
    console.log('\n  Connexion : page d\'accueil du portail, lien « Connexion administrateur local ».\n');
    return 0;
  }

  if (commande === 'supprimer') {
    if (!login) { console.error('Identifiant manquant.\n'); afficherAide(); return 1; }
    try {
      supprimerAdminLocal(login, 'ligne de commande');
      console.log(`Compte « ${login} » supprime.`);
      return 0;
    } catch (e) {
      console.error(`Echec : ${e.message}`);
      return 1;
    }
  }

  console.error(`Commande inconnue : ${commande}\n`);
  afficherAide();
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void existeAdminLocal; // garantit l'initialisation du schema avant toute commande
  process.exit(executer(process.argv.slice(2)));
}
