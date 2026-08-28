import { db, journaliser } from '../lib/db.js';
import { config } from '../lib/config.js';
import { exigerAuth } from '../lib/session.js';
import {
  attribuerBadges, tousLesBadges,
  classementServices, classementAgents, rangAgent, rangService, statistiquesGlobales,
  pointsPossibles,
} from '../lib/scoring.js';
import {
  progression, repondre, totaux, effacerTentative, detailTentative, effacerTentatives,
} from '../lib/tentatives.js';
import { jetonValide } from '../lib/apercu.js';

/** Date du jour en heure locale : passer par toISOString reculerait d'un jour le soir. */
function aujourdhui() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * La campagne est close le lendemain de sa date de fin : le 31 octobre reste
 * jouable toute la journee, le 1er novembre le classement est definitif.
 */
export function campagneClose() {
  return !!config.campagne.fin && aujourdhui() > config.campagne.fin;
}

/**
 * Un defi est jouable s'il est publie, que sa date de parution est atteinte,
 * et que la campagne n'est pas close.
 * Les defis des semaines precedentes restent ouverts : un agent qui prend le
 * train en marche doit pouvoir rattraper.
 */
function estOuvert(defi) {
  return defi.publie === 1 && defi.ouvre_le <= aujourdhui() && !campagneClose();
}

/** Un defi deja joue reste consultable apres la cloture, sans pouvoir etre rejoue. */
function estParu(defi) {
  return defi.publie === 1 && defi.ouvre_le <= aujourdhui();
}

