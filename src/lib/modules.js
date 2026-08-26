import fs from 'node:fs';
import path from 'node:path';
import { db, journaliser } from './db.js';
import { ajouterColonne } from './db.js';

/**
 * Catalogue de modules et programmation des semaines.
 *
 * Un module est un questionnaire complet, ecrit une fois pour toutes dans
 * content/modules. Il ne connait pas la semaine ou il sera joue : c'est la
 * programmation qui l'y place. Sans cette separation, changer l'ordre des
 * themes obligeait a renommer des fichiers et a deplacer du contenu.
 *
 * On peut donc preparer vingt modules et n'en jouer que quatre, ou decaler
 * tout le calendrier sans toucher a une seule question.
 */

const DOSSIER = path.resolve(process.cwd(), 'content', 'modules');

db.exec(`
CREATE TABLE IF NOT EXISTS programme (
  semaine     INTEGER PRIMARY KEY,
  module_code TEXT NOT NULL,
  maj_le      TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Le defi porte le module qu'il joue : c'est ce qui permet de savoir, une fois
// la campagne finie, quel questionnaire a reellement ete pose.
ajouterColonne('defis', 'module_code', 'TEXT');

/** Lit un module du catalogue. Renvoie null s'il n'existe pas. */
export function lireModule(code) {
  const fichier = path.join(DOSSIER, `${path.basename(code)}.json`);
  if (!fs.existsSync(fichier)) return null;
  const m = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  return { ...m, code: m.code || path.basename(code) };
}

/**
 * Catalogue complet, trie par theme puis par titre. On expose l'essentiel -
 * de quoi choisir - sans le detail des reponses, qui ne regarde pas l'ecran
 * de programmation.
 */
export function listerModules() {
  if (!fs.existsSync(DOSSIER)) return [];
  return fs.readdirSync(DOSSIER)
    .filter((f) => f.endsWith('.json'))
    .map((f) => lireModule(f.replace(/\.json$/, '')))
    .filter(Boolean)
    .map((m) => ({
      code: m.code,
      theme: m.theme || 'Divers',
      titre: m.titre,
      accroche: m.accroche,
      intro: m.intro,
      duree_minutes: m.duree_minutes || 7,
      badge: m.badge || null,
      questions: m.questions.length,
      points: m.questions.reduce((n, q) => n + (q.points || 10), 0),
    }))
    .sort((a, b) => a.theme.localeCompare(b.theme, 'fr') || a.titre.localeCompare(b.titre, 'fr'));
}

export const lireProgramme = () =>
  db.prepare('SELECT semaine, module_code FROM programme ORDER BY semaine').all();

/**
 * Etat des semaines : ce qui est programme, ce qui est deja joue, et ce qu'on
 * peut encore changer. Un questionnaire deja joue ne se remplace pas : les
 * participations enregistrees porteraient sur des questions disparues.
 */
export function etatProgramme() {
  const defis = db.prepare(`
    SELECT d.semaine, d.id, d.titre, d.module_code, d.ouvre_le, d.publie,
           (SELECT COUNT(*) FROM participations p WHERE p.defi_id = d.id) AS participations
    FROM defis d ORDER BY d.semaine
  `).all();
  const parSemaine = new Map(defis.map((d) => [d.semaine, d]));

  return lireProgramme().map((p) => {
    const d = parSemaine.get(p.semaine);
    return {
      semaine: p.semaine,
      module_code: p.module_code,
      titre: d?.titre || lireModule(p.module_code)?.titre || null,
      ouvre_le: d?.ouvre_le || null,
      publie: d ? !!d.publie : false,
      participations: d?.participations || 0,
      verrouille: (d?.participations || 0) > 0,
    };
  });
}

/**
 * Enregistre la programmation. Chaque entree est { semaine, module_code } ;
 * une semaine absente de la liste est deprogrammee.
 *
 * Le contenu n'est pas copie ici : c'est importerContenus() qui, ensuite,
 * verse les questions dans les defis. Separer les deux evite qu'un simple
 * changement d'ordre ne reecrive quatre questionnaires.
 */
export function enregistrerProgramme(entrees, parQui) {
  const propres = [];
  const vues = new Set();
  for (const e of entrees) {
    const semaine = Number(e.semaine);
    const code = String(e.module_code || '').trim();
    if (!Number.isInteger(semaine) || semaine < 1 || !code) continue;
    if (vues.has(semaine)) continue;
    if (!lireModule(code)) throw new Error(`Module inconnu : ${code}`);
    vues.add(semaine);
    propres.push({ semaine, code });
  }

  // Une semaine deja jouee ne se reprogramme pas : les participations
  // enregistrees porteraient sur des questions qui n'existeraient plus.
  const jouees = db.prepare(`
    SELECT d.semaine, d.module_code FROM defis d
    WHERE (SELECT COUNT(*) FROM participations p WHERE p.defi_id = d.id) > 0
  `).all();
  for (const j of jouees) {
    const demande = propres.find((p) => p.semaine === j.semaine);
    if (j.module_code && demande && demande.code !== j.module_code) {
      throw new Error(
        `La semaine ${j.semaine} a deja ete jouee : son module ne peut plus changer.`
      );
    }
  }

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM programme');
    const inserer = db.prepare('INSERT INTO programme (semaine, module_code) VALUES (?, ?)');
    for (const p of propres) inserer.run(p.semaine, p.code);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  journaliser(parQui, 'programme_enregistre',
    propres.map((p) => `S${p.semaine}=${p.code}`).join(', ') || 'aucune semaine', null);
  return propres.length;
}
