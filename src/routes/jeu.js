import { db, journaliser } from '../lib/db.js';
import { config } from '../lib/config.js';
import { exigerAuth } from '../lib/session.js';
import {
  noterQuestion, bonusRapidite, attribuerBadges, BADGES,
  classementServices, classementAgents, rangAgent, rangService, statistiquesGlobales,
} from '../lib/scoring.js';

const aujourdhui = () => new Date().toISOString().slice(0, 10);

/** Un defi est jouable si il est publie et que sa date d'ouverture est atteinte. */
function estOuvert(defi) {
  return defi.publie === 1 && defi.ouvre_le <= aujourdhui();
}

export default async function routesJeu(app) {
  app.addHook('preHandler', exigerAuth);

  /* ------------------------------------------------------- Liste des defis */
  app.get('/api/defis', async (requete) => {
    const defis = db.prepare('SELECT * FROM defis ORDER BY semaine').all();
    const faits = db.prepare(
      'SELECT defi_id, score, score_max, bonnes, total_questions FROM participations WHERE agent_id = ? AND entrainement = 0'
    ).all(requete.agent.id);
    const parDefi = Object.fromEntries(faits.map((f) => [f.defi_id, f]));

    return defis.map((d) => ({
      semaine: d.semaine,
      titre: d.titre,
      accroche: d.accroche,
      dureeMinutes: d.duree_minutes,
      ouvreLe: d.ouvre_le,
      ouvert: estOuvert(d),
      nbQuestions: db.prepare('SELECT COUNT(*) AS n FROM questions WHERE defi_id = ?').get(d.id).n,
      participation: parDefi[d.id]
        ? {
            score: parDefi[d.id].score,
            scoreMax: parDefi[d.id].score_max,
            bonnes: parDefi[d.id].bonnes,
            total: parDefi[d.id].total_questions,
          }
        : null,
    }));
  });

  /* ------------------------------------------ Contenu d'un defi (sans les corrections) */
  app.get('/api/defis/:semaine', async (requete, reponse) => {
    const defi = db.prepare('SELECT * FROM defis WHERE semaine = ?').get(Number(requete.params.semaine));
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    if (!estOuvert(defi)) return reponse.code(403).send({ erreur: `Ce défi ouvre le ${defi.ouvre_le}.` });

    const dejaFait = db.prepare(
      'SELECT id FROM participations WHERE agent_id = ? AND defi_id = ? AND entrainement = 0'
    ).get(requete.agent.id, defi.id);

    const questions = db.prepare('SELECT * FROM questions WHERE defi_id = ? ORDER BY ordre').all(defi.id);

    return {
      semaine: defi.semaine,
      titre: defi.titre,
      accroche: defi.accroche,
      intro: defi.intro,
      dureeMinutes: defi.duree_minutes,
      // Rejouer est possible mais ne rapporte plus de points : mode entrainement
      entrainement: !!dejaFait,
      questions: questions.map((q) => ({
        id: q.id,
        enonce: q.enonce,
        contexte: q.contexte,
        multiple: !!q.multiple,
        points: q.points,
        // Les bonnes reponses ne sont JAMAIS envoyees au navigateur avant validation
        reponses: db.prepare('SELECT id, libelle FROM reponses WHERE question_id = ? ORDER BY ordre').all(q.id),
      })),
    };
  });

  /* ---------------------------------------------------------- Validation */
  app.post('/api/defis/:semaine/valider', async (requete, reponse) => {
    const defi = db.prepare('SELECT * FROM defis WHERE semaine = ?').get(Number(requete.params.semaine));
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    if (!estOuvert(defi)) return reponse.code(403).send({ erreur: 'Ce défi n\'est pas ouvert.' });

    const { reponses: choixParQuestion, dureeSecondes } = requete.body || {};
    if (!choixParQuestion || typeof choixParQuestion !== 'object') {
      return reponse.code(400).send({ erreur: 'Réponses manquantes.' });
    }

    const dejaFait = db.prepare(
      'SELECT id FROM participations WHERE agent_id = ? AND defi_id = ? AND entrainement = 0'
    ).get(requete.agent.id, defi.id);
    const entrainement = dejaFait ? 1 : 0;

    const questions = db.prepare('SELECT * FROM questions WHERE defi_id = ? ORDER BY ordre').all(defi.id);
    const detail = [];
    let score = 0; let scoreMax = 0; let bonnes = 0;

    for (const q of questions) {
      q.reponses = db.prepare('SELECT id, libelle, correcte FROM reponses WHERE question_id = ? ORDER BY ordre').all(q.id);
      const choix = choixParQuestion[q.id] || [];
      const note = noterQuestion(q, choix);

      score += note.points;
      scoreMax += q.points;
      if (note.parfaite) bonnes++;

      detail.push({
        questionId: q.id,
        enonce: q.enonce,
        points: note.points,
        pointsMax: q.points,
        parfaite: note.parfaite,
        explication: q.explication,
        choixAgent: choix.map(Number),
        bonnesReponses: q.reponses.filter((r) => r.correcte).map((r) => r.id),
        reponses: q.reponses.map((r) => ({ id: r.id, libelle: r.libelle, correcte: !!r.correcte })),
      });
    }

    const duree = Math.max(0, Math.min(Number(dureeSecondes) || 0, 7200));
    const bonus = entrainement ? 0 : bonusRapidite(score, duree, questions.length);
    const scoreFinal = score + bonus;
    const bonusMax = bonus > 0 && bonus >= Math.round(score * 0.19);

    let nouveauxBadges = [];
    if (!entrainement) {
      db.prepare(`
        INSERT INTO participations (agent_id, defi_id, score, score_max, bonnes, total_questions, duree_secondes, entrainement)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).run(requete.agent.id, defi.id, scoreFinal, scoreMax, bonnes, questions.length, duree);

      const participationId = db.prepare(
        'SELECT id FROM participations WHERE agent_id = ? AND defi_id = ? AND entrainement = 0'
      ).get(requete.agent.id, defi.id).id;

      const ins = db.prepare(
        'INSERT INTO reponses_agent (participation_id, question_id, choix, correcte, points_obtenus) VALUES (?, ?, ?, ?, ?)'
      );
      for (const d of detail) {
        ins.run(participationId, d.questionId, JSON.stringify(d.choixAgent), d.parfaite ? 1 : 0, d.points);
      }

      nouveauxBadges = attribuerBadges(requete.agent.id, {
        semaine: defi.semaine, score: scoreFinal, scoreMax, bonusMax,
      });

      journaliser(requete.agent.login, 'defi_termine', `semaine=${defi.semaine} score=${scoreFinal}/${scoreMax}`, requete.ip);
    }

    return {
      entrainement: !!entrainement,
      score: scoreFinal,
      scoreBrut: score,
      bonus,
      scoreMax,
      bonnes,
      total: questions.length,
      pourcentage: scoreMax ? Math.round((score / scoreMax) * 100) : 0,
      detail,
      nouveauxBadges,
      rangService: rangService(requete.agent.service),
      rangAgent: rangAgent(requete.agent.id),
    };
  });

  /* --------------------------------------------------------- Classements */
  app.get('/api/classement', async (requete) => ({
    services: classementServices(),
    agents: classementAgents(50),
    monService: requete.agent.service,
    monRangService: rangService(requete.agent.service),
    monRangAgent: rangAgent(requete.agent.id),
    stats: statistiquesGlobales(),
  }));

  /* ------------------------------------------------------------- Profil */
  app.get('/api/profil', async (requete) => {
    const participations = db.prepare(`
      SELECT p.*, d.semaine, d.titre FROM participations p
      JOIN defis d ON d.id = p.defi_id
      WHERE p.agent_id = ? AND p.entrainement = 0 ORDER BY d.semaine
    `).all(requete.agent.id);

    const obtenus = db.prepare('SELECT code, obtenu_le FROM badges_agent WHERE agent_id = ?').all(requete.agent.id);
    const codesObtenus = Object.fromEntries(obtenus.map((b) => [b.code, b.obtenu_le]));

    const totalDefis = db.prepare('SELECT COUNT(*) AS n FROM defis WHERE publie = 1').get().n;

    return {
      agent: { nomComplet: requete.agent.nom_complet, service: requete.agent.service },
      participations: participations.map((p) => ({
        semaine: p.semaine, titre: p.titre, score: p.score, scoreMax: p.score_max,
        bonnes: p.bonnes, total: p.total_questions, termineLe: p.termine_le,
      })),
      scoreTotal: participations.reduce((s, p) => s + p.score, 0),
      badges: BADGES.map((b) => ({ ...b, obtenu: !!codesObtenus[b.code], obtenuLe: codesObtenus[b.code] || null })),
      rangService: rangService(requete.agent.service),
      rangAgent: rangAgent(requete.agent.id),
      complet: participations.length >= totalDefis && totalDefis > 0,
      totalDefis,
      campagne: config.campagne,
    };
  });
}
