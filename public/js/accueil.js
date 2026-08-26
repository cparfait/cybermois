import { api, echapper, initialiserPage, alerte } from '/js/commun.js';

const agent = await initialiserPage('/accueil');

try {
  const [defis, profil] = await Promise.all([api('/api/defis'), api('/api/profil')]);

  const faits = defis.filter((d) => d.participation).length;
  const ouverts = defis.filter((d) => d.ouvert).length;
  const progression = ouverts ? Math.round((faits / defis.length) * 100) : 0;

  document.getElementById('heros').innerHTML = `
    <section class="heros">
      <p class="surtitre">Bonjour ${echapper((agent.nomComplet || '').split(' ')[0] || '')}</p>
      <h1>Faites gagner ${echapper(agent.service)}</h1>
      <p style="max-width:52ch;margin:0">
        Chaque défi terminé rapporte des points à votre service. Comptez 5 à 8 minutes,
        et il n'y a rien à installer.
      </p>
      <div class="compteurs">
        <div>
          <div class="compteur-valeur">${profil.scoreTotal}</div>
          <div class="compteur-libelle">points gagnés</div>
        </div>
        <div>
          <div class="compteur-valeur">${faits}<span style="font-size:1.1rem;opacity:.75">/${defis.length}</span></div>
          <div class="compteur-libelle">défis terminés</div>
        </div>
        <div>
          <div class="compteur-valeur">${profil.rangService.rang ? `${profil.rangService.rang}<span style="font-size:1.1rem;opacity:.75">e</span>` : '—'}</div>
          <div class="compteur-libelle">rang de mon service</div>
        </div>
        <div>
          <div class="compteur-valeur">${profil.badges.filter((b) => b.obtenu).length}</div>
          <div class="compteur-libelle">badges obtenus</div>
        </div>
      </div>
      <div class="jauge" role="img" aria-label="Progression : ${progression} pour cent"><span style="width:${progression}%"></span></div>
    </section>`;

  document.getElementById('defis').innerHTML = defis.map((defi) => {
    const p = defi.participation;
    const classe = p ? 'termine' : defi.ouvert ? '' : 'verrouille';
    const pourcentage = p && p.scoreMax ? Math.round((p.score / p.scoreMax) * 100) : 0;

    let action;
    if (!defi.ouvert) {
      const date = new Date(defi.ouvreLe + 'T00:00:00')
        .toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
      action = `<p class="discret" style="margin:0">🔒 Ouverture le ${date}</p>`;
    } else if (p) {
      action = `<a class="btn btn-secondaire btn-bloc" href="/defi/${defi.semaine}">Revoir les corrections</a>`;
    } else {
      action = `<a class="btn btn-principal btn-bloc" href="/defi/${defi.semaine}">Je relève le défi</a>`;
    }

    return `
      <article class="carte carte-defi ${classe}">
        <p class="numero-semaine">Semaine ${defi.semaine}</p>
        <h3 style="margin-bottom:.2em">${echapper(defi.titre)}</h3>
        <p class="accroche" style="margin-top:0">${echapper(defi.accroche)}</p>
        <p class="meta-defi">
          <span>⏱️ ${defi.dureeMinutes} min</span>
          <span>❓ ${defi.nbQuestions} questions</span>
        </p>
        ${p ? `<p class="resultat-defi">✅ Terminé — ${p.score} / ${p.scoreMax} points (${pourcentage} %)</p>` : ''}
        <div class="pied-carte">${action}</div>
      </article>`;
  }).join('');
} catch (erreur) {
  alerte('alerte', erreur.message);
  document.getElementById('defis').innerHTML = '';
}
