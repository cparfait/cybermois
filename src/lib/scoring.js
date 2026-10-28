import { db } from './db.js';
import { nomsReferentiel } from './referentiel.js';
import { cleComparaison } from './services.js';
import { aujourdhui } from './dates.js';

/**
 * Bareme d'une question a choix multiples.
 * Notation partielle : on compte les bonnes cochees et les mauvaises cochees.
 * score = points * max(0, (bonnes_cochees - mauvaises_cochees) / nb_bonnes)
 * Jamais de score negatif (choix pedagogique : l'erreur n'est pas punie).
 */
export function noterQuestion(question, choixAgent) {
  const bonnes = question.reponses.filter((r) => r.correcte).map((r) => r.id);
  const choix = [...new Set((choixAgent || []).map(Number))];

  const bonnesCochees = choix.filter((id) => bonnes.includes(id)).length;
  const mauvaisesCochees = choix.filter((id) => !bonnes.includes(id)).length;

  const ratio = bonnes.length === 0 ? 0 : Math.max(0, (bonnesCochees - mauvaisesCochees) / bonnes.length);
  const points = Math.round(question.points * ratio);
  const parfaite = bonnesCochees === bonnes.length && mauvaisesCochees === 0;

  return { points, parfaite, bonnesCochees, mauvaisesCochees, totalBonnes: bonnes.length };
}

/* ---------------------------------------------------------------- Badges */

/**
 * Part de reussite a partir de laquelle le badge d'un defi est decerne.
 * Exportee parce que l'ecran l'annonce a l'agent : la valeur etait recopiee a
 * la main dans l'interface, et n'avait aucune raison d'y rester juste.
 */
export const SEUIL_BADGE_DEFI = 0.8;

/** Nombre de defis termines qui vaut le badge « Assidu ». */
export const SEUIL_ASSIDU = 3;

/**
 * Deux familles de badges.
 *
 * Les GENERIQUES, ci-dessous, ne dependent d'aucun contenu : ils recompensent
 * une maniere de jouer et restent valables d'une annee sur l'autre.
 *
 * Les badges de DEFI sont portes par les defis eux-memes, en base. Cables sur
 * un numero d'ordre, ils devenaient faux des qu'on changeait un theme ou qu'on
 * inserait un defi - et un badge inatteignable est pire que pas de badge du
 * tout.
 *
 * Chaque condition ci-dessous est verifiee atteignable par la simulation.
 */
export const BADGES_GENERIQUES = [
  {
    code: 'premier_pas', libelle: 'Premier pas', emoji: '🚀',
    description: 'Vous avez terminé votre premier défi.',
  },
  {
    code: 'oeil_de_lynx', libelle: 'Œil de lynx', emoji: '👁️',
    description: 'Un défi terminé sans jamais cocher une mauvaise réponse.',
  },
  {
    code: 'sans_faute', libelle: 'Sans faute', emoji: '🎯',
    description: 'Un défi terminé avec la totalité des points.',
  },
  {
    code: 'assidu', libelle: 'Assidu', emoji: '📅',
    description: 'Trois défis terminés.',
  },
  {
    code: 'cyber_heros', libelle: 'Cyber-Héros', emoji: '🏆',
    description: 'Tous les défis de la campagne terminés.',
  },
  {
    code: 'ambassadeur', libelle: 'Ambassadeur', emoji: '🌟',
    description: 'Tous les défis terminés avec 80 % de réussite au total.',
  },
];

/** Badges portes par les defis publies, dans l'ordre des parutions. */
export function badgesDefis() {
  return db.prepare(`
    SELECT id, badge_code AS code, badge_libelle AS libelle,
           badge_emoji AS emoji, badge_description AS description
    FROM defis
    WHERE publie = 1 AND badge_code IS NOT NULL AND badge_code <> ''
    ORDER BY ouvre_le, id
  `).all();
}

/**
 * Catalogue des badges, pour l'affichage du profil.
 *
 * Le catalogue ne montre QUE des badges atteignables. « Assidu » recompense
 * trois defis termines : dans une campagne qui n'en compte que deux, il ne
 * peut pas s'obtenir, et l'afficher grise pour toute la campagne revient a
 * promettre ce qu'on ne tiendra pas. Un badge impossible est pire que pas de
 * badge du tout - c'est d'ailleurs ce que verifie tests/badges.test.mjs.
 *
 * `agentId` ajoute les badges que cet agent a REELLEMENT obtenus, meme s'ils
 * ne sont plus atteignables aujourd'hui : depublier un defi ne doit pas effacer
 * du profil une recompense deja gagnee.
 */
