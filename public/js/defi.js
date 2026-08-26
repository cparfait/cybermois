import { api, echapper, initialiserPage, alerte, confettis } from '/js/commun.js';

await initialiserPage('/accueil');

const semaine = Number(location.pathname.split('/').pop());
const zone = document.getElementById('zone');
const choixAgent = new Map(); // questionId -> Set(reponseId)
let debut = null;
let defi = null;

/* --------------------------------------------------------------- Affichage */

function afficherDefi() {
  const total = defi.questions.length;

  zone.innerHTML = `
    <p class="numero-question">Semaine ${defi.semaine}</p>
    <h1 style="margin-bottom:.15em">${echapper(defi.titre)}</h1>
    <p style="font-style:italic;color:var(--encre-douce);margin-top:0">${echapper(defi.accroche)}</p>
    <div class="carte" style="margin:1.5rem 0">${echapper(defi.intro)}</div>

    ${defi.entrainement ? `
      <div class="message message-info" style="margin-bottom:1.5rem">
        Vous avez déjà terminé ce défi : votre score est enregistré et ne changera plus.
        Vous pouvez le refaire librement, en mode entraînement.
      </div>` : ''}

    <div class="barre-progression">
      <div class="etat-progression">
        <span id="etat-texte">0 question sur ${total} répondue</span>
        <span id="etat-pourcent">0 %</span>
      </div>
      <div class="piste" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"
           aria-label="Progression dans le défi"><span id="piste-remplie" style="width:0%"></span></div>
    </div>

    <form id="formulaire-defi">
      ${defi.questions.map((q, i) => construireQuestion(q, i, total)).join('')}
    </form>

    <div class="zone-validation">
      <div id="avertissement" aria-live="polite"></div>
      <button type="button" class="btn btn-principal btn-bloc" id="btn-valider" disabled>
        Valider mes réponses
      </button>
      <p class="discret centre" style="margin:.7rem 0 0">
        Vous ne pouvez valider qu'une fois : prenez le temps de relire.
      </p>
    </div>`;

  document.getElementById('formulaire-defi').addEventListener('change', surChangement);
  document.getElementById('btn-valider').addEventListener('click', valider);
  // Affiche d'emblee combien de questions restent, plutot qu'un bouton
  // desactive sans explication.
  majProgression();
  debut = Date.now();
}

function construireQuestion(q, index, total) {
  const type = q.multiple ? 'checkbox' : 'radio';
  const forme = q.multiple ? 'carree' : 'ronde';

  return `
  <fieldset class="carte bloc-question" id="question-${q.id}" style="border:1px solid var(--bordure)">
    <legend class="sr-only">Question ${index + 1} sur ${total}</legend>
    <p class="numero-question">Question ${index + 1} / ${total} — ${q.points} points</p>
    <h2 style="font-size:1.2rem;margin:.3em 0 .6em">${echapper(q.enonce)}</h2>
    ${q.contexte ? `<div class="contexte">${echapper(q.contexte)}</div>` : ''}
    <p class="consigne">${q.multiple ? '☑ Plusieurs réponses possibles' : '◉ Une seule réponse'}</p>
    <ul class="liste-choix">
      ${q.reponses.map((r) => `
        <li class="choix" data-reponse="${r.id}">
          <label>
            <input type="${type}" name="q${q.id}" value="${r.id}" data-question="${q.id}">
            <span class="etiquette">
              <span class="case ${forme}" aria-hidden="true">✓</span>
              <span>${echapper(r.libelle)}</span>
            </span>
          </label>
        </li>`).join('')}
    </ul>
  </fieldset>`;
}

/* ------------------------------------------------------------ Interactions */

function surChangement(evenement) {
  const entree = evenement.target;
  if (!entree.dataset.question) return;
  const questionId = Number(entree.dataset.question);
  const question = defi.questions.find((q) => q.id === questionId);

  if (question.multiple) {
    const set = choixAgent.get(questionId) || new Set();
    if (entree.checked) set.add(Number(entree.value)); else set.delete(Number(entree.value));
    if (set.size) choixAgent.set(questionId, set); else choixAgent.delete(questionId);
  } else {
    choixAgent.set(questionId, new Set([Number(entree.value)]));
  }
  majProgression();
}

function majProgression() {
  const total = defi.questions.length;
  const repondues = choixAgent.size;
  const pourcent = Math.round((repondues / total) * 100);

  document.getElementById('etat-texte').textContent =
    `${repondues} question${repondues > 1 ? 's' : ''} sur ${total} répondue${repondues > 1 ? 's' : ''}`;
  document.getElementById('etat-pourcent').textContent = `${pourcent} %`;
  document.getElementById('piste-remplie').style.width = `${pourcent}%`;
  document.querySelector('.piste').setAttribute('aria-valuenow', String(pourcent));

  const bouton = document.getElementById('btn-valider');
  bouton.disabled = repondues < total;
  bouton.textContent = repondues < total
    ? `Encore ${total - repondues} question${total - repondues > 1 ? 's' : ''} à répondre`
    : 'Valider mes réponses';
}

