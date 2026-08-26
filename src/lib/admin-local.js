import crypto from 'node:crypto';
import { db, journaliser } from './db.js';

/**
 * Compte administrateur local, independant de l'Active Directory.
 *
 * Il resout le probleme d'amorcage : la configuration LDAP se saisit dans le
 * back-office, mais le back-office exige une authentification... qui passe par
 * le LDAP. Le compte local permet d'entrer avant que l'annuaire ne soit joignable,
 * et de reprendre la main s'il tombe en cours de campagne.
 *
 * Ce n'est pas un compte d'agent : il est marque exclu, donc il ne compte ni
 * dans les effectifs, ni dans les taux de participation, ni dans les classements.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS admins_locaux (
  agent_id     INTEGER PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  empreinte    TEXT NOT NULL,
  sel          TEXT NOT NULL,
  cree_le      TEXT NOT NULL DEFAULT (datetime('now')),
  maj_le       TEXT,
  provisoire   INTEGER NOT NULL DEFAULT 0
);
`);

const PARAMETRES_SCRYPT = { N: 16384, r: 8, p: 1 };

function calculer(motDePasse, sel) {
  return crypto.scryptSync(motDePasse, sel, 64, PARAMETRES_SCRYPT).toString('hex');
}

function comparer(a, b) {
  const ta = Buffer.from(a, 'hex');
  const tb = Buffer.from(b, 'hex');
  // Comparaison a temps constant : ne pas laisser fuir d'information par la duree
  return ta.length === tb.length && crypto.timingSafeEqual(ta, tb);
}

export function existeAdminLocal() {
  return db.prepare('SELECT COUNT(*) AS n FROM admins_locaux').get().n > 0;
}

export function listerAdminsLocaux() {
  return db.prepare(`
    SELECT a.id, a.login, a.nom_complet, l.cree_le, l.maj_le, l.provisoire, a.vu_le
    FROM admins_locaux l JOIN agents a ON a.id = l.agent_id
    ORDER BY a.login
  `).all();
}

/**
 * Cree ou remplace un compte local.
 * provisoire = mot de passe genere par l'application, a changer a la premiere occasion.
 */
export function definirAdminLocal(login, motDePasse, { nomComplet, provisoire = false, parQui } = {}) {
  const identifiant = String(login || '').trim().toLowerCase();
  if (!identifiant) throw new Error("L'identifiant est obligatoire.");
  if (!motDePasse || String(motDePasse).length < 12) {
    throw new Error('Le mot de passe doit comporter au moins 12 caractères.');
  }

  let agent = db.prepare('SELECT * FROM agents WHERE login = ?').get(identifiant);
  if (!agent) {
    db.prepare(`
      INSERT INTO agents (login, nom_complet, service, service_ad, origine, est_admin, exclu, note)
      VALUES (?, ?, 'Administration technique', 'Administration technique', 'local', 1, 1, ?)
    `).run(identifiant, nomComplet || `Administrateur ${identifiant}`,
           "Compte local d'administration : hors effectifs et hors classement.");
    agent = db.prepare('SELECT * FROM agents WHERE login = ?').get(identifiant);
  } else {
    // Un compte local reste administrateur, exclu des effectifs et du classement
    db.prepare("UPDATE agents SET est_admin = 1, exclu = 1, origine = 'local' WHERE id = ?").run(agent.id);
  }

  const sel = crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO admins_locaux (agent_id, empreinte, sel, provisoire, maj_le)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(agent_id) DO UPDATE SET
      empreinte = excluded.empreinte, sel = excluded.sel,
      provisoire = excluded.provisoire, maj_le = datetime('now')
  `).run(agent.id, calculer(motDePasse, sel), sel, provisoire ? 1 : 0);

  journaliser(parQui || identifiant, 'admin_local_defini', identifiant, null);
  return agent;
}

export function supprimerAdminLocal(login, parQui) {
  const agent = db.prepare('SELECT * FROM agents WHERE login = ?').get(String(login).toLowerCase());
  if (!agent) throw new Error('Compte introuvable.');
  if (listerAdminsLocaux().length <= 1) {
    throw new Error('Impossible de supprimer le dernier compte local : vous perdriez tout moyen de reprendre la main si l\'annuaire devenait injoignable.');
  }
  db.prepare('DELETE FROM admins_locaux WHERE agent_id = ?').run(agent.id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
  journaliser(parQui, 'admin_local_supprime', login, null);
}

/** Verifie un couple identifiant / mot de passe local. */
export function verifierAdminLocal(login, motDePasse) {
  if (!login || !motDePasse) return { ok: false, motif: 'identifiants_vides' };

  const ligne = db.prepare(`
    SELECT l.*, a.id AS agent_id FROM admins_locaux l
    JOIN agents a ON a.id = l.agent_id
    WHERE a.login = ?
  `).get(String(login).trim().toLowerCase());

  if (!ligne) return { ok: false, motif: 'compte_inconnu' };
  if (!comparer(calculer(motDePasse, ligne.sel), ligne.empreinte)) {
    return { ok: false, motif: 'mot_de_passe_invalide' };
  }

  db.prepare("UPDATE agents SET vu_le = datetime('now') WHERE id = ?").run(ligne.agent_id);
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(ligne.agent_id);
  return { ok: true, agent, provisoire: !!ligne.provisoire };
}

/**
 * Amorcage au demarrage : sans aucun compte local, on en cree un.
 * Le mot de passe vient de l'environnement, sinon il est genere et affiche
 * une fois dans les journaux - lisibles dans Portainer.
 */
export function amorcerAdminLocal() {
  if (existeAdminLocal()) return null;

  const login = (process.env.ADMIN_LOCAL_LOGIN || 'admin').trim().toLowerCase();
  const fourni = process.env.ADMIN_LOCAL_MOT_DE_PASSE;
  const motDePasse = fourni || crypto.randomBytes(12).toString('base64url');

  definirAdminLocal(login, motDePasse, {
    nomComplet: 'Administrateur local',
    provisoire: !fourni,
    parQui: 'amorcage',
  });

  return { login, motDePasse, genere: !fourni };
}
