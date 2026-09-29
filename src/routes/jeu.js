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
import { aujourdhui } from '../lib/dates.js';
import { illustrationDe } from '../lib/illustrations.js';

// La date du jour vient d'un module partage : le calcul des scores l'emploie
// aussi, et les deux divergeaient d'un jour deux heures par nuit.

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
 * Les defis deja parus restent ouverts : un agent qui prend le
 * train en marche doit pouvoir rattraper.
 */
function estOuvert(defi) {
  return defi.publie === 1 && defi.ouvre_le <= aujourdhui() && !campagneClose();
}

/** Un defi deja joue reste consultable apres la cloture, sans pouvoir etre rejoue. */
function estParu(defi) {
  return defi.publie === 1 && defi.ouvre_le <= aujourdhui();
}

/**
 * Rang d'un defi dans la campagne : « Défi n°3 ».
 *
 * Une date de parution situe un defi dans le calendrier, elle ne le nomme pas.
 * « Paru le jeudi 30 juillet » se lit deux fois avant de comprendre de quel
 * defi on parle, la ou un numero se retient.
 *
 * Le numero se CALCULE a partir de l'ordre des parutions, il ne se stocke pas :
 * c'est ce qui evite de retomber sur l'ancien travers, ou un rang inscrit en
 * base devenait faux des qu'on inserait un defi ou qu'on deplacait une date.
 * L'identifiant departage deux defis parus le meme jour, pour que l'ordre soit
 * le meme d'un ecran a l'autre.
 */
