import { db, journaliser } from './db.js';
import { config } from './config.js';

/**
 * Application des durees de conservation annoncees dans les mentions legales.
 *
 * La page « Mentions legales » promet trois durees :
 *   - resultats et classements : jusqu'a la fin de l'annee civile suivant la campagne
 *   - preuves de participation agregees : 3 ans
 *   - journaux de connexion : 6 mois
 *
 * Rien ne les appliquait. Une duree annoncee et jamais tenue est un
 * manquement en soi : le registre des traitements decrit un effacement qui ne
 * se produit pas, et la personne qui exerce son droit d'acces recoit des
 * donnees censees avoir disparu.
 *
 * Avant d'effacer les resultats nominatifs, on en conserve la trace AGREGEE -
 * combien de defis chaque agent a suivis - parce que c'est elle, et pas le
 * detail des reponses, qui sert de preuve de l'action de sensibilisation en
 * audit. C'est aussi la seule des trois durees qui se compte en annees.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS preuves_participation (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  login          TEXT NOT NULL,
  service        TEXT,
  annee          TEXT NOT NULL,
  defis_termines INTEGER NOT NULL DEFAULT 0,
  cree_le        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(login, annee)
);
`);

/**
 * 456 jours : la fin de l'annee civile suivant la campagne, a quelques
 * semaines pres. Le calcul exact dependrait de la date de chaque participation ;
 * une duree glissante se verifie d'un coup d'oeil et ne conserve jamais plus
 * longtemps que ce qui est annonce pour les participations de debut de
 * campagne, qui sont les plus nombreuses.
 */
const JOURS_RESULTATS = 456;
const JOURS_JOURNAL = 180;
const JOURS_PREUVES = 1095;

/**
 * Efface ce qui a depasse sa duree de conservation.
 * Renvoie le compte de ce qui a ete efface, pour le journal d'exploitation.
 */
export function appliquerRetention({ simulation = false } = {}) {
  const jJournal = Number(config.retention.journalJours) || JOURS_JOURNAL;
  const jResultats = Number(config.retention.resultatsJours) || JOURS_RESULTATS;
  const jPreuves = Number(config.retention.preuvesJours) || JOURS_PREUVES;

  const compter = (sql, ...params) => db.prepare(sql).get(...params).n;

  const rapport = {
    journal: compter(
      "SELECT COUNT(*) AS n FROM journal WHERE horodatage < datetime('now', ?)",
      `-${jJournal} days`
    ),
    participations: compter(
      "SELECT COUNT(*) AS n FROM participations WHERE termine_le < datetime('now', ?)",
      `-${jResultats} days`
    ),
    preuves: compter(
      "SELECT COUNT(*) AS n FROM preuves_participation WHERE cree_le < datetime('now', ?)",
      `-${jPreuves} days`
    ),
  };

  if (simulation) return { ...rapport, simulation: true };
  if (!rapport.journal && !rapport.participations && !rapport.preuves) return rapport;

  db.exec('BEGIN');
  try {
    // La preuve agregee se constitue AVANT l'effacement : apres, plus rien ne
    // dirait combien de defis l'agent a suivis.
    if (rapport.participations) {
      db.prepare(`
        INSERT INTO preuves_participation (login, service, annee, defis_termines)
        SELECT a.login, a.service, strftime('%Y', p.termine_le), COUNT(*)
          FROM participations p
          JOIN agents a ON a.id = p.agent_id
         WHERE p.entrainement = 0 AND p.termine_le < datetime('now', ?)
         GROUP BY a.login, strftime('%Y', p.termine_le)
        ON CONFLICT(login, annee) DO UPDATE SET
          defis_termines = excluded.defis_termines,
          service = excluded.service
      `).run(`-${jResultats} days`);

      // reponses_agent part par cascade, mais l'ecrire explicitement evite de
      // dependre de l'etat de PRAGMA foreign_keys au moment de la purge.
      db.prepare(`
        DELETE FROM reponses_agent WHERE participation_id IN (
          SELECT id FROM participations WHERE termine_le < datetime('now', ?)
        )
      `).run(`-${jResultats} days`);
      db.prepare("DELETE FROM participations WHERE termine_le < datetime('now', ?)")
        .run(`-${jResultats} days`);
    }

    if (rapport.journal) {
      db.prepare("DELETE FROM journal WHERE horodatage < datetime('now', ?)")
        .run(`-${jJournal} days`);
    }
    if (rapport.preuves) {
      db.prepare("DELETE FROM preuves_participation WHERE cree_le < datetime('now', ?)")
        .run(`-${jPreuves} days`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  journaliser('systeme', 'retention_appliquee',
    `journal=${rapport.journal} participations=${rapport.participations} preuves=${rapport.preuves}`,
    null);

  return rapport;
}
