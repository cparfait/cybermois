import { api, echapper, initialiserPage, alerte, formaterDate } from '/js/commun.js';

await initialiserPage('/profil');
const zone = document.getElementById('zone');


try {
  const p = await api('/api/profil');
  const obtenus = p.badges.filter((b) => b.obtenu).length;
  // Meme denominateur que le classement : le total atteignable a ce jour, et
  // non les seuls defis joues. Rapporte aux defis joues, un agent qui n'en
  // a fait qu'un affichait « 100 % de reussite » a cote d'un classement qui
  // le disait dernier - deux chiffres justes, et personne ne s'y retrouvait.
  const reussite = p.pointsPossibles
    ? Math.round((p.scoreTotal / p.pointsPossibles) * 100) : 0;

  zone.innerHTML = `
    <h1 style="margin-bottom:.1em">${echapper(p.agent.nomComplet)}</h1>
    <p class="discret" style="margin-top:0;font-family:var(--police-ui)">${echapper(p.agent.service)}</p>

    <div class="grille grille-3" style="margin:1.75rem 0">
      <div class="carte centre">
        <div style="font-family:var(--police-titre);font-weight:900;font-size:2.2rem;color:var(--vert-fonce);line-height:1">${p.scoreTotal}${p.pointsPossibles
          ? `<span style="font-size:1.1rem;color:var(--encre-douce)">/${p.pointsPossibles}</span>` : ''}</div>
        <div class="discret ui">points cumulés</div>
      </div>
      <div class="carte centre">
        <div style="font-family:var(--police-titre);font-weight:900;font-size:2.2rem;color:var(--vert-fonce);line-height:1">${p.participations.length}<span style="font-size:1.1rem;color:var(--encre-douce)">/${p.totalDefis}</span></div>
        <div class="discret ui">défis terminés</div>
      </div>
      <div class="carte centre">
        <div style="font-family:var(--police-titre);font-weight:900;font-size:2.2rem;color:var(--vert-fonce);line-height:1">${reussite} %</div>
        <div class="discret ui">de réussite</div>
      </div>
      <div class="carte centre">
        <div style="font-family:var(--police-titre);font-weight:900;font-size:2.2rem;color:var(--vert-fonce);line-height:1">${p.rangAgent.rang || '—'}</div>
        <div class="discret ui">rang individuel${p.rangAgent.total ? ` sur ${p.rangAgent.total}` : ''}</div>
      </div>
    </div>

    ${p.complet ? `
      <div class="carte" style="border-left:5px solid var(--vert-clair);margin-bottom:2rem">
        <h2 style="margin-bottom:.3em"><span aria-hidden="true">🏆</span> Cybermois terminé</h2>
        <p style="margin-top:0">Vous avez relevé les ${p.totalDefis} défis de la campagne. Votre attestation de participation est prête.</p>
        <a class="btn btn-principal" href="/attestation">Voir mon attestation</a>
      </div>` : `
      <div class="message message-info" style="margin-bottom:2rem">
        Terminez les ${p.totalDefis} défis pour débloquer votre attestation de participation.
        Il vous en reste ${p.totalDefis - p.participations.length}.
      </div>`}

    <section class="carte" style="margin-bottom:2rem">
      <h2>Mes défis</h2>
      ${p.participations.length ? p.participations.map((x) => `
        <a class="ligne-defi" href="/revoir/${x.id}"
           style="text-decoration:none;color:inherit"
           title="Revoir mes réponses à ce défi">
          <div class="pastille">n°${x.numero}</div>
          <div>
            <div style="font-family:var(--police-ui);font-weight:700">${echapper(x.titre)}</div>
            <div class="discret ui">${x.bonnes} / ${x.total} réponses parfaites · terminé le ${formaterDate(x.termineLe)}</div>
            <div class="discret ui" style="font-size:.78rem">Voir mes réponses →</div>
          </div>
          <div class="score-ligne">${x.score} / ${x.scoreMax}</div>
        </a>`).join('')
        : '<p class="discret">Aucun défi terminé pour le moment. <a href="/accueil">Commencer</a></p>'}
    </section>

    <section>
      <h2>Mes badges <span class="discret ui" style="font-weight:400">— ${obtenus} sur ${p.badges.length}</span></h2>
      <div class="grille-badges" style="margin-top:1rem">
        ${p.badges.map((b) => `
          <div class="badge ${b.obtenu ? 'obtenu' : ''}">
            <!-- L'emoji du badge se saisit dans l'editeur d'administration :
                 il passe par echapper() comme tout le reste. -->
            <div class="emoji" aria-hidden="true">${echapper(b.emoji)}</div>
            <div class="nom">${echapper(b.libelle)}</div>
            <div class="desc">${echapper(b.description)}</div>
            ${b.obtenu ? `<div class="desc" style="margin-top:.4rem;color:var(--vert-clair-texte);font-weight:700">Obtenu</div>` : ''}
            <span class="sr-only">${b.obtenu ? 'Badge obtenu' : 'Badge non obtenu'}</span>
          </div>`).join('')}
      </div>
    </section>`;
} catch (erreur) {
  alerte('alerte', erreur.message);
  zone.innerHTML = '';
}
