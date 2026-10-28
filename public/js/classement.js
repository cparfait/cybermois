import {
  api, echapper, initialiserPage, alerte, medaille, animationsReduites,
} from '/js/commun.js';

const agent = await initialiserPage('/classement');

/** Defilement respectueux du reglage « reduire les animations ». */
const glisser = () => (animationsReduites() ? 'auto' : 'smooth');

/* ------------------------------------------------------------- Onglets */

const onglets = [
  { bouton: document.getElementById('onglet-services'), panneau: document.getElementById('panneau-services') },
  { bouton: document.getElementById('onglet-agents'), panneau: document.getElementById('panneau-agents') },
];

onglets.forEach(({ bouton }, index) => {
  bouton.addEventListener('click', () => activerOnglet(index));
  bouton.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const suivant = (index + (e.key === 'ArrowRight' ? 1 : onglets.length - 1)) % onglets.length;
    activerOnglet(suivant);
    onglets[suivant].bouton.focus();
  });
});

function activerOnglet(actif) {
  onglets.forEach(({ bouton, panneau }, i) => {
    bouton.setAttribute('aria-selected', String(i === actif));
    panneau.hidden = i !== actif;
  });
}

/* ------------------------------------------------------------- Rendu */

function podium(entrees, rendu) {
  if (entrees.length < 3) return '';
  const ordre = [1, 0, 2]; // 2e, 1er, 3e pour l'effet visuel
  const classes = { 0: 'or', 1: 'argent', 2: 'bronze' };
  return `<div class="podium">${ordre
    .map((i) => `<div class="marche ${classes[i]}">${rendu(entrees[i], i)}</div>`)
    .join('')}</div>`;
}

// On affiche les dix premiers : au-dela le classement se lit mal, et l'agent
// qui se cherche a la 60e place prefere deplier que faire defiler.
const PREMIERS = 10;

/**
 * Cellule de rang.
 * Sur le podium la medaille remplacait le chiffre : un lecteur d'ecran
 * annoncait « medaille sportive premiere place » ou rien du tout, et les trois
 * premieres lignes n'avaient plus de rang. L'emoji decore, le chiffre informe.
 */
const celluleRang = (rang) => (medaille(rang)
  ? `<span aria-hidden="true">${medaille(rang)}</span><span class="sr-only">${rang}</span>`
  : String(rang));

/** Bouton « voir plus » : deplie les lignes au-dela des dix premieres. */
function brancherVoirPlus(idTable, idBouton, total, libelle) {
  const bouton = document.getElementById(idBouton);
  if (!bouton) return;

  const restants = total - PREMIERS;
  if (restants <= 0) { bouton.hidden = true; return; }
  bouton.hidden = false;

  let deplie = false;
  const majLibelle = () => {
    bouton.textContent = deplie
      ? 'Réduire au top 10'
      : `Voir les ${restants} autre${restants > 1 ? 's' : ''} ${libelle}${restants > 1 ? 's' : ''}`;
    bouton.setAttribute('aria-expanded', String(deplie));
  };
  majLibelle();

  bouton.onclick = () => {
    deplie = !deplie;
    document.querySelectorAll(`#${idTable} tr[data-au-dela]`).forEach((l) => { l.hidden = !deplie; });
    majLibelle();
    if (!deplie) document.getElementById(idTable).scrollIntoView({ behavior: glisser(), block: 'start' });
  };
}

/** « 2,6 » et non « 2.6 » : la moyenne de defis par agent s'ecrit a la francaise. */
const virgule = (n) => String(n).replace('.', ',');

