import nodemailer from 'nodemailer';
import { config } from './config.js';
import { db } from './db.js';
import { classementServices, classementAgents, statistiquesGlobales } from './scoring.js';

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
 * Mail de lancement : destine a etre copie-colle par la DPO depuis sa propre boite.
 *
 * La premiere semaine n'annonce pas un defi, elle ouvre une operation : il faut
 * dire qui la porte, ce qui est mesure, et ce qui ne l'est pas. Un agent qui
 * decouvre un classement nominatif sans avoir rien lu se demande d'abord si sa
 * hierarchie va voir son score - et ne joue pas. Les semaines suivantes se
 * contentent d'annoncer le defi, l'operation etant deja connue.
 */
export function mailLancement(semaine) {
  const defi = db.prepare('SELECT * FROM defis WHERE semaine = ?').get(semaine);
  if (!defi) return null;
  const lien = `${config.publicUrl}/defi/${semaine}`;
  const nbDefis = db.prepare('SELECT COUNT(*) AS n FROM defis WHERE publie = 1').get().n;

  if (Number(semaine) === 1) return mailOuverture(defi, lien, nbDefis);

  const corps = `
<p>Bonjour à toutes et à tous,</p>
<p>Le <strong>Cybermois</strong> se poursuit à la Ville de Châtillon. Le défi de cette semaine est en ligne :</p>
<h2 style="font-family:'Montserrat',Arial,sans-serif;font-size:21px;color:#006e46;margin:22px 0 6px;">Semaine ${semaine} — ${echapper(defi.titre)}</h2>
<p style="font-style:italic;color:#4a5a53;margin-top:0;">${echapper(defi.accroche)}</p>
<p>${echapper(defi.intro)}</p>
<p><strong>${defi.duree_minutes} minutes suffisent.</strong> Connectez-vous avec vos identifiants habituels de session Windows.</p>
${bouton(lien, 'Je relève le défi')}
<p>Chaque bonne réponse rapporte des points à <strong>votre service</strong>. Le classement est mis à jour en direct : allez voir où vous en êtes.</p>
<p>Bonne chance,<br>La déléguée à la protection des données</p>`;

  return {
    objet: `Cybermois — Semaine ${semaine} : ${defi.titre}`,
    html: gabarit({ titre: `Semaine ${semaine}`, preheader: defi.accroche, corps }),
    texte: versTexte(corps),
  };
}

/**
 * Ouverture de la campagne, signee de la DPO.
 *
 * Trois choses doivent y figurer, et l'ordre compte. Ce qu'on demande - cinq
 * minutes, pas un examen. Ce qui est mesure et vu par qui : un classement
 * nominatif decouvert sans preavis fait fuir plus d'agents qu'il n'en motive.
 * Et l'information RGPD, qui n'est pas une formalite mais precisement ce qui
 * rend la premiere credible.
 */
function mailOuverture(defi, lien, nbDefis) {
  const corps = `
<p>Bonjour à toutes et à tous,</p>

<p>Octobre est le <strong>mois européen de la cybersécurité</strong>. La Ville de Châtillon
y participe cette année avec une opération courte, ouverte à tous les agents :
<strong>le Cybermois</strong>.</p>

<h2 style="font-family:'Montserrat',Arial,sans-serif;font-size:21px;color:#006e46;margin:22px 0 6px;">Semaine 1 — ${echapper(defi.titre)}</h2>
<p style="font-style:italic;color:#4a5a53;margin-top:0;">${echapper(defi.accroche)}</p>

<p><strong>${nbDefis} défis, un par semaine, ${defi.duree_minutes} minutes chacun.</strong>
Des questions concrètes, tirées de situations qui se produisent vraiment dans une
collectivité. Après chaque réponse, la correction vous dit ce que vous avez trouvé,
ce qui vous a échappé, et pourquoi.</p>

${bouton(lien, 'Je relève le premier défi')}

<p>Connectez-vous avec <strong>vos identifiants de session Windows</strong> — votre
identifiant ou votre adresse professionnelle, au choix. Il n'y a rien à installer,
et vous pouvez jouer depuis un téléphone.</p>

<h3 style="font-family:'Montserrat',Arial,sans-serif;font-size:17px;color:#006e46;margin:26px 0 6px;">Ce n'est pas un examen</h3>
<p>Aucun résultat individuel n'est transmis à votre hiérarchie, et se tromper n'a
aucune conséquence : c'est même l'intérêt de l'exercice. Les questions sont conçues
pour piéger des gens attentifs, parce que les attaques réelles le sont aussi.</p>

<p>Le classement se fait <strong>par service</strong> : chaque défi terminé rapporte des
points au vôtre. Un classement individuel existe aussi ; si vous préférez ne pas y
figurer nominativement, écrivez-moi — votre participation continuera de compter pour
votre service, sans que votre nom apparaisse.</p>

<h3 style="font-family:'Montserrat',Arial,sans-serif;font-size:17px;color:#006e46;margin:26px 0 6px;">Vos données</h3>
<p>Le portail utilise votre identifiant, votre nom, votre adresse professionnelle et
votre service, lus dans l'annuaire de la collectivité. Vos réponses et vos scores sont
conservés jusqu'à la fin de l'année suivant la campagne ; un décompte du nombre de
défis suivis est gardé trois ans comme preuve de l'action de sensibilisation.
<strong>Votre mot de passe n'est jamais enregistré</strong> : il sert uniquement à vous
authentifier auprès de l'annuaire.</p>

<p>Vous disposez d'un droit d'accès, de rectification, d'effacement, de limitation et
d'opposition sur ces données. Les mentions légales complètes sont accessibles depuis le
portail, et je reste à votre disposition pour toute question.</p>

<p>Bonne campagne à toutes et à tous,</p>
<p>La déléguée à la protection des données<br>Ville de Châtillon</p>`;

  return {
    objet: `Cybermois : ${nbDefis} défis pour aiguiser vos réflexes — le premier est en ligne`,
    html: gabarit({
      titre: 'Ouverture du Cybermois',
      preheader: `${nbDefis} défis, ${defi.duree_minutes} minutes chacun. Le classement se fait par service.`,
      corps,
    }),
    texte: versTexte(corps),
  };
}

