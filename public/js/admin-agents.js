import { api, echapper, alerte, formaterDate, animationsReduites } from '/js/commun.js';
import { formulaireSynchronisation } from '/js/admin-sync.js';
import { formulaireResultatsAgent } from '/js/admin-corrections.js';
import { formulaireServices as formulaireEffectifsServices } from '/js/admin-services.js';
import { formulaireRattachement } from '/js/admin-rattachement.js';
import { formulaireReferentiel } from '/js/admin-referentiel.js';
import { formulaireNonReferences } from '/js/admin-non-references.js';

let etatFiltres = { recherche: '', service: '', etat: '', page: 1, parPage: 50 };
let dernierImport = null;

/** Defilement respectueux du reglage « reduire les animations ». */
const glisser = () => (animationsReduites() ? 'auto' : 'smooth');
const amener = (element, block = 'nearest') =>
  element?.scrollIntoView({ behavior: glisser(), block });
const remonter = () => window.scrollTo({ top: 0, behavior: glisser() });

/**
 * Neutralise un bouton le temps d'un appel, et le retablit dans tous les cas.
 * Un double clic sur « Ajouter » creait deux agents ; sur une action groupee,
 * il exclut deux fois - la seconde echouant avec un message d'erreur apres une
 * operation pourtant reussie.
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

/**
 * Restaure le focus et la position du curseur apres un re-rendu.
 *
 * Chaque frappe dans le champ de recherche relance chargerAgents(), qui
 * remplace tout le panneau : le champ disparaissait sous les doigts, le focus
 * retombait sur <body>, et il fallait recliquer entre chaque lettre. On note
 * ou on en etait avant, on y revient apres.
 */
function memoriserSaisie(id) {
  const champ = document.getElementById(id);
  if (!champ || document.activeElement !== champ) return null;
  return { id, debut: champ.selectionStart, fin: champ.selectionEnd };
}

function restaurerSaisie(memoire) {
  if (!memoire) return;
  const champ = document.getElementById(memoire.id);
  if (!champ) return;
  champ.focus({ preventScroll: true });
  try {
    champ.setSelectionRange(memoire.debut, memoire.fin);
  } catch { /* certains types de champ refusent setSelectionRange */ }
}

/**
 * Lit un fichier CSV en gerant l'encodage.
 * Un export PowerShell 5.1 ou un « enregistrer sous CSV » d'Excel produit souvent
 * du Windows-1252 : decode en UTF-8 strict, il echoue. On retombe alors sur 1252.
 */
async function lireFichier(fichier) {
  const donnees = await fichier.arrayBuffer();
  try {
    return { texte: new TextDecoder('utf-8', { fatal: true }).decode(donnees), encodage: 'UTF-8' };
  } catch {
    return { texte: new TextDecoder('windows-1252').decode(donnees), encodage: 'Windows-1252' };
  }
}

/**
 * Tuile de statistique cliquable : le chiffre affiche et le filtre qui le
 * produit sont la meme chose, il n'y a donc aucune raison de les separer.
 */
function tuile(valeur, libelle, etat) {
  const actif = etatFiltres.etat === etat;
  return `
    <button type="button" class="stat-admin stat-cliquable${actif ? ' stat-active' : ''}"
            data-filtre="${etat}" aria-pressed="${actif}">
      <span class="v">${valeur}</span>
      <span class="l">${libelle}</span>
    </button>`;
}

const pagination = (p) => p.total
  ? `${(p.page - 1) * p.parPage + 1}–${Math.min(p.page * p.parPage, p.total)} sur ${p.total} agent${p.total > 1 ? 's' : ''}`
  : 'Aucun agent';

/** Navigation entre pages : sans elle, 600 lignes arrivent d'un bloc. */
function navigation(p) {
  if (p.pages <= 1) return '';
  return `
    <div class="rang" style="justify-content:center;margin-top:1rem">
      <button type="button" class="btn btn-secondaire" data-page="1" ${p.page === 1 ? 'disabled' : ''}
              style="padding:.4rem .8rem;font-size:.85rem">Première</button>
      <button type="button" class="btn btn-secondaire" data-page="${p.page - 1}" ${p.page === 1 ? 'disabled' : ''}
              style="padding:.4rem .8rem;font-size:.85rem">Précédente</button>
      <span class="ui" style="padding:0 .8rem;font-weight:700">Page ${p.page} sur ${p.pages}</span>
      <button type="button" class="btn btn-secondaire" data-page="${p.page + 1}" ${p.page === p.pages ? 'disabled' : ''}
              style="padding:.4rem .8rem;font-size:.85rem">Suivante</button>
      <button type="button" class="btn btn-secondaire" data-page="${p.pages}" ${p.page === p.pages ? 'disabled' : ''}
              style="padding:.4rem .8rem;font-size:.85rem">Dernière</button>
    </div>`;
}