function rendreServices(donnees) {
  const services = donnees.services;

  // La direction de l'agent est reconnue par la ligne que le serveur a deja
  // identifiee : comparer les libelles ne marche plus, puisque le classement
  // ramene chaque direction a l'orthographe du referentiel.
  const maDirection = donnees.monRangService?.detail?.service || null;

  document.getElementById('podium-services').innerHTML = podium(services, (s, i) => `
    <div class="medaille" aria-hidden="true">${medaille(i + 1)}</div>
    <div class="sr-only">${i + 1}<sup>${i === 0 ? 're' : 'e'}</sup> place</div>
    <div class="nom">${echapper(s.service)}</div>
    <div class="points">${virgule(s.defis_par_agent)} / ${s.defis_parus} défis</div>
    <div class="sous">par agent · ${s.pourcentage_moyen} % de réussite · ${s.taux_participation} % de participation</div>`);

  document.getElementById('table-services').innerHTML = `
    <caption class="sr-only">Classement des directions par défis terminés, puis par réussite</caption>
    <thead><tr>
      <th scope="col">Rang</th><th scope="col">Direction</th>
      <th scope="col" class="num">Défis par agent</th>
      <th scope="col" class="num">Réussite</th>
      <th scope="col" class="num">Points</th>
      <th scope="col" class="num">Participation</th>
      <th scope="col" class="num">Agents</th>
    </tr></thead>
    <tbody>${services.map((s, i) => `
      <tr class="${s.service === maDirection ? 'moi' : ''}"${i >= PREMIERS ? ' data-au-dela hidden' : ''}>
        <td class="rang-cell">${celluleRang(i + 1)}</td>
        <td>${echapper(s.service)}${s.service === maDirection ? ' <span class="discret">(ma direction)</span>' : ''}</td>
        <td class="num" style="white-space:nowrap"><strong>${virgule(s.defis_par_agent)}</strong> / ${s.defis_parus}</td>
        <td class="num">${s.pourcentage_moyen} %</td>
        <td class="num discret" style="white-space:nowrap">${s.score_max_joue ? `${s.score_total} / ${s.score_max_joue}` : '—'}</td>
        <td class="num">
          <div class="rang" style="justify-content:flex-end;gap:.5rem;flex-wrap:nowrap">
            <span>${s.taux_participation} %</span>
            <span class="barre-mini" aria-hidden="true"><span style="width:${Math.min(100, s.taux_participation)}%"></span></span>
          </div>
        </td>
        <td class="num">${s.joueurs} / ${s.inscrits}</td>
      </tr>`).join('')}</tbody>`;

  if (!services.length) {
    document.getElementById('table-services').innerHTML =
      '<tbody><tr><td class="discret">Aucune participation pour le moment. Soyez le premier !</td></tr></tbody>';
  }
  brancherVoirPlus('table-services', 'voir-plus-services', services.length, 'direction');
}

function rendreAgents(donnees) {
  const agents = donnees.agents;

  document.getElementById('podium-agents').innerHTML = podium(agents, (a, i) => `
    <div class="medaille" aria-hidden="true">${medaille(i + 1)}</div>
    <div class="sr-only">${i + 1}<sup>${i === 0 ? 'er' : 'e'}</sup></div>
    <div class="nom">${echapper(a.nom_complet)}</div>
    <div class="points">${a.score_total} pts</div>
    <div class="sous">${a.defis_joues} / ${a.defis_parus} défis · ${a.pourcentage} % de réussite · ${echapper(a.service)}</div>`);

  document.getElementById('table-agents').innerHTML = `
    <caption class="sr-only">Classement individuel des agents par points, avec défis terminés et réussite</caption>
    <thead><tr>
      <th scope="col">Rang</th><th scope="col">Agent</th><th scope="col">Direction</th>
      <th scope="col" class="num">Points</th>
      <th scope="col" class="num">Défis</th>
      <th scope="col" class="num">Réussite</th>
    </tr></thead>
    <!-- « Ma ligne » vient du serveur. Comparer les noms surlignait les
         homonymes, et ne trouvait jamais un agent qui a demande a ne pas
         figurer nominativement : il paraissait sous « Agent anonyme ». -->
    <tbody>${agents.map((a, i) => `
      <tr class="${a.moi ? 'moi' : ''}"${i >= PREMIERS ? ' data-au-dela hidden' : ''}>
        <td class="rang-cell">${celluleRang(i + 1)}</td>
        <td>${echapper(a.nom_complet)}${a.moi ? ' <span class="discret">(moi)</span>' : ''}</td>
        <td>${echapper(a.service)}</td>
        <td class="num" style="white-space:nowrap"><strong>${a.score_total}</strong></td>
        <td class="num" style="white-space:nowrap">${a.defis_joues} / ${a.defis_parus}</td>
        <td class="num">${a.pourcentage} %</td>
      </tr>`).join('')}</tbody>`;

  if (!agents.length) {
    document.getElementById('table-agents').innerHTML =
      '<tbody><tr><td class="discret">Aucune participation pour le moment.</td></tr></tbody>';
  }
  brancherVoirPlus('table-agents', 'voir-plus-agents', agents.length, 'agent');
}

