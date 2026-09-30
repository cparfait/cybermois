import { db, journaliser } from './db.js';

/**
 * Textes des mails de campagne, modifiables depuis l'onglet Mails.
 *
 * Un mail melange deux choses : ce qu'on dit, que la DPO ou la DSI veulent
 * pouvoir reformuler, et ce qui change d'un agent ou d'une semaine a l'autre
 * - le prenom, le calendrier, le classement. Le texte se saisit dans un
 * editeur visuel ; les donnees y figurent sous forme de reperes {{nom}}, que
 * l'envoi remplace.
 *
 * Deux sortes de reperes. Un repere « en ligne » (le prenom, le titre du
 * defi) se glisse dans une phrase et devient du texte. Un repere « bloc » (le
 * calendrier, le bouton, le classement) produit un tableau ou un bouton : il
 * occupe seul son paragraphe.
 *
 * Un texte jamais modifie n'est pas stocke : il suit le code, et une
 * correction du texte d'origine atteint donc aussi les instances en place.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS modeles_mail (
  type      TEXT PRIMARY KEY,
  objet     TEXT NOT NULL,
  corps     TEXT NOT NULL,
  maj_le    TEXT NOT NULL DEFAULT (datetime('now')),
  maj_par   TEXT
);
`);

/* ------------------------------------------------------------ Reperes */

const EN_LIGNE = (libelle) => ({ libelle, bloc: false });
const BLOC = (libelle) => ({ libelle, bloc: true });

const SALUTATION = { salutation: EN_LIGNE('Bonjour Prénom,'), prenom: EN_LIGNE('Prénom') };
const DEFI = {
  titre_defi: EN_LIGNE('Titre du défi'),
  duree: EN_LIGNE('Durée du défi (minutes)'),
  lien_defi: EN_LIGNE('Adresse du défi'),
  defi: BLOC('Titre et accroche du défi'),
  bouton: BLOC('Bouton vers le défi'),
};
const RATTRAPAGE = { rattrapage: EN_LIGNE('Phrase : les défis restent ouverts jusqu’au…') };

/* -------------------------------------------------------------- Modeles */

const h3 = (t) => `<h3>${t}</h3>`;

/**
 * Les textes d'origine. Ils reprennent mot pour mot les mails ecrits en dur
 * jusqu'ici : passer a l'editeur ne change rien a ce que recoivent les agents.
 */
