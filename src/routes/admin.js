import { db, journaliser } from '../lib/db.js';
import { config } from '../lib/config.js';
import { exigerAdmin } from '../lib/session.js';
import { testerConnexion } from '../lib/ldap.js';
import { importerContenus, exporterDefi, dateOuverture } from '../lib/seed.js';
import { classementServices, classementAgents, statistiquesGlobales } from '../lib/scoring.js';
import {
  testerSmtp, envoyerRelances, envoyerResultats,
  mailLancement, mailRelance, mailResultats,
} from '../lib/mail.js';

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
  app.get('/api/admin/defis', async () => db.prepare('SELECT * FROM defis ORDER BY semaine').all());

  app.get('/api/admin/defis/:semaine', async (requete, reponse) => {
    const defi = exporterDefi(Number(requete.params.semaine));
    if (!defi) return reponse.code(404).send({ erreur: 'Défi introuvable.' });
    return defi;
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

    db.prepare(`UPDATE defis SET titre = ?, accroche = ?, intro = ?, duree_minutes = ?, ouvre_le = ?, publie = ?, maj_le = datetime('now') WHERE id = ?`)
      .run(
        corps.titre ?? defi.titre, corps.accroche ?? defi.accroche, corps.intro ?? defi.intro,
        Number(corps.duree_minutes) || defi.duree_minutes,
        corps.ouvre_le || defi.ouvre_le,
        corps.publie === undefined ? defi.publie : (corps.publie ? 1 : 0),
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

  app.post('/api/admin/reimporter', async (requete) => {
    const rapport = importerContenus({ force: !!requete.body?.force });
    journaliser(requete.agent.login, 'reimport_contenus', JSON.stringify(rapport), requete.ip);
    return { ok: true, rapport };
  });

  app.post('/api/admin/campagne', async (requete, reponse) => {
    const debut = String(requete.body?.debut || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(debut)) return reponse.code(400).send({ erreur: 'Date attendue au format AAAA-MM-JJ.' });
    config.campagne.debut = debut;
    for (const d of db.prepare('SELECT semaine FROM defis').all()) {
      db.prepare('UPDATE defis SET ouvre_le = ? WHERE semaine = ?').run(dateOuverture(d.semaine), d.semaine);
    }
    journaliser(requete.agent.login, 'campagne_replanifiee', debut, requete.ip);
    return { ok: true, message: `Semaine 1 ouverte le ${debut}, semaines suivantes décalées de 7 jours.` };
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

  app.post('/api/admin/reinitialiser', async (requete, reponse) => {
    if (requete.body?.confirmation !== 'REINITIALISER') {
      return reponse.code(400).send({ erreur: 'Confirmation manquante. Envoyez { "confirmation": "REINITIALISER" }.' });
    }
    db.exec('DELETE FROM reponses_agent; DELETE FROM participations; DELETE FROM badges_agent; DELETE FROM envois;');
    journaliser(requete.agent.login, 'reinitialisation', 'participations et badges effaces', requete.ip);
    return { ok: true, message: 'Participations, badges et historique d\'envois effacés. Les comptes agents et les défis sont conservés.' };
  });
}
