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
  rendre(d.services);
}

function rendre(services) {
  const filtre = recherche.toLowerCase();
  const visibles = filtre
    ? services.filter((s) => (s.service || '').toLowerCase().includes(filtre))
    : services;

  const totalActifs = services.reduce((n, s) => n + s.actifs, 0);
  const totalExclus = services.reduce((n, s) => n + s.exclus, 0);

  document.getElementById('zone-formulaire').innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--vert-clair)">
      <h2>Services et effectifs</h2>
      <p class="discret" style="margin-top:-.3em">
        ${services.length} services · ${totalActifs} agents dans la campagne · ${totalExclus} exclus.
      </p>

      <div class="message message-info" style="margin:1rem 0">
        Une exclusion prononcée ici est <strong>conservée lors des synchronisations
        suivantes</strong> : vous ne referez pas ce tri à chaque fois. Pour réintégrer un
        service, cochez-le et utilisez « Réintégrer ».
      </div>

      <div class="rang" style="align-items:flex-end;margin-bottom:.8rem">
        <div class="champ-admin" style="flex:1;min-width:240px;margin-bottom:0">
          <label for="rech-service">Rechercher un service</label>
          <input type="search" id="rech-service" value="${echapper(recherche)}" placeholder="Elus, Crêche, Centre de Loisirs…">
        </div>
        <button class="btn btn-secondaire" id="btn-tout-services" style="margin-bottom:0">Tout cocher</button>
        <button class="btn btn-secondaire" id="btn-rien-services" style="margin-bottom:0">Tout décocher</button>
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
            <tr${s.actifs === 0 && s.exclus ? ' style="opacity:.55"' : ''}>
              <td><input type="checkbox" class="case-service-ex" value="${echapper(s.service)}"
                         aria-label="Sélectionner ${echapper(s.service)}"
                         style="width:18px;height:18px;accent-color:var(--vert-fonce)"></td>
              <td><strong>${echapper(s.service)}</strong></td>
              <td class="num">${s.effectif}</td>
              <td class="num">${s.sans_email || '—'}</td>
              <td class="num">${s.connectes || '—'}</td>
              <td class="num">${s.joueurs || '—'}</td>
              <td>${s.exclus === s.effectif
                ? '<span class="pastille-etat etat-ko">exclu</span>'
                : s.exclus
                  ? `<span class="pastille-etat" style="background:var(--alerte-fond);color:var(--alerte)">${s.exclus} exclu(s)</span>`
                  : '<span class="pastille-etat etat-ok">dans la campagne</span>'}</td>
            </tr>`).join('')
            : '<tr><td colspan="7" class="discret">Aucun service ne correspond.</td></tr>'}
          </tbody>
        </table>
      </div>

      <button class="btn btn-secondaire" id="btn-fermer-services" style="margin-top:1rem">Fermer</button>
    </div>`;

  brancher(services);
}

function brancher(services) {
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
    minuteur = setTimeout(() => { recherche = e.target.value.trim(); rendre(services); }, 250);
  });

  document.getElementById('btn-tout-services').addEventListener('click', () => {
    cases().forEach((c) => { c.checked = true; }); majBarre();
  });
  document.getElementById('btn-rien-services').addEventListener('click', () => {
    cases().forEach((c) => { c.checked = false; }); majBarre();
  });
  document.getElementById('btn-fermer-services').addEventListener('click', () => { zone.innerHTML = ''; });

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
