import { db } from './db.js';

/**
 * Regroupement des services.
 *
 * Un annuaire reel comporte des sous-OU : « Creches », « Ecoles » et
 * « Restauration scolaire » sont trois OU distinctes qui, pour la campagne,
 * doivent compter comme un seul service « Affaires scolaires ».
 *
 * Plutot que d'imposer une profondeur d'OU uniforme - qui ne marche jamais,
 * car toutes les branches n'ont pas la meme profondeur - on tient une table de
 * correspondance « ce que dit l'annuaire -> service affiche ».
 *
 * Elle s'applique aux deux chemins d'entree : la connexion d'un agent et
 * l'import d'un effectif. Le libelle brut est conserve dans agents.service_ad,
 * ce qui permet de rejouer un regroupement a tout moment sans reimporter.
 */

export const normaliser = (nom) => String(nom || '').replace(/\s+/g, ' ').trim();

/** Chaine complete des OU d'un DN, de la plus proche de l'agent a la plus haute. */
export function chaineOu(dn) {
  if (!dn) return [];
  const ous = [];
  for (const rdn of String(dn).split(/(?<!\\),/)) {
    const m = rdn.trim().match(/^OU=(.+)$/i);
    if (m) ous.push(m[1].replace(/\\(.)/g, '$1').trim());
  }
  return ous;
}

/** Applique la table de correspondance. Sans regle, le libelle brut est conserve. */
export function resoudreService(brut) {
  const source = normaliser(brut);
  if (!source) return 'Non rattache';
  const regle = db.prepare('SELECT cible FROM regroupements_service WHERE source = ?').get(source);
  return regle ? regle.cible : source;
}

export function lireRegroupements() {
  return db.prepare('SELECT source, cible FROM regroupements_service ORDER BY cible, source').all();
}

/** Remplace l'integralite des regles, puis recalcule le service de tous les agents. */
export function enregistrerRegroupements(regles) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM regroupements_service');
    const inserer = db.prepare('INSERT INTO regroupements_service (source, cible) VALUES (?, ?)');
    for (const r of regles) {
      const source = normaliser(r.source);
      const cible = normaliser(r.cible);
      // Une regle qui ne change rien est inutile a stocker
      if (source && cible && source !== cible) inserer.run(source, cible);
    }
    const touches = appliquerRegroupements();
    db.exec('COMMIT');
    return touches;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Recalcule agents.service a partir de agents.service_ad et des regles en vigueur. */
export function appliquerRegroupements() {
  const agents = db.prepare('SELECT id, service, service_ad FROM agents').all();
  const maj = db.prepare('UPDATE agents SET service = ? WHERE id = ?');
  let touches = 0;

  for (const a of agents) {
    // Les fiches anterieures a cette fonctionnalite n'ont pas de service_ad :
    // on prend leur service actuel comme libelle d'origine.
    const brut = a.service_ad || a.service;
    const cible = resoudreService(brut);
    if (cible !== a.service) { maj.run(cible, a.id); touches++; }
  }
  return touches;
}

/**
 * Inventaire des libelles bruts presents en base, avec une proposition de
 * regroupement. La proposition s'appuie sur l'OU parente du DN : c'est
 * exactement le regroupement recherche dans la majorite des cas.
 */
export function inventaireServices() {
  const lignes = db.prepare(`
    SELECT
      COALESCE(NULLIF(a.service_ad, ''), a.service) AS source,
      COUNT(*)                                      AS effectif,
      MIN(a.service_brut)                           AS exemple_dn,
      MIN(a.service)                                AS service_actuel
    FROM agents a
    WHERE a.exclu = 0
    GROUP BY source
    ORDER BY source
  `).all();

  const regles = Object.fromEntries(lireRegroupements().map((r) => [r.source, r.cible]));
  const chaines = lignes.map((l) => chaineOu(l.exemple_dn));

  // Une OU presente dans la quasi-totalite des branches est un conteneur
  // technique (« Agents », « Utilisateurs », « Personnel »), pas un service :
  // la proposer comme regroupement fusionnerait toute la collectivite.
  const avecOu = chaines.filter((c) => c.length).length;
  const frequence = new Map();
  for (const c of chaines) {
    for (const ou of new Set(c)) frequence.set(ou, (frequence.get(ou) || 0) + 1);
  }
  const estGenerique = (ou) => avecOu > 1 && frequence.get(ou) >= avecOu;

  return lignes.map((l, i) => {
    const ous = chaines[i];
    // On remonte l'arborescence jusqu'a la premiere OU qui soit un vrai
    // regroupement metier, en sautant les conteneurs techniques.
    let proposition = null;
    for (let n = 1; n < ous.length; n++) {
      if (ous[n] !== l.source && !estGenerique(ous[n])) { proposition = ous[n]; break; }
    }
    return {
      source: l.source,
      effectif: l.effectif,
      cible: regles[l.source] || l.source,
      regroupe: !!regles[l.source],
      chaineOu: ous,
      proposition,
    };
  });
}
