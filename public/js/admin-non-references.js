import { api, echapper, alerte } from '/js/commun.js';

/**
 * Services non référencés.
 *
 * Un libellé qui ne correspond à aucun service du référentiel paraît au
 * classement sous un nom que la collectivité ne reconnaît pas, et deux
 * graphies du même service y comptent pour deux. C'est la liste de travail :
 * elle doit finir vide.
 *
 * Deux issues pour chaque ligne, et pas une de plus : soit le libellé
 * rejoint un service du référentiel, soit il manquait au référentiel et y
 * entre. Le texte libre est volontairement absent - c'est lui qui a créé
 * « Action culturelle » et « Action Culturelle ».
 */

const RATTACHER = '__ajouter__';

const RANGS = {
  sure: { libelle: 'Sûre', couleur: 'var(--succes)' },
  probable: { libelle: 'Probable', couleur: 'var(--vert-fonce)' },
  incertaine: { libelle: 'Incertaine', couleur: 'var(--alerte)' },
  aucune: { libelle: 'Aucune', couleur: 'var(--encre-douce)' },
};

let auTermine = () => {};
let donnees = null;
let filtre = 'tous';

export async function formulaireNonReferences(onTermine) {
  if (onTermine) auTermine = onTermine;
  const zone = document.getElementById('zone-formulaire');
  zone.innerHTML = '<div class="carte"><p class="discret">Comparaison avec le référentiel…</p></div>';
  zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    donnees = await api('/api/admin/services/non-references');
  } catch (e) {
    zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }
  rendre();
}