export async function chargerAgents() {
  const cible = document.getElementById('panneau-agents');
  // Note prise avant l'appel : le champ existe encore, et c'est lui qui porte
  // le focus quand la recherche est en cours de frappe.
  const saisie = memoriserSaisie('f-recherche');

  const parametres = new URLSearchParams();
  if (etatFiltres.recherche) parametres.set('recherche', etatFiltres.recherche);
  if (etatFiltres.service) parametres.set('service', etatFiltres.service);
  if (etatFiltres.etat) parametres.set('etat', etatFiltres.etat);
  parametres.set('page', etatFiltres.page);
  parametres.set('parPage', etatFiltres.parPage);

  let d;
  try {
    d = await api(`/api/admin/agents?${parametres}`);
  } catch (e) {
    cible.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }

  const r = d.resume;

  cible.innerHTML = `
    <details class="aide-admin">
      <summary>Comment alimenter la liste des agents</summary>
      <p><strong>La synchronisation depuis l'annuaire est la voie normale.</strong> Elle lit
      directement l'Active Directory, repère les comptes déjà connus et ne propose que les
      nouveaux — ce qui permet de la relancer autant de fois qu'on veut, pendant la campagne
      comme l'année suivante, pour rattraper les arrivées.</p>
      <p>Rien n'entre sans validation : vous passez en revue les nouveaux comptes service par
      service avant de les accepter. Les comptes désactivés dans l'annuaire sont écartés des
      effectifs et des statistiques, en conservant leurs résultats.</p>
      <p>L'<strong>import CSV</strong> reste disponible si vous préférez passer par un fichier
      relu dans Excel, et l'<strong>ajout manuel</strong> pour un cas particulier. Sans aucun
      des trois, un agent n'apparaît qu'à sa première connexion — et le taux de participation
      reste faux jusque-là.</p>
      <p>Un agent ajouté ici <strong>ne dispose d'aucun compte</strong> : il se connectera avec
      son compte Active Directory, comme tout le monde. La fiche sert uniquement à le compter et
      à le contacter.</p>
    </details>

    <p class="discret" style="margin-bottom:.5rem;font-size:.82rem">
      Cliquez sur un chiffre pour filtrer la liste.
    </p>
    <div class="bandeau-stats" style="margin-bottom:1.1rem">
      ${tuile(r.total - r.exclus, 'agents dans la campagne', 'actifs')}
      ${tuile(r.connectes, 'se sont déjà connectés', 'connectes')}
      ${tuile(r.jamais_connectes, 'jamais connectés', 'jamais_connecte')}
      ${tuile(r.sans_email, 'sans adresse mail', 'sans_email')}
      ${tuile(r.importes, "issus de l'annuaire", 'annuaire')}
      ${tuile(r.exclus, 'exclus de la campagne', 'exclus')}
      ${tuile(r.anonymes, 'masqués du classement', 'anonymes')}
      ${r.hors_referentiel ? tuile(r.hors_referentiel, 'hors référentiel', 'hors_referentiel') : ''}
    </div>

    ${d.horsReferentiel?.length ? `
      <div class="message message-alerte" style="margin-bottom:1.1rem">
        <strong>${d.horsReferentiel.reduce((n, s) => n + s.n, 0)} agent(s)
        rattachés à ${d.horsReferentiel.length} service(s) absents du référentiel.</strong>
        Ils apparaîtront au classement sous un nom que la collectivité ne reconnaît pas.
        <details style="margin-top:.5rem">
          <summary class="ui" style="cursor:pointer;font-size:.85rem">Voir lesquels</summary>
          <ul class="ui" style="font-size:.84rem;columns:2;margin:.4rem 0 0">
            ${d.horsReferentiel.slice(0, 60).map((s) => `
              <li>${echapper(s.service)} — ${s.n}</li>`).join('')}
          </ul>
          ${d.horsReferentiel.length > 60
            ? `<p class="discret" style="font-size:.82rem">… et ${d.horsReferentiel.length - 60} autre(s)</p>`
            : ''}
        </details>
        <p style="margin:.6rem 0 0;font-size:.86rem">
          Ils n'entrent pas au classement collectif, qui ne retient que les directions du
          référentiel. Traitez-les depuis <strong>« Services non référencés »</strong> :
          rattachez-les à une direction reconnue, ou ajoutez-les au référentiel.
        </p>
        <div class="rang" style="margin-top:.6rem">
          <button type="button" class="btn btn-secondaire" data-filtre="hors_referentiel"
                  style="padding:.35rem .8rem;font-size:.82rem">Voir ces agents dans la liste</button>
        </div>
      </div>` : ''}

    <div class="barre-outils" style="margin-bottom:1.2rem">
      <button class="btn btn-principal" id="btn-ouvrir-sync">Synchroniser depuis l'annuaire</button>
      <button class="btn btn-secondaire" id="btn-ouvrir-referentiel">Référentiel des services</button>
      <button class="btn btn-secondaire" id="btn-ouvrir-nonref">Services non référencés</button>
      <button class="btn btn-secondaire" id="btn-ouvrir-effectifs">Services participants</button>
      <button class="btn btn-secondaire" id="btn-ouvrir-services">Renommer et regrouper</button>
      <button class="btn btn-secondaire" id="btn-ouvrir-rattachement">Agents sans service</button>
      <button class="btn btn-secondaire" id="btn-ouvrir-ajout">Ajouter un agent</button>
      <details style="margin-left:auto">
        <summary class="ui discret" style="cursor:pointer;font-size:.84rem;padding:.5rem">Import par fichier</summary>
        <div class="rang" style="margin-top:.5rem">
          <button class="btn btn-secondaire" id="btn-ouvrir-import" style="padding:.4rem .8rem;font-size:.82rem">Importer un CSV</button>
          <a class="btn btn-secondaire" href="/api/admin/agents/modele.csv" style="padding:.4rem .8rem;font-size:.82rem">Modèle</a>
        </div>
      </details>
    </div>

    <div id="zone-formulaire"></div>

    ${etatFiltres.service ? `
      <div class="message message-info" style="margin-bottom:1rem">
        <div class="rang" style="justify-content:space-between">
          <span>Direction filtrée : <strong>${echapper(etatFiltres.service)}</strong></span>
          <span class="rang">
            <button type="button" class="btn btn-secondaire" id="btn-renommer-service"
                    style="padding:.35rem .8rem;font-size:.82rem">Renommer ou regrouper cette direction</button>
            <button type="button" class="btn btn-secondaire" id="btn-retirer-service"
                    style="padding:.35rem .8rem;font-size:.82rem">Retirer le filtre</button>
          </span>
        </div>
      </div>` : ''}

    <h2 style="margin-bottom:.6rem">Liste des agents</h2>
    <div class="barre-filtres" style="margin-bottom:1rem">
      <div class="champ-admin" style="flex:2;min-width:240px">
        <label for="f-recherche">Rechercher</label>
        <input type="search" id="f-recherche" value="${echapper(etatFiltres.recherche)}" placeholder="nom, identifiant ou adresse">
      </div>
      <div class="champ-admin" style="flex:1;min-width:190px">
        <label for="f-service">Direction</label>
        <select id="f-service">
          <option value="">Toutes les directions</option>
          ${d.services.map((s) => `<option value="${echapper(s.service)}"${s.service === etatFiltres.service ? ' selected' : ''}>${echapper(s.service)} (${s.n})</option>`).join('')}
        </select>
      </div>
      <div class="champ-admin" style="flex:1;min-width:180px">
        <label for="f-etat">État</label>
        <select id="f-etat">
          <option value="">Tous</option>
          <option value="actifs"${etatFiltres.etat === 'actifs' ? ' selected' : ''}>Dans la campagne</option>
          <option value="connectes"${etatFiltres.etat === 'connectes' ? ' selected' : ''}>Déjà connectés</option>
          <option value="annuaire"${etatFiltres.etat === 'annuaire' ? ' selected' : ''}>Issus de l'annuaire</option>
          <option value="anonymes"${etatFiltres.etat === 'anonymes' ? ' selected' : ''}>Masqués du classement</option>
          <option value="hors_referentiel"${etatFiltres.etat === 'hors_referentiel' ? ' selected' : ''}>Hors référentiel</option>
          <option value="jamais_connecte"${etatFiltres.etat === 'jamais_connecte' ? ' selected' : ''}>Jamais connectés</option>
          <option value="inactifs"${etatFiltres.etat === 'inactifs' ? ' selected' : ''}>Aucun défi terminé</option>
          <option value="sans_email"${etatFiltres.etat === 'sans_email' ? ' selected' : ''}>Sans adresse mail</option>
          <option value="joueurs"${etatFiltres.etat === 'joueurs' ? ' selected' : ''}>Ont joué</option>
          <option value="exclus"${etatFiltres.etat === 'exclus' ? ' selected' : ''}>Exclus</option>
        </select>
      </div>
      <button class="btn btn-secondaire" id="btn-reinit-filtres" style="padding:.55rem 1rem">Réinitialiser</button>
    </div>

    <div id="barre-selection" hidden class="message message-info" style="margin-bottom:1rem">
      <span id="nb-selection"></span>
      <div class="rang" style="margin-top:.6rem">
        <button class="btn btn-secondaire" style="padding:.3rem .7rem;font-size:.8rem" data-groupe="exclure">Exclure</button>
        <button class="btn btn-secondaire" style="padding:.3rem .7rem;font-size:.8rem" data-groupe="reintegrer">Réintégrer</button>
        <button class="btn btn-secondaire" style="padding:.3rem .7rem;font-size:.8rem" data-groupe="anonymiser">Masquer du classement</button>
        <button class="btn btn-secondaire" style="padding:.3rem .7rem;font-size:.8rem" data-groupe="nommer">Réafficher</button>
        <button class="btn btn-secondaire" style="padding:.3rem .7rem;font-size:.8rem;border-color:var(--erreur);color:var(--erreur)" data-groupe="supprimer">Supprimer</button>
      </div>
    </div>

    <div class="rang" style="justify-content:space-between;margin-bottom:.6rem">
      <span class="discret ui">${pagination(d.pagination)}</span>
      <label class="discret ui" style="display:flex;align-items:center;gap:.4rem;font-weight:400">
        Par page
        <select id="f-par-page" style="width:auto;padding:.3rem .5rem">
          ${[25, 50, 100, 200].map((n) => `<option value="${n}"${n === d.pagination.parPage ? ' selected' : ''}>${n}</option>`).join('')}
        </select>
      </label>
    </div>

    <div class="tableau-defilant"><table class="admin agents">
      <caption class="sr-only">Liste des agents de la campagne</caption>
      <thead><tr>
        <th scope="col" style="width:32px">
          <input type="checkbox" id="tout-selectionner" aria-label="Tout sélectionner" style="width:18px;height:18px;accent-color:var(--vert-fonce)">
          <span class="sr-only">Sélection</span>
        </th>
        <th scope="col">Agent</th><th scope="col">Direction</th><th scope="col">Adresse</th>
        <th scope="col" class="num">Défis</th><th scope="col" class="num">Points</th>
        <th scope="col">État</th><th scope="col">Actions</th>
      </tr></thead>
      <tbody>${d.agents.length ? d.agents.map(ligneAgent).join('')
        : '<tr><td colspan="8" class="discret">Aucun agent ne correspond à ces critères.</td></tr>'}</tbody>
    </table></div>

    ${navigation(d.pagination)}`;

  brancher(d);
  restaurerSaisie(saisie);
}

