import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Libelle porte par un agent dont la direction n'a pas pu etre determinee.
 *
 * Une seule graphie, exportee : elle s'ecrivait en clair dans dix fichiers,
 * sans accent parce qu'elle vient du code, alors que l'ecran l'affiche a des
 * agents. Les deux orthographes ont fini par coexister dans la meme page.
 */
export const SERVICE_NON_RATTACHE = 'Non rattaché';

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
export const db = new DatabaseSync(config.dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Deux processus touchent la meme base : le serveur, et les outils en ligne de
// commande - import du parametrage, compte administrateur - qu'on lance
// pendant qu'il tourne. Sans delai d'attente, SQLite rend « database is locked »
// des la premiere collision, au lieu de patienter le temps d'une ecriture qui
// dure quelques millisecondes.
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  login          TEXT NOT NULL UNIQUE,
  nom_complet    TEXT NOT NULL,
  email          TEXT,
  service        TEXT NOT NULL DEFAULT 'Non rattaché',
  service_brut   TEXT,
  est_admin      INTEGER NOT NULL DEFAULT 0,
  cree_le        TEXT NOT NULL DEFAULT (datetime('now')),
  vu_le          TEXT
);

CREATE TABLE IF NOT EXISTS regroupements_service (
  source         TEXT PRIMARY KEY,
  cible          TEXT NOT NULL,
  cree_le        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS defis (
  id             INTEGER PRIMARY KEY,
  titre          TEXT NOT NULL,
  accroche       TEXT NOT NULL,
  intro          TEXT NOT NULL,
  duree_minutes  INTEGER NOT NULL DEFAULT 7,
  ouvre_le       TEXT NOT NULL,
  publie         INTEGER NOT NULL DEFAULT 0,
  maj_le         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  defi_id        INTEGER NOT NULL REFERENCES defis(id) ON DELETE CASCADE,
  ordre          INTEGER NOT NULL,
  enonce         TEXT NOT NULL,
  contexte       TEXT,
  multiple       INTEGER NOT NULL DEFAULT 0,
  points         INTEGER NOT NULL DEFAULT 10,
  explication    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS reponses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id    INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  ordre          INTEGER NOT NULL,
  libelle        TEXT NOT NULL,
  correcte       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS participations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id       INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  defi_id        INTEGER NOT NULL REFERENCES defis(id) ON DELETE CASCADE,
  score          INTEGER NOT NULL DEFAULT 0,
  score_max      INTEGER NOT NULL DEFAULT 0,
  bonnes         INTEGER NOT NULL DEFAULT 0,
  total_questions INTEGER NOT NULL DEFAULT 0,
  duree_secondes INTEGER NOT NULL DEFAULT 0,
  entrainement   INTEGER NOT NULL DEFAULT 0,
  termine_le     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, defi_id, entrainement)
);

CREATE TABLE IF NOT EXISTS reponses_agent (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  participation_id INTEGER NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  question_id      INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  choix            TEXT NOT NULL,
  correcte         INTEGER NOT NULL DEFAULT 0,
  points_obtenus   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS badges_agent (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id       INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,
  obtenu_le      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, code)
);

CREATE TABLE IF NOT EXISTS journal (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  horodatage     TEXT NOT NULL DEFAULT (datetime('now')),
  login          TEXT,
  action         TEXT NOT NULL,
  detail         TEXT,
  ip             TEXT
);

CREATE TABLE IF NOT EXISTS envois (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  horodatage     TEXT NOT NULL DEFAULT (datetime('now')),
  type           TEXT NOT NULL,
  defi_id        INTEGER,
  destinataires  INTEGER NOT NULL DEFAULT 0,
  succes         INTEGER NOT NULL DEFAULT 0,
  erreur         TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token          TEXT PRIMARY KEY,
  agent_id       INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  cree_le        TEXT NOT NULL DEFAULT (datetime('now')),
  expire_le      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_participations_defi ON participations(defi_id);
CREATE INDEX IF NOT EXISTS idx_agents_service ON agents(service);
CREATE INDEX IF NOT EXISTS idx_journal_horodatage ON journal(horodatage);
`);

/**
 * Migrations additives.
 * SQLite ne sait pas faire ADD COLUMN IF NOT EXISTS : on lit la structure
 * existante et on n'ajoute que ce qui manque. Une base deja en service se met
 * ainsi a jour sans perdre de donnees.
 */
export function ajouterColonne(table, colonne, definition) {
  const colonnes = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!colonnes.includes(colonne)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colonne} ${definition}`);
  }
}

