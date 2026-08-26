import { db, journaliser } from './db.js';
import { noterQuestion, attribuerBadges } from './scoring.js';

/**
 * Correction des resultats apres coup.
 *
 * Le besoin vient d'un incident vecu : une question corrigee en cours de
 * campagne, et tous ceux qui avaient deja repondu se retrouvent notes sur un
 * bareme qui n'existe plus.
 *
 * Deux reponses, complementaires :
 *   - le RECALCUL, qui rejoue toutes les participations d'un defi contre le
 *     bareme courant. C'est la seule voie tenable quand 400 agents sont
 *     concernes ;
 *   - la CORRECTION UNITAIRE, pour le cas particulier qu'aucune regle ne
 *     rattrape.
 *
 * Les deux sont tracees nominativement. Un administrateur ne peut pas toucher
 * a ses propres resultats : c'est la garantie qui protege les agents, et les
 * administrateurs eux-memes.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS corrections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  horodatage     TEXT NOT NULL DEFAULT (datetime('now')),
  par_qui        TEXT NOT NULL,
  type           TEXT NOT NULL,
  agent_login    TEXT,
  agent_nom      TEXT,
  defi_semaine   INTEGER,
  question_id    INTEGER,
  question       TEXT,
  avant          TEXT,
  apres          TEXT,
  motif          TEXT,
  ip             TEXT
);
CREATE INDEX IF NOT EXISTS idx_corrections_horodatage ON corrections(horodatage);
`);

function tracer(entree) {
  db.prepare(`
    INSERT INTO corrections (par_qui, type, agent_login, agent_nom, defi_semaine,
                             question_id, question, avant, apres, motif, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entree.parQui, entree.type, entree.agentLogin || null, entree.agentNom || null,
    entree.semaine || null, entree.questionId || null,
    entree.question ? String(entree.question).slice(0, 300) : null,
    entree.avant || null, entree.apres || null,
    entree.motif ? String(entree.motif).slice(0, 500) : null, entree.ip || null
  );
}

export const lireCorrections = (limite = 300) =>
  db.prepare('SELECT * FROM corrections ORDER BY id DESC LIMIT ?').all(limite);

/** Recharge une question avec ses reponses, pour la renoter. */
function chargerQuestion(questionId) {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
  if (!q) return null;
  q.reponses = db.prepare('SELECT id, libelle, correcte FROM reponses WHERE question_id = ? ORDER BY ordre').all(q.id);
  return q;
}

/** Recalcule les totaux d'une participation a partir de ses reponses enregistrees. */
function recalculerParticipation(participationId) {
  const lignes = db.prepare(
    'SELECT id, question_id, choix, points_obtenus, correcte FROM reponses_agent WHERE participation_id = ?'
  ).all(participationId);

  let score = 0; let scoreMax = 0; let bonnes = 0;
  const majReponse = db.prepare('UPDATE reponses_agent SET points_obtenus = ?, correcte = ? WHERE id = ?');

  for (const l of lignes) {
    const q = chargerQuestion(l.question_id);
    // Question supprimee depuis : sa reponse ne compte plus nulle part
    if (!q) { majReponse.run(0, 0, l.id); continue; }

    let choix = [];
    try { choix = JSON.parse(l.choix) || []; } catch { choix = []; }

    const note = noterQuestion(q, choix);
    score += note.points;
    scoreMax += q.points;
    if (note.parfaite) bonnes++;
    majReponse.run(note.points, note.parfaite ? 1 : 0, l.id);
  }

  db.prepare(
    'UPDATE participations SET score = ?, score_max = ?, bonnes = ? WHERE id = ?'
  ).run(score, scoreMax, bonnes, participationId);

  return { score, scoreMax, bonnes };
}

/**
 * Rejoue toutes les participations d'un defi contre le bareme courant.
 * En simulation, rien n'est ecrit : on annonce d'abord qui bouge et de combien.
 */
export function recalculerDefi(semaine, { simulation = true, parQui, ip, motif } = {}) {
  const defi = db.prepare('SELECT * FROM defis WHERE semaine = ?').get(Number(semaine));
  if (!defi) return { ok: false, message: 'Défi introuvable.' };

  const participations = db.prepare(`
    SELECT p.id, p.score, p.score_max, p.bonnes, a.login, a.nom_complet, a.service
    FROM participations p JOIN agents a ON a.id = p.agent_id
    WHERE p.defi_id = ? AND p.entrainement = 0
    ORDER BY a.nom_complet
  `).all(defi.id);

  if (!participations.length) {
    return { ok: true, semaine, titre: defi.titre, concernes: 0, changements: [], message: 'Aucune participation à recalculer.' };
  }

  // La simulation se fait dans une transaction annulee : on obtient le vrai
  // resultat du recalcul sans rien laisser derriere.
  db.exec('BEGIN');
  const changements = [];
  try {
    for (const p of participations) {
      const apres = recalculerParticipation(p.id);
      if (apres.score !== p.score || apres.scoreMax !== p.score_max || apres.bonnes !== p.bonnes) {
        changements.push({
          login: p.login, nom: p.nom_complet, service: p.service,
          avant: { score: p.score, scoreMax: p.score_max, bonnes: p.bonnes },
          apres,
          ecart: apres.score - p.score,
        });
      }
    }
    if (simulation) db.exec('ROLLBACK'); else db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return { ok: false, message: `Recalcul interrompu : ${err.message}` };
  }

  if (!simulation) {
    tracer({
      parQui, type: 'recalcul_defi', semaine: defi.semaine,
      question: defi.titre,
      avant: `${participations.length} participation(s)`,
      apres: `${changements.length} score(s) modifie(s)`,
      motif, ip,
    });
    journaliser(parQui, 'recalcul_defi',
      `semaine=${defi.semaine} ${changements.length}/${participations.length} scores modifies`, ip);
  }

  return {
    ok: true,
    simulation,
    semaine: defi.semaine,
    titre: defi.titre,
    concernes: participations.length,
    modifies: changements.length,
    changements: changements.slice(0, 200),
    message: simulation
      ? `${changements.length} score(s) seraient modifié(s) sur ${participations.length} participation(s).`
      : `${changements.length} score(s) recalculé(s) sur ${participations.length} participation(s).`,
  };
}

