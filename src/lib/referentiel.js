import { db, journaliser } from './db.js';
import { cleComparaison, normaliser, resoudreService } from './services.js';

/**
 * Referentiel des services.
 *
 * Sans lui, chaque regroupement se saisissait en texte libre : deux graphies
 * suffisaient a creer deux services, et rien ne disait quels services la
 * collectivite reconnait vraiment.
 *
 * Le referentiel est la liste de reference - celle que la DSI maintient - et
 * le regroupement ne fait plus que pointer dessus. C'est aussi ce qui permet
 * de preparer la liste AVANT de savoir ce que contient l'annuaire.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS referentiel_services (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  nom     TEXT NOT NULL UNIQUE,
  ordre   INTEGER NOT NULL DEFAULT 0,
  actif   INTEGER NOT NULL DEFAULT 1,
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export const lireReferentiel = () =>
  db.prepare('SELECT id, nom, ordre, actif FROM referentiel_services ORDER BY ordre, nom COLLATE NOCASE').all();

export const nomsReferentiel = () =>
  db.prepare('SELECT nom FROM referentiel_services WHERE actif = 1 ORDER BY ordre, nom COLLATE NOCASE')
    .all().map((s) => s.nom);

/**
 * Etat du referentiel confronte aux donnees : combien d'agents par service,
 * et quels services utilises n'y figurent pas encore.
 */
export function etatReferentiel() {
  const reference = lireReferentiel();
  const utilises = db.prepare(`
    SELECT service, COUNT(*) AS effectif
    FROM agents WHERE exclu = 0 AND origine <> 'local'
    GROUP BY service
  `).all();

  const parCle = new Map(utilises.map((u) => [cleComparaison(u.service), u]));
  const clesReference = new Set(reference.map((r) => cleComparaison(r.nom)));

  return {
    services: reference.map((r) => ({
      ...r,
      effectif: parCle.get(cleComparaison(r.nom))?.effectif || 0,
    })),
    // Utilises mais absents du referentiel : ce sont eux qu'il reste a traiter
    horsReferentiel: utilises
      .filter((u) => !clesReference.has(cleComparaison(u.service)))
      .sort((a, b) => b.effectif - a.effectif),
  };
}

/**
 * Remplace le referentiel par la liste fournie, dans l'ordre donne.
 *
 * Chaque entree est un nom, ou un objet { id, nom } quand elle vient de
 * l'ecran d'edition. L'identifiant est ce qui permet de reconnaitre un
 * renommage : sans lui, « Finances » devenu « Direction des finances » serait
 * une suppression suivie d'une creation, et les agents resteraient rattaches
 * a l'ancien nom - celui que le classement continuerait d'afficher.
 */
export function enregistrerReferentiel(entrees, parQui) {
  const existants = new Map(lireReferentiel().map((s) => [s.id, s.nom]));
  const propres = [];
  const renommages = [];
  const vues = new Set();
  for (const entree of entrees) {
    const objet = typeof entree === 'object' && entree !== null;
    const nom = normaliser(objet ? entree.nom : entree);
    if (!nom) continue;
    const cle = cleComparaison(nom);
    if (vues.has(cle)) continue; // deux graphies du meme service : on garde la premiere
    vues.add(cle);
    propres.push(nom);

    const ancien = objet ? existants.get(Number(entree.id)) : null;
    if (ancien && ancien !== nom) renommages.push({ ancien, nouveau: nom });
  }

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM referentiel_services');
    const inserer = db.prepare('INSERT INTO referentiel_services (nom, ordre) VALUES (?, ?)');
    propres.forEach((nom, i) => inserer.run(nom, i));
    for (const r of renommages) propagerRenommage(r.ancien, r.nouveau);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const detail = `${propres.length} service(s)`
    + (renommages.length ? `, renomme(s) : ${renommages.map((r) => `${r.ancien} -> ${r.nouveau}`).join(', ')}` : '');
  journaliser(parQui, 'referentiel_enregistre', detail, null);
  return propres.length;
}

/**
 * Un service renomme reste le meme service : ses agents le suivent, y compris
 * ceux rattaches a la main, et les regles qui pointaient sur l'ancien nom
 * visent desormais le nouveau. L'ancien nom devient lui-meme une regle, pour
 * qu'un agent dont l'annuaire dit encore « Finances » ne retombe pas sur
 * l'ancien service a sa prochaine connexion.
 */
