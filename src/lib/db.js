import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

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
  service        TEXT NOT NULL DEFAULT 'Non rattache',
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
  semaine        INTEGER NOT NULL UNIQUE,
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
  semaine        INTEGER,
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

// Le prenom de l'annuaire (givenName). Sans lui, il faut deviner ou couper
// le nom complet, et « NOM Prenom » donne alors « Bonjour DUPONT ».
ajouterColonne('agents', 'prenom', 'TEXT');

// Chaque defi porte son badge : cable sur le numero de semaine, il devenait
// faux des qu'on changeait de theme ou qu'on inserait une semaine.
ajouterColonne('defis', 'badge_code', 'TEXT');
ajouterColonne('defis', 'badge_libelle', 'TEXT');
ajouterColonne('defis', 'badge_emoji', 'TEXT');
ajouterColonne('defis', 'badge_description', 'TEXT');

export function journaliser(login, action, detail, ip) {
  db.prepare('INSERT INTO journal (login, action, detail, ip) VALUES (?, ?, ?, ?)')
    .run(login || null, action, detail ? String(detail).slice(0, 500) : null, ip || null);
}
