import { api, echapper, initialiserPage, alerte, formaterDate } from '/js/commun.js';

/**
 * Relecture d'un defi termine.
 *
 * « Revoir les corrections » renvoyait au questionnaire, qui repartait en mode
 * entrainement : on rejouait au lieu de relire, et ce qu'on cherchait - sa
 * propre reponse - disparaissait a la premiere validation.
 *
 * Cet ecran ne propose rien a modifier : pas de champ, pas de bouton desactive
 * qui inviterait encore a essayer. Juste ce qui a ete repondu, ce qui etait
 * attendu, et pourquoi.
 */

await initialiserPage('/accueil');

const defiId = Number(location.pathname.split('/').pop());
const zone = document.getElementById('zone');

/**
 * Une proposition telle qu'elle a ete vue.
 * Declaree avant le rendu : `bloc()` est hissee, pas cette constante - l'appeler
 * depuis le corps du module en dessous jetait « Cannot access before
 * initialization », et la page ne montrait plus que le bouton de retour.
 */
const ligne = (r, classe, marqueur, lecture) => `
  <li class="${classe}">
    <span class="marqueur" aria-hidden="true">${marqueur}</span>
    <span>${echapper(r.libelle)}${lecture ? `<span class="sr-only"> — ${lecture}</span>` : ''}</span>
  </li>`;

try {
  const d = await api(`/api/defis/${defiId}/relecture`);
  const pourcentage = d.scoreMax ? Math.round((d.score / d.scoreMax) * 100) : 0;
  // formaterDate de commun.js fait deja ce travail, et le faisait deja ici a
  // l'identique : deux ecritures d'une meme date finissent toujours par
  // diverger.
  const date = formaterDate(d.termineLe);

  // Le titre de l'onglet etait « Mes réponses » pour les vingt defis : dans un
  // historique de navigation ou un jeu d'onglets, rien ne les distinguait.
  document.title = `Défi n°${d.numero} — ${d.titre} — mes réponses — Cybermois — Ville de Châtillon`;

  zone.innerHTML = `
    <p class="numero-question">Défi n°${d.numero}</p>
    <h1 style="margin-bottom:.15em">${echapper(d.titre)}</h1>
    <p style="font-style:italic;color:var(--encre-douce);margin-top:0">${echapper(d.accroche || '')}</p>

    <div class="carte" style="margin:1.5rem 0">
      <div class="rang" style="justify-content:space-between;align-items:baseline;flex-wrap:wrap">
        <div>
          <strong style="font-size:1.3rem">${d.score} / ${d.scoreMax} points</strong>
          <span class="discret"> — ${pourcentage} %, ${d.bonnes} question(s) parfaite(s) sur ${d.total}</span>
        </div>
        ${date ? `<span class="discret">Terminé le ${echapper(date)}</span>` : ''}
      </div>
      <p class="discret" style="margin:.8rem 0 0">
        Ce résultat est définitif : cette page ne sert qu'à relire. Pour vous entraîner
        de nouveau sur ces questions, retournez au défi depuis la liste.
      </p>
    </div>

    ${d.questions.map((q, i) => bloc(q, i)).join('')}

    <div class="rang" style="margin-top:1.5rem">
      <a class="btn btn-secondaire" href="/accueil">Retour aux défis</a>
      <a class="btn btn-secondaire" href="/profil">Mon profil</a>
    </div>`;
} catch (erreur) {
  alerte('alerte', erreur.message);
  zone.innerHTML = '<p><a class="btn btn-secondaire" href="/accueil">Retour aux défis</a></p>';
}

function bloc(q, i) {
  const items = q.reponses.map((r) => {
    // Quatre cas, et chacun merite son mot : le silence sur une bonne reponse
    // manquee est precisement ce qu'on vient relire.
    if (r.choisie && r.correcte) return ligne(r, 'bonne', '✔', 'Vous aviez coché — bonne réponse');
    if (r.choisie && !r.correcte) return ligne(r, 'tort', '✘', 'Vous aviez coché — à tort');
    if (!r.choisie && r.correcte) return ligne(r, 'bonne', '＋', 'Bonne réponse, non cochée');
    return ligne(r, '', '·', '');
  }).join('');

  return `
    <section class="bloc-relecture ${q.parfaite ? 'juste' : 'ratee'}">
      <div class="rang" style="align-items:baseline;gap:.6rem">
        <strong style="font-size:1.05rem">${i + 1}. ${echapper(q.enonce)}</strong>
        <span class="note-question">${q.pointsObtenus} / ${q.points} pts</span>
      </div>
      <!-- Le contexte est saisi dans un textarea : sans pre-line, la mise en
           situation et le mail a analyser se retrouvaient sur une ligne. -->
      ${q.contexte ? `<p class="discret" style="margin:.4rem 0 0;white-space:pre-line">${echapper(q.contexte)}</p>` : ''}
      <ul class="liste-relecture">${items}</ul>
      ${q.explication ? `<p style="margin:0">${echapper(q.explication)}</p>` : ''}
    </section>`;
}
