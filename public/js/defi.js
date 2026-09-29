import { api, echapper, initialiserPage, alerte, confettis, animationsReduites } from '/js/commun.js';
import { reconnaitreVideo, lienVideoSur } from '/js/video.js';
import { libelleNiveau } from '/js/bareme.js';

await initialiserPage('/accueil');

const defiId = Number(location.pathname.split('/').pop());
const zone = document.getElementById('zone');

/**
 * Region vocale permanente.
 *
 * Un `role="status"` cree en meme temps que son contenu n'est pas annonce :
 * le lecteur d'ecran ne surveille que les regions deja presentes. Celle-ci vit
 * dans le gabarit, hors de la zone reecrite a chaque etape.
 */
const annonce = document.getElementById('annonce');
const annoncer = (texte) => { if (annonce) annonce.textContent = texte; };

/** Defilement respectueux du reglage « reduire les animations ». */
const glisser = () => (animationsReduites() ? 'auto' : 'smooth');
const remonter = () => window.scrollTo({ top: 0, behavior: glisser() });

/**
 * Porte le focus sur le titre de l'etape qui vient de s'afficher.
 *
 * Remplacer le contenu de la zone laissait le focus sur un bouton disparu,
 * donc sur <body> : au clavier il fallait retraverser tout l'en-tete, et le
 * lecteur d'ecran ne disait rien de la nouvelle question.
 */
function porterFocus(selecteur = '[data-etape]') {
  const cible = zone.querySelector(selecteur);
  if (cible) cible.focus({ preventScroll: true });
}

/** Titre de l'onglet : le meme pour les vingt defis ne repere rien. */
function majTitrePage(defiCourant) {
  if (!defiCourant?.titre) return;
  document.title = `Défi n°${defiCourant.numero} — ${defiCourant.titre} — Cybermois — Ville de Châtillon`;
}

// Le jeton d'apercu vit dans l'URL du navigateur, mais c'est l'API qui decide
// d'ouvrir un defi scelle : il doit donc accompagner chaque appel. Sans cela le
// lien partage affichait bien la page, et se faisait refuser au premier octet
// demande au serveur.
const jetonApercu = new URLSearchParams(location.search).get('apercu') || '';
const avecApercu = (chemin) => (jetonApercu
  ? `${chemin}${chemin.includes('?') ? '&' : '?'}apercu=${encodeURIComponent(jetonApercu)}`
  : chemin);

let defi = null;
let index = 0;          // question affichee
let choix = new Set();  // selection en cours

/* --------------------------------------------------------------- Chargement */

try {
  defi = await api(avecApercu(`/api/defis/${defiId}`));
  majTitrePage(defi);
  // On reprend la ou l'agent s'etait arrete : une session perdue ne doit pas
  // l'obliger a tout refaire.
  const repondues = new Set(defi.dejaRepondu || []);
  index = defi.questions.findIndex((q) => !repondues.has(q.id));
  const toutRepondu = index === -1;
  if (toutRepondu) index = defi.questions.length - 1;

  if (defi.close) afficherCloture();
  // Toutes les questions sont validees mais le defi n'a jamais ete cloture :
  // l'onglet a ete ferme entre la derniere correction et « Voir mon
  // resultat ». Reafficher la derniere question menait a un 409 au clic sur
  // « Valider », sans autre issue que d'abandonner le defi. On propose donc
  // directement la cloture, qui est la seule action qui reste a faire.
  else if (toutRepondu) afficherDefiComplet();
  // Une reprise va droit a la question suivante : reafficher l'introduction et
  // la video a quelqu'un qui a deja repondu a six questions lui redemande de
  // cliquer pour retrouver ou il en etait.
  else if (repondues.size > 0) afficherQuestion();
  else afficherIntro();
} catch (erreur) {
  alerte('alerte', erreur.message);
  zone.innerHTML = '<p><a class="btn btn-secondaire" href="/accueil">Retour aux défis</a></p>';
}

/* ------------------------------------------------------------------ Ecrans */