export function mailRelance(agent, semaine) {
  const defi = db.prepare('SELECT * FROM defis WHERE semaine = ?').get(semaine);
  if (!defi) return null;
  const lien = `${config.publicUrl}/defi/${semaine}`;
  const stats = classementServices().find((s) => s.service === agent.service);

  const corps = `
<p>Bonjour ${echapper((agent.nom_complet || '').split(' ')[0] || '')},</p>
<p>Le défi de la semaine ${semaine}, <strong>${echapper(defi.titre)}</strong>, vous attend toujours.</p>
<p style="background:#f4f8dd;border-left:4px solid #aec80c;padding:12px 16px;margin:20px 0;">
  ${stats
    ? `Votre service — <strong>${echapper(agent.service)}</strong> — affiche <strong>${stats.taux_participation} %</strong> de participation. Chaque défi terminé fait monter votre service au classement.`
    : `Votre participation fera monter <strong>${echapper(agent.service)}</strong> au classement.`}
</p>
<p><strong>${defi.duree_minutes} minutes</strong>, pas plus. Et il n'y a rien à installer.</p>
${bouton(lien, 'Faire le défi maintenant')}
<p style="font-size:14px;color:#4a5a53;">Vous pouvez encore rattraper les défis des semaines précédentes : ils restent ouverts jusqu'au 31 octobre.</p>`;

  return {
    objet: `Il vous reste 5 minutes ? Le défi « ${defi.titre} » vous attend`,
    html: gabarit({ titre: 'Relance', preheader: `Semaine ${semaine} : ${defi.accroche}`, corps }),
    texte: versTexte(corps),
  };
}

