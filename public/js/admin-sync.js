import { api, echapper, alerte } from '/js/commun.js';

/**
 * Sas de validation de la synchronisation annuaire.
 * Rien n'est ecrit tant que l'administrateur n'a pas valide : un annuaire de
 * collectivite contient elus, comptes de service et boites partagees, et le
 * service de chaque agent doit etre verifie avant d'alimenter un classement.
 */

let analyse = null;
let auTermine = () => {};

export async function formulaireSynchronisation(onTermine) {
  if (onTermine) auTermine = onTermine;
  const zone = document.getElementById('zone-formulaire');

  zone.innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--vert-clair)">
      <h2>Synchroniser depuis l'annuaire</h2>
      <p class="discret">Interrogation de l'Active Directory en cours…</p>
    </div>`;
  zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    analyse = await api('/api/admin/synchronisation/analyse', { method: 'POST' });
  } catch (e) {
    zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }
  rendre();
}

function rendre() {
  const d = analyse;
  const r = d.resume;

  document.getElementById('zone-formulaire').innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--vert-clair)">
      <h2>Synchroniser depuis l'annuaire</h2>
      <p class="discret" style="margin-top:-.3em">
        ${d.lus} compte(s) lu(s) sur ${echapper(d.source)} · service déduit de ${echapper(d.origineService)}.
        <strong>Rien n'est enregistré tant que vous n'avez pas validé.</strong>
      </p>

      <div class="grille grille-3" style="margin:1.2rem 0">
        <div class="stat-admin"><div class="v">${r.nouveaux}</div><div class="l">nouveaux comptes à valider</div></div>
        <div class="stat-admin"><div class="v">${r.modifies}</div><div class="l">fiches à mettre à jour</div></div>
        <div class="stat-admin"><div class="v">${r.desactives}</div><div class="l">désactivés dans l'annuaire</div></div>
        <div class="stat-admin"><div class="v">${r.disparus}</div><div class="l">absents de l'annuaire</div></div>
        <div class="stat-admin"><div class="v">${r.ecartes}</div><div class="l">écartés par vos règles</div></div>
        <div class="stat-admin"><div class="v">${r.sansAdresse}</div><div class="l">écartés faute d'adresse mail</div></div>
        <div class="stat-admin"><div class="v">${r.services}</div><div class="l">services concernés</div></div>
      </div>

      <details class="aide-admin">
        <summary>Règles d'exclusion — ce qui n'est jamais proposé</summary>
        <p>Un annuaire de collectivité contient bien plus que des agents : élus, comptes de
        service, boîtes partagées, prestataires. Ces règles les écartent à chaque
        synchronisation, sans avoir à les décocher de nouveau.</p>
        <div id="zone-exclusions"></div>
      </details>

      <h3 style="margin-top:1.5rem">1. Nouveaux comptes</h3>
      <p class="discret">
        Décochez ce qui n'a pas sa place dans la campagne. Vérifiez surtout le service :
        c'est lui qui pilote le classement, et il se corrige mal une fois la campagne lancée.
      </p>

      <div class="rang" style="margin:.8rem 0">
        <button class="btn btn-secondaire" style="padding:.3rem .8rem;font-size:.8rem" id="btn-tout-cocher">Tout cocher</button>
        <button class="btn btn-secondaire" style="padding:.3rem .8rem;font-size:.8rem" id="btn-tout-decocher">Tout décocher</button>
        <span class="discret ui" id="compteur-selection"></span>
      </div>

      <div style="max-height:460px;overflow-y:auto;border:1px solid var(--bordure);border-radius:var(--rayon-sm)">
        ${d.nouveauxParService.length ? d.nouveauxParService.map((s, i) => `
          <div style="border-bottom:1px solid var(--bordure)">
            <div style="display:flex;gap:.7rem;align-items:center;padding:.7rem .9rem;background:var(--vert-fonce-clair)">
              <input type="checkbox" class="case-service" data-service="${i}" checked
                     aria-label="Retenir le service ${echapper(s.service)}"
                     style="width:20px;height:20px;flex:0 0 auto;accent-color:var(--vert-fonce)">
              <span style="flex:1">
                <strong class="ui">${echapper(s.service)}</strong>
                <span class="discret"> — ${s.effectif} agent(s)${s.sansEmail ? `, dont ${s.sansEmail} sans adresse` : ''}</span>
              </span>
              <button type="button" class="btn btn-secondaire" style="padding:.2rem .6rem;font-size:.75rem"
                      data-deplier="${i}">Détail</button>
            </div>
            <div id="detail-${i}" hidden style="padding:.3rem .9rem .8rem 2.6rem">
              ${s.agents.map((a) => `
                <label style="display:flex;gap:.6rem;align-items:baseline;font-weight:400;padding:.15rem 0">
                  <input type="checkbox" class="case-agent-sync" data-service="${i}" value="${echapper(a.login)}" checked
                         style="width:16px;height:16px;flex:0 0 auto;accent-color:var(--vert-fonce)">
                  <span class="ui" style="font-size:.85rem">
                    ${echapper(a.nomComplet)} <span class="discret">(${echapper(a.login)})</span>
                    ${a.email ? '' : ' <span style="color:var(--alerte)">— sans adresse</span>'}
                    ${a.serviceAd !== s.service ? ` <span class="discret">· annuaire : ${echapper(a.serviceAd)}</span>` : ''}
                  </span>
                </label>`).join('')}
            </div>
          </div>`).join('')
        : '<p class="discret" style="padding:1rem">Aucun nouveau compte : l’effectif est à jour.</p>'}
      </div>

      <h3 style="margin-top:1.5rem">2. Comptes déjà connus</h3>
      <div class="grille grille-2">
        <label style="display:flex;gap:.6rem;align-items:flex-start;font-weight:400">
          <input type="checkbox" id="sync-modifications" checked style="width:20px;height:20px;flex:0 0 auto;accent-color:var(--vert-fonce)">
          <span><strong>Mettre à jour ${r.modifies} fiche(s)</strong><br>
          <span class="discret">Nom, adresse et service repris de l'annuaire.</span></span>
        </label>
        <label style="display:flex;gap:.6rem;align-items:flex-start;font-weight:400">
          <input type="checkbox" id="sync-desactives" checked style="width:20px;height:20px;flex:0 0 auto;accent-color:var(--vert-fonce)">
          <span><strong>Écarter ${r.desactives} compte(s) désactivé(s)</strong><br>
          <span class="discret">Sortis des effectifs, des relances et des statistiques. Résultats conservés.</span></span>
        </label>
      </div>

      ${r.disparus ? `
        <fieldset style="margin:1rem 0;border:1px solid var(--bordure);border-radius:var(--rayon);padding:.9rem 1rem">
          <legend class="ui" style="font-weight:700;padding:0 .4rem">
            ${r.disparus} compte(s) absent(s) de l'annuaire
          </legend>
          <p class="discret" style="margin:0 0 .7rem;font-size:.86rem">
            Ils existent ici mais l'annuaire ne les renvoie plus : compte supprimé,
            déplacé hors de la base de recherche, ou identifiant modifié.
            <strong>Vérifiez avant de choisir</strong> — une base de recherche trop
            restrictive les ferait tous sortir d'un coup.
          </p>
          <div class="rang" style="flex-direction:column;align-items:stretch;gap:.55rem">
            <label style="display:flex;gap:.6rem;align-items:flex-start;font-weight:400">
              <input type="radio" name="sync-disparus" value="rien" checked
                     style="width:20px;height:20px;flex:0 0 auto;accent-color:var(--vert-fonce)">
              <span><strong>Ne rien faire</strong><br>
              <span class="discret">Ils restent dans la campagne. À choisir si vous n'avez pas encore vérifié.</span></span>
            </label>
            <label style="display:flex;gap:.6rem;align-items:flex-start;font-weight:400">
              <input type="radio" name="sync-disparus" value="ecarter"
                     style="width:20px;height:20px;flex:0 0 auto;accent-color:var(--vert-fonce)">
              <span><strong>Écarter</strong><br>
              <span class="discret">Sortis des effectifs, des relances et des classements. Résultats conservés,
              et ils reviennent d'eux-mêmes si le compte réapparaît.</span></span>
            </label>
            <label style="display:flex;gap:.6rem;align-items:flex-start;font-weight:400">
              <input type="radio" name="sync-disparus" value="supprimer"
                     style="width:20px;height:20px;flex:0 0 auto;accent-color:var(--erreur)">
              <span><strong style="color:var(--erreur)">Supprimer définitivement</strong><br>
              <span class="discret">La fiche, les participations, les réponses et les badges sont effacés.
              ${d.disparus.reduce((n, a) => n + (a.defis || 0), 0)} défi(s) joué(s) au total seraient perdus.
              <strong>Irréversible.</strong> Le journal conserve la liste des identifiants supprimés.</span></span>
            </label>
          </div>
        </fieldset>` : ''}

      ${bloc(d.modifies, 'Détail des modifications', (m) => `<strong>${echapper(m.nomComplet)}</strong> — `
        + m.changements.map((c) => `${echapper(c.champ)} : ${echapper(c.avant)} → <strong>${echapper(c.apres)}</strong>`).join(' · '))}

      ${bloc(d.desactives, 'Comptes désactivés dans l’annuaire', (a) => `${echapper(a.nomComplet)} `
        + `<span class="discret">(${echapper(a.service)})</span>`
        + (a.defis ? ` — ${a.defis} défi(s) joué(s), résultats conservés` : ''))}

      ${bloc(d.disparus, 'Absents de l’annuaire', (a) => `${echapper(a.nomComplet)} `
        + `<span class="discret">(${echapper(a.service)})</span>${a.defis ? ` — ${a.defis} défi(s) joué(s)` : ''}`, 'var(--alerte)')}

      ${bloc(d.ecartes, `${r.ecartes} compte(s) écarté(s) par vos règles`, (a) => `${echapper(a.nomComplet)} `
        + `<span class="discret">(${echapper(a.login)}) — ${echapper(a.motif)}</span>`)}

      ${d.exigerEmail && r.sansAdresse ? `
        <details style="margin-top:.6rem">
          <summary class="ui" style="cursor:pointer;font-weight:700">${r.sansAdresse} compte(s) sans adresse mail, non retenus</summary>
          <p class="discret" style="font-size:.84rem;margin:.4rem 0">
            Ils ne recevraient ni le message de lancement ni les relances : les compter
            dégraderait le taux de participation de leur service sans qu'ils puissent jouer.
            Pour les inclure malgré tout, décochez la règle dans
            Administration → Configuration → Rattachement au service.
          </p>
          <ul class="ui" style="font-size:.84rem">
            ${d.sansAdresse.slice(0, 80).map((a) => `<li>${echapper(a.nomComplet)} <span class="discret">(${echapper(a.login)}) — ${echapper(a.service)}</span></li>`).join('')}
          </ul>
          ${d.sansAdresse.length > 80 ? `<p class="discret">… ${r.sansAdresse - 80} autre(s)</p>` : ''}
        </details>` : ''}

      ${r.enBaseSansAdresse ? `
        <div class="message message-alerte" style="margin-top:.8rem">
          ${r.enBaseSansAdresse} agent(s) déjà présent(s) n'ont pas d'adresse mail.
          Ils ne sont pas écartés automatiquement — certains ont peut-être déjà joué —
          mais ils ne recevront aucune relance. Repérez-les dans la liste des agents,
          filtre « Sans adresse mail ».
        </div>` : ''}

      <div class="rang" style="margin-top:1.5rem;border-top:1px solid var(--bordure);padding-top:1.2rem">
        <button class="btn btn-principal" id="btn-appliquer-sync">Valider et appliquer</button>
        <button class="btn btn-secondaire" id="btn-relancer-sync">Relancer l'analyse</button>
        <button class="btn btn-secondaire" id="btn-fermer-sync">Fermer</button>
      </div>
    </div>`;

  brancher();
}