function numeroDefi(defi) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM defis
    WHERE publie = 1 AND (ouvre_le < ? OR (ouvre_le = ? AND id <= ?))
  `).get(defi.ouvre_le, defi.ouvre_le, defi.id).n;
}

export default async function routesJeu(app) {
  app.addHook('preHandler', exigerAuth);

  /* ------------------------------------------------------- Liste des defis */
  /** Reglages d'affichage de la page des defis, modifiables sans redemarrage. */
  app.get('/api/defis/affichage', async () => ({
    defisParLigne: Math.min(4, Math.max(1, Number(config.defisParLigne) || 2)),
  }));

  app.get('/api/defis', async (requete) => {
    // Un defi masque ne figure plus dans la liste. Il y apparaissait encore,
    // scelle : « Masquer » ne masquait donc que le contenu, pas la carte, et
    // le defi comptait quand meme dans la numerotation affichee aux agents.
    const defis = db.prepare('SELECT * FROM defis WHERE publie = 1 ORDER BY ouvre_le, id').all();
    const faits = db.prepare(
      'SELECT defi_id, score, score_max, bonnes, total_questions FROM participations WHERE agent_id = ? AND entrainement = 0'
    ).all(requete.agent.id);
    const parDefi = Object.fromEntries(faits.map((f) => [f.defi_id, f]));

    return defis.map((d, rang) => {
      const ouvert = estOuvert(d);
      // Ce qui commande l'affichage, c'est la PARUTION, pas la jouabilite.
      // Les deux se confondaient, si bien qu'apres la cloture de la campagne
      // tous les defis - y compris ceux que l'agent avait joues - se
      // rescellaient : « Descellement le lundi 5 octobre » au 1er novembre,
      // et plus aucun moyen de relire ses corrections.
      const paru = estParu(d);

      // Un defi a venir ne livre rien de son contenu : ni titre, ni accroche,
      // ni nombre de questions. L'effet de surprise fait partie de la
      // campagne, et le masquer a l'ecran seulement ne masquerait rien - la
      // reponse de l'API se lit dans n'importe quel navigateur.
      return {
      id: d.id,
      // La liste est deja triee par parution : le rang s'y lit directement,
      // sans repasser par la base pour chaque carte.
      numero: rang + 1,
      titre: paru ? d.titre : null,
      accroche: paru ? d.accroche : null,
      dureeMinutes: paru ? d.duree_minutes : null,
      ouvreLe: d.ouvre_le,
      ouvert,
      paru,
      nbQuestions: paru
        ? db.prepare('SELECT COUNT(*) AS n FROM questions WHERE defi_id = ?').get(d.id).n
        : null,
      // Questions deja validees sur un defi non termine : c'est ce qui permet
      // a l'accueil de proposer de reprendre plutot que de recommencer. Un
      // agent interrompu au telephone ne doit pas croire qu'il repart de zero.
      repondues: ouvert && !parDefi[d.id]
        ? progression(requete.agent.id, d.id, { apercu: false }).length
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
  app.get('/api/defis/:id', async (requete, reponse) => {
    const defi = db.prepare('SELECT * FROM defis WHERE id = ?').get(Number(requete.params.id));
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
      id: defi.id,
      ouvreLe: defi.ouvre_le,
      numero: numeroDefi(defi),
      titre: defi.titre,
      accroche: defi.accroche,
      intro: defi.intro,
      dureeMinutes: defi.duree_minutes,
      // Video d'introduction, facultative. L'URL seule est transmise : c'est le
      // navigateur qui decide d'appeler YouTube, et seulement si l'agent clique.
      video: defi.video_url
        ? {
            url: defi.video_url,
            titre: defi.video_titre || null,
            // Alternative textuelle, affichee sous le lecteur : une video sans
            // equivalent texte n'est pas accessible.
            transcription: defi.video_transcription || null,
          }
        : null,
      // Sans video, l'illustration du module prend sa place.
      illustration: defi.video_url ? null : illustrationDe(defi),
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
      // Permet de reprendre ou l'agent s'etait arrete, dans le mode en cours
      dejaRepondu: progression(requete.agent.id, defi.id, { apercu }).map((p) => p.question_id),
      questions: questions.map((q) => ({
        id: q.id,
        enonce: q.enonce,
        contexte: q.contexte,
        multiple: !!q.multiple,
        points: q.points,
        // Le niveau est affiche avec les points : « 15 points » sans raison
        // ressemble a une faveur, « Difficile · 15 points » s'explique tout seul.
        difficulte: q.difficulte,
        // Les bonnes reponses ne sont JAMAIS envoyees au navigateur avant validation
        reponses: db.prepare('SELECT id, libelle FROM reponses WHERE question_id = ? ORDER BY ordre').all(q.id),
      })),
    };
  });

  /* --------------------------------------- Validation, une question a la fois */

  app.post('/api/defis/:id/questions/:questionId', async (requete, reponse) => {
    const defi = db.prepare('SELECT * FROM defis WHERE id = ?').get(Number(requete.params.id));
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

    // Les choix ne sont retenus que s'ils designent bien une proposition de
    // CETTE question. Sans ce filtre, n'importe quelle valeur - identifiant
    // d'une autre question, chaine, objet - etait enregistree telle quelle
    // dans la tentative puis archivee, jusqu'a la taille maximale d'un corps
    // de requete.
    const proposes = db.prepare('SELECT id FROM reponses WHERE question_id = ?').all(question.id)
      .map((r) => r.id);
    const brut = Array.isArray(requete.body?.choix) ? requete.body.choix : [];
    const choix = [...new Set(brut.map(Number))].filter((id) => proposes.includes(id));

    if (!brut.length) return reponse.code(400).send({ erreur: 'Sélectionnez au moins une réponse.' });
    if (!choix.length) {
      return reponse.code(400).send({
        erreur: 'Aucune des réponses transmises ne correspond à cette question.',
        code: 'CHOIX_INVALIDE',
      });
    }
    // Une question a choix unique n'accepte qu'une seule coche : l'ecran le
    // respecte, l'API ne l'exigeait pas.
    if (!question.multiple && choix.length > 1) {
      return reponse.code(400).send({
        erreur: 'Cette question n’admet qu’une seule réponse.',
        code: 'CHOIX_MULTIPLE_REFUSE',
      });
    }

    // Une reponse validee ne se reprend pas : la correction est deja connue.
    // Le controle porte sur le mode en cours, sans quoi une reponse d'apercu
    // bloquerait la meme question dans le parcours reel.
    const dejaRepondu = progression(requete.agent.id, defi.id, { apercu })
      .some((p) => p.question_id === question.id);
    if (dejaRepondu) {
      return reponse.code(409).send({
        erreur: 'Vous avez déjà répondu à cette question.',
        code: 'DEJA_REPONDU',
      });
    }

    const correction = repondre(requete.agent.id, defi.id, question, choix, { apercu });
    const etat = totaux(requete.agent.id, defi.id, { apercu });
    const nbQuestions = db.prepare('SELECT COUNT(*) AS n FROM questions WHERE defi_id = ?').get(defi.id).n;

    return {
      ...correction,
      progression: { repondues: etat.repondues, total: nbQuestions },
      scoreCourant: etat.score,
      derniere: etat.repondues >= nbQuestions,
    };
  });

  /* ----------------------------------------------------------- Fin du defi */

  app.post('/api/defis/:id/terminer', async (requete, reponse) => {
    const defi = db.prepare('SELECT * FROM defis WHERE id = ?').get(Number(requete.params.id));
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    if (campagneClose()) {
      return reponse.code(403).send({ erreur: 'La campagne est terminée.', close: true });
    }

    const apercu = jetonValide(defi, requete.query?.apercu);

    // Un defi qui n'est pas ouvert ne se termine pas. Ce controle manquait :
    // il suffisait de jouer avec un lien d'apercu, puis d'appeler cette route
    // SANS le jeton, pour qu'une participation reelle soit ecrite sur un defi
    // encore scelle - ou jamais publie.
    if (!apercu && !estOuvert(defi)) {
      return reponse.code(403).send({
        erreur: "Ce défi n'est pas ouvert : aucun résultat ne peut y être enregistré.",
        code: 'DEFI_FERME',
      });
    }

    const nbQuestions = db.prepare('SELECT COUNT(*) AS n FROM questions WHERE defi_id = ?').get(defi.id).n;
    if (nbQuestions === 0) {
      // Sans ce garde-fou, « 0 reponse sur 0 » passait pour un defi complet :
      // une participation vide etait ecrite, et « Sans faute » decerne.
      return reponse.code(400).send({
        erreur: "Ce défi ne comporte aucune question : il n'y a rien à valider.",
        code: 'DEFI_VIDE',
      });
    }

    // Les totaux ne retiennent que les reponses du mode en cours : une partie
    // d'apercu ne peut donc plus alimenter une participation reelle.
    const etat = totaux(requete.agent.id, defi.id, { apercu });
    if (etat.repondues < nbQuestions) {
      return reponse.code(400).send({
        erreur: `Défi incomplet : ${etat.repondues} question(s) sur ${nbQuestions}.`,
        code: 'DEFI_INCOMPLET',
      });
    }

    const dejaFait = db.prepare(
      'SELECT id FROM participations WHERE agent_id = ? AND defi_id = ? AND entrainement = 0'
    ).get(requete.agent.id, defi.id);
    // Un apercu ne compte jamais : aucune participation n'est ecrite, donc rien
    // n'entre au classement, aux statistiques ni aux badges.
    const entrainement = (apercu || dejaFait) ? 1 : 0;

    let nouveauxBadges = [];
    // Une seule transaction : une participation sans ses reponses archivees
    // laissait un defi « termine » dont la relecture etait vide, et qu'un
    // recalcul ulterieur ramenait a zero.
    db.exec('BEGIN');
    try {
      if (!entrainement) {
        const res = db.prepare(`
          INSERT INTO participations (agent_id, defi_id, score, score_max, bonnes, total_questions, duree_secondes, entrainement)
          VALUES (?, ?, ?, ?, ?, ?, 0, 0)
        `).run(requete.agent.id, defi.id, etat.score, etat.scoreMax, etat.parfaites, nbQuestions);

        const ins = db.prepare(
          'INSERT INTO reponses_agent (participation_id, question_id, choix, correcte, points_obtenus) VALUES (?, ?, ?, ?, ?)'
        );
        for (const d of detailTentative(requete.agent.id, defi.id, { apercu: false })) {
          ins.run(res.lastInsertRowid, d.question_id, d.choix, d.parfaite, d.points);
        }
      }

      // Les traces de l'apercu partent avec lui : le parcours reel doit trouver
      // un defi vierge le jour de son ouverture.
      if (apercu) effacerTentatives(requete.agent.id, defi.id, { apercuSeulement: true });
      else effacerTentative(requete.agent.id, defi.id);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      requete.log.error(err, 'cloture de defi interrompue');
      return reponse.code(500).send({
        erreur: "L'enregistrement de votre résultat a échoué. Vos réponses sont conservées : "
          + 'réessayez dans un instant.',
        code: 'CLOTURE_ECHOUEE',
      });
    }

    // Hors transaction : les badges et le journal ne doivent pas faire
    // echouer l'enregistrement du resultat, qui est ce qui compte.
    if (!entrainement) {
      nouveauxBadges = attribuerBadges(requete.agent.id, {
        defiId: defi.id, score: etat.score, scoreMax: etat.scoreMax,
        // Cocher une mauvaise proposition n'est pas la meme chose qu'en oublier
        // une bonne : seul le premier cas empeche « Œil de lynx ».
        erreurs: etat.erreurs,
      });

      journaliser(requete.agent.login, 'defi_termine',
        `defi=${defi.id} score=${etat.score}/${etat.scoreMax}`, requete.ip);
    }

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

  /**
   * Abandonner la tentative en cours pour repartir de zero.
   *
   * Cette route effacait tout, sans condition. Chaque validation renvoyant la
   * correction complete de la question, il suffisait de repondre au hasard,
   * de noter les bonnes reponses, d'appeler cette route, puis de rejouer : un
   * sans-faute et tous les badges, depuis la console du navigateur.
   *
   * Une reponse reelle deja validee ne s'efface donc plus. Ce qui reste
   * permis - et qui est le besoin d'origine - c'est d'abandonner un parcours
   * ou rien n'a encore ete valide, et de recommencer autant qu'on veut en
   * entrainement ou en apercu, ou rien ne compte.
   */
  app.delete('/api/defis/:id/tentative', async (requete, reponse) => {
    const defi = db.prepare('SELECT * FROM defis WHERE id = ?').get(Number(requete.params.id));
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });

    const reelles = db.prepare(
      'SELECT COUNT(*) AS n FROM tentatives WHERE agent_id = ? AND defi_id = ? AND apercu = 0'
    ).get(requete.agent.id, defi.id).n;

    // Un defi deja termine rejoue en entrainement : les reponses en cours ne
    // valent plus rien, on peut repartir de zero sans consequence.
    const dejaFait = db.prepare(
      'SELECT id FROM participations WHERE agent_id = ? AND defi_id = ? AND entrainement = 0'
    ).get(requete.agent.id, defi.id);

    if (reelles > 0 && !dejaFait) {
      return reponse.code(409).send({
        erreur: `Vous avez déjà validé ${reelles} réponse(s) sur ce défi, et leurs corrections `
          + "vous ont été montrées. Recommencer à zéro reviendrait à rejouer en connaissant "
          + 'les réponses : le défi se termine avec les réponses déjà données.',
        code: 'TENTATIVE_VERROUILLEE',
        repondues: reelles,
      });
    }

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
    //
    // Le drapeau « moi » remplace la comparaison des noms faite a l'ecran :
    // celle-ci surlignait les homonymes et ne reconnaissait jamais un agent
    // ayant demande l'anonymat, dont la ligne porte « Agent anonyme ».
    agents: classementAgents(1000).map((a) => ({
      ...a,
      moi: a.id === requete.agent.id,
    })),
    monService: requete.agent.service,
    monRangService: rangService(requete.agent.service),
    monRangAgent: rangAgent(requete.agent.id),
    // « parDefi » porte le titre et la date de CHAQUE defi, y compris ceux qui
    // ne sont pas parus : la page ne les affichait pas, mais la reponse de
    // l'API se lit dans n'importe quel navigateur. Les agents n'ont besoin que
    // des totaux ; le detail par defi reste servi au back-office.
    stats: statistiquesGlobales({ detailParDefi: false }),
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
  app.get('/api/defis/:id/relecture', async (requete, reponse) => {
    const defi = db.prepare('SELECT * FROM defis WHERE id = ?').get(Number(requete.params.id));
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
      id: defi.id,
      ouvreLe: defi.ouvre_le,
      numero: numeroDefi(defi),
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
      SELECT p.*, d.id AS defi, d.titre, d.ouvre_le FROM participations p
      JOIN defis d ON d.id = p.defi_id
      WHERE p.agent_id = ? AND p.entrainement = 0 ORDER BY d.ouvre_le, d.id
    `).all(requete.agent.id);

    const obtenus = db.prepare('SELECT code, obtenu_le FROM badges_agent WHERE agent_id = ?').all(requete.agent.id);
    const codesObtenus = Object.fromEntries(obtenus.map((b) => [b.code, b.obtenu_le]));

    const totalDefis = db.prepare('SELECT COUNT(*) AS n FROM defis WHERE publie = 1').get().n;

    return {
      agent: { nomComplet: requete.agent.nom_complet, service: requete.agent.service },
      participations: participations.map((p) => ({
        id: p.defi, numero: numeroDefi({ id: p.defi, ouvre_le: p.ouvre_le }),
        titre: p.titre, ouvreLe: p.ouvre_le, score: p.score, scoreMax: p.score_max,
        bonnes: p.bonnes, total: p.total_questions, termineLe: p.termine_le,
      })),
      scoreTotal: participations.reduce((s, p) => s + p.score, 0),
      // Le total atteignable a ce jour, pour dire « 62 % » plutot que « 430
      // points » - un nombre de points ne se situe pas tout seul.
      pointsPossibles: pointsPossibles(),
      badges: tousLesBadges({ agentId: requete.agent.id }).map((b) => ({
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