export const MODELES = {
  ouverture: {
    nom: "Mail d'ouverture",
    variables: {
      ...SALUTATION, ...DEFI, ...RATTRAPAGE,
      nb_defis: EN_LIGNE('Nombre de défis de la campagne'),
      questions_par_defi: EN_LIGNE('Questions par défi'),
      points_par_defi: EN_LIGNE('Points par défi'),
      bareme: EN_LIGNE('Barème : 3 faciles à 10 points, …'),
      jusqu_a_la_fin: EN_LIGNE('« jusqu’à la fin de la campagne, le … »'),
      calendrier: BLOC('Calendrier des défis'),
    },
    objet: 'Cybermois : {{nb_defis}} défis pour aiguiser vos réflexes — le premier est en ligne',
    corps: `<p>{{salutation}}</p>
<p>Octobre est le <strong>mois européen de la cybersécurité</strong>. La Ville de Châtillon y participe cette année avec une opération courte, ouverte à tous les agents : <strong>le Cybermois</strong>. Il commence aujourd'hui.</p>
<p>{{defi}}</p>
<p><strong>{{nb_defis}} défis au fil du mois, {{duree}} minutes chacun.</strong> Des questions concrètes, tirées de situations qui se produisent vraiment dans une collectivité. Après chaque réponse, la correction vous dit ce que vous avez trouvé, ce qui vous a échappé, et pourquoi.</p>
<p>{{bouton}}</p>
<p>Connectez-vous avec <strong>vos identifiants de session Windows</strong> — votre identifiant ou votre adresse professionnelle, au choix. Il n'y a rien à installer, et vous pouvez jouer depuis un téléphone.</p>
${h3('Comment ça marche')}
<ul>
<li><strong>Un défi paraît à chaque date du calendrier</strong> ci-dessous. Il reste ouvert {{jusqu_a_la_fin}} : si vous en manquez un, vous pouvez le rattraper.</li>
<li><strong>{{questions_par_defi}} questions, {{points_par_defi}} points par défi</strong> : {{bareme}}. Tous les défis pèsent le même poids : aucune semaine ne compte plus qu'une autre.</li>
<li><strong>Le mercredi</strong>, un rappel est envoyé à celles et ceux qui n'ont pas encore fait les défis de la semaine. Aucun si vous êtes à jour.</li>
<li><strong>Le vendredi</strong>, les résultats et le classement des directions sont diffusés.</li>
<li>À la fin de la campagne, une <strong>attestation de participation</strong> est à télécharger depuis votre profil sur le portail.</li>
</ul>
<p>{{calendrier}}</p>
${h3("Ce n'est pas un examen")}
<p>Aucun résultat individuel n'est transmis à votre hiérarchie, et se tromper n'a aucune conséquence : c'est même l'intérêt de l'exercice. Les questions sont conçues pour piéger des gens attentifs, parce que les attaques réelles le sont aussi.</p>
<p>Le classement se fait <strong>par direction</strong> : chaque défi terminé rapporte des points à la vôtre. Un classement individuel existe aussi ; si vous préférez ne pas y figurer nominativement, écrivez-moi — votre participation continuera de compter pour votre direction, sans que votre nom apparaisse.</p>
${h3('Vos données')}
<p>Le portail utilise votre identifiant, votre nom, votre adresse professionnelle et votre direction, lus dans l'annuaire de la collectivité. Vos réponses et vos scores sont conservés jusqu'à la fin de l'année suivant la campagne ; un décompte du nombre de défis suivis est gardé trois ans comme preuve de l'action de sensibilisation. <strong>Votre mot de passe n'est jamais enregistré</strong> : il sert uniquement à vous authentifier auprès de l'annuaire.</p>
<p>Vous disposez d'un droit d'accès, de rectification, d'effacement, de limitation et d'opposition sur ces données. Les mentions légales complètes sont accessibles depuis le portail, et je reste à votre disposition pour toute question.</p>
<p>Bonne campagne à toutes et à tous,</p>
<p>La déléguée à la protection des données<br>Ville de Châtillon</p>`,
  },

  annonce: {
    nom: 'Annonce du lundi',
    variables: {
      ...SALUTATION, ...RATTRAPAGE,
      nouveautes: EN_LIGNE('« Nouveau défi : Titre » ou « 2 nouveaux défis cette semaine »'),
      phrase_semaine: EN_LIGNE('« Voici le défi de la semaine : » ou « Voici les 2 défis… »'),
      defis_semaine: BLOC('Les défis de la semaine, avec leur bouton'),
      defis_en_retard: BLOC('Les défis précédents non faits, ou « Vous êtes à jour »'),
    },
    objet: 'Cybermois — {{nouveautes}}',
    corps: `<p>{{salutation}}</p>
<p>Le <strong>Cybermois</strong> continue. {{phrase_semaine}}</p>
<p>{{defis_semaine}}</p>
${h3('Les défis précédents sont toujours ouverts')}
<p>{{defis_en_retard}}</p>
<p>{{rattrapage}}</p>
<p>Bonne semaine,<br>La Direction des systèmes d'information</p>`,
  },

  'relance-semaine': {
    nom: 'Relance du mercredi (plusieurs défis)',
    aide: "Quand un seul défi manque à l'agent, c'est la relance d'un seul défi qui part.",
    variables: {
      ...SALUTATION, ...RATTRAPAGE,
      nb_defis_manquants: EN_LIGNE('Nombre de défis qui manquent'),
      defis_manquants: BLOC('Les défis qui manquent, avec leur bouton'),
      participation_service: BLOC('Encadré : participation de la direction'),
    },
    objet: 'Cybermois — {{nb_defis_manquants}} défis vous attendent cette semaine',
    corps: `<p>{{salutation}}</p>
<p>Cette semaine, <strong>{{nb_defis_manquants}} défis</strong> du Cybermois vous attendent encore :</p>
<p>{{defis_manquants}}</p>
<p>{{participation_service}}</p>
<p>{{rattrapage}}</p>`,
  },

  relance: {
    nom: "Relance d'un seul défi",
    aide: 'Part aussi le mercredi, quand un seul défi de la semaine manque à l’agent.',
    variables: {
      ...SALUTATION, ...DEFI, ...RATTRAPAGE,
      participation_service: BLOC('Encadré : participation de la direction'),
    },
    objet: 'Il vous reste 5 minutes ? Le défi « {{titre_defi}} » vous attend',
    corps: `<p>{{salutation}}</p>
<p>Le défi <strong>{{titre_defi}}</strong> vous attend toujours.</p>
<p>{{participation_service}}</p>
<p><strong>{{duree}} minutes</strong>, pas plus. Et il n'y a rien à installer.</p>
<p>{{bouton}}</p>
<p>{{rattrapage}}</p>`,
  },

  resultats: {
    nom: 'Résultats du vendredi',
    variables: {
      titre_defi: EN_LIGNE('Titre du défi'),
      sujet_resultats: EN_LIGNE('« du défi Titre » ou « de la campagne »'),
      participants: EN_LIGNE('Nombre de participants'),
      chiffres: BLOC('Chiffres clés : participants, participation, points'),
      classement_services: BLOC('Classement des directions'),
      classement_individuel: BLOC('Classement individuel (dix premiers)'),
      bouton: BLOC('Bouton vers le classement'),
    },
    objet: 'Cybermois — Résultats : {{titre_defi}}',
    corps: `<p>Bonjour à toutes et à tous,</p>
<p>Voici les résultats {{sujet_resultats}}.</p>
<p>{{chiffres}}</p>
<h2>🏆 Classement des directions</h2>
<p>Score moyen par agent de la direction, et taux de participation.</p>
<p>{{classement_services}}</p>
<h2>⭐ Classement individuel</h2>
<p>{{classement_individuel}}</p>
<p>{{bouton}}</p>
<p>Les défis déjà parus restent accessibles : il n'est jamais trop tard pour faire gagner des points à votre direction.</p>
<p>Bon week-end,<br>La Direction des systèmes d'information</p>`,
  },

  lancement: {
    nom: 'Texte pour la DPO (nouveau défi)',
    aide: 'À copier-coller depuis la messagerie de la DPO. Pour le premier défi, c’est le mail d’ouverture.',
    variables: {
      ...DEFI,
      accroche_defi: EN_LIGNE('Accroche du défi'),
      intro_defi: EN_LIGNE('Introduction du défi'),
    },
    objet: 'Cybermois — Nouveau défi : {{titre_defi}}',
    corps: `<p>Bonjour à toutes et à tous,</p>
<p>Le <strong>Cybermois</strong> se poursuit à la Ville de Châtillon. Un nouveau défi est en ligne :</p>
<p>{{defi}}</p>
<p>{{intro_defi}}</p>
<p><strong>{{duree}} minutes suffisent.</strong> Connectez-vous avec vos identifiants habituels de session Windows.</p>
<p>{{bouton}}</p>
<p>Chaque bonne réponse rapporte des points à <strong>votre direction</strong>. Le classement est mis à jour en direct : allez voir où vous en êtes.</p>
<p>Bonne chance,<br>La déléguée à la protection des données</p>`,
  },
};