function afficherCloture() {
  zone.innerHTML = `
    <p class="numero-question">Défi n°${defi.numero}</p>
    <h1 style="margin-bottom:.15em" tabindex="-1" data-etape>${echapper(defi.titre)}</h1>
    <div class="message message-info" style="margin:1.5rem 0">
      <strong>La campagne est terminée.</strong> Le classement est définitif et les défis ne
      sont plus jouables. Vous pouvez toujours relire les questions et vos résultats depuis
      votre profil.
    </div>
    <div class="rang">
      <a class="btn btn-principal" href="/classement">Voir le classement définitif</a>
      <a class="btn btn-secondaire" href="/profil">Mes résultats</a>
    </div>`;
}

/**
 * Toutes les questions sont repondues, le defi n'est pas cloture.
 *
 * Cet ecran n'a qu'une action, et c'est precisement celle qui manquait : le
 * calcul du resultat. Il ferme la seule impasse du parcours.
 */
function afficherDefiComplet() {
  const total = defi.questions.length;

  zone.innerHTML = `
    <p class="numero-question">Défi n°${defi.numero}</p>
    <h1 style="margin-bottom:.15em" tabindex="-1" data-etape>Défi complet</h1>
    <div class="message message-succes" style="margin:1.5rem 0">
      Vous avez répondu aux ${total} questions de ce défi. Il ne reste qu'à en établir le
      résultat : votre session s'était interrompue juste avant.
    </div>
    <div class="zone-validation">
      <button type="button" class="btn btn-principal btn-bloc" id="btn-suivant">Voir mon résultat</button>
    </div>
    <p class="centre" style="margin-top:1rem">
      <a class="lien-discret" href="/accueil">Retour aux défis</a>
    </p>`;

  const bouton = document.getElementById('btn-suivant');
  bouton.addEventListener('click', () => terminer(bouton));
  annoncer(`Défi complet : ${total} questions répondues. Voir mon résultat.`);
  porterFocus();
}

function afficherIntro() {
  const total = defi.questions.length;

  zone.innerHTML = `
    <p class="numero-question">Défi n°${defi.numero}</p>
    <h1 style="margin-bottom:.15em" tabindex="-1" data-etape>${echapper(defi.titre)}</h1>
    <p style="font-style:italic;color:var(--encre-douce);margin-top:0">${echapper(defi.accroche)}</p>
    <!-- L'introduction se saisit dans un textarea : ses paragraphes doivent
         survivre a l'echappement, sinon tout se retrouve sur une seule ligne. -->
    <div class="carte" style="margin:1.5rem 0;white-space:pre-line">${echapper(defi.intro)}</div>

    ${defi.video ? blocVideo(defi.video)
      // Decorative : le titre et l'accroche disent deja tout, un lecteur
      // d'ecran n'a pas a entendre la description d'un dessin en plus.
      : defi.illustration ? `
      <figure class="illustration-defi">
        <img src="${echapper(defi.illustration)}" alt="" width="640" height="360">
      </figure>` : ''}

    ${defi.apercu ? `
      <div class="message message-alerte" style="margin-bottom:1.5rem">
        <strong>Aperçu — rien n'est enregistré.</strong> Vous jouez ce défi avant son
        ouverture : aucun score, aucun badge, aucune trace au classement. Le parcours est
        celui que verront les agents, à l'identique.
      </div>`
    : defi.entrainement ? `
      <div class="message message-info" style="margin-bottom:1.5rem">
        Vous avez déjà terminé ce défi : votre score est enregistré et ne changera plus.
        Vous pouvez le refaire librement, en mode entraînement.
      </div>` : ''}

    <div class="carte" style="margin-bottom:1.5rem">
      <h2 style="margin-bottom:.4em">Comment ça marche</h2>
      <p style="margin:0">
        Les questions s'affichent <strong>une par une</strong>. Vous validez, la correction
        s'affiche aussitôt : ce que vous avez trouvé, ce qui vous a échappé, et pourquoi.
        <strong>Une réponse validée ne se reprend pas</strong>, prenez le temps de lire les
        propositions.
      </p>
      <p class="discret" style="margin-bottom:0">
        ${total} questions · environ ${defi.dureeMinutes} minutes · aucune limite de temps.
      </p>
    </div>

    <button class="btn btn-principal btn-bloc" id="btn-commencer">Commencer</button>`;

  document.getElementById('btn-commencer').addEventListener('click', afficherQuestion);
  brancherVideo();
}

