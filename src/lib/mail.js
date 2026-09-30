import nodemailer from 'nodemailer';
import { prenomUsuel } from './prenom.js';
import { config } from './config.js';
import { db } from './db.js';
import { classementServices, classementAgents, statistiquesGlobales, ligneClassement } from './scoring.js';
import { NIVEAUX, QUESTIONS_PAR_DEFI, TOTAL_DEFI } from './bareme.js';
import { aujourdhui, decalerJours, dateLisible } from './dates.js';
import { rendreModele } from './modeles-mail.js';

let transport = null;
function obtenirTransport() {
  if (transport) return transport;
  if (!config.smtp.host) return null;
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
    tls: { rejectUnauthorized: false }, // relais interne avec certificat auto-signe
  });
  return transport;
}

export async function testerSmtp() {
  const t = obtenirTransport();
  if (!t) return { ok: false, message: 'Aucun serveur SMTP configure (SMTP_HOST vide).' };
  try {
    await t.verify();
    return { ok: true, message: `Relais SMTP ${config.smtp.host}:${config.smtp.port} joignable.` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/* --------------------------------------------------------------- Gabarit */

const echapper = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function gabarit({ titre, preheader, corps }) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${echapper(titre)}</title></head>
<body style="margin:0;padding:0;background:#f7faf8;font-family:Georgia,'Times New Roman',serif;color:#14211c;">
<span style="display:none;font-size:1px;color:#f7faf8;">${echapper(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7faf8;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #d9e4de;border-radius:12px;overflow:hidden;">
  <tr><td style="background:#006e46;padding:20px 28px;border-bottom:4px solid #aec80c;">
    <div style="font-family:'Montserrat',Arial,sans-serif;color:#ffffff;font-size:12px;letter-spacing:.1em;text-transform:uppercase;">Ville de Châtillon</div>
    <div style="font-family:'Montserrat',Arial,sans-serif;color:#ffffff;font-size:24px;font-weight:900;margin-top:2px;">Cybermois 2026</div>
  </td></tr>
  <tr><td style="padding:28px;font-size:16px;line-height:1.6;">${corps}</td></tr>
  <tr><td style="padding:18px 28px;background:#f7faf8;border-top:1px solid #d9e4de;font-family:'Montserrat',Arial,sans-serif;font-size:12px;color:#4a5a53;line-height:1.5;">
    Message automatique du portail Cybermois — Direction des systèmes d'information.<br>
    Pour toute question sur le traitement de vos données, contactez la déléguée à la protection des données.
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

const bouton = (lien, libelle) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr><td style="background:#006e46;border-radius:8px;">
   <a href="${echapper(lien)}" style="display:inline-block;padding:13px 28px;font-family:'Montserrat',Arial,sans-serif;font-weight:700;font-size:15px;color:#ffffff;text-decoration:none;">${echapper(libelle)}</a>
   </td></tr></table>`;

const versTexte = (html) => html
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|tr|div|h[1-4]|li)>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\n{3,}/g, '\n\n').trim();

/* ------------------------------------------------------------- Contenus */

/**
 * Le premier defi de la campagne : le plus ancien des defis publies. Sa date
 * de parution est le « premier jour », celui du mail d'ouverture.
 */
export const premierDefi = () => db.prepare(
  'SELECT * FROM defis WHERE publie = 1 ORDER BY ouvre_le, id LIMIT 1'
).get() || null;

/**
 * Le dernier defi paru, sujet du mail de resultats. Un rang calcule sur le
 * calendrier ne veut rien dire des lors que les dates de parution sont
 * libres. La date du jour est la date locale : `date('now')`, en UTC, le
 * faisait encore attendre deux heures le jour d'une parution.
 */
export const dernierDefiParu = (jour = aujourdhui()) => db.prepare(
  'SELECT * FROM defis WHERE publie = 1 AND ouvre_le <= ? ORDER BY ouvre_le DESC, id DESC LIMIT 1'
).get(jour) || null;

/**
 * Les defis de la semaine : parus dans les sept derniers jours, aujourd'hui
 * compris. Une fenetre glissante plutot que la semaine du calendrier : un
 * defi paru un jeudi doit encore etre rappele le mercredi suivant, alors
 * qu'il appartient a la semaine d'avant.
 */
export const defisDeLaSemaine = (jour = aujourdhui()) => db.prepare(`
  SELECT * FROM defis WHERE publie = 1 AND ouvre_le BETWEEN ? AND ? ORDER BY ouvre_le, id
`).all(decalerJours(jour, -6), jour);

/** Les defis qui paraissent dans les sept jours qui viennent, aujourd'hui compris. */
export const defisAVenir = (jour = aujourdhui()) => db.prepare(`
  SELECT * FROM defis WHERE publie = 1 AND ouvre_le BETWEEN ? AND ? ORDER BY ouvre_le, id
`).all(jour, decalerJours(jour, 6));

/** Mail d'ouverture adresse a un agent. `null` si aucun defi n'est publie. */
export function mailBienvenue(agent) {
  const defi = premierDefi();
  return defi ? mailOuverture(defi, agent) : null;
}

/* -------------------------------------------------- Blocs de donnees */

// Ce qui change d'un agent ou d'une semaine a l'autre. Le texte autour se
// modifie dans l'onglet Mails (modeles-mail.js) ; ces blocs, eux, sont des
// donnees mises en forme, et restent dans le code.

const salutation = (agent) => (agent
  ? `Bonjour ${prenomUsuel(agent.nom_complet, agent.prenom)},`
  : 'Bonjour à toutes et à tous,');

const blocDefi = (defi) => `
<h2 style="font-family:'Montserrat',Arial,sans-serif;font-size:21px;color:#006e46;margin:22px 0 6px;">${echapper(defi.titre)}</h2>
<p style="font-style:italic;color:#4a5a53;margin-top:0;">${echapper(defi.accroche)}</p>`;

/**
 * Titre, accroche, duree, puis bouton. Avec `jour`, un defi pas encore paru a
 * la place sa date d'ouverture : le lien ne s'ouvrirait pas.
 */
const blocDefiAvecAction = (d, libelle, jour = null) => `
<h2 style="font-family:'Montserrat',Arial,sans-serif;font-size:19px;color:#006e46;margin:22px 0 4px;">${echapper(d.titre)}</h2>
<p style="font-style:italic;color:#4a5a53;margin:0;">${echapper(d.accroche)} — ${d.duree_minutes} minutes</p>
${!jour || d.ouvre_le <= jour
    ? bouton(`${config.publicUrl}/defi/${d.id}`, libelle)
    : `<p style="margin:10px 0 18px;"><strong>En ligne à partir du ${echapper(dateLisible(d.ouvre_le))}.</strong></p>`}`;

function blocParticipation(agent) {
  const stats = ligneClassement(agent.service);
  return `<p style="background:#f4f8dd;border-left:4px solid #aec80c;padding:12px 16px;margin:20px 0;">
  ${stats
    ? `Votre direction — <strong>${echapper(agent.service)}</strong> — affiche <strong>${stats.taux_participation} %</strong> de participation. Chaque défi terminé la fait monter au classement.`
    : `Votre participation fera monter <strong>${echapper(agent.service)}</strong> au classement.`}
</p>`;
}

/** Les reperes communs a tous les mails qui portent sur un defi. */
const donneesDefi = (defi, libelleBouton) => ({
  titre_defi: defi.titre,
  accroche_defi: defi.accroche,
  intro_defi: defi.intro,
  duree: String(defi.duree_minutes),
  lien_defi: `${config.publicUrl}/defi/${defi.id}`,
  defi: blocDefi(defi),
  bouton: bouton(`${config.publicUrl}/defi/${defi.id}`, libelleBouton),
});

const prenomDe = (agent) => (agent ? prenomUsuel(agent.nom_complet, agent.prenom) : '');

/** Le mail pret a partir : texte du modele, donnees remplacees, gabarit. */
function composer(type, valeurs, { titre, preheader }) {
  const { objet, corps } = rendreModele(type, valeurs);
  return { objet, html: gabarit({ titre, preheader, corps }), texte: versTexte(corps) };
}

/**
 * Mail de lancement : destine a etre copie-colle par la DPO depuis sa propre boite.
 *
 * Le premier defi n'annonce pas un questionnaire, il ouvre une operation : il
 * faut dire qui la porte, ce qui est mesure, et ce qui ne l'est pas. Un agent
 * qui decouvre un classement nominatif sans avoir rien lu se demande d'abord
 * si sa hierarchie va voir son score - et ne joue pas. Les suivants se
 * contentent d'annoncer le defi, l'operation etant deja connue.
 */
export function mailLancement(defiId) {
  const defi = db.prepare('SELECT * FROM defis WHERE id = ?').get(Number(defiId));
  if (!defi) return null;

  // Le premier defi de la campagne se reconnait a sa date de parution, non a
  // un rang : rien n'empeche d'en faire paraitre deux le meme jour, mais le
  // mail d'ouverture ne se justifie que pour le plus ancien.
  const premier = premierDefi();
  if (premier && premier.id === defi.id) return mailOuverture(defi);

  return composer('lancement', donneesDefi(defi, 'Je relève le défi'),
    { titre: defi.titre, preheader: defi.accroche });
}

/**
 * Ouverture de la campagne, signee de la DPO.
 *
 * Trois choses doivent y figurer, et l'ordre compte. Ce qu'on demande - cinq
 * minutes, pas un examen. Ce qui est mesure et vu par qui : un classement
 * nominatif decouvert sans preavis fait fuir plus d'agents qu'il n'en motive.
 * Et l'information RGPD, qui n'est pas une formalite mais precisement ce qui
 * rend la premiere credible.
 *
 * Envoye a chaque agent le jour de parution du premier defi, il doit aussi
 * expliquer comment la campagne se deroule : c'est le seul message qui le
 * dit, et un agent qui ne sait pas qu'un defi manque se rattrape ne revient
 * pas apres une semaine d'absence.
 *
 * @param agent destinataire, pour le saluer par son prenom ; absent, le
 *              message s'adresse a tous (copie de la DPO, apercu).
 */
function mailOuverture(defi, agent = null) {
  const defis = db.prepare('SELECT titre, ouvre_le FROM defis WHERE publie = 1 ORDER BY ouvre_le, id').all();
  const nbDefis = defis.length;

  const calendrier = nbDefis > 1 ? `
<p style="margin:16px 0 6px;"><strong>Le calendrier</strong></p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px;">
  ${defis.map((d) => `<tr>
    <td style="padding:4px 14px 4px 0;white-space:nowrap;color:#006e46;font-family:'Montserrat',Arial,sans-serif;font-weight:700;">${echapper(dateLisible(d.ouvre_le))}</td>
    <td style="padding:4px 0;">${echapper(d.titre)}</td></tr>`).join('')}
</table>` : '';

  return composer('ouverture', {
    ...donneesDefi(defi, 'Je relève le premier défi'),
    salutation: salutation(agent),
    prenom: prenomDe(agent),
    rattrapage: rattrapage(),
    nb_defis: String(nbDefis),
    questions_par_defi: String(QUESTIONS_PAR_DEFI),
    points_par_defi: String(TOTAL_DEFI),
    jusqu_a_la_fin: config.campagne.fin
      ? `jusqu'à la fin de la campagne, le ${dateLisible(config.campagne.fin)}`
      : "jusqu'à la fin de la campagne",
    bareme: NIVEAUX.map((n) => `${n.attendues} ${n.libelle.toLowerCase()}${n.attendues > 1 ? 's' : ''} à ${n.points} points`).join(', '),
    calendrier,
  }, {
    titre: 'Ouverture du Cybermois',
    preheader: `${nbDefis} défis, ${defi.duree_minutes} minutes chacun. Le classement se fait par direction.`,
  });
}

export function mailRelance(agent, defiId) {
  const defi = db.prepare('SELECT * FROM defis WHERE id = ?').get(Number(defiId));
  if (!defi) return null;
  return composer('relance', {
    ...donneesDefi(defi, 'Faire le défi maintenant'),
    salutation: salutation(agent),
    prenom: prenomDe(agent),
    rattrapage: rattrapage(),
    participation_service: blocParticipation(agent),
  }, { titre: 'Relance', preheader: defi.accroche });
}

/**
 * Annonce du lundi : les defis de la semaine, et ceux d'avant que l'agent n'a
 * pas encore faits - ils restent ouverts, et beaucoup l'ignorent.
 *
 * Un defi qui parait plus tard dans la semaine est annonce avec sa date : le
 * lien ne s'ouvrira qu'a partir de ce jour-la.
 */
export function mailAnnonce(agent, semaine, enRetard, jour = aujourdhui()) {
  if (!semaine?.length) return null;

  const retard = enRetard?.length ? `
<p style="margin-top:0;">Il vous en reste ${enRetard.length === 1 ? 'un' : enRetard.length} à faire — chacun fait encore gagner des points à votre direction :</p>
<ul style="padding-left:20px;margin:8px 0 16px;">
  ${enRetard.map((d) => `<li style="margin-bottom:6px;"><a href="${echapper(`${config.publicUrl}/defi/${d.id}`)}" style="color:#006e46;font-weight:700;">${echapper(d.titre)}</a></li>`).join('')}
</ul>` : `
<p style="margin-top:0;">${agent
    ? 'Vous êtes à jour : bravo. Si un collègue a manqué une semaine, dites-lui qu’il peut encore la rattraper.'
    : 'Vous en avez manqué un ? Il n’est pas trop tard : chaque défi rattrapé fait encore gagner des points à votre direction.'}</p>`;

  return composer('annonce', {
    salutation: salutation(agent),
    prenom: prenomDe(agent),
    rattrapage: rattrapage(),
    nouveautes: semaine.length > 1
      ? `${semaine.length} nouveaux défis cette semaine`
      : `Nouveau défi : ${semaine[0].titre}`,
    phrase_semaine: semaine.length > 1
      ? `Voici les ${semaine.length} défis de la semaine :`
      : 'Voici le défi de la semaine :',
    defis_semaine: semaine.map((d) => blocDefiAvecAction(d, 'Je relève le défi', jour)).join(''),
    defis_en_retard: retard,
  }, { titre: 'Les défis de la semaine', preheader: semaine.map((d) => d.titre).join(' · ') });
}

// « jusqu'au 31 octobre » etait ecrit en dur : faux des que la campagne
// changeait de dates. Du texte brut : le modele l'echappe a l'insertion.
const rattrapage = () => (config.campagne.fin
  ? `Les défis déjà parus restent ouverts jusqu'au ${dateLisible(config.campagne.fin)} : vous pouvez les rattraper.`
  : 'Les défis déjà parus restent ouverts : vous pouvez les rattraper.');

/**
 * Relance du mercredi : les defis de la semaine que l'agent n'a pas termines.
 *
 * Un seul message, meme quand deux defis sont parus : deux relances le meme
 * matin se liraient comme du harcelement, et la seconde ne serait pas ouverte.
 */
export function mailRelanceSemaine(agent, manquants) {
  if (!manquants?.length) return null;
  if (manquants.length === 1) return mailRelance(agent, manquants[0].id);

  return composer('relance-semaine', {
    salutation: salutation(agent),
    prenom: prenomDe(agent),
    rattrapage: rattrapage(),
    nb_defis_manquants: String(manquants.length),
    defis_manquants: manquants.map((d) => blocDefiAvecAction(d, 'Faire ce défi')).join(''),
    participation_service: blocParticipation(agent),
  }, { titre: 'Relance', preheader: manquants.map((d) => d.titre).join(' · ') });
}

export function mailResultats(defiId) {
  const services = classementServices();
  const agents = classementAgents(10);
  const stats = statistiquesGlobales();
  const defi = db.prepare('SELECT * FROM defis WHERE id = ?').get(Number(defiId));

  const medaille = ['🥇', '🥈', '🥉'];
  const ligneService = (s, i) => `
    <tr style="border-bottom:1px solid #d9e4de;">
      <td style="padding:9px 6px;font-family:'Montserrat',Arial,sans-serif;font-weight:700;width:38px;">${medaille[i] || `${i + 1}.`}</td>
      <td style="padding:9px 6px;">${echapper(s.service)}</td>
      <td style="padding:9px 6px;text-align:right;font-family:'Montserrat',Arial,sans-serif;font-weight:700;color:#006e46;white-space:nowrap;">${s.pourcentage_moyen} %</td>
      <td style="padding:9px 6px;text-align:right;font-family:'Montserrat',Arial,sans-serif;font-size:13px;color:#4a5a53;white-space:nowrap;">${s.taux_participation} %</td>
    </tr>`;

  const ligneAgent = (a, i) => `
    <tr style="border-bottom:1px solid #d9e4de;">
      <td style="padding:9px 6px;font-family:'Montserrat',Arial,sans-serif;font-weight:700;width:38px;">${medaille[i] || `${i + 1}.`}</td>
      <td style="padding:9px 6px;">${echapper(a.nom_complet)}<br><span style="font-size:13px;color:#4a5a53;">${echapper(a.service)}</span></td>
      <td style="padding:9px 6px;text-align:right;font-family:'Montserrat',Arial,sans-serif;font-weight:700;color:#006e46;white-space:nowrap;">${a.score_total} pts</td>
    </tr>`;

  const chiffre = (valeur, libelle) => `<td align="center" style="padding:14px 6px;"><div style="font-family:'Montserrat',Arial,sans-serif;font-size:26px;font-weight:900;color:#006e46;">${valeur}</div><div style="font-size:13px;color:#4a5a53;">${libelle}</div></td>`;
  const taux = stats.inscrits ? Math.round((stats.joueurs / stats.inscrits) * 100) : 0;

  return composer('resultats', {
    titre_defi: defi?.titre || '',
    sujet_resultats: defi ? `du défi ${defi.titre}` : 'de la campagne',
    participants: String(stats.joueurs),
    chiffres: `<table role="presentation" width="100%" style="background:#e6f1ec;border-radius:10px;padding:4px;margin:20px 0;"><tr>
  ${chiffre(stats.joueurs, 'participants')}${chiffre(`${taux} %`, 'de participation')}${chiffre(stats.points_cumules, 'points cumulés')}
</tr></table>`,
    classement_services: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;">${services.slice(0, 10).map(ligneService).join('')}</table>`,
    classement_individuel: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;">${agents.map(ligneAgent).join('')}</table>`,
    bouton: bouton(`${config.publicUrl}/classement`, 'Voir le classement complet'),
  }, { titre: 'Résultats', preheader: `${stats.joueurs} participants, classement des directions` });
}

export function mailDiplome(agent) {
  const corps = `
<p>Bonjour ${echapper(prenomUsuel(agent.nom_complet, agent.prenom))},</p>
<p>Vous avez terminé <strong>les quatre défis du Cybermois</strong>. Bravo !</p>
<p>Votre attestation de participation est disponible sur le portail : vous pouvez la télécharger et l'imprimer.</p>
${bouton(`${config.publicUrl}/profil`, 'Récupérer mon attestation')}
<p>Merci pour le temps que vous y avez consacré. La sécurité de la collectivité repose largement sur ces réflexes du quotidien.</p>
<p>La Direction des systèmes d'information</p>`;
  return {
    objet: 'Bravo — vous avez terminé le Cybermois',
    html: gabarit({ titre: 'Félicitations', preheader: 'Votre attestation vous attend', corps }),
    texte: versTexte(corps),
  };
}

/* ---------------------------------------------------------------- Envois */

async function envoyer({ to, objet, html, texte, bcc }) {
  const t = obtenirTransport();
  if (!t) throw new Error('SMTP non configure');
  // Plus de refus sur smtp.actif : cet interrupteur coupe les envois
  // PLANIFIES, que server.js ne programme pas quand il est eteint. Refuser ici
  // bloquait aussi l'envoi fait a la main, confirme a l'ecran - si bien qu'il
  // fallait activer tout l'automatique pour envoyer un seul message.
  await t.sendMail({
    from: config.smtp.from,
    to, bcc,
    cc: config.smtp.copie || undefined,
    subject: objet,
    html, text: texte,
  });
}

/**
 * Une seule adresse, sans nom ni liste : le champ de test ne doit pas pouvoir
 * servir a arroser plusieurs destinataires d'un coup.
 */
export const adresseValide = (adresse) =>
  /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(String(adresse || '')) && String(adresse).length <= 254;

/**
 * Envoi de test : le message tel quel, a une seule adresse, marque dans son
 * objet. Sans la copie configuree - elle recevrait chaque essai - et sans
 * trace dans « envois », ou il passerait pour le vrai envoi.
 */
export async function envoyerTest(adresse, m) {
  if (!adresseValide(adresse)) throw new Error('Adresse invalide');
  const t = obtenirTransport();
  if (!t) throw new Error('SMTP non configure');
  await t.sendMail({
    from: config.smtp.from,
    to: adresse,
    subject: `[TEST] ${m.objet}`,
    html: m.html,
    text: m.texte,
  });
}

/**
 * Un envoi en masse a la fois.
 *
 * Rien n'empechait deux envois simultanes sur le meme defi : un double clic,
 * ou la tache planifiee qui tombe pendant un envoi manuel, et cinq cents
 * agents recevaient la relance en double. La trace dans « envois » n'etant
 * ecrite qu'a la fin de la boucle, le second appel ne pouvait meme pas
 * s'apercevoir que le premier etait en cours.
 */
const envoisEnCours = new Set();

function verrouiller(cle) {
  if (envoisEnCours.has(cle)) return false;
  envoisEnCours.add(cle);
  return true;
}

/** Relance des agents n'ayant pas encore joue le defi donne. */
export async function envoyerRelances(defiId, { simulation = false } = {}) {
  const defi = db.prepare('SELECT id FROM defis WHERE id = ? AND publie = 1').get(Number(defiId));
  if (!defi) return { ok: false, message: `Defi ${defiId} introuvable ou non publie.` };

  const cibles = db.prepare(`
    SELECT a.* FROM agents a
    WHERE a.email IS NOT NULL AND a.email <> ''
      AND a.exclu = 0
      AND NOT EXISTS (SELECT 1 FROM participations p WHERE p.agent_id = a.id AND p.defi_id = ? AND p.entrainement = 0)
  `).all(defi.id);

  if (simulation) return { ok: true, simulation: true, destinataires: cibles.length, apercu: cibles.slice(0, 5).map((a) => a.email) };

  const cle = `relance:${defi.id}`;
  if (!verrouiller(cle)) {
    return {
      ok: false,
      code: 'ENVOI_EN_COURS',
      message: 'Une relance est deja en cours d\'envoi pour ce defi. Attendez qu\'elle se termine.',
    };
  }

  let succes = 0; let derniereErreur = null;
  try {
    for (const agent of cibles) {
      try {
        const m = mailRelance(agent, defi.id);
        await envoyer({ to: agent.email, ...m });
        succes++;
      } catch (err) { derniereErreur = err.message; }
    }

    db.prepare('INSERT INTO envois (type, defi_id, destinataires, succes, erreur) VALUES (?, ?, ?, ?, ?)')
      .run('relance', defi.id, cibles.length, succes, derniereErreur);
  } finally {
    envoisEnCours.delete(cle);
  }

  return { ok: true, destinataires: cibles.length, succes, erreur: derniereErreur };
}

// Agents qui recoivent les mails individuels. Le compte d'administration
// locale n'est pas un agent : il ne joue pas et n'a rien a recevoir.
const AGENTS_JOIGNABLES = `a.email IS NOT NULL AND a.email <> '' AND a.exclu = 0 AND a.origine <> 'local'`;

/** Le mail d'ouverture est-il deja parti ? Une remise a zero l'oublie. */
export const ouvertureEnvoyee = () =>
  !!db.prepare("SELECT 1 FROM envois WHERE type = 'ouverture' AND succes > 0 LIMIT 1").get();

/**
 * Mail d'ouverture, a chaque agent.
 *
 * Il ne part qu'une fois : la tache planifiee passe plusieurs fois le premier
 * jour, pour rattraper un serveur arrete a l'heure prevue, et un envoi manuel
 * peut tomber apres elle. `forcer` le renvoie quand meme - a un effectif
 * complete apres coup, par exemple.
 */
export async function envoyerOuverture({ simulation = false, forcer = false } = {}) {
  const defi = premierDefi();
  if (!defi) return { ok: false, message: 'Aucun défi publié : rien à annoncer.' };

  const cibles = db.prepare(`SELECT a.* FROM agents a WHERE ${AGENTS_JOIGNABLES}`).all();
  const deja = ouvertureEnvoyee();

  if (simulation) {
    return {
      ok: true, simulation: true, destinataires: cibles.length, dejaEnvoye: deja,
      premierJour: defi.ouvre_le, apercu: cibles.slice(0, 5).map((a) => a.email),
    };
  }
  if (deja && !forcer) {
    return {
      ok: false, code: 'DEJA_ENVOYE',
      message: "Le mail d'ouverture a déjà été envoyé pour cette campagne.",
    };
  }
  if (!verrouiller('ouverture')) {
    return { ok: false, code: 'ENVOI_EN_COURS', message: "Le mail d'ouverture est déjà en cours d'envoi." };
  }

  let succes = 0; let derniereErreur = null;
  try {
    for (const agent of cibles) {
      try {
        await envoyer({ to: agent.email, ...mailOuverture(defi, agent) });
        succes++;
      } catch (err) { derniereErreur = err.message; }
    }
    db.prepare('INSERT INTO envois (type, defi_id, destinataires, succes, erreur) VALUES (?, ?, ?, ?, ?)')
      .run('ouverture', defi.id, cibles.length, succes, derniereErreur);
  } finally {
    envoisEnCours.delete('ouverture');
  }
  return { ok: true, destinataires: cibles.length, succes, erreur: derniereErreur };
}

/**
 * Tache du premier jour : n'envoie que le jour de parution du premier defi,
 * et une seule fois. Renvoie `null` quand il n'y a rien a faire.
 */
export async function ouvertureDuJour(jour = aujourdhui()) {
  const defi = premierDefi();
  if (!defi || defi.ouvre_le !== jour || ouvertureEnvoyee()) return null;
  return envoyerOuverture();
}

/** L'annonce de la semaine est-elle deja partie ? Six jours : un lundi ne voit pas le precedent. */
const annonceEnvoyee = () => !!db.prepare(
  "SELECT 1 FROM envois WHERE type = 'annonce' AND succes > 0 AND horodatage >= datetime('now', '-6 days') LIMIT 1"
).get();

/**
 * Annonce du lundi, a chaque agent : les defis de la semaine, et ceux d'avant
 * qui lui restent.
 *
 * Pas d'annonce avant ni pendant le premier jour : le mail d'ouverture la
 * remplace, et deux messages le meme matin se feraient concurrence.
 */
export async function envoyerAnnonce({ simulation = false, forcer = false, jour = aujourdhui() } = {}) {
  if (config.campagne.fin && jour > config.campagne.fin) {
    return { ok: false, message: 'La campagne est terminée : plus d\'annonce.' };
  }
  const premier = premierDefi();
  if (!premier || premier.ouvre_le >= jour) {
    return {
      ok: false, code: 'OUVERTURE',
      message: "La campagne n'a pas encore commencé : c'est le mail d'ouverture qui annonce le premier défi.",
    };
  }
  const semaine = defisAVenir(jour);
  if (!semaine.length) return { ok: false, message: 'Aucun défi ne paraît dans les sept jours qui viennent : rien à annoncer.' };

  const anciens = db.prepare('SELECT * FROM defis WHERE publie = 1 AND ouvre_le < ? ORDER BY ouvre_le, id').all(jour);
  const fait = db.prepare(
    'SELECT 1 FROM participations WHERE agent_id = ? AND defi_id = ? AND entrainement = 0'
  );
  const cibles = db.prepare(`SELECT a.* FROM agents a WHERE ${AGENTS_JOIGNABLES}`).all();
  const deja = annonceEnvoyee();

  if (simulation) {
    return {
      ok: true, simulation: true, destinataires: cibles.length, dejaEnvoye: deja,
      defis: semaine.map((d) => d.titre), apercu: cibles.slice(0, 5).map((a) => a.email),
    };
  }
  if (deja && !forcer) {
    return { ok: false, code: 'DEJA_ENVOYE', message: "L'annonce de la semaine a déjà été envoyée." };
  }
  if (!verrouiller('annonce')) {
    return { ok: false, code: 'ENVOI_EN_COURS', message: "L'annonce est déjà en cours d'envoi." };
  }

  let succes = 0; let derniereErreur = null;
  try {
    for (const agent of cibles) {
      try {
        const enRetard = anciens.filter((d) => !fait.get(agent.id, d.id));
        await envoyer({ to: agent.email, ...mailAnnonce(agent, semaine, enRetard, jour) });
        succes++;
      } catch (err) { derniereErreur = err.message; }
    }
    db.prepare('INSERT INTO envois (type, defi_id, destinataires, succes, erreur) VALUES (?, ?, ?, ?, ?)')
      .run('annonce', semaine[0].id, cibles.length, succes, derniereErreur);
  } finally {
    envoisEnCours.delete('annonce');
  }
  return { ok: true, destinataires: cibles.length, succes, erreur: derniereErreur, defis: semaine.map((d) => d.titre) };
}

/** Tache du lundi : `null` quand il n'y a rien a faire, ou que c'est deja fait. */
export async function annonceDuJour(jour = aujourdhui()) {
  if (annonceEnvoyee()) return null;
  const res = await envoyerAnnonce({ jour });
  return res.ok ? res : null;
}

/**
 * Relance du mercredi : chaque agent qui n'a pas termine tous les defis de la
 * semaine recoit un message listant ceux qui lui manquent.
 *
 * Elle ne regardait que le dernier defi paru : quand deux defis sortaient la
 * meme semaine, celui qui avait fait le plus recent n'etait jamais relance
 * pour l'autre.
 */
export async function envoyerRelancesSemaine({ simulation = false, jour = aujourdhui() } = {}) {
  if (config.campagne.fin && jour > config.campagne.fin) {
    return { ok: false, message: 'La campagne est terminée : plus de relance.' };
  }
  const defis = defisDeLaSemaine(jour);
  if (!defis.length) return { ok: false, message: 'Aucun défi paru ces sept derniers jours : rien à relancer.' };

  const fait = db.prepare(
    'SELECT 1 FROM participations WHERE agent_id = ? AND defi_id = ? AND entrainement = 0'
  );
  const cibles = db.prepare(`SELECT a.* FROM agents a WHERE ${AGENTS_JOIGNABLES}`).all()
    .map((agent) => ({ agent, manquants: defis.filter((d) => !fait.get(agent.id, d.id)) }))
    .filter((c) => c.manquants.length);

  if (simulation) {
    return {
      ok: true, simulation: true, destinataires: cibles.length,
      defis: defis.map((d) => d.titre), apercu: cibles.slice(0, 5).map((c) => c.agent.email),
    };
  }
  if (!verrouiller('relance-semaine')) {
    return { ok: false, code: 'ENVOI_EN_COURS', message: 'Une relance est déjà en cours d\'envoi.' };
  }

  let succes = 0; let derniereErreur = null;
  try {
    for (const { agent, manquants } of cibles) {
      try {
        await envoyer({ to: agent.email, ...mailRelanceSemaine(agent, manquants) });
        succes++;
      } catch (err) { derniereErreur = err.message; }
    }
    db.prepare('INSERT INTO envois (type, defi_id, destinataires, succes, erreur) VALUES (?, NULL, ?, ?, ?)')
      .run('relance_semaine', cibles.length, succes, derniereErreur);
  } finally {
    envoisEnCours.delete('relance-semaine');
  }
  return { ok: true, destinataires: cibles.length, succes, erreur: derniereErreur, defis: defis.map((d) => d.titre) };
}

/** Resultats d'un defi envoyes au groupe de distribution. */
export async function envoyerResultats(defiId, { simulation = false } = {}) {
  const id = Number(defiId) || null;
  const m = mailResultats(id);
  if (simulation) return { ok: true, simulation: true, destinataires: config.smtp.groupeDiffusion, apercu: m.objet };
  if (!config.smtp.groupeDiffusion) return { ok: false, message: 'MAIL_GROUPE_DIFFUSION non renseigne.' };

  const cle = `resultats:${id}`;
  if (!verrouiller(cle)) {
    return {
      ok: false,
      code: 'ENVOI_EN_COURS',
      message: 'Un envoi de resultats est deja en cours pour ce defi.',
    };
  }

  try {
    await envoyer({ to: config.smtp.groupeDiffusion, ...m });
    db.prepare('INSERT INTO envois (type, defi_id, destinataires, succes) VALUES (?, ?, 1, 1)').run('resultats', id);
    return { ok: true, destinataires: 1, succes: 1 };
  } catch (err) {
    db.prepare('INSERT INTO envois (type, defi_id, destinataires, succes, erreur) VALUES (?, ?, 1, 0, ?)').run('resultats', id, err.message);
    return { ok: false, message: err.message };
  } finally {
    envoisEnCours.delete(cle);
  }
}