export default async function routesJeu(app) {
  app.addHook('preHandler', exigerAuth);

  /* ------------------------------------------------------- Liste des defis */
  /** Reglages d'affichage de la page des defis, modifiables sans redemarrage. */
  app.get('/api/defis/affichage', async () => ({
    defisParLigne: Math.min(4, Math.max(1, Number(config.defisParLigne) || 2)),
  }));

  app.get('/api/defis', async (requete) => {
    const defis = db.prepare('SELECT * FROM defis ORDER BY semaine').all();
    const faits = db.prepare(
      'SELECT defi_id, score, score_max, bonnes, total_questions FROM participations WHERE agent_id = ? AND entrainement = 0'
    ).all(requete.agent.id);
    const parDefi = Object.fromEntries(faits.map((f) => [f.defi_id, f]));

    return defis.map((d) => {
      const ouvert = estOuvert(d);

      // Un defi a venir ne livre rien de son contenu : ni titre, ni accroche,
      // ni nombre de questions. L'effet de surprise fait partie de la
      // campagne, et le masquer a l'ecran seulement ne masquerait rien - la
      // reponse de l'API se lit dans n'importe quel navigateur.
      return {
      semaine: d.semaine,
      titre: ouvert ? d.titre : null,
      accroche: ouvert ? d.accroche : null,
      dureeMinutes: ouvert ? d.duree_minutes : null,
      ouvreLe: d.ouvre_le,
      ouvert,
      paru: estParu(d),
      nbQuestions: ouvert
        ? db.prepare('SELECT COUNT(*) AS n FROM questions WHERE defi_id = ?').get(d.id).n
        : null,
      // Questions deja validees sur un defi non termine : c'est ce qui permet
      // a l'accueil de proposer de reprendre plutot que de recommencer. Un
      // agent interrompu au telephone ne doit pas croire qu'il repart de zero.
      repondues: ouvert && !parDefi[d.id]
        ? progression(requete.agent.id, d.id).length
        : 0,
      participation: parDefi[d.id]
        ? {
            score: parDefi[d.id].score,
            scoreMax: parDefi[d.id].score_max,
            bonnes: parDefi[d.id].bonnes,
            total: parDefi[d.id].total_questions,
          }
        : null,
      };
    });
  });

  /* ------------------------------------------ Contenu d'un defi (sans les corrections) */
  app.get('/api/defis/:semaine', async (requete, reponse) => {
    const defi = db.prepare('SELECT * FROM defis WHERE semaine = ?').get(Number(requete.params.semaine));
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    // Apres la cloture le defi reste consultable : on peut relire les
    // corrections, mais plus rien ne s'enregistre.
    // Un jeton d'apercu ouvre un defi encore scelle, pour relecture ou test.
    // Rien de ce qui s'y joue ne comptera : ce n'est pas un reglage, c'est le
    // chemin de code - aucune participation n'est ecrite plus bas.
    const apercu = jetonValide(defi, requete.query?.apercu);
    if (!apercu && !estParu(defi)) {
      return reponse.code(403).send({ erreur: `Ce défi ouvre le ${defi.ouvre_le}.` });
    }

    const dejaFait = db.prepare(
      'SELECT id FROM participations WHERE agent_id = ? AND defi_id = ? AND entrainement = 0'
    ).get(requete.agent.id, defi.id);

    // Les reponses d'un apercu ne doivent pas preremplir le parcours reel :
    // sans cela l'agent trouverait son defi a moitie fait le lundi d'ouverture.
    if (!apercu) effacerTentatives(requete.agent.id, defi.id, { apercuSeulement: true });

    const questions = db.prepare('SELECT * FROM questions WHERE defi_id = ? ORDER BY ordre').all(defi.id);

    return {
      semaine: defi.semaine,
      titre: defi.titre,
      accroche: defi.accroche,
      intro: defi.intro,
      dureeMinutes: defi.duree_minutes,
      // Video d'introduction, facultative. L'URL seule est transmise : c'est le
      // navigateur qui decide d'appeler YouTube, et seulement si l'agent clique.
      video: defi.video_url ? { url: defi.video_url, titre: defi.video_titre || null } : null,
      // Hebergeurs autorises : l'ecran ne connait le format d'insertion que de
      // YouTube et Dailymotion. Pour une autre plateforme, il insere l'adresse
      // telle quelle - a condition qu'elle figure ici, sinon le navigateur la
      // bloquerait de toute facon.
      videoDomaines: config.videoDomaines || [],
      // Rejouer est possible mais ne rapporte plus de points : mode entrainement.
      // Un apercu l'est toujours, par construction.
      entrainement: apercu || !!dejaFait,
      apercu,
      close: campagneClose(),
      // Permet de reprendre ou l'agent s'etait arrete
      dejaRepondu: progression(requete.agent.id, defi.id).map((p) => p.question_id),
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

  /* --------------------------------------- Validation, une question a la fois */

  app.post('/api/defis/:semaine/questions/:questionId', async (requete, reponse) => {
    const defi = db.prepare('SELECT * FROM defis WHERE semaine = ?').get(Number(requete.params.semaine));
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    if (campagneClose()) {
      return reponse.code(403).send({
        erreur: `La campagne est terminée depuis le ${config.campagne.fin}. Le classement est définitif.`,
        close: true,
      });
    }
    const apercu = jetonValide(defi, requete.query?.apercu);
    if (!apercu && !estOuvert(defi)) {
      return reponse.code(403).send({ erreur: "Ce défi n'est pas ouvert." });
    }

    const question = db.prepare('SELECT * FROM questions WHERE id = ? AND defi_id = ?')
      .get(Number(requete.params.questionId), defi.id);
    if (!question) return reponse.code(404).send({ erreur: 'Question introuvable.' });

    const choix = Array.isArray(requete.body?.choix) ? requete.body.choix : [];
    if (!choix.length) return reponse.code(400).send({ erreur: 'Sélectionnez au moins une réponse.' });

    // Une reponse validee ne se reprend pas : la correction est deja connue
    const dejaRepondu = progression(requete.agent.id, defi.id).some((p) => p.question_id === question.id);
    if (dejaRepondu) {
      return reponse.code(409).send({ erreur: 'Vous avez déjà répondu à cette question.' });
    }

    const correction = repondre(requete.agent.id, defi.id, question, choix, { apercu });
    const etat = totaux(requete.agent.id, defi.id);
    const nbQuestions = db.prepare('SELECT COUNT(*) AS n FROM questions WHERE defi_id = ?').get(defi.id).n;

    return {
      ...correction,
      progression: { repondues: etat.repondues, total: nbQuestions },
      scoreCourant: etat.score,
      derniere: etat.repondues >= nbQuestions,
    };
  });

  /* ----------------------------------------------------------- Fin du defi */

  app.post('/api/defis/:semaine/terminer', async (requete, reponse) => {
    const defi = db.prepare('SELECT * FROM defis WHERE semaine = ?').get(Number(requete.params.semaine));
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    if (campagneClose()) {
      return reponse.code(403).send({ erreur: 'La campagne est terminée.', close: true });
    }

    const nbQuestions = db.prepare('SELECT COUNT(*) AS n FROM questions WHERE defi_id = ?').get(defi.id).n;
    const etat = totaux(requete.agent.id, defi.id);
    if (etat.repondues < nbQuestions) {
      return reponse.code(400).send({
        erreur: `Défi incomplet : ${etat.repondues} question(s) sur ${nbQuestions}.`,
      });
    }

    const apercu = jetonValide(defi, requete.query?.apercu);
    const dejaFait = db.prepare(
      'SELECT id FROM participations WHERE agent_id = ? AND defi_id = ? AND entrainement = 0'
    ).get(requete.agent.id, defi.id);
    // Un apercu ne compte jamais : aucune participation n'est ecrite, donc rien
    // n'entre au classement, aux statistiques ni aux badges.
    const entrainement = (apercu || dejaFait) ? 1 : 0;

    // Les traces de l'apercu partent avec lui : le parcours reel doit trouver
    // un defi vierge le jour de son ouverture.
    if (apercu) effacerTentatives(requete.agent.id, defi.id, { apercuSeulement: true });

    let nouveauxBadges = [];
    if (!entrainement) {
      db.prepare(`
        INSERT INTO participations (agent_id, defi_id, score, score_max, bonnes, total_questions, duree_secondes, entrainement)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0)
      `).run(requete.agent.id, defi.id, etat.score, etat.scoreMax, etat.parfaites, nbQuestions);

      const participationId = db.prepare(
        'SELECT id FROM participations WHERE agent_id = ? AND defi_id = ? AND entrainement = 0'
      ).get(requete.agent.id, defi.id).id;

      const ins = db.prepare(
        'INSERT INTO reponses_agent (participation_id, question_id, choix, correcte, points_obtenus) VALUES (?, ?, ?, ?, ?)'
      );
      for (const d of detailTentative(requete.agent.id, defi.id)) {
        ins.run(participationId, d.question_id, d.choix, d.parfaite, d.points);
      }

      nouveauxBadges = attribuerBadges(requete.agent.id, {
        semaine: defi.semaine, score: etat.score, scoreMax: etat.scoreMax,
        // Cocher une mauvaise proposition n'est pas la meme chose qu'en oublier
        // une bonne : seul le premier cas empeche « Œil de lynx ».
        erreurs: etat.erreurs,
      });

      journaliser(requete.agent.login, 'defi_termine',
        `semaine=${defi.semaine} score=${etat.score}/${etat.scoreMax}`, requete.ip);
    }

    effacerTentative(requete.agent.id, defi.id);

    return {
      entrainement: !!entrainement,
      score: etat.score,
      scoreMax: etat.scoreMax,
      bonnes: etat.parfaites,
      total: nbQuestions,
      pourcentage: etat.scoreMax ? Math.round((etat.score / etat.scoreMax) * 100) : 0,
      nouveauxBadges,
      rangService: rangService(requete.agent.service),
      rangAgent: rangAgent(requete.agent.id),
    };
  });

  /** Abandonner la tentative en cours pour repartir de zero. */
  app.delete('/api/defis/:semaine/tentative', async (requete, reponse) => {
    const defi = db.prepare('SELECT * FROM defis WHERE semaine = ?').get(Number(requete.params.semaine));
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    effacerTentative(requete.agent.id, defi.id);
    return { ok: true };
  });

  /* --------------------------------------------------------- Classements */
  app.get('/api/classement', async (requete) => ({
    close: campagneClose(),
    finCampagne: config.campagne.fin,
    services: classementServices(),
    // La page n'affiche que les dix premiers, mais le « voir plus » deplie
    // l'ensemble sans nouvel appel.
    agents: classementAgents(1000),
    monService: requete.agent.service,
    monRangService: rangService(requete.agent.service),
    monRangAgent: rangAgent(requete.agent.id),
    stats: statistiquesGlobales(),
  }));

  /* ------------------------------------------------------------- Profil */
  /**
   * Relecture d'un defi termine : ce que l'agent a repondu, et pourquoi.
   *
   * « Revoir les corrections » renvoyait au questionnaire, qui repartait en
   * mode entrainement : on rejouait au lieu de relire, et la premiere reponse
   * disparaissait de l'ecran. Cette route rend l'etat enregistre, sans rien
   * offrir a modifier.
   */
  app.get('/api/defis/:semaine/relecture', async (requete, reponse) => {
    const defi = db.prepare('SELECT * FROM defis WHERE semaine = ?').get(Number(requete.params.semaine));
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });

    const participation = db.prepare(`
      SELECT id, score, score_max, bonnes, total_questions, termine_le
      FROM participations
      WHERE agent_id = ? AND defi_id = ? AND entrainement = 0
    `).get(requete.agent.id, defi.id);

    if (!participation) {
      return reponse.code(404).send({
        erreur: "Vous n'avez pas encore terminé ce défi : il n'y a rien à relire.",
      });
    }

    const donnees = db.prepare(`
      SELECT r.question_id, r.choix, r.correcte, r.points_obtenus,
             q.enonce, q.contexte, q.multiple, q.points, q.explication, q.ordre
      FROM reponses_agent r
      JOIN questions q ON q.id = r.question_id
      WHERE r.participation_id = ?
      ORDER BY q.ordre
    `).all(participation.id);

    return {
      semaine: defi.semaine,
      titre: defi.titre,
      accroche: defi.accroche,
      score: participation.score,
      scoreMax: participation.score_max,
      bonnes: participation.bonnes,
      total: participation.total_questions,
      termineLe: participation.termine_le,
      questions: donnees.map((d) => {
        let choisis = [];
        try { choisis = JSON.parse(d.choix) || []; } catch { choisis = []; }
        return {
          enonce: d.enonce,
          contexte: d.contexte,
          multiple: !!d.multiple,
          points: d.points,
          pointsObtenus: d.points_obtenus,
          parfaite: !!d.correcte,
          explication: d.explication,
          // Les bonnes reponses sont ici legitimes : le defi est termine, et
          // le score enregistre ne bougera plus.
          reponses: db.prepare(
            'SELECT id, libelle, correcte FROM reponses WHERE question_id = ? ORDER BY ordre'
          ).all(d.question_id).map((r) => ({
            libelle: r.libelle,
            correcte: !!r.correcte,
            choisie: choisis.includes(r.id),
          })),
        };
      }),
    };
  });

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
      // Le total atteignable a ce jour, pour dire « 62 % » plutot que « 430
      // points » - un nombre de points ne se situe pas tout seul.
      pointsPossibles: pointsPossibles(),
      badges: tousLesBadges().map((b) => ({
        ...b, obtenu: !!codesObtenus[b.code], obtenuLe: codesObtenus[b.code] || null,
      })),
      rangService: rangService(requete.agent.service),
      rangAgent: rangAgent(requete.agent.id),
      complet: participations.length >= totalDefis && totalDefis > 0,
      totalDefis,
      campagne: config.campagne,
      close: campagneClose(),
    };
  });
}
