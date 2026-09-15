import { db, journaliser } from './db.js';
import { config } from './config.js';
import { listerAgentsAnnuaire } from './ldap.js';
import { resoudreService, normaliser } from './services.js';

/**
 * Synchronisation de l'effectif depuis l'Active Directory.
 *
 * Aucune ecriture n'a lieu sans validation explicite : l'annuaire d'une
 * collectivite contient bien plus que des agents - elus, comptes de service,
 * boites partagees, comptes de test - et la liste des services doit etre
 * verifiee avant d'alimenter un classement.
 *
 * L'analyse produit quatre categories, chacune traitee separement :
 *   nouveaux    comptes absents de l'application, a valider un par un
 *   modifies    service, nom ou adresse ayant change dans l'annuaire
 *   desactives  comptes desactives dans l'annuaire, encore actifs ici
 *   disparus    comptes absents de l'annuaire (suppression, changement d'OU)
 */

db.exec(`
CREATE TABLE IF NOT EXISTS exclusions_sync (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  champ    TEXT NOT NULL,
  motif    TEXT NOT NULL,
  cree_le  TEXT NOT NULL DEFAULT (datetime('now')),
  cree_par TEXT,
  UNIQUE(champ, motif)
);
`);

/**
 * Motifs proposes par defaut : ce qui, dans un annuaire de collectivite,
 * n'a jamais sa place dans une campagne destinee aux agents.
 */
export const MOTIFS_SUGGERES = [
  { champ: 'dn', motif: 'OU=Comptes de service', libelle: 'Comptes de service' },
  { champ: 'dn', motif: 'OU=Elus', libelle: 'Élus' },
  { champ: 'dn', motif: 'OU=zExternes', libelle: 'Prestataires externes' },
  { champ: 'service', motif: 'Elus de', libelle: 'Services commençant par « Elus de »' },
  { champ: 'login', motif: 'svc-', libelle: 'Identifiants commençant par svc-' },
  { champ: 'login', motif: 'adm-', libelle: 'Identifiants commençant par adm-' },
  { champ: 'service', motif: 'A CLASSER', libelle: 'Comptes non classés' },
];

export const lireExclusions = () =>
  db.prepare('SELECT id, champ, motif FROM exclusions_sync ORDER BY champ, motif').all();

export function enregistrerExclusions(regles, parQui) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM exclusions_sync');
    const inserer = db.prepare('INSERT OR IGNORE INTO exclusions_sync (champ, motif, cree_par) VALUES (?, ?, ?)');
    for (const r of regles) {
      const champ = ['dn', 'service', 'login'].includes(r.champ) ? r.champ : null;
      const motif = String(r.motif || '').trim();
      if (champ && motif) inserer.run(champ, motif, parQui || null);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return lireExclusions();
}

/** Un compte est-il ecarte par une des regles ? Renvoie le motif, ou null. */
function motifExclusion(agent, exclusions) {
  for (const e of exclusions) {
    const valeur = e.champ === 'dn' ? agent.dn
      : e.champ === 'service' ? agent.serviceAd
        : agent.login;
    if (String(valeur || '').toLowerCase().includes(e.motif.toLowerCase())) {
      return `${e.champ} contient « ${e.motif} »`;
    }
  }
  return null;
}

/**
 * Compare l'annuaire et la base, sans rien ecrire.
 * C'est le sas : rien n'entre dans la campagne avant validation.
 */