/** Detail des questionnaires d'un agent, pour la correction unitaire. */
export function participationsAgent(agentId) {
  const agent = db.prepare('SELECT id, login, nom_complet, service FROM agents WHERE id = ?').get(agentId);
  if (!agent) return null;

  const participations = db.prepare(`
    SELECT p.id, p.score, p.score_max, p.bonnes, p.total_questions, p.termine_le, p.entrainement,
           d.semaine, d.titre
    FROM participations p JOIN defis d ON d.id = p.defi_id
    WHERE p.agent_id = ? AND p.entrainement = 0
    ORDER BY d.semaine
  `).all(agentId);

  return {
    agent,
    participations: participations.map((p) => ({
      ...p,
      reponses: db.prepare(`
        SELECT r.id, r.question_id, r.choix, r.correcte, r.points_obtenus,
               q.enonce, q.points, q.multiple, q.explication
        FROM reponses_agent r JOIN questions q ON q.id = r.question_id
        WHERE r.participation_id = ?
        ORDER BY q.ordre
      `).all(p.id).map((r) => {
        let choix = [];
        try { choix = JSON.parse(r.choix) || []; } catch { choix = []; }
        return {
          ...r,
          choix,
          propositions: db.prepare(
            'SELECT id, libelle, correcte FROM reponses WHERE question_id = ? ORDER BY ordre'
          ).all(r.question_id),
        };
      }),
    })),
  };
}

/**
 * Modifie la reponse enregistree d'un agent a une question, puis renote.
 * On ne touche pas directement aux points : on corrige ce que l'agent est
 * repute avoir coche, et le bareme fait le reste. Une note saisie a la main
 * serait impossible a justifier.
 */
export function corrigerReponse(reponseAgentId, nouveauChoix, { parQui, ip, motif } = {}) {
  const ligne = db.prepare(`
    SELECT r.id, r.participation_id, r.question_id, r.choix, r.points_obtenus,
           q.enonce, q.points, p.agent_id, d.semaine, a.login, a.nom_complet
    FROM reponses_agent r
    JOIN questions q      ON q.id = r.question_id
    JOIN participations p ON p.id = r.participation_id
    JOIN defis d          ON d.id = p.defi_id
    JOIN agents a         ON a.id = p.agent_id
    WHERE r.id = ?
  `).get(Number(reponseAgentId));

  if (!ligne) return { ok: false, message: 'Réponse introuvable.' };
  if (ligne.login === parQui) {
    return {
      ok: false,
      message: 'Vous ne pouvez pas modifier vos propres résultats. '
        + 'Demandez à un autre administrateur de le faire.',
    };
  }

  const question = chargerQuestion(ligne.question_id);
  const valides = new Set(question.reponses.map((r) => r.id));
  const choix = [...new Set((nouveauChoix || []).map(Number))].filter((id) => valides.has(id));
  if (!choix.length) return { ok: false, message: 'Sélectionnez au moins une proposition valide.' };

  let ancienChoix = [];
  try { ancienChoix = JSON.parse(ligne.choix) || []; } catch { ancienChoix = []; }

  const libelle = (ids) => question.reponses
    .filter((r) => ids.includes(r.id))
    .map((r) => r.libelle)
    .join(' | ') || '(aucune)';

  db.exec('BEGIN');
  let totaux;
  try {
    db.prepare('UPDATE reponses_agent SET choix = ? WHERE id = ?').run(JSON.stringify(choix), ligne.id);
    totaux = recalculerParticipation(ligne.participation_id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return { ok: false, message: `Correction impossible : ${err.message}` };
  }

  // Les badges peuvent avoir ete gagnes grace a cette correction
  attribuerBadges(ligne.agent_id, {
    semaine: ligne.semaine, score: totaux.score, scoreMax: totaux.scoreMax, bonusMax: false,
  });

  tracer({
    parQui, type: 'correction_reponse',
    agentLogin: ligne.login, agentNom: ligne.nom_complet,
    semaine: ligne.semaine, questionId: ligne.question_id, question: ligne.enonce,
    avant: `${libelle(ancienChoix)} (${ligne.points_obtenus} pts)`,
    apres: `${libelle(choix)} (${totaux.score} pts au total)`,
    motif, ip,
  });
  journaliser(parQui, 'correction_reponse',
    `${ligne.login} semaine=${ligne.semaine} question=${ligne.question_id}`, ip);

  return {
    ok: true,
    totaux,
    message: `Réponse corrigée pour ${ligne.nom_complet}. `
      + `Nouveau score sur la semaine ${ligne.semaine} : ${totaux.score} / ${totaux.scoreMax}.`,
  };
}
