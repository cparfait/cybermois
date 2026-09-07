import { api, echapper, initialiserPage, alerte, confettis, animationsReduites } from '/js/commun.js';

await initialiserPage('/accueil');

const defiId = Number(location.pathname.split('/').pop());
const zone = document.getElementById('zone');

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
  // On reprend la ou l'agent s'etait arrete : une session perdue ne doit pas
  // l'obliger a tout refaire.
  const repondues = new Set(defi.dejaRepondu || []);
  index = defi.questions.findIndex((q) => !repondues.has(q.id));
  if (index === -1) index = defi.questions.length - 1;

  if (defi.close) afficherCloture();
  // Une reprise va droit a la question suivante : reafficher l'introduction et
  // la video a quelqu'un qui a deja repondu a six questions lui redemande de
  // cliquer pour retrouver ou il en etait.
  else if (repondues.size > 0) afficherQuestion();
  else afficherIntro(0);
} catch (erreur) {
  alerte('alerte', erreur.message);
  zone.innerHTML = '<p><a class="btn btn-secondaire" href="/accueil">Retour aux défis</a></p>';
}

/* ------------------------------------------------------------------ Ecrans */

function afficherCloture() {
  zone.innerHTML = `
    <p class="numero-question">Défi n°${defi.numero}</p>
    <h1 style="margin-bottom:.15em">${echapper(defi.titre)}</h1>
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

function afficherIntro(dejaFaites) {
  const total = defi.questions.length;

  zone.innerHTML = `
    <p class="numero-question">Défi n°${defi.numero}</p>
    <h1 style="margin-bottom:.15em">${echapper(defi.titre)}</h1>
    <p style="font-style:italic;color:var(--encre-douce);margin-top:0">${echapper(defi.accroche)}</p>
    <div class="carte" style="margin:1.5rem 0">${echapper(defi.intro)}</div>

    ${defi.video ? blocVideo(defi.video) : ''}

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

    ${dejaFaites ? `
      <div class="message message-succes" style="margin-bottom:1.5rem">
        Vous aviez déjà répondu à ${dejaFaites} question${dejaFaites > 1 ? 's' : ''} :
        vous reprenez à la question ${index + 1}.
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

    <button class="btn btn-principal btn-bloc" id="btn-commencer">
      ${dejaFaites ? 'Reprendre le défi' : 'Commencer'}
    </button>`;

  document.getElementById('btn-commencer').addEventListener('click', afficherQuestion);
  brancherVideo();
}

/**
 * Reconnait l'hebergeur et compose l'adresse du lecteur.
 *
 * YouTube pour la plupart des contenus, Dailymotion parce que c'est la que
 * Cybermalveillance.gouv.fr publie son kit de sensibilisation - la source la
 * plus legitime pour une collectivite, et il aurait ete absurde de l'exclure.
 *
 * On accepte watch?v=, youtu.be, /embed/, /shorts/ et /video/ : personne ne
 * retient laquelle de ces adresses est la bonne.
 */
function reconnaitreVideo(url) {
  const brut = String(url || '');

  // Fichier depose par la collectivite : servi par ce serveur, sur le reseau
  // interne. Aucun tiers n'est appele, donc rien a consentir - la video se
  // lance directement, sans vignette intermediaire.
  if (/^\/videos\/[A-Za-z0-9._-]+$/.test(brut)) {
    return { hebergeur: 'la Ville', local: true, source: brut };
  }

  const yt = brut.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  if (yt) {
    return {
      hebergeur: 'YouTube',
      // Domaine sans cookie : le strict minimum une fois le consentement donne.
      embed: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt[1])}?rel=0&autoplay=1`,
    };
  }

  const dm = brut.match(/dailymotion\.com\/(?:embed\/)?video\/([A-Za-z0-9]+)|dai\.ly\/([A-Za-z0-9]+)/);
  if (dm) {
    return {
      hebergeur: 'Dailymotion',
      // Adresse du lecteur, sans passer par la redirection depuis
      // www.dailymotion.com : une redirection vers un autre domaine se heurte
      // a la politique de securite, et le lecteur reste vide sans rien dire.
      embed: `https://geo.dailymotion.com/player.html?video=${encodeURIComponent(dm[1] || dm[2])}&autoplay=1`,
    };
  }

  // Plateforme dont on ne connait pas le format d'insertion - l'ANSSI, une
  // autre collectivite. On insere l'adresse telle quelle, a condition que son
  // domaine soit autorise : sinon le navigateur la bloquerait sans rien dire,
  // et mieux vaut un lien qui fonctionne qu'un cadre vide.
  try {
    const u = new URL(brut);
    const autorises = defi?.videoDomaines || [];
    if (u.protocol === 'https:' && autorises.includes(u.hostname)) {
      return { hebergeur: u.hostname, embed: u.href };
    }
  } catch { /* adresse illisible : traitee comme un simple lien */ }

  return null;
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
  const v = reconnaitreVideo(video.url);
  if (!v) {
    return `
      <div class="carte" style="margin:1.5rem 0">
        <a href="${echapper(video.url)}" target="_blank" rel="noopener noreferrer">
          Voir la vidéo d’introduction
        </a>
      </div>`;
  }

  // Fichier local : rien a consentir, donc rien a cliquer avant de voir.
  if (v.local) {
    return `
      <section class="carte bloc-video" style="margin:1.5rem 0">
        <div class="cadre-video">
          <video src="${echapper(v.source)}" controls preload="metadata"
                 style="width:100%;height:100%"></video>
        </div>
      </section>`;
  }

  return `
    <section class="carte bloc-video" style="margin:1.5rem 0">
      <div id="lecteur-video" class="vignette-video"
           data-embed="${echapper(v.embed)}">
        <button type="button" class="btn btn-principal" id="btn-lire-video">
          ▶ Regarder la vidéo
        </button>
        <p class="discret" style="margin:.7rem 0 0;font-size:.82rem;max-width:46ch">
          La vidéo est hébergée par ${echapper(v.hebergeur)}. Rien n'est chargé tant que vous
          ne cliquez pas : en lançant la lecture, vous acceptez le dépôt de cookies par ce service.
        </p>
      </div>
    </section>`;
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
        <span>${q.points} points</span>
      </div>
      <div class="piste" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pourcent}"
           aria-label="Progression dans le défi"><span style="width:${pourcent}%"></span></div>
    </div>

    <fieldset class="carte bloc-question" style="border:1px solid var(--bordure)">
      <legend class="sr-only">Question ${index + 1} sur ${total}</legend>
      <h2 style="font-size:1.25rem;margin:.2em 0 .6em">${echapper(q.enonce)}</h2>
      ${q.contexte ? `<div class="contexte">${echapper(q.contexte)}</div>` : ''}
      <p class="consigne">${q.multiple ? '☑ Plusieurs réponses possibles' : '◉ Une seule réponse'}</p>
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
      <div id="avertissement" aria-live="polite"></div>
      <button type="button" class="btn btn-principal btn-bloc" id="btn-valider" disabled>
        Sélectionnez une réponse
      </button>
      <p class="discret centre" style="margin:.7rem 0 0">
        Une fois validée, la réponse ne peut plus être modifiée.
      </p>
    </div>`;

  zone.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach((entree) =>
    entree.addEventListener('change', () => {
      if (q.multiple) {
        if (entree.checked) choix.add(Number(entree.value)); else choix.delete(Number(entree.value));
      } else {
        choix = new Set([Number(entree.value)]);
      }
      const bouton = document.getElementById('btn-valider');
      bouton.disabled = choix.size === 0;
      bouton.textContent = choix.size === 0 ? 'Sélectionnez une réponse' : 'Valider ma réponse';
    }));

  document.getElementById('btn-valider').addEventListener('click', validerQuestion);
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
           aria-valuenow="${Math.round((r.progression.repondues / total) * 100)}">
        <span style="width:${Math.round((r.progression.repondues / total) * 100)}%"></span>
      </div>
    </div>

    <div class="carte bloc-question bloc-correction correction-animee" style="border:1px solid var(--bordure)" role="status">
      ${r.points > 0 ? `<span class="points-gagnes" aria-hidden="true">+${r.points}</span>` : ''}
      <p class="bandeau-note" style="color:${couleur}">
        ${r.parfaite ? '✅' : r.points > 0 ? '⚠️' : '❌'} ${verdict} — ${r.points} / ${r.pointsMax} points
      </p>
      <h2 style="font-size:1.2rem;margin:.2em 0 .8em">${echapper(q.enonce)}</h2>
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

  document.getElementById('btn-suivant').addEventListener('click', async () => {
    if (r.derniere) return terminer();
    index++;
    afficherQuestion();
  });

  // Une salve discrete sur une reponse parfaite : elle recompense sans envahir
  // la page, la pluie pleine hauteur restant reservee a la fin du defi.
  if (r.parfaite && !animationsReduites()) {
    const premiere = zone.querySelector('.choix.correcte');
    setTimeout(() => confettis({ nombre: 26, duree: 1100, depuis: premiere }), 420);
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------------------------------------------------- Fin du defi */

async function terminer() {
  const bouton = document.getElementById('btn-suivant');
  bouton.disabled = true;
  bouton.textContent = 'Calcul du résultat…';

  let r;
  try {
    r = await api(avecApercu(`/api/defis/${defiId}/terminer`), { method: 'POST' });
  } catch (erreur) {
    alerte('alerte', erreur.message);
    bouton.disabled = false;
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
      <h1 style="margin-bottom:.2em">${felicitations}</h1>
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
          ${r.nouveauxBadges.map((b) => `<span class="badge-gagne">${b.emoji} ${echapper(b.libelle)}</span>`).join('')}
        </div>` : ''}

      ${!r.entrainement && r.rangService?.rang ? `
        <div class="encart-rang">
          <strong>${echapper(r.rangService.detail?.service || '')}</strong> occupe la
          <strong>${r.rangService.rang}<sup>${r.rangService.rang === 1 ? 're' : 'e'}</sup> place</strong>
          sur ${r.rangService.total} services${r.rangAgent?.rang
            ? ` · vous êtes ${r.rangAgent.rang}<sup>${r.rangAgent.rang === 1 ? 'er' : 'e'}</sup> au classement individuel` : ''}.
        </div>` : ''}

      <div class="rang" style="justify-content:center;margin-top:1.5rem">
        <a class="btn btn-principal" href="/classement">Voir le classement</a>
        <a class="btn btn-secondaire" href="/accueil">Retour aux défis</a>
      </div>
    </section>`;

  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (!r.entrainement && r.pourcentage >= 70) confettis({ nombre: 80, duree: 2400 });
}
