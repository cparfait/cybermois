import { api, echapper, alerte } from '/js/commun.js';

/**
 * Vue d'ensemble des services.
 *
 * Ecarter les elus ou une boite generique agent par agent est impraticable :
 * ils arrivent par paquets de trente. Cet ecran raisonne par service, ce qui
 * est l'unite a laquelle la decision se prend reellement.
 *
 * Une exclusion prononcee ici est marquee « manuelle » et survit aux
 * synchronisations suivantes : le tri ne se refait pas a chaque fois.
 */

let auTermine = () => {};
let recherche = '';
let etat = 'tous';

export async function formulaireServices(onTermine) {
  if (onTermine) auTermine = onTermine;
  const zone = document.getElementById('zone-formulaire');
  zone.innerHTML = '<div class="carte"><p class="discret">Chargement des services…</p></div>';
  zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  let d;
  try {
    d = await api('/api/admin/services/effectifs');
  } catch (e) {
    zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }
  rendre(d);
}

function rendre(donnees) {
  const services = donnees.services;
  const filtre = recherche.toLowerCase();
  const correspond = (s) => {
    if (filtre && !(s.service || '').toLowerCase().includes(filtre)) return false;
    if (etat === 'exclus') return s.exclus > 0;
    if (etat === 'campagne') return s.actifs > 0;
    return true;
  };
  const visibles = services.filter(correspond);
  const nbExclus = services.filter((s) => s.exclus > 0).length;

  const totalExclus = services.reduce((n, s) => n + s.exclus, 0);

  document.getElementById('zone-formulaire').innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--vert-clair)">
      <h2>Services participant à la campagne</h2>
      <p class="discret" style="margin-top:-.3em">
        Ce que verront les agents au classement, une fois les regroupements faits
        et les exclusions prononcées.
      </p>

      <div class="bandeau-stats" style="margin:1rem 0">
        <div class="stat-admin"><div class="v">${donnees.participants}</div><div class="l">services au classement</div></div>
        <div class="stat-admin"><div class="v">${donnees.totalActifs}</div><div class="l">agents concernés</div></div>
        <div class="stat-admin"><div class="v">${totalExclus}</div><div class="l">agents exclus</div></div>
        <div class="stat-admin"><div class="v">${services.filter((s) => s.sources.length > 1).length}</div><div class="l">services regroupés</div></div>
      </div>

      <div class="message message-info" style="margin:1rem 0">
        Une exclusion prononcée ici est <strong>conservée lors des synchronisations
        suivantes</strong> : vous ne referez pas ce tri à chaque fois. Pour réintégrer un
        service, cochez-le et utilisez « Réintégrer ».
      </div>

      <div class="barre-filtres" style="margin-bottom:.9rem">
        <div class="champ-admin" style="flex:1;min-width:260px">
          <label for="rech-service">Rechercher un service</label>
          <input type="search" id="rech-service" value="${echapper(recherche)}" placeholder="Elus, Crêche, Centre de Loisirs…">
        </div>
        <button class="btn btn-secondaire" id="btn-tout-services" style="padding:.55rem 1rem">Tout cocher</button>
        <button class="btn btn-secondaire" id="btn-rien-services" style="padding:.55rem 1rem">Tout décocher</button>
      </div>

      <div class="rang" role="group" aria-label="Filtrer par état" style="margin-bottom:.9rem">
        ${[
          ['tous', `Tous (${services.length})`],
          ['campagne', `Dans la campagne (${donnees.participants})`],
          ['exclus', `Exclus (${nbExclus})`],
        ].map(([cle, libelle]) => `
          <button type="button" class="btn ${etat === cle ? 'btn-principal' : 'btn-secondaire'}"
                  data-etat="${cle}" aria-pressed="${etat === cle}"
                  style="padding:.35rem .9rem;font-size:.85rem">${libelle}</button>`).join('')}
      </div>

      <div id="barre-services" hidden class="message message-alerte" style="margin-bottom:1rem">
        <span id="nb-services"></span>
        <div class="rang" style="margin-top:.6rem">
          <button class="btn btn-secondaire" id="btn-exclure-services"
                  style="padding:.35rem .9rem;font-size:.85rem;border-color:var(--erreur);color:var(--erreur)">
            Exclure ces services de la campagne
          </button>
          <button class="btn btn-secondaire" id="btn-reintegrer-services" style="padding:.35rem .9rem;font-size:.85rem">
            Réintégrer
          </button>
        </div>
      </div>

      <div class="tableau-defilant" style="max-height:520px;overflow-y:auto">
        <table class="admin">
          <thead><tr>
            <th style="width:32px"></th>
            <th>Service</th>
            <th class="num">Agents</th>
            <th class="num">Sans adresse</th>
            <th class="num">Connectés</th>
            <th class="num">Ont joué</th>
            <th>État</th>
          </tr></thead>
          <tbody>${visibles.length ? visibles.map((s) => `
            <tr${s.exclus
              ? ` style="background:var(--alerte-fond);border-left:3px solid var(--alerte)${s.actifs === 0 ? ';opacity:.7' : ''}"`
              : ''}>
              <td><input type="checkbox" class="case-service-ex" value="${echapper(s.service)}"
                         aria-label="Sélectionner ${echapper(s.service)}"
                         style="width:18px;height:18px;accent-color:var(--vert-fonce)"></td>
              <td>
                <button type="button" class="lien-service" data-voir="${echapper(s.service)}"
                        aria-expanded="false"
                        title="Voir les agents de ce service">${echapper(s.service)}</button>
                ${s.sources.length > 1 ? `
                  <details style="margin-top:.2rem">
                    <summary class="discret ui" style="cursor:pointer;font-size:.76rem">
                      regroupe ${s.sources.length} libellés d'annuaire
                    </summary>
                    <ul class="ui discret" style="font-size:.78rem;margin:.3rem 0 0;padding-left:1rem">
                      ${s.sources.map((x) => `<li>${echapper(x.source)} — ${x.effectif}</li>`).join('')}
                    </ul>
                  </details>` : ''}
              </td>
              <td class="num">
                <button type="button" class="lien-service" data-voir="${echapper(s.service)}"
                        aria-expanded="false"
                        title="Voir les agents de ce service">${s.effectif}</button>
              </td>
              <td class="num">${s.sans_email || '—'}</td>
              <td class="num">${s.connectes || '—'}</td>
              <td class="num">${s.joueurs || '—'}</td>
              <td>${s.exclus === s.effectif
                ? '<span class="pastille-etat etat-ko">exclu</span>'
                : s.exclus
                  ? `<span class="pastille-etat" style="background:var(--alerte-fond);color:var(--alerte)">${s.exclus} exclu(s)</span>`
                  : '<span class="pastille-etat etat-ok">dans la campagne</span>'}</td>
            </tr>
            <tr class="detail-service" data-detail="${echapper(s.service)}" hidden>
              <td colspan="7" style="background:var(--fond-doux)"></td>
            </tr>`).join('')
            : '<tr><td colspan="7" class="discret">Aucun service ne correspond.</td></tr>'}
          </tbody>
        </table>
      </div>

      <button class="btn btn-secondaire" id="btn-fermer-services" style="margin-top:1rem">Fermer</button>
    </div>`;

  brancher(donnees);
}

function brancher(donnees) {
  const zone = document.getElementById('zone-formulaire');
  const cases = () => [...zone.querySelectorAll('.case-service-ex')];
  const choisis = () => cases().filter((c) => c.checked).map((c) => c.value);

  const majBarre = () => {
    const n = choisis().length;
    document.getElementById('barre-services').hidden = n === 0;
    document.getElementById('nb-services').textContent =
      `${n} service(s) sélectionné(s)`;
  };
  majBarre();

  zone.addEventListener('change', (e) => {
    if (e.target.matches('.case-service-ex')) majBarre();
  });

  let minuteur;
  document.getElementById('rech-service').addEventListener('input', (e) => {
    clearTimeout(minuteur);
    minuteur = setTimeout(() => { recherche = e.target.value.trim(); rendre(donnees); }, 250);
  });

  document.getElementById('btn-tout-services').addEventListener('click', () => {
    cases().forEach((c) => { c.checked = true; }); majBarre();
  });
  document.getElementById('btn-rien-services').addEventListener('click', () => {
    cases().forEach((c) => { c.checked = false; }); majBarre();
  });
  document.getElementById('btn-fermer-services').addEventListener('click', () => { zone.innerHTML = ''; });

  zone.addEventListener('click', (e) => {
    const bouton = e.target.closest('[data-voir]');
    if (bouton) { basculerDetail(zone, bouton); return; }

    const filtre = e.target.closest('[data-etat]');
    if (filtre) { etat = filtre.dataset.etat; rendre(donnees); }
  });

  const agir = async (exclu) => {
    const liste = choisis();
    if (!liste.length) return;
    if (exclu && !confirm(
      `Exclure ${liste.length} service(s) de la campagne ?\n\n`
      + `${liste.slice(0, 8).join('\n')}${liste.length > 8 ? `\n… et ${liste.length - 8} autre(s)` : ''}\n\n`
      + 'Leurs agents sortent des effectifs, des relances et des classements. '
      + 'Les résultats déjà enregistrés sont conservés.'
    )) return;

    try {
      const r = await api('/api/admin/services/exclusion', {
        method: 'POST', body: { services: liste, exclu },
      });
      alerte('alerte', r.message, 'succes');
      recherche = '';
      await formulaireServices();
      auTermine();
    } catch (e) { alerte('alerte', e.message); }
  };

  document.getElementById('btn-exclure-services').addEventListener('click', () => agir(true));
  document.getElementById('btn-reintegrer-services').addEventListener('click', () => agir(false));
}

/**
 * Ouvre - ou referme - la composition d'un service.
 *
 * La liste est chargee a la demande : afficher d'emblee les agents des
 * 87 services rendrait la page inutilisable pour repondre a une question
 * qu'on ne se pose que sur deux ou trois d'entre eux.
 */
async function basculerDetail(zone, bouton) {
  const service = bouton.dataset.voir;
  const ligne = zone.querySelector(`[data-detail="${CSS.escape(service)}"]`);
  if (!ligne) return;

  const cellule = ligne.firstElementChild;
  const boutons = zone.querySelectorAll(`[data-voir="${CSS.escape(service)}"]`);

  if (!ligne.hidden) {
    ligne.hidden = true;
    boutons.forEach((b) => b.setAttribute('aria-expanded', 'false'));
    return;
  }

  ligne.hidden = false;
  boutons.forEach((b) => b.setAttribute('aria-expanded', 'true'));
  if (cellule.dataset.charge === '1') return;

  cellule.innerHTML = '<p class="discret" style="margin:.5rem 0">Chargement…</p>';
  try {
    const r = await api(`/api/admin/agents?service=${encodeURIComponent(service)}&parPage=200`);
    const agents = r.agents || [];
    const total = r.pagination?.total ?? agents.length;
    cellule.innerHTML = agents.length
      ? `<p class="discret ui" style="margin:.4rem 0;font-size:.82rem">
           ${agents.length}${total > agents.length ? ` sur ${total}` : ''} agent(s)
         </p>
         <ul class="ui" style="columns:2;font-size:.84rem;margin:0;padding-left:1.1rem">
           ${agents.map((a) => `<li${a.exclu ? ' style="opacity:.55"' : ''}>
             ${echapper(a.nom_complet)}
             <span class="discret">(${echapper(a.login)})</span>
             ${a.exclu ? '<span class="discret"> — exclu</span>' : ''}
           </li>`).join('')}
         </ul>`
      : '<p class="discret" style="margin:.5rem 0">Aucun agent.</p>';
    cellule.dataset.charge = '1';
  } catch (e) {
    cellule.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
  }
}
