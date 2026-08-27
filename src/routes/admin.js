import { db, journaliser } from '../lib/db.js';
import { config } from '../lib/config.js';
import { exigerAdmin } from '../lib/session.js';
import { testerConnexion } from '../lib/ldap.js';
import { importerContenus, exporterDefi, dateOuverture } from '../lib/seed.js';
import { listerModules, lireModule, etatProgramme, enregistrerProgramme } from '../lib/modules.js';
import { versionApplication } from '../lib/version.js';
import { classementServices, classementAgents, statistiquesGlobales } from '../lib/scoring.js';
import {
  testerSmtp, envoyerRelances, envoyerResultats,
  mailLancement, mailRelance, mailResultats,
} from '../lib/mail.js';
import { creerJetonApercu, revoquerJetonApercu, lienApercu } from '../lib/apercu.js';

const csv = (lignes, entetes) => {
  const echapper = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [entetes.join(';'), ...lignes.map((l) => entetes.map((e) => echapper(l[e])).join(';'))].join('\r\n');
};

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
    const defis = db.prepare('SELECT semaine, titre, ouvre_le, publie FROM defis ORDER BY semaine').all();

    return { stats, services, jamaisJoue, derniersEnvois, defis, campagne: config.campagne };
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
   * Le catalogue des modules disponibles, et la semaine ou chacun est place.
   * Ecrire vingt questionnaires et n'en jouer que quatre suppose de pouvoir
   * choisir : c'est ce que cet ecran permet.
   */
  app.get('/api/admin/modules', async () => ({
    modules: listerModules(),
    programme: etatProgramme(),
    debut: config.campagne.debut,
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

    const bouts = [`${n} semaine(s) programmee(s)`];
    if (crees) bouts.push(`${crees} questionnaire(s) cree(s)`);
    if (majs) bouts.push(`${majs} mis a jour`);
    if (retires) bouts.push(`${retires} retire(s)`);
    return { message: `${bouts.join(', ')}.`, rapport };
  });

  app.get('/api/admin/defis', async () => db.prepare('SELECT * FROM defis ORDER BY semaine').all()
    // Le jeton lui-meme ne sort pas d'ici : il n'est rendu qu'a sa creation.
    .map(({ jeton_apercu: jeton, ...d }) => ({ ...d, apercuOuvert: !!jeton })));

  app.get('/api/admin/defis/:semaine', async (requete, reponse) => {
    const defi = exporterDefi(Number(requete.params.semaine));
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    return defi;
  });

  /** Creation d'un defi. Il arrive masque : on le publie une fois redige. */
  app.post('/api/admin/defis', async (requete, reponse) => {
    const c = requete.body || {};
    const titre = String(c.titre || '').trim();
    if (!titre) return reponse.code(400).send({ erreur: 'Le titre est obligatoire.' });

    // Numero libre le plus petit : on rebouche les trous laisses par une suppression
    const occupees = new Set(db.prepare('SELECT semaine FROM defis').all().map((d) => d.semaine));
    let semaine = Number(c.semaine) || 0;
    if (semaine) {
      if (occupees.has(semaine)) {
        return reponse.code(409).send({ erreur: `La semaine ${semaine} existe déjà.` });
      }
    } else {
      semaine = 1;
      while (occupees.has(semaine)) semaine++;
    }

    const res = db.prepare(`
      INSERT INTO defis (semaine, titre, accroche, intro, duree_minutes, ouvre_le, publie)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(
      semaine, titre,
      String(c.accroche || '').trim(),
      String(c.intro || '').trim(),
      Number(c.duree_minutes) || 7,
      c.ouvre_le || dateOuverture(semaine)
    );

    // Une question d'amorce, pour que l'editeur ne s'ouvre pas sur un ecran vide
    const q = db.prepare(
      'INSERT INTO questions (defi_id, ordre, enonce, contexte, multiple, points, explication) VALUES (?, 1, ?, NULL, 1, 10, ?)'
    ).run(res.lastInsertRowid, 'Nouvelle question — remplacez cet énoncé', '');
    const r = db.prepare('INSERT INTO reponses (question_id, ordre, libelle, correcte) VALUES (?, ?, ?, ?)');
    r.run(q.lastInsertRowid, 1, 'Première réponse (bonne)', 1);
    r.run(q.lastInsertRowid, 2, 'Deuxième réponse', 0);

    journaliser(requete.agent.login, 'defi_cree', `semaine=${semaine} titre=${titre}`, requete.ip);
    return {
      ok: true,
      semaine,
      message: `Défi « ${titre} » créé en semaine ${semaine}, pour l'instant masqué. `
        + 'Rédigez les questions, puis publiez-le.',
    };
  });

  /** Suppression d'un defi. Les participations partent avec : confirmation exigee. */
  app.delete('/api/admin/defis/:semaine', async (requete, reponse) => {
    const semaine = Number(requete.params.semaine);
    const defi = db.prepare('SELECT * FROM defis WHERE semaine = ?').get(semaine);
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });

    const participations = db.prepare(
      'SELECT COUNT(*) AS n FROM participations WHERE defi_id = ?'
    ).get(defi.id).n;

    if (participations > 0 && !requete.body?.confirmerPerteResultats) {
      return reponse.code(409).send({
        erreur: `« ${defi.titre} » a été joué ${participations} fois. Le supprimer effacera `
          + 'définitivement ces résultats et modifiera tous les classements. '
          + 'Préférez le masquer : il disparaît du portail sans perdre les scores.',
        participations,
        confirmationRequise: true,
      });
    }

    db.prepare('DELETE FROM defis WHERE id = ?').run(defi.id); // cascade questions et participations
    journaliser(requete.agent.login, 'defi_supprime', `semaine=${semaine} (${participations} participations)`, requete.ip);

    return {
      ok: true,
      message: `Défi « ${defi.titre} » supprimé.`
        + (participations ? ` ${participations} participation(s) effacée(s).` : '')
        + ' Attention : il sera recréé au prochain rechargement des contenus si un fichier '
        + `content/semaine-${semaine}.json existe encore.`,
    };
  });

  app.post('/api/admin/defis/:semaine', async (requete, reponse) => {
    const semaine = Number(requete.params.semaine);
    const defi = db.prepare('SELECT * FROM defis WHERE semaine = ?').get(semaine);
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });

    const corps = requete.body || {};
    const questions = corps.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      return reponse.code(400).send({ erreur: 'Au moins une question est requise.' });
    }
    for (const [i, q] of questions.entries()) {
      if (!q.enonce || !Array.isArray(q.reponses) || q.reponses.length < 2) {
        return reponse.code(400).send({ erreur: `Question ${i + 1} : énoncé et au moins deux réponses requis.` });
      }
      if (!q.reponses.some((r) => r.correcte)) {
        return reponse.code(400).send({ erreur: `Question ${i + 1} : au moins une bonne réponse doit être cochée.` });
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

    db.prepare(`UPDATE defis SET titre = ?, accroche = ?, intro = ?, duree_minutes = ?, ouvre_le = ?, publie = ?,
                  badge_code = ?, badge_libelle = ?, badge_emoji = ?, badge_description = ?,
                  video_url = ?, video_titre = ?,
                  maj_le = datetime('now') WHERE id = ?`)
      .run(
        corps.titre ?? defi.titre, corps.accroche ?? defi.accroche, corps.intro ?? defi.intro,
        Number(corps.duree_minutes) || defi.duree_minutes,
        corps.ouvre_le || defi.ouvre_le,
        corps.publie === undefined ? defi.publie : (corps.publie ? 1 : 0),
        corps.badge?.libelle ? codeBadge : defi.badge_code,
        corps.badge?.libelle ?? defi.badge_libelle,
        corps.badge?.emoji ?? defi.badge_emoji,
        corps.badge?.description ?? defi.badge_description,
        videoUrl, videoTitre,
        defi.id
      );

    db.prepare('DELETE FROM questions WHERE defi_id = ?').run(defi.id);
    const insQ = db.prepare('INSERT INTO questions (defi_id, ordre, enonce, contexte, multiple, points, explication) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insR = db.prepare('INSERT INTO reponses (question_id, ordre, libelle, correcte) VALUES (?, ?, ?, ?)');
    questions.forEach((q, i) => {
      const res = insQ.run(defi.id, i + 1, q.enonce, q.contexte || null, q.multiple ? 1 : 0, Number(q.points) || 10, q.explication || '');
      q.reponses.forEach((r, j) => insR.run(res.lastInsertRowid, j + 1, r.libelle, r.correcte ? 1 : 0));
    });

    journaliser(requete.agent.login, 'defi_modifie', `semaine=${semaine} questions=${questions.length}`, requete.ip);
    return { ok: true, message: `Semaine ${semaine} enregistrée (${questions.length} questions).` };
  });

  app.post('/api/admin/defis/:semaine/publication', async (requete, reponse) => {
    const semaine = Number(requete.params.semaine);
    const publie = requete.body?.publie ? 1 : 0;
    const res = db.prepare('UPDATE defis SET publie = ? WHERE semaine = ?').run(publie, semaine);
    if (res.changes === 0) return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    journaliser(requete.agent.login, 'defi_publication', `semaine=${semaine} publie=${publie}`, requete.ip);
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
  app.post('/api/admin/defis/:semaine/apercu', async (requete, reponse) => {
    const cree = creerJetonApercu(requete.params.semaine, requete.agent.login);
    if (!cree) return reponse.code(404).send({ erreur: 'Défi introuvable.' });

    return {
      ok: true,
      ...cree,
      lien: lienApercu(config.publicUrl, cree.semaine, cree.jeton),
      message: "Lien d'aperçu créé. Il ouvre ce défi avant sa date, et rien de ce qui "
        + "s'y joue n'entre au classement. Révoquez-le après vos essais.",
    };
  });

  app.delete('/api/admin/defis/:semaine/apercu', async (requete, reponse) => {
    if (!revoquerJetonApercu(requete.params.semaine, requete.agent.login)) {
      return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    }
    return { ok: true, message: "Lien d'aperçu révoqué : il ne fonctionne plus." };
  });

  app.post('/api/admin/reimporter', async (requete) => {
    const rapport = importerContenus({ force: !!requete.body?.force });
    journaliser(requete.agent.login, 'reimport_contenus', JSON.stringify(rapport), requete.ip);
    return { ok: true, rapport };
  });

  app.post('/api/admin/campagne', async (requete, reponse) => {
    const debut = String(requete.body?.debut || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(debut)) return reponse.code(400).send({ erreur: 'Date attendue au format AAAA-MM-JJ.' });
    config.campagne.debut = debut;

    // Replanifier veut dire remettre tout le calendrier au rythme hebdomadaire.
    // Les dates fixees a la main sont donc levees : les conserver ferait
    // reapparaitre les anciennes ouvertures au prochain import, et le bouton
    // paraitrait sans effet sur ces semaines-la.
    const forcees = db.prepare("SELECT COUNT(*) AS n FROM programme WHERE ouvre_le IS NOT NULL").get().n;
    db.prepare('UPDATE programme SET ouvre_le = NULL').run();

    for (const d of db.prepare('SELECT semaine FROM defis').all()) {
      db.prepare('UPDATE defis SET ouvre_le = ? WHERE semaine = ?').run(dateOuverture(d.semaine), d.semaine);
    }
    journaliser(requete.agent.login, 'campagne_replanifiee',
      `${debut}${forcees ? `, ${forcees} date(s) manuelle(s) levee(s)` : ''}`, requete.ip);

    return {
      ok: true,
      message: `Semaine 1 ouverte le ${debut}, semaines suivantes décalées de 7 jours.`
        + (forcees ? ` ${forcees} date(s) fixée(s) à la main ont été réalignées.` : ''),
    };
  });

  /* --------------------------------------------------------------- Mails */
  app.get('/api/admin/mails/:type/:semaine', async (requete, reponse) => {
    const semaine = Number(requete.params.semaine);
    const type = requete.params.type;
    let m = null;
    if (type === 'lancement') m = mailLancement(semaine);
    else if (type === 'resultats') m = mailResultats(semaine);
    else if (type === 'relance') {
      const exemple = db.prepare('SELECT * FROM agents LIMIT 1').get()
        || { nom_complet: 'Prénom NOM', service: 'Service exemple' };
      m = mailRelance(exemple, semaine);
    } else return reponse.code(400).send({ erreur: 'Type inconnu (lancement, relance, resultats).' });

    if (!m) return reponse.code(404).send({ erreur: 'Semaine introuvable.' });
    return m;
  });

  app.post('/api/admin/mails/relances/:semaine', async (requete) => {
    const semaine = Number(requete.params.semaine);
    const simulation = !!requete.body?.simulation;
    const res = await envoyerRelances(semaine, { simulation });
    if (!simulation) journaliser(requete.agent.login, 'relances_envoyees', `semaine=${semaine} ${JSON.stringify(res)}`, requete.ip);
    return res;
  });

  app.post('/api/admin/mails/resultats/:semaine', async (requete) => {
    const semaine = Number(requete.params.semaine);
    const simulation = !!requete.body?.simulation;
    const res = await envoyerResultats(semaine, { simulation });
    if (!simulation) journaliser(requete.agent.login, 'resultats_envoyes', `semaine=${semaine} ${JSON.stringify(res)}`, requete.ip);
    return res;
  });

  /* ------------------------------------------------------------- Exports */
  app.get('/api/admin/export/participations.csv', async (requete, reponse) => {
    const lignes = db.prepare(`
      SELECT a.login, a.nom_complet AS nom, a.service, a.email,
             d.semaine, d.titre AS defi,
             p.score, p.score_max, p.bonnes, p.total_questions, p.duree_secondes, p.termine_le
      FROM participations p
      JOIN agents a ON a.id = p.agent_id
      JOIN defis d  ON d.id = p.defi_id
      WHERE p.entrainement = 0
      ORDER BY d.semaine, a.service, a.nom_complet
    `).all();
    journaliser(requete.agent.login, 'export_participations', `${lignes.length} lignes`, requete.ip);
    return reponse.type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="cybermois-participations.csv"')
      .send(csv(lignes, ['login', 'nom', 'service', 'email', 'semaine', 'defi', 'score', 'score_max', 'bonnes', 'total_questions', 'duree_secondes', 'termine_le']));
  });

  app.get('/api/admin/export/services.csv', async (requete, reponse) => {
    const lignes = classementServices();
    return reponse.type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="cybermois-services.csv"')
      .send(csv(lignes, ['service', 'inscrits', 'joueurs', 'taux_participation', 'score_moyen', 'score_total', 'defis_joues']));
  });

  app.get('/api/admin/export/agents.csv', async (requete, reponse) => {
    const lignes = classementAgents(100000);
    return reponse.type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="cybermois-agents.csv"')
      .send(csv(lignes, ['nom_complet', 'service', 'score_total', 'defis_joues', 'bonnes_total']));
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
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      return reponse.code(500).send({ erreur: `Remise à zéro interrompue : ${err.message}` });
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
    // zero affichait ses questions comme deja repondues.
    db.exec('DELETE FROM reponses_agent; DELETE FROM participations; '
      + 'DELETE FROM tentatives; DELETE FROM badges_agent; DELETE FROM envois;');
    journaliser(requete.agent.login, 'reinitialisation',
      'participations, tentatives et badges effaces', requete.ip);
    return {
      ok: true,
      message: "Participations, tentatives, badges et historique d'envois effacés. "
        + 'Les comptes agents, les défis et le paramétrage sont conservés.',
    };
  });
}
