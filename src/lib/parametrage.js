import fs from 'node:fs';
import path from 'node:path';
import { db, journaliser } from './db.js';
import { cleComparaison, normaliser, appliquerRegroupements } from './services.js';
// Ces deux modules portent la definition de leurs tables. Les importer garantit
// qu'elles existent : sur une base neuve - le cas meme de la production -
// l'import echouait sinon sur « no such table ».
import { nomsReferentiel } from './referentiel.js';
import { lireExclusions } from './synchronisation.js';

/**
 * Export et import du parametrage de classement.
 *
 * Regrouper quatre-vingt-seize libelles d'annuaire en trente-huit services,
 * ecarter les comptes fonctionnels, rattacher a la main ceux que l'annuaire
 * ne renseigne pas : ce travail represente plusieurs heures et ne se devine
 * pas. Le refaire en production apres la premiere synchronisation serait
 * absurde, et l'inscrire en dur dans le code interdirait a une autre
 * collectivite d'utiliser l'application.
 *
 * Il vit donc dans un fichier, hors du code, que l'on transporte. Rien n'est
 * charge automatiquement : l'import se demande.
 *
 * Ce qui est emporte :
 *
 *   referentiel     la liste des services reconnus, dans son ordre
 *   regroupements   libelle d'annuaire -> service du referentiel
 *   exclusionsSync  les regles qui ecartent des comptes a la synchronisation
 *   agents          les decisions prises agent par agent : exclusion manuelle,
 *                   rattachement force, masquage du classement
 *
 * Ce qui ne l'est pas : les participations, les scores, les badges et les
 * sessions. Un parametrage n'est pas une sauvegarde.
 *
 * Les agents sont designes par leur identifiant, jamais par leur cle primaire :
 * une base neuve leur en donnera d'autres.
 */

const VERSION = 1;

export function exporterParametrage({ collectivite = '', note = '' } = {}) {
  const referentiel = db.prepare(
    'SELECT nom, ordre, actif FROM referentiel_services ORDER BY ordre, nom COLLATE NOCASE'
  ).all();

  const regroupements = db.prepare(
    'SELECT source, cible FROM regroupements_service ORDER BY cible, source'
  ).all();

  const exclusionsSync = db.prepare(
    'SELECT champ, motif FROM exclusions_sync ORDER BY champ, motif'
  ).all();

  // Seules les decisions prises a la main voyagent. Une exclusion prononcee par
  // l'annuaire - compte desactive, compte disparu - se reconstituera d'elle-meme
  // a la premiere synchronisation ; la transporter figerait un etat perime.
  const agents = db.prepare(`
    SELECT login, nom_complet, service, service_ad, exclu, exclu_motif, service_force, anonyme, note
    FROM agents
    WHERE origine <> 'local'
      AND ((exclu = 1 AND exclu_motif = 'manuel') OR service_force = 1 OR anonyme = 1)
    ORDER BY login
  `).all().map((a) => ({
    login: a.login,
    // Le nom n'est pas relu a l'import : il est la pour qu'un humain puisse
    // relire le fichier et reconnaitre de qui il s'agit.
    nom: a.nom_complet,
    ...(a.exclu ? { exclu: true, motif: a.note || null } : {}),
    ...(a.service_force ? { service: a.service, serviceAnnuaire: a.service_ad || null } : {}),
    ...(a.anonyme ? { anonyme: true } : {}),
  }));

  return {
    version: VERSION,
    collectivite,
    note,
    referentiel: referentiel.map((r) => ({ nom: r.nom, actif: !!r.actif })),
    regroupements,
    exclusionsSync,
    agents,
  };
}

/** Controle de forme, avant toute ecriture. */
function verifier(p) {
  if (!p || typeof p !== 'object') throw new Error('Fichier illisible.');
  if (p.version !== VERSION) {
    throw new Error(`Version de parametrage ${p.version} non prise en charge (attendu ${VERSION}).`);
  }
  for (const champ of ['referentiel', 'regroupements', 'exclusionsSync', 'agents']) {
    if (!Array.isArray(p[champ])) throw new Error(`Section « ${champ} » absente ou mal formee.`);
  }
}

/**
 * Applique un parametrage.
 *
 * `remplacer` decide du sort de l'existant : vrai, le referentiel et les
 * regroupements sont reecrits ; faux, ils sont completes. Le second mode sert
 * a rejouer un parametrage apres une synchronisation sans perdre ce qui a ete
 * decide entre-temps.
 *
 * Les agents absents de la base ne sont pas crees : un parametrage ne fabrique
 * pas d'effectif. Ils sont rapportes, pour qu'on sache ce qui n'a pas pris.
 */