export function tousLesBadges({ agentId = null } = {}) {
  const publies = db.prepare('SELECT COUNT(*) AS n FROM defis WHERE publie = 1').get().n;

  const atteignables = BADGES_GENERIQUES.filter((b) => {
    if (b.code === 'assidu') return publies >= SEUIL_ASSIDU;
    // « Tous les defis termines » n'a pas de sens sans defi publie.
    if (b.code === 'cyber_heros' || b.code === 'ambassadeur') return publies > 0;
    return true;
  });

  const catalogue = [...atteignables, ...badgesDefis()];
  if (!agentId) return catalogue;

  const connus = new Set(catalogue.map((b) => b.code));
  const obtenus = db.prepare('SELECT code FROM badges_agent WHERE agent_id = ?').all(agentId)
    .map((l) => l.code).filter((c) => !connus.has(c));
  if (!obtenus.length) return catalogue;

  // Un badge gagne puis retire du catalogue garde son libelle : on le retrouve
  // parmi les generiques, ou sur le defi qui le portait, meme depublie.
  const marques = obtenus.map(() => '?').join(',');
  const surDefis = db.prepare(`
    SELECT badge_code AS code, badge_libelle AS libelle,
           badge_emoji AS emoji, badge_description AS description
    FROM defis WHERE badge_code IN (${marques})
  `).all(...obtenus);

  const retrouves = obtenus.map((code) =>
    BADGES_GENERIQUES.find((b) => b.code === code)
    || surDefis.find((b) => b.code === code)
    || { code, libelle: code, emoji: '🏅', description: 'Badge obtenu lors d’une campagne précédente.' });

  return [...catalogue, ...retrouves];
}

// Conserve pour compatibilite avec le code existant
export const BADGES = BADGES_GENERIQUES;

/**
 * Attribue les badges gagnes apres une participation.
 * `erreurs` compte les questions ou l'agent a coche au moins une mauvaise
 * proposition : oublier une bonne reponse n'est pas se tromper.
 */
export function attribuerBadges(agentId, { defiId, score, scoreMax, erreurs = null } = {}) {
  const nouveaux = [];
  const catalogue = tousLesBadges();
  const donner = (code) => {
    if (!code) return;
    const res = db.prepare('INSERT OR IGNORE INTO badges_agent (agent_id, code) VALUES (?, ?)').run(agentId, code);
    if (res.changes > 0) {
      const b = catalogue.find((x) => x.code === code);
      if (b) nouveaux.push(b);
    }
  };

  const parts = db.prepare(
    'SELECT score, score_max FROM participations WHERE agent_id = ? AND entrainement = 0'
  ).all(agentId);

  donner('premier_pas');
  if (scoreMax > 0 && score >= scoreMax) donner('sans_faute');
  if (erreurs === 0) donner('oeil_de_lynx');

  // Le badge du defi qui vient d'etre joue
  if (scoreMax > 0 && score / scoreMax >= SEUIL_BADGE_DEFI) {
    const badge = db.prepare('SELECT badge_code FROM defis WHERE id = ?').get(defiId);
    donner(badge?.badge_code);
  }

  // Les seuils suivent le nombre reel de defis publies : en ajouter un ne doit
  // pas decerner « Cyber-Heros » par anticipation.
  const publies = db.prepare('SELECT COUNT(*) AS n FROM defis WHERE publie = 1').get().n;
  const defisPublies = publies || SEUIL_ASSIDU;

  // « Assidu » annonce trois defis termines : il en exige donc trois.
  // Le seuil suivait auparavant le nombre de defis publies, si bien qu'avec
  // deux defis au programme le badge tombait au deuxieme - en contradiction
  // avec sa propre description, que l'agent a sous les yeux.
  if (parts.length >= SEUIL_ASSIDU) donner('assidu');
  if (publies > 0 && parts.length >= defisPublies) {
    donner('cyber_heros');
    const total = parts.reduce((s, p) => s + p.score, 0);
    const totalMax = parts.reduce((s, p) => s + p.score_max, 0);
    if (totalMax > 0 && total / totalMax >= SEUIL_BADGE_DEFI) donner('ambassadeur');
  }

  return nouveaux;
}

