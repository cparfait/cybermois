import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';

const DOSSIER = path.resolve(process.cwd(), 'content');

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
 * Charge les defis depuis content/*.json.
 * Idempotent : reimporter met a jour titres et questions sans perdre les participations.
 * Les defis deja joues ne sont pas ecrases sauf si force = true.
 */
export function importerContenus({ force = false } = {}) {
  const fichiers = fs.readdirSync(DOSSIER).filter((f) => /^semaine-\d+\.json$/.test(f)).sort();
  const rapport = [];

  for (const fichier of fichiers) {
    const defi = JSON.parse(fs.readFileSync(path.join(DOSSIER, fichier), 'utf8'));
    const existant = db.prepare('SELECT id FROM defis WHERE semaine = ?').get(defi.semaine);

    if (existant) {
      const joue = db.prepare('SELECT COUNT(*) AS n FROM participations WHERE defi_id = ?').get(existant.id).n;
      if (joue > 0 && !force) {
        rapport.push({ semaine: defi.semaine, statut: 'ignore', motif: `${joue} participation(s) enregistree(s)` });
        continue;
      }
      db.prepare(`UPDATE defis SET titre = ?, accroche = ?, intro = ?, duree_minutes = ?, ouvre_le = ?,
                    badge_code = ?, badge_libelle = ?, badge_emoji = ?, badge_description = ?,
                    maj_le = datetime('now') WHERE id = ?`)
        .run(defi.titre, defi.accroche, defi.intro, defi.duree_minutes || 7, dateOuverture(defi.semaine),
             defi.badge?.code || null, defi.badge?.libelle || null,
             defi.badge?.emoji || null, defi.badge?.description || null, existant.id);
      db.prepare('DELETE FROM questions WHERE defi_id = ?').run(existant.id);
      insererQuestions(existant.id, defi.questions);
      rapport.push({ semaine: defi.semaine, statut: 'mis a jour', questions: defi.questions.length });
    } else {
      const res = db.prepare(`
        INSERT INTO defis (semaine, titre, accroche, intro, duree_minutes, ouvre_le, publie,
                           badge_code, badge_libelle, badge_emoji, badge_description)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(defi.semaine, defi.titre, defi.accroche, defi.intro, defi.duree_minutes || 7,
             dateOuverture(defi.semaine), defi.badge?.code || null, defi.badge?.libelle || null,
             defi.badge?.emoji || null, defi.badge?.description || null);
      insererQuestions(res.lastInsertRowid, defi.questions);
      rapport.push({ semaine: defi.semaine, statut: 'cree', questions: defi.questions.length });
    }
  }
  return rapport;
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