/**
 * Alternative textuelle a la video.
 *
 * Une video sans transcription n'a aucun equivalent pour qui ne l'entend pas,
 * ou pour qui ne peut pas la regarder depuis son poste. Elle est repliee : le
 * parcours reste celui de la video, l'alternative est la pour qui la cherche.
 */
function blocTranscription(video) {
  const texte = String(video?.transcription || '').trim();
  if (!texte) return '';
  return `
    <details class="carte" style="margin:.8rem 0 1.5rem">
      <summary class="ui" style="cursor:pointer;font-weight:700">Transcription</summary>
      <div style="white-space:pre-line;margin-top:.7rem">${echapper(texte)}</div>
    </details>`;
}

/**
 * Vignette locale plutot qu'insertion directe.
 *
 * Un lecteur YouTube insere dans la page appelle Google des l'affichage, et
 * depose ses traceurs avant meme que l'agent n'ait rien demande. Sur un portail
 * de sensibilisation cyber porte par une commune, ce serait difficile a
 * defendre. Rien n'est donc charge tant qu'on ne clique pas, et le clic vaut
 * consentement - il est annonce comme tel.
 */
function blocVideo(video) {
  // Le titre de la video ne s'affiche pas : deux titres l'un sous l'autre -
  // celui du defi, puis celui de la video - se confondaient, et l'agent ne
  // savait plus lequel designait quoi. Le titre saisi sert a l'administration,
  // pour reconnaitre le fichier ; ici, la place de la video suffit a dire ce
  // qu'elle est.
  const v = reconnaitreVideo(video.url, {
    domainesAutorises: defi?.videoDomaines || [],
    autoplay: true,
  });

  if (!v) {
    // L'adresse part dans un href : on ne lui fait pas confiance sur parole.
    // Seuls https et un fichier servi par ce serveur sont admis ; le reste -
    // « javascript: », « data: » - s'affiche en texte, ou il ne peut rien.
    const lien = lienVideoSur(video.url);
    return `
      <div class="carte" style="margin:1.5rem 0">
        ${lien
          ? `<a href="${echapper(lien)}" target="_blank" rel="noopener noreferrer">
               Voir la vidéo d’introduction
             </a>`
          : `<p style="margin:0">Vidéo d’introduction — adresse inutilisable :
               <span style="word-break:break-all">${echapper(video.url)}</span></p>`}
      </div>
      ${blocTranscription(video)}`;
  }

  // Fichier local : rien a consentir, donc rien a cliquer avant de voir.
  if (v.local) {
    return `
      <section class="carte bloc-video" style="margin:1.5rem 0">
        <div class="cadre-video">
          <video src="${echapper(v.source)}" controls preload="metadata"
                 style="width:100%;height:100%"></video>
        </div>
      </section>
      ${blocTranscription(video)}`;
  }

  return `
    <section class="carte bloc-video" style="margin:1.5rem 0">
      <div id="lecteur-video" class="vignette-video"
           data-embed="${echapper(v.embed)}">
        <button type="button" class="btn btn-principal" id="btn-lire-video">
          <span aria-hidden="true">▶</span> Regarder la vidéo
        </button>
        <p class="discret" style="margin:.7rem 0 0;font-size:.82rem;max-width:46ch">
          La vidéo est hébergée par ${echapper(v.hebergeur)}. Rien n'est chargé tant que vous
          ne cliquez pas : en lançant la lecture, vous acceptez le dépôt de cookies par ce service.
        </p>
      </div>
    </section>
    ${blocTranscription(video)}`;
}

function brancherVideo() {
  const bouton = document.getElementById('btn-lire-video');
  if (!bouton) return;

  bouton.addEventListener('click', () => {
    const zoneVideo = document.getElementById('lecteur-video');
    zoneVideo.outerHTML = `
      <div class="cadre-video">
        <iframe src="${echapper(zoneVideo.dataset.embed)}"
                title="Vidéo d'introduction du défi" allow="autoplay; encrypted-media; fullscreen"
                referrerpolicy="strict-origin-when-cross-origin" allowfullscreen loading="lazy"></iframe>
      </div>`;
  });
}

