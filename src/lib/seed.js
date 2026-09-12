import { pathToFileURL } from 'node:url';
import { db } from './db.js';
import { lireModule, lireProgramme } from './modules.js';
// La table des tentatives est creee par ce module : sans l'importer, le
// rechargement lance en ligne de commande echouerait sur une table absente.
import './tentatives.js';

/**
 * Verse dans les defis le contenu des modules programmes.
 *
 * Un defi cree est publie : sa date d'ouverture suffit a le tenir ferme
 * jusqu'au jour dit. Exiger en plus une publication manuelle faisait doublon
 * avec la programmation, et se soldait par des defis qui restaient scelles
 * passe leur date sans que rien ne l'explique. « Masquer » reste possible,
 * mais devient ce qu'il aurait toujours du etre : une exception.
 *
 * La programmation dit quel module parait a quelle date ; cette fonction en
 * tire les questionnaires. Elle est idempotente : la rejouer met a jour
 * titres, dates et questions sans toucher aux participations.
 *
 * Deux choses ne sont jamais reecrites sans force :
 *   - un defi deja joue, dont les participants ont repondu a des questions qui
 *     doivent rester celles qu'ils ont vues ;
 *   - un defi retouche dans le back-office, dont la correction vaut mieux que
 *     le fichier. Cette fonction s'executant a chaque demarrage du serveur,
 *     sans cette protection une question corrigee le lundi disparaissait au
 *     redemarrage du mardi, remplacee par le texte d'origine.
 *
 * Dans les deux cas la DATE reste appliquee : la repousser ou l'avancer ne
 * touche pas au questionnaire.
 */
export function importerContenus({ force = false } = {}) {
  const rapport = [];
  const programme = lireProgramme();

  for (const { module_code: code, ouvre_le: ouverture } of programme) {
    const module = lireModule(code);
    if (!module) {
      rapport.push({ module: code, statut: 'introuvable', motif: `module ${code}` });
      continue;
    }

    // Le module est ce qui identifie un defi d'un import a l'autre : c'est lui
    // qu'on retrouve, sa date n'etant qu'une propriete de plus a mettre a jour.
    const existant = db.prepare('SELECT id, contenu_modifie FROM defis WHERE module_code = ?').get(code);
    const badge = module.badge || {};
    const video = module.video || {};

    if (existant) {
      const joue = db.prepare('SELECT COUNT(*) AS n FROM participations WHERE defi_id = ?').get(existant.id).n;
      // Une tentative en cours compte autant qu'une participation terminee.
      // Sans elle, un simple redemarrage du conteneur - donc chaque
      // deploiement - reecrivait les questions du defi ouvert le matin meme,
      // et la cascade emportait les reponses des agents en train de jouer :
      // ils repartaient de zero, apres avoir vu les corrections.
      const enCours = db.prepare('SELECT COUNT(*) AS n FROM tentatives WHERE defi_id = ?').get(existant.id).n;
      const motif = existant.contenu_modifie
        ? 'modifie dans le back-office'
        : joue > 0 ? `${joue} participation(s) enregistree(s)`
          : enCours > 0 ? `${enCours} reponse(s) en cours de saisie` : null;

      if (motif && !force) {
        // La date, elle, reste modifiable : la repousser ou l'avancer ne
        // change rien au questionnaire.
        db.prepare("UPDATE defis SET ouvre_le = ?, maj_le = datetime('now') WHERE id = ?")
          .run(ouverture, existant.id);
        rapport.push({ module: code, ouvre_le: ouverture, statut: 'protege', motif });
        continue;
      }
      // Le defi redevient conforme a son module : le drapeau tombe, sans quoi
      // un rechargement force resterait annonce comme « protege » ensuite.
      db.prepare(`UPDATE defis SET titre = ?, accroche = ?, intro = ?, duree_minutes = ?, ouvre_le = ?,
                    module_code = ?, badge_code = ?, badge_libelle = ?, badge_emoji = ?, badge_description = ?,
                    video_url = ?, video_titre = ?, contenu_modifie = 0,
                    maj_le = datetime('now') WHERE id = ?`)
        .run(module.titre, module.accroche, module.intro, module.duree_minutes || 7, ouverture,
             module.code, badge.code || null, badge.libelle || null,
             badge.emoji || null, badge.description || null,
             video.url || null, video.titre || null, existant.id);
      db.prepare('DELETE FROM questions WHERE defi_id = ?').run(existant.id);
      insererQuestions(existant.id, module.questions);
      rapport.push({ module: module.code, ouvre_le: ouverture, statut: 'mis a jour', questions: module.questions.length });
    } else {
      const res = db.prepare(`
        INSERT INTO defis (titre, accroche, intro, duree_minutes, ouvre_le, publie, module_code,
                           badge_code, badge_libelle, badge_emoji, badge_description, video_url, video_titre)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(module.titre, module.accroche, module.intro, module.duree_minutes || 7,
             ouverture, module.code, badge.code || null, badge.libelle || null,
             badge.emoji || null, badge.description || null,
             video.url || null, video.titre || null);
      insererQuestions(res.lastInsertRowid, module.questions);
      rapport.push({ module: module.code, ouvre_le: ouverture, statut: 'cree', questions: module.questions.length });
    }
  }

  // Un module deprogramme n'a plus de raison d'apparaitre au portail. On ne
  // supprime que ce que personne n'a joue : le reste se depublie a la main.
  // Les defis rediges directement dans l'administration n'ont pas de module :
  // ils ne dependent pas du programme, et ne sont donc jamais emportes ici.
  const programmes = new Set(programme.map((p) => p.module_code));
  for (const d of db.prepare('SELECT id, module_code, titre FROM defis WHERE module_code IS NOT NULL').all()) {
    if (programmes.has(d.module_code)) continue;
    const joue = db.prepare('SELECT COUNT(*) AS n FROM participations WHERE defi_id = ?').get(d.id).n;
    if (joue > 0) { rapport.push({ module: d.module_code, statut: 'conserve', motif: `${joue} participation(s)` }); continue; }
    db.prepare('DELETE FROM questions WHERE defi_id = ?').run(d.id);
    db.prepare('DELETE FROM defis WHERE id = ?').run(d.id);
    rapport.push({ module: d.module_code, statut: 'deprogramme' });
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
export function exporterDefi(id) {
  const defi = db.prepare('SELECT * FROM defis WHERE id = ?').get(Number(id));
  if (!defi) return null;
  const questions = db.prepare('SELECT * FROM questions WHERE defi_id = ? ORDER BY ordre').all(defi.id);
  return {
    id: defi.id, titre: defi.titre, accroche: defi.accroche, intro: defi.intro,
    duree_minutes: defi.duree_minutes,
    // Date et publication manquaient : l'editeur les affichait vides, et son
    // enregistrement renvoyait « non publie » - il depubliait donc le defi
    // qu'on venait simplement corriger.
    ouvre_le: defi.ouvre_le,
    publie: !!defi.publie,
    badge: defi.badge_code ? {
      code: defi.badge_code, libelle: defi.badge_libelle,
      emoji: defi.badge_emoji, description: defi.badge_description,
    } : null,
    // La video se modifie defi par defi : celle du module n'est qu'une valeur
    // de depart, et une campagne peut vouloir la sienne.
    video: defi.video_url
      ? {
          url: defi.video_url,
          titre: defi.video_titre,
          // L'editeur doit la retrouver pour la modifier : sans elle, chaque
          // enregistrement effacerait l'alternative textuelle deja saisie.
          transcription: defi.video_transcription || null,
        }
      : null,
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
