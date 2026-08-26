import { api, echapper, alerte } from '/js/commun.js';

/**
 * Referentiel des services.
 *
 * C'est la liste que la collectivite reconnait, maintenue ici, et vers laquelle
 * le regroupement pointe. Sans elle, chaque regroupement se saisissait en texte
 * libre : deux graphies suffisaient a creer deux services.
 *
 * Elle peut etre preparee avant meme de connaitre le contenu de l'annuaire.
 */

let auTermine = () => {};
let donnees = null;

export async function formulaireReferentiel(onTermine) {
  if (onTermine) auTermine = onTermine;
  const zone = document.getElementById('zone-formulaire');
  zone.innerHTML = '<div class="carte"><p class="discret">Chargement du référentiel…</p></div>';
  zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    donnees = await api('/api/admin/referentiel');
  } catch (e) {
    zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }
  rendre();
}

function rendre() {
  const d = donnees;
  const vide = d.services.length === 0;

  document.getElementById('zone-formulaire').innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--vert-clair)">
      <h2>Référentiel des services</h2>
      <p class="discret" style="margin-top:-.3em">
        La liste des services que la collectivité reconnaît. Le regroupement des libellés
        d'annuaire pointe vers elle, ce qui évite qu'une différence d'orthographe ne crée
        un service de plus.
      </p>

      ${vide ? `
        <div class="message message-info" style="margin:1rem 0">
          <strong>Le référentiel est vide.</strong> Deux façons de le remplir : coller votre
          liste ci-dessous, ou l'amorcer à partir des services déjà présents dans les données.
        </div>` : ''}

      <div class="bandeau-stats" style="margin:1rem 0">
        <div class="stat-admin"><div class="v">${d.services.length}</div><div class="l">services au référentiel</div></div>
        <div class="stat-admin"><div class="v">${d.services.filter((s) => s.effectif > 0).length}</div><div class="l">avec des agents</div></div>
        <div class="stat-admin"><div class="v">${d.horsReferentiel.length}</div><div class="l">libellés hors référentiel</div></div>
      </div>

      <details class="aide-admin" ${vide ? 'open' : ''}>
        <summary>Coller une liste de services</summary>
        <p>Un service par ligne, ou séparés par des virgules. Les numéros en début de ligne
        sont ignorés, ce qui permet de copier-coller depuis une page web sans nettoyer.</p>
        <div class="champ-admin">
          <label for="collage-services" class="sr-only">Liste des services</label>
          <textarea id="collage-services" style="min-height:150px;font-family:var(--police-ui)"
                    placeholder="Police Municipale&#10;Ressources Humaines&#10;Petite Enfance&#10;Éducation…"></textarea>
        </div>
        <div class="rang">
          <button class="btn btn-principal" id="btn-coller" style="padding:.45rem .9rem;font-size:.85rem">
            Ajouter au référentiel
          </button>
          <label style="display:flex;align-items:center;gap:.5rem;font-weight:400">
            <input type="checkbox" id="remplacer-referentiel" style="width:18px;height:18px;accent-color:var(--vert-fonce)">
            <span class="ui" style="font-size:.85rem">Remplacer la liste actuelle</span>
          </label>
        </div>
      </details>

      <div class="rang" style="margin:1rem 0">
        <button class="btn btn-secondaire" id="btn-initialiser" style="padding:.45rem .9rem;font-size:.85rem">
          Amorcer depuis les données
        </button>
        <button class="btn btn-secondaire" id="btn-appliquer-ref" style="padding:.45rem .9rem;font-size:.85rem">
          Rattacher les libellés au référentiel
        </button>
      </div>

      ${d.horsReferentiel.length ? `
        <details style="margin-bottom:1rem">
          <summary class="ui" style="cursor:pointer;font-weight:700;color:var(--alerte)">
            ${d.horsReferentiel.length} libellé(s) utilisé(s) mais absent(s) du référentiel
          </summary>
          <p class="discret" style="font-size:.84rem;margin:.4rem 0">
            Ils apparaissent au classement sans figurer dans votre liste. Ajoutez-les, ou
            regroupez-les vers un service existant.
          </p>
          <ul class="ui" style="font-size:.84rem;columns:2">
            ${d.horsReferentiel.slice(0, 60).map((h) => `<li>${echapper(h.service)} — ${h.effectif}</li>`).join('')}
          </ul>
        </details>` : ''}

      <h3>Liste actuelle</h3>
      <p class="discret" style="margin-top:-.3em;font-size:.84rem">
        Modifiez un nom directement dans le champ. Une ligne vidée est supprimée à l'enregistrement.
      </p>

      <div class="tableau-defilant" style="max-height:420px;overflow-y:auto">
        <table class="admin">
          <thead><tr><th style="width:48px">Ordre</th><th>Nom du service</th><th class="num">Agents</th><th></th></tr></thead>
          <tbody id="corps-referentiel">${d.services.map((s, i) => ligne(s, i)).join('')
            || '<tr><td colspan="4" class="discret">Référentiel vide.</td></tr>'}</tbody>
        </table>
      </div>

      <div class="rang" style="margin-top:.8rem">
        <button class="btn btn-secondaire" id="btn-ajouter-ligne" style="padding:.45rem .9rem;font-size:.85rem">
          + Ajouter un service
        </button>
      </div>

      <div class="rang" style="margin-top:1.2rem;border-top:1px solid var(--bordure);padding-top:1.2rem">
        <button class="btn btn-principal" id="btn-enregistrer-ref">Enregistrer le référentiel</button>
        <button class="btn btn-secondaire" id="btn-fermer-ref">Fermer</button>
      </div>
    </div>`;

  brancher();
}

const ligne = (s, i) => `
  <tr>
    <td class="discret">${i + 1}</td>
    <td><input type="text" class="nom-service-ref" value="${echapper(s.nom || '')}"
               aria-label="Nom du service ${i + 1}"></td>
    <td class="num">${s.effectif ?? 0}</td>
    <td><button type="button" class="btn btn-secondaire" data-supprimer-ligne
                aria-label="Supprimer ${echapper(s.nom || '')}"
                style="padding:.3rem .6rem;font-size:.8rem;border-color:var(--erreur);color:var(--erreur)">✕</button></td>
  </tr>`;

function brancher() {
  const zone = document.getElementById('zone-formulaire');
  const noms = () => [...zone.querySelectorAll('.nom-service-ref')].map((c) => c.value.trim()).filter(Boolean);

  zone.addEventListener('click', (e) => {
    if (e.target.matches('[data-supprimer-ligne]')) e.target.closest('tr').remove();
  });

  document.getElementById('btn-ajouter-ligne').addEventListener('click', () => {
    const corps = document.getElementById('corps-referentiel');
    corps.insertAdjacentHTML('beforeend', ligne({ nom: '', effectif: 0 }, corps.children.length));
    corps.lastElementChild.querySelector('input').focus();
  });

  document.getElementById('btn-fermer-ref').addEventListener('click', () => { zone.innerHTML = ''; });

  const recharger = async (message) => {
    if (message) alerte('alerte', message, 'succes');
    await formulaireReferentiel();
    auTermine();
  };

  document.getElementById('btn-enregistrer-ref').addEventListener('click', async () => {
    try {
      const r = await api('/api/admin/referentiel', { method: 'PUT', body: { services: noms() } });
      await recharger(r.message);
    } catch (e) { alerte('alerte', e.message); }
  });

  document.getElementById('btn-coller').addEventListener('click', async () => {
    const texte = document.getElementById('collage-services').value;
    if (!texte.trim()) return alerte('alerte', 'Collez la liste des services.');
    try {
      const r = await api('/api/admin/referentiel/coller', {
        method: 'POST',
        body: { texte, remplacer: document.getElementById('remplacer-referentiel').checked },
      });
      await recharger(r.message);
    } catch (e) { alerte('alerte', e.message); }
  });

  document.getElementById('btn-initialiser').addEventListener('click', async () => {
    try {
      const r = await api('/api/admin/referentiel/initialiser', { method: 'POST' });
      await recharger(r.message);
    } catch (e) { alerte('alerte', e.message); }
  });

  document.getElementById('btn-appliquer-ref').addEventListener('click', async () => {
    if (!confirm(
      'Rattacher chaque libellé d\'annuaire au service du référentiel qui lui correspond ?\n\n'
      + 'Le rapprochement se fait sur le nom, en ignorant la casse et les accents, et par préfixe : '
      + '« Jeunesse - Kid Club » rejoint « Jeunesse » si ce service figure au référentiel.'
    )) return;
    try {
      const r = await api('/api/admin/referentiel/appliquer', { method: 'POST' });
      await recharger(r.message);
    } catch (e) { alerte('alerte', e.message); }
  });
}