function afficherQuestion() {
  const q = defi.questions[index];
  const total = defi.questions.length;
  const pourcent = Math.round((index / total) * 100);
  choix = new Set();

  zone.innerHTML = `
    <div class="barre-progression">
      <div class="etat-progression">
        <span>Question ${index + 1} sur ${total}</span>
        <span>${libelleNiveau(q.difficulte) ? `${libelleNiveau(q.difficulte)} · ` : ''}${q.points} points</span>
      </div>
      <div class="piste" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pourcent}"
           aria-label="Progression dans le défi"><span style="width:${pourcent}%"></span></div>
    </div>

    <fieldset class="carte bloc-question" style="border:1px solid var(--bordure)">
      <legend class="sr-only">Question ${index + 1} sur ${total}</legend>
      <h2 style="font-size:1.25rem;margin:.2em 0 .6em" tabindex="-1" data-etape>${echapper(q.enonce)}</h2>
      ${q.contexte ? `<div class="contexte">${echapper(q.contexte)}</div>` : ''}
      <p class="consigne"><span aria-hidden="true">${q.multiple ? '☑' : '◉'}</span>
        ${q.multiple ? 'Plusieurs réponses possibles' : 'Une seule réponse'}</p>
      <ul class="liste-choix">
        ${q.reponses.map((r) => `
          <li class="choix">
            <label>
              <input type="${q.multiple ? 'checkbox' : 'radio'}" name="q${q.id}" value="${r.id}">
              <span class="etiquette">
                <span class="case ${q.multiple ? 'carree' : 'ronde'}" aria-hidden="true">✓</span>
                <span>${echapper(r.libelle)}</span>
              </span>
            </label>
          </li>`).join('')}
      </ul>
    </fieldset>

    <div class="zone-validation">
      <div id="avertissement"></div>
      <!-- La consigne etait le libelle d'un bouton desactive, affiche a 45 %
           d'opacite : la seule instruction de l'ecran etait aussi son texte le
           moins lisible. Elle vit maintenant dans un paragraphe normal, et le
           bouton garde un libelle stable. -->
      <p class="discret centre" id="consigne-validation" style="margin:0 0 .6rem">
        Sélectionnez une réponse pour continuer.
      </p>
      <button type="button" class="btn btn-principal btn-bloc" id="btn-valider"
              aria-describedby="consigne-validation" disabled>
        Valider ma réponse
      </button>
      <p class="discret centre" style="margin:.7rem 0 0">
        Une fois validée, la réponse ne peut plus être modifiée.
      </p>
    </div>`;

  const consigne = document.getElementById('consigne-validation');

  zone.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach((entree) =>
    entree.addEventListener('change', () => {
      if (q.multiple) {
        if (entree.checked) choix.add(Number(entree.value)); else choix.delete(Number(entree.value));
      } else {
        choix = new Set([Number(entree.value)]);
      }
      document.getElementById('btn-valider').disabled = choix.size === 0;
      consigne.hidden = choix.size > 0;
    }));

  document.getElementById('btn-valider').addEventListener('click', validerQuestion);
  remonter();
  annoncer(`Question ${index + 1} sur ${total}. ${q.enonce}`);
  porterFocus();
}

async function validerQuestion() {
  const q = defi.questions[index];
  const bouton = document.getElementById('btn-valider');
  bouton.disabled = true;
  bouton.textContent = 'Correction…';

  try {
    const r = await api(avecApercu(`/api/defis/${defiId}/questions/${q.id}`), {
      method: 'POST', body: { choix: [...choix] },
    });
    afficherCorrection(q, r);
  } catch (erreur) {
    alerte('avertissement', erreur.message);
    // Le bloc d'avertissement nait avec son message : il ne serait pas annonce.
    annoncer(erreur.message);
    bouton.disabled = false;
    bouton.textContent = 'Valider ma réponse';
  }
}