function ligneAgent(a) {
  const etats = [];
  if (a.exclu) etats.push('<span class="pastille-etat etat-ko">Exclu</span>');
  else if (!a.vu_le) etats.push('<span class="pastille-etat" style="background:var(--alerte-fond);color:var(--alerte)">Jamais connecté</span>');
  else etats.push(`<span class="pastille-etat etat-ok" title="Vu le ${formaterDate(a.vu_le)}">Connecté</span>`);
  if (a.anonyme) etats.push('<span class="pastille-etat" style="background:var(--info-fond);color:var(--info)">Masqué</span>');
  if (a.est_admin) etats.push('<span class="pastille-etat etat-ok">Admin</span>');

  // La direction est ce qui parait au classement ; le service d'annuaire dont
  // elle decoule ne se lisait que dans une infobulle, derriere une asterisque.
  // Il fallait survoler chaque ligne pour savoir a quoi un agent est rattache,
  // et donc pour comprendre pourquoi il compte pour telle direction.
  const provenance = a.service_force
    ? 'Direction choisie à la main : la synchronisation avec l’annuaire ne la modifie plus.'
    : a.service_ad && a.service_ad !== a.service
      ? `Service « ${a.service_ad} » lu dans l’annuaire, rattaché à cette direction.`
      : null;

  const origine = a.service_force
    ? '<span class="discret" style="font-size:.72rem">Rattachement manuel</span>'
    : a.service_ad && a.service_ad !== a.service
      ? `<span class="discret tronque" style="font-size:.72rem">Annuaire : ${echapper(a.service_ad)}</span>`
      : '';

  // Une direction absente du referentiel paraitra au classement sous un nom que
  // la collectivite ne reconnait pas. Le signaler ici evite de le decouvrir une
  // fois la campagne ouverte.
  const service = `
    <button type="button" class="lien-service tronque" data-service="${echapper(a.service)}"
            title="${echapper(`${a.service} — cliquer pour filtrer sur cette direction`)}">${echapper(a.service)}</button>${
    origine ? `<br><span title="${echapper(provenance || '')}">${origine}</span>` : ''}${
    a.serviceReference === false
      ? '<br><span class="pastille-etat" style="font-size:.66rem;background:var(--alerte-fond);color:var(--alerte)"'
        + ' title="Cette direction ne figure pas au référentiel">hors référentiel</span>'
      : ''}`;

  return `
    <tr data-id="${a.id}">
      <td><input type="checkbox" class="case-agent" value="${a.id}" aria-label="Sélectionner ${echapper(a.nom_complet)}" style="width:18px;height:18px;accent-color:var(--vert-fonce)"></td>
      <td><strong>${echapper(a.nom_complet)}</strong><br><span class="discret" style="font-size:.78rem">${echapper(a.login)}</span></td>
      <td class="col-service">${service}</td>
      <td class="col-adresse">${a.email
        ? `<span class="tronque" title="${echapper(a.email)}">${echapper(a.email)}</span>`
        : '<span class="discret">—</span>'}</td>
      <td class="num">${a.defis_joues}</td>
      <td class="num">${a.score_total}</td>
      <td>${etats.join(' ') || '<span class="discret">—</span>'}</td>
      <td class="actions">
        <button class="btn btn-secondaire" style="padding:.25rem .55rem;font-size:.76rem" data-modifier="${a.id}">Modifier</button>
        ${a.defis_joues ? `<button class="btn btn-secondaire" style="padding:.25rem .55rem;font-size:.76rem" data-resultats="${a.id}">Résultats</button>` : ''}
        ${a.defis_joues ? `<button class="btn btn-secondaire" style="padding:.25rem .55rem;font-size:.76rem;border-color:var(--alerte);color:var(--alerte)"
                data-remise-a-zero="${a.id}" data-nom="${echapper(a.nom_complet)}">Effacer ses essais</button>` : ''}
        <button class="btn btn-secondaire" style="padding:.25rem .55rem;font-size:.76rem;border-color:var(--erreur);color:var(--erreur)" data-supprimer="${a.id}">Suppr.</button>
      </td>
    </tr>`;
}

function brancher(d) {
  const cible = document.getElementById('panneau-agents');

  // --- Filtres
  let minuteur;
  document.getElementById('f-recherche').addEventListener('input', (e) => {
    clearTimeout(minuteur);
    minuteur = setTimeout(() => {
      etatFiltres.recherche = e.target.value.trim(); etatFiltres.page = 1; chargerAgents();
    }, 350);
  });
  document.getElementById('f-service').addEventListener('change', (e) => {
    etatFiltres.service = e.target.value; etatFiltres.page = 1; chargerAgents();
  });
  document.getElementById('f-etat').addEventListener('change', (e) => {
    etatFiltres.etat = e.target.value; etatFiltres.page = 1; chargerAgents();
  });
  document.getElementById('btn-reinit-filtres').addEventListener('click', () => {
    etatFiltres = { recherche: '', service: '', etat: '', page: 1, parPage: etatFiltres.parPage };
    chargerAgents();
  });

  document.getElementById('f-par-page')?.addEventListener('change', (e) => {
    etatFiltres.parPage = Number(e.target.value); etatFiltres.page = 1; chargerAgents();
  });

  // Le service affiche dans chaque ligne filtre la liste : c'est le geste
  // naturel quand on cherche « qui est dans ce service ».
  cible.querySelectorAll('[data-service]').forEach((b) => b.addEventListener('click', () => {
    etatFiltres.service = b.dataset.service;
    etatFiltres.page = 1;
    chargerAgents();
  }));

  document.getElementById('btn-retirer-service')?.addEventListener('click', () => {
    etatFiltres.service = ''; etatFiltres.page = 1; chargerAgents();
  });

  document.getElementById('btn-renommer-service')?.addEventListener('click', () => {
    formulaireServices(etatFiltres.service);
  });

  cible.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => {
    etatFiltres.page = Number(b.dataset.page);
    chargerAgents();
    amener(document.getElementById('panneau-agents'), 'start');
  }));

  // Recliquer sur la tuile active retire le filtre : pas besoin d'un bouton dedie
  cible.querySelectorAll('[data-filtre]').forEach((b) => b.addEventListener('click', () => {
    etatFiltres.etat = etatFiltres.etat === b.dataset.filtre ? '' : b.dataset.filtre;
    etatFiltres.page = 1;
    chargerAgents();
  }));

  // --- Selection multiple
  const cases = () => [...cible.querySelectorAll('.case-agent')];
  const sel = () => cases().filter((c) => c.checked).map((c) => Number(c.value));

  const majSelection = () => {
    const n = sel().length;
    const barre = document.getElementById('barre-selection');
    barre.hidden = n === 0;
    document.getElementById('nb-selection').textContent = `${n} agent${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}`;
  };

  document.getElementById('tout-selectionner').addEventListener('change', (e) => {
    cases().forEach((c) => { c.checked = e.target.checked; });
    majSelection();
  });
  cible.addEventListener('change', (e) => { if (e.target.matches('.case-agent')) majSelection(); });

  cible.querySelectorAll('[data-groupe]').forEach((b) => b.addEventListener('click', () => {
    const ids = sel();
    const action = b.dataset.groupe;
    if (!ids.length) return undefined;
    if (action === 'supprimer' && !confirm(
      `Supprimer définitivement ${ids.length} agent(s) et tous leurs résultats ?\n\n`
      + "L'exclusion est préférable : elle les écarte de la campagne en conservant l'historique."
    )) return undefined;

    return pendant(b, 'En cours…', async () => {
      try {
        const r = await api('/api/admin/agents/action-groupee', { method: 'POST', body: { ids, action } });
        alerte('alerte', r.message, 'succes');
        await chargerAgents();
      } catch (e) { alerte('alerte', e.message); }
    });
  }));

  // --- Actions unitaires
  cible.querySelectorAll('[data-modifier]').forEach((b) =>
    b.addEventListener('click', () => formulaireAgent(d.agents.find((a) => a.id === Number(b.dataset.modifier)), d.services)));

  // Pendant une recette on joue, on recommence, on fait jouer un collegue.
  // Remettre toute la base a zero pour cela detruirait les essais des autres.
  cible.querySelectorAll('[data-remise-a-zero]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(
      `Effacer tous les résultats de ${b.dataset.nom} ?

`
      + 'Participations, réponses, tentatives en cours et badges. Le compte est conservé '
      + 'et pourra rejouer depuis le début.'
    )) return;
    try {
      const r = await api(`/api/admin/agents/${b.dataset.remiseAZero}/reinitialiser`, { method: 'POST' });
      alerte('alerte', r.message, 'succes');
      chargerAgents();
    } catch (e) { alerte('alerte', e.message); }
  }));

  cible.querySelectorAll('[data-resultats]').forEach((b) =>
    b.addEventListener('click', () => formulaireResultatsAgent(Number(b.dataset.resultats), chargerAgents)));

  cible.querySelectorAll('[data-supprimer]').forEach((b) =>
    b.addEventListener('click', () => supprimer(d.agents.find((a) => a.id === Number(b.dataset.supprimer)))));

  // --- Ouverture des formulaires
  document.getElementById('btn-ouvrir-ajout').addEventListener('click', () => formulaireAgent(null, d.services));
  document.getElementById('btn-ouvrir-import').addEventListener('click', () => formulaireImport());
  document.getElementById('btn-ouvrir-services').addEventListener('click', () => formulaireServices());
  document.getElementById('btn-ouvrir-sync')
    .addEventListener('click', () => formulaireSynchronisation(chargerAgents));
  document.getElementById('btn-ouvrir-effectifs')
    .addEventListener('click', () => formulaireEffectifsServices(chargerAgents));
  document.getElementById('btn-ouvrir-rattachement')
    .addEventListener('click', () => formulaireRattachement(chargerAgents));
  document.getElementById('btn-ouvrir-referentiel')
    .addEventListener('click', () => formulaireReferentiel(chargerAgents));
  document.getElementById('btn-ouvrir-nonref')
    .addEventListener('click', () => formulaireNonReferences(chargerAgents));
}

