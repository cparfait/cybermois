import { cleComparaison } from './services.js';

/**
 * Rapprochement d'un libellé d'annuaire avec un service du referentiel.
 *
 * L'egalite stricte ne suffit pas : les deux listes sont ecrites par des
 * personnes differentes, a des annees d'intervalle. « CTM » et « Centre
 * Technique municipal » designent le meme service sans partager un caractere,
 * « Jeunesse » et « Service Jeunesse » different d'un mot vide de sens.
 *
 * On combine donc plusieurs indices, chacun repondant a un cas observe :
 *
 *   sigle           CTM              -> Centre Technique municipal
 *   inclusion       Jeunesse         -> Service Jeunesse
 *   prefixe         Crêche La Cigogne-> Petite Enfance (via mot-cle)
 *   mots partages   Marches Publics  -> Achats et Commande Publique (faible)
 *
 * Chaque proposition sort avec un niveau de confiance, parce qu'une suggestion
 * fausse presentee comme sure coute plus cher que pas de suggestion du tout.
 */

// Mots trop frequents pour distinguer deux services : les compter ferait
// ressembler « Service Jeunesse » a « Service Technique ».
const MOTS_VIDES = new Set([
  'de', 'du', 'des', 'la', 'le', 'les', 'et', 'a', 'au', 'aux', 'en', 'd', 'l',
  'service', 'services', 'direction', 'pole', 'poles', 'son', 'sa', 'ses',
  'avec', 'pour', 'sur', 'par',
]);

const mots = (texte) => cleComparaison(texte).split(' ').filter(Boolean);
const motsUtiles = (texte) => mots(texte).filter((m) => !MOTS_VIDES.has(m));

/** Initiales des mots significatifs : « Centre Technique municipal » -> ctm */
function sigle(texte) {
  const m = motsUtiles(texte);
  return m.length >= 2 ? m.map((x) => x[0]).join('') : '';
}

/**
 * Pondere chaque mot par sa rarete dans le referentiel : « urbaine » vaut plus
 * que « generale », qui revient partout.
 */
function poids(referentiel) {
  const frequence = new Map();
  for (const r of referentiel) {
    for (const m of new Set(motsUtiles(r))) frequence.set(m, (frequence.get(m) || 0) + 1);
  }
  const total = referentiel.length || 1;
  return (mot) => Math.log(1 + total / (1 + (frequence.get(mot) || 0)));
}

/** Distance de Levenshtein bornee, pour rattraper une faute de frappe. */
function proche(a, b, tolerance = 2) {
  if (Math.abs(a.length - b.length) > tolerance) return false;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let precedent = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tampon = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, precedent + (a[i - 1] === b[j - 1] ? 0 : 1));
      precedent = tampon;
    }
  }
  return d[b.length] <= tolerance;
}

/**
 * Score de 0 a 100 entre un libellé et un service.
 * Les regles sont ordonnees de la plus sure a la plus fragile.
 */
export function scorer(libelle, service, peser) {
  const cl = cleComparaison(libelle);
  const cs = cleComparaison(service);
  if (!cl || !cs) return { score: 0, motif: null };

  if (cl === cs) return { score: 100, motif: 'libellés identiques' };

  // « Jeunesse » dans « Service Jeunesse », ou l'inverse
  if (cl.startsWith(`${cs} `) || cl.endsWith(` ${cs}`) || cl.includes(` ${cs} `)) {
    return { score: 92, motif: `« ${service} » est contenu dans le libellé` };
  }
  if (cs.startsWith(`${cl} `) || cs.endsWith(` ${cl}`) || cs.includes(` ${cl} `)) {
    return { score: 88, motif: `le libellé est contenu dans « ${service} »` };
  }

  // Sigle : CTM -> Centre Technique municipal
  const s = sigle(service);
  if (s && s.length >= 2 && cl.replace(/ /g, '') === s) {
    return { score: 90, motif: `sigle de « ${service} »` };
  }
  const sl = sigle(libelle);
  if (sl && sl.length >= 2 && cs.replace(/ /g, '') === sl) {
    return { score: 86, motif: `« ${service} » est le sigle du libellé` };
  }

  const ml = motsUtiles(libelle);
  const ms = motsUtiles(service);
  if (!ml.length || !ms.length) return { score: 0, motif: null };

  // Mots partages, ponderes par leur rarete
  const ensembleS = new Set(ms);
  let commun = 0; let totalL = 0;
  const partages = [];
  for (const m of new Set(ml)) {
    const p = peser(m);
    totalL += p;
    if (ensembleS.has(m)) { commun += p; partages.push(m); continue; }
    // Faute de frappe ou variante : « administation » / « administration »
    const voisin = ms.find((x) => x.length > 5 && proche(m, x));
    if (voisin) { commun += p * 0.85; partages.push(m); }
  }
  if (!commun) return { score: 0, motif: null };

  const totalS = ms.reduce((n, m) => n + peser(m), 0);
  // Moyenne harmonique : un libellé long qui partage un mot avec un service
  // court ne doit pas obtenir un score eleve.
  const couvertureL = commun / totalL;
  const couvertureS = commun / totalS;
  const harmonique = (2 * couvertureL * couvertureS) / (couvertureL + couvertureS);

  return {
    score: Math.round(harmonique * 80),
    motif: `mots en commun : ${partages.join(', ')}`,
  };
}

/**
 * Propose, pour chaque libellé, les meilleurs services du referentiel.
 *
 * Les seuils sont volontairement prudents : mieux vaut ne rien proposer que
 * de faire basculer trente agents dans le mauvais service.
 */
export function rapprocher(libelles, referentiel, { maximum = 3 } = {}) {
  const peser = poids(referentiel);

  return libelles.map((l) => {
    const libelle = typeof l === 'string' ? l : l.libelle;
    const effectif = typeof l === 'string' ? 0 : (l.effectif || 0);

    const candidats = referentiel
      .map((service) => ({ service, ...scorer(libelle, service, peser) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maximum);

    const meilleur = candidats[0] || null;
    const second = candidats[1] || null;

    // Un ecart faible entre les deux premiers signale une ambiguite reelle :
    // « Maison des Arts » hesite entre plusieurs « Maison des … ».
    const ambigu = !!(meilleur && second && meilleur.score - second.score < 8);

    let confiance = 'aucune';
    if (meilleur) {
      if (meilleur.score >= 85 && !ambigu) confiance = 'sure';
      else if (meilleur.score >= 60) confiance = 'probable';
      else if (meilleur.score >= 35) confiance = 'incertaine';
    }

    return {
      libelle,
      effectif,
      confiance,
      ambigu,
      proposition: confiance === 'aucune' ? null : meilleur.service,
      motif: meilleur?.motif || null,
      score: meilleur?.score || 0,
      candidats,
    };
  });
}