function afficherCorrection(q, r) {
  const total = defi.questions.length;
  const b = r.bilan;

  const items = r.reponses.map((rep) => {
    let classe = ''; let pastille = ''; let lecture = '';
    if (rep.choisie && rep.correcte) {
      classe = 'correcte'; pastille = 'verdict-bonne'; lecture = 'Bonne réponse';
    } else if (rep.choisie && !rep.correcte) {
      classe = 'fausse'; pastille = 'verdict-tort'; lecture = 'À tort';
    } else if (!rep.choisie && rep.correcte) {
      classe = 'manquee'; pastille = 'verdict-oubliee'; lecture = 'Oubliée';
    }

    return `<li class="choix ${classe}">
      <span class="etiquette">
        <span class="case ${q.multiple ? 'carree' : 'ronde'}"
              style="${rep.choisie ? 'background:var(--encre-douce);border-color:var(--encre-douce);color:#fff' : ''}"
              aria-hidden="true">${rep.choisie ? '✓' : ''}</span>
        <span>${echapper(rep.libelle)}</span>
        ${lecture ? `<span class="verdict-reponse ${pastille}">${lecture}</span>` : ''}
      </span></li>`;
  }).join('');

  // Un retour precis vaut mieux qu'un « faux » : on nomme ce qui a manque
  let verdict; let couleur;
  if (r.parfaite) { verdict = 'Réponse parfaite'; couleur = 'var(--succes)'; }
  else if (r.points > 0) { verdict = 'Réponse incomplète'; couleur = 'var(--alerte)'; }
  else { verdict = 'Réponse incorrecte'; couleur = 'var(--erreur)'; }

  const details = [];
  if (b.aTort.length) {
    details.push(`<p style="margin:.4rem 0"><strong>Vous avez coché à tort :</strong> ${
      b.aTort.map((x) => `« ${echapper(x)} »`).join(', ')}</p>`);
  }
  if (b.oubliees.length) {
    details.push(`<p style="margin:.4rem 0"><strong>Il fallait aussi cocher :</strong> ${
      b.oubliees.map((x) => `« ${echapper(x)} »`).join(', ')}</p>`);
  }
  if (r.parfaite && b.bonnesTotal > 1) {
    details.push(`<p style="margin:.4rem 0">Vous avez trouvé les ${b.bonnesTotal} bonnes réponses.</p>`);
  }

  zone.innerHTML = `
    <div class="barre-progression">
      <div class="etat-progression">
        <span>Question ${index + 1} sur ${total} — corrigée</span>
        <span>${r.scoreCourant} point${r.scoreCourant > 1 ? 's' : ''} au total</span>
      </div>
      <div class="piste" role="progressbar" aria-valuemin="0" aria-valuemax="100"
           aria-label="Progression dans le défi"
           aria-valuenow="${Math.round((r.progression.repondues / total) * 100)}">
        <span style="width:${Math.round((r.progression.repondues / total) * 100)}%"></span>
      </div>
    </div>

    <div class="carte bloc-question bloc-correction correction-animee" style="border:1px solid var(--bordure)">
      ${r.points > 0 ? `<span class="points-gagnes" aria-hidden="true">+${r.points}</span>` : ''}
      <p class="bandeau-note" style="color:${couleur}">
        <span aria-hidden="true">${r.parfaite ? '✅' : r.points > 0 ? '⚠️' : '❌'}</span>
        ${verdict} — ${r.points} / ${r.pointsMax} points
      </p>
      <h2 style="font-size:1.2rem;margin:.2em 0 .8em" tabindex="-1" data-etape>${echapper(q.enonce)}</h2>
      <ul class="liste-choix">${items}</ul>

      ${details.length ? `<div class="explication explication-bilan" style="border-left-color:${couleur}">${details.join('')}</div>` : ''}

      ${r.explication ? `
        <div class="explication explication-pourquoi">
          <strong>Pourquoi :</strong> ${echapper(r.explication)}
        </div>` : ''}
    </div>

    <div class="zone-validation">
      <button type="button" class="btn btn-principal btn-bloc" id="btn-suivant">
        ${r.derniere ? 'Voir mon résultat' : `Question suivante (${index + 2} sur ${total})`}
      </button>
    </div>`;

  const suivant = document.getElementById('btn-suivant');
  suivant.addEventListener('click', () => {
    if (r.derniere) return terminer(suivant);
    index++;
    return afficherQuestion();
  });

  // Une salve discrete sur une reponse parfaite : elle recompense sans envahir
  // la page, la pluie pleine hauteur restant reservee a la fin du defi.
  if (r.parfaite && !animationsReduites()) {
    const premiere = zone.querySelector('.choix.correcte');
    setTimeout(() => confettis({ nombre: 26, duree: 1100, depuis: premiere }), 420);
  }

  remonter();
  // Le verdict passe par la region permanente : cree en meme temps que son
  // contenu, un role="status" resterait muet.
  annoncer(`${verdict} — ${r.points} sur ${r.pointsMax} points.`);
  porterFocus();
}

