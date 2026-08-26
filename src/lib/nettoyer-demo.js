/**
 * Retrait des donnees de demonstration.
 *
 * Le mode demonstration cree des agents fictifs, et les phases de recette
 * laissent des participations qui n'ont rien a faire dans les classements
 * reels. Ce nettoyage les distingue des vraies fiches par trois marqueurs sans
 * ambiguite, plutot que par une liste d'identifiants qui vieillirait mal :
 *
 *   - le domaine de messagerie fictif   @ville-chatillon.fr
 *   - le domaine fictif dans le DN      DC=ville,DC=local
 *   - le service fictif de l'annuaire simule
 *
 * Les fiches issues de la synchronisation annuaire et le compte
 * d'administration local ne sont jamais touches.
 *
 *   npm run nettoyer-demo             (simulation : rien n'est efface)
 *   npm run nettoyer-demo -- --appliquer
 *   npm run nettoyer-demo -- --appliquer --participations
 */
import { pathToFileURL } from 'node:url';
import { db, journaliser } from './db.js';

const DOMAINE_FICTIF = '%@ville-chatillon.fr';
const DN_FICTIF = '%DC=ville,DC=local%';

/**
 * Le domaine fictif est le marqueur decisif : le domaine reel de la
 * collectivite est chatillon92.fr, jamais ville-chatillon.fr. On ne se fie pas
 * a l'origine de la fiche, car l'annuaire simule cree lui aussi des fiches
 * marquees « annuaire ».
 *
 * Seul le compte d'administration local est protege sans condition : le
 * supprimer couperait l'acces au back-office.
 */
const CONDITION = `
  origine <> 'local'
  AND (
    email LIKE ?
    OR service_brut LIKE ?
    -- Fiches importees depuis un CSV de test : ni adresse, ni DN d'annuaire
    OR (origine = 'import' AND (email IS NULL OR email = '') AND service_brut IS NULL)
  )
`;

export function inventaireDemo() {
  const agents = db.prepare(`
    SELECT id, login, nom_complet, email, service, origine
    FROM agents WHERE ${CONDITION} ORDER BY service, login
  `).all(DOMAINE_FICTIF, DN_FICTIF);

  const ids = agents.map((a) => a.id);
  const marques = ids.length ? ids.map(() => '?').join(',') : 'NULL';

  return {
    agents,
    participations: ids.length
      ? db.prepare(`SELECT COUNT(*) AS n FROM participations WHERE agent_id IN (${marques})`).get(...ids).n
      : 0,
    conserves: db.prepare(
      "SELECT COUNT(*) AS n FROM agents WHERE origine IN ('annuaire', 'local')"
    ).get().n,
  };
}

/**
 * Participations restant apres retrait des fiches fictives.
 *
 * Elles sont portees par de vraies fiches et passent donc inapercues, alors
 * qu'elles viennent des essais : un identifiant fictif peut coincider avec un
 * identifiant reel, la synchronisation ecrase alors le nom et l'adresse mais
 * laisse les resultats en place.
 */
export function participationsReelles() {
  return db.prepare('SELECT COUNT(*) AS n FROM participations').get().n;
}

export function nettoyer({ appliquer = false, participations = false, parQui = 'ligne de commande' } = {}) {
  const inventaire = inventaireDemo();
  const reelles = participationsReelles();

  if (!appliquer) return { simulation: true, ...inventaire, participationsReelles: reelles };

  db.exec('BEGIN');
  try {
    // Les participations, badges et tentatives partent en cascade avec l'agent
    const res = db.prepare(`DELETE FROM agents WHERE ${CONDITION}`).run(DOMAINE_FICTIF, DN_FICTIF);

    let effaceesReelles = 0;
    if (participations) {
      // Toutes les participations restantes : celles des fiches fictives sont
      // deja parties en cascade, il ne reste que des resultats d'essais.
      effaceesReelles = db.prepare('DELETE FROM participations').run().changes;
      db.exec('DELETE FROM badges_agent');
      db.exec('DELETE FROM tentatives');
    }
    db.exec('COMMIT');

    journaliser(parQui, 'nettoyage_demo',
      `${res.changes} agent(s) fictif(s), ${effaceesReelles} participation(s) de recette`, null);

    return {
      simulation: false,
      agentsSupprimes: res.changes,
      participationsSupprimees: effaceesReelles,
      conserves: inventaire.conserves,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appliquer = process.argv.includes('--appliquer');
  const participations = process.argv.includes('--participations');
  const r = nettoyer({ appliquer, participations });

  if (r.simulation) {
    console.log(`\n  ${r.agents.length} fiche(s) de démonstration détectée(s) :\n`);
    for (const a of r.agents) {
      console.log(`    ${a.login.padEnd(14)} ${(a.nom_complet || '').padEnd(20)} `
        + `${(a.service || '').padEnd(26)} ${a.email || '(sans adresse)'}`);
    }
    console.log(`\n  ${r.participations} participation(s) rattachée(s) à ces fiches`);
    console.log(`  ${r.participationsReelles} participation(s) au total, essais compris`);
    console.log(`  ${r.conserves} fiche(s) réelle(s) conservée(s)\n`);
    console.log('  Rien n\'a été effacé. Pour appliquer :');
    console.log('    npm run nettoyer-demo -- --appliquer');
    console.log('  Pour effacer aussi les participations de recette des vrais agents :');
    console.log('    npm run nettoyer-demo -- --appliquer --participations\n');
  } else {
    console.log(`\n  ${r.agentsSupprimes} fiche(s) de démonstration supprimée(s).`);
    if (r.participationsSupprimees) {
      console.log(`  ${r.participationsSupprimees} participation(s) de recette effacée(s).`);
    }
    console.log(`  ${r.conserves} fiche(s) réelle(s) conservée(s).\n`);
  }
}