export function mailResultats(semaine) {
  const services = classementServices();
  const agents = classementAgents(10);
  const stats = statistiquesGlobales();
  const defi = db.prepare('SELECT * FROM defis WHERE semaine = ?').get(semaine);

  const medaille = ['🥇', '🥈', '🥉'];
  const ligneService = (s, i) => `
    <tr style="border-bottom:1px solid #d9e4de;">
      <td style="padding:9px 6px;font-family:'Montserrat',Arial,sans-serif;font-weight:700;width:38px;">${medaille[i] || `${i + 1}.`}</td>
      <td style="padding:9px 6px;">${echapper(s.service)}</td>
      <td style="padding:9px 6px;text-align:right;font-family:'Montserrat',Arial,sans-serif;font-weight:700;color:#006e46;white-space:nowrap;">${s.score_moyen} pts</td>
      <td style="padding:9px 6px;text-align:right;font-family:'Montserrat',Arial,sans-serif;font-size:13px;color:#4a5a53;white-space:nowrap;">${s.taux_participation} %</td>
    </tr>`;

  const ligneAgent = (a, i) => `
    <tr style="border-bottom:1px solid #d9e4de;">
      <td style="padding:9px 6px;font-family:'Montserrat',Arial,sans-serif;font-weight:700;width:38px;">${medaille[i] || `${i + 1}.`}</td>
      <td style="padding:9px 6px;">${echapper(a.nom_complet)}<br><span style="font-size:13px;color:#4a5a53;">${echapper(a.service)}</span></td>
      <td style="padding:9px 6px;text-align:right;font-family:'Montserrat',Arial,sans-serif;font-weight:700;color:#006e46;white-space:nowrap;">${a.score_total} pts</td>
    </tr>`;

  const corps = `
<p>Bonjour à toutes et à tous,</p>
<p>Voici les résultats de la <strong>semaine ${semaine}${defi ? ` — ${echapper(defi.titre)}` : ''}</strong>.</p>

<table role="presentation" width="100%" style="background:#e6f1ec;border-radius:10px;padding:4px;margin:20px 0;"><tr>
  <td align="center" style="padding:14px 6px;"><div style="font-family:'Montserrat',Arial,sans-serif;font-size:26px;font-weight:900;color:#006e46;">${stats.joueurs}</div><div style="font-size:13px;color:#4a5a53;">participants</div></td>
  <td align="center" style="padding:14px 6px;"><div style="font-family:'Montserrat',Arial,sans-serif;font-size:26px;font-weight:900;color:#006e46;">${stats.inscrits ? Math.round((stats.joueurs / stats.inscrits) * 100) : 0} %</div><div style="font-size:13px;color:#4a5a53;">de participation</div></td>
  <td align="center" style="padding:14px 6px;"><div style="font-family:'Montserrat',Arial,sans-serif;font-size:26px;font-weight:900;color:#006e46;">${stats.points_cumules}</div><div style="font-size:13px;color:#4a5a53;">points cumulés</div></td>
</tr></table>

<h2 style="font-family:'Montserrat',Arial,sans-serif;font-size:19px;color:#006e46;margin:26px 0 8px;">🏆 Classement des services</h2>
<p style="font-size:13px;color:#4a5a53;margin-top:0;">Score moyen par agent du service, et taux de participation.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;">${services.slice(0, 10).map(ligneService).join('')}</table>

<h2 style="font-family:'Montserrat',Arial,sans-serif;font-size:19px;color:#006e46;margin:26px 0 8px;">⭐ Classement individuel</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;">${agents.map(ligneAgent).join('')}</table>

${bouton(`${config.publicUrl}/classement`, 'Voir le classement complet')}
<p>Les défis des semaines précédentes restent accessibles : il n'est jamais trop tard pour faire gagner des points à votre service.</p>
<p>Bon week-end,<br>La Direction des systèmes d'information</p>`;

  return {
    objet: `Cybermois — Résultats de la semaine ${semaine}`,
    html: gabarit({ titre: 'Résultats', preheader: `${stats.joueurs} participants, classement des services`, corps }),
    texte: versTexte(corps),
  };
}

export function mailDiplome(agent) {
  const corps = `
<p>Bonjour ${echapper((agent.nom_complet || '').split(' ')[0] || '')},</p>
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
  if (!config.smtp.actif) throw new Error('Envoi desactive (MAIL_ENVOI_ACTIF=false)');
  await t.sendMail({
    from: config.smtp.from,
    to, bcc,
    cc: config.smtp.copie || undefined,
    subject: objet,
    html, text: texte,
  });
}

/** Relance des agents n'ayant pas encore joue le defi de la semaine donnee. */
export async function envoyerRelances(semaine, { simulation = false } = {}) {
  const defi = db.prepare('SELECT id FROM defis WHERE semaine = ? AND publie = 1').get(semaine);
  if (!defi) return { ok: false, message: `Semaine ${semaine} introuvable ou non publiee.` };

  const cibles = db.prepare(`
    SELECT a.* FROM agents a
    WHERE a.email IS NOT NULL AND a.email <> ''
      AND a.exclu = 0
      AND NOT EXISTS (SELECT 1 FROM participations p WHERE p.agent_id = a.id AND p.defi_id = ? AND p.entrainement = 0)
  `).all(defi.id);

  if (simulation) return { ok: true, simulation: true, destinataires: cibles.length, apercu: cibles.slice(0, 5).map((a) => a.email) };

  let succes = 0; let derniereErreur = null;
  for (const agent of cibles) {
    try {
      const m = mailRelance(agent, semaine);
      await envoyer({ to: agent.email, ...m });
      succes++;
    } catch (err) { derniereErreur = err.message; }
  }

  db.prepare('INSERT INTO envois (type, semaine, destinataires, succes, erreur) VALUES (?, ?, ?, ?, ?)')
    .run('relance', semaine, cibles.length, succes, derniereErreur);

  return { ok: true, destinataires: cibles.length, succes, erreur: derniereErreur };
}

/** Resultats hebdomadaires envoyes au groupe de distribution. */
export async function envoyerResultats(semaine, { simulation = false } = {}) {
  const m = mailResultats(semaine);
  if (simulation) return { ok: true, simulation: true, destinataires: config.smtp.groupeDiffusion, apercu: m.objet };
  if (!config.smtp.groupeDiffusion) return { ok: false, message: 'MAIL_GROUPE_DIFFUSION non renseigne.' };

  try {
    await envoyer({ to: config.smtp.groupeDiffusion, ...m });
    db.prepare('INSERT INTO envois (type, semaine, destinataires, succes) VALUES (?, ?, 1, 1)').run('resultats', semaine);
    return { ok: true, destinataires: 1, succes: 1 };
  } catch (err) {
    db.prepare('INSERT INTO envois (type, semaine, destinataires, succes, erreur) VALUES (?, ?, 1, 0, ?)').run('resultats', semaine, err.message);
    return { ok: false, message: err.message };
  }
}
