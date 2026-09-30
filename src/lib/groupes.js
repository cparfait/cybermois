import { db, journaliser } from './db.js';
import { nomsReferentiel } from './referentiel.js';
import { cleComparaison } from './services.js';

/**
 * Groupes Active Directory des agents, et groupes exclus de chaque mail.
 *
 * Les groupes servent a cibler un envoi - le mail aux elus part aux membres
 * d'un groupe - et a en ecarter d'autres : les elus ne recoivent pas le mail
 * d'ouverture, qui leur parlerait d'un portail qu'ils n'atteignent pas depuis
 * chez eux.
 *
 * Ils sont releves a chaque synchronisation et a chaque connexion, par leur
 * nom court (CN). Seule l'appartenance directe est connue : le membre d'un
 * groupe imbrique dans un autre n'appartient, ici, qu'au premier.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS agent_groupes (
  agent_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  groupe    TEXT NOT NULL,
  PRIMARY KEY (agent_id, groupe)
);
CREATE INDEX IF NOT EXISTS idx_agent_groupes_groupe ON agent_groupes (groupe COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS mails_exclusions (
  type    TEXT NOT NULL,
  groupe  TEXT NOT NULL,
  PRIMARY KEY (type, groupe)
);
`);

/** « CN=GG-Elus,OU=Groupes,DC=... » -> « GG-Elus ». Une valeur sans CN reste telle quelle. */
export function nomCourt(dn) {
  const premier = String(dn || '').split(/(?<!\\),/)[0].trim();
  const cn = /^cn=(.+)$/i.exec(premier);
  return (cn ? cn[1] : premier).replace(/\\(.)/g, '$1').trim();
}

/** Remplace les groupes connus d'un agent par ceux que l'annuaire vient de donner. */
export function enregistrerGroupes(agentId, dns) {
  if (!agentId || !Array.isArray(dns)) return;
  db.prepare('DELETE FROM agent_groupes WHERE agent_id = ?').run(agentId);
  const inserer = db.prepare('INSERT OR IGNORE INTO agent_groupes (agent_id, groupe) VALUES (?, ?)');
  for (const dn of dns) {
    const nom = nomCourt(dn);
    if (nom) inserer.run(agentId, nom);
  }
}

/** Les groupes connus, avec leur nombre de membres joignables par mail. */
export const listerGroupes = () => db.prepare(`
  SELECT g.groupe,
         COUNT(*) AS membres,
         SUM(CASE WHEN a.email IS NOT NULL AND a.email <> '' THEN 1 ELSE 0 END) AS avec_email
  FROM agent_groupes g JOIN agents a ON a.id = g.agent_id
  WHERE a.origine <> 'local'
  GROUP BY g.groupe COLLATE NOCASE
  ORDER BY g.groupe COLLATE NOCASE
`).all();

/* ------------------------------------------------ Exclusions par mail */

/** Les mails auxquels une exclusion s'applique : ceux qui partent aux agents. */
export const TYPES_EXCLUSION = {
  ouverture: "Mail d'ouverture",
  annonce: 'Annonce du lundi',
  'relance-semaine': 'Relance du mercredi',
  relance: "Relance d'un seul défi",
};

export function lireExclusionsMail() {
  const parType = Object.fromEntries(Object.keys(TYPES_EXCLUSION).map((t) => [t, []]));
  for (const l of db.prepare('SELECT type, groupe FROM mails_exclusions ORDER BY groupe COLLATE NOCASE').all()) {
    parType[l.type]?.push(l.groupe);
  }
  return parType;
}

export function enregistrerExclusionsMail(type, groupes, login) {
  if (!TYPES_EXCLUSION[type]) throw new Error('Type de mail inconnu.');
  const propres = [...new Set((groupes || []).map((g) => nomCourt(g)).filter(Boolean))];
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM mails_exclusions WHERE type = ?').run(type);
    const inserer = db.prepare('INSERT OR IGNORE INTO mails_exclusions (type, groupe) VALUES (?, ?)');
    for (const g of propres) inserer.run(type, g);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  journaliser(login, 'exclusions_mail', `${type} : ${propres.join(', ') || 'aucune'}`, null);
  return propres;
}

/* ------------------------------------------------------ Destinataires */

/**
 * Les agents a qui un mail de campagne peut partir, parmi `agents`.
 *
 * Deux regles s'ajoutent a celles des requetes (adresse, exclusion, compte
 * local) :
 *   - la direction de l'agent est active au referentiel : la meme regle que
 *     le classement, qui ne montre que ces directions. Un agent hors
 *     referentiel recevait les mails d'une campagne ou il ne comptait pas ;
 *   - il n'appartient a aucun groupe exclu de ce type de mail.
 * Un referentiel vide ne filtre rien : c'est le cas d'une instance neuve.
 */
export function filtrerDestinataires(type, agents) {
  const reference = nomsReferentiel();
  const actives = new Set(reference.map(cleComparaison));
  const exclus = new Set((lireExclusionsMail()[type] || []).map((g) => g.toLowerCase()));
  const groupesDe = db.prepare('SELECT groupe FROM agent_groupes WHERE agent_id = ?');

  return agents.filter((a) => {
    if (reference.length && !actives.has(cleComparaison(a.service))) return false;
    if (!exclus.size) return true;
    return !groupesDe.all(a.id).some((g) => exclus.has(g.groupe.toLowerCase()));
  });
}

/**
 * Les membres d'un groupe, pour un envoi cible. Ni la direction ni les
 * exclusions de campagne ne comptent : on vise ce groupe, et lui seul. Un
 * compte que l'annuaire a ecarte - desactive ou disparu, motif « annuaire »
 * pose par la synchronisation - ne recoit rien, en revanche.
 */
export const membresDuGroupe = (groupe) => db.prepare(`
  SELECT a.* FROM agents a
  JOIN agent_groupes g ON g.agent_id = a.id AND g.groupe = ? COLLATE NOCASE
  WHERE a.email IS NOT NULL AND a.email <> '' AND a.origine <> 'local'
    AND NOT (a.exclu = 1 AND a.exclu_motif = 'annuaire')
  ORDER BY a.nom_complet COLLATE NOCASE
`).all(String(groupe || ''));