/* ----------------------------------------------------------- Classements */

/**
 * Points qu'un agent peut avoir gagnes a ce jour.
 *
 * Seuls les defis deja parus comptent : inclure un defi a venir
 * ferait chuter tout le monde a chaque ouverture, et donnerait un
 * pourcentage qui baisse alors que personne n'a demerite.
 *
 * Le total est le meme pour tous, ce qui laisse le classement dans l'ordre
 * qu'il avait quand il s'exprimait en points - seule l'unite change.
 */
export function pointsPossibles(jour = aujourdhui()) {
  // La date est passee en parametre, et non lue par date('now') : cette
  // derniere rend la date UTC, alors que l'ouverture d'un defi se juge en
  // heure locale. Les deux divergeaient deux heures par nuit.
  const r = db.prepare(`
    SELECT COALESCE(SUM(q.points), 0) AS total
    FROM questions q
    JOIN defis d ON d.id = q.defi_id
    WHERE d.publie = 1 AND d.ouvre_le <= ?
  `).get(jour);
  return r?.total || 0;
}

/**
 * Nombre de defis parus a ce jour, avec la meme regle que pointsPossibles :
 * c'est l'etalon de la participation (« 3 défis sur 4 »).
 */
export function defisParus(jour = aujourdhui()) {
  return db.prepare('SELECT COUNT(*) AS n FROM defis WHERE publie = 1 AND ouvre_le <= ?').get(jour).n;
}

/**
 * Classement par direction.
 *
 * Seules les directions du referentiel sont classees. Sans ce filtre, chaque
 * libelle d'annuaire non rattache formait sa propre ligne : le classement
 * annoncait cinquante « directions » la ou la collectivite en compte cinq, et
 * la premiere place se jouait entre des services de trois agents.
 *
 * Les agents dont la direction ne figure pas au referentiel n'entrent donc pas
 * au classement, ni au numerateur ni au denominateur. Ils se rattachent depuis
 * « Services non references », qui est l'ecran fait pour cela.
 *
 * Referentiel vide : il n'y a rien a quoi comparer, on classe tout. Sinon
 * l'ecran serait vide avant meme qu'on ait pu renseigner la liste.
 *
 * La reussite est la MOYENNE des resultats de ceux qui ont joue : leurs
 * points sur le maximum des defis qu'ils ont faits. Elle etait rapportee aux
 * points que TOUS les agents auraient pu gagner : une direction ou 2 % des
 * agents jouaient plafonnait a 2 % de reussite, quels que soient leurs
 * resultats. La participation dit desormais seule combien jouent.
 *
 * Classement : la participation passe d'abord, comme pour les agents. Les
 * directions se classent au nombre moyen de defis termines par agent INSCRIT,
 * puis a la reussite, puis a la part d'agents ayant joue. Classees a la seule
 * reussite, une direction ou deux agents avaient fait deux defis sans faute
 * passait devant une autre ou chacun avait tout fait a 90 %.
 */