const bloc = (liste, titre, rendu, couleur) => (liste && liste.length ? `
  <details style="margin-top:.6rem">
    <summary class="ui" style="cursor:pointer;font-weight:700${couleur ? `;color:${couleur}` : ''}">${echapper(titre)}</summary>
    <ul class="ui" style="font-size:.84rem">${liste.slice(0, 80).map((x) => `<li>${rendu(x)}</li>`).join('')}</ul>
    ${liste.length > 80 ? `<p class="discret">… ${liste.length - 80} autre(s)</p>` : ''}
  </details>` : '');

function brancher() {
  const zone = document.getElementById('zone-formulaire');
  const cases = () => [...zone.querySelectorAll('.case-agent-sync')];

  const majCompteur = () => {
    document.getElementById('compteur-selection').textContent =
      `${cases().filter((c) => c.checked).length} agent(s) seront ajoutés`;
  };
  majCompteur();

  zone.addEventListener('change', (e) => {
    if (e.target.matches('.case-service')) {
      const i = e.target.dataset.service;
      zone.querySelectorAll(`.case-agent-sync[data-service="${i}"]`)
        .forEach((c) => { c.checked = e.target.checked; });
    }
    if (e.target.matches('.case-agent-sync')) {
      const i = e.target.dataset.service;
      const freres = [...zone.querySelectorAll(`.case-agent-sync[data-service="${i}"]`)];
      const service = zone.querySelector(`.case-service[data-service="${i}"]`);
      service.checked = freres.every((c) => c.checked);
      service.indeterminate = !service.checked && freres.some((c) => c.checked);
    }
    majCompteur();
  });

  zone.querySelectorAll('[data-deplier]').forEach((b) => b.addEventListener('click', () => {
    const detail = document.getElementById(`detail-${b.dataset.deplier}`);
    detail.hidden = !detail.hidden;
    b.textContent = detail.hidden ? 'Détail' : 'Masquer';
  }));

  document.getElementById('btn-tout-cocher').addEventListener('click', () => {
    zone.querySelectorAll('.case-service, .case-agent-sync').forEach((c) => { c.checked = true; c.indeterminate = false; });
    majCompteur();
  });
  document.getElementById('btn-tout-decocher').addEventListener('click', () => {
    zone.querySelectorAll('.case-service, .case-agent-sync').forEach((c) => { c.checked = false; c.indeterminate = false; });
    majCompteur();
  });

  document.getElementById('btn-fermer-sync').addEventListener('click', () => { zone.innerHTML = ''; });
  document.getElementById('btn-relancer-sync').addEventListener('click', () => formulaireSynchronisation());

  rendreExclusions();

  /** Que faire des comptes absents : ne rien faire, ecarter, ou supprimer. */
  const choixDisparus = () =>
    document.querySelector('input[name="sync-disparus"]:checked')?.value || 'rien';

  document.getElementById('btn-appliquer-sync').addEventListener('click', async () => {
    const bouton = document.getElementById('btn-appliquer-sync');

    const choix = choixDisparus();
    const nb = analyse.resume.disparus;
    const paragraphes = (...bouts) => bouts.join(String.fromCharCode(10, 10));

    if (choix === 'ecarter' && nb > 0 && !confirm(paragraphes(
      `Écarter ${nb} agent(s) absent(s) de l'annuaire ?`,
      'Si la base de recherche est trop restrictive, ce sont des agents légitimes qui sortiraient de la campagne.'
    ))) return;

    // La suppression efface des résultats que rien ne restaurera. On demande
    // donc le nombre plutôt qu'un simple « OK » : ce n'est pas la même décision
    // que l'exclusion, et le geste ne doit pas l'être non plus.
    if (choix === 'supprimer' && nb > 0) {
      const defis = (analyse.disparus || []).reduce((n, a) => n + (a.defis || 0), 0);
      const saisi = prompt(paragraphes(
        `Supprimer définitivement ${nb} compte(s) et tous leurs résultats ?`,
        `${defis} défi(s) joué(s) seront effacés. Cette action est irréversible.`,
        `Tapez ${nb} pour confirmer.`
      ));
      if (saisi === null) return;
      if (saisi.trim() !== String(nb)) {
        return alerte('alerte', 'Suppression annulée : le nombre saisi ne correspond pas.');
      }
    }

    bouton.disabled = true;
    bouton.textContent = 'Application en cours…';
    try {
      const r = await api('/api/admin/synchronisation/appliquer', {
        method: 'POST',
        body: {
          accepter: cases().filter((c) => c.checked).map((c) => c.value),
          appliquerModifications: document.getElementById('sync-modifications').checked,
          exclureDesactives: document.getElementById('sync-desactives').checked,
          exclureDisparus: choixDisparus() === 'ecarter',
          supprimerDisparus: choixDisparus() === 'supprimer',
        },
      });
      alerte('alerte', r.message, 'succes');
      zone.innerHTML = '';
      auTermine();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      alerte('alerte', e.message);
      bouton.disabled = false;
      bouton.textContent = 'Valider et appliquer';
    }
  });
}

