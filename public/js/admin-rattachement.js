import { api, echapper, alerte } from '/js/commun.js';

/**
 * Rattachement des agents sans service.
 *
 * Quand l'attribut « department » est vide, l'agent tombe dans « Non rattaché »
 * et son service n'apparait nulle part. Son DN porte pourtant presque toujours
 * l'information : on la propose, groupee, plutot que de faire saisir 93 fois
 * la meme chose.
 *
 * Un rattachement decide ici est marque comme force : la synchronisation
 * suivante ne l'ecrasera pas, sans quoi le travail serait a refaire.
 */

let auTermine = () => {};
let donnees = null;

export async function formulaireRattachement(onTermine) {
  if (onTermine) auTermine = onTermine;
  const zone = document.getElementById('zone-formulaire');
  zone.innerHTML = '<div class="carte"><p class="discret">Analyse des agents sans service…</p></div>';
  zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    donnees = await api('/api/admin/agents/non-rattaches');
  } catch (e) {
    zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }
  rendre();
}

function rendre() {
  const d = donnees;

  if (!d.total) {
    document.getElementById('zone-formulaire').innerHTML = `
      <div class="carte" style="margin-bottom:1.5rem">
        <h2>Agents sans service</h2>
        <div class="message message-succes">Tous les agents sont rattachés à un service.</div>
        <button class="btn btn-secondaire" id="btn-fermer-rattachement">Fermer</button>
      </div>`;
    document.getElementById('btn-fermer-rattachement')
      .addEventListener('click', () => { document.getElementById('zone-formulaire').innerHTML = ''; });
    return;
  }

  const options = (valeur) => d.services
    .map((s) => `<option value="${echapper(s.service)}"${s.service === valeur ? ' selected' : ''}>${echapper(s.service)} (${s.n})</option>`)
    .join('');

  const avecIndice = d.groupes.filter((g) => g.proposition).reduce((n, g) => n + g.agents.length, 0);

  document.getElementById('zone-formulaire').innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--vert-clair)">
      <h2>Rattacher les agents sans service</h2>
      <p class="discret" style="margin-top:-.3em">
        ${d.total} agents n'ont pas d'attribut « department » dans l'annuaire.
        Leur emplacement dans l'arborescence en désigne un pour ${avecIndice} d'entre eux.
      </p>

      <div class="message message-info" style="margin:1rem 0">
        Le rattachement décidé ici <strong>résiste aux synchronisations</strong> : l'annuaire ne
        l'écrasera pas. La correction propre reste de renseigner « department » dans l'Active
        Directory — elle profiterait à toutes vos applications, pas seulement à celle-ci.
      </div>

      <div class="rang" style="margin-bottom:1rem">
        <button class="btn btn-secondaire" id="btn-tout-rattacher"
                style="padding:.45rem .9rem;font-size:.85rem">Retenir toutes les propositions</button>
        <span class="discret ui" id="compteur-rattachement"></span>
      </div>

      ${d.groupes.map((g, i) => `
        <div class="editeur-question" data-groupe="${i}">
          <div class="barre-filtres" style="margin-bottom:.6rem">
            <div style="flex:1;min-width:200px">
              <strong class="ui">${g.indiceOu ? `Sous « ${echapper(g.indiceOu)} »` : "Sans indice dans l'annuaire"}</strong>
              <span class="discret"> — ${g.agents.length} agent(s)</span>
              ${g.proposition && g.existe
                ? `<br><span class="discret" style="font-size:.8rem">correspond au service existant « ${echapper(g.proposition)} »</span>`
                : g.proposition
                  ? '<br><span class="discret" style="font-size:.8rem">créerait un nouveau service</span>'
                  : ''}
            </div>
            <div class="champ-admin" style="flex:1;min-width:230px">
              <label for="svc-${i}">Rattacher à</label>
              <select id="svc-${i}" class="service-groupe">
                <option value="">Ne rien faire</option>
                ${g.proposition && !g.existe
                  ? `<option value="${echapper(g.proposition)}" selected>${echapper(g.proposition)} — nouveau service</option>`
                  : ''}
                ${options(g.existe ? g.proposition : null)}
              </select>
            </div>
          </div>

          <details>
            <summary class="ui discret" style="cursor:pointer;font-size:.84rem">Voir les ${g.agents.length} agent(s)</summary>
            <ul class="ui" style="font-size:.84rem;columns:2;margin:.5rem 0">
              ${g.agents.map((a) => `<li>${echapper(a.nomComplet)} <span class="discret">(${echapper(a.login)})</span></li>`).join('')}
            </ul>
          </details>
        </div>`).join('')}

      <div class="rang" style="margin-top:1.2rem;border-top:1px solid var(--bordure);padding-top:1.2rem">
        <button class="btn btn-principal" id="btn-appliquer-rattachement">Appliquer les rattachements</button>
        <button class="btn btn-secondaire" id="btn-fermer-rattachement">Fermer</button>
      </div>
    </div>`;

  brancher();
}

function brancher() {
  const zone = document.getElementById('zone-formulaire');
  const selecteurs = () => [...zone.querySelectorAll('.service-groupe')];

  const majCompteur = () => {
    let n = 0;
    selecteurs().forEach((sel, i) => { if (sel.value) n += donnees.groupes[i].agents.length; });
    document.getElementById('compteur-rattachement').textContent =
      `${n} agent(s) seront rattachés`;
  };
  majCompteur();
  zone.addEventListener('change', (e) => { if (e.target.matches('.service-groupe')) majCompteur(); });

  document.getElementById('btn-tout-rattacher').addEventListener('click', () => {
    selecteurs().forEach((sel, i) => {
      const p = donnees.groupes[i].proposition;
      if (p && [...sel.options].some((o) => o.value === p)) sel.value = p;
    });
    majCompteur();
  });

  document.getElementById('btn-fermer-rattachement')
    .addEventListener('click', () => { zone.innerHTML = ''; });

  document.getElementById('btn-appliquer-rattachement').addEventListener('click', async () => {
    const affectations = [];
    selecteurs().forEach((sel, i) => {
      if (!sel.value) return;
      for (const a of donnees.groupes[i].agents) affectations.push({ id: a.id, service: sel.value });
    });

    if (!affectations.length) return alerte('alerte', 'Aucun rattachement sélectionné.');

    const bouton = document.getElementById('btn-appliquer-rattachement');
    bouton.disabled = true;
    bouton.textContent = 'Rattachement…';
    try {
      const r = await api('/api/admin/agents/rattachement', { method: 'POST', body: { affectations } });
      alerte('alerte', r.message, 'succes');
      zone.innerHTML = '';
      auTermine();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      alerte('alerte', e.message);
      bouton.disabled = false;
      bouton.textContent = 'Appliquer les rattachements';
    }
  });
}