/* ---------------------------------------------------------- Nettoyage */

const BALISES = new Set(['p', 'br', 'strong', 'em', 'u', 'h2', 'h3', 'ul', 'ol', 'li', 'a']);
const RENOMMEES = { b: 'strong', i: 'em', div: 'p' };

/** Une adresse de lien acceptable : web, mail, ou un repere comme {{lien_defi}}. */
const lienSur = (href) => /^(https?:\/\/|mailto:)/i.test(href) || /^\{\{\w+\}\}$/.test(href);

/**
 * Ne garde du HTML saisi que la mise en forme d'un mail : paragraphes,
 * titres, gras, italique, souligne, listes, liens. Tout attribut disparait,
 * sauf l'adresse d'un lien. Un collage depuis Word ou une page web n'apporte
 * donc ni police, ni couleur, ni script.
 */
export function nettoyerHtml(brut) {
  const html = String(brut ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|iframe|object|template)\b[\s\S]*?<\/\1\s*>/gi, '');

  let sortie = '';
  let dernier = 0;
  const balise = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  const texte = (t) => t.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  for (let m = balise.exec(html); m; m = balise.exec(html)) {
    sortie += texte(html.slice(dernier, m.index));
    dernier = balise.lastIndex;
    const fermante = m[1] === '/';
    let nom = m[2].toLowerCase();
    nom = RENOMMEES[nom] || nom;
    if (!BALISES.has(nom)) continue;
    if (nom === 'br') { sortie += '<br>'; continue; }
    if (fermante) { sortie += `</${nom}>`; continue; }
    if (nom === 'a') {
      const h = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[3]);
      const href = (h?.[1] ?? h?.[2] ?? '').replace(/&amp;/g, '&').trim();
      sortie += lienSur(href) ? `<a href="${href.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">` : '<a>';
      continue;
    }
    sortie += `<${nom}>`;
  }
  sortie += texte(html.slice(dernier));

  return sortie
    // Un <div> devenu <p> autour d'un <p> : un seul niveau suffit.
    .replace(/<p>\s*<p>/g, '<p>').replace(/<\/p>\s*<\/p>/g, '</p>')
    .replace(/<p>(\s|<br>|&nbsp;)*<\/p>/g, '')
    .trim();
}