function propagerRenommage(ancien, nouveau) {
  db.prepare('UPDATE regroupements_service SET cible = ? WHERE cible = ?').run(nouveau, ancien);
  // Une regle « nouveau -> x » ferait boucler la resolution : elle n'a plus de sens
  db.prepare('DELETE FROM regroupements_service WHERE source = ?').run(nouveau);
  db.prepare('INSERT INTO regroupements_service (source, cible) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET cible = excluded.cible')
    .run(ancien, nouveau);
  db.prepare('UPDATE agents SET service = ? WHERE service = ?').run(nouveau, ancien);
}

/** Alimente le referentiel a partir des services reellement utilises. */
export function initialiserDepuisDonnees(parQui) {
  const utilises = db.prepare(`
    SELECT service, COUNT(*) AS n FROM agents
    WHERE exclu = 0 AND origine <> 'local' AND service <> 'Non rattache'
    GROUP BY service ORDER BY n DESC
  `).all().map((s) => s.service);

  const existants = nomsReferentiel();
  const cles = new Set(existants.map(cleComparaison));
  const ajoutes = utilises.filter((s) => !cles.has(cleComparaison(s)));

  return enregistrerReferentiel([...existants, ...ajoutes], parQui) - existants.length >= 0
    ? { total: existants.length + ajoutes.length, ajoutes: ajoutes.length }
    : { total: 0, ajoutes: 0 };
}

/**
 * Analyse un collage : une ligne par service, ou une liste separee par des
 * virgules ou des points-virgules. On accepte aussi un numero en tete de ligne,
 * comme dans une liste copiee depuis une page web.
 */
export function analyserCollage(texte) {
  return String(texte || '')
    .split(/[\r\n;,]+/)
    .map((l) => l.replace(/^\s*\d+[.)\-–]\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Rapproche chaque libellé d'annuaire d'un service du referentiel.
 * Le rapprochement est souple - casse, accents, pluriel - puis se rabat sur
 * une correspondance par prefixe : « Jeunesse - Kid Club » retombe sur
 * « Jeunesse » si ce service figure au referentiel.
 */
export function suggererDepuisReferentiel(libelle) {
  const noms = nomsReferentiel();
  if (!noms.length) return null;

  const cle = cleComparaison(libelle);
  const exact = noms.find((n) => cleComparaison(n) === cle);
  if (exact) return exact;

  // Le service du referentiel dont le nom ouvre le libelle, le plus long d'abord
  const candidats = noms
    .filter((n) => cle.startsWith(`${cleComparaison(n)} `))
    .sort((a, b) => cleComparaison(b).length - cleComparaison(a).length);
  return candidats[0] || null;
}

/** Applique le referentiel : chaque libellé qui lui correspond y est rattache. */
export function appliquerReferentiel(parQui) {
  const libelles = db.prepare(`
    SELECT DISTINCT COALESCE(NULLIF(service_ad, ''), service) AS source
    FROM agents WHERE exclu = 0 AND service_force = 0
  `).all().map((l) => l.source);

  const regles = [];
  for (const source of libelles) {
    const cible = suggererDepuisReferentiel(source);
    if (cible && cible !== source) regles.push({ source, cible });
  }

  if (!regles.length) return { regles: 0, touches: 0 };

  const inserer = db.prepare(
    'INSERT INTO regroupements_service (source, cible) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET cible = excluded.cible'
  );
  const maj = db.prepare('UPDATE agents SET service = ? WHERE id = ?');

  db.exec('BEGIN');
  let touches = 0;
  try {
    for (const r of regles) inserer.run(r.source, r.cible);
    for (const a of db.prepare('SELECT id, service, service_ad FROM agents WHERE service_force = 0').all()) {
      const cible = resoudreService(a.service_ad || a.service);
      if (cible !== a.service) { maj.run(cible, a.id); touches++; }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  journaliser(parQui, 'referentiel_applique', `${regles.length} regle(s), ${touches} agent(s)`, null);
  return { regles: regles.length, touches };
}
