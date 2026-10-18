import { db, journaliser } from '../lib/db.js';
import { config } from '../lib/config.js';
import { exigerAdmin } from '../lib/session.js';
import { testerConnexion } from '../lib/ldap.js';
import { importerContenus, exporterDefi } from '../lib/seed.js';
import { listerModules, lireModule, etatProgramme, enregistrerProgramme } from '../lib/modules.js';
import { versionApplication } from '../lib/version.js';
import { classementServices, classementAgents, statistiquesGlobales } from '../lib/scoring.js';
import {
  testerSmtp, envoyerRelances, envoyerResultats,
  mailLancement, mailRelance, mailResultats,
} from '../lib/mail.js';
import { creerJetonApercu, revoquerJetonApercu, lienApercu } from '../lib/apercu.js';
import {
  enregistrerVideo, listerVideos, supprimerVideo, formatsLisibles, TAILLE_MAX,
  placeOccupee, QUOTA_TOTAL,
} from '../lib/videos.js';
import { csv } from '../lib/csv.js';

// L'echappement vit dans son propre module : il neutralise desormais les
// cellules que le tableur lirait comme des formules, ce qui merite d'etre
// teste et partage plutot que recopie. Voir src/lib/csv.js.

export default async function routesAdmin(app) {
  app.addHook('preHandler', exigerAdmin);

  /* ------------------------------------------------------ Tableau de bord */
  app.get('/api/admin/tableau-de-bord', async () => {
    const stats = statistiquesGlobales();
    const services = classementServices();

    const jamaisJoue = db.prepare(`
      SELECT service, COUNT(*) AS n FROM agents a
      WHERE NOT EXISTS (SELECT 1 FROM participations p WHERE p.agent_id = a.id AND p.entrainement = 0)
      GROUP BY service ORDER BY n DESC
    `).all();

    const derniersEnvois = db.prepare('SELECT * FROM envois ORDER BY id DESC LIMIT 10').all();
    const defis = db.prepare('SELECT id, titre, ouvre_le, publie FROM defis ORDER BY ouvre_le, id').all();

    // L'ecran signalait « aucun effectif importe » des que tout le monde
    // s'etait connecte, ce qui arrive dans une petite collectivite. La
    // question est de savoir si un effectif de reference existe, pas de
    // comparer deux compteurs qui peuvent legitimement coincider.
    const effectifImporte = db.prepare(
      "SELECT COUNT(*) AS n FROM agents WHERE origine IN ('import', 'annuaire') AND exclu = 0"
    ).get().n;

    return {
      stats, services, jamaisJoue, derniersEnvois, defis,
      effectifImporte,
      campagne: config.campagne,
    };
  });

  /* ------------------------------------------------------------ Diagnostic */
  app.get('/api/admin/diagnostic', async () => {
    const [ldap, smtp] = await Promise.all([testerConnexion(), testerSmtp()]);
    return {
      ldap,
      smtp,
      version: versionApplication(),
      configuration: {
        ldapUrl: config.ldap.url,
        baseDn: config.ldap.baseDn,
        sourceService: config.service.source === 'ou' ? `OU du DN (profondeur ${config.service.ouDepth})` : `attribut ${config.service.attribut}`,
        groupeRequis: config.ldap.requiredGroup || '(aucun)',
        envoiMailActif: config.smtp.actif,
        groupeDiffusion: config.smtp.groupeDiffusion || '(non renseigne)',
        cronRelance: config.cron.relance,
        cronResultats: config.cron.resultats,
        urlPublique: config.publicUrl,
        administrateurs: config.adminLogins,
      },
    };
  });

  /* ---------------------------------------------------- Gestion des defis */
  /* ------------------------------------------- Catalogue et programmation */

  /**
   * Le catalogue des modules disponibles, et la date ou chacun parait.
   * Ecrire vingt questionnaires et n'en jouer que quatre suppose de pouvoir
   * choisir : c'est ce que cet ecran permet.
   */
  app.get('/api/admin/modules', async () => ({
    modules: listerModules(),
    programme: etatProgramme(),
  }));

  /** Le detail d'un module, reponses comprises, pour le relire avant de le programmer. */
  app.get('/api/admin/modules/:code', async (requete, reponse) => {
    const module = lireModule(requete.params.code);
    if (!module) return reponse.code(404).send({ erreur: 'Module introuvable.' });
    return module;
  });

  /**
   * Enregistre la programmation puis verse le contenu dans les defis.
   * Les deux vont ensemble : une programmation qui ne se traduit pas en
   * questionnaires ne se verifierait qu'au moment ou il serait trop tard.
   */
  app.put('/api/admin/programme', async (requete, reponse) => {
    const entrees = Array.isArray(requete.body?.programme) ? requete.body.programme : null;
    if (!entrees) return reponse.code(400).send({ erreur: 'Programmation attendue.' });

    let n;
    try {
      n = enregistrerProgramme(entrees, requete.agent.login);
    } catch (err) {
      return reponse.code(409).send({ erreur: err.message });
    }

    const rapport = importerContenus();
    const crees = rapport.filter((r) => r.statut === 'cree').length;
    const majs = rapport.filter((r) => r.statut === 'mis a jour').length;
    const retires = rapport.filter((r) => r.statut === 'deprogramme').length;

    const bouts = [`${n} defi(s) programme(s)`];
    if (crees) bouts.push(`${crees} questionnaire(s) cree(s)`);
    if (majs) bouts.push(`${majs} mis a jour`);
    if (retires) bouts.push(`${retires} retire(s)`);
    return { message: `${bouts.join(', ')}.`, rapport };
  });

  // Les compteurs accompagnent chaque defi : l'ecran doit pouvoir annoncer ce
  // qu'une suppression emporte AVANT qu'on la demande, et distinguer de vrais
  // resultats de simples essais - les seconds ne valent rien.
  app.get('/api/admin/defis', async () => db.prepare(`
    SELECT d.*,
           (SELECT COUNT(*) FROM participations p
             WHERE p.defi_id = d.id AND p.entrainement = 0) AS participations,
           (SELECT COUNT(*) FROM participations p
             WHERE p.defi_id = d.id AND p.entrainement = 1) AS essais
    FROM defis d ORDER BY d.ouvre_le, d.id
  `).all()
    // Le jeton lui-meme ne sort pas d'ici : il n'est rendu qu'a sa creation.
    .map(({ jeton_apercu: jeton, ...d }) => ({ ...d, apercuOuvert: !!jeton })));

  app.get('/api/admin/defis/:id', async (requete, reponse) => {
    const defi = exporterDefi(requete.params.id);
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    // Les hebergeurs autorises accompagnent le defi : sans eux, l'apercu video
    // de l'editeur ne pouvait pas juger d'une adresse et annoncait « adresse
    // non reconnue » pour une plateforme parfaitement acceptee. L'ecran devait
    // sinon aller les chercher dans un second appel.
    return { ...defi, videoDomaines: config.videoDomaines || [] };
  });

  /** Creation d'un defi. Il arrive masque : on le publie une fois redige. */
  app.post('/api/admin/defis', async (requete, reponse) => {
    const c = requete.body || {};
    const titre = String(c.titre || '').trim();
    if (!titre) return reponse.code(400).send({ erreur: 'Le titre est obligatoire.' });

    // La date de parution est le seul reperage d'un defi : sans elle, il ne
    // paraitrait jamais. A defaut, le jour meme - le defi arrivant masque,
    // rien ne s'ouvre pour autant.
    const ouvreLe = /^\d{4}-\d{2}-\d{2}$/.test(String(c.ouvre_le || ''))
      ? c.ouvre_le : new Date().toISOString().slice(0, 10);

    // Les trois insertions vont ensemble : un defi cree sans sa question
    // d'amorce s'ouvrait sur un editeur vide, et se serait laisse publier.
    let nouveauId;
    db.exec('BEGIN');
    try {
      const res = db.prepare(`
        INSERT INTO defis (titre, accroche, intro, duree_minutes, ouvre_le, publie)
        VALUES (?, ?, ?, ?, ?, 0)
      `).run(
        titre,
        String(c.accroche || '').trim(),
        String(c.intro || '').trim(),
        Number(c.duree_minutes) || 7,
        ouvreLe
      );
      nouveauId = res.lastInsertRowid;

      // Une question d'amorce, pour que l'editeur ne s'ouvre pas sur un ecran vide
      const q = db.prepare(
        'INSERT INTO questions (defi_id, ordre, enonce, contexte, multiple, points, explication) VALUES (?, 1, ?, NULL, 1, 10, ?)'
      ).run(nouveauId, 'Nouvelle question — remplacez cet énoncé', '');
      const r = db.prepare('INSERT INTO reponses (question_id, ordre, libelle, correcte) VALUES (?, ?, ?, ?)');
      r.run(q.lastInsertRowid, 1, 'Première réponse (bonne)', 1);
      r.run(q.lastInsertRowid, 2, 'Deuxième réponse', 0);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      requete.log.error(err, 'creation de defi interrompue');
      return reponse.code(500).send({
        erreur: "La création a échoué : aucun défi n'a été enregistré.",
        code: 'CREATION_ECHOUEE',
      });
    }

    journaliser(requete.agent.login, 'defi_cree', `defi=${nouveauId} titre=${titre}`, requete.ip);
    return {
      ok: true,
      id: nouveauId,
      message: `Défi « ${titre} » créé pour le ${ouvreLe}, pour l'instant masqué. `
        + 'Rédigez les questions, puis publiez-le.',
    };
  });

  /** Suppression d'un defi. Les participations partent avec : confirmation exigee. */
  app.delete('/api/admin/defis/:id', async (requete, reponse) => {
    const id = Number(requete.params.id);
    const defi = db.prepare('SELECT * FROM defis WHERE id = ?').get(id);
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });

    // Un defi en cours se supprime comme un autre : rien n'est verrouille par
    // sa date. Ce qui se protege, ce sont les resultats - et seuls les vrais
    // comptent : un essai en entrainement n'a jamais valu au classement.
    const { reels, essais } = db.prepare(`
      SELECT COALESCE(SUM(entrainement = 0), 0) AS reels,
             COALESCE(SUM(entrainement = 1), 0) AS essais
      FROM participations WHERE defi_id = ?
    `).get(defi.id);
    const participations = reels + essais;

    if (participations > 0 && !requete.body?.confirmerPerteResultats) {
      return reponse.code(409).send({
        erreur: `« ${defi.titre} » porte ${reels} résultat(s) réel(s)`
          + (essais ? ` et ${essais} essai(s) d'entraînement` : '')
          + '. Le supprimer les effacera définitivement et modifiera les classements. '
          + 'Vous pouvez aussi le masquer : il disparaît du portail sans perdre les scores.',
        participations,
        reels,
        essais,
        confirmationRequise: true,
      });
    }

    // Supprimer le defi ne suffisait pas : son module restait au programme, et
    // importerContenus() le recreait au demarrage suivant du serveur - donc a
    // chaque deploiement, qui redemarre le conteneur. Le defi revenait seul, et
    // « Supprimer » ne tenait pas sa promesse. Retirer aussi la parution est ce
    // que le geste veut dire : le module reste au catalogue, reprogrammable.
    db.exec('BEGIN');
    let deprogramme = 0;
    try {
      db.prepare('DELETE FROM defis WHERE id = ?').run(defi.id); // cascade questions et participations
      if (defi.module_code) {
        deprogramme = db.prepare('DELETE FROM programme WHERE module_code = ?').run(defi.module_code).changes;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      requete.log.error(err, 'suppression de defi interrompue');
      return reponse.code(500).send({ erreur: 'Suppression impossible : rien n’a été modifié.', code: 'SUPPRESSION_ECHOUEE' });
    }

    journaliser(requete.agent.login, 'defi_supprime',
      `defi=${id} (${participations} participations)${deprogramme ? `, module ${defi.module_code} deprogramme` : ''}`,
      requete.ip);

    return {
      ok: true,
      message: `Défi « ${defi.titre} » supprimé.`
        + (participations ? ` ${participations} participation(s) effacée(s).` : '')
        + (deprogramme
          ? ` Le module ${defi.module_code} est retiré du programme : le défi ne reviendra pas `
            + 'au prochain rechargement. Il reste au catalogue si vous voulez le reprogrammer.'
          : ''),
    };
  });

  app.post('/api/admin/defis/:id', async (requete, reponse) => {
    const id = Number(requete.params.id);
    const defi = db.prepare('SELECT * FROM defis WHERE id = ?').get(id);
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });

    const corps = requete.body || {};
    const questions = corps.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      return reponse.code(400).send({ erreur: 'Au moins une question est requise.' });
    }
    const texte = (v) => (typeof v === 'string' ? v.trim() : '');
    for (const [i, q] of questions.entries()) {
      if (!texte(q.enonce) || !Array.isArray(q.reponses) || q.reponses.length < 2) {
        return reponse.code(400).send({ erreur: `Question ${i + 1} : énoncé et au moins deux réponses requis.` });
      }
      // Le libelle n'etait pas verifie : une reponse sans texte faisait
      // echouer l'insertion APRES la suppression des anciennes questions, et
      // le defi restait sans aucune question.
      const vide = q.reponses.findIndex((r) => !texte(r?.libelle));
      if (vide !== -1) {
        return reponse.code(400).send({
          erreur: `Question ${i + 1}, réponse ${vide + 1} : le libellé ne peut pas être vide.`,
        });
      }
      if (!q.reponses.some((r) => r.correcte)) {
        return reponse.code(400).send({ erreur: `Question ${i + 1} : au moins une bonne réponse doit être cochée.` });
      }
    }

    /**
     * Un defi deja joue ne se restructure pas.
     *
     * Les questions etaient supprimees puis recreees a chaque enregistrement.
     * Or reponses_agent.question_id porte ON DELETE CASCADE : corriger une
     * coquille sur un defi joue par trois cents agents effacait, sans un mot,
     * TOUTES leurs reponses archivees. Les scores restaient, mais « Revoir mes
     * reponses » devenait vide et un recalcul ulterieur les ramenait a zero.
     *
     * Tant que des participations reelles existent, la structure est donc
     * figee : meme nombre de questions, meme nombre de reponses par question.
     * Les textes, eux, restent modifiables - c'est le besoin courant - et sont
     * mis a jour EN PLACE, sans jamais detruire d'identifiant.
     */
    const reelles = db.prepare(
      'SELECT COUNT(*) AS n FROM participations WHERE defi_id = ? AND entrainement = 0'
    ).get(defi.id).n;

    const existantes = db.prepare(
      'SELECT id FROM questions WHERE defi_id = ? ORDER BY ordre, id'
    ).all(defi.id);

    if (reelles > 0) {
      if (questions.length !== existantes.length) {
        return reponse.code(409).send({
          erreur: `« ${defi.titre} » a déjà été joué par ${reelles} agent(s). `
            + `Le nombre de questions ne peut plus changer (${existantes.length} attendues, `
            + `${questions.length} reçues) : les réponses déjà enregistrées y font référence. `
            + 'Vous pouvez corriger les textes, ou supprimer le défi si vous acceptez de perdre les résultats.',
          code: 'STRUCTURE_FIGEE',
          participations: reelles,
        });
      }
      for (const [i, q] of questions.entries()) {
        const nb = db.prepare('SELECT COUNT(*) AS n FROM reponses WHERE question_id = ?')
          .get(existantes[i].id).n;
        if (q.reponses.length !== nb) {
          return reponse.code(409).send({
            erreur: `« ${defi.titre} » a déjà été joué par ${reelles} agent(s). `
              + `Le nombre de réponses de la question ${i + 1} ne peut plus changer `
              + `(${nb} attendues, ${q.reponses.length} reçues).`,
            code: 'STRUCTURE_FIGEE',
            participations: reelles,
          });
        }
      }
    }

    // Un badge sans code n'existe pas : on en derive un du libelle pour que le
    // badge suive le defi meme quand l'administrateur le renomme.
    const codeBadge = corps.badge?.code
      || (corps.badge?.libelle
        ? corps.badge.libelle.normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)
        : defi.badge_code);

    // Une video se retire en vidant le champ : sans distinguer « absent du
    // corps » de « vidé », on ne pourrait plus jamais l'enlever.
    const videoFournie = corps.video !== undefined;
    const videoUrl = videoFournie ? (String(corps.video?.url || '').trim() || null) : defi.video_url;
    const videoTitre = videoFournie
      ? (videoUrl ? (String(corps.video?.titre || '').trim() || null) : null)
      : defi.video_titre;
    // Transcription : l'alternative textuelle exigee par le RGAA pour un
    // contenu video. Elle disparait avec la video qu'elle decrit.
    const videoTranscription = videoFournie
      ? (videoUrl ? (String(corps.video?.transcription || '').trim().slice(0, 20000) || null) : null)
      : defi.video_transcription;

    // Une adresse video doit etre servie par le portail ou tenir en https :
    // rien n'empechait d'enregistrer « data: » ou « file: », que l'ecran
    // presentait ensuite comme un lien a cliquer.
    if (videoUrl && !/^\/videos\/[A-Za-z0-9._-]+$/.test(videoUrl)) {
      let acceptable = false;
      try { acceptable = new URL(videoUrl).protocol === 'https:'; } catch { acceptable = false; }
      if (!acceptable) {
        return reponse.code(400).send({
          erreur: "L'adresse de la vidéo doit commencer par https:// ou désigner un fichier "
            + 'déposé sur le portail.',
          code: 'VIDEO_INVALIDE',
        });
      }
    }

    // La date de parution est verifiee comme a la creation : une saisie
    // invalide passait ici sans controle et faussait la comparaison
    // « ouvre_le <= aujourd'hui », donc l'ouverture du defi.
    if (corps.ouvre_le !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(corps.ouvre_le))) {
      return reponse.code(400).send({ erreur: 'Date de parution invalide : attendu AAAA-MM-JJ.' });
    }

    // Un emoji de badge est borne et ne contient pas de balise : il est
    // affiche tel quel sur le profil, l'attestation et l'ecran de fin.
    const emoji = corps.badge?.emoji === undefined
      ? defi.badge_emoji
      : String(corps.badge.emoji).replace(/[<>&"']/g, '').slice(0, 8) || null;

    // Tout s'ecrit d'un bloc : un enregistrement interrompu au milieu laissait
    // un defi dont les questions avaient disparu.
    db.exec('BEGIN');
    try {
      // Ce defi a ete ecrit a la main : le rechargement des contenus, qui
      // s'execute a chaque demarrage, ne doit plus le remplacer par son module.
      db.prepare(`UPDATE defis SET titre = ?, accroche = ?, intro = ?, duree_minutes = ?, ouvre_le = ?, publie = ?,
                    badge_code = ?, badge_libelle = ?, badge_emoji = ?, badge_description = ?,
                    video_url = ?, video_titre = ?, video_transcription = ?, contenu_modifie = 1,
                    maj_le = datetime('now') WHERE id = ?`)
        .run(
          corps.titre ?? defi.titre, corps.accroche ?? defi.accroche, corps.intro ?? defi.intro,
          Number(corps.duree_minutes) || defi.duree_minutes,
          corps.ouvre_le || defi.ouvre_le,
          corps.publie === undefined ? defi.publie : (corps.publie ? 1 : 0),
          corps.badge?.libelle ? codeBadge : defi.badge_code,
          corps.badge?.libelle ?? defi.badge_libelle,
          emoji,
          corps.badge?.description ?? defi.badge_description,
          videoUrl, videoTitre, videoTranscription,
          defi.id
        );

      if (reelles > 0) {
        // Mise a jour EN PLACE : les identifiants de questions et de reponses
        // sont conserves, donc les reponses archivees des agents restent
        // rattachees a ce qu'elles designent.
        const majQ = db.prepare(`UPDATE questions SET ordre = ?, enonce = ?, contexte = ?,
                                   multiple = ?, points = ?, explication = ? WHERE id = ?`);
        const majR = db.prepare('UPDATE reponses SET ordre = ?, libelle = ?, correcte = ? WHERE id = ?');
        questions.forEach((q, i) => {
          const qid = existantes[i].id;
          majQ.run(i + 1, q.enonce, q.contexte || null, q.multiple ? 1 : 0,
            Math.max(1, Number(q.points) || 10), q.explication || '', qid);
          const rExistantes = db.prepare(
            'SELECT id FROM reponses WHERE question_id = ? ORDER BY ordre, id'
          ).all(qid);
          q.reponses.forEach((r, j) => majR.run(j + 1, r.libelle, r.correcte ? 1 : 0, rExistantes[j].id));
        });
      } else {
        db.prepare('DELETE FROM questions WHERE defi_id = ?').run(defi.id);
        const insQ = db.prepare('INSERT INTO questions (defi_id, ordre, enonce, contexte, multiple, points, explication) VALUES (?, ?, ?, ?, ?, ?, ?)');
        const insR = db.prepare('INSERT INTO reponses (question_id, ordre, libelle, correcte) VALUES (?, ?, ?, ?)');
        questions.forEach((q, i) => {
          // Des points negatifs ou nuls etaient acceptes : une question sans
          // valeur cassait le calcul du pourcentage.
          const res = insQ.run(defi.id, i + 1, q.enonce, q.contexte || null, q.multiple ? 1 : 0,
            Math.max(1, Number(q.points) || 10), q.explication || '');
          q.reponses.forEach((r, j) => insR.run(res.lastInsertRowid, j + 1, r.libelle, r.correcte ? 1 : 0));
        });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      requete.log.error(err, 'enregistrement de defi interrompu');
      return reponse.code(500).send({
        erreur: "L'enregistrement a échoué : le défi est resté dans son état précédent.",
        code: 'ENREGISTREMENT_ECHOUE',
      });
    }

    journaliser(requete.agent.login, 'defi_modifie',
      `defi=${id} questions=${questions.length}${reelles ? ` (maj en place, ${reelles} participations)` : ''}`,
      requete.ip);
    return {
      ok: true,
      message: `Défi « ${corps.titre ?? defi.titre} » enregistré (${questions.length} questions). `
        + 'Vos modifications sont désormais protégées : le rechargement des contenus ne les '
        + 'remplacera plus par le module d’origine.'
        + (reelles
          ? ` Ce défi ayant déjà été joué par ${reelles} agent(s), les textes ont été corrigés `
            + 'sans toucher aux réponses déjà enregistrées.'
          : ''),
    };
  });

  app.post('/api/admin/defis/:id/publication', async (requete, reponse) => {
    const id = Number(requete.params.id);
    const publie = requete.body?.publie ? 1 : 0;

    // Publier un defi sans question le rendait immediatement « terminable » :
    // zero reponse sur zero question passait pour un parcours complet, une
    // participation vide etait ecrite et les badges decernes.
    if (publie) {
      const nb = db.prepare('SELECT COUNT(*) AS n FROM questions WHERE defi_id = ?').get(id).n;
      if (nb === 0) {
        return reponse.code(400).send({
          erreur: 'Ce défi ne comporte aucune question : rédigez-les avant de le publier.',
          code: 'DEFI_VIDE',
        });
      }
    }

    const res = db.prepare('UPDATE defis SET publie = ? WHERE id = ?').run(publie, id);
    if (res.changes === 0) return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    journaliser(requete.agent.login, 'defi_publication', `defi=${id} publie=${publie}`, requete.ip);
    return { ok: true, publie: !!publie };
  });

  /* ------------------------------------------------- Apercu avant ouverture */

  /**
   * Un lien qui ouvre un defi encore scelle, sans que rien ne compte.
   *
   * Faire relire un questionnaire par la DPO, ou l'essayer avec un collegue,
   * suppose de pouvoir y jouer avant l'ouverture. Le jeton porte l'acces ; le
   * fait que rien ne compte est structurel - aucune participation n'est ecrite.
   */
  app.post('/api/admin/defis/:id/apercu', async (requete, reponse) => {
    const cree = creerJetonApercu(requete.params.id, requete.agent.login);
    if (!cree) return reponse.code(404).send({ erreur: 'Défi introuvable.' });

    return {
      ok: true,
      ...cree,
      lien: lienApercu(config.publicUrl, cree.id, cree.jeton),
      message: "Lien d'aperçu créé. Il ouvre ce défi avant sa date, et rien de ce qui "
        + "s'y joue n'entre au classement. Révoquez-le après vos essais.",
    };
  });

  app.delete('/api/admin/defis/:id/apercu', async (requete, reponse) => {
    if (!revoquerJetonApercu(requete.params.id, requete.agent.login)) {
      return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    }
    return { ok: true, message: "Lien d'aperçu révoqué : il ne fonctionne plus." };
  });

  /* --------------------------------------------- Vidéos hébergées sur place */

  /**
   * Depot d'une video servie par la collectivite.
   *
   * Cinq cents agents qui regardent la meme video sur YouTube en meme temps,
   * cela se voit sur le lien Internet d'une commune. Un fichier depose ici est
   * servi depuis le serveur : le trafic reste interne, et aucun tiers n'est
   * appele - donc aucun consentement a demander non plus.
   */
  app.post('/api/admin/videos', async (requete, reponse) => {
    const fichier = await requete.file();
    if (!fichier) return reponse.code(400).send({ erreur: 'Aucun fichier reçu.' });

    // Les videos partagent le volume de la base : sans plafond, un depot
    // repete saturait le disque, et SQLite ne pouvait plus ecrire une seule
    // participation.
    const occupe = placeOccupee();
    if (occupe >= QUOTA_TOTAL) {
      return reponse.code(507).send({
        erreur: `Les vidéos occupent déjà ${Math.round(occupe / 1024 / 1024)} Mo, `
          + `pour un maximum de ${Math.round(QUOTA_TOTAL / 1024 / 1024)} Mo. `
          + 'Supprimez un fichier inutilisé avant d’en déposer un nouveau.',
        code: 'QUOTA_ATTEINT',
      });
    }

    let resultat;
    try {
      resultat = await enregistrerVideo(fichier.file, fichier.mimetype);
    } catch (err) {
      return reponse.code(400).send({ erreur: err.message });
    }

    // Le flux signale lui-meme un depassement de la limite : sans ce controle,
    // un fichier tronque serait enregistre comme s'il etait complet.
    if (fichier.file.truncated) {
      supprimerVideo(resultat.nom);
      return reponse.code(413).send({
        erreur: `Fichier trop volumineux : ${Math.round(TAILLE_MAX / 1024 / 1024)} Mo au maximum.`,
      });
    }

    const mo = Math.round(resultat.octets / 1024 / 1024);
    journaliser(requete.agent.login, 'video_deposee', `${resultat.nom} (${mo} Mo)`, requete.ip);

    return {
      ok: true,
      ...resultat,
      message: `Vidéo déposée (${mo} Mo). Elle est servie depuis le serveur : `
        + "aucun appel à un service extérieur, et le trafic ne sort pas du réseau.",
    };
  });

  /** Les fichiers deposes, avec le defi qui s'en sert. */
  app.get('/api/admin/videos', async () => {
    const usages = new Map(
      db.prepare('SELECT id, titre, video_url FROM defis WHERE video_url IS NOT NULL')
        .all().map((d) => [d.video_url, d])
    );
    return {
      videos: listerVideos().map((v) => ({ ...v, utiliseePar: usages.get(v.url) || null })),
      tailleMax: TAILLE_MAX,
      formats: formatsLisibles(),
    };
  });

  app.delete('/api/admin/videos/:nom', async (requete, reponse) => {
    // Supprimer un fichier encore reference laisserait un defi pointant vers
    // le vide, ce qui ne se verrait qu'a l'ouverture par un agent.
    const url = `/videos/${requete.params.nom}`;
    const utilisee = db.prepare('SELECT titre FROM defis WHERE video_url = ?').get(url);
    if (utilisee) {
      return reponse.code(409).send({
        erreur: `Cette vidéo est utilisée par le défi « ${utilisee.titre} ». `
          + 'Retirez-la du défi avant de supprimer le fichier.',
      });
    }

    try {
      if (!supprimerVideo(requete.params.nom)) {
        return reponse.code(404).send({ erreur: 'Fichier introuvable.' });
      }
    } catch (err) {
      return reponse.code(400).send({ erreur: err.message });
    }

    journaliser(requete.agent.login, 'video_supprimee', requete.params.nom, requete.ip);
    return { ok: true, message: 'Vidéo supprimée.' };
  });

  app.post('/api/admin/reimporter', async (requete, reponse) => {
    const force = !!requete.body?.force;

    /**
     * Le rechargement force reecrit les questionnaires depuis les fichiers,
     * ce qui supprime les questions - et, par cascade, les reponses archivees
     * de tous ceux qui ont deja joue. Sans confirmation, un bouton
     * « Recharger » effacait donc la campagne en cours sans rien annoncer.
     */
    if (force) {
      const touches = db.prepare(`
        SELECT d.titre, COUNT(p.id) AS n
        FROM defis d JOIN participations p ON p.defi_id = d.id AND p.entrainement = 0
        WHERE d.module_code IS NOT NULL
        GROUP BY d.id HAVING n > 0
      `).all();
      const total = touches.reduce((s, d) => s + d.n, 0);

      if (total > 0 && !requete.body?.confirmerPerteResultats) {
        return reponse.code(409).send({
          erreur: `Le rechargement forcé réécrira ${touches.length} défi(s) déjà joué(s) et `
            + `effacera les réponses enregistrées de ${total} participation(s). Les scores `
            + 'resteraient, mais plus rien ne les expliquerait et un recalcul les remettrait à zéro.',
          defis: touches,
          participations: total,
          confirmationRequise: true,
          code: 'CONFIRMATION_REQUISE',
        });
      }
    }

    const rapport = importerContenus({ force });
    journaliser(requete.agent.login, force ? 'reimport_contenus_force' : 'reimport_contenus',
      JSON.stringify(rapport), requete.ip);
    return { ok: true, rapport };
  });

  /* --------------------------------------------------------------- Mails */
  app.get('/api/admin/mails/:type/:id', async (requete, reponse) => {
    const id = Number(requete.params.id);
    const type = requete.params.type;
    let m = null;
    if (type === 'lancement') m = mailLancement(id);
    else if (type === 'resultats') m = mailResultats(id);
    else if (type === 'relance') {
      // Un agent reel, et non le premier venu : « SELECT ... LIMIT 1 » tombait
      // volontiers sur le compte d'administration locale, dont le nom et la
      // direction ne ressemblent a rien de ce que les agents recevront.
      const exemple = db.prepare(
        "SELECT * FROM agents WHERE exclu = 0 AND origine <> 'local' ORDER BY id LIMIT 1"
      ).get() || { nom_complet: 'Prénom NOM', service: 'Direction exemple' };
      m = mailRelance(exemple, id);
    } else return reponse.code(400).send({ erreur: 'Type inconnu (lancement, relance, resultats).' });

    if (!m) return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    return m;
  });

  app.post('/api/admin/mails/relances/:id', async (requete) => {
    const id = Number(requete.params.id);
    const simulation = !!requete.body?.simulation;
    const res = await envoyerRelances(id, { simulation });
    if (!simulation) journaliser(requete.agent.login, 'relances_envoyees', `defi=${id} ${JSON.stringify(res)}`, requete.ip);
    return res;
  });

  app.post('/api/admin/mails/resultats/:id', async (requete) => {
    const id = Number(requete.params.id);
    const simulation = !!requete.body?.simulation;
    const res = await envoyerResultats(id, { simulation });
    if (!simulation) journaliser(requete.agent.login, 'resultats_envoyes', `defi=${id} ${JSON.stringify(res)}`, requete.ip);
    return res;
  });

  /* ------------------------------------------------------------- Exports */
  app.get('/api/admin/export/participations.csv', async (requete, reponse) => {
    const lignes = db.prepare(`
      SELECT a.login, a.nom_complet AS nom, a.service, a.email,
             d.ouvre_le, d.titre AS defi,
             p.score, p.score_max, p.bonnes, p.total_questions, p.duree_secondes, p.termine_le
      FROM participations p
      JOIN agents a ON a.id = p.agent_id
      JOIN defis d  ON d.id = p.defi_id
      WHERE p.entrainement = 0
      ORDER BY d.ouvre_le, d.id, a.service, a.nom_complet
    `).all();
    journaliser(requete.agent.login, 'export_participations', `${lignes.length} lignes`, requete.ip);
    return reponse.type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="cybermois-participations.csv"')
      .send(csv(lignes, ['login', 'nom', 'service', 'email', 'ouvre_le', 'defi', 'score', 'score_max', 'bonnes', 'total_questions', 'duree_secondes', 'termine_le']));
  });

  app.get('/api/admin/export/services.csv', async (requete, reponse) => {
    const lignes = classementServices();
    return reponse.type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="cybermois-services.csv"')
      .send(csv(lignes, ['service', 'inscrits', 'joueurs', 'taux_participation', 'defis_par_agent',
        'defis_parus', 'pourcentage_moyen', 'score_total', 'points_possibles', 'score_moyen', 'defis_joues']));
  });

  app.get('/api/admin/export/agents.csv', async (requete, reponse) => {
    const lignes = classementAgents(100000);
    return reponse.type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="cybermois-agents.csv"')
      .send(csv(lignes, ['nom_complet', 'service', 'defis_joues', 'defis_parus', 'score_total', 'bonnes_total']));
  });

  /** Preuve de participation exploitable en audit SSI */
  app.get('/api/admin/export/attestation.csv', async (requete, reponse) => {
    const lignes = db.prepare(`
      SELECT a.login, a.nom_complet AS nom, a.service,
             COUNT(p.id) AS defis_termines,
             (SELECT COUNT(*) FROM defis WHERE publie = 1) AS defis_publies,
             MIN(p.termine_le) AS premiere_participation,
             MAX(p.termine_le) AS derniere_participation,
             ROUND(SUM(p.score) * 100.0 / NULLIF(SUM(p.score_max), 0), 0) AS taux_reussite
      FROM agents a
      LEFT JOIN participations p ON p.agent_id = a.id AND p.entrainement = 0
      GROUP BY a.id ORDER BY a.service, a.nom_complet
    `).all();
    journaliser(requete.agent.login, 'export_attestation', `${lignes.length} agents`, requete.ip);
    return reponse.type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="cybermois-attestations.csv"')
      .send(csv(lignes, ['login', 'nom', 'service', 'defis_termines', 'defis_publies', 'taux_reussite', 'premiere_participation', 'derniere_participation']));
  });

  app.get('/api/admin/export/journal.csv', async (requete, reponse) => {
    const lignes = db.prepare('SELECT * FROM journal ORDER BY id DESC LIMIT 20000').all();
    return reponse.type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="cybermois-journal.csv"')
      .send(csv(lignes, ['horodatage', 'login', 'action', 'detail', 'ip']));
  });

  /* --------------------------------------------------------------- Divers */
  app.get('/api/admin/journal', async () => db.prepare('SELECT * FROM journal ORDER BY id DESC LIMIT 200').all());

  /**
   * Efface les resultats d'un seul agent.
   *
   * Pendant une recette on joue, on recommence, on fait jouer un collegue :
   * remettre toute la base a zero pour cela detruirait aussi les essais des
   * autres. Les comptes, les defis et le parametrage ne sont pas touches.
   */
  app.post('/api/admin/agents/:id/reinitialiser', async (requete, reponse) => {
    const id = Number(requete.params.id);
    const agent = db.prepare('SELECT id, login, nom_complet FROM agents WHERE id = ?').get(id);
    if (!agent) return reponse.code(404).send({ erreur: 'Agent introuvable.' });

    let efface = 0;
    db.exec('BEGIN');
    try {
      efface += db.prepare(`
        DELETE FROM reponses_agent
        WHERE participation_id IN (SELECT id FROM participations WHERE agent_id = ?)
      `).run(id).changes;
      for (const table of ['participations', 'tentatives', 'badges_agent']) {
        efface += db.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).run(id).changes;
      }
      // La date de premiere connexion aussi : sans elle, l'agent reste compte
      // parmi ceux qui « se sont connectes », et le taux de participation d'une
      // recette ne repart jamais de zero.
      efface += db.prepare('UPDATE agents SET vu_le = NULL WHERE id = ?').run(id).changes;
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      requete.log.error(err, 'remise a zero interrompue');
      return reponse.code(500).send({ erreur: 'Remise à zéro interrompue : rien n’a été modifié.', code: 'REINITIALISATION_ECHOUEE' });
    }

    journaliser(requete.agent.login, 'agent_reinitialise',
      `${agent.login} : ${efface} ligne(s) effacee(s)`, requete.ip);

    return {
      ok: true,
      efface,
      message: `Résultats de ${agent.nom_complet} effacés : participations, réponses, `
        + 'tentatives en cours et badges. Le compte est conservé et peut rejouer.',
    };
  });

  app.post('/api/admin/reinitialiser', async (requete, reponse) => {
    if (requete.body?.confirmation !== 'REINITIALISER') {
      return reponse.code(400).send({ erreur: 'Confirmation manquante. Envoyez { "confirmation": "REINITIALISER" }.' });
    }
    // Les tentatives manquaient : sans elles, un defi rejoue apres remise a
    // zero affichait ses questions comme deja repondues. Les dates de premiere
    // connexion aussi : les agents restaient sinon comptes parmi ceux qui « se
    // sont connectes », et le taux de participation ne repartait jamais de zero.
    // D'un bloc : une remise a zero interrompue au milieu laissait des badges
    // sans participation, ou des tentatives orphelines.
    let oublies = 0;
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM reponses_agent; DELETE FROM participations; '
        + 'DELETE FROM tentatives; DELETE FROM badges_agent; DELETE FROM envois;');
      oublies = db.prepare('UPDATE agents SET vu_le = NULL').run().changes;
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      requete.log.error(err, 'reinitialisation interrompue');
      return reponse.code(500).send({
        erreur: 'Remise à zéro interrompue : rien n’a été effacé.',
        code: 'REINITIALISATION_ECHOUEE',
      });
    }

    journaliser(requete.agent.login, 'reinitialisation',
      `participations, tentatives, badges effaces, ${oublies} date(s) de connexion oubliee(s)`,
      requete.ip);

    return {
      ok: true,
      message: "Participations, tentatives, badges et historique d'envois effacés. "
        + `${oublies} date(s) de première connexion remises à zéro : le taux de `
        + 'participation repart de zéro. Les comptes agents, les défis et le '
        + 'paramétrage sont conservés.',
    };
  });
}
