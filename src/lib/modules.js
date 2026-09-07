import fs from 'node:fs';
import path from 'node:path';
import { db, journaliser } from './db.js';
import { ajouterColonne } from './db.js';

/**
 * Catalogue de modules et programmation des parutions.
 *
 * Un module est un questionnaire complet, ecrit une fois pour toutes dans
 * content/modules. Il ne connait pas sa date de parution : c'est la
 * programmation qui la lui donne. Sans cette separation, changer l'ordre des
 * themes obligeait a renommer des fichiers et a deplacer du contenu.
 *
 * Chaque module programme porte sa propre date, saisie a la main. Rien
 * n'impose un defi par semaine : on peut en faire paraitre deux le meme jour,
 * ou laisser passer quinze jours entre deux.
 */

const DOSSIER = path.resolve(process.cwd(), 'content', 'modules');

db.exec(`
CREATE TABLE IF NOT EXISTS programme (
  module_code TEXT PRIMARY KEY,
  ouvre_le    TEXT NOT NULL,
  maj_le      TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Le defi porte le module qu'il joue : c'est ce qui permet de savoir, une fois
// la campagne finie, quel questionnaire a reellement ete pose.
ajouterColonne('defis', 'module_code', 'TEXT');

// Jeton d'apercu : permet de faire jouer un defi avant son ouverture, sans que
// le resultat compte. Nul par defaut - un apercu se demande, il ne trouve pas
// une porte ouverte par accident.
ajouterColonne('defis', 'jeton_apercu', 'TEXT');

// Video d'introduction, presentee avant les questions. Facultative.
ajouterColonne('defis', 'video_url', 'TEXT');
ajouterColonne('defis', 'video_titre', 'TEXT');

/**
 * Le defi a ete retouche dans le back-office.
 *
 * Le rechargement des contenus rejoue les fichiers du catalogue dans les
 * defis, et il s'execute a chaque demarrage du serveur. Une question corrigee
 * a la main sur un defi que personne n'avait encore joue etait donc effacee au
 * redemarrage suivant, sans que rien ne le signale : on retrouvait le texte du
 * module, et on croyait avoir mal enregistre.
 *
 * Ce drapeau rend la correction plus forte que le fichier. Il ne se leve que
 * par un rechargement force, qui dit explicitement vouloir revenir au module.
 */
const drapeauInexistant = !db.prepare('PRAGMA table_info(defis)').all()
  .some((c) => c.name === 'contenu_modifie');
ajouterColonne('defis', 'contenu_modifie', 'INTEGER NOT NULL DEFAULT 0');

/** Lit un module du catalogue. Renvoie null s'il n'existe pas. */
export function lireModule(code) {
  const fichier = path.join(DOSSIER, `${path.basename(code)}.json`);
  if (!fs.existsSync(fichier)) return null;
  const m = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  return { ...m, code: m.code || path.basename(code) };
}

/**
 * Rattrapage, une seule fois : les defis qui different deja de leur module ont
 * ete retouches avant que le drapeau n'existe.
 *
 * Sans cela, la protection n'aurait servi qu'aux corrections a venir, et le
 * premier redemarrage aurait emporte celles qui l'ont motivee. On compare le
 * texte des questions et des propositions : c'est ce que quelqu'un corrige.
 */
export function marquerLesDefisDejaRetouches() {
  const empreinte = (questions) => JSON.stringify(questions.map((q) => [
    String(q.enonce || '').trim(),
    String(q.contexte || '').trim(),
    q.multiple ? 1 : 0,
    Number(q.points) || 10,
    String(q.explication || '').trim(),
    (q.reponses || []).map((r) => [String(r.libelle || '').trim(), r.correcte ? 1 : 0]),
  ]));

  for (const d of db.prepare('SELECT id, module_code, titre, accroche, intro FROM defis WHERE module_code IS NOT NULL').all()) {
    const module = lireModule(d.module_code);
    if (!module) continue;

    const questions = db.prepare('SELECT * FROM questions WHERE defi_id = ? ORDER BY ordre').all(d.id)
      .map((q) => ({
        ...q,
        reponses: db.prepare('SELECT libelle, correcte FROM reponses WHERE question_id = ? ORDER BY ordre').all(q.id),
      }));

    const differe = empreinte(questions) !== empreinte(module.questions)
      || d.titre !== module.titre || d.accroche !== module.accroche || d.intro !== module.intro;

    if (differe) db.prepare('UPDATE defis SET contenu_modifie = 1 WHERE id = ?').run(d.id);
  }
}

if (drapeauInexistant) marquerLesDefisDejaRetouches();

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
      video: m.video || null,
      questions: m.questions.length,
      points: m.questions.reduce((n, q) => n + (q.points || 10), 0),
    }))
    .sort((a, b) => a.theme.localeCompare(b.theme, 'fr') || a.titre.localeCompare(b.titre, 'fr'));
}

export const lireProgramme = () =>
  db.prepare('SELECT module_code, ouvre_le FROM programme ORDER BY ouvre_le, module_code').all();

/**
 * Etat du programme : ce qui est prevu, ce qui est deja joue, et ce qu'on peut
 * encore changer. Un questionnaire deja joue ne se deprogramme pas : les
 * participations enregistrees porteraient sur des questions disparues.
 */
export function etatProgramme() {
  const defis = db.prepare(`
    SELECT d.id, d.titre, d.module_code, d.ouvre_le, d.publie,
           (SELECT COUNT(*) FROM participations p WHERE p.defi_id = d.id) AS participations
    FROM defis d WHERE d.module_code IS NOT NULL
  `).all();
  const parModule = new Map(defis.map((d) => [d.module_code, d]));

  return lireProgramme().map((p) => {
    const d = parModule.get(p.module_code);
    return {
      id: d?.id || null,
      module_code: p.module_code,
      titre: d?.titre || lireModule(p.module_code)?.titre || null,
      ouvre_le: p.ouvre_le,
      publie: d ? !!d.publie : false,
      participations: d?.participations || 0,
      verrouille: (d?.participations || 0) > 0,
    };
  });
}

/**
 * Enregistre la programmation. Chaque entree est { module_code, ouvre_le } ;
 * un module absent de la liste est deprogramme.
 *
 * La date est obligatoire et propre a chaque module : c'est elle, et elle
 * seule, qui fait paraitre le defi. Deux modules peuvent porter la meme.
 *
 * Le contenu n'est pas copie ici : c'est importerContenus() qui, ensuite,
 * verse les questions dans les defis. Separer les deux evite qu'un simple
 * changement de date ne reecrive quatre questionnaires.
 */
export function enregistrerProgramme(entrees, parQui) {
  const propres = [];
  const vues = new Set();
  for (const e of entrees) {
    const code = String(e.module_code || '').trim();
    if (!code || vues.has(code)) continue;
    if (!lireModule(code)) throw new Error(`Module inconnu : ${code}`);

    const date = String(e.ouvre_le || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Date de parution manquante ou invalide pour le module ${code}.`);
    }

    vues.add(code);
    propres.push({ code, date });
  }

  // Un module deja joue ne se deprogramme pas : les participations
  // enregistrees porteraient sur des questions qui n'existeraient plus.
  const jouees = db.prepare(`
    SELECT DISTINCT d.module_code FROM defis d
    WHERE d.module_code IS NOT NULL
      AND (SELECT COUNT(*) FROM participations p WHERE p.defi_id = d.id) > 0
  `).all();
  for (const j of jouees) {
    if (!vues.has(j.module_code)) {
      throw new Error(
        `Le module ${j.module_code} a deja ete joue : il ne peut plus etre deprogramme.`
      );
    }
  }

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM programme');
    const inserer = db.prepare('INSERT INTO programme (module_code, ouvre_le) VALUES (?, ?)');
    for (const p of propres) inserer.run(p.code, p.date);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  journaliser(parQui, 'programme_enregistre',
    propres.map((p) => `${p.date}=${p.code}`).join(', ') || 'aucun defi', null);
  return propres.length;
}