export function classementServices() {
  const possible = pointsPossibles();
  const parus = defisParus();

  const lignes = db.prepare(`
    SELECT
      a.service                  AS service,
      COUNT(DISTINCT a.id)       AS inscrits,
      COUNT(DISTINCT p.agent_id) AS joueurs,
      COALESCE(SUM(p.score), 0)  AS score_total,
      COALESCE(SUM(p.score_max), 0) AS score_max_joue,
      COUNT(p.id)                AS defis_joues
    FROM agents a
    -- Les defis publies et deja parus seulement : les memes que ceux dont
    -- les points sont atteignables (pointsPossibles).
    LEFT JOIN participations p ON p.agent_id = a.id AND p.entrainement = 0
      AND p.defi_id IN (SELECT id FROM defis WHERE publie = 1 AND ouvre_le <= ?)
    WHERE a.exclu = 0
    GROUP BY a.service
  `).all(aujourdhui());

  // Deux graphies d'une meme direction comptaient pour deux. On les ramene a
  // l'orthographe du referentiel, qui fait foi, et leurs agents se rejoignent.
  const reference = nomsReferentiel();
  const canonique = new Map(reference.map((n) => [cleComparaison(n), n]));

  const cumul = new Map();
  for (const l of lignes) {
    const nom = reference.length ? canonique.get(cleComparaison(l.service)) : l.service;
    if (!nom) continue; // direction absente du referentiel : hors classement
    const c = cumul.get(nom)
      || { service: nom, inscrits: 0, joueurs: 0, score_total: 0, score_max_joue: 0, defis_joues: 0 };
    c.inscrits += l.inscrits;
    c.joueurs += l.joueurs;
    c.score_total += l.score_total;
    c.score_max_joue += l.score_max_joue;
    c.defis_joues += l.defis_joues;
    cumul.set(nom, c);
  }

  // « 27 pts » ne dit rien sans son maximum : le meme chiffre vaut un sans-faute
  // sur un defi et un resultat mediocre sur quatre. Le pourcentage se lit
  // seul, et le total possible est rappele a cote.
  // Le tri se fait sur les valeurs exactes : arrondies, deux directions a
  // 66,4 % et 66,6 % se retrouvaient a egalite.
  const reussite = (c) => (c.score_max_joue ? c.score_total / c.score_max_joue : 0);
  const participation = (c) => (c.inscrits ? c.joueurs / c.inscrits : 0);
  const defisParAgent = (c) => (c.inscrits ? c.defis_joues / c.inscrits : 0);
  return [...cumul.values()]
    .sort((a, b) => defisParAgent(b) - defisParAgent(a)
      || reussite(b) - reussite(a)
      || participation(b) - participation(a)
      || a.service.localeCompare(b.service, 'fr'))
    .map((c) => ({
      ...c,
      score_moyen: c.inscrits ? Math.round((c.score_total * 10) / c.inscrits) / 10 : 0,
      taux_participation: Math.round(participation(c) * 100),
      points_possibles: possible * c.inscrits,
      pourcentage_moyen: Math.round(reussite(c) * 100),
      defis_par_agent: Math.round(defisParAgent(c) * 10) / 10,
      defis_parus: parus,
    }));
}

/**
 * La ligne du classement qui porte cette direction, quelle que soit sa
 * graphie. Comparer les chaines telles quelles ratait « Population &
 * Citoyennete » face a « Population et Citoyennete ».
 */
export function ligneClassement(service, lignes = classementServices()) {
  const cle = cleComparaison(service);
  return lignes.find((s) => cleComparaison(s.service) === cle) || null;
}

/** Classement individuel nominatif. */
export function classementAgents(limite = 100) {
  const possible = pointsPossibles();
  const parus = defisParus();

  const lignes = db.prepare(`
    SELECT
      a.id,
      -- Droit d'opposition : l'agent compte pour son service mais n'est plus nomme
      CASE WHEN a.anonyme = 1 THEN 'Agent anonyme' ELSE a.nom_complet END AS nom_complet,
      a.anonyme,
      a.service,
      COALESCE(SUM(p.score), 0)  AS score_total,
      COALESCE(SUM(p.score_max), 0) AS score_max_joue,
      COUNT(p.id)                AS defis_joues,
      COALESCE(SUM(p.bonnes), 0) AS bonnes_total,
      MIN(p.termine_le)          AS premiere_participation
    FROM agents a
    JOIN participations p ON p.agent_id = a.id AND p.entrainement = 0
      AND p.defi_id IN (SELECT id FROM defis WHERE publie = 1 AND ouvre_le <= ?)
    WHERE a.exclu = 0
    GROUP BY a.id
  `).all(aujourdhui());

  // Meme lecture que pour les directions : la reussite sur les defis faits.
  // Rapportee a tous les defis parus, elle donnait 45 % a un agent qui avait
  // fait un seul des deux defis, a 90 %.
  //
  // Classement : les points d'abord. Le nombre de defis faits et le
  // pourcentage de reussite s'affichent a cote, sans decider de l'ordre ;
  // ils departagent seulement deux agents a egalite de points, puis
  // l'anteriorite.
  const reussite = (l) => (l.score_max_joue ? l.score_total / l.score_max_joue : 0);
  return lignes
    .sort((a, b) => b.score_total - a.score_total
      || reussite(b) - reussite(a)
      || b.defis_joues - a.defis_joues
      || String(a.premiere_participation).localeCompare(String(b.premiere_participation)))
    .slice(0, limite)
    .map((l) => ({
      ...l,
      defis_parus: parus,
      points_possibles: possible,
      pourcentage: Math.round(reussite(l) * 100),
    }));
}