/* ------------------------------------------------- Ajout et modification */

async function formulaireAgent(agent, services) {
  const zone = document.getElementById('zone-formulaire');
  const creation = !agent;

  // Le referentiel fait foi : on affecte l'agent a une direction reconnue,
  // pas a un texte libre qui creerait une graphie de plus au classement.
  // Sans referentiel, on retombe sur la saisie libre aidee des services en usage.
  let referentiel = [];
  try { referentiel = (await api('/api/admin/referentiel')).services.map((s) => s.nom); } catch { /* saisie libre */ }
  const actuel = creation ? '' : agent.service;

  // De quel service d'annuaire la direction affichee decoule : sans cette
  // ligne, on ne sait pas si la direction proposee vient de l'annuaire ou
  // d'une decision anterieure, et on la rechange a l'aveugle.
  const rattachement = creation ? '' : agent.service_force
    ? '<br>Rattachement fait à la main : la synchronisation avec l’annuaire ne le défait plus.'
    : agent.service_ad && agent.service_ad !== agent.service
      ? `<br>Service lu dans l’annuaire : <strong>${echapper(agent.service_ad)}</strong>, rattaché à cette direction.`
      : '<br>Direction lue directement dans l’annuaire.';
  const choix = referentiel.length
    ? [...(actuel && !referentiel.includes(actuel) ? [actuel] : []), ...referentiel]
    : [];
  const champService = choix.length
    ? `<select id="a-service">
        ${creation ? '<option value="">— Choisir une direction —</option>' : ''}
        ${choix.map((s) => `<option value="${echapper(s)}"${s === actuel ? ' selected' : ''}>${echapper(s)}${
          s === actuel && !referentiel.includes(s) ? ' (hors référentiel)' : ''}</option>`).join('')}
      </select>
      <p class="discret" style="margin:.3rem 0 0;font-size:.8rem">Directions du référentiel. Ce choix résiste aux synchronisations avec l'annuaire.${rattachement}</p>`
    : `<input type="text" id="a-service" list="liste-services" value="${echapper(actuel)}" placeholder="Etat civil">
      <datalist id="liste-services">${services.map((s) => `<option value="${echapper(s.service)}">`).join('')}</datalist>
      <p class="discret" style="margin:.3rem 0 0;font-size:.8rem">Le référentiel est vide : saisie libre.${rattachement}</p>`;

  zone.innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--vert-clair)">
      <h2>${creation ? 'Ajouter un agent' : `Modifier « ${echapper(agent.nom_complet)} »`}</h2>

      <div class="grille grille-2">
        <div class="champ-admin">
          <label for="a-login">Identifiant Active Directory</label>
          <input type="text" id="a-login" value="${creation ? '' : echapper(agent.login)}" ${creation ? '' : 'disabled'}
                 placeholder="p.dupont" autocapitalize="none" spellcheck="false">
          ${creation
            ? '<p class="discret" style="margin:.3rem 0 0;font-size:.8rem">Doit correspondre exactement au sAMAccountName de l\'annuaire.</p>'
            : '<p class="discret" style="margin:.3rem 0 0;font-size:.8rem">Non modifiable : c\'est la clé de rapprochement avec l\'annuaire.</p>'}
        </div>
        <div class="champ-admin">
          <label for="a-nom">Nom affiché</label>
          <input type="text" id="a-nom" value="${creation ? '' : echapper(agent.nom_complet)}" placeholder="Paul DUPONT">
        </div>
        <div class="champ-admin">
          <label for="a-email">Adresse mail</label>
          <input type="email" id="a-email" value="${creation || !agent.email ? '' : echapper(agent.email)}" placeholder="p.dupont@chatillon92.fr">
          <p class="discret" style="margin:.3rem 0 0;font-size:.8rem">Sans adresse, l'agent ne recevra aucune relance.</p>
        </div>
        <div class="champ-admin">
          <label for="a-service">Direction</label>
          ${champService}
        </div>
      </div>

      ${creation ? '' : `
        <fieldset style="border:1px solid var(--bordure);border-radius:var(--rayon-sm);padding:1rem;margin-bottom:1rem">
          <legend class="ui" style="font-weight:700;font-size:.88rem;padding:0 .4rem">Statut</legend>
          <label style="display:flex;gap:.6rem;align-items:flex-start;font-weight:400;margin-bottom:.8rem">
            <input type="checkbox" id="a-exclu" ${agent.exclu ? 'checked' : ''} style="width:20px;height:20px;flex:0 0 auto;accent-color:var(--vert-fonce)">
            <span><strong>Exclure de la campagne</strong><br>
            <span class="discret">L'agent ne peut plus se connecter, n'est plus compté dans les effectifs ni relancé. Ses résultats sont conservés.</span></span>
          </label>
          <label style="display:flex;gap:.6rem;align-items:flex-start;font-weight:400">
            <input type="checkbox" id="a-anonyme" ${agent.anonyme ? 'checked' : ''} style="width:20px;height:20px;flex:0 0 auto;accent-color:var(--vert-fonce)">
            <span><strong>Masquer du classement individuel</strong><br>
            <span class="discret">Droit d'opposition : l'agent apparaît comme « Agent anonyme » mais continue d'alimenter le score de son service.</span></span>
          </label>
        </fieldset>`}

      <div class="champ-admin">
        <label for="a-note">Note interne (facultatif)</label>
        <input type="text" id="a-note" value="${creation || !agent.note ? '' : echapper(agent.note)}" placeholder="Agent sans poste informatique, congé longue durée…">
      </div>

      <div class="rang">
        <button class="btn btn-principal" id="btn-enregistrer-agent">${creation ? 'Ajouter' : 'Enregistrer'}</button>
        <button class="btn btn-secondaire" id="btn-annuler-agent">Annuler</button>
      </div>
    </div>`;

  amener(zone);
  document.getElementById(creation ? 'a-login' : 'a-nom').focus();
  document.getElementById('btn-annuler-agent').addEventListener('click', () => { zone.innerHTML = ''; });

  const boutonEnregistrer = document.getElementById('btn-enregistrer-agent');
  boutonEnregistrer.addEventListener('click', () => pendant(boutonEnregistrer, 'Enregistrement…', async () => {
    const corps = {
      nom_complet: document.getElementById('a-nom').value,
      email: document.getElementById('a-email').value,
      service: document.getElementById('a-service').value,
      note: document.getElementById('a-note').value,
    };

    try {
      let r;
      if (creation) {
        corps.login = document.getElementById('a-login').value;
        r = await api('/api/admin/agents', { method: 'POST', body: corps });
      } else {
        corps.exclu = document.getElementById('a-exclu').checked;
        corps.anonyme = document.getElementById('a-anonyme').checked;
        r = await api(`/api/admin/agents/${agent.id}`, { method: 'PATCH', body: corps });
      }
      alerte('alerte', r.message, 'succes');
      zone.innerHTML = '';
      await chargerAgents();
    } catch (e) { alerte('alerte', e.message); }
  }));
}

/* --------------------------------------------------------- Suppression */

async function supprimer(agent) {
  if (!confirm(`Supprimer « ${agent.nom_complet} » ?`)) return;
  try {
    const r = await api(`/api/admin/agents/${agent.id}`, { method: 'DELETE' });
    alerte('alerte', r.message, 'succes');
    chargerAgents();
  } catch (e) {
    // Le serveur refuse tant que la perte des resultats n'est pas confirmee.
    // Il le dit par un code ; la lecture du message reste en repli, le temps
    // que toutes les instances servent une version qui l'envoie.
    if (e.code === 'CONFIRMATION_REQUISE' || /défi\(s\)/.test(e.message)) {
      if (!confirm(`${e.message}\n\nConfirmer la suppression définitive ?`)) return;
      try {
        const r = await api(`/api/admin/agents/${agent.id}`, {
          method: 'DELETE', body: { confirmerPerteResultats: true },
        });
        alerte('alerte', r.message, 'succes');
        chargerAgents();
      } catch (e2) { alerte('alerte', e2.message); }
    } else alerte('alerte', e.message);
  }
}

/* -------------------------------------------------------------- Import */

function formulaireImport() {
  const zone = document.getElementById('zone-formulaire');
  dernierImport = null;

  zone.innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--vert-clair)">
      <h2>Importer un export d'annuaire</h2>

      <details class="aide-admin" style="margin-bottom:1.2rem">
        <summary>Comment produire le fichier depuis l'Active Directory</summary>
        <p>Sur un contrôleur de domaine ou un poste doté des outils RSAT, en PowerShell :</p>
        <code class="bloc">Get-ADUser -Filter "Enabled -eq 'True'" -SearchBase "OU=Utilisateurs,OU=CHATILLON,DC=chatillon,DC=lan" -Properties DisplayName, Mail, Department | Select-Object SamAccountName, DisplayName, Mail, Department, DistinguishedName | Export-Csv -Path C:\\temp\\agents.csv -NoTypeInformation -Encoding UTF8 -Delimiter ";"</code>
        <p style="margin-top:.8rem">Ouvrez ensuite le fichier dans Excel pour retirer les comptes
        de service, les boîtes partagées et les comptes génériques, puis enregistrez-le.
        Les colonnes reconnues sont, quelle que soit leur casse ou leurs accents :</p>
        <p><strong>identifiant</strong> (login, sAMAccountName, identifiant) — obligatoire ·
        <strong>nom</strong> (DisplayName, ou Prénom + Nom séparés) ·
        <strong>adresse</strong> (mail, email, courriel) ·
        <strong>service</strong> (service, department, direction) ·
        <strong>DN</strong> (DistinguishedName) — utilisé pour déduire le service si aucune colonne service.</p>
        <p>Séparateur point-virgule, virgule ou tabulation : détecté automatiquement.
        Encodage UTF-8 ou Windows-1252 : détecté également.</p>
      </details>

      <div class="champ-admin">
        <label for="fichier-import">Fichier CSV</label>
        <input type="file" id="fichier-import" accept=".csv,.txt,text/csv,text/plain">
      </div>

      <p class="discret" style="margin-top:-.3rem">Ou collez directement le contenu :</p>
      <div class="champ-admin">
        <label for="colle-import" class="sr-only">Contenu du fichier</label>
        <textarea id="colle-import" style="min-height:110px;font-family:monospace;font-size:.82rem" placeholder="login;nom_complet;email;service&#10;p.dupont;Paul DUPONT;p.dupont@chatillon92.fr;Etat civil"></textarea>
      </div>

      <div class="rang">
        <button class="btn btn-principal" id="btn-analyser">Analyser le fichier</button>
        <button class="btn btn-secondaire" id="btn-annuler-import">Annuler</button>
      </div>

      <div id="apercu-import" style="margin-top:1.5rem"></div>
    </div>`;

  amener(zone);
  document.getElementById('btn-annuler-import').addEventListener('click', () => { zone.innerHTML = ''; });

  document.getElementById('fichier-import').addEventListener('change', async (e) => {
    const fichier = e.target.files?.[0];
    if (!fichier) return;
    const { texte, encodage } = await lireFichier(fichier);
    document.getElementById('colle-import').value = texte;
    alerte('alerte', `Fichier « ${fichier.name} » chargé (${encodage}, ${Math.round(fichier.size / 1024)} Ko). Cliquez sur « Analyser ».`, 'info');
  });

  document.getElementById('btn-analyser').addEventListener('click', analyser);
}

