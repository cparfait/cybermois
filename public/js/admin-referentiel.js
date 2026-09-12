import { api, echapper, alerte, animationsReduites } from '/js/commun.js';

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

/**
 * Neutralise un bouton le temps d'un appel, et le retablit dans tous les cas.
 * Deux clics sur « Enregistrer le référentiel » envoyaient deux fois la meme
 * liste : le second appel arrivait sur des identifiants que le premier venait
 * de renumeroter.
 */
async function pendant(bouton, libelleEnCours, action) {
  if (!bouton) return action();
  const libelle = bouton.textContent;
  bouton.disabled = true;
  if (libelleEnCours) bouton.textContent = libelleEnCours;
  try {
    return await action();
  } finally {
    bouton.disabled = false;
    bouton.textContent = libelle;
  }
}

export async function formulaireReferentiel(onTermine) {
  if (onTermine) auTermine = onTermine;
  const zone = document.getElementById('zone-formulaire');
  zone.innerHTML = '<div class="carte"><p class="discret">Chargement du référentiel…</p></div>';
  zone.scrollIntoView({ behavior: animationsReduites() ? 'auto' : 'smooth', block: 'nearest' });

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
          <caption class="sr-only">Services inscrits au référentiel</caption>
          <thead><tr><th scope="col" style="width:48px">Ordre</th><th scope="col">Nom du service</th>
            <th scope="col" class="num">Agents</th>
            <th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
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
  <tr data-id="${s.id || ''}">
    <td class="discret">${i + 1}</td>
    <td><input type="text" class="nom-service-ref" value="${echapper(s.nom || '')}"
               aria-label="Nom du service ${i + 1}"></td>
    <td class="num">${s.effectif ?? 0}</td>
    <td><button type="button" class="btn btn-secondaire" data-supprimer-ligne
                aria-label="Supprimer ${echapper(s.nom || `le service ${i + 1}`)}"
                style="padding:.3rem .6rem;font-size:.8rem;border-color:var(--erreur);color:var(--erreur)"><span aria-hidden="true">✕</span></button></td>
  </tr>`;

function brancher() {
  const zone = document.getElementById('zone-formulaire');
  // L'identifiant accompagne le nom : c'est lui qui permet au serveur de
  // distinguer un renommage d'une suppression suivie d'un ajout.
  const noms = () => [...zone.querySelectorAll('.nom-service-ref')]
    .map((c) => ({ id: Number(c.closest('tr').dataset.id) || null, nom: c.value.trim() }))
    .filter((s) => s.nom);

  // Supprimer une ligne ne touche a rien tant qu'on n'a pas enregistre. Les
  // autres boutons de l'ecran rechargent la liste depuis le serveur : ils
  // effacaient donc en silence les suppressions en attente. On vidait ses 42
  // lignes, on collait ses 6 services sans cocher « Remplacer », et le
  // referentiel en comptait 48 - les 42 revenues, plus les 6 ajoutees.
  let modifie = false;
  const marquer = () => { modifie = true; };

  zone.addEventListener('click', (e) => {
    if (e.target.matches('[data-supprimer-ligne]')) { e.target.closest('tr').remove(); marquer(); }
  });
  zone.addEventListener('input', (e) => {
    if (e.target.matches('.nom-service-ref')) marquer();
  });

  /** Previent avant qu'une action ne reparte de la liste enregistree. */
  const modificationsPerdues = (action) => modifie && !confirm(
    `Vos modifications de la liste ne sont pas enregistrées.\n\n${action} repart de la liste `
    + 'enregistrée : les lignes supprimées ou renommées ici seront perdues.\n\n'
    + 'Enregistrez d’abord si vous voulez les conserver. Continuer quand même ?'
  );

  document.getElementById('btn-ajouter-ligne').addEventListener('click', () => {
    const corps = document.getElementById('corps-referentiel');
    corps.insertAdjacentHTML('beforeend', ligne({ nom: '', effectif: 0 }, corps.children.length));
    corps.lastElementChild.querySelector('input').focus();
    marquer();
  });

  document.getElementById('btn-fermer-ref').addEventListener('click', () => {
    if (modificationsPerdues('Fermer')) return;
    zone.innerHTML = '';
  });

  // Le bouton dit ce qu'il va faire : « Ajouter » et « Remplacer » n'ont pas
  // le meme effet, et la case se lit mal a cote d'un libelle qui ne bouge pas.
  const remplacer = document.getElementById('remplacer-referentiel');
  const boutonColler = document.getElementById('btn-coller');
  const majLibelleColler = () => {
    boutonColler.textContent = remplacer.checked ? 'Remplacer le référentiel' : 'Ajouter au référentiel';
  };
  remplacer.addEventListener('change', majLibelleColler);
  majLibelleColler();

  const recharger = async (message) => {
    if (message) alerte('alerte', message, 'succes');
    await formulaireReferentiel();
    auTermine();
  };

  const boutonEnregistrer = document.getElementById('btn-enregistrer-ref');
  boutonEnregistrer.addEventListener('click', () => pendant(boutonEnregistrer, 'Enregistrement…', async () => {
    try {
      const r = await api('/api/admin/referentiel', { method: 'PUT', body: { services: noms() } });
      await recharger(r.message);
    } catch (e) { alerte('alerte', e.message); }
  }));

  boutonColler.addEventListener('click', () => {
    const champ = document.getElementById('collage-services');
    const texte = champ.value;
    if (!texte.trim()) {
      alerte('alerte', 'Collez la liste des services.');
      champ.focus();
      return undefined;
    }
    if (modificationsPerdues('Coller une liste')) return undefined;
    return pendant(boutonColler, 'Enregistrement…', async () => {
      try {
        const r = await api('/api/admin/referentiel/coller', {
          method: 'POST',
          body: { texte, remplacer: remplacer.checked },
        });
        await recharger(r.message);
      } catch (e) { alerte('alerte', e.message); }
    });
  });

  const boutonInitialiser = document.getElementById('btn-initialiser');
  boutonInitialiser.addEventListener('click', () => {
    if (modificationsPerdues('Amorcer depuis les données')) return undefined;
    // Ce bouton verse TOUS les libelles d'annuaire au referentiel : sur un
    // annuaire reel cela en fait des dizaines, soit l'inverse d'une liste de
    // directions. Il ne rend service que sur un referentiel vide.
    if (!confirm(
      'Ajouter au référentiel tous les services trouvés dans les données ?\n\n'
      + 'Il y en a souvent plusieurs dizaines, un par libellé d’annuaire. '
      + 'À réserver à un référentiel vide : pour une liste de directions, collez-la vous-même.'
    )) return undefined;
    return pendant(boutonInitialiser, 'Amorçage…', async () => {
      try {
        const r = await api('/api/admin/referentiel/initialiser', { method: 'POST' });
        await recharger(r.message);
      } catch (e) { alerte('alerte', e.message); }
    });
  });

  const boutonAppliquer = document.getElementById('btn-appliquer-ref');
  boutonAppliquer.addEventListener('click', () => {
    if (modificationsPerdues('Rattacher les libellés')) return undefined;
    if (!confirm(
      'Rattacher chaque libellé d\'annuaire au service du référentiel qui lui correspond ?\n\n'
      + 'Le rapprochement se fait sur le nom, en ignorant la casse et les accents, et par préfixe : '
      + '« Jeunesse - Kid Club » rejoint « Jeunesse » si ce service figure au référentiel.'
    )) return undefined;
    return pendant(boutonAppliquer, 'Rattachement…', async () => {
      try {
        const r = await api('/api/admin/referentiel/appliquer', { method: 'POST' });
        await recharger(r.message);
      } catch (e) { alerte('alerte', e.message); }
    });
  });
}