/* -------------------------------------------------------------- Validation */

async function valider() {
  const manquantes = defi.questions.filter((q) => !choixAgent.has(q.id));
  if (manquantes.length) {
    alerte('avertissement', `Il reste ${manquantes.length} question(s) sans réponse.`, 'alerte');
    document.getElementById(`question-${manquantes[0].id}`).scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const bouton = document.getElementById('btn-valider');
  bouton.disabled = true;
  bouton.textContent = 'Correction en cours…';

  const reponses = {};
  for (const [questionId, set] of choixAgent) reponses[questionId] = [...set];

  try {
    const resultat = await api(`/api/defis/${semaine}/valider`, {
      method: 'POST',
      body: { reponses, dureeSecondes: Math.round((Date.now() - debut) / 1000) },
    });
    afficherResultat(resultat);
  } catch (erreur) {
    alerte('avertissement', erreur.message);
    bouton.disabled = false;
    bouton.textContent = 'Valider mes réponses';
  }
}

function afficherResultat(r) {
  const felicitations =
    r.pourcentage >= 90 ? 'Excellent !' :
    r.pourcentage >= 70 ? 'Bien joué !' :
    r.pourcentage >= 50 ? 'Pas mal !' : 'Merci d\'avoir joué !';

  const corrections = r.detail.map((d, i) => {
    const choix = new Set(d.choixAgent);
    const bonnes = new Set(d.bonnesReponses);

    const items = d.reponses.map((rep) => {
      const coche = choix.has(rep.id);
      const juste = bonnes.has(rep.id);
      let classe = ''; let marque = '';
      if (coche && juste) { classe = 'correcte'; marque = '✅'; }
      else if (coche && !juste) { classe = 'fausse'; marque = '❌'; }
      else if (!coche && juste) { classe = 'manquee'; marque = '➕ oubliée'; }

      return `<li class="choix ${classe}">
        <span class="etiquette">
          <span class="case ${d.reponses.length && bonnes.size > 1 ? 'carree' : 'ronde'}"
                style="${coche ? 'background:var(--encre-douce);border-color:var(--encre-douce);color:#fff' : ''}"
                aria-hidden="true">${coche ? '✓' : ''}</span>
          <span>${echapper(rep.libelle)}</span>
          <span class="marque">${marque}</span>
        </span></li>`;
    }).join('');

    return `
      <fieldset class="carte bloc-question" style="border:1px solid var(--bordure)">
        <legend class="sr-only">Correction de la question ${i + 1}</legend>
        <p class="bandeau-note" style="color:${d.parfaite ? 'var(--succes)' : 'var(--alerte)'}">
          ${d.parfaite ? '✅ Réponse parfaite' : '⚠️ Réponse incomplète'} — ${d.points} / ${d.pointsMax} points
        </p>
        <h2 style="font-size:1.15rem;margin:.2em 0 .8em">${echapper(d.enonce)}</h2>
        <ul class="liste-choix">${items}</ul>
        ${d.explication ? `<div class="explication"><strong>Pourquoi :</strong> ${echapper(d.explication)}</div>` : ''}
      </fieldset>`;
  }).join('');

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
        ${r.bonus > 0 ? ` · bonus rapidité : +${r.bonus} points` : ''}
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
          sur ${r.rangService.total} services${r.rangAgent?.rang ? ` · vous êtes ${r.rangAgent.rang}<sup>${r.rangAgent.rang === 1 ? 'er' : 'e'}</sup> au classement individuel` : ''}.
        </div>` : ''}

      <div class="rang" style="justify-content:center;margin-top:1.5rem">
        <a class="btn btn-principal" href="/classement">Voir le classement</a>
        <a class="btn btn-secondaire" href="/accueil">Retour aux défis</a>
      </div>
    </section>

    <h2 style="margin-top:2.5rem">Les corrections</h2>
    <p class="discret">Prenez une minute pour les parcourir : c'est là que tout se joue.</p>
    ${corrections}

    <div class="rang" style="justify-content:center;margin:2rem 0">
      <a class="btn btn-principal" href="/accueil">Retour aux défis</a>
    </div>`;

  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (!r.entrainement && r.pourcentage >= 70) confettis();
}

/* ---------------------------------------------------------------- Chargement */

try {
  defi = await api(`/api/defis/${semaine}`);
  afficherDefi();
} catch (erreur) {
  alerte('alerte', erreur.message);
  zone.innerHTML = '<p><a class="btn btn-secondaire" href="/accueil">Retour aux défis</a></p>';
}