export function importerParametrage(parametrage, { parQui = 'import', remplacer = true } = {}) {
  verifier(parametrage);

  // Lecture inoffensive, qui force la creation des tables portees par les
  // modules importes plus haut avant que la transaction ne s'ouvre.
  const avant = { referentiel: nomsReferentiel().length, exclusions: lireExclusions().length };

  const rapport = {
    referentiel: 0, regroupements: 0, exclusionsSync: 0,
    exclus: 0, rattaches: 0, anonymes: 0,
    inconnus: [],
  };

  db.exec('BEGIN');
  try {
    /* ---------------------------------------------------------- Referentiel */
    const existants = remplacer
      ? []
      : db.prepare('SELECT nom FROM referentiel_services ORDER BY ordre, nom').all().map((r) => r.nom);
    if (remplacer) db.exec('DELETE FROM referentiel_services');

    const vus = new Set(existants.map(cleComparaison));
    const liste = [...existants];
    for (const r of parametrage.referentiel) {
      const nom = normaliser(r.nom);
      if (!nom || vus.has(cleComparaison(nom))) continue;
      vus.add(cleComparaison(nom));
      liste.push(nom);
    }
    if (remplacer) {
      const inserer = db.prepare('INSERT INTO referentiel_services (nom, ordre) VALUES (?, ?)');
      liste.forEach((nom, i) => inserer.run(nom, i));
    } else {
      const inserer = db.prepare(
        'INSERT INTO referentiel_services (nom, ordre) VALUES (?, ?) ON CONFLICT(nom) DO NOTHING'
      );
      liste.forEach((nom, i) => inserer.run(nom, i));
    }
    rapport.referentiel = liste.length;

    /* -------------------------------------------------------- Regroupements */
    if (remplacer) db.exec('DELETE FROM regroupements_service');
    const regle = db.prepare(`
      INSERT INTO regroupements_service (source, cible) VALUES (?, ?)
      ON CONFLICT(source) DO UPDATE SET cible = excluded.cible
    `);
    for (const r of parametrage.regroupements) {
      const source = normaliser(r.source);
      const cible = normaliser(r.cible);
      if (!source || !cible || source === cible) continue;
      regle.run(source, cible);
      rapport.regroupements++;
    }

    /* ------------------------------------------ Regles d'exclusion de synchro */
    if (remplacer) db.exec('DELETE FROM exclusions_sync');
    const exclusion = db.prepare(
      'INSERT OR IGNORE INTO exclusions_sync (champ, motif, cree_par) VALUES (?, ?, ?)'
    );
    for (const e of parametrage.exclusionsSync) {
      if (!e.champ || !e.motif) continue;
      exclusion.run(String(e.champ), String(e.motif), parQui);
      rapport.exclusionsSync++;
    }

    /* ------------------------------------------------ Decisions agent par agent */
    const trouver = db.prepare('SELECT id, login FROM agents WHERE login = ?');
    const ecarter = db.prepare(
      "UPDATE agents SET exclu = 1, exclu_motif = 'manuel', note = COALESCE(note, ?) WHERE id = ?"
    );
    const rattacher = db.prepare(
      'UPDATE agents SET service = ?, service_ad = COALESCE(NULLIF(?, \'\'), service_ad), service_force = 1 WHERE id = ?'
    );
    const masquer = db.prepare('UPDATE agents SET anonyme = 1 WHERE id = ?');

    for (const a of parametrage.agents) {
      const login = String(a.login || '').toLowerCase();
      const fiche = login ? trouver.get(login) : null;
      if (!fiche) { rapport.inconnus.push(a.login); continue; }

      if (a.exclu) { ecarter.run(a.motif || 'Écarté par le paramétrage importé', fiche.id); rapport.exclus++; }
      if (a.service) { rattacher.run(a.service, a.serviceAnnuaire || '', fiche.id); rapport.rattaches++; }
      if (a.anonyme) { masquer.run(fiche.id); rapport.anonymes++; }
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw new Error(`Import interrompu, aucune modification enregistrée : ${err.message}`);
  }

  // Les regroupements ne valent que s'ils sont appliques aux fiches : sans cela
  // le referentiel serait juste et le classement toujours faux.
  rapport.deplaces = appliquerRegroupements();

  rapport.avant = avant;

  journaliser(parQui, 'parametrage_importe',
    `${rapport.referentiel} service(s), ${rapport.regroupements} regroupement(s), `
    + `${rapport.exclus} exclusion(s), ${rapport.rattaches} rattachement(s), `
    + `${rapport.deplaces} agent(s) deplace(s)`
    + (rapport.inconnus.length ? `, ${rapport.inconnus.length} login(s) inconnu(s)` : ''), null);

  return rapport;
}

export function lireFichier(chemin) {
  return JSON.parse(fs.readFileSync(path.resolve(chemin), 'utf8'));
}

export function ecrireFichier(chemin, parametrage) {
  const complet = path.resolve(chemin);
  fs.mkdirSync(path.dirname(complet), { recursive: true });
  fs.writeFileSync(complet, `${JSON.stringify(parametrage, null, 2)}\n`, 'utf8');
  return complet;
}
