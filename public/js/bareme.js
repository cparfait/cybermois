/**
 * Bareme d'un defi : dix questions, cent points, toujours.
 *
 * Deux exigences qui semblent contradictoires se rejoignent ici.
 *
 * 1. Une question difficile doit rapporter plus qu'une question de reflexe.
 *    Tout compter a dix points revenait a dire qu'ouvrir une piece jointe et
 *    reconnaitre une signature de domaine se valent.
 *
 * 2. Deux defis doivent peser le meme poids au classement. Sans cela, la
 *    semaine ou le questionnaire vaut 115 points decide du classement a la
 *    place des agents : celui qui a manque cette semaine-la ne rattrape plus,
 *    quoi qu'il fasse ensuite. C'est arrive - les modules allaient de 70 a
 *    115 points.
 *
 * La solution tient en une repartition fixe. Chaque defi porte trois questions
 * faciles, quatre moyennes et trois difficiles : 3x5 + 4x10 + 3x15 = 100.
 * La difficulte fait foi, les points en decoulent - personne ne saisit un
 * nombre de points a la main, et aucun defi ne peut donc deriver.
 */

export const NIVEAUX = [
  {
    cle: 'facile', libelle: 'Facile', points: 5, attendues: 3,
    aide: 'Un reflexe, une definition, un geste connu. La bonne reponse se voit.',
  },
  {
    cle: 'moyen', libelle: 'Moyenne', points: 10, attendues: 4,
    aide: 'Il faut choisir entre plusieurs conduites plausibles, ou repérer un détail.',
  },
  {
    cle: 'difficile', libelle: 'Difficile', points: 15, attendues: 3,
    aide: 'Cas limite, piège connu, procédure : une réponse fausse s\'y défend bien.',
  },
];

export const QUESTIONS_PAR_DEFI = NIVEAUX.reduce((n, x) => n + x.attendues, 0);
export const TOTAL_DEFI = NIVEAUX.reduce((n, x) => n + x.attendues * x.points, 0);

const PAR_CLE = new Map(NIVEAUX.map((n) => [n.cle, n]));

/**
 * Niveau d'une question. Les questionnaires ecrits avant le bareme ne portent
 * qu'un nombre de points : on le traduit, plutot que de les declarer invalides.
 */
export function niveauDe(question) {
  const cle = String(question?.difficulte || '').trim().toLowerCase();
  if (PAR_CLE.has(cle)) return PAR_CLE.get(cle);

  const points = Number(question?.points);
  if (Number.isFinite(points)) {
    // Le niveau dont le bareme est le plus proche des points d'origine
    return NIVEAUX.reduce((meilleur, n) =>
      (Math.abs(n.points - points) < Math.abs(meilleur.points - points) ? n : meilleur));
  }
  return PAR_CLE.get('moyen');
}

export const pointsDe = (question) => niveauDe(question).points;
export const libelleNiveau = (cle) => PAR_CLE.get(String(cle || '').toLowerCase())?.libelle || null;

/**
 * Confronte un questionnaire au bareme.
 *
 * Renvoie toujours le detail plutot qu'un simple oui/non : l'editeur du
 * back-office doit pouvoir dire ce qui manque - « il manque une question
 * difficile » est une consigne, « barème non respecté » n'en est pas une.
 */
export function verifierBareme(questions) {
  const liste = Array.isArray(questions) ? questions : [];
  const comptes = Object.fromEntries(NIVEAUX.map((n) => [n.cle, 0]));
  let total = 0;

  for (const q of liste) {
    const niveau = niveauDe(q);
    comptes[niveau.cle]++;
    total += niveau.points;
  }

  const ecarts = [];
  if (liste.length !== QUESTIONS_PAR_DEFI) {
    ecarts.push(`${liste.length} question(s) au lieu de ${QUESTIONS_PAR_DEFI}`);
  }
  for (const n of NIVEAUX) {
    if (comptes[n.cle] === n.attendues) continue;
    const manque = n.attendues - comptes[n.cle];
    ecarts.push(manque > 0
      ? `il manque ${manque} question(s) « ${n.libelle} »`
      : `${-manque} question(s) « ${n.libelle} » de trop`);
  }

  return { ok: ecarts.length === 0, total, attendu: TOTAL_DEFI, repartition: comptes, ecarts };
}

/** Phrase courte pour le back-office : « 10 questions · 100 points · conforme ». */
export function resumeBareme(questions) {
  const v = verifierBareme(questions);
  return v.ok
    ? `${QUESTIONS_PAR_DEFI} questions · ${v.total} points · barème respecté`
    : `${(questions || []).length} question(s) · ${v.total} points · ${v.ecarts.join(', ')}`;
}
