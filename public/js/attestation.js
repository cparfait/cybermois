import { api, echapper, initialiserPage, alerte } from '/js/commun.js';

await initialiserPage('/profil');
const zone = document.getElementById('zone');
document.getElementById('btn-imprimer').addEventListener('click', () => window.print());

try {
  const p = await api('/api/profil');

  if (!p.complet) {
    zone.innerHTML = `
      <div class="message message-info">
        Votre attestation sera disponible une fois les ${p.totalDefis} défis terminés.
        Il vous en reste ${p.totalDefis - p.participations.length}.
        <a href="/accueil">Continuer les défis</a>
      </div>`;
  } else {
    const scoreMaxTotal = p.participations.reduce((s, x) => s + x.scoreMax, 0);
    const reussite = scoreMaxTotal ? Math.round((p.scoreTotal / scoreMaxTotal) * 100) : 0;
    const badges = p.badges.filter((b) => b.obtenu);
    const annee = new Date().getFullYear();

    zone.innerHTML = `
      <div class="attestation">
        <img src="/img/email-logo.png" alt="Ville de Châtillon" class="logo">
        <p class="surtitre">Cybermois ${annee}</p>
        <h1>Attestation de participation</h1>

        <p class="nom-agent">${echapper(p.agent.nomComplet)}</p>
        <p class="service-agent">${echapper(p.agent.service)}</p>

        <p class="corps">
          a suivi l'intégralité du parcours de sensibilisation à la cybersécurité
          organisé par la Ville de Châtillon, soit ${p.totalDefis} défis couvrant
          les mots de passe, le hameçonnage, la protection des données et l'ingénierie sociale.
        </p>

        <div class="chiffres">
          <div class="chiffre"><div class="v">${p.participations.length}</div><div class="l">défis relevés</div></div>
          <div class="chiffre"><div class="v">${p.scoreTotal}</div><div class="l">points</div></div>
          <div class="chiffre"><div class="v">${reussite} %</div><div class="l">de réussite</div></div>
          <div class="chiffre"><div class="v">${badges.length}</div><div class="l">badges</div></div>
        </div>

        ${badges.length ? `<div class="badges-att" aria-label="Badges obtenus">${badges.map((b) => b.emoji).join(' ')}</div>` : ''}

        <p class="signature">
          Délivrée le ${new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}<br>
          <strong>Direction des systèmes d'information</strong><br>
          Ville de Châtillon
        </p>
      </div>`;
  }
} catch (erreur) {
  alerte('alerte', erreur.message);
  zone.innerHTML = '';
}