/**
 * Un defi n'appartient plus a une semaine : il parait a une date, fixee a la
 * main. Le rythme hebdomadaire etait cable dans la cle du defi lui-meme, ce
 * qui interdisait d'en publier deux la meme semaine - et obligeait a
 * renumeroter tout le calendrier des qu'on en inserait un.
 *
 * La date devient la seule chose qui ordonne les defis ; l'identifiant
 * technique devient la seule chose qui les designe. Les numeros de semaine
 * deja enregistres sont convertis en identifiants avant de disparaitre, pour
 * que le registre des corrections et l'historique des envois restent lisibles.
 */
function colonnes(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

const existe = (table) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

function migrerVersDatesManuelles() {
  if (!colonnes('defis').some((c) => c.name === 'semaine')) return;

  // La correspondance se lit tant que la colonne existe encore : apres la
  // reconstruction de la table, plus rien ne relierait « semaine 3 » a un defi.
  const parSemaine = new Map(
    db.prepare('SELECT semaine, id FROM defis').all().map((d) => [d.semaine, d.id])
  );

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    // Le programme se range desormais par module : c'est lui qui porte la date
    // de parution, une par module et non plus une par semaine.
    if (existe('programme') && colonnes('programme').some((c) => c.name === 'semaine')) {
      db.exec(`
        CREATE TABLE programme_nouveau (
          module_code TEXT PRIMARY KEY,
          ouvre_le    TEXT NOT NULL,
          maj_le      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO programme_nouveau (module_code, ouvre_le)
          SELECT p.module_code,
                 COALESCE(p.ouvre_le, (SELECT d.ouvre_le FROM defis d WHERE d.semaine = p.semaine))
            FROM programme p
           WHERE COALESCE(p.ouvre_le, (SELECT d.ouvre_le FROM defis d WHERE d.semaine = p.semaine)) IS NOT NULL;
        DROP TABLE programme;
        ALTER TABLE programme_nouveau RENAME TO programme;
      `);
    }

    // Envois et corrections designaient un defi par sa semaine : on retient
    // l'identifiant, seule reference qui survivra.
    for (const [table, ancienne] of [['envois', 'semaine'], ['corrections', 'defi_semaine']]) {
      if (!existe(table) || !colonnes(table).some((c) => c.name === ancienne)) continue;
      ajouterColonne(table, 'defi_id', 'INTEGER');
      for (const [semaine, id] of parSemaine) {
        db.prepare(`UPDATE ${table} SET defi_id = ? WHERE ${ancienne} = ?`).run(id, semaine);
      }
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${ancienne}`);
    }

    // SQLite ne sait pas retirer une colonne portant une contrainte UNIQUE :
    // la table se reconstruit a l'identique, moins la semaine. Les cles
    // etrangeres sont desactivees le temps de l'echange, sans quoi la
    // suppression de l'ancienne table emporterait questions et participations.
    const gardees = colonnes('defis').filter((c) => c.name !== 'semaine');
    const definition = gardees.map((c) => [
      `"${c.name}"`, c.type,
      c.pk ? 'PRIMARY KEY' : '',
      c.notnull ? 'NOT NULL' : '',
      c.dflt_value === null ? '' : `DEFAULT (${c.dflt_value})`,
    ].filter(Boolean).join(' ')).join(', ');
    const noms = gardees.map((c) => `"${c.name}"`).join(', ');

    db.exec(`CREATE TABLE defis_nouveau (${definition})`);
    db.exec(`INSERT INTO defis_nouveau (${noms}) SELECT ${noms} FROM defis`);
    db.exec('DROP TABLE defis');
    db.exec('ALTER TABLE defis_nouveau RENAME TO defis');

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

migrerVersDatesManuelles();

// Agents pre-importes depuis l'annuaire : effectif de reference, meme sans connexion
ajouterColonne('agents', 'origine', "TEXT NOT NULL DEFAULT 'connexion'");
// Agent hors campagne : ne peut pas se connecter, exclu des effectifs et des relances
ajouterColonne('agents', 'exclu', 'INTEGER NOT NULL DEFAULT 0');
// Droit d'opposition : compte pour son service, masque du classement individuel
ajouterColonne('agents', 'anonyme', 'INTEGER NOT NULL DEFAULT 0');
ajouterColonne('agents', 'note', 'TEXT');
// Pourquoi l'agent est exclu : « manuel » (decision de l'administration) ou
// « annuaire » (compte desactive ou disparu). Sans cette distinction, une
// resynchronisation reintegrerait les agents ecartes a la main.
ajouterColonne('agents', 'exclu_motif', 'TEXT');
// Service attribue a la main : l'annuaire ne doit plus l'ecraser. Sans cela,
// rattacher les agents dont l'attribut « department » est vide serait a
// refaire apres chaque synchronisation.
ajouterColonne('agents', 'service_force', 'INTEGER NOT NULL DEFAULT 0');
// Service tel que lu dans l'annuaire, avant application de la table de
// correspondance. Le conserver permet de rejouer un regroupement a tout moment.
ajouterColonne('agents', 'service_ad', 'TEXT');

// Rattrapage, une seule fois : les directions affectees depuis le formulaire
// « Modifier » avant que ce geste ne pose le marqueur. Sans lui, la connexion
// suivante de l'agent rendait la main a l'annuaire et defaisait la decision.
// Le journal garde la trace de chaque modification de service faite ainsi :
// c'est lui qui dit quels agents en beneficient.
if (!db.prepare("SELECT 1 FROM journal WHERE action = 'rattrapage_service_force'").get()) {
  const logins = db.prepare(`
    SELECT DISTINCT substr(detail, 1, instr(detail, ' : ') - 1) AS login
    FROM journal
    WHERE action = 'agent_modifie' AND detail LIKE '% : %service = ?%'
  `).all().map((l) => l.login).filter(Boolean);
  let marques = 0;
  const forcer = db.prepare('UPDATE agents SET service_force = 1 WHERE login = ? AND service_force = 0 AND exclu = 0');
  for (const login of logins) marques += forcer.run(login).changes;
  db.prepare("INSERT INTO journal (login, action, detail) VALUES ('systeme', 'rattrapage_service_force', ?)")
    .run(`${marques} agent(s) dont la direction choisie a la main est desormais protegee`);
}

// D'ou vient le droit d'administration : « groupe » (appartenance au groupe
// Active Directory), « liste » (identifiant enumere dans la configuration) ou
// « local » (compte d'amorcage). Sans cette distinction, retirer un
// identifiant de la liste obligeait soit a ne rien revoquer, soit a revoquer
// aussi les administrateurs du groupe, qui ne se verifient pas sans annuaire.
ajouterColonne('agents', 'admin_source', 'TEXT');

/**
 * Une seule graphie pour le libelle « non rattache ».
 *
 * Il s'ecrivait sans accent - il vient du code - mais il s'affiche a des
 * agents, et l'ecran a fini par montrer les deux orthographes cote a cote.
 * Les fiches deja enregistrees sont reprises ici, sans quoi les anciennes
 * garderaient l'ancienne graphie et formeraient une direction distincte au
 * regroupement.
 */
for (const colonne of ['service', 'service_ad']) {
  db.prepare(`UPDATE agents SET ${colonne} = ? WHERE ${colonne} = ?`)
    .run(SERVICE_NON_RATTACHE, 'Non rattache');
}
db.prepare('UPDATE regroupements_service SET cible = ? WHERE cible = ?')
  .run(SERVICE_NON_RATTACHE, 'Non rattache');

// Alternative textuelle de la video d'introduction. Le RGAA l'exige pour tout
// contenu video, et l'editeur n'offrait aucun endroit ou la saisir.
ajouterColonne('defis', 'video_transcription', 'TEXT');

// Le prenom de l'annuaire (givenName). Sans lui, il faut deviner ou couper
// le nom complet, et « NOM Prenom » donne alors « Bonjour DUPONT ».
ajouterColonne('agents', 'prenom', 'TEXT');

// Chaque defi porte son badge : cable sur un numero d'ordre, il devenait faux
// des qu'on changeait de theme ou qu'on inserait un defi.
ajouterColonne('defis', 'badge_code', 'TEXT');
ajouterColonne('defis', 'badge_libelle', 'TEXT');
ajouterColonne('defis', 'badge_emoji', 'TEXT');
ajouterColonne('defis', 'badge_description', 'TEXT');

export function journaliser(login, action, detail, ip) {
  db.prepare('INSERT INTO journal (login, action, detail, ip) VALUES (?, ?, ?, ?)')
    .run(login || null, action, detail ? String(detail).slice(0, 500) : null, ip || null);
}
