import { pathToFileURL } from 'node:url';
import { db } from './db.js';
import { config } from './config.js';
import { lireModule, lireProgramme } from './modules.js';

/**
 * Date d'ouverture d'une semaine : debut de campagne + (semaine - 1) * 7 jours.
 * Le calcul se fait en UTC et le formatage a la main : passer par toISOString()
 * sur une date locale reculerait d'un jour en heure francaise (UTC+1 ou +2).
 */
export function dateOuverture(semaine) {
  const [annee, mois, jour] = config.campagne.debut.split('-').map(Number);
  const d = new Date(Date.UTC(annee, mois - 1, jour));
  d.setUTCDate(d.getUTCDate() + (semaine - 1) * 7);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * Verse dans les defis le contenu des modules programmes.
 *
 * Un defi cree est publie : sa date d'ouverture suffit a le tenir ferme
 * jusqu'au jour dit. Exiger en plus une publication manuelle faisait doublon
 * avec la programmation, et se soldait par des defis qui restaient scelles
 * passe leur date sans que rien ne l'explique. « Masquer » reste possible,
 * mais devient ce qu'il aurait toujours du etre : une exception.
 *
 * La programmation dit quel module se joue quelle semaine ; cette fonction
 * en tire les questionnaires. Elle est idempotente : la rejouer met a jour
 * titres et questions sans toucher aux participations.
 *
 * Un defi deja joue n'est pas reecrit sans force : ses participants ont
 * repondu a des questions qui doivent rester celles qu'ils ont vues.
 */
export function importerContenus({ force = false } = {}) {
  const rapport = [];
  const programme = lireProgramme();

  for (const { semaine, module_code: code, ouvre_le: forcee } of programme) {
    const module = lireModule(code);
    // Une date saisie a la main prime sur le rythme hebdomadaire.
    const ouverture = forcee || dateOuverture(semaine);
    if (!module) {
      rapport.push({ semaine, statut: 'introuvable', motif: `module ${code}` });
      continue;
    }

    const existant = db.prepare('SELECT id FROM defis WHERE semaine = ?').get(semaine);
    const badge = module.badge || {};
    const video = module.video || {};

    if (existant) {
      const joue = db.prepare('SELECT COUNT(*) AS n FROM participations WHERE defi_id = ?').get(existant.id).n;
      if (joue > 0 && !force) {
        rapport.push({ semaine, statut: 'ignore', motif: `${joue} participation(s) enregistree(s)` });
        continue;
      }
      db.prepare(`UPDATE defis SET titre = ?, accroche = ?, intro = ?, duree_minutes = ?, ouvre_le = ?,
                    module_code = ?, badge_code = ?, badge_libelle = ?, badge_emoji = ?, badge_description = ?,
                    video_url = ?, video_titre = ?,
                    maj_le = datetime('now') WHERE id = ?`)
        .run(module.titre, module.accroche, module.intro, module.duree_minutes || 7, ouverture,
             module.code, badge.code || null, badge.libelle || null,
             badge.emoji || null, badge.description || null,
             video.url || null, video.titre || null, existant.id);
      db.prepare('DELETE FROM questions WHERE defi_id = ?').run(existant.id);
      insererQuestions(existant.id, module.questions);
      rapport.push({ semaine, module: module.code, statut: 'mis a jour', questions: module.questions.length });
    } else {
      const res = db.prepare(`
        INSERT INTO defis (semaine, titre, accroche, intro, duree_minutes, ouvre_le, publie, module_code,
                           badge_code, badge_libelle, badge_emoji, badge_description, video_url, video_titre)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(semaine, module.titre, module.accroche, module.intro, module.duree_minutes || 7,
             ouverture, module.code, badge.code || null, badge.libelle || null,
             badge.emoji || null, badge.description || null,
             video.url || null, video.titre || null);
      insererQuestions(res.lastInsertRowid, module.questions);
      rapport.push({ semaine, module: module.code, statut: 'cree', questions: module.questions.length });
    }
  }

  // Une semaine deprogrammee n'a plus de raison d'apparaitre au portail. On ne
  // supprime que ce que personne n'a joue : le reste se depublie a la main.
  const programmees = new Set(programme.map((p) => p.semaine));
  for (const d of db.prepare('SELECT id, semaine FROM defis').all()) {
    if (programmees.has(d.semaine)) continue;
    const joue = db.prepare('SELECT COUNT(*) AS n FROM participations WHERE defi_id = ?').get(d.id).n;
    if (joue > 0) { rapport.push({ semaine: d.semaine, statut: 'conserve', motif: `${joue} participation(s)` }); continue; }
    db.prepare('DELETE FROM questions WHERE defi_id = ?').run(d.id);
    db.prepare('DELETE FROM defis WHERE id = ?').run(d.id);
    rapport.push({ semaine: d.semaine, statut: 'deprogramme' });
  }

  return rapport.sort((a, b) => a.semaine - b.semaine);
}

function insererQuestions(defiId, questions) {
  const q = db.prepare('INSERT INTO questions (defi_id, ordre, enonce, contexte, multiple, points, explication) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const r = db.prepare('INSERT INTO reponses (question_id, ordre, libelle, correcte) VALUES (?, ?, ?, ?)');
  questions.forEach((question, i) => {
    const res = q.run(
      defiId, i + 1, question.enonce, question.contexte || null,
      question.multiple ? 1 : 0, question.points || 10, question.explication || ''
    );
    question.reponses.forEach((rep, j) => r.run(res.lastInsertRowid, j + 1, rep.libelle, rep.correcte ? 1 : 0));
  });
}

/** Exporte un defi de la base vers le format JSON editable */
export function exporterDefi(semaine) {
  const defi = db.prepare('SELECT * FROM defis WHERE semaine = ?').get(semaine);
  if (!defi) return null;
  const questions = db.prepare('SELECT * FROM questions WHERE defi_id = ? ORDER BY ordre').all(defi.id);
  return {
    semaine: defi.semaine, titre: defi.titre, accroche: defi.accroche, intro: defi.intro,
    duree_minutes: defi.duree_minutes,
    badge: defi.badge_code ? {
      code: defi.badge_code, libelle: defi.badge_libelle,
      emoji: defi.badge_emoji, description: defi.badge_description,
    } : null,
    questions: questions.map((q) => ({
      enonce: q.enonce, contexte: q.contexte, multiple: !!q.multiple, points: q.points, explication: q.explication,
      reponses: db.prepare('SELECT libelle, correcte FROM reponses WHERE question_id = ? ORDER BY ordre').all(q.id)
        .map((r) => ({ libelle: r.libelle, correcte: !!r.correcte })),
    })),
  };
}

// Execution directe : node src/lib/seed.js [--force]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force');
  console.table(importerContenus({ force }));
}