function rendreExclusions() {
  const cible = document.getElementById('zone-exclusions');
  if (!cible) return;

  const actives = analyse.exclusions || [];
  const suggeres = analyse.motifsSuggeres || [];
  const estActive = (s) => actives.some((a) => a.champ === s.champ && a.motif === s.motif);
  const sur_mesure = actives.filter((a) => !suggeres.some((s) => s.champ === a.champ && s.motif === a.motif));

  const ligne = (champ, motif, libelle, coche) => `
    <label style="display:flex;gap:.6rem;align-items:center;font-weight:400;padding:.15rem 0">
      <input type="checkbox" class="case-exclusion" data-champ="${echapper(champ)}" data-motif="${echapper(motif)}"
             ${coche ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--vert-fonce)">
      <span class="ui" style="font-size:.85rem">${echapper(libelle)}
        <span class="discret">— ${echapper(champ)} contient « ${echapper(motif)} »</span></span>
    </label>`;

  cible.innerHTML = `
    ${suggeres.map((s) => ligne(s.champ, s.motif, s.libelle, estActive(s))).join('')}
    ${sur_mesure.map((a) => ligne(a.champ, a.motif, 'Règle ajoutée', true)).join('')}

    <div class="rang" style="align-items:flex-end;margin-top:.8rem">
      <div class="champ-admin" style="width:130px;margin-bottom:0">
        <label for="ex-champ">Champ</label>
        <select id="ex-champ">
          <option value="dn">DN</option><option value="service">Service</option><option value="login">Identifiant</option>
        </select>
      </div>
      <div class="champ-admin" style="flex:1;min-width:180px;margin-bottom:0">
        <label for="ex-motif">Contient</label>
        <input type="text" id="ex-motif" placeholder="OU=Comptes de service">
      </div>
      <button class="btn btn-secondaire" id="btn-ajouter-exclusion" style="margin-bottom:0;padding:.4rem .9rem;font-size:.82rem">Ajouter</button>
    </div>

    <button class="btn btn-secondaire" id="btn-enregistrer-exclusions" style="margin-top:.8rem;padding:.4rem .9rem;font-size:.82rem">
      Enregistrer les règles et relancer l'analyse
    </button>`;

  document.getElementById('btn-ajouter-exclusion').addEventListener('click', () => {
    const motif = document.getElementById('ex-motif').value.trim();
    if (!motif) return;
    analyse.exclusions = [...(analyse.exclusions || []), { champ: document.getElementById('ex-champ').value, motif }];
    rendreExclusions();
  });

  document.getElementById('btn-enregistrer-exclusions').addEventListener('click', async () => {
    const regles = [...cible.querySelectorAll('.case-exclusion')]
      .filter((c) => c.checked)
      .map((c) => ({ champ: c.dataset.champ, motif: c.dataset.motif }));
    try {
      const r = await api('/api/admin/synchronisation/exclusions', { method: 'PUT', body: { regles } });
      alerte('alerte', r.message, 'succes');
      formulaireSynchronisation();
    } catch (e) { alerte('alerte', e.message); }
  });
}
