import { db } from './db.js';
import { config } from './config.js';

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

/**
 * Cle de comparaison insensible a la casse, aux accents, a la ponctuation et
 * au pluriel. « Services Techniques », « Service Technique » et
 * « service techniques » donnent la meme cle, tout comme « Population &
 * Citoyennete » et « Population et Citoyennete ».
 *
 * Les annuaires reels sont remplis a la main sur des annees : ces variantes
 * d'orthographe y sont la regle, pas l'exception, et creeraient autant de
 * services distincts au classement.
 */
export function cleComparaison(nom) {
  return String(nom || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' et ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((mot) => mot.replace(/s$/, ''))
    .join(' ');
}

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

/**
 * Composition de chaque service affiche : quels libelles d'annuaire il agrege.
 * C'est la seule vue qui permette de verifier un regroupement apres coup.
 */
export function resumeRegroupements() {
  const lignes = db.prepare(`
    SELECT a.service,
           COALESCE(NULLIF(a.service_ad, ''), a.service) AS source,
           COUNT(*) AS effectif
    FROM agents a
    WHERE a.exclu = 0 AND a.origine <> 'local'
    GROUP BY a.service, source
    ORDER BY a.service COLLATE NOCASE, effectif DESC
  `).all();

  const parService = new Map();
  for (const l of lignes) {
    if (!parService.has(l.service)) parService.set(l.service, { service: l.service, effectif: 0, sources: [] });
    const s = parService.get(l.service);
    s.effectif += l.effectif;
    s.sources.push({ source: l.source, effectif: l.effectif });
  }
  return [...parService.values()].sort((a, b) => b.effectif - a.effectif);
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

    // Le nombre d'agents deplaces a l'instant ne dit rien de l'effet des regles :
    // reenregistrer les memes regles donne zero, alors que rien n'a change.
    const gouvernes = db.prepare(`
      SELECT COUNT(*) AS n FROM agents a
      JOIN regroupements_service g ON g.source = COALESCE(NULLIF(a.service_ad, ''), a.service)
      WHERE a.exclu = 0
    `).get().n;

    db.exec('COMMIT');
    return { touches, gouvernes };
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

  const sources = lignes.map((l) => l.source);
  const familles = detecterFamilles(sources);

  return lignes.map((l, i) => {
    const ous = chaines[i];

    // 1. Familles deduites des libelles eux-memes : c'est le cas le plus frequent
    //    quand les OU sont organisees par site plutot que par service.
    let proposition = familles.get(l.source) || null;

    // 2. A defaut, l'OU parente - mais seulement si le service VIENT des OU.
    //    Quand il est lu dans un attribut, l'arborescence decrit souvent des
    //    sites et non des services : proposer « TECHNOSUD » comme regroupement
    //    de « CCAS » n'aurait aucun sens.
    if (!proposition && config.service.source === 'ou') {
      for (let n = 1; n < ous.length; n++) {
        if (ous[n] !== l.source && !estGenerique(ous[n])) { proposition = ous[n]; break; }
      }
    }

    return {
      source: l.source,
      effectif: l.effectif,
      cible: regles[l.source] || l.source,
      regroupe: !!regles[l.source],
      chaineOu: ous,
      proposition: proposition && proposition !== l.source ? proposition : null,
    };
  });
}

/**
 * Deduit des regroupements a partir des libelles eux-memes, selon deux motifs
 * observes dans les annuaires de collectivite :
 *
 *   - le tiret separateur   « Jeunesse - Kid Club »        -> Jeunesse
 *   - le prefixe partage    « Crêche La Cigogne »,
 *                           « Crêche Petit Poucet »        -> Crêche
 *
 * Les orthographes divergentes d'un meme prefixe sont ramenees a la graphie la
 * plus repandue : sans cela « Services Techniques - Voirie » et « Service
 * Technique - Propreté » donneraient deux services distincts.
 */
export function detecterFamilles(sources, seuil = 2) {
  const candidats = new Map(); // source -> prefixe propose

  for (const source of sources) {
    const separe = source.split(/\s+[-–—]\s+/);
    if (separe.length > 1 && separe[0].trim()) candidats.set(source, separe[0].trim());
  }

  // Prefixe partage : on regroupe par premier mot, puis on retient le plus long
  // prefixe commun a TOUS les membres du groupe. Raisonner a longueur fixe
  // couperait « Crêche Petit Poucet » et « Crêche Petit Prince » sur
  // « Crêche Petit », alors que la famille est « Crêche ».
  const restants = sources.filter((s) => !candidats.has(s));
  const grappes = new Map();
  for (const source of restants) {
    const mots = source.split(' ');
    if (mots.length < 2) continue;
    const cle = cleComparaison(mots[0]);
    if (!grappes.has(cle)) grappes.set(cle, []);
    grappes.get(cle).push(source);
  }

  for (const membres of grappes.values()) {
    if (membres.length < seuil) continue;

    const motsPar = membres.map((s) => s.split(' '));
    const normalises = motsPar.map((mots) => mots.map((m) => cleComparaison(m)));

    let longueur = 0;
    const maximum = Math.min(...motsPar.map((m) => m.length));
    while (longueur < maximum
      && normalises.every((n) => n[longueur] === normalises[0][longueur])) longueur++;

    // Un membre entierement contenu dans le prefixe est le nom de la famille
    if (longueur === 0) continue;

    // « Cabinet de la Maire » et « Cabinet de Madame la Maire » ont pour prefixe
    // commun « Cabinet de » : on retire les mots outils finaux, qui ne font pas
    // un nom de service.
    const MOTS_OUTILS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'a', 'au', 'aux', 'en', 'd', 'l']);
    while (longueur > 1 && MOTS_OUTILS.has(cleComparaison(motsPar[0][longueur - 1]))) longueur--;

    // Graphie de reference : mot par mot, la plus frequente parmi les membres
    const prefixe = [];
    for (let i = 0; i < longueur; i++) {
      const compte = new Map();
      for (const mots of motsPar) compte.set(mots[i], (compte.get(mots[i]) || 0) + 1);
      // Depart au comptage : on retient la graphie la plus longue, donc la forme
      // ecrite en toutes lettres plutot qu'un symbole (« et » plutot que « & »).
      prefixe.push([...compte.entries()]
        .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0], 'fr'))[0][0]);
    }
    const famille = prefixe.join(' ');

    for (const source of membres) {
      if (source !== famille) candidats.set(source, famille);
    }
  }

  // Harmonisation des graphies : on retient la plus frequente de chaque famille
  const graphies = new Map();
  for (const prefixe of candidats.values()) {
    const cle = cleComparaison(prefixe);
    if (!graphies.has(cle)) graphies.set(cle, new Map());
    const compte = graphies.get(cle);
    compte.set(prefixe, (compte.get(prefixe) || 0) + 1);
  }
  const canonique = new Map();
  for (const [cle, compte] of graphies) {
    const meilleure = [...compte.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    canonique.set(cle, meilleure);
  }

  // Deux libelles qui ne different que par l'orthographe se rejoignent aussi
  const parCle = new Map();
  for (const source of sources) {
    const cle = cleComparaison(source);
    if (!parCle.has(cle)) parCle.set(cle, []);
    parCle.get(cle).push(source);
  }

  // Un libelle retenu comme nom de famille ne doit jamais etre redirige a son
  // tour : sans cette precaution, deux orthographes d'un meme service se
  // pointent mutuellement et le regroupement tourne en rond.
  const nomsDeFamille = new Set(
    [...candidats.values()].map((p) => canonique.get(cleComparaison(p)))
  );

  const familles = new Map();
  for (const source of sources) {
    if (candidats.has(source)) {
      const cible = canonique.get(cleComparaison(candidats.get(source)));
      if (cible !== source) familles.set(source, cible);
      continue;
    }
    if (nomsDeFamille.has(source)) continue;

    const jumeaux = parCle.get(cleComparaison(source));
    if (jumeaux.length > 1) {
      const cible = [...jumeaux].sort((a, b) => b.length - a.length || a.localeCompare(b, 'fr'))[0];
      if (cible !== source) familles.set(source, cible);
    }
  }
  return familles;
}
