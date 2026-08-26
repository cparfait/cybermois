import { api, echapper, initialiserPage, alerte, confettis } from '/js/commun.js';

await initialiserPage('/accueil');

const semaine = Number(location.pathname.split('/').pop());
const zone = document.getElementById('zone');

let defi = null;
let index = 0;          // question affichee
let choix = new Set();  // selection en cours

/* --------------------------------------------------------------- Chargement */

try {
  defi = await api(`/api/defis/${semaine}`);
  // On reprend la ou l'agent s'etait arrete : une session perdue ne doit pas
  // l'obliger a tout refaire.
  const repondues = new Set(defi.dejaRepondu || []);
  index = defi.questions.findIndex((q) => !repondues.has(q.id));
  if (index === -1) index = defi.questions.length - 1;

  if (defi.close) afficherCloture();
  else afficherIntro(repondues.size);
} catch (erreur) {
  alerte('alerte', erreur.message);
  zone.innerHTML = '<p><a class="btn btn-secondaire" href="/accueil">Retour aux défis</a></p>';
}

/* ------------------------------------------------------------------ Ecrans */

function afficherCloture() {
  zone.innerHTML = `
    <p class="numero-question">Semaine ${defi.semaine}</p>
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
    <p class="numero-question">Semaine ${defi.semaine}</p>
    <h1 style="margin-bottom:.15em">${echapper(defi.titre)}</h1>
    <p style="font-style:italic;color:var(--encre-douce);margin-top:0">${echapper(defi.accroche)}</p>
    <div class="carte" style="margin:1.5rem 0">${echapper(defi.intro)}</div>

    ${defi.entrainement ? `
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
    const r = await api(`/api/defis/${semaine}/questions/${q.id}`, {
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

    <div class="carte bloc-question" style="border:1px solid var(--bordure)" role="status">
      <p class="bandeau-note" style="color:${couleur}">
        ${r.parfaite ? '✅' : r.points > 0 ? '⚠️' : '❌'} ${verdict} — ${r.points} / ${r.pointsMax} points
      </p>
      <h2 style="font-size:1.2rem;margin:.2em 0 .8em">${echapper(q.enonce)}</h2>
      <ul class="liste-choix">${items}</ul>

      ${details.length ? `<div class="explication" style="border-left-color:${couleur}">${details.join('')}</div>` : ''}

      ${r.explication ? `
        <div class="explication">
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

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------------------------------------------------- Fin du defi */

async function terminer() {
  const bouton = document.getElementById('btn-suivant');
  bouton.disabled = true;
  bouton.textContent = 'Calcul du résultat…';

  let r;
  try {
    r = await api(`/api/defis/${semaine}/terminer`, { method: 'POST' });
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
  if (!r.entrainement && r.pourcentage >= 70) confettis();
}