async function analyser() {
  const contenu = document.getElementById('colle-import').value;
  const apercu = document.getElementById('apercu-import');
  if (!contenu.trim()) return alerte('alerte', 'Sélectionnez un fichier ou collez son contenu.');

  apercu.innerHTML = '<p class="discret">Analyse en cours…</p>';
  let d;
  try {
    d = await api('/api/admin/agents/import/analyse', { method: 'POST', body: { contenu } });
  } catch (e) {
    apercu.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }

  dernierImport = contenu;
  const c = d.confrontation;

  apercu.innerHTML = `
    <h3>Ce que l'import va faire</h3>
    <div class="grille grille-3" style="margin-bottom:1.2rem">
      <div class="stat-admin"><div class="v">${c.nouveaux}</div><div class="l">agents ajoutés</div></div>
      <div class="stat-admin"><div class="v">${c.misAJour}</div><div class="l">fiches mises à jour</div></div>
      <div class="stat-admin"><div class="v">${d.resume.services}</div><div class="l">services identifiés</div></div>
      <div class="stat-admin"><div class="v">${d.resume.rejetees}</div><div class="l">lignes rejetées</div></div>
      <div class="stat-admin"><div class="v">${d.resume.sansEmail}</div><div class="l">sans adresse mail</div></div>
      <div class="stat-admin"><div class="v">${c.nbAbsents}</div><div class="l">en base, absents du fichier</div></div>
    </div>

    <p class="discret">Colonnes reconnues :
      ${Object.entries(d.colonnesReconnues).map(([champ, entete]) => `<strong>${echapper(champ)}</strong> ← « ${echapper(entete)} »`).join(' · ')}
      ${d.separateur === '\t' ? ' · séparateur : tabulation' : ` · séparateur : « ${echapper(d.separateur)} »`}
    </p>

    ${d.resume.sansService ? `<div class="message message-alerte" style="margin:1rem 0">
      ${d.resume.sansService} agent(s) sans service identifiable seront rattachés à « Non rattaché ».
      Vérifiez la colonne service de votre fichier.</div>` : ''}

    ${d.rejets.length ? `
      <details style="margin:1rem 0">
        <summary class="ui" style="cursor:pointer;font-weight:700;color:var(--erreur)">${d.resume.rejetees} ligne(s) rejetée(s)</summary>
        <ul class="ui" style="font-size:.85rem">${d.rejets.map((r) => `<li>Ligne ${r.numero} : ${echapper(r.motif)}</li>`).join('')}</ul>
      </details>` : ''}

    ${c.nbChangementsService ? `
      <details style="margin:1rem 0">
        <summary class="ui" style="cursor:pointer;font-weight:700">${c.nbChangementsService} changement(s) de service</summary>
        <ul class="ui" style="font-size:.85rem">${c.changementsService.map((x) => `<li>${echapper(x.login)} : ${echapper(x.avant)} → <strong>${echapper(x.apres)}</strong></li>`).join('')}</ul>
      </details>` : ''}

    ${c.nbAbsents ? `
      <details style="margin:1rem 0">
        <summary class="ui" style="cursor:pointer;font-weight:700">${c.nbAbsents} agent(s) en base mais absent(s) du fichier</summary>
        <ul class="ui" style="font-size:.85rem">${c.absents.map((a) => `<li>${echapper(a.nom)} (${echapper(a.login)}) — ${echapper(a.service)}</li>`).join('')}</ul>
      </details>` : ''}

    <h3 style="margin-top:1.5rem">Aperçu des ${Math.min(d.agents.length, 50)} premières lignes</h3>
    <div class="tableau-defilant" style="max-height:320px;overflow-y:auto"><table class="admin">
      <caption class="sr-only">Aperçu des lignes lues dans le fichier</caption>
      <thead><tr><th scope="col">Identifiant</th><th scope="col">Nom</th><th scope="col">Adresse</th>
        <th scope="col">Service</th><th scope="col">Remarques</th></tr></thead>
      <tbody>${d.agents.map((a) => `
        <tr>
          <td>${echapper(a.login)}</td><td>${echapper(a.nomComplet)}</td>
          <td>${a.email ? echapper(a.email) : '<span class="discret">—</span>'}</td>
          <td>${echapper(a.service)}</td>
          <td class="discret" style="font-size:.8rem">${echapper(a.avertissements.join(' · '))}</td>
        </tr>`).join('')}</tbody>
    </table></div>

    ${c.nbAbsents ? `
      <label style="display:flex;gap:.6rem;align-items:flex-start;font-weight:400;margin:1.2rem 0">
        <input type="checkbox" id="exclure-absents" style="width:20px;height:20px;flex:0 0 auto;accent-color:var(--vert-fonce)">
        <span><strong>Exclure les ${c.nbAbsents} agent(s) absents du fichier</strong><br>
        <span class="discret">Utile si ce fichier fait référence : les départs sont écartés de la campagne.
        Leurs résultats sont conservés, ils ne sont pas supprimés.</span></span>
      </label>` : ''}

    <div class="rang" style="margin-top:1.2rem;border-top:1px solid var(--bordure);padding-top:1.2rem">
      <button class="btn btn-principal" id="btn-confirmer-import">Lancer l'import de ${d.resume.retenues} agent(s)</button>
      <span class="discret ui">Rien n'a encore été enregistré.</span>
    </div>`;

  document.getElementById('btn-confirmer-import').addEventListener('click', async () => {
    const bouton = document.getElementById('btn-confirmer-import');
    bouton.disabled = true;
    bouton.textContent = 'Import en cours…';
    try {
      const r = await api('/api/admin/agents/import', {
        method: 'POST',
        body: { contenu: dernierImport, exclureAbsents: document.getElementById('exclure-absents')?.checked },
      });
      alerte('alerte', r.message, 'succes');
      document.getElementById('zone-formulaire').innerHTML = '';
      chargerAgents();
      remonter();
    } catch (e) {
      alerte('alerte', e.message);
      bouton.disabled = false;
      bouton.textContent = 'Relancer l\'import';
    }
  });
}

