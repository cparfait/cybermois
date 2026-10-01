import nodemailer from 'nodemailer';
import { prenomUsuel } from './prenom.js';
import { config } from './config.js';
import { db } from './db.js';
import { classementServices, classementAgents, statistiquesGlobales, ligneClassement } from './scoring.js';
import { aujourdhui, decalerJours, dateLisible, lundiDe } from './dates.js';
import { rendreModele, SIGNATURE } from './modeles-mail.js';
import { filtrerDestinataires, membresDuGroupe } from './groupes.js';

/**
 * La connexion au relais, gardee tant que ses reglages ne changent pas.
 *
 * Elle etait creee une fois pour toutes : un serveur SMTP corrige dans
 * l'onglet Configuration - prise d'effet immediate, annonce l'ecran -
 * n'etait utilise qu'apres un redemarrage, et les envois continuaient
 * d'echouer sur l'ancien.
 */
let transport = null;
let reglagesTransport = '';
function obtenirTransport() {
  if (!config.smtp.host) return null;
  const reglages = JSON.stringify([config.smtp.host, config.smtp.port, config.smtp.secure,
    config.smtp.user, config.smtp.password]);
  if (transport && reglages === reglagesTransport) return transport;
  transport?.close?.();
  reglagesTransport = reglages;
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

/*
 * Trois periodes, une par mail. La « semaine » est celle du calendrier, du
 * lundi au dimanche : une fenetre de sept jours glissante debordait sur la
 * semaine suivante - une ouverture un mercredi annoncait les defis du lundi
 * d'apres, que l'annonce de ce lundi-la reprenait une seconde fois.
 */

const dimancheDe = (jour) => decalerJours(lundiDe(jour), 6);

/**
 * Les defis qui paraissent de `jour` a la fin de sa semaine : ceux qu'annoncent
 * l'ouverture (a partir du premier jour) et l'annonce du lundi.
 */
export const defisAVenir = (jour = aujourdhui()) => db.prepare(`
  SELECT * FROM defis WHERE publie = 1 AND ouvre_le BETWEEN ? AND ? ORDER BY ouvre_le, id
`).all(jour, dimancheDe(jour));

/**
 * Les defis dont parlent les resultats envoyes `jour` : parus depuis le
 * samedi precedant sa semaine. Un vendredi, c'est du samedi au vendredi :
 * un defi du week-end compte ainsi dans les resultats suivants, et chaque
 * defi est nomme une fois, par un seul vendredi.
 */
export const defisDeLaSemaine = (jour = aujourdhui()) => db.prepare(`
  SELECT * FROM defis WHERE publie = 1 AND ouvre_le BETWEEN ? AND ? ORDER BY ouvre_le, id
`).all(decalerJours(lundiDe(jour), -2), jour);

/** Tous les defis parus a `jour`. */
export const defisParus = (jour = aujourdhui()) => db.prepare(
  'SELECT * FROM defis WHERE publie = 1 AND ouvre_le <= ? ORDER BY ouvre_le, id'
).all(jour);

/**
 * Les defis que reprend la relance du mercredi : tous ceux parus depuis au
 * moins deux jours, les plus anciens compris. Un defi paru le matin meme -
 * ou la veille - n'a pas encore ete manque : la relance partait le jour
 * meme de l'ouverture quand celle-ci tombait un mercredi.
 */
export const DELAI_RELANCE = 2;
export const defisARelancer = (jour = aujourdhui()) => defisParus(decalerJours(jour, -DELAI_RELANCE));

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
/**
 * Les donnees du mail d'ouverture, que reprend le mail aux elus.
 *
 * Tous les defis de la premiere semaine, pas le seul premier : quand
 * plusieurs paraissent le premier jour, les autres passaient sous silence.
 * Rien au-dela de la semaine : le programme ne s'annonce pas a l'avance.
 */
function donneesOuverture(defi, agent) {
  const semaine = defisAVenir(defi.ouvre_le);
  return {
    ...donneesDefi(defi, 'Je relève le premier défi'),
    phrase_semaine: semaine.length > 1
      ? `Voici les ${semaine.length} défis de la semaine :`
      : 'Voici le premier défi :',
    defis_semaine: semaine.map((d) => blocDefiAvecAction(d, 'Je relève le défi', defi.ouvre_le)).join(''),
    salutation: salutation(agent),
    prenom: prenomDe(agent),
    rattrapage: rattrapage(),
    jusqu_a_la_fin: rattrapageCourt(),
  };
}

function mailOuverture(defi, agent = null) {
  return composer('ouverture', donneesOuverture(defi, agent), {
    titre: 'Ouverture du Cybermois',
    preheader: `${defi.duree_minutes} minutes pour le premier défi. Le classement se fait par direction.`,
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

  // Les defis d'avant, toujours ouverts. Rien de ceux qui ne sont pas encore
  // parus : seule la semaine s'annonce.
  const retard = enRetard?.length ? `
<p>Les défis précédents sont toujours ouverts. Il vous en reste ${enRetard.length === 1 ? 'un' : enRetard.length} à faire :</p>
<ul style="padding-left:20px;margin:8px 0 16px;">
  ${enRetard.map((d) => `<li style="margin-bottom:6px;"><a href="${echapper(`${config.publicUrl}/defi/${d.id}`)}" style="color:#006e46;font-weight:700;">${echapper(d.titre)}</a></li>`).join('')}
</ul>` : `
<p>${agent
    ? 'Vous êtes à jour sur les défis précédents : bravo.'
    : `Un défi manqué ? Les défis précédents sont toujours ouverts ${echapper(rattrapageCourt())}.`}</p>`;

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
const rattrapageCourt = () => (config.campagne.fin
  ? `jusqu'au ${dateLisible(config.campagne.fin)}` : "jusqu'à la fin de la campagne");

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

/**
 * Mail aux elus, envoye a la main aux membres d'un groupe de l'annuaire.
 *
 * Les elus n'ont pas tous un poste sur le reseau de la mairie : le portail
 * ne s'atteint que de l'interieur. Le mail dit comment y acceder, et c'est
 * pour cela qu'ils sont en general ecartes du mail d'ouverture, qui ne le
 * dit pas.
 */
export function mailElus(agent) {
  // Le debut, c'est le premier defi : le reglage « Debut de campagne » restait
  // au lundi 5 octobre quand le programme commencait le jeudi 1er. Il ne sert
  // plus que tant qu'aucun defi n'est programme.
  const premier = premierDefi();
  const debut = premier?.ouvre_le || config.campagne.debut;
  const { fin } = config.campagne;
  // Le mail d'ouverture, avec en plus la maniere d'acceder au portail : les
  // donnees sont les siennes, le bouton « portail » vient s'y ajouter.
  return composer('elus', {
    ...(premier ? donneesOuverture(premier, agent) : { salutation: salutation(agent), prenom: prenomDe(agent) }),
    periode: debut && fin
      ? `du ${dateLisible(debut)} au ${dateLisible(fin)}`
      : fin ? `jusqu'au ${dateLisible(fin)}` : 'en octobre',
    lien_portail: `${config.publicUrl}/`,
    bouton: bouton(`${config.publicUrl}/`, 'Ouvrir le portail Cybermois'),
  }, { titre: 'Ouverture du Cybermois', preheader: 'Comment participer depuis la mairie : réseau interne, PC du bureau des élus ou VPN.' });
}

/**
 * Resultats du vendredi, au groupe de diffusion.
 *
 * Ils nommaient le seul dernier defi paru, alors que chiffres et classement
 * portent sur toute la campagne : avec deux defis dans la semaine, l'autre
 * n'etait pas cite. Ils nomment desormais les defis de la semaine - celle du
 * defi donne, jusqu'a son vendredi.
 */
export function mailResultats(defiId, { jour = null } = {}) {
  const services = classementServices();
  const agents = classementAgents(10);
  const stats = statistiquesGlobales();
  const defi = db.prepare('SELECT * FROM defis WHERE id = ?').get(Number(defiId));

  // Le vendredi de la semaine du defi ; un defi du week-end compte pour la suivante.
  let vendredi = defi ? decalerJours(lundiDe(defi.ouvre_le), 4) : null;
  if (vendredi && defi.ouvre_le > vendredi) vendredi = decalerJours(vendredi, 7);
  // L'envoi du vendredi part de la date du jour : une semaine sans nouveau
  // defi ne doit pas reprendre les titres d'une semaine passee.
  const semaine = jour ? defisDeLaSemaine(jour) : vendredi ? defisDeLaSemaine(vendredi) : [];
  const titres = semaine.map((d) => d.titre);
  const enumeration = titres.length > 1
    ? `${titres.slice(0, -1).join(', ')} et ${titres[titres.length - 1]}`
    : titres[0] || (jour ? 'pas de nouveau défi, les précédents restent ouverts' : defi?.titre || '');

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
      <td style="padding:9px 6px;text-align:right;font-family:'Montserrat',Arial,sans-serif;font-weight:700;color:#006e46;white-space:nowrap;">${a.pourcentage} %<br><span style="font-size:12px;font-weight:400;color:#4a5a53;">${a.defis_joues} défi${a.defis_joues > 1 ? 's' : ''}</span></td>
    </tr>`;

  const chiffre = (valeur, libelle) => `<td align="center" style="padding:14px 6px;"><div style="font-family:'Montserrat',Arial,sans-serif;font-size:26px;font-weight:900;color:#006e46;">${valeur}</div><div style="font-size:13px;color:#4a5a53;">${libelle}</div></td>`;
  const taux = stats.inscrits ? Math.round((stats.joueurs / stats.inscrits) * 100) : 0;

  return composer('resultats', {
    defis_semaine: enumeration || 'la campagne continue',
    titre_defi: defi?.titre || '',
    sujet_resultats: defi ? `du défi ${defi.titre}` : 'de la campagne',
    participants: String(stats.joueurs),
    chiffres: `<table role="presentation" width="100%" style="background:#e6f1ec;border-radius:10px;padding:4px;margin:20px 0;"><tr>
  ${chiffre(stats.joueurs, 'participants')}${chiffre(`${taux} %`, 'de participation')}${chiffre(stats.points_cumules, 'points cumulés')}
</tr></table>`,
    // Deux pourcentages sans titre ne se lisaient pas : l'en-tete les nomme.
    classement_services: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;">
    <tr>
      <th colspan="2"></th>
      <th style="padding:0 6px 6px;text-align:right;font-family:'Montserrat',Arial,sans-serif;font-size:12px;font-weight:700;color:#006e46;">Réussite</th>
      <th style="padding:0 6px 6px;text-align:right;font-family:'Montserrat',Arial,sans-serif;font-size:12px;font-weight:700;color:#4a5a53;">Participation</th>
    </tr>${services.slice(0, 10).map(ligneService).join('')}</table>`,
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
<p>${SIGNATURE}</p>`;
  return {
    objet: 'Bravo — vous avez terminé le Cybermois',
    html: gabarit({ titre: 'Félicitations', preheader: 'Votre attestation vous attend', corps }),
    texte: versTexte(corps),
  };
}

/* ------------------------------------------------- Mails d'une semaine */

const NOMS_ENVOIS = {
  ouverture: "Mail d'ouverture",
  annonce: 'Annonce du lundi',
  'relance-semaine': 'Relance du mercredi',
  resultats: 'Résultats du vendredi',
};
const CLE_REGLAGE = { ouverture: 'ouverture', annonce: 'annonce', 'relance-semaine': 'relance', resultats: 'resultats' };

/**
 * Les semaines de la campagne, du lundi du premier defi a celui du dernier -
 * ou de la fin de campagne, si elle vient apres : relances et resultats
 * continuent de partir tant que la campagne dure.
 */
export function semainesDeCampagne() {
  const defis = db.prepare('SELECT titre, ouvre_le FROM defis WHERE publie = 1 ORDER BY ouvre_le, id').all();
  if (!defis.length) return [];
  let lundi = lundiDe(defis[0].ouvre_le);
  const dernier = [lundiDe(defis[defis.length - 1].ouvre_le), config.campagne.fin ? lundiDe(config.campagne.fin) : '']
    .sort().pop();
  const semaines = [];
  for (; lundi <= dernier && semaines.length < 60; lundi = decalerJours(lundi, 7)) {
    const dimanche = decalerJours(lundi, 6);
    semaines.push({
      lundi,
      libelle: `Semaine du ${dateLisible(lundi)}`,
      defis: defis.filter((d) => d.ouvre_le >= lundi && d.ouvre_le <= dimanche).map((d) => d.titre),
    });
  }
  return semaines;
}

/**
 * Les mails automatiques d'une semaine, tels qu'ils partiront : chacun a son
 * jour, avec le contenu de ce jour-la. Un mail qui ne partira pas figure
 * aussi, avec la raison : c'est ce qu'on cherche en relisant une semaine.
 *
 * Les mails individuels sont montres pour `agent`, suppose n'avoir encore
 * fait aucun defi : c'est la version la plus longue, celle qui liste tout.
 */
export function mailsDeLaSemaine(lundi, agent) {
  const jour = (n) => decalerJours(lundi, n);
  const close = (j) => !!config.campagne.fin && j > config.campagne.fin;
  const premier = premierDefi();
  const liste = [];
  const ajouter = (type, date, mail, absent = null) => liste.push({
    type,
    nom: NOMS_ENVOIS[type],
    jour: date,
    automatique: !!config.mails?.[CLE_REGLAGE[type]],
    mail: absent ? null : mail,
    absent,
  });

  if (premier && premier.ouvre_le >= lundi && premier.ouvre_le <= jour(6)) {
    ajouter('ouverture', premier.ouvre_le, mailOuverture(premier, agent));
  }

  // L'annonce : memes conditions que l'envoi du lundi (envoyerAnnonce).
  if (!premier || premier.ouvre_le >= lundi) {
    ajouter('annonce', lundi, null, premier && premier.ouvre_le <= jour(6)
      ? "Pas d'annonce cette semaine : le mail d'ouverture en tient lieu."
      : "Pas d'annonce : la campagne n'a pas encore commencé.");
  } else if (close(lundi)) {
    ajouter('annonce', lundi, null, "Pas d'annonce : la campagne est terminée.");
  } else {
    const semaine = defisAVenir(lundi);
    const anciens = db.prepare('SELECT * FROM defis WHERE publie = 1 AND ouvre_le < ? ORDER BY ouvre_le, id').all(lundi);
    ajouter('annonce', lundi, mailAnnonce(agent, semaine, anciens, lundi),
      semaine.length ? null : "Pas d'annonce : aucun défi ne paraît cette semaine.");
  }

  // La relance : memes conditions que l'envoi du mercredi (envoyerRelancesSemaine).
  const mercredi = jour(2);
  const aRelancer = close(mercredi) ? [] : defisARelancer(mercredi);
  ajouter('relance-semaine', mercredi, aRelancer.length ? mailRelanceSemaine(agent, aRelancer) : null,
    close(mercredi) ? 'Pas de relance : la campagne est terminée.'
      : aRelancer.length ? null : `Pas de relance : aucun défi paru depuis au moins ${DELAI_RELANCE} jours.`);

  const vendredi = jour(4);
  const dernier = dernierDefiParu(vendredi);
  ajouter('resultats', vendredi, dernier ? mailResultats(dernier.id, { jour: vendredi }) : null,
    dernier ? null : 'Pas de résultats : aucun défi paru.');

  return liste.sort((a, b) => a.jour.localeCompare(b.jour));
}

/**
 * Un exemple de chaque mail de la campagne, pour tout relire d'un coup :
 * chaque mail automatique pris dans la premiere semaine ou il part, puis le
 * mail aux elus. Un mail qui ne partirait jamais - aucune semaine ne le
 * produit - n'y figure pas.
 */
export function exemplesDeCampagne(agent) {
  const exemples = [];
  const vus = new Set();
  for (const { lundi } of semainesDeCampagne()) {
    for (const m of mailsDeLaSemaine(lundi, agent)) {
      if (m.mail && !vus.has(m.type)) {
        vus.add(m.type);
        exemples.push(m);
      }
    }
    if (vus.size === Object.keys(NOMS_ENVOIS).length) break;
  }
  exemples.sort((a, b) => a.jour.localeCompare(b.jour));
  exemples.push({ type: 'elus', nom: 'Mail aux élus', jour: null, mail: mailElus(agent) });
  return exemples;
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
export async function envoyerTest(adresse, m, etiquette = '') {
  if (!adresseValide(adresse)) throw new Error('Adresse invalide');
  const t = obtenirTransport();
  if (!t) throw new Error('SMTP non configure');
  await t.sendMail({
    from: config.smtp.from,
    to: adresse,
    // L'etiquette dit de quel envoi il s'agit quand plusieurs tests arrivent
    // d'un coup : « [TEST mercredi 7 octobre] ».
    subject: `[TEST${etiquette ? ` ${etiquette}` : ''}] ${m.objet}`,
    html: m.html,
    text: m.texte,
  });
}

/* ------------------------------------------------- Envois en nombre */

/*
 * Un envoi a quatre cents agents ne tient pas dans une requete web : le
 * proxy coupe au bout d'une minute (« 504 »), alors que la boucle continue
 * sur le serveur sans que personne ne sache ou elle en est. Et Microsoft 365
 * n'accepte que trente messages par minute d'un meme compte : envoyes d'une
 * traite, tous ceux d'apres etaient refuses.
 *
 * Desormais un envoi en nombre part en arriere-plan, au debit regle
 * (smtp.parMinute), reessaie un message refuse pour cause de limite, et note
 * chaque destinataire servi : le relancer ne part qu'a ceux qui ne l'ont pas
 * encore recu.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS envois_agents (
  lot        TEXT NOT NULL,
  agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  horodatage TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (lot, agent_id)
);
`);

const servis = (lot) => new Set(
  db.prepare('SELECT agent_id FROM envois_agents WHERE lot = ?').all(lot).map((l) => l.agent_id)
);
/*
 * Une adresse, un mail. Certaines adresses sont portees par deux comptes :
 * boite partagee (relais.petite-enfance@), agent qui a deux comptes dans
 * l'annuaire. L'envoi d'ouverture leur en a remis deux, a quelques secondes
 * d'intervalle. Un envoi marque donc servis tous les comptes de l'adresse, et
 * n'ecrit qu'une fois a chacune.
 */
const noterServi = (lot, agentId) => {
  db.prepare('INSERT OR IGNORE INTO envois_agents (lot, agent_id) VALUES (?, ?)').run(lot, agentId);
  db.prepare(`
    INSERT OR IGNORE INTO envois_agents (lot, agent_id)
    SELECT ?, b.id FROM agents a
    JOIN agents b ON lower(b.email) = lower(a.email) AND b.id <> a.id
    WHERE a.id = ? AND a.email IS NOT NULL AND a.email <> ''
  `).run(lot, agentId);
};

/** Une seule cible par adresse : la premiere rencontree. */
const uneParAdresse = (cibles, agentDe = (c) => c) => {
  const vues = new Set();
  return cibles.filter((c) => {
    const adresse = String(agentDe(c).email || '').toLowerCase();
    if (!adresse || vues.has(adresse)) return false;
    vues.add(adresse);
    return true;
  });
};

/** Les cibles qui n'ont pas encore recu ce lot, une par adresse. */
const nonServis = (lot, cibles, agentDe = (c) => c) => {
  const deja = servis(lot);
  return uneParAdresse(cibles.filter((c) => !deja.has(agentDe(c).id)), agentDe);
};

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Millisecondes entre deux messages ; 0 si le debit n'est pas limite. */
export const intervalleEnvoi = () => {
  const n = Number(config.smtp.parMinute) || 0;
  return n > 0 ? Math.ceil(60000 / n) : 0;
};

/** Duree estimee d'un envoi, en minutes, pour l'annoncer a l'ecran. */
const minutesPour = (n) => Math.max(1, Math.ceil((n * intervalleEnvoi()) / 60000));

/** Un refus passager : limite de debit, serveur occupe. Il vaut la peine d'attendre. */
const passager = (err) => /\b4\d\d\b|\b4\.\d+\.\d+\b|rate|throttl|too many|exceed|limit/i
  .test(`${err?.responseCode || ''} ${err?.message || err}`);

/** Le temps d'attente avant de reessayer un message refuse pour cause de limite. */
export const reglagesReprise = { attente: 60000, essais: 3 };

async function envoyerAvecReprise(message) {
  for (let essai = 1; ; essai++) {
    try {
      return await envoyer(message);
    } catch (err) {
      if (essai >= reglagesReprise.essais || !passager(err)) throw err;
      await pause(reglagesReprise.attente);
    }
  }
}

/**
 * Un envoi en nombre a la fois par cle.
 *
 * Rien n'empechait deux envois simultanes sur le meme defi : un double clic,
 * ou la tache planifiee qui tombe pendant un envoi manuel, et cinq cents
 * agents recevaient la relance en double.
 */
const envoisEnCours = new Set();
const progression = new Map();

function verrouiller(cle) {
  if (envoisEnCours.has(cle)) return false;
  envoisEnCours.add(cle);
  return true;
}

/** Les envois en cours, pour l'ecran : ou ils en sont, et combien de temps il reste. */
export const envoisEnCoursDetail = () => [...progression.values()].map((e) => ({
  type: e.type,
  total: e.total,
  faits: e.faits,
  succes: e.succes,
  erreur: e.erreur,
  minutesRestantes: minutesPour(e.total - e.faits),
}));

/**
 * La boucle commune : un message par cible, au debit regle. Chaque succes est
 * note dans le lot ; la trace finale va dans « envois ».
 *
 * @param attendre faux : l'envoi part en arriere-plan, la fonction rend la
 *                 main aussitot avec une estimation de duree.
 */
function lancerEnvoi({ cle, type, lot, cibles, agentDe = (c) => c, message, tracer, attendre }) {
  const etat = { type, total: cibles.length, faits: 0, succes: 0, erreur: null };
  progression.set(cle, etat);
  const travail = (async () => {
    try {
      for (const c of cibles) {
        if (etat.faits && intervalleEnvoi()) await pause(intervalleEnvoi());
        try {
          await envoyerAvecReprise(message(c));
          etat.succes++;
          if (lot) noterServi(lot, agentDe(c).id);
        } catch (err) { etat.erreur = err.message; }
        etat.faits++;
      }
      tracer(etat);
    } finally {
      progression.delete(cle);
      envoisEnCours.delete(cle);
    }
    return { ok: true, destinataires: etat.total, succes: etat.succes, erreur: etat.erreur };
  })();

  if (attendre) return travail;
  travail.catch((err) => console.error(`Envoi ${type} interrompu :`, err)); // eslint-disable-line no-console
  return {
    ok: true,
    lance: true,
    destinataires: etat.total,
    minutes: minutesPour(etat.total),
    message: `Envoi lancé : ${etat.total} mail(s), environ ${minutesPour(etat.total)} minute(s). `
      + 'Vous pouvez quitter la page : il continue sur le serveur.',
  };
}

const tracer = (type, defiId, detail = null) => (etat) => db.prepare(
  'INSERT INTO envois (type, defi_id, destinataires, succes, erreur, detail) VALUES (?, ?, ?, ?, ?, ?)'
).run(type, defiId, etat.total, etat.succes, etat.erreur, detail);

// Agents qui recoivent les mails individuels. Le compte d'administration
// locale n'est pas un agent : il ne joue pas et n'a rien a recevoir.
const AGENTS_JOIGNABLES = `a.email IS NOT NULL AND a.email <> '' AND a.exclu = 0 AND a.origine <> 'local'`;

/** Relance des agents n'ayant pas encore joue le defi donne. */
export async function envoyerRelances(defiId, { simulation = false, attendre = true } = {}) {
  const defi = db.prepare('SELECT id FROM defis WHERE id = ? AND publie = 1').get(Number(defiId));
  if (!defi) return { ok: false, message: `Defi ${defiId} introuvable ou non publie.` };

  // Une relance par jour et par defi : la relancer le meme jour ne reprend que
  // ceux qu'elle n'a pas encore atteints.
  const lot = `relance:${defi.id}:${aujourdhui()}`;
  const cibles = nonServis(lot, filtrerDestinataires('relance', db.prepare(`
    SELECT a.* FROM agents a
    WHERE ${AGENTS_JOIGNABLES}
      AND NOT EXISTS (SELECT 1 FROM participations p WHERE p.agent_id = a.id AND p.defi_id = ? AND p.entrainement = 0)
  `).all(defi.id)));

  if (simulation) return { ok: true, simulation: true, destinataires: cibles.length, apercu: cibles.slice(0, 5).map((a) => a.email) };
  if (!cibles.length) return { ok: false, message: 'Personne à relancer pour ce défi aujourd’hui.' };

  const cle = `relance:${defi.id}`;
  if (!verrouiller(cle)) {
    return { ok: false, code: 'ENVOI_EN_COURS', message: 'Une relance est déjà en cours d’envoi pour ce défi.' };
  }
  return lancerEnvoi({
    cle, type: 'relance', lot, cibles, attendre,
    message: (agent) => ({ to: agent.email, ...mailRelance(agent, defi.id) }),
    tracer: tracer('relance', defi.id),
  });
}

/** Le mail d'ouverture est-il deja parti ? Une remise a zero l'oublie. */
export const ouvertureEnvoyee = () =>
  !!db.prepare("SELECT 1 FROM envois WHERE type = 'ouverture' AND succes > 0 LIMIT 1").get();

/**
 * Mail d'ouverture, a chaque agent.
 *
 * Il ne part qu'une fois : la tache planifiee passe plusieurs fois le premier
 * jour, pour rattraper un serveur arrete a l'heure prevue, et un envoi manuel
 * peut tomber apres elle. `forcer` le complete : il part aux seuls agents qui
 * ne l'ont pas encore recu - un envoi interrompu, un effectif complete apres
 * coup.
 */
export async function envoyerOuverture({ simulation = false, forcer = false, attendre = true } = {}) {
  const defi = premierDefi();
  if (!defi) return { ok: false, message: 'Aucun défi publié : rien à annoncer.' };

  const tous = filtrerDestinataires('ouverture', db.prepare(`SELECT a.* FROM agents a WHERE ${AGENTS_JOIGNABLES}`).all());
  const cibles = nonServis('ouverture', tous);
  const deja = ouvertureEnvoyee();

  if (simulation) {
    return {
      ok: true, simulation: true, destinataires: cibles.length, dejaEnvoye: deja,
      premierJour: defi.ouvre_le, apercu: cibles.slice(0, 5).map((a) => a.email),
    };
  }
  if (!cibles.length) {
    return { ok: false, code: 'TOUS_SERVIS', message: "Tous les agents ont déjà reçu le mail d'ouverture." };
  }
  if (deja && !forcer) {
    return {
      ok: false, code: 'DEJA_ENVOYE', restants: cibles.length,
      message: `Le mail d'ouverture est déjà parti. ${cibles.length} agent(s) ne l'ont pas encore reçu.`,
    };
  }
  if (!verrouiller('ouverture')) {
    return { ok: false, code: 'ENVOI_EN_COURS', message: "Le mail d'ouverture est déjà en cours d'envoi." };
  }
  return lancerEnvoi({
    cle: 'ouverture', type: 'ouverture', lot: 'ouverture', cibles, attendre,
    message: (agent) => ({ to: agent.email, ...mailOuverture(defi, agent) }),
    tracer: tracer('ouverture', defi.id),
  });
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
export async function envoyerAnnonce({ simulation = false, forcer = false, jour = aujourdhui(), attendre = true } = {}) {
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
  const lot = `annonce:${lundiDe(jour)}`;
  const cibles = nonServis(lot, filtrerDestinataires('annonce', db.prepare(`SELECT a.* FROM agents a WHERE ${AGENTS_JOIGNABLES}`).all()));
  const deja = annonceEnvoyee();

  if (simulation) {
    return {
      ok: true, simulation: true, destinataires: cibles.length, dejaEnvoye: deja,
      defis: semaine.map((d) => d.titre), apercu: cibles.slice(0, 5).map((a) => a.email),
    };
  }
  if (!cibles.length) {
    return { ok: false, code: 'TOUS_SERVIS', message: "Tous les agents ont déjà reçu l'annonce de cette semaine." };
  }
  if (deja && !forcer) {
    return {
      ok: false, code: 'DEJA_ENVOYE', restants: cibles.length,
      message: `L'annonce de la semaine est déjà partie. ${cibles.length} agent(s) ne l'ont pas encore reçue.`,
    };
  }
  if (!verrouiller('annonce')) {
    return { ok: false, code: 'ENVOI_EN_COURS', message: "L'annonce est déjà en cours d'envoi." };
  }
  const res = lancerEnvoi({
    cle: 'annonce', type: 'annonce', lot, cibles, attendre,
    message: (agent) => ({
      to: agent.email,
      ...mailAnnonce(agent, semaine, anciens.filter((d) => !fait.get(agent.id, d.id)), jour),
    }),
    tracer: tracer('annonce', semaine[0].id),
  });
  const defis = semaine.map((d) => d.titre);
  return attendre ? { ...(await res), defis } : { ...res, defis };
}

/** Tache du lundi : `null` quand il n'y a rien a faire, ou que c'est deja fait. */
export async function annonceDuJour(jour = aujourdhui()) {
  if (annonceEnvoyee()) return null;
  const res = await envoyerAnnonce({ jour });
  return res.ok ? res : null;
}

/**
 * Relance du mercredi : chaque agent qui n'a pas termine tous les defis deja
 * parus - ceux de la semaine comme les plus anciens - recoit un message
 * listant ceux qui lui manquent. La relancer le meme jour ne reprend que ceux
 * qu'elle n'a pas encore atteints.
 */
export async function envoyerRelancesSemaine({ simulation = false, jour = aujourdhui(), attendre = true } = {}) {
  if (config.campagne.fin && jour > config.campagne.fin) {
    return { ok: false, message: 'La campagne est terminée : plus de relance.' };
  }
  const defis = defisARelancer(jour);
  if (!defis.length) {
    return { ok: false, message: `Aucun défi paru depuis au moins ${DELAI_RELANCE} jours : rien à relancer.` };
  }

  const fait = db.prepare(
    'SELECT 1 FROM participations WHERE agent_id = ? AND defi_id = ? AND entrainement = 0'
  );
  const lot = `relance-semaine:${jour}`;
  const cibles = nonServis(lot, filtrerDestinataires('relance-semaine',
    db.prepare(`SELECT a.* FROM agents a WHERE ${AGENTS_JOIGNABLES}`).all())
    .map((agent) => ({ agent, manquants: defis.filter((d) => !fait.get(agent.id, d.id)) }))
    .filter((c) => c.manquants.length), (c) => c.agent);

  if (simulation) {
    return {
      ok: true, simulation: true, destinataires: cibles.length,
      defis: defis.map((d) => d.titre), apercu: cibles.slice(0, 5).map((c) => c.agent.email),
    };
  }
  if (!cibles.length) return { ok: false, code: 'TOUS_SERVIS', message: 'Personne à relancer aujourd’hui.' };
  if (!verrouiller('relance-semaine')) {
    return { ok: false, code: 'ENVOI_EN_COURS', message: 'Une relance est déjà en cours d\'envoi.' };
  }
  const res = lancerEnvoi({
    cle: 'relance-semaine', type: 'relance-semaine', lot, cibles, attendre, agentDe: (c) => c.agent,
    message: ({ agent, manquants }) => ({ to: agent.email, ...mailRelanceSemaine(agent, manquants) }),
    tracer: tracer('relance_semaine', null),
  });
  const titres = defis.map((d) => d.titre);
  return attendre ? { ...(await res), defis: titres } : { ...res, defis: titres };
}

/** Resultats d'un defi envoyes au groupe de distribution : un seul message. */
export async function envoyerResultats(defiId, { simulation = false, jour = null } = {}) {
  const id = Number(defiId) || null;
  const m = mailResultats(id, { jour });
  if (simulation) return { ok: true, simulation: true, destinataires: config.smtp.groupeDiffusion, apercu: m.objet };
  if (!config.smtp.groupeDiffusion) return { ok: false, message: 'MAIL_GROUPE_DIFFUSION non renseigne.' };

  const cle = `resultats:${id}`;
  if (!verrouiller(cle)) {
    return { ok: false, code: 'ENVOI_EN_COURS', message: 'Un envoi de resultats est deja en cours pour ce defi.' };
  }

  try {
    await envoyerAvecReprise({ to: config.smtp.groupeDiffusion, ...m });
    db.prepare('INSERT INTO envois (type, defi_id, destinataires, succes) VALUES (?, ?, 1, 1)').run('resultats', id);
    return { ok: true, destinataires: 1, succes: 1 };
  } catch (err) {
    db.prepare('INSERT INTO envois (type, defi_id, destinataires, succes, erreur) VALUES (?, ?, 1, 0, ?)').run('resultats', id, err.message);
    return { ok: false, message: err.message };
  } finally {
    envoisEnCours.delete(cle);
  }
}

/** Dernier envoi du mail aux elus, pour l'ecran. */
export const dernierEnvoiElus = () => db.prepare(
  "SELECT horodatage, destinataires, succes, erreur, detail FROM envois WHERE type = 'elus' ORDER BY id DESC LIMIT 1"
).get() || null;

/**
 * Mail aux elus, aux membres du groupe choisi. Le relancer ne part qu'aux
 * membres qui ne l'ont pas encore recu : un groupe complete apres coup, ou un
 * envoi interrompu.
 */
export async function envoyerElus(groupe, { simulation = false, attendre = true } = {}) {
  if (!String(groupe || '').trim()) return { ok: false, message: 'Choisissez un groupe.' };
  const membres = membresDuGroupe(groupe);
  const cibles = nonServis('elus', membres);
  if (simulation) {
    return {
      ok: true, simulation: true, destinataires: cibles.length, membres: membres.length,
      apercu: cibles.slice(0, 10).map((a) => a.nom_complet),
    };
  }
  if (!membres.length) return { ok: false, message: `Aucun membre joignable par mail dans le groupe « ${groupe} ».` };
  if (!cibles.length) return { ok: false, code: 'TOUS_SERVIS', message: `Tous les membres de « ${groupe} » ont déjà reçu le mail.` };
  if (!verrouiller('elus')) return { ok: false, code: 'ENVOI_EN_COURS', message: 'Le mail aux élus est déjà en cours d’envoi.' };

  return lancerEnvoi({
    cle: 'elus', type: 'elus', lot: 'elus', cibles, attendre,
    message: (agent) => ({ to: agent.email, ...mailElus(agent) }),
    tracer: tracer('elus', null, groupe),
  });
}

/* ---------------------------------------------------------- Rattrapage */

/*
 * Un envoi interrompu - limite de debit depassee, serveur arrete - laisse des
 * agents sans le mail, et rien ne disait lesquels. Le rattrapage les montre
 * et leur envoie le mail, a eux seuls.
 *
 * Les envois faits avant que l'application ne note chaque destinataire n'ont
 * laisse aucune trace : un export de la messagerie (journal des messages
 * remis) se declare ici, et ses destinataires comptent comme servis.
 */

/** Les mails qui se rattrapent, avec leur lot et leurs destinataires prevus. */
const RATTRAPAGES = {
  ouverture: {
    nom: "Mail d'ouverture",
    lot: () => 'ouverture',
    prevus: () => filtrerDestinataires('ouverture', db.prepare(`SELECT a.* FROM agents a WHERE ${AGENTS_JOIGNABLES}`).all()),
  },
  annonce: {
    nom: 'Annonce de cette semaine',
    lot: () => `annonce:${lundiDe(aujourdhui())}`,
    prevus: () => filtrerDestinataires('annonce', db.prepare(`SELECT a.* FROM agents a WHERE ${AGENTS_JOIGNABLES}`).all()),
  },
};
export const TYPES_RATTRAPAGE = Object.fromEntries(Object.entries(RATTRAPAGES).map(([t, r]) => [t, r.nom]));

/** Qui devait recevoir ce mail, qui l'a recu, qui l'attend encore. */
export function etatRattrapage(type) {
  const r = RATTRAPAGES[type];
  if (!r) return null;
  const tous = r.prevus();
  // On compte des adresses, pas des comptes : c'est a elles que part le mail.
  const prevus = uneParAdresse(tous);
  const manquants = nonServis(r.lot(), tous);

  // Les adresses portees par plusieurs comptes : elles expliquent un ecart
  // entre le nombre d'agents et le nombre de mails partis.
  const parAdresse = new Map();
  for (const a of tous) {
    const cle = a.email.toLowerCase();
    if (!parAdresse.has(cle)) parAdresse.set(cle, []);
    parAdresse.get(cle).push(a.nom_complet);
  }
  const partagees = [...parAdresse].filter(([, noms]) => noms.length > 1)
    .map(([email, noms]) => ({ email, noms }))
    .sort((x, y) => x.email.localeCompare(y.email));

  return {
    type,
    nom: r.nom,
    agents: tous.length,
    prevus: prevus.length,
    recus: prevus.length - manquants.length,
    partagees,
    manquants: manquants
      .map((a) => ({ nom: a.nom_complet, direction: a.service, email: a.email }))
      .sort((x, y) => x.nom.localeCompare(y.nom, 'fr', { sensitivity: 'base' })),
  };
}

/**
 * Les destinataires d'un envoi, d'apres un export de la messagerie.
 *
 * L'export ne contient pas que l'envoi : tests (« [TEST] … »), reponses et
 * transferts des agents, reponses automatiques, messages d'autres jours. Ils
 * sont ecartes, sans quoi un agent qui a recu un « RE: » passait pour servi :
 *   - la date, si une colonne la porte : seules les lignes du `jour` voulu ;
 *   - l'expediteur, si une colonne le porte : celui de l'envoi, c'est-a-dire
 *     le plus frequent parmi les lignes retenues ;
 *   - l'objet, si une colonne le porte : ni test, ni reponse, ni transfert.
 * Sans colonne de destinataire, toute adresse du texte est prise, moins
 * celle de l'expediteur configure.
 *
 * @returns { adresses, lignes, retenues, ecartees: { date, objet, expediteur } }
 */
export function lireExport(texte, { jour = null } = {}) {
  const lignes = String(texte || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const decouper = (l) => {
    const sortie = []; let courant = ''; let guillemets = false;
    for (const c of l) {
      if (c === '"') { guillemets = !guillemets; continue; }
      if ((c === ',' || c === ';' || c === '\t') && !guillemets) { sortie.push(courant.trim()); courant = ''; continue; }
      courant += c;
    }
    sortie.push(courant.trim());
    return sortie;
  };
  // Certains exports entourent chaque ligne de guillemets et doublent ceux de
  // l'interieur : une telle ligne ne donne qu'un champ, on la deballe.
  const champs = (ligne) => {
    const l = ligne.trim();
    const sortie = decouper(l);
    return sortie.length === 1 && l.startsWith('"') && l.endsWith('"')
      ? decouper(l.slice(1, -1).replace(/""/g, '"'))
      : sortie;
  };
  const motif = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const premiere = (v) => (String(v || '').match(motif) || [])[0]?.toLowerCase() || '';

  const entete = lignes.length ? champs(lignes[0]).map((c) => c.toLowerCase().trim()) : [];
  const colonne = (...noms) => entete.findIndex((c) => noms.includes(c));
  const cDestinataire = colonne('to', 'destinataire', 'destinataires', 'recipient', 'recipients',
    'recipient address', 'adresse du destinataire', 'à');
  const cDate = colonne('date & time', 'date', 'date/heure', 'date et heure', 'received', 'date de réception');
  const cExpediteur = colonne('sender', 'from', 'expéditeur', 'expediteur', 'sender address');
  const cObjet = colonne('subject', 'objet');

  if (cDestinataire < 0) {
    const expediteurs = new Set([config.smtp.from, config.smtp.user]
      .flatMap((v) => String(v || '').match(motif) || []).map((a) => a.toLowerCase()));
    const adresses = [...new Set((String(texte || '').match(motif) || []).map((a) => a.toLowerCase()))]
      .filter((a) => !expediteurs.has(a));
    return { adresses, lignes: lignes.length, retenues: lignes.length, ecartees: { date: 0, objet: 0, expediteur: 0 } };
  }

  const rangs = lignes.slice(1).map(champs);

  // Les dates : JJ/MM ou MM/JJ selon l'export, nombre de jours si Excel l'a
  // converti. Excel francais lit un export americain « 10/01/2026 » comme le
  // 10 janvier : on accepte donc aussi le jour et le mois inverses.
  const iso = (a, m, j) => `${a}-${String(m).padStart(2, '0')}-${String(j).padStart(2, '0')}`;
  const formatAmericain = rangs.some((r) => /\b(AM|PM)\b/i.test(r[cDate] || ''))
    || rangs.some((r) => Number(/^(\d{1,2})\/(\d{1,2})\//.exec(r[cDate] || '')?.[2]) > 12);
  const datesDe = (valeur) => {
    const v = String(valeur || '').trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (m) return [iso(m[1], m[2], m[3])];
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
    if (m) return formatAmericain ? [iso(m[3], m[1], m[2])] : [iso(m[3], m[2], m[1])];
    if (/^\d{5}(\.\d+)?$/.test(v)) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 86400000);
      const a = d.getUTCFullYear(); const mo = d.getUTCMonth() + 1; const j = d.getUTCDate();
      return j <= 12 ? [iso(a, mo, j), iso(a, j, mo)] : [iso(a, mo, j)];
    }
    return [];
  };

  const ecartees = { date: 0, objet: 0, expediteur: 0 };
  let retenues = rangs.filter((r) => premiere(r[cDestinataire]));
  if (jour && cDate >= 0) {
    const avant = retenues.length;
    retenues = retenues.filter((r) => datesDe(r[cDate]).includes(jour));
    ecartees.date = avant - retenues.length;
  }
  if (cObjet >= 0) {
    const avant = retenues.length;
    const pasLEnvoi = /^\s*(\[test|\[reporting\]|re\s*:|tr\s*:|fw\s*:|fwd\s*:|réponse automatique|reponse automatique|automatic reply|absence)/i;
    retenues = retenues.filter((r) => !pasLEnvoi.test(r[cObjet] || ''));
    ecartees.objet = avant - retenues.length;
  }
  if (cExpediteur >= 0 && retenues.length) {
    const compte = new Map();
    for (const r of retenues) {
      const e = premiere(r[cExpediteur]);
      compte.set(e, (compte.get(e) || 0) + 1);
    }
    const principal = [...compte].sort((a, b) => b[1] - a[1])[0][0];
    const avant = retenues.length;
    retenues = retenues.filter((r) => premiere(r[cExpediteur]) === principal);
    ecartees.expediteur = avant - retenues.length;
  }

  const adresses = [...new Set(retenues.map((r) => premiere(r[cDestinataire])))];
  return { adresses, lignes: rangs.length, retenues: retenues.length, ecartees };
}

/** Les adresses seules : l'export entier, sans filtre de date. */
export const adressesDeLExport = (texte, options) => lireExport(texte, options).adresses;

/**
 * Declare comme servis, pour ce mail, les agents dont l'adresse figure dans
 * l'export. Les adresses inconnues sont comptees, pas creees.
 */
export function importerRecus(type, texte, { jour = null } = {}) {
  const r = RATTRAPAGES[type];
  if (!r) throw new Error('Type de mail inconnu.');
  const lecture = lireExport(texte, { jour });
  const parAdresse = db.prepare('SELECT id FROM agents WHERE lower(email) = ?');
  let reconnus = 0;
  const inconnues = [];
  db.exec('BEGIN');
  try {
    for (const adresse of lecture.adresses) {
      const agent = parAdresse.get(adresse);
      if (!agent) { inconnues.push(adresse); continue; }
      noterServi(r.lot(), agent.id);
      reconnus++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return {
    adresses: lecture.adresses.length, reconnus, inconnues,
    lignes: lecture.lignes, retenues: lecture.retenues, ecartees: lecture.ecartees,
  };
}
