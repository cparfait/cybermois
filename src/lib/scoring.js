import { db } from './db.js';
import { nomsReferentiel } from './referentiel.js';
import { cleComparaison } from './services.js';

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

/** Bonus rapidite : jusqu'a 20 % du score, si l'agent a repondu sans bacler. */
export function bonusRapidite(score, dureeSecondes, nbQuestions) {
  const referenceHaute = nbQuestions * 45; // au-dela : pas de bonus
  const referenceBasse = nbQuestions * 12; // en deca : reponses baclees, pas de bonus
  if (dureeSecondes < referenceBasse || dureeSecondes > referenceHaute) return 0;
  const part = 1 - (dureeSecondes - referenceBasse) / (referenceHaute - referenceBasse);
  return Math.round(score * 0.2 * part);
}

/* ---------------------------------------------------------------- Badges */

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

/** Catalogue complet, pour l'affichage du profil. */
export function tousLesBadges() {
  return [...BADGES_GENERIQUES, ...badgesDefis()];
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

  // Le badge du defi qui vient d'etre joue, a partir de 80 % de reussite
  if (scoreMax > 0 && score / scoreMax >= 0.8) {
    const badge = db.prepare('SELECT badge_code FROM defis WHERE id = ?').get(defiId);
    donner(badge?.badge_code);
  }

  // Les seuils suivent le nombre reel de defis publies : en ajouter un ne doit
  // pas decerner « Cyber-Heros » par anticipation.
  const defisPublies = db.prepare('SELECT COUNT(*) AS n FROM defis WHERE publie = 1').get().n || 4;

  if (parts.length >= Math.min(3, defisPublies)) donner('assidu');
  if (parts.length >= defisPublies) {
    donner('cyber_heros');
    const total = parts.reduce((s, p) => s + p.score, 0);
    const totalMax = parts.reduce((s, p) => s + p.score_max, 0);
    if (totalMax > 0 && total / totalMax >= 0.8) donner('ambassadeur');
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
export function pointsPossibles() {
  const r = db.prepare(`
    SELECT COALESCE(SUM(q.points), 0) AS total
    FROM questions q
    JOIN defis d ON d.id = q.defi_id
    WHERE d.publie = 1 AND d.ouvre_le <= date('now')
  `).get();
  return r?.total || 0;
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
 * Le score retenu est la MOYENNE par agent inscrit de la direction, pas le
 * total : sinon une direction de 40 agents ecraserait mecaniquement une
 * direction de 4. Le taux de participation est affiche a cote, c'est le vrai
 * levier de mobilisation.
 */
export function classementServices() {
  const possible = pointsPossibles();

  const lignes = db.prepare(`
    SELECT
      a.service                  AS service,
      COUNT(DISTINCT a.id)       AS inscrits,
      COUNT(DISTINCT p.agent_id) AS joueurs,
      COALESCE(SUM(p.score), 0)  AS score_total,
      COUNT(p.id)                AS defis_joues
    FROM agents a
    LEFT JOIN participations p ON p.agent_id = a.id AND p.entrainement = 0
    WHERE a.exclu = 0
    GROUP BY a.service
  `).all();

  // Deux graphies d'une meme direction comptaient pour deux. On les ramene a
  // l'orthographe du referentiel, qui fait foi, et leurs agents se rejoignent.
  const reference = nomsReferentiel();
  const canonique = new Map(reference.map((n) => [cleComparaison(n), n]));

  const cumul = new Map();
  for (const l of lignes) {
    const nom = reference.length ? canonique.get(cleComparaison(l.service)) : l.service;
    if (!nom) continue; // direction absente du referentiel : hors classement
    const c = cumul.get(nom)
      || { service: nom, inscrits: 0, joueurs: 0, score_total: 0, defis_joues: 0 };
    c.inscrits += l.inscrits;
    c.joueurs += l.joueurs;
    c.score_total += l.score_total;
    c.defis_joues += l.defis_joues;
    cumul.set(nom, c);
  }

  // « 27 pts » ne dit rien sans son maximum : le meme chiffre vaut un sans-faute
  // sur un defi et un resultat mediocre sur quatre. Le pourcentage se lit
  // seul, et le total possible est rappele a cote.
  return [...cumul.values()]
    .map((c) => ({
      ...c,
      score_moyen: c.inscrits ? Math.round((c.score_total * 10) / c.inscrits) / 10 : 0,
      taux_participation: c.inscrits ? Math.round((c.joueurs * 100) / c.inscrits) : 0,
      points_possibles: possible * c.inscrits,
      pourcentage_moyen: possible && c.inscrits
        ? Math.round((c.score_total * 100) / (possible * c.inscrits))
        : 0,
    }))
    .sort((a, b) => b.score_moyen - a.score_moyen
      || b.taux_participation - a.taux_participation
      || a.service.localeCompare(b.service, 'fr'));
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

  const lignes = db.prepare(`
    SELECT
      a.id,
      -- Droit d'opposition : l'agent compte pour son service mais n'est plus nomme
      CASE WHEN a.anonyme = 1 THEN 'Agent anonyme' ELSE a.nom_complet END AS nom_complet,
      a.anonyme,
      a.service,
      COALESCE(SUM(p.score), 0)  AS score_total,
      COUNT(p.id)                AS defis_joues,
      COALESCE(SUM(p.bonnes), 0) AS bonnes_total,
      MIN(p.termine_le)          AS premiere_participation
    FROM agents a
    JOIN participations p ON p.agent_id = a.id AND p.entrainement = 0
    WHERE a.exclu = 0
    GROUP BY a.id
    ORDER BY score_total DESC, defis_joues DESC, premiere_participation ASC
    LIMIT ?
  `).all(limite);

  // Meme lecture que pour les services : un pourcentage, et les points
  // rapportes au total atteignable a ce jour.
  return lignes.map((l) => ({
    ...l,
    points_possibles: possible,
    pourcentage: possible ? Math.round((l.score_total * 100) / possible) : 0,
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

/** Statistiques globales pour le tableau de bord et les mails. */
export function statistiquesGlobales() {
  const g = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM agents WHERE exclu = 0)                            AS inscrits,
      (SELECT COUNT(*) FROM agents WHERE exclu = 0 AND vu_le IS NOT NULL)      AS connectes,
      (SELECT COUNT(DISTINCT p.agent_id) FROM participations p
         JOIN agents a ON a.id = p.agent_id
        WHERE p.entrainement = 0 AND a.exclu = 0)                              AS joueurs,
      (SELECT COUNT(*) FROM participations WHERE entrainement = 0)             AS participations,
      -- Remplace plus bas par le nombre de directions reellement classees :
      -- compter les libelles distincts annoncait « 86 services en lice » sous
      -- un tableau qui n'en montrait que cinq.
      (SELECT COUNT(DISTINCT service) FROM agents WHERE exclu = 0)             AS services_distincts,
      (SELECT COALESCE(SUM(score), 0) FROM participations WHERE entrainement = 0) AS points_cumules
  `).get();

  const parDefi = db.prepare(`
    SELECT d.id, d.titre, d.ouvre_le,
           COUNT(p.id) AS participants,
           ROUND(AVG(CASE WHEN p.score_max > 0 THEN p.score * 100.0 / p.score_max END), 0) AS reussite_moyenne
    FROM defis d
    LEFT JOIN participations p ON p.defi_id = d.id AND p.entrainement = 0
    GROUP BY d.id ORDER BY d.ouvre_le, d.id
  `).all();

  return { ...g, services: classementServices().length, parDefi };
}
