import { db, journaliser } from '../lib/db.js';
import { config } from '../lib/config.js';
import { exigerAdmin } from '../lib/session.js';
import { preparerImport } from '../lib/import-csv.js';
import {
  resoudreService, inventaireServices, lireRegroupements,
  enregistrerRegroupements, appliquerRegroupements,
} from '../lib/services.js';
import {
  analyserSynchronisation, appliquerSynchronisation,
  lireExclusions, enregistrerExclusions, MOTIFS_SUGGERES,
} from '../lib/synchronisation.js';

export default async function routesUtilisateurs(app) {
  app.addHook('preHandler', exigerAdmin);

  /* ------------------------------------------------------------ Liste */

  app.get('/api/admin/agents', async (requete) => {
    const recherche = String(requete.query?.recherche || '').trim().toLowerCase();
    const service = String(requete.query?.service || '').trim();
    const etat = String(requete.query?.etat || '').trim();

    const conditions = [];
    const valeurs = [];
    if (recherche) {
      conditions.push("(LOWER(a.login) LIKE ? OR LOWER(a.nom_complet) LIKE ? OR LOWER(COALESCE(a.email, '')) LIKE ?)");
      valeurs.push(`%${recherche}%`, `%${recherche}%`, `%${recherche}%`);
    }
    if (service) { conditions.push('a.service = ?'); valeurs.push(service); }
    if (etat === 'exclus') conditions.push('a.exclu = 1');
    if (etat === 'actifs') conditions.push('a.exclu = 0');
    if (etat === 'jamais_connecte') conditions.push('a.vu_le IS NULL AND a.exclu = 0');
    if (etat === 'sans_email') conditions.push("(a.email IS NULL OR a.email = '') AND a.exclu = 0");
    if (etat === 'inactifs') {
      conditions.push('a.exclu = 0 AND NOT EXISTS (SELECT 1 FROM participations p WHERE p.agent_id = a.id AND p.entrainement = 0)');
    }
    const ou = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const agents = db.prepare(`
      SELECT a.id, a.login, a.nom_complet, a.email, a.service, a.origine,
             a.est_admin, a.exclu, a.anonyme, a.note, a.cree_le, a.vu_le,
             COUNT(p.id)               AS defis_joues,
             COALESCE(SUM(p.score), 0) AS score_total
      FROM agents a
      LEFT JOIN participations p ON p.agent_id = a.id AND p.entrainement = 0
      ${ou}
      GROUP BY a.id
      ORDER BY a.service, a.nom_complet
      LIMIT 1000
    `).all(...valeurs);

    const services = db.prepare('SELECT service, COUNT(*) AS n FROM agents WHERE exclu = 0 GROUP BY service ORDER BY service').all();

    const resume = db.prepare(`
      SELECT
        COUNT(*)                                          AS total,
        SUM(CASE WHEN exclu = 1 THEN 1 ELSE 0 END)        AS exclus,
        SUM(CASE WHEN vu_le IS NULL AND exclu = 0 THEN 1 ELSE 0 END) AS jamais_connectes,
        SUM(CASE WHEN (email IS NULL OR email = '') AND exclu = 0 THEN 1 ELSE 0 END) AS sans_email,
        SUM(CASE WHEN origine = 'import' THEN 1 ELSE 0 END) AS importes,
        SUM(CASE WHEN anonyme = 1 THEN 1 ELSE 0 END)      AS anonymes
      FROM agents
    `).get();

    return { agents, services, resume, tronque: agents.length >= 1000 };
  });

  /* ------------------------------------------------------------ Creation */

  app.post('/api/admin/agents', async (requete, reponse) => {
    const c = requete.body || {};
    const login = String(c.login || '').trim().toLowerCase().replace(/^.*\\/, '');

    if (!login) return reponse.code(400).send({ erreur: "L'identifiant est obligatoire." });
    if (/[\s,;]/.test(login)) return reponse.code(400).send({ erreur: "L'identifiant ne peut pas contenir d'espace." });
    if (db.prepare('SELECT id FROM agents WHERE login = ?').get(login)) {
      return reponse.code(409).send({ erreur: `L'agent « ${login} » existe déjà.` });
    }

    const nomComplet = String(c.nom_complet || '').trim() || login;
    const service = String(c.service || '').replace(/\s+/g, ' ').trim() || 'Non rattache';
    const email = String(c.email || '').trim().toLowerCase() || null;

    db.prepare(`
      INSERT INTO agents (login, nom_complet, email, service, service_ad, origine, est_admin, note)
      VALUES (?, ?, ?, ?, ?, 'manuel', ?, ?)
    `).run(login, nomComplet, email, resoudreService(service), service,
           config.adminLogins.includes(login) ? 1 : 0, c.note || null);

    journaliser(requete.agent.login, 'agent_cree', `${login} (${service})`, requete.ip);
    return {
      ok: true,
      message: `Agent « ${nomComplet} » ajouté au service ${service}. `
        + "Il devra se connecter avec son compte Active Directory : l'ajout ici ne crée aucun compte.",
    };
  });

  /* ------------------------------------------------------------ Modification */

  app.patch('/api/admin/agents/:id', async (requete, reponse) => {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(Number(requete.params.id));
    if (!agent) return reponse.code(404).send({ erreur: 'Agent introuvable.' });

    const c = requete.body || {};
    const champs = [];
    const valeurs = [];

    if (c.nom_complet !== undefined) { champs.push('nom_complet = ?'); valeurs.push(String(c.nom_complet).trim() || agent.login); }
    if (c.email !== undefined) { champs.push('email = ?'); valeurs.push(String(c.email).trim().toLowerCase() || null); }
    if (c.service !== undefined) {
      // On force aussi le libelle d'origine : sans cela, un recalcul des
      // regroupements ecraserait la correction saisie a la main.
      const service = String(c.service).replace(/\s+/g, ' ').trim() || 'Non rattache';
      champs.push('service = ?'); valeurs.push(service);
      champs.push('service_ad = ?'); valeurs.push(service);
    }
    if (c.exclu !== undefined) { champs.push('exclu = ?'); valeurs.push(c.exclu ? 1 : 0); }
    if (c.anonyme !== undefined) { champs.push('anonyme = ?'); valeurs.push(c.anonyme ? 1 : 0); }
    if (c.note !== undefined) { champs.push('note = ?'); valeurs.push(String(c.note).trim() || null); }

    if (!champs.length) return reponse.code(400).send({ erreur: 'Aucune modification demandée.' });

    valeurs.push(agent.id);
    db.prepare(`UPDATE agents SET ${champs.join(', ')} WHERE id = ?`).run(...valeurs);

    journaliser(requete.agent.login, 'agent_modifie', `${agent.login} : ${champs.join(', ')}`, requete.ip);
    return { ok: true, message: `Agent « ${agent.login} » mis à jour.` };
  });

  /* ------------------------------------------------------------ Suppression */

  app.delete('/api/admin/agents/:id', async (requete, reponse) => {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(Number(requete.params.id));
    if (!agent) return reponse.code(404).send({ erreur: 'Agent introuvable.' });

    if (agent.login === requete.agent.login) {
      return reponse.code(400).send({ erreur: 'Vous ne pouvez pas supprimer votre propre compte.' });
    }

    const participations = db.prepare(
      'SELECT COUNT(*) AS n FROM participations WHERE agent_id = ?'
    ).get(agent.id).n;

    // Supprimer un agent qui a joue effacerait ses resultats et fausserait les
    // classements : on impose une confirmation explicite.
    if (participations > 0 && !requete.body?.confirmerPerteResultats) {
      return reponse.code(409).send({
        erreur: `« ${agent.nom_complet} » a terminé ${participations} défi(s). `
          + 'Le supprimer effacera définitivement ses résultats et modifiera le score de son service. '
          + "Préférez l'exclusion, qui conserve l'historique.",
        participations,
        confirmationRequise: true,
      });
    }

    db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id); // cascade sur participations et badges
    journaliser(requete.agent.login, 'agent_supprime', `${agent.login} (${participations} participation(s))`, requete.ip);

    return {
      ok: true,
      message: `Agent « ${agent.nom_complet} » supprimé.`
        + (participations ? ` ${participations} participation(s) effacée(s).` : '')
        + " S'il se reconnecte, sa fiche sera recréée automatiquement : utilisez l'exclusion pour l'écarter durablement.",
    };
  });

  /* ------------------------------------------------------ Actions groupees */

  app.post('/api/admin/agents/action-groupee', async (requete, reponse) => {
    const ids = Array.isArray(requete.body?.ids) ? requete.body.ids.map(Number).filter(Boolean) : [];
    const action = String(requete.body?.action || '');
    if (!ids.length) return reponse.code(400).send({ erreur: 'Aucun agent sélectionné.' });

    const marques = ids.map(() => '?').join(',');
    let message;

    if (action === 'exclure' || action === 'reintegrer') {
      const exclu = action === 'exclure' ? 1 : 0;
      // On ne s'exclut jamais soi-meme par megarde
      const res = db.prepare(`UPDATE agents SET exclu = ? WHERE id IN (${marques}) AND login <> ?`)
        .run(exclu, ...ids, requete.agent.login);
      message = `${res.changes} agent(s) ${exclu ? 'exclus de' : 'réintégrés dans'} la campagne.`;
    } else if (action === 'anonymiser' || action === 'nommer') {
      const anonyme = action === 'anonymiser' ? 1 : 0;
      const res = db.prepare(`UPDATE agents SET anonyme = ? WHERE id IN (${marques})`).run(anonyme, ...ids);
      message = `${res.changes} agent(s) ${anonyme ? 'masqués du' : 'réaffichés au'} classement individuel.`;
    } else if (action === 'supprimer') {
      const res = db.prepare(`DELETE FROM agents WHERE id IN (${marques}) AND login <> ?`).run(...ids, requete.agent.login);
      message = `${res.changes} agent(s) supprimés, ainsi que leurs résultats.`;
    } else {
      return reponse.code(400).send({ erreur: 'Action inconnue.' });
    }

    journaliser(requete.agent.login, 'agents_action_groupee', `${action} sur ${ids.length} agent(s)`, requete.ip);
    return { ok: true, message };
  });

  /* --------------------------------------------------------------- Import */

  /** Previsualisation : analyse le fichier sans rien ecrire en base. */
  app.post('/api/admin/agents/import/analyse', async (requete, reponse) => {
    const texte = String(requete.body?.contenu || '');
    if (!texte.trim()) return reponse.code(400).send({ erreur: 'Fichier vide.' });

    const resultat = preparerImport(texte, { ouDepth: config.service.ouDepth });
    if (!resultat.ok) return reponse.code(400).send(resultat);

    // Confrontation a l'existant, pour annoncer exactement ce qui va se passer
    const existants = new Map(
      db.prepare('SELECT login, id, service, nom_complet FROM agents').all().map((a) => [a.login, a])
    );

    let nouveaux = 0; let misAJour = 0; const changementsService = [];
    for (const a of resultat.agents) {
      const e = existants.get(a.login);
      if (!e) { nouveaux++; continue; }
      misAJour++;
      if (e.service !== a.service) changementsService.push({ login: a.login, avant: e.service, apres: a.service });
    }

    const absents = [...existants.values()].filter(
      (e) => !resultat.agents.some((a) => a.login === e.login)
    );

    return {
      ...resultat,
      // On n'expose qu'un echantillon : 500 agents en JSON alourdiraient l'affichage
      agents: resultat.agents.slice(0, 50),
      rejets: resultat.rejets.slice(0, 50),
      confrontation: {
        nouveaux,
        misAJour,
        changementsService: changementsService.slice(0, 30),
        nbChangementsService: changementsService.length,
        absents: absents.slice(0, 30).map((a) => ({ login: a.login, nom: a.nom_complet, service: a.service })),
        nbAbsents: absents.length,
      },
    };
  });

  /** Import effectif. */
  app.post('/api/admin/agents/import', async (requete, reponse) => {
    const texte = String(requete.body?.contenu || '');
    const exclureAbsents = !!requete.body?.exclureAbsents;
    if (!texte.trim()) return reponse.code(400).send({ erreur: 'Fichier vide.' });

    const resultat = preparerImport(texte, { ouDepth: config.service.ouDepth });
    if (!resultat.ok) return reponse.code(400).send(resultat);

    const inserer = db.prepare(`
      INSERT INTO agents (login, nom_complet, email, service, service_ad, service_brut, origine, est_admin)
      VALUES (?, ?, ?, ?, ?, ?, 'import', ?)
      ON CONFLICT(login) DO UPDATE SET
        nom_complet = excluded.nom_complet,
        email       = COALESCE(excluded.email, agents.email),
        service     = excluded.service,
        service_ad  = excluded.service_ad,
        -- Le DN n'est ecrase que si le fichier en fournit un
        service_brut= COALESCE(excluded.service_brut, agents.service_brut),
        est_admin   = excluded.est_admin,
        exclu       = 0
    `);

    let nouveaux = 0; let misAJour = 0;
    const existants = new Set(db.prepare('SELECT login FROM agents').all().map((a) => a.login));

    db.exec('BEGIN');
    try {
      for (const a of resultat.agents) {
        if (existants.has(a.login)) misAJour++; else nouveaux++;
        inserer.run(a.login, a.nomComplet, a.email, resoudreService(a.service), a.service, a.dn,
                    config.adminLogins.includes(a.login) ? 1 : 0);
      }

      let exclus = 0;
      if (exclureAbsents) {
        const logins = resultat.agents.map((a) => a.login);
        const marques = logins.map(() => '?').join(',');
        // On exclut plutot que de supprimer : les resultats deja acquis sont conserves
        const res = db.prepare(
          `UPDATE agents SET exclu = 1 WHERE login NOT IN (${marques}) AND login <> ?`
        ).run(...logins, requete.agent.login);
        exclus = res.changes;
      }

      db.exec('COMMIT');
      journaliser(
        requete.agent.login, 'agents_importes',
        `${nouveaux} nouveaux, ${misAJour} mis a jour, ${exclus} exclus`, requete.ip
      );

      return {
        ok: true,
        nouveaux, misAJour, exclus,
        rejetes: resultat.rejets.length,
        services: resultat.services.length,
        message: `Import terminé : ${nouveaux} agent(s) ajouté(s), ${misAJour} mis à jour`
          + (exclus ? `, ${exclus} exclu(s) car absent(s) du fichier` : '')
          + (resultat.rejets.length ? `, ${resultat.rejets.length} ligne(s) rejetée(s)` : '')
          + `. ${resultat.services.length} services identifiés.`,
      };
    } catch (err) {
      db.exec('ROLLBACK');
      return reponse.code(500).send({ erreur: `Import interrompu, aucune modification enregistrée : ${err.message}` });
    }
  });

  /* --------------------------------------- Synchronisation depuis l'annuaire */

  /** Analyse : ne touche a rien, c'est le sas de validation. */
  app.post('/api/admin/synchronisation/analyse', async (requete, reponse) => {
    const resultat = await analyserSynchronisation();
    if (!resultat.ok) return reponse.code(502).send({ erreur: resultat.message });
    return { ...resultat, motifsSuggeres: MOTIFS_SUGGERES };
  });

  /** Application : seuls les comptes explicitement retenus entrent. */
  app.post('/api/admin/synchronisation/appliquer', async (requete, reponse) => {
    const c = requete.body || {};
    const resultat = await appliquerSynchronisation({
      accepter: Array.isArray(c.accepter) ? c.accepter : [],
      appliquerModifications: c.appliquerModifications !== false,
      exclureDesactives: c.exclureDesactives !== false,
      exclureDisparus: !!c.exclureDisparus,
    }, requete.agent.login);

    if (!resultat.ok) return reponse.code(500).send({ erreur: resultat.message });
    return resultat;
  });

  app.get('/api/admin/synchronisation/exclusions', async () => ({
    exclusions: lireExclusions(),
    suggeres: MOTIFS_SUGGERES,
  }));

  app.put('/api/admin/synchronisation/exclusions', async (requete, reponse) => {
    const regles = Array.isArray(requete.body?.regles) ? requete.body.regles : null;
    if (!regles) return reponse.code(400).send({ erreur: 'Liste de règles attendue.' });
    try {
      const exclusions = enregistrerExclusions(regles, requete.agent.login);
      journaliser(requete.agent.login, 'exclusions_sync', `${exclusions.length} regle(s)`, requete.ip);
      return { ok: true, exclusions, message: `${exclusions.length} règle(s) d'exclusion enregistrée(s).` };
    } catch (err) {
      return reponse.code(500).send({ erreur: err.message });
    }
  });

  /* ------------------------------------------------ Regroupement des services */

  app.get('/api/admin/services', async () => ({
    inventaire: inventaireServices(),
    regles: lireRegroupements(),
  }));

  app.post('/api/admin/services/regroupements', async (requete, reponse) => {
    const regles = Array.isArray(requete.body?.regles) ? requete.body.regles : null;
    if (!regles) return reponse.code(400).send({ erreur: 'Liste de règles attendue.' });

    try {
      const touches = enregistrerRegroupements(regles);
      journaliser(requete.agent.login, 'regroupements_enregistres',
                  `${regles.length} regle(s), ${touches} agent(s) reaffectes`, requete.ip);
      return {
        ok: true,
        message: `${regles.length} regroupement(s) enregistré(s). ${touches} agent(s) réaffecté(s).`,
        touches,
      };
    } catch (err) {
      return reponse.code(500).send({ erreur: `Enregistrement impossible : ${err.message}` });
    }
  });

  app.post('/api/admin/services/reappliquer', async (requete) => {
    const touches = appliquerRegroupements();
    journaliser(requete.agent.login, 'regroupements_reappliques', `${touches} agent(s)`, requete.ip);
    return { ok: true, message: `${touches} agent(s) réaffecté(s).` };
  });

  /** Modele de fichier a remplir. */
  app.get('/api/admin/agents/modele.csv', async (requete, reponse) => {
    const lignes = [
      'login;nom_complet;email;service',
      's.leroy;Sophie LEROY;s.leroy@ville-chatillon.fr;Etat civil',
      'p.martin;Paul MARTIN;p.martin@ville-chatillon.fr;Etat civil',
      'f.lambert;Fatou LAMBERT;f.lambert@ville-chatillon.fr;Services techniques',
    ];
    return reponse.type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="modele-agents.csv"')
      .send('﻿' + lignes.join('\r\n'));
  });
}