/* ---------------------------------------------------------- Lecture */

/**
 * Un brouillon remplace le texte enregistre le temps d'un apercu ou d'un
 * test. Les mails se construisent de facon synchrone : rien d'autre ne peut
 * s'intercaler entre la pose et le retrait.
 */
let brouillon = null;

export function avecBrouillon(type, modele, construire) {
  brouillon = modele ? { type, objet: String(modele.objet ?? ''), corps: nettoyerHtml(modele.corps) } : null;
  try {
    return construire();
  } finally {
    brouillon = null;
  }
}

export function lireModele(type) {
  const origine = MODELES[type];
  if (!origine) return null;
  if (brouillon?.type === type) return { objet: brouillon.objet, corps: brouillon.corps, personnalise: true };
  const stocke = db.prepare('SELECT objet, corps, maj_le, maj_par FROM modeles_mail WHERE type = ?').get(type);
  return stocke
    ? { objet: stocke.objet, corps: stocke.corps, personnalise: true, majLe: stocke.maj_le, majPar: stocke.maj_par }
    : { objet: origine.objet, corps: origine.corps, personnalise: false };
}

/** Tous les modeles, pour l'editeur : texte courant, reperes, texte d'origine. */
export function listerModeles() {
  return Object.entries(MODELES).map(([type, m]) => ({
    type,
    nom: m.nom,
    aide: m.aide || null,
    variables: Object.entries(m.variables).map(([nom, v]) => ({ nom, ...v })),
    ...lireModele(type),
  }));
}

/* ---------------------------------------------------------- Ecriture */

/**
 * Les reperes inconnus et les blocs glisses dans une phrase sont refuses a
 * l'enregistrement : le premier partirait tel quel chez cinq cents agents,
 * le second casserait la mise en page.
 */
