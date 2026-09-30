import { db, journaliser, SERVICE_NON_RATTACHE } from '../lib/db.js';
import { config } from '../lib/config.js';
import { exigerAdmin, detruireSessionsAgent, detruireSessionsAgents } from '../lib/session.js';
import { preparerImport } from '../lib/import-csv.js';
import {
  resoudreService, inventaireServices, lireRegroupements,
  enregistrerRegroupements, appliquerRegroupements, resumeRegroupements,
  chaineOu, cleComparaison, normaliser,
} from '../lib/services.js';
import {
  analyserSynchronisation, appliquerSynchronisation,
  lireExclusions, enregistrerExclusions, MOTIFS_SUGGERES,
} from '../lib/synchronisation.js';
import {
  etatReferentiel, enregistrerReferentiel, initialiserDepuisDonnees,
  analyserCollage, appliquerReferentiel, nomsReferentiel,
} from '../lib/referentiel.js';
import { rapprocher } from '../lib/rapprochement.js';

export default async function routesUtilisateurs(app) {
  app.addHook('preHandler', exigerAdmin);

  /* ------------------------------------------------------------ Liste */

  app.get('/api/admin/agents', async (requete) => {
    const recherche = String(requete.query?.recherche || '').trim().toLowerCase();
    const service = String(requete.query?.service || '').trim();
    const etat = String(requete.query?.etat || '').trim();

    // Un agent rattache a un service absent du referentiel apparait au
    // classement sous un nom que la collectivite ne reconnait pas - et depuis
    // que le classement se limite au referentiel, il n'y apparait plus du tout.
    // Referentiel vide : tout serait signale « hors referentiel », ce qui
    // n'apprendrait rien. On se tait tant qu'il n'y a pas de liste de reference.
    const clesReferentiel = new Set(nomsReferentiel().map(cleComparaison));
    const referenceOuNon = (nom) => !clesReferentiel.size || clesReferentiel.has(cleComparaison(nom));

    // La comparaison tolere la casse, les accents et le pluriel : elle ne peut
    // pas s'ecrire en SQL. On dresse donc la liste des directions concernees,
    // puis on filtre dessus.
    const directionsHors = clesReferentiel.size
      ? db.prepare('SELECT DISTINCT service FROM agents').all()
          .map((s) => s.service).filter((s) => !referenceOuNon(s))
      : [];

    const conditions = [];
    const valeurs = [];
    if (recherche) {
      conditions.push("(LOWER(a.login) LIKE ? OR LOWER(a.nom_complet) LIKE ? OR LOWER(COALESCE(a.email, '')) LIKE ?)");
      valeurs.push(`%${recherche}%`, `%${recherche}%`, `%${recherche}%`);
    }
    if (service) { conditions.push('a.service = ?'); valeurs.push(service); }
    // Le libelle brut de l'annuaire, et non le service resolu : l'ecran de
    // regroupement raisonne sur ce qui arrive de l'AD, pas sur le resultat.
    const libelle = String(requete.query?.libelle || '').trim();
    if (libelle) {
      conditions.push("COALESCE(NULLIF(a.service_ad, ''), a.service) = ?");
      valeurs.push(libelle);
    }
    if (etat === 'exclus') conditions.push('a.exclu = 1');
    if (etat === 'actifs') conditions.push('a.exclu = 0');
    if (etat === 'jamais_connecte') conditions.push('a.vu_le IS NULL AND a.exclu = 0');
    if (etat === 'sans_email') conditions.push("(a.email IS NULL OR a.email = '') AND a.exclu = 0");
    if (etat === 'inactifs') {
      conditions.push('a.exclu = 0 AND NOT EXISTS (SELECT 1 FROM participations p WHERE p.agent_id = a.id AND p.entrainement = 0)');
    }
    if (etat === 'connectes') conditions.push('a.vu_le IS NOT NULL AND a.exclu = 0');
    if (etat === 'joueurs') {
      conditions.push('a.exclu = 0 AND EXISTS (SELECT 1 FROM participations p WHERE p.agent_id = a.id AND p.entrainement = 0)');
    }
    if (etat === 'annuaire') conditions.push("a.origine IN ('import', 'annuaire') AND a.exclu = 0");
    if (etat === 'anonymes') conditions.push('a.anonyme = 1');
    if (etat === 'hors_referentiel') {
      // Aucune direction concernee : la liste doit etre vide, pas complete.
      if (!directionsHors.length) conditions.push('1 = 0');
      else {
        conditions.push(`a.exclu = 0 AND a.service IN (${directionsHors.map(() => '?').join(', ')})`);
        valeurs.push(...directionsHors);
      }
    }
    const ou = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Pagination : a 600 agents, tout envoyer alourdit la page pour rien.
    const parPage = Math.min(200, Math.max(10, Number(requete.query?.parPage) || 50));
    const page = Math.max(1, Number(requete.query?.page) || 1);

    const total = db.prepare(`SELECT COUNT(*) AS n FROM agents a ${ou}`).get(...valeurs).n;
    const pages = Math.max(1, Math.ceil(total / parPage));
    const pageCourante = Math.min(page, pages);

    const agents = db.prepare(`
      SELECT a.id, a.login, a.nom_complet, a.email, a.service, a.service_ad, a.origine,
             -- Dit d'ou vient la direction affichee : de l'annuaire, ou d'une
             -- decision prise dans le back-office que la synchronisation respecte.
             a.service_force,
             a.est_admin, a.exclu, a.anonyme, a.note, a.cree_le, a.vu_le,
             COUNT(p.id)               AS defis_joues,
             COALESCE(SUM(p.score), 0) AS score_total
      FROM agents a
      LEFT JOIN participations p ON p.agent_id = a.id AND p.entrainement = 0
      ${ou}
      GROUP BY a.id
      ORDER BY a.service, a.nom_complet
      LIMIT ? OFFSET ?
    `).all(...valeurs, parPage, (pageCourante - 1) * parPage);

    const services = db.prepare('SELECT service, COUNT(*) AS n FROM agents WHERE exclu = 0 GROUP BY service ORDER BY service').all();

    const horsReferentiel = clesReferentiel.size
      ? db.prepare(`
          SELECT service, COUNT(*) AS n FROM agents
          WHERE exclu = 0 AND origine <> 'local'
          GROUP BY service ORDER BY n DESC
        `).all().filter((s) => !referenceOuNon(s.service))
      : [];

    const resume = db.prepare(`
      SELECT
        COUNT(*)                                          AS total,
        SUM(CASE WHEN exclu = 1 THEN 1 ELSE 0 END)        AS exclus,
        SUM(CASE WHEN vu_le IS NULL AND exclu = 0 THEN 1 ELSE 0 END) AS jamais_connectes,
        SUM(CASE WHEN (email IS NULL OR email = '') AND exclu = 0 THEN 1 ELSE 0 END) AS sans_email,
        -- « import » vient du CSV, « annuaire » de la synchronisation :
        -- les deux alimentent l'effectif, les separer n'aurait aucun sens ici.
        SUM(CASE WHEN origine IN ('import', 'annuaire') AND exclu = 0 THEN 1 ELSE 0 END) AS importes,
        SUM(CASE WHEN vu_le IS NOT NULL AND exclu = 0 THEN 1 ELSE 0 END) AS connectes,
        SUM(CASE WHEN anonyme = 1 THEN 1 ELSE 0 END)      AS anonymes
      FROM agents
    `).get();

    // Compte les agents que le classement collectif laissera de cote. Il
    // alimente une tuile cliquable : voir le nombre sans pouvoir ouvrir la
    // liste obligeait a filtrer direction par direction.
    resume.hors_referentiel = directionsHors.length
      ? db.prepare(`
          SELECT COUNT(*) AS n FROM agents
          WHERE exclu = 0 AND service IN (${directionsHors.map(() => '?').join(', ')})
        `).get(...directionsHors).n
      : 0;

    return {
      // Chaque ligne dit si son service figure au referentiel : c'est ce qui
      // se verra au classement, et l'ecart se corrige mieux avant l'ouverture.
      agents: agents.map((a) => ({ ...a, serviceReference: referenceOuNon(a.service) })),
      services,
      resume,
      horsReferentiel,
      pagination: { page: pageCourante, pages, parPage, total },
    };
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
    const service = String(c.service || '').replace(/\s+/g, ' ').trim() || SERVICE_NON_RATTACHE;
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
      const service = String(c.service).replace(/\s+/g, ' ').trim() || SERVICE_NON_RATTACHE;
      if (service !== agent.service) {
        champs.push('service = ?'); valeurs.push(service);
        champs.push('service_ad = ?'); valeurs.push(service);
        // Une direction choisie a la main est une decision : la synchronisation
        // avec l'annuaire ne doit pas la defaire a la connexion suivante.
        champs.push('service_force = 1');
      }
    }
    if (c.exclu !== undefined) {
      champs.push('exclu = ?'); valeurs.push(c.exclu ? 1 : 0);
      // Une exclusion decidee ici resiste aux synchronisations suivantes
      champs.push('exclu_motif = ?'); valeurs.push(c.exclu ? 'manuel' : null);
    }
    if (c.anonyme !== undefined) { champs.push('anonyme = ?'); valeurs.push(c.anonyme ? 1 : 0); }
    if (c.note !== undefined) { champs.push('note = ?'); valeurs.push(String(c.note).trim() || null); }

    if (!champs.length) return reponse.code(400).send({ erreur: 'Aucune modification demandée.' });

    valeurs.push(agent.id);
    db.prepare(`UPDATE agents SET ${champs.join(', ')} WHERE id = ?`).run(...valeurs);

    // Exclure quelqu'un doit prendre effet a l'instant ou on le decide : la
    // fiche seule ne suffisait pas, l'agent deja connecte continuait de jouer
    // jusqu'a l'expiration de son cookie, huit heures plus tard.
    const coupees = c.exclu ? detruireSessionsAgent(agent.id) : 0;

    journaliser(requete.agent.login, 'agent_modifie', `${agent.login} : ${champs.join(', ')}`, requete.ip);
    return {
      ok: true,
      message: `Agent « ${agent.login} » mis à jour.`
        + (coupees ? ` ${coupees} session(s) en cours interrompue(s).` : ''),
    };
  });

  /* ------------------------------------------------------------ Suppression */

  app.delete('/api/admin/agents/:id', async (requete, reponse) => {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(Number(requete.params.id));
    if (!agent) return reponse.code(404).send({ erreur: 'Agent introuvable.' });

    if (agent.login === requete.agent.login) {
      return reponse.code(400).send({ erreur: 'Vous ne pouvez pas supprimer votre propre compte.' });
    }

    // Un compte local se supprime depuis la configuration, qui refuse d'effacer
    // le dernier : sans cette garde, on perdait ici le seul moyen de reprendre
    // la main quand l'annuaire devient injoignable.
    if (agent.origine === 'local') {
      return reponse.code(409).send({
        erreur: `« ${agent.login} » est un compte d'administration locale. Il se supprime depuis `
          + 'Administration > Configuration, qui vérifie qu’il en reste au moins un.',
        code: 'COMPTE_LOCAL',
      });
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
        // Un code, et non le libelle : l'ecran detectait ce refus par une
        // expression reguliere sur le texte du message, que la moindre
        // reformulation cassait.
        code: 'CONFIRMATION_REQUISE',
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
      // On ne s'exclut jamais soi-meme par megarde. Les comptes locaux non
      // plus : ils sont « exclus » par construction, et les reintegrer les
      // ferait entrer dans les effectifs et le taux de participation.
      const res = db.prepare(`
        UPDATE agents SET exclu = ?, exclu_motif = ?
        WHERE id IN (${marques}) AND login <> ? AND origine <> 'local'
      `).run(exclu, exclu ? 'manuel' : null, ...ids, requete.agent.login);
      // L'exclusion prend effet tout de suite : sans cela l'agent continuait
      // de jouer jusqu'a l'expiration de son cookie, huit heures plus tard.
      const coupees = exclu ? detruireSessionsAgents(ids) : 0;
      message = `${res.changes} agent(s) ${exclu ? 'exclus de' : 'réintégrés dans'} la campagne.`
        + (coupees ? ` ${coupees} session(s) en cours interrompue(s).` : '');
    } else if (action === 'anonymiser' || action === 'nommer') {
      const anonyme = action === 'anonymiser' ? 1 : 0;
      const res = db.prepare(`UPDATE agents SET anonyme = ? WHERE id IN (${marques})`).run(anonyme, ...ids);
      message = `${res.changes} agent(s) ${anonyme ? 'masqués du' : 'réaffichés au'} classement individuel.`;
    } else if (action === 'supprimer') {
      /**
       * La suppression groupee contournait deux garde-fous que la suppression
       * unitaire impose : la confirmation quand des resultats existent, et la
       * protection des comptes locaux. On pouvait donc effacer d'un clic les
       * resultats de la campagne, et le dernier compte permettant de reprendre
       * la main si l'annuaire devenait injoignable.
       */
      const locaux = db.prepare(
        `SELECT COUNT(*) AS n FROM agents WHERE id IN (${marques}) AND origine = 'local'`
      ).get(...ids).n;

      const avecResultats = db.prepare(`
        SELECT COUNT(DISTINCT p.agent_id) AS n FROM participations p
        WHERE p.agent_id IN (${marques}) AND p.entrainement = 0
      `).get(...ids).n;

      if (avecResultats > 0 && !requete.body?.confirmerPerteResultats) {
        return reponse.code(409).send({
          erreur: `${avecResultats} des agents sélectionnés ont des résultats enregistrés. `
            + 'Les supprimer effacera définitivement ces résultats et modifiera les classements. '
            + "Préférez l'exclusion, qui conserve l'historique.",
          agentsAvecResultats: avecResultats,
          confirmationRequise: true,
          code: 'CONFIRMATION_REQUISE',
        });
      }

      const res = db.prepare(
        `DELETE FROM agents WHERE id IN (${marques}) AND login <> ? AND origine <> 'local'`
      ).run(...ids, requete.agent.login);
      message = `${res.changes} agent(s) supprimés, ainsi que leurs résultats.`
        + (locaux ? ` ${locaux} compte(s) local(aux) ignoré(s) : ils se gèrent depuis la configuration.` : '');
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

    // Meme regle que la synchronisation : sans adresse, l'agent ne recevrait
    // ni lancement ni relance et fausserait le taux de son service.
    const sansAdresse = config.sync.exigerEmail ? resultat.agents.filter((a) => !a.email) : [];
    if (config.sync.exigerEmail) resultat.agents = resultat.agents.filter((a) => a.email);

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
      exigerEmail: config.sync.exigerEmail,
      sansAdresse: sansAdresse.slice(0, 100),
      nbSansAdresse: sansAdresse.length,
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

    const nbSansAdresse = config.sync.exigerEmail
      ? resultat.agents.filter((a) => !a.email).length : 0;
    if (config.sync.exigerEmail) resultat.agents = resultat.agents.filter((a) => a.email);

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
        nbSansAdresse,
        message: `Import terminé : ${nouveaux} agent(s) ajouté(s), ${misAJour} mis à jour`
          + (exclus ? `, ${exclus} exclu(s) car absent(s) du fichier` : '')
          + (nbSansAdresse ? `, ${nbSansAdresse} écarté(s) faute d'adresse mail` : '')
          + (resultat.rejets.length ? `, ${resultat.rejets.length} ligne(s) rejetée(s)` : '')
          + `. ${resultat.services.length} services identifiés.`,
      };
    } catch (err) {
      db.exec('ROLLBACK');
      requete.log.error(err, 'import interrompu');
      return reponse.code(500).send({ erreur: 'Import interrompu : aucune modification n’a été enregistrée.', code: 'IMPORT_ECHOUE' });
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
      supprimerDisparus: !!c.supprimerDisparus,
      disparusChoisis: Array.isArray(c.disparusChoisis) ? c.disparusChoisis : null,
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
      requete.log.error(err, 'operation interrompue');
      return reponse.code(500).send({ erreur: 'Opération interrompue : rien n’a été modifié.', code: 'OPERATION_ECHOUEE' });
    }
  });

  /* ------------------------------------------- Referentiel des services */

  app.get('/api/admin/referentiel', async () => etatReferentiel());

  app.put('/api/admin/referentiel', async (requete, reponse) => {
    const noms = Array.isArray(requete.body?.services) ? requete.body.services : null;
    if (!noms) return reponse.code(400).send({ erreur: 'Liste de services attendue.' });
    try {
      const n = enregistrerReferentiel(noms, requete.agent.login);
      return { ok: true, total: n, message: `Référentiel enregistré : ${n} service(s).` };
    } catch (err) {
      requete.log.error(err, 'operation interrompue');
      return reponse.code(500).send({ erreur: 'Opération interrompue : rien n’a été modifié.', code: 'OPERATION_ECHOUEE' });
    }
  });

  /** Collage en masse : une ligne par service, ou une liste separee. */
  app.post('/api/admin/referentiel/coller', async (requete, reponse) => {
    const noms = analyserCollage(requete.body?.texte);
    if (!noms.length) return reponse.code(400).send({ erreur: 'Aucun service reconnu dans le texte collé.' });

    const remplacer = !!requete.body?.remplacer;
    const existants = remplacer ? [] : nomsReferentiel();
    try {
      const n = enregistrerReferentiel([...existants, ...noms], requete.agent.login);
      return {
        ok: true, total: n, reconnus: noms.length,
        message: `${noms.length} service(s) reconnu(s) dans le texte. Référentiel : ${n} service(s).`,
      };
    } catch (err) {
      requete.log.error(err, 'operation interrompue');
      return reponse.code(500).send({ erreur: 'Opération interrompue : rien n’a été modifié.', code: 'OPERATION_ECHOUEE' });
    }
  });

  /** Amorce le referentiel avec les services deja presents dans les donnees. */
  app.post('/api/admin/referentiel/initialiser', async (requete) => {
    const r = initialiserDepuisDonnees(requete.agent.login);
    return {
      ok: true, ...r,
      message: `${r.ajoutes} service(s) ajouté(s) depuis les données. Référentiel : ${r.total} service(s).`,
    };
  });

  /**
   * Propose un service du referentiel pour chaque libellé d'annuaire.
   * N'ecrit rien : c'est une aide a la decision, pas une decision.
   */
  app.get('/api/admin/referentiel/suggestions', async () => {
    const referentiel = nomsReferentiel();
    if (!referentiel.length) {
      return { referentiel: [], suggestions: [], message: 'Le référentiel est vide.' };
    }

    const libelles = db.prepare(`
      SELECT COALESCE(NULLIF(service_ad, ''), service) AS libelle, COUNT(*) AS effectif
      FROM agents
      WHERE exclu = 0 AND origine <> 'local' AND service_force = 0
      GROUP BY libelle
      ORDER BY effectif DESC
    `).all();

    const suggestions = rapprocher(libelles, referentiel);
    const parConfiance = (c) => suggestions.filter((s) => s.confiance === c);

    return {
      referentiel,
      suggestions,
      resume: {
        libelles: suggestions.length,
        sure: parConfiance('sure').length,
        probable: parConfiance('probable').length,
        incertaine: parConfiance('incertaine').length,
        aucune: parConfiance('aucune').length,
        agentsSurs: parConfiance('sure').reduce((n, s) => n + s.effectif, 0),
      },
    };
  });

  /** Rattache automatiquement les libellés d'annuaire aux services du référentiel. */
  app.post('/api/admin/referentiel/appliquer', async (requete, reponse) => {
    try {
      const r = appliquerReferentiel(requete.agent.login);
      return {
        ok: true, ...r,
        message: r.regles
          ? `${r.regles} libellé(s) rattaché(s) au référentiel, ${r.touches} agent(s) déplacé(s).`
          : 'Aucun rapprochement possible : les libellés ne correspondent à aucun service du référentiel.',
      };
    } catch (err) {
      requete.log.error(err, 'operation interrompue');
      return reponse.code(500).send({ erreur: 'Opération interrompue : rien n’a été modifié.', code: 'OPERATION_ECHOUEE' });
    }
  });

  /* ------------------------------------------- Agents sans service attribue */

  /**
   * Les agents dont l'attribut « department » est vide tombent dans
   * « Non rattaché ». Leur DN porte pourtant presque toujours l'information :
   * on la propose, en la rapprochant d'un service deja existant quand la
   * graphie differe.
   */
  app.get('/api/admin/agents/non-rattaches', async () => {
    const agents = db.prepare(`
      SELECT id, login, nom_complet, email, service_brut, vu_le
      FROM agents
      WHERE service = ? AND exclu = 0 AND origine <> 'local'
      ORDER BY nom_complet
    `).all(SERVICE_NON_RATTACHE);

    const existants = db.prepare(`
      SELECT service, COUNT(*) AS n FROM agents
      WHERE exclu = 0 AND service <> ?
      GROUP BY service ORDER BY service COLLATE NOCASE
    `).all(SERVICE_NON_RATTACHE);

    // Rapprochement souple : « LUDO-MEDIATHEQUE » dans le DN doit retomber sur
    // « Ludo-Médiathèque » si ce service existe deja.
    const parCle = new Map(existants.map((e) => [cleComparaison(e.service), e.service]));

    const groupes = new Map();
    for (const a of agents) {
      const ous = chaineOu(a.service_brut);
      const indice = ous[0] || null;
      const cle = indice ? cleComparaison(indice) : '';
      const proposition = indice ? (parCle.get(cle) || indice) : null;
      const groupe = proposition || '(aucun indice)';

      if (!groupes.has(groupe)) {
        groupes.set(groupe, {
          proposition, existe: !!(indice && parCle.get(cle)),
          indiceOu: indice, agents: [],
        });
      }
      groupes.get(groupe).agents.push({
        id: a.id, login: a.login, nomComplet: a.nom_complet,
        email: a.email, chaineOu: ous, connecte: !!a.vu_le,
      });
    }

    return {
      total: agents.length,
      services: existants,
      groupes: [...groupes.values()].sort((x, y) => y.agents.length - x.agents.length),
    };
  });

  /**
   * Export des agents sans service, avec le service deduit de leur emplacement.
   * Sert a corriger l'annuaire lui-meme plutot qu'a le contourner : un
   * « department » renseigne profite a toutes les applications, pas seulement
   * a celle-ci.
   */
  app.get('/api/admin/agents/non-rattaches.csv', async (requete, reponse) => {
    const agents = db.prepare(`
      SELECT login, nom_complet, email, service_brut
      FROM agents
      WHERE service = ? AND exclu = 0 AND origine <> 'local'
      ORDER BY nom_complet
    `).all(SERVICE_NON_RATTACHE);

    const existants = db.prepare(`
      SELECT DISTINCT service FROM agents WHERE exclu = 0 AND service <> ?
    `).all(SERVICE_NON_RATTACHE).map((s) => s.service);
    const parCle = new Map(existants.map((e) => [cleComparaison(e), e]));

    // Echappement CSV sans expression reguliere : une classe de caracteres
    // contenant un saut de ligne se prete mal aux modifications automatisees.
    const echapper = (v) => {
      const t = v === null || v === undefined ? '' : String(v);
      const aProteger = t.includes('"') || t.includes(';') || t.includes(String.fromCharCode(10));
      return aProteger ? '"' + t.split('"').join('""') + '"' : t;
    };

    const lignes = agents.map((a) => {
      const ous = chaineOu(a.service_brut);
      const indice = ous[0] || '';
      // Les regroupements decides dans l'application valent pour l'annuaire :
      // si « Caramel » a ete rattache a « Petite Enfance » ici, c'est cela
      // qu'il faut ecrire dans la fiche, pas le nom de la creche.
      const regroupe = resoudreService(indice);
      const propose = regroupe !== indice
        ? regroupe
        : parCle.get(cleComparaison(indice)) || indice;
      return [a.login, a.nom_complet, a.email || '', indice, propose, ous.join(' < ')]
        .map(echapper).join(';');
    });

    const entetes = 'SamAccountName;Nom;Adresse;OU;DepartementPropose;Arborescence';

    journaliser(requete.agent.login, 'export_non_rattaches', `${agents.length} agents`, requete.ip);
    const RETOUR = String.fromCharCode(13, 10);
    return reponse.type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="cybermois-a-corriger-dans-ad.csv"')
      .send('﻿' + [entetes, ...lignes].join(RETOUR));
  });

  /** Rattachement, definitif : l'annuaire ne l'ecrasera plus. */
  app.post('/api/admin/agents/rattachement', async (requete, reponse) => {
    const affectations = Array.isArray(requete.body?.affectations) ? requete.body.affectations : [];
    const exclusions = Array.isArray(requete.body?.exclusions) ? requete.body.exclusions : [];
    if (!affectations.length && !exclusions.length) {
      return reponse.code(400).send({ erreur: 'Aucune affectation transmise.' });
    }

    const maj = db.prepare(`
      UPDATE agents SET service = ?, service_ad = ?, service_force = 1 WHERE id = ?
    `);
    // Motif « manuel » : la synchronisation ne defait pas une decision prise ici.
    // Sans quoi les comptes de service reviendraient a chaque passage.
    const exclure = db.prepare(`
      UPDATE agents SET exclu = 1, exclu_motif = 'manuel', note = COALESCE(note, ?) WHERE id = ?
    `);

    let touches = 0;
    let ecartes = 0;
    const services = new Set();
    db.exec('BEGIN');
    try {
      for (const a of affectations) {
        const service = normaliser(a.service);
        const id = Number(a.id);
        if (!service || !id) continue;
        // resoudreService pour qu'un rattachement suive un regroupement existant
        maj.run(resoudreService(service), service, id);
        services.add(service);
        touches++;
      }
      for (const brut of exclusions) {
        const id = Number(brut);
        if (!id) continue;
        exclure.run("Écarté depuis l'écran de rattachement", id);
        ecartes++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      requete.log.error(err, 'rattachement interrompu');
      return reponse.code(500).send({ erreur: 'Rattachement interrompu : rien n’a été modifié.', code: 'RATTACHEMENT_ECHOUE' });
    }

    journaliser(requete.agent.login, 'agents_rattaches',
      `${touches} agent(s) vers ${[...services].join(', ') || 'aucun service'}, ${ecartes} ecarte(s)`,
      requete.ip);

    const bouts = [];
    if (touches) bouts.push(`${touches} agent(s) rattaché(s) à ${services.size} service(s)`);
    if (ecartes) bouts.push(`${ecartes} agent(s) écarté(s) de la campagne`);

    return {
      ok: true,
      touches,
      ecartes,
      message: `${bouts.join(', ')}. `
        + "Ces décisions résistent aux synchronisations : l'annuaire ne les écrasera pas.",
    };
  });

  /* -------------------------------------------- Vue d'ensemble des services */

  /** Un service par ligne, avec de quoi l'ecarter d'un geste. */
  app.get('/api/admin/services/effectifs', async () => {
    const composition = new Map(
      resumeRegroupements().map((s) => [s.service, s.sources])
    );

    const services = db.prepare(`
      SELECT
        a.service,
        COUNT(*)                                                AS effectif,
        SUM(CASE WHEN a.exclu = 1 THEN 1 ELSE 0 END)            AS exclus,
        SUM(CASE WHEN a.exclu = 0 THEN 1 ELSE 0 END)            AS actifs,
        SUM(CASE WHEN a.exclu = 0 AND (a.email IS NULL OR a.email = '') THEN 1 ELSE 0 END) AS sans_email,
        SUM(CASE WHEN a.exclu = 0 AND a.vu_le IS NOT NULL THEN 1 ELSE 0 END) AS connectes,
        COUNT(DISTINCT p.agent_id)                              AS joueurs
      FROM agents a
      LEFT JOIN participations p ON p.agent_id = a.id AND p.entrainement = 0
      WHERE a.origine <> 'local'
      GROUP BY a.service
      ORDER BY a.service COLLATE NOCASE
    `).all();

    return {
      services: services.map((s) => ({ ...s, sources: composition.get(s.service) || [] })),
      // Ce qui apparaitra reellement au classement, une fois les regroupements
      // faits et les exclusions prononcees.
      participants: services.filter((s) => s.actifs > 0).length,
      totalActifs: services.reduce((n, s) => n + s.actifs, 0),
    };
  });

  /** Exclusion ou reintegration de tous les agents d'un ou plusieurs services. */
  app.post('/api/admin/services/exclusion', async (requete, reponse) => {
    const services = Array.isArray(requete.body?.services) ? requete.body.services : [];
    const exclu = requete.body?.exclu !== false;
    if (!services.length) return reponse.code(400).send({ erreur: 'Aucun service sélectionné.' });

    const marques = services.map(() => '?').join(',');
    const res = db.prepare(`
      UPDATE agents SET exclu = ?, exclu_motif = ?
      WHERE service IN (${marques}) AND origine <> 'local' AND login <> ?
    `).run(exclu ? 1 : 0, exclu ? 'manuel' : null, ...services, requete.agent.login);

    journaliser(requete.agent.login, exclu ? 'services_exclus' : 'services_reintegres',
      `${services.join(', ')} (${res.changes} agents)`, requete.ip);

    return {
      ok: true,
      touches: res.changes,
      message: `${res.changes} agent(s) ${exclu ? 'exclus' : 'réintégrés'} `
        + `sur ${services.length} service(s).`
        + (exclu ? " L'exclusion résiste aux synchronisations suivantes." : ''),
    };
  });

  /* ------------------------------------------------ Regroupement des services */

  app.get('/api/admin/services', async () => {
    // Un libellé est « referencé » quand sa cible - donc apres regroupement -
    // figure au referentiel. C'est cette cible qui parait au classement, pas
    // le libellé brut : marquer sur le libellé induirait en erreur des qu'un
    // regroupement est en place.
    const cles = new Set(nomsReferentiel().map(cleComparaison));
    const inventaire = inventaireServices()
      .map((i) => ({ ...i, referencee: cles.has(cleComparaison(i.cible)) }));

    return {
      inventaire,
      regles: lireRegroupements(),
      // Quand un referentiel existe, c'est lui qui fait foi : les listes
      // deroulantes n'offrent plus du texte libre mais des services reconnus.
      referentiel: nomsReferentiel(),
    };
  });

  /**
   * Les libelles d'annuaire qui ne correspondent a aucun service du referentiel.
   *
   * C'est la liste de travail : tant qu'un libelle y figure, ses agents
   * apparaissent au classement sous un nom que la collectivite ne reconnait
   * pas, et deux graphies du meme service comptent pour deux.
   *
   * On donne le rapprochement le plus probable avec son degre de confiance,
   * parce qu'une suggestion fausse presentee comme sure coute plus cher que
   * pas de suggestion du tout.
   */
  app.get('/api/admin/services/non-references', async () => {
    const reference = nomsReferentiel();
    const cles = new Set(reference.map(cleComparaison));

    const inventaire = inventaireServices();
    // Le libelle est reference des lors que sa cible actuelle - donc apres
    // regroupement - figure au referentiel. C'est bien la cible qui parait au
    // classement, pas le libelle brut.
    const hors = inventaire.filter((i) => !cles.has(cleComparaison(i.cible)));

    const rapproches = reference.length
      ? rapprocher(hors.map((h) => ({ libelle: h.cible, effectif: h.effectif })), reference)
      : [];
    const parLibelle = new Map(rapproches.map((r) => [r.libelle, r]));

    return {
      referentiel: reference,
      total: inventaire.length,
      references: inventaire.length - hors.length,
      agents: hors.reduce((n, h) => n + h.effectif, 0),
      services: hors.map((h) => {
        const r = parLibelle.get(h.cible);
        return {
          source: h.source,
          cible: h.cible,
          regroupe: h.regroupe,
          effectif: h.effectif,
          chaineOu: h.chaineOu,
          proposition: r?.proposition || null,
          confiance: r?.confiance || 'aucune',
          motif: r?.motif || null,
          score: r?.score || 0,
          candidats: r?.candidats || [],
        };
      }).sort((a, b) => b.effectif - a.effectif || a.cible.localeCompare(b.cible, 'fr')),
    };
  });

  /**
   * Traite les libelles hors referentiel : les uns pointent vers un service
   * reconnu, les autres entrent au referentiel parce qu'ils en manquaient.
   *
   * Les regles existantes sont conservees : enregistrerRegroupements() remplace
   * la table entiere, envoyer la seule selection de cet ecran effacerait le
   * travail fait ailleurs.
   */
  app.post('/api/admin/services/non-references', async (requete, reponse) => {
    const affectations = Array.isArray(requete.body?.affectations) ? requete.body.affectations : [];
    const ajouts = Array.isArray(requete.body?.ajouts) ? requete.body.ajouts : [];
    if (!affectations.length && !ajouts.length) {
      return reponse.code(400).send({ erreur: 'Aucune décision transmise.' });
    }

    let entres = 0;
    if (ajouts.length) {
      const existants = nomsReferentiel();
      const cles = new Set(existants.map(cleComparaison));
      const nouveaux = ajouts.map(normaliser).filter((n) => n && !cles.has(cleComparaison(n)));
      if (nouveaux.length) {
        enregistrerReferentiel([...existants, ...nouveaux], requete.agent.login);
        entres = nouveaux.length;
      }
    }

    let touches = 0;
    let regles = 0;
    if (affectations.length) {
      const fusion = new Map(lireRegroupements().map((r) => [r.source, r.cible]));
      for (const a of affectations) {
        const source = normaliser(a.source);
        const cible = normaliser(a.cible);
        if (source && cible) fusion.set(source, cible);
      }
      const liste = [...fusion].map(([source, cible]) => ({ source, cible }));
      ({ touches } = enregistrerRegroupements(liste));
      regles = affectations.length;
    }

    journaliser(requete.agent.login, 'services_non_references',
      `${regles} rattachement(s), ${entres} ajout(s) au referentiel, ${touches} agent(s) deplace(s)`,
      requete.ip);

    const bouts = [];
    if (regles) bouts.push(`${regles} libellé(s) rattaché(s) au référentiel`);
    if (entres) bouts.push(`${entres} service(s) ajouté(s) au référentiel`);
    if (touches) bouts.push(`${touches} agent(s) ont changé de service`);

    return { ok: true, touches, entres, message: `${bouts.join(', ')}.` };
  });

  app.post('/api/admin/services/regroupements', async (requete, reponse) => {
    const regles = Array.isArray(requete.body?.regles) ? requete.body.regles : null;
    if (!regles) return reponse.code(400).send({ erreur: 'Liste de règles attendue.' });

    try {
      const { touches, gouvernes } = enregistrerRegroupements(regles);
      journaliser(requete.agent.login, 'regroupements_enregistres',
                  `${regles.length} regle(s), ${gouvernes} agent(s) concernes, ${touches} deplaces`, requete.ip);
      return {
        ok: true,
        message: `${regles.length} règle(s) enregistrée(s), portant sur ${gouvernes} agent(s).`
          + (touches ? ` ${touches} viennent de changer de service.` : ' Aucun changement : les règles étaient déjà appliquées.'),
        touches,
        gouvernes,
        resume: resumeRegroupements().filter((s) => s.sources.length > 1),
      };
    } catch (err) {
      requete.log.error(err, 'enregistrement impossible');
      return reponse.code(500).send({ erreur: 'Enregistrement impossible : rien n’a été modifié.', code: 'ENREGISTREMENT_ECHOUE' });
    }
  });

  app.get('/api/admin/services/composition', async () => ({
    services: resumeRegroupements(),
  }));

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