/* ---------------------------------------------------------- Chargement */

try {
  const donnees = await api('/api/classement');

  const rs = donnees.monRangService;
  const ra = donnees.monRangAgent;
  document.getElementById('moi').innerHTML = `
    <div class="encart-moi">
      <strong>${echapper(agent.service)}</strong>
      ${rs.rang
        ? ` — ${rs.rang}<sup>${rs.rang === 1 ? 're' : 'e'}</sup> place sur ${rs.total} directions,
            ${virgule(rs.detail?.defis_par_agent ?? 0)} défi${(rs.detail?.defis_par_agent ?? 0) >= 2 ? 's' : ''} terminé${(rs.detail?.defis_par_agent ?? 0) >= 2 ? 's' : ''} par agent,
            ${rs.detail?.pourcentage_moyen ?? 0} % de réussite et ${rs.detail?.taux_participation ?? 0} % de participation.`
        : rs.horsReferentiel
          // Dire « pas encore classé » ferait croire a un manque de
          // participation, alors que c'est le rattachement qui manque.
          ? ' — cette direction n’est pas encore rattachée au référentiel : vos points comptent, mais elle n’apparaît pas au classement collectif.'
          : ' — pas encore classé, à vous de lancer la machine.'}
      ${ra.rang ? `<br>Vous êtes ${ra.rang}<sup>${ra.rang === 1 ? 'er' : 'e'}</sup> sur ${ra.total} agents ayant participé.` : ''}
    </div>`;

  const s = donnees.stats;
  document.getElementById('stats').innerHTML = `
    <div class="stat"><div class="v">${s.joueurs}</div><div class="l">agents ont joué</div></div>
    <div class="stat"><div class="v">${s.inscrits ? Math.round((s.joueurs / s.inscrits) * 100) : 0} %</div><div class="l">de participation</div></div>
    <div class="stat"><div class="v">${s.services}</div><div class="l">directions en lice</div></div>
    <div class="stat"><div class="v">${s.participations}</div><div class="l">défis terminés</div></div>
    <div class="stat"><div class="v">${s.points_cumules}</div><div class="l">points cumulés</div></div>`;

  // Chaque onglet annonce ce qu'il contient : sans cela, on ne sait pas si
  // la seconde vue vaut le clic, et on repart avec un seul des deux
  // classements en tete.
  const nS = donnees.services.length;
  const nA = donnees.agents.length;
  document.getElementById('compte-services').textContent =
    nS ? `${nS} direction${nS > 1 ? 's' : ''} classée${nS > 1 ? 's' : ''}` : 'aucune direction classée';
  document.getElementById('compte-agents').textContent =
    nA ? `${nA} agent${nA > 1 ? 's' : ''} classé${nA > 1 ? 's' : ''}` : 'aucun agent classé';

  rendreServices(donnees);
  rendreAgents(donnees);
} catch (erreur) {
  alerte('alerte', erreur.message);
}