/* ------------------------------------------------------------- Fin du defi */

async function terminer(declencheur) {
  const bouton = declencheur || document.getElementById('btn-suivant');
  const libelle = bouton?.textContent;
  if (bouton) {
    bouton.disabled = true;
    bouton.textContent = 'Calcul du résultat…';
  }

  let r;
  try {
    r = await api(avecApercu(`/api/defis/${defiId}/terminer`), { method: 'POST' });
  } catch (erreur) {
    alerte('alerte', erreur.message);
    annoncer(erreur.message);
    if (bouton) {
      bouton.disabled = false;
      bouton.textContent = libelle;
    }
    return;
  }

  const felicitations =
    r.pourcentage >= 90 ? 'Excellent !'
      : r.pourcentage >= 70 ? 'Bien joué !'
        : r.pourcentage >= 50 ? 'Pas mal !' : "Merci d'avoir joué !";

  zone.innerHTML = `
    <section class="carte score-final">
      <div class="score-cercle">
        <div>
          <div class="valeur">${r.pourcentage}<span style="font-size:1.4rem">%</span></div>
          <div class="sur">${r.score} / ${r.scoreMax} points</div>
        </div>
      </div>
      <h1 style="margin-bottom:.2em" tabindex="-1" data-etape>${felicitations}</h1>
      <p class="discret" style="margin-top:0">
        ${r.bonnes} réponse${r.bonnes > 1 ? 's' : ''} parfaite${r.bonnes > 1 ? 's' : ''} sur ${r.total}
      </p>

      ${r.entrainement ? `
        <div class="message message-info" style="text-align:left;margin-top:1.2rem">
          Mode entraînement : ce score ne modifie pas le classement, votre résultat initial reste en vigueur.
        </div>` : ''}

      ${r.nouveauxBadges?.length ? `
        <p class="ui" style="font-weight:700;margin-top:1.6rem;margin-bottom:0">Nouveaux badges débloqués</p>
        <div class="liste-badges">
          ${r.nouveauxBadges.map((b) => `<span class="badge-gagne"><span aria-hidden="true">${echapper(b.emoji)}</span> ${echapper(b.libelle)}</span>`).join('')}
        </div>` : ''}

      ${!r.entrainement && r.rangService?.rang ? `
        <div class="encart-rang">
          <strong>${echapper(r.rangService.detail?.service || '')}</strong> occupe la
          <strong>${r.rangService.rang}<sup>${r.rangService.rang === 1 ? 're' : 'e'}</sup> place</strong>
          sur ${r.rangService.total} directions${r.rangAgent?.rang
            ? ` · vous êtes ${r.rangAgent.rang}<sup>${r.rangAgent.rang === 1 ? 'er' : 'e'}</sup> au classement individuel` : ''}.
        </div>` : ''}

      <div class="rang" style="justify-content:center;margin-top:1.5rem">
        <a class="btn btn-principal" href="/classement">Voir le classement</a>
        <a class="btn btn-secondaire" href="/accueil">Retour aux défis</a>
      </div>
    </section>`;

  remonter();
  annoncer(`${felicitations} ${r.score} sur ${r.scoreMax} points, ${r.pourcentage} %.`);
  porterFocus();
  if (!r.entrainement && r.pourcentage >= 70) confettis({ nombre: 80, duree: 2400 });
}