function rendre() {
  const d = donnees;
  const visibles = filtre === 'tous' ? d.services : d.services.filter((s) => s.confiance === filtre);
  const parRang = (cle) => d.services.filter((s) => s.confiance === cle).length;

  document.getElementById('zone-formulaire').innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--alerte)">
      <h2>Services non référencés</h2>
      <p class="discret" style="margin-top:-.3em">
        Libellés issus de l'annuaire qui ne correspondent à aucun service du référentiel.
        Leurs agents apparaissent au classement sous un nom que la collectivité ne reconnaît pas.
      </p>

      ${!d.referentiel.length ? `
        <div class="message message-alerte" style="margin:1rem 0">
          <strong>Le référentiel est vide.</strong> Renseignez-le d'abord dans
          « Référentiel des services » : sans lui, cet écran n'a rien à quoi comparer.
        </div>` : ''}

      <div class="bandeau-stats" style="margin:1rem 0">
        <div class="stat-admin"><div class="v">${d.services.length}</div><div class="l">libellés non référencés</div></div>
        <div class="stat-admin"><div class="v">${d.agents}</div><div class="l">agents concernés</div></div>
        <div class="stat-admin"><div class="v">${d.references}</div><div class="l">libellés déjà référencés</div></div>
        <div class="stat-admin"><div class="v">${d.referentiel.length}</div><div class="l">services au référentiel</div></div>
      </div>

      ${d.services.length ? `
        <div class="rang" role="group" aria-label="Filtrer par confiance" style="margin-bottom:.9rem">
          ${[['tous', `Tous (${d.services.length})`],
             ['sure', `Sûres (${parRang('sure')})`],
             ['probable', `Probables (${parRang('probable')})`],
             ['incertaine', `Incertaines (${parRang('incertaine')})`],
             ['aucune', `Sans proposition (${parRang('aucune')})`]].map(([cle, libelle]) => `
            <button type="button" class="btn ${filtre === cle ? 'btn-principal' : 'btn-secondaire'}"
                    data-filtre="${cle}" aria-pressed="${filtre === cle}"
                    style="padding:.35rem .9rem;font-size:.85rem">${libelle}</button>`).join('')}
        </div>

        <div class="rang" style="margin-bottom:.9rem">
          <button class="btn btn-secondaire" id="btn-retenir-sures"
                  style="padding:.4rem .9rem;font-size:.85rem">Retenir les propositions sûres</button>
          <button class="btn btn-secondaire" id="btn-tout-ajouter"
                  style="padding:.4rem .9rem;font-size:.85rem">Tout ajouter au référentiel</button>
          <button class="btn btn-secondaire" id="btn-remettre-zero"
                  style="padding:.4rem .9rem;font-size:.85rem">Ne rien faire</button>
          <span class="discret ui" id="compteur-nonref" style="font-size:.85rem"></span>
        </div>

        <div class="tableau-defilant" style="max-height:520px;overflow-y:auto">
          <table class="admin">
            <thead><tr>
              <th>Libellé d'annuaire</th>
              <th class="num">Agents</th>
              <th>Rapprochement proposé</th>
              <th style="min-width:260px">Décision</th>
            </tr></thead>
            <tbody>${visibles.length
              ? visibles.map((s) => ligne(s, d.referentiel)).join('')
              : '<tr><td colspan="4" class="discret">Aucun libellé dans cette catégorie.</td></tr>'}
            </tbody>
          </table>
        </div>

        <div class="rang" style="margin-top:1.2rem;border-top:1px solid var(--bordure);padding-top:1.2rem">
          <button class="btn btn-principal" id="btn-appliquer-nonref">Appliquer</button>
          <button class="btn btn-secondaire" id="btn-fermer-nonref">Fermer</button>
        </div>`
      : `
        <div class="message message-succes" style="margin:1rem 0">
          Tous les libellés d'annuaire correspondent à un service du référentiel.
        </div>
        <button class="btn btn-secondaire" id="btn-fermer-nonref">Fermer</button>`}
    </div>`;

  brancher();
}

const ligne = (s, referentiel) => {
  const rang = RANGS[s.confiance] || RANGS.aucune;
  return `
  <tr data-source="${echapper(s.source)}">
    <td>
      <strong>${echapper(s.cible)}</strong>
      ${s.regroupe && s.source !== s.cible
        ? `<br><span class="discret" style="font-size:.78rem">regroupé depuis « ${echapper(s.source)} »</span>`
        : ''}
      ${s.chaineOu?.length > 1
        ? `<br><span class="discret" style="font-size:.76rem">${echapper(s.chaineOu.join(' < '))}</span>`
        : ''}
    </td>
    <td class="num">${s.effectif}</td>
    <td>
      ${s.proposition ? `
        <span class="pastille-etat" style="background:transparent;border:1px solid ${rang.couleur};color:${rang.couleur}">
          ${rang.libelle}
        </span>
        <strong style="margin-left:.4rem">${echapper(s.proposition)}</strong>
        ${s.motif ? `<br><span class="discret" style="font-size:.78rem">${echapper(s.motif)}</span>` : ''}`
        : '<span class="discret">Aucune correspondance trouvée</span>'}
    </td>
    <td>
      <select class="decision-nonref" aria-label="Décision pour ${echapper(s.cible)}">
        <option value="">Ne rien faire</option>
        <option value="${RATTACHER}">＋ Ajouter « ${echapper(s.cible)} » au référentiel</option>
        <optgroup label="Rattacher à un service du référentiel">
          ${referentiel.map((n) => `<option value="${echapper(n)}">${echapper(n)}</option>`).join('')}
        </optgroup>
      </select>
    </td>
  </tr>`;
};

function brancher() {
  const zone = document.getElementById('zone-formulaire');
  const fermer = document.getElementById('btn-fermer-nonref');
  fermer.addEventListener('click', () => { zone.innerHTML = ''; });
  if (!donnees.services.length) return;

  const selecteurs = () => [...zone.querySelectorAll('.decision-nonref')];
  const source = (sel) => sel.closest('tr').dataset.source;
  const fiche = (sel) => donnees.services.find((s) => s.source === source(sel));

  const majCompteur = () => {
    let rattaches = 0; let ajouts = 0; let agents = 0;
    selecteurs().forEach((sel) => {
      if (!sel.value) return;
      agents += fiche(sel)?.effectif || 0;
      if (sel.value === RATTACHER) ajouts++; else rattaches++;
    });
    const bouts = [];
    if (rattaches) bouts.push(`${rattaches} rattachement(s)`);
    if (ajouts) bouts.push(`${ajouts} ajout(s) au référentiel`);
    if (agents) bouts.push(`${agents} agent(s) concerné(s)`);
    document.getElementById('compteur-nonref').textContent = bouts.join(' · ') || 'Aucune décision';
  };
  majCompteur();

  zone.addEventListener('change', (e) => {
    if (e.target.matches('.decision-nonref')) majCompteur();
  });

  zone.querySelectorAll('[data-filtre]').forEach((b) => b.addEventListener('click', () => {
    // Le filtre re-rend le tableau : on retient les decisions deja prises,
    // sans quoi changer de vue les effacerait sans prevenir.
    const memoire = new Map(selecteurs().filter((s) => s.value).map((s) => [source(s), s.value]));
    filtre = b.dataset.filtre;
    rendre();
    [...document.querySelectorAll('.decision-nonref')].forEach((sel) => {
      const v = memoire.get(sel.closest('tr').dataset.source);
      if (v) sel.value = v;
    });
    majCompteur();
  }));

  document.getElementById('btn-retenir-sures').addEventListener('click', () => {
    selecteurs().forEach((sel) => {
      const s = fiche(sel);
      if (s?.confiance === 'sure' && s.proposition) sel.value = s.proposition;
    });
    majCompteur();
  });

  document.getElementById('btn-tout-ajouter').addEventListener('click', () => {
    selecteurs().forEach((sel) => { sel.value = RATTACHER; });
    majCompteur();
  });

  document.getElementById('btn-remettre-zero').addEventListener('click', () => {
    selecteurs().forEach((sel) => { sel.value = ''; });
    majCompteur();
  });

  document.getElementById('btn-appliquer-nonref').addEventListener('click', async () => {
    const affectations = [];
    const ajouts = [];
    selecteurs().forEach((sel) => {
      if (!sel.value) return;
      const s = fiche(sel);
      if (sel.value === RATTACHER) ajouts.push(s.cible);
      // La regle porte sur le libelle brut : c'est lui que la synchronisation
      // relira, pas la cible affichee.
      else affectations.push({ source: s.source, cible: sel.value });
    });

    if (!affectations.length && !ajouts.length) {
      return alerte('alerte', 'Aucune décision sélectionnée.');
    }

    const bouton = document.getElementById('btn-appliquer-nonref');
    bouton.disabled = true;
    bouton.textContent = 'Application…';
    try {
      const r = await api('/api/admin/services/non-references', {
        method: 'POST', body: { affectations, ajouts },
      });
      alerte('alerte', r.message, 'succes');
      filtre = 'tous';
      await formulaireNonReferences();
      auTermine();
    } catch (e) {
      alerte('alerte', e.message);
      bouton.disabled = false;
      bouton.textContent = 'Appliquer';
    }
  });
}