export async function analyserSynchronisation() {
  const lecture = await listerAgentsAnnuaire();
  if (!lecture.ok) return { ok: false, message: lecture.message };

  const exclusions = lireExclusions();
  const enBase = new Map(
    db.prepare(`
      SELECT id, login, nom_complet, email, service, service_ad, service_force,
             exclu, exclu_motif, origine, vu_le,
             (SELECT COUNT(*) FROM participations p WHERE p.agent_id = agents.id AND p.entrainement = 0) AS defis
      FROM agents
    `).all().map((a) => [a.login, a])
  );

  const nouveaux = [];
  const modifies = [];
  const desactives = [];
  const ecartes = [];
  const sansAdresse = [];
  const vusDansAnnuaire = new Set();
  // Comptes dont l'annuaire ne dit pas le service : ni l'attribut, ni l'OU.
  // Ils gardent leur rattachement actuel, mais le chiffre merite d'etre dit -
  // c'est lui qui pointe une OU mal placee ou un « department » a remplir.
  let sansService = 0;

  for (const a of lecture.agents) {
    vusDansAnnuaire.add(a.login);
    const existant = enBase.get(a.login);
    const motif = motifExclusion(a, exclusions);

    // Un compte desactive dans l'annuaire sort de la campagne, qu'il soit
    // deja connu ou non : le laisser compter fausserait l'effectif de reference.
    if (!a.actif) {
      if (existant && !existant.exclu) {
        desactives.push({
          login: a.login, nomComplet: existant.nom_complet,
          service: existant.service, defis: existant.defis,
        });
      }
      continue;
    }

    if (motif) {
      if (!existant) ecartes.push({ ...a, motif });
      continue;
    }

    if (!a.serviceAd) sansService++;

    if (!existant) {
      // Sans adresse, l'agent ne recevra jamais ni lancement ni relance :
      // l'inclure ne ferait que degrader le taux de participation de son service.
      if (config.sync.exigerEmail && !a.email) {
        sansAdresse.push({ ...a, service: resoudreService(a.serviceAd) });
        continue;
      }
      nouveaux.push({ ...a, service: resoudreService(a.serviceAd) });
      continue;
    }

    const changements = [];
    if (normaliser(existant.nom_complet) !== normaliser(a.nomComplet)) {
      changements.push({ champ: 'nom', avant: existant.nom_complet, apres: a.nomComplet });
    }
    if ((existant.email || '') !== (a.email || '')) {
      changements.push({ champ: 'adresse', avant: existant.email || '(vide)', apres: a.email || '(vide)' });
    }
    // a.serviceAd vide : l'annuaire ne dit rien du service de cet agent. Ce
    // n'est pas un changement, et surtout pas un passage a « Non rattache » -
    // le silence de l'annuaire ne defait pas ce qu'on sait deja.
    if (!existant.service_force && a.serviceAd
      && normaliser(existant.service_ad || existant.service) !== normaliser(a.serviceAd)) {
      changements.push({ champ: 'service', avant: existant.service_ad || existant.service, apres: a.serviceAd });
    }
    // Un compte reactive dans l'annuaire revient dans la campagne, sauf s'il a
    // ete ecarte volontairement : cette decision-la ne se defait pas toute seule.
    if (existant.exclu && existant.origine !== 'local' && existant.exclu_motif !== 'manuel') {
      changements.push({ champ: 'etat', avant: 'exclu', apres: 'réintégré' });
    }
    if (changements.length) {
      modifies.push({
        login: a.login, nomComplet: a.nomComplet, serviceAd: a.serviceAd,
        service: resoudreService(a.serviceAd), email: a.email, changements,
      });
    }
  }

  /**
   * Les listes du sas suivent sinon l'ordre de lecture de l'annuaire, qui n'en
   * est pas un : relire trois cents noms pour verifier qu'un agent y figure
   * suppose de pouvoir les parcourir. Le tri est accentue - « Élus » se range
   * avec les E, pas apres les Z.
   */
  const parNom = (liste) =>
    [...liste].sort((a, b) => String(a.nomComplet || a.login || '')
      .localeCompare(String(b.nomComplet || b.login || ''), 'fr', { sensitivity: 'base' }));

  // Agents deja en base qui n'ont pas d'adresse : signales, jamais ecartes
  // d'office - certains ont peut-etre deja joue.
  const enBaseSansAdresse = [...enBase.values()]
    .filter((a) => !a.exclu && a.origine !== 'local' && !a.email)
    .map((a) => ({ login: a.login, nomComplet: a.nom_complet, service: a.service, defis: a.defis }));

  const disparus = [...enBase.values()]
    .filter((a) => !vusDansAnnuaire.has(a.login) && !a.exclu && a.origine !== 'local')
    .map((a) => ({ login: a.login, nomComplet: a.nom_complet, service: a.service, defis: a.defis }));

  // Repartition par service des nouveaux comptes : c'est la vue qui permet de
  // reperer d'un coup d'oeil un lot entier a ecarter.
  const parService = new Map();
  for (const n of nouveaux) {
    if (!parService.has(n.service)) parService.set(n.service, []);
    parService.get(n.service).push(n);
  }

  return {
    ok: true,
    source: config.ldap.url === 'demo' ? 'annuaire simulé' : config.ldap.url,
    origineService: config.service.source === 'attr'
      ? `attribut ${config.service.attribut}`
      : `OU du DN (profondeur ${config.service.ouDepth})`,
    lus: lecture.agents.length,
    resume: {
      nouveaux: nouveaux.length,
      modifies: modifies.length,
      desactives: desactives.length,
      disparus: disparus.length,
      ecartes: ecartes.length,
      sansAdresse: sansAdresse.length,
      enBaseSansAdresse: enBaseSansAdresse.length,
      sansService,
      services: parService.size,
    },
    nouveauxParService: [...parService.entries()]
      .map(([service, agents]) => ({
        service,
        effectif: agents.length,
        sansEmail: agents.filter((a) => !a.email).length,
        agents: parNom(agents).map((a) => ({
          login: a.login, nomComplet: a.nomComplet, email: a.email, serviceAd: a.serviceAd, dn: a.dn,
        })),
      }))
      .sort((a, b) => b.effectif - a.effectif || a.service.localeCompare(b.service, 'fr')),
    modifies: parNom(modifies).slice(0, 200),
    desactives: parNom(desactives),
    disparus: parNom(disparus),
    ecartes: parNom(ecartes).slice(0, 100),
    sansAdresse: parNom(sansAdresse).slice(0, 200),
    enBaseSansAdresse: parNom(enBaseSansAdresse),
    exigerEmail: config.sync.exigerEmail,
    exclusions,
  };
}