/** Position d'un agent dans le classement individuel. */
export function rangAgent(agentId) {
  const tous = classementAgents(100000);
  const i = tous.findIndex((a) => a.id === agentId);
  return { rang: i === -1 ? null : i + 1, total: tous.length };
}

/**
 * Position d'une direction au classement.
 * Un agent dont la direction ne figure pas au referentiel n'a pas de rang :
 * l'ecran le dit, plutot que de le faire passer pour dernier.
 */
export function rangService(service) {
  const tous = classementServices();
  const cle = cleComparaison(service);
  const i = tous.findIndex((s) => cleComparaison(s.service) === cle);
  return {
    rang: i === -1 ? null : i + 1,
    total: tous.length,
    detail: tous[i] || null,
    horsReferentiel: i === -1 && tous.length > 0,
  };
}

/**
 * Agents ayant fait un sans-faute (100 %) a au moins un defi, avec les defis
 * concernes. Les participations d'entrainement et les agents exclus ne
 * comptent pas, comme au classement.
 */
export function agentsSansFaute() {
  const lignes = db.prepare(`
    SELECT a.id, a.nom_complet, a.service, d.titre, d.ouvre_le
    FROM participations p
    JOIN agents a ON a.id = p.agent_id
    JOIN defis d ON d.id = p.defi_id
    WHERE p.entrainement = 0 AND a.exclu = 0
      AND p.score_max > 0 AND p.score >= p.score_max
    ORDER BY d.ouvre_le, d.id
  `).all();

  const parAgent = new Map();
  for (const l of lignes) {
    const e = parAgent.get(l.id)
      || { id: l.id, nom_complet: l.nom_complet, service: l.service, defis: [] };
    e.defis.push(l.titre);
    parAgent.set(l.id, e);
  }
  return [...parAgent.values()]
    .map((e) => ({ ...e, nombre: e.defis.length }))
    .sort((a, b) => b.nombre - a.nombre || a.nom_complet.localeCompare(b.nom_complet, 'fr'));
}

/** Statistiques globales pour le tableau de bord et les mails. */
export function statistiquesGlobales({ detailParDefi = true } = {}) {
  const g = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM agents WHERE exclu = 0)                            AS inscrits,
      (SELECT COUNT(*) FROM agents WHERE exclu = 0 AND vu_le IS NOT NULL)      AS connectes,
      (SELECT COUNT(DISTINCT p.agent_id) FROM participations p
         JOIN agents a ON a.id = p.agent_id
        WHERE p.entrainement = 0 AND a.exclu = 0)                              AS joueurs,
      -- Les agents exclus sont ecartes ici aussi : leurs participations
      -- comptaient dans les totaux affiches alors qu'elles sont hors
      -- classement, si bien que les deux chiffres ne se recoupaient pas.
      (SELECT COUNT(*) FROM participations p
         JOIN agents a ON a.id = p.agent_id
        WHERE p.entrainement = 0 AND a.exclu = 0)                              AS participations,
      -- Nombre de libelles distincts arrivant de l'annuaire. Il ne sert qu'a
      -- mesurer l'ecart avec le referentiel dans le back-office ; le nombre de
      -- directions reellement classees est rendu a part, sous « services ».
      (SELECT COUNT(DISTINCT service) FROM agents WHERE exclu = 0)             AS libelles_distincts,
      (SELECT COALESCE(SUM(p.score), 0) FROM participations p
         JOIN agents a ON a.id = p.agent_id
        WHERE p.entrainement = 0 AND a.exclu = 0)                              AS points_cumules
  `).get();

  const parDefi = detailParDefi
    ? db.prepare(`
        SELECT d.id, d.titre, d.ouvre_le,
               COUNT(p.id) AS participants,
               ROUND(AVG(CASE WHEN p.score_max > 0 THEN p.score * 100.0 / p.score_max END), 0) AS reussite_moyenne
        FROM defis d
        LEFT JOIN participations p ON p.defi_id = d.id AND p.entrainement = 0
        GROUP BY d.id ORDER BY d.ouvre_le, d.id
      `).all()
    : [];

  return { ...g, services: classementServices().length, parDefi };
}