export function verifierModele(type, { objet, corps }) {
  const m = MODELES[type];
  if (!m) return ['Type de mail inconnu.'];
  const erreurs = [];
  if (!String(objet ?? '').trim()) erreurs.push("L'objet ne peut pas être vide.");
  if (!nettoyerHtml(corps).replace(/<[^>]+>/g, '').trim()) erreurs.push('Le texte ne peut pas être vide.');

  const inconnus = new Set();
  for (const [, nom] of `${objet} ${corps}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    if (!m.variables[nom]) inconnus.add(nom);
  }
  if (inconnus.size) {
    erreurs.push(`Donnée inconnue pour ce mail : ${[...inconnus].map((n) => `{{${n}}}`).join(', ')}.`);
  }

  // Un bloc peut figurer une fois seul et une fois dans une phrase : on
  // compare les occurrences, pas la simple presence.
  const propre = nettoyerHtml(corps);
  const blocs = Object.keys(m.variables).filter((n) => m.variables[n].bloc);
  const compter = (motif) => (propre.match(new RegExp(motif, 'g')) || []).length;
  const malPlaces = blocs.filter((nom) =>
    compter(`\\{\\{${nom}\\}\\}`) > compter(`<p>\\s*\\{\\{${nom}\\}\\}\\s*</p>`));
  if (malPlaces.length) {
    erreurs.push(`${malPlaces.map((n) => `« ${m.variables[n].libelle} »`).join(', ')} `
      + 'doit rester seul sur sa ligne.');
  }
  for (const nom of blocs.filter((n) => String(objet).includes(`{{${n}}}`))) {
    erreurs.push(`« ${m.variables[nom].libelle} » ne peut pas figurer dans l'objet.`);
  }
  return erreurs;
}

export function enregistrerModele(type, { objet, corps }, login) {
  db.prepare(`
    INSERT INTO modeles_mail (type, objet, corps, maj_le, maj_par) VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(type) DO UPDATE SET objet = excluded.objet, corps = excluded.corps,
      maj_le = excluded.maj_le, maj_par = excluded.maj_par
  `).run(type, String(objet).trim(), nettoyerHtml(corps), login || null);
  journaliser(login, 'modele_mail_modifie', type, null);
}

export function reinitialiserModele(type, login) {
  db.prepare('DELETE FROM modeles_mail WHERE type = ?').run(type);
  journaliser(login, 'modele_mail_reinitialise', type, null);
}

/* ------------------------------------------------------------- Rendu */

const echapper = (s) => String(s ?? '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const POLICE_TITRE = "font-family:'Montserrat',Arial,sans-serif;color:#006e46;";

/** Les styles en ligne d'un mail : les messageries ignorent les feuilles de style. */
function styliser(html) {
  return html
    .replace(/<h2>/g, `<h2 style="${POLICE_TITRE}font-size:19px;margin:26px 0 8px;">`)
    .replace(/<h3>/g, `<h3 style="${POLICE_TITRE}font-size:17px;margin:26px 0 6px;">`)
    .replace(/<ul>/g, '<ul style="padding-left:20px;margin:8px 0;">')
    .replace(/<ol>/g, '<ol style="padding-left:20px;margin:8px 0;">')
    .replace(/<li>/g, '<li style="margin-bottom:8px;">')
    .replace(/<a href=/g, '<a style="color:#006e46;font-weight:700;" href=');
}

/**
 * Le mail d'un type, donnees remplacees.
 *
 * @param valeurs  { nom: valeur } : une chaine pour un repere en ligne, du
 *                 HTML pour un bloc. Un bloc vide fait disparaitre sa ligne.
 * @returns { objet, corps } - le corps en HTML, pret pour le gabarit
 */
export function rendreModele(type, valeurs) {
  const modele = lireModele(type);
  const variables = MODELES[type].variables;
  const valeur = (nom) => valeurs[nom] ?? '';

  // Les styles d'abord : poses apres, ils atteignaient aussi les blocs, et
  // le bouton vert prenait la couleur verte des liens du texte.
  let corps = styliser(modele.corps).replace(/<p>\s*\{\{(\w+)\}\}\s*<\/p>/g, (tout, nom) =>
    (variables[nom]?.bloc ? valeur(nom) : tout));
  corps = corps.replace(/\{\{(\w+)\}\}/g, (tout, nom) => {
    if (!variables[nom]) return tout;
    return variables[nom].bloc ? valeur(nom) : echapper(valeur(nom));
  });

  const objet = modele.objet
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (tout, nom) => {
      if (!variables[nom]) return tout;
      return variables[nom].bloc ? '' : String(valeur(nom));
    })
    .replace(/\s{2,}/g, ' ')
    .trim()
    // Une donnee vide en fin d'objet laissait « Résultats : » en suspens.
    .replace(/\s*[:—–-]$/, '');

  return { objet, corps };
}