/**
 * Applique la synchronisation validee.
 * `accepter` porte les identifiants explicitement retenus dans le sas.
 */
export async function appliquerSynchronisation({
  accepter = [], appliquerModifications = true,
  exclureDesactives = true, exclureDisparus = false, supprimerDisparus = false,
  disparusChoisis = null,
  // Annuaire deja lu. Sert a rejouer exactement la lecture presentee dans le
  // sas, et a eprouver cette fonction sans controleur de domaine.
  annuaire = null,
} = {}, parQui) {
  const lecture = annuaire ? { ok: true, agents: annuaire } : await listerAgentsAnnuaire();
  if (!lecture.ok) return { ok: false, message: lecture.message };

  const retenus = new Set(accepter.map((l) => String(l).toLowerCase()));
  const parLogin = new Map(lecture.agents.map((a) => [a.login, a]));
  const enBase = new Map(db.prepare('SELECT id, login, exclu, origine FROM agents').all().map((a) => [a.login, a]));

  const inserer = db.prepare(`
    INSERT INTO agents (login, nom_complet, prenom, email, service, service_ad, service_brut, origine, est_admin)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'annuaire', ?)
  `);
  // Une exclusion decidee par l'administration survit a la synchronisation :
  // sinon il faudrait refaire le tri a chaque fois. Seules les exclusions
  // prononcees par l'annuaire lui-meme sont levees quand le compte redevient actif.
  const majorer = db.prepare(`
    UPDATE agents SET nom_complet = @nomComplet,
                      -- COALESCE : un annuaire muet sur givenName ne doit pas
                      -- effacer un prenom deja connu.
                      prenom = COALESCE(@prenom, prenom),
                      email = COALESCE(@email, email),
                      -- Deux raisons de ne pas toucher au service.
                      -- Un rattachement decide a la main resiste a l'annuaire :
                      -- c'est tout l'interet de l'avoir saisi. Et un annuaire
                      -- qui ne dit rien du service ne dit pas « Non rattache » :
                      -- ecraser avec son silence vidait de leur direction des
                      -- centaines d'agents a chaque synchronisation.
                      service    = CASE WHEN service_force = 1 OR @serviceAd IS NULL
                                        THEN service    ELSE @service    END,
                      service_ad = CASE WHEN service_force = 1 OR @serviceAd IS NULL
                                        THEN service_ad ELSE @serviceAd END,
                      service_brut = @dn,
                      exclu = CASE WHEN exclu_motif = 'manuel' THEN exclu ELSE 0 END,
                      exclu_motif = CASE WHEN exclu_motif = 'manuel' THEN exclu_motif ELSE NULL END
    WHERE login = @login
  `);
  const exclure = db.prepare(
    "UPDATE agents SET exclu = 1, exclu_motif = 'annuaire', note = COALESCE(note, ?) WHERE login = ?"
  );

  /**
   * Efface un agent et tout ce qui s'y rattache.
   *
   * Sans les tables liees, la suppression laisserait des participations
   * orphelines qui continueraient de peser dans les moyennes d'un service
   * dont plus personne ne fait partie. On descend donc jusqu'aux reponses,
   * qui pendent aux participations et non a l'agent.
   *
   * Le journal et la table des corrections ne sont pas touches : ils portent
   * la trace de ce qui a ete fait, et c'est precisement ce qui ne doit pas
   * disparaitre avec le compte.
   */
  const supprimerAgent = (id) => {
    db.prepare(`
      DELETE FROM reponses_agent
      WHERE participation_id IN (SELECT id FROM participations WHERE agent_id = ?)
    `).run(id);
    for (const table of ['participations', 'tentatives', 'badges_agent', 'sessions', 'admins_locaux']) {
      db.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).run(id);
    }
    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  };

  let ajoutes = 0; let misAJour = 0; let desactives = 0; let retires = 0; let supprimes = 0;
  const effaces = [];
  let refusesSansAdresse = 0;

  db.exec('BEGIN');
  try {
    for (const login of retenus) {
      const a = parLogin.get(login);
      if (!a || !a.actif || enBase.has(login)) continue;
      // Verification cote serveur : la regle ne doit pas dependre du formulaire
      if (config.sync.exigerEmail && !a.email) { refusesSansAdresse++; continue; }
      inserer.run(a.login, a.nomComplet, a.prenom || null, a.email, resoudreService(a.serviceAd), a.serviceAd, a.dn,
        config.adminLogins.includes(a.login) ? 1 : 0);
      ajoutes++;
    }

    if (appliquerModifications) {
      for (const a of lecture.agents) {
        const existant = enBase.get(a.login);
        // Les comptes locaux d'administration ne sont pas pilotes par l'annuaire
        if (!existant || !a.actif || existant.origine === 'local') continue;
        majorer.run({
          nomComplet: a.nomComplet, prenom: a.prenom || null, email: a.email,
          service: a.serviceAd ? resoudreService(a.serviceAd) : null,
          serviceAd: a.serviceAd || null, dn: a.dn, login: a.login,
        });
        misAJour++;
      }
    }

    if (exclureDesactives) {
      for (const a of lecture.agents) {
        const existant = enBase.get(a.login);
        if (a.actif || !existant || existant.exclu || existant.origine === 'local') continue;
        exclure.run("Compte desactive dans l'annuaire", a.login);
        desactives++;
      }
    }

    if (supprimerDisparus || exclureDisparus) {
      // Une selection explicite l'emporte : tous les absents ne relevent pas
      // du meme sort - un depart definitif se supprime, un compte deplace par
      // erreur ne doit surtout pas l'etre. Sans liste, on traite l'ensemble,
      // ce qui reste le comportement des appels programmatiques.
      const choisis = Array.isArray(disparusChoisis)
        ? new Set(disparusChoisis.map((l) => String(l).toLowerCase()))
        : null;

      for (const [login, existant] of enBase) {
        // Un compte local ne vient pas de l'annuaire : son absence n'a aucun
        // sens, et le supprimer couperait l'acces a l'administration.
        if (parLogin.has(login) || existant.origine === 'local') continue;
        if (choisis && !choisis.has(login)) continue;

        // Sans selection explicite, on s'en tient a ce que l'analyse a
        // annonce : elle ne liste comme « disparus » que les comptes NON
        // exclus. Sans ce filtre, une suppression demandee sans liste
        // emportait aussi des agents ecartes a la main, que l'ecran n'avait
        // jamais montres - et dont les resultats partaient avec eux.
        if (!choisis && existant.exclu) continue;

        if (supprimerDisparus) {
          effaces.push(login);
          supprimerAgent(existant.id);
          supprimes++;
          continue;
        }
        if (existant.exclu) continue;
        exclure.run("Absent de l'annuaire lors de la derniere synchronisation", login);
        retires++;
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return { ok: false, message: `Synchronisation interrompue, aucune modification enregistrée : ${err.message}` };
  }

  journaliser(parQui, 'synchronisation_annuaire',
    `${ajoutes} ajoutes, ${misAJour} mis a jour, ${desactives} desactives, ${retires} retires`
    + (supprimes ? `, ${supprimes} supprimes` : ''), null);

  // Une suppression ne se rattrape pas : le journal doit garder qui a disparu,
  // meme si la fiche, elle, n'existe plus.
  if (supprimes) {
    journaliser(parQui, 'agents_supprimes',
      `${supprimes} compte(s) absent(s) de l'annuaire : ${effaces.join(', ')}`, null);
  }

  return {
    ok: true,
    ajoutes, misAJour, desactives, retires, supprimes, refusesSansAdresse,
    message: `${ajoutes} agent(s) ajouté(s)`
      + (misAJour ? `, ${misAJour} fiche(s) mise(s) à jour` : '')
      + (desactives ? `, ${desactives} compte(s) désactivé(s) dans l'annuaire écarté(s)` : '')
      + (retires ? `, ${retires} disparu(s) de l'annuaire écarté(s)` : '')
      + (supprimes ? `, ${supprimes} compte(s) supprimé(s) avec leurs résultats` : '')
      + (refusesSansAdresse ? `, ${refusesSansAdresse} sans adresse mail non retenu(s)` : '')
      + '.',
  };
}