/* ------------------------------------------- Regroupement des services */

async function formulaireServices(filtreInitial = '') {
  const zone = document.getElementById('zone-formulaire');
  zone.innerHTML = '<p class="discret">Analyse des services…</p>';

  let d;
  try {
    d = await api('/api/admin/services');
  } catch (e) {
    zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }

  // Le referentiel fait foi : c'est la liste des services que la collectivite
  // reconnait, et le regroupement ne fait que pointer dessus. Y ajouter les
  // libelles bruts de l'annuaire rendait la liste inutilisable - on y
  // retrouvait « Action culturelle » et « Action Culturelle », c'est-a-dire
  // exactement ce que le regroupement doit supprimer.
  const referentiel = [...(d.referentiel || [])].sort((a, b) => a.localeCompare(b, 'fr'));

  // Sans referentiel, on se rabat sur ce qui existe : mieux vaut une liste
  // imparfaite que pas de liste du tout.
  const secours = [...new Set([
    ...d.inventaire.map((i) => i.cible),
    ...d.inventaire.map((i) => i.proposition).filter(Boolean),
  ])].sort((a, b) => a.localeCompare(b, 'fr'));

  const noms = referentiel.length ? referentiel : secours;

  const option = (n, valeur) =>
    `<option value="${echapper(n)}"${n === valeur ? ' selected' : ''}>${echapper(n)}</option>`;

  /**
   * La valeur courante d'une ligne peut precéder le referentiel. La masquer
   * changerait silencieusement le regroupement en vigueur : on la garde, a
   * part, pour qu'elle se voie et se corrige.
   */
  const listeOptions = (valeur) => {
    const dedans = noms.map((n) => option(n, valeur)).join('');
    if (!valeur || noms.includes(valeur)) return dedans;
    return `<optgroup label="Hors référentiel">${option(valeur, valeur)}</optgroup>`
      + `<optgroup label="Référentiel">${dedans}</optgroup>`;
  };

  const avecProposition = d.inventaire.filter((i) => !i.regroupe && i.proposition).length;
  // Ce qui reste a faire : un libellé dont la cible n'est pas au referentiel
  // parait au classement sous un nom que la collectivite ne reconnait pas.
  const aClasser = d.inventaire.filter((i) => !i.referencee).length;

  zone.innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--vert-clair)">
      <h2>Renommer et regrouper les services</h2>

      <details class="aide-admin" style="margin-bottom:1.2rem">
        <summary>À quoi ça sert</summary>
        <p>Ce tableau associe chaque libellé lu dans l'annuaire au nom affiché dans la campagne.
        Il sert à deux choses.</p>
        <p><strong>Renommer.</strong> Un annuaire contient des libellés écrits pour l'informatique,
        pas pour être affichés : « LUDO-MEDIATHEQUE », « zzGVE », « CTM ». Vous saisissez le nom
        présentable, le libellé d'origine reste visible ici et sous chaque agent.</p>
        <p><strong>Regrouper.</strong> « Crèche La Cigogne », « Crèche Petit Poucet » et
        « Crèche Sablons » sont trois libellés distincts qui ne forment qu'un service.
        Pointez-les vers le même nom et ils fusionnent au classement.</p>
        <p>Le regroupement s'applique <strong>partout et durablement</strong> : à l'import comme à la
        connexion d'un agent. C'est pourquoi il vaut mieux que trier le fichier à la main — un tri Excel
        serait contourné dès qu'un agent se connecte, puisque sa fiche est alors créée depuis son DN.</p>
        <p>Le libellé d'origine est conservé : vous pouvez modifier un regroupement à tout moment,
        le classement se recalcule sans qu'il faille réimporter quoi que ce soit.</p>
      </details>

      <div class="rang" style="margin-bottom:1rem">
        <button class="btn btn-principal" id="btn-suggerer"
                style="padding:.45rem .9rem;font-size:.85rem">Proposer un rapprochement</button>
        ${avecProposition ? `
          <button class="btn btn-secondaire" id="btn-appliquer-propositions"
                  style="padding:.45rem .9rem;font-size:.85rem">
            Regrouper les familles (${avecProposition})
          </button>` : ''}
        <span class="discret ui" id="etat-suggestions"></span>
      </div>

      <div class="rang" role="group" aria-label="Filtrer par état" style="margin-bottom:.9rem">
        ${[['tous', `Tous (${d.inventaire.length})`],
           ['aclasser', `À classer (${aClasser})`],
           ['references', `Au référentiel (${d.inventaire.length - aClasser})`]].map(([cle, libelle]) => `
          <button type="button" class="btn btn-secondaire" data-etat-libelle="${cle}"
                  style="padding:.35rem .9rem;font-size:.85rem">${libelle}</button>`).join('')}
      </div>

      <div id="resultat-suggestions"></div>

      <div class="barre-filtres" style="margin-bottom:.8rem">
        <div class="champ-admin" style="flex:1;min-width:220px">
          <label for="rech-regroupement">Filtrer les libellés</label>
          <input type="search" id="rech-regroupement" value="${echapper(filtreInitial)}"
                 placeholder="Centre de Loisirs, Crêche, Elus…">
        </div>
        <button type="button" class="btn btn-secondaire" id="btn-cocher-visibles" style="padding:.55rem 1rem">
          Cocher les lignes affichées
        </button>
        <button type="button" class="btn btn-secondaire" id="btn-decocher-tout" style="padding:.55rem 1rem">
          Tout décocher
        </button>
      </div>

      <div id="barre-affectation" hidden class="message message-info" style="margin-bottom:.8rem">
        <div class="barre-filtres">
          <div class="champ-admin" style="flex:1;min-width:260px">
            <label for="nom-groupe"><span id="nb-lignes-cochees"></span> — nom à leur donner</label>
            <select id="nom-groupe">
              <option value="">Choisir un service…</option>
              ${listeOptions(null)}
              <option value="__nouveau__">＋ Créer un service…</option>
            </select>
          </div>
          <button type="button" class="btn btn-principal" id="btn-affecter" style="padding:.55rem 1rem">
            Appliquer à ces lignes
          </button>
        </div>
      </div>

      <div class="tableau-defilant"><table class="admin" id="table-regroupement">
        <caption class="sr-only">Libellés d'annuaire et nom affiché dans la campagne</caption>
        <thead><tr>
          <th scope="col" style="width:32px"><span class="sr-only">Sélection</span></th>
          <th scope="col">Libellé dans l'annuaire</th>
          <th scope="col" class="num">Agents</th>
          <th scope="col">Nom affiché dans la campagne</th>
        </tr></thead>
        <tbody>${d.inventaire.map((i) => `
          <tr data-libelle="${echapper(i.source.toLowerCase())}"
              style="border-left:4px solid ${i.referencee ? 'var(--succes)' : 'var(--alerte)'}${i.regroupe ? ';background:var(--vert-clair-fond)' : ''}">
            <td><input type="checkbox" class="case-regroupement"
                       aria-label="Sélectionner ${echapper(i.source)}"
                       style="width:18px;height:18px;accent-color:var(--vert-fonce)"></td>
            <td>
              <strong>${echapper(i.source)}</strong>
              ${i.referencee
                ? '<br><span class="pastille-etat etat-ok" style="font-size:.68rem">au référentiel</span>'
                : '<br><span class="pastille-etat" style="font-size:.68rem;background:var(--alerte-fond);color:var(--alerte)">à classer</span>'}
            </td>
            <td class="num">
              <button type="button" class="lien-service" data-voir-libelle="${echapper(i.source)}"
                      title="Voir les agents de ce libellé">${i.effectif}</button>
            </td>
            <td>
              <div class="rang" style="flex-wrap:nowrap;gap:.4rem">
                <select class="cible-service" data-source="${echapper(i.source)}"
                        data-proposition="${echapper(i.proposition || '')}"
                        aria-label="Nom affiché pour ${echapper(i.source)}"
                        style="min-width:200px">
                  ${listeOptions(i.cible)}
                  <option value="__nouveau__">＋ Créer un service…</option>
                </select>
                <button type="button" class="btn btn-secondaire" data-annuler
                        title="Revenir au libellé de l'annuaire"
                        aria-label="Annuler le regroupement de ${echapper(i.source)}"
                        style="padding:.4rem .7rem;font-size:.9rem;flex:0 0 auto">↺</button>
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>

      <div class="rang" style="margin-top:1.2rem;border-top:1px solid var(--bordure);padding-top:1.2rem">
        <button class="btn btn-principal" id="btn-enregistrer-services">Enregistrer et recalculer</button>
        <button class="btn btn-secondaire" id="btn-fermer-services">Fermer</button>
        <span class="discret ui" id="apercu-regroupement"></span>
      </div>
    </div>`;

  amener(zone);

  const champs = () => [...zone.querySelectorAll('.cible-service')];

  const majApercu = () => {
    const distincts = new Set(champs().map((c) => c.value.trim()).filter(Boolean));
    const regroupes = champs().filter((c) => c.value.trim() && c.value.trim() !== c.dataset.source).length;
    document.getElementById('apercu-regroupement').textContent =
      `${d.inventaire.length} libellés → ${distincts.size} service(s) au classement`
      + ` · ${regroupes} ligne(s) modifiée(s)`;

    // Une ligne modifiee se repere sans avoir a comparer les deux colonnes
    for (const c of champs()) {
      const modifie = c.value.trim() && c.value.trim() !== c.dataset.source;
      c.closest('tr').style.background = modifie ? 'var(--vert-clair-fond)' : '';
    }
  };
  majApercu();
  zone.addEventListener('input', (e) => { if (e.target.matches('.cible-service')) majApercu(); });

  /**
   * Creation d'un service : le nom est ajoute a TOUTES les listes deroulantes,
   * sinon il ne serait choisissable que sur la ligne ou il a ete cree.
   */
  const tousLesSelecteurs = () => [
    ...zone.querySelectorAll('.cible-service'),
    ...[document.getElementById('nom-groupe')].filter(Boolean),
  ];

  function ajouterNom(nom) {
    for (const sel of tousLesSelecteurs()) {
      if ([...sel.options].some((o) => o.value === nom)) continue;
      const option = new Option(nom, nom);
      // Toujours avant l'entree « Créer un service… », qui reste en dernier
      sel.add(option, sel.querySelector('option[value="__nouveau__"]'));
    }
  }

  function demanderNom(selecteur) {
    const nom = (prompt('Nom du nouveau service :') || '').trim();
    if (!nom) {
      selecteur.value = selecteur.dataset.source ?? '';
      return null;
    }
    ajouterNom(nom);
    selecteur.value = nom;
    return nom;
  }

  zone.addEventListener('change', (e) => {
    if (!e.target.matches('.cible-service, #nom-groupe')) return;
    if (e.target.value === '__nouveau__') demanderNom(e.target);
    if (e.target.matches('.cible-service')) majApercu();
  });

  // Un filtre d'etat, en complement de la recherche : sur quatre-vingt-dix-huit
  // libellés, ce qui compte est de ne plus voir ceux qui sont deja regles.
  zone.addEventListener('click', (e) => {
    const bouton = e.target.closest('[data-etat-libelle]');
    if (!bouton) return;
    const etat = bouton.dataset.etatLibelle;

    zone.querySelectorAll('[data-etat-libelle]').forEach((b) => {
      const actif = b.dataset.etatLibelle === etat;
      b.classList.toggle('btn-principal', actif);
      b.classList.toggle('btn-secondaire', !actif);
    });

    d.inventaire.forEach((i, rang) => {
      const ligne = zone.querySelectorAll('#table-regroupement tbody tr')[rang];
      if (!ligne) return;
      ligne.hidden = etat === 'aclasser' ? i.referencee
        : etat === 'references' ? !i.referencee
          : false;
    });
  });

  // « Accueil - 14 agents » : la question suivante est toujours « lesquels ? ».
  zone.addEventListener('click', (e) => {
    const voir = e.target.closest('[data-voir-libelle]');
    if (voir) agentsDuLibelle(voir.dataset.voirLibelle);
  });

  // Refuser une proposition ne doit pas obliger a retrouver le libellé d'origine
  zone.addEventListener('click', (e) => {
    if (!e.target.matches('[data-annuler]')) return;
    const champ = e.target.closest('.rang').querySelector('.cible-service');
    ajouterNom(champ.dataset.source);
    champ.value = champ.dataset.source;
    majApercu();
  });

  /* ---- Affectation groupee : donner le meme nom a plusieurs libelles ---- */

  const lignes = () => [...zone.querySelectorAll('#table-regroupement tbody tr')];
  const cochees = () => lignes().filter((l) => l.querySelector('.case-regroupement').checked);

  const majSelection = () => {
    const n = cochees().length;
    document.getElementById('barre-affectation').hidden = n === 0;
    document.getElementById('nb-lignes-cochees').textContent =
      `${n} libellé${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}`;
  };

  zone.addEventListener('change', (e) => {
    if (e.target.matches('.case-regroupement')) majSelection();
  });

  const filtrer = () => {
    const q = document.getElementById('rech-regroupement').value.trim().toLowerCase();
    for (const l of lignes()) l.hidden = q ? !l.dataset.libelle.includes(q) : false;
  };

  let minuteurRegroupement;
  document.getElementById('rech-regroupement').addEventListener('input', () => {
    clearTimeout(minuteurRegroupement);
    minuteurRegroupement = setTimeout(filtrer, 200);
  });
  // Ouverture depuis la liste des agents : le filtre est deja rempli
  filtrer();

  document.getElementById('btn-cocher-visibles').addEventListener('click', () => {
    for (const l of lignes()) {
      if (!l.hidden) l.querySelector('.case-regroupement').checked = true;
    }
    majSelection();
  });

  document.getElementById('btn-decocher-tout').addEventListener('click', () => {
    for (const l of lignes()) l.querySelector('.case-regroupement').checked = false;
    majSelection();
  });

  document.getElementById('btn-affecter').addEventListener('click', () => {
    const nom = document.getElementById('nom-groupe').value.trim();
    if (!nom || nom === '__nouveau__') {
      return alerte('alerte', 'Choisissez un service, ou créez-en un.');
    }
    ajouterNom(nom);

    for (const l of cochees()) {
      l.querySelector('.cible-service').value = nom;
      l.querySelector('.case-regroupement').checked = false;
    }
    document.getElementById('nom-groupe').value = '';
    majSelection();
    majApercu();
    alerte('alerte', `« ${nom} » appliqué. Vérifiez le tableau, puis enregistrez.`, 'succes');
  });

  /**
   * Rapprochement avec le referentiel : on remplit d'office ce qui est sur,
   * on montre le reste sans y toucher. Une suggestion fausse presentee comme
   * sure coute plus cher que pas de suggestion du tout.
   */
  document.getElementById('btn-suggerer').addEventListener('click', async () => {
    const bouton = document.getElementById('btn-suggerer');
    const zoneResultat = document.getElementById('resultat-suggestions');
    bouton.disabled = true;
    bouton.textContent = 'Analyse…';

    let r;
    try {
      r = await api('/api/admin/referentiel/suggestions');
    } catch (e) {
      alerte('alerte', e.message);
      bouton.disabled = false;
      bouton.textContent = 'Proposer un rapprochement';
      return;
    }

    bouton.disabled = false;
    bouton.textContent = 'Proposer un rapprochement';

    if (!r.referentiel.length) {
      zoneResultat.innerHTML = `
        <div class="message message-alerte">
          Le référentiel est vide. Renseignez-le d'abord dans « Référentiel des services » :
          c'est lui qui sert de cible au rapprochement.
        </div>`;
      return;
    }

    const parLibelle = new Map(r.suggestions.map((s) => [s.libelle, s]));
    const appliquer = (niveaux) => {
      let n = 0;
      for (const c of champs()) {
        const s = parLibelle.get(c.dataset.source);
        if (!s || !s.proposition || !niveaux.includes(s.confiance)) continue;
        if (![...c.options].some((o) => o.value === s.proposition)) ajouterNom(s.proposition);
        c.value = s.proposition;
        n++;
      }
      majApercu();
      return n;
    };

    const n = appliquer(['sure']);
    document.getElementById('etat-suggestions').textContent =
      `${n} libellé(s) rapproché(s) avec certitude`;

    const aVerifier = r.suggestions.filter((s) => ['probable', 'incertaine'].includes(s.confiance));
    const sans = r.suggestions.filter((s) => s.confiance === 'aucune');

    zoneResultat.innerHTML = `
      <div class="message message-info" style="margin-bottom:1rem">
        <p style="margin:0 0 .5rem">
          <strong>${r.resume.sure} libellé(s) rapproché(s)</strong> — ${r.resume.agentsSurs} agents.
          Ils sont déjà renseignés dans le tableau, vérifiez-les avant d'enregistrer.
        </p>

        ${aVerifier.length ? `
          <details style="margin-top:.6rem">
            <summary class="ui" style="cursor:pointer;font-weight:700">
              ${aVerifier.length} rapprochement(s) à confirmer
            </summary>
            <p class="discret" style="font-size:.84rem;margin:.4rem 0">
              Non appliqués : le doute est réel. Cochez ceux qui vous conviennent.
            </p>
            <ul class="ui" style="font-size:.84rem;list-style:none;padding:0">
              ${aVerifier.map((s) => `
                <li style="padding:.2rem 0">
                  <label style="display:flex;gap:.5rem;align-items:baseline;font-weight:400">
                    <input type="checkbox" class="case-suggestion"
                           data-libelle="${echapper(s.libelle)}" data-cible="${echapper(s.proposition)}"
                           style="width:16px;height:16px;accent-color:var(--vert-fonce)">
                    <span>${echapper(s.libelle)} <span class="discret">(${s.effectif})</span>
                      → <strong>${echapper(s.proposition)}</strong>
                      <span class="discret">— ${echapper(s.motif || '')}</span></span>
                  </label>
                </li>`).join('')}
            </ul>
            <button type="button" class="btn btn-secondaire" id="btn-appliquer-suggestions"
                    style="padding:.35rem .8rem;font-size:.82rem">Appliquer les rapprochements cochés</button>
          </details>` : ''}

        ${sans.length ? `
          <details style="margin-top:.6rem">
            <summary class="ui" style="cursor:pointer;font-weight:700">
              ${sans.length} libellé(s) sans correspondance
            </summary>
            <p class="discret" style="font-size:.84rem;margin:.4rem 0">
              Aucun service du référentiel ne leur ressemble. À traiter à la main, ou à
              ajouter au référentiel s'il en manque.
            </p>
            <ul class="ui" style="font-size:.84rem;columns:2">
              ${sans.slice(0, 60).map((s) => `<li>${echapper(s.libelle)} <span class="discret">(${s.effectif})</span></li>`).join('')}
            </ul>
          </details>` : ''}
      </div>`;

    document.getElementById('btn-appliquer-suggestions')?.addEventListener('click', () => {
      const choisies = [...zoneResultat.querySelectorAll('.case-suggestion:checked')];
      for (const c of choisies) {
        const champ = champs().find((x) => x.dataset.source === c.dataset.libelle);
        if (!champ) continue;
        ajouterNom(c.dataset.cible);
        champ.value = c.dataset.cible;
      }
      majApercu();
      alerte('alerte', `${choisies.length} rapprochement(s) reporté(s) dans le tableau.`, 'succes');
    });
  });

  document.getElementById('btn-appliquer-propositions')?.addEventListener('click', () => {
    for (const c of champs()) {
      if (!c.dataset.proposition) continue;
      ajouterNom(c.dataset.proposition);
      c.value = c.dataset.proposition;
    }
    majApercu();
    alerte('alerte', 'Propositions reportées dans le tableau. Vérifiez, ajustez, puis enregistrez.', 'info');
  });

  document.getElementById('btn-fermer-services').addEventListener('click', () => { zone.innerHTML = ''; });

  document.getElementById('btn-enregistrer-services').addEventListener('click', async () => {
    const regles = champs()
      .map((c) => ({ source: c.dataset.source, cible: c.value.trim() }))
      .filter((r) => r.cible && r.cible !== r.source);

    try {
      const r = await api('/api/admin/services/regroupements', { method: 'POST', body: { regles } });
      alerte('alerte', r.message, 'succes');
      zone.innerHTML = '';
      chargerAgents();
      remonter();
    } catch (e) { alerte('alerte', e.message); }
  });
}

/**
 * Ouvre la liste des agents deja filtree.
 *
 * Les tuiles du tableau de bord donnent un chiffre ; la question qui suit est
 * toujours « lesquels ? ». Ce point d'entree evite de refaire a la main le
 * filtre que la tuile designe deja.
 */
export function filtrerAgents(etat, service = '') {
  etatFiltres = { recherche: '', service, etat, page: 1, parPage: etatFiltres.parPage };
  return chargerAgents();
}

/**
 * Liste des agents portant un libellé d'annuaire.
 *
 * Devant « Accueil - 14 agents », la question suivante est toujours
 * « lesquels ? » : quatorze personnes derriere un mot aussi vague peuvent
 * relever de trois services differents. Sans cette liste, il fallait quitter
 * l'ecran, filtrer la liste des agents, puis revenir - et recommencer au
 * libelle suivant.
 *
 * On utilise <dialog>, qui apporte la fermeture par Echap, le retour du focus
 * et le fond inerte sans qu'on ait a les reecrire.
 */
async function agentsDuLibelle(libelle) {
  document.getElementById('modale-libelle')?.remove();

  const modale = document.createElement('dialog');
  modale.id = 'modale-libelle';
  // Sans nom accessible, la boite s'annonce « boîte de dialogue » et rien de
  // plus : on ne sait pas de quel libelle on consulte les agents. Son titre
  // fait office de nom.
  modale.setAttribute('aria-labelledby', 'titre-modale-libelle');
  modale.style.cssText = 'max-width:min(680px,92vw);width:100%;border:0;border-radius:var(--rayon);'
    + 'padding:0;box-shadow:0 12px 40px rgba(0,0,0,.22)';
  modale.innerHTML = `
    <div style="padding:1.4rem 1.6rem">
      <div class="rang" style="justify-content:space-between;align-items:flex-start;margin-bottom:.6rem">
        <h2 id="titre-modale-libelle" style="margin:0;font-size:1.15rem">${echapper(libelle)}</h2>
        <button type="button" class="btn btn-secondaire" data-fermer-modale
                style="padding:.3rem .7rem;font-size:.8rem">Fermer</button>
      </div>
      <p class="discret" id="corps-modale-libelle" style="margin:0">Chargement…</p>
    </div>`;
  document.body.appendChild(modale);
  modale.showModal();

  modale.addEventListener('click', (e) => {
    // Un clic sur le fond ferme : la cible est alors la boite de dialogue
    // elle-meme, jamais son contenu.
    if (e.target === modale || e.target.closest('[data-fermer-modale]')) modale.close();
  });
  modale.addEventListener('close', () => modale.remove());

  const corps = modale.querySelector('#corps-modale-libelle');
  try {
    const r = await api(`/api/admin/agents?libelle=${encodeURIComponent(libelle)}&parPage=200`);
    const agents = r.agents || [];
    const total = r.pagination?.total ?? agents.length;

    corps.outerHTML = agents.length ? `
      <p class="discret ui" style="margin:0 0 .5rem;font-size:.84rem">
        ${agents.length}${total > agents.length ? ` sur ${total}` : ''} agent(s) ·
        service actuel : <strong>${echapper(agents[0].service)}</strong>
      </p>
      <div class="tableau-defilant" style="max-height:52vh;overflow-y:auto">
        <table class="admin">
          <caption class="sr-only">Agents portant ce libellé d'annuaire</caption>
          <thead><tr><th scope="col">Agent</th><th scope="col">Adresse</th><th scope="col">Service</th></tr></thead>
          <tbody>${agents.map((a) => `
            <tr${a.exclu ? ' style="opacity:.55"' : ''}>
              <td><strong>${echapper(a.nom_complet)}</strong>
                <br><span class="discret" style="font-size:.8rem">${echapper(a.login)}</span></td>
              <td class="discret" style="font-size:.84rem">${echapper(a.email || '—')}</td>
              <td>${echapper(a.service)}${a.exclu ? ' <span class="discret">— exclu</span>' : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<p class="discret">Aucun agent pour ce libellé.</p>';
  } catch (e) {
    corps.outerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
  }
}
