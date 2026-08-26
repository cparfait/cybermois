import { api, echapper, alerte, formaterDate } from '/js/commun.js';

/**
 * Correction des resultats apres coup.
 *
 * Deux voies, parce qu'elles ne repondent pas au meme probleme :
 *   - le RECALCUL rejoue tout un defi contre le bareme corrige. C'est la seule
 *     voie tenable quand une question a ete corrigee apres que des centaines
 *     d'agents y ont repondu ;
 *   - la CORRECTION UNITAIRE traite le cas particulier restant.
 *
 * Les deux exigent un motif et sont tracees nominativement.
 */

let auTermine = () => {};

/* ------------------------------------------------------------- Recalcul */

export async function formulaireRecalcul(semaine, titre, onTermine) {
  if (onTermine) auTermine = onTermine;
  const zone = document.getElementById('editeur') || document.getElementById('zone-formulaire');

  zone.innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--vert-clair)">
      <h2>Recalculer la semaine ${semaine}</h2>
      <p class="discret">Analyse en cours…</p>
    </div>`;
  zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  let d;
  try {
    d = await api(`/api/admin/defis/${semaine}/recalculer`, { method: 'POST', body: { simulation: true } });
  } catch (e) {
    zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }

  zone.innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--vert-clair)">
      <h2>Recalculer « ${echapper(titre)} »</h2>

      <details class="aide-admin">
        <summary>À quoi ça sert</summary>
        <p>Quand une question est corrigée alors que des agents y ont déjà répondu, leurs
        scores restent calculés sur l'ancien barème. Le recalcul rejoue leurs réponses
        enregistrées contre le barème actuel : personne ne perd sa participation, seuls
        les points bougent.</p>
        <p>C'est la seule voie praticable dès qu'il y a plus d'une poignée de participants.
        La correction manuelle, agent par agent, reste disponible pour les cas isolés.</p>
      </details>

      <div class="grille grille-3" style="margin:1.2rem 0">
        <div class="stat-admin"><div class="v">${d.concernes}</div><div class="l">participations concernées</div></div>
        <div class="stat-admin"><div class="v">${d.modifies}</div><div class="l">scores qui changeraient</div></div>
      </div>

      ${d.modifies ? `
        <div class="tableau-defilant" style="max-height:340px;overflow-y:auto">
          <table class="admin">
            <thead><tr><th>Agent</th><th>Service</th><th class="num">Avant</th><th class="num">Après</th><th class="num">Écart</th></tr></thead>
            <tbody>${d.changements.map((c) => `
              <tr>
                <td>${echapper(c.nom)}</td>
                <td>${echapper(c.service)}</td>
                <td class="num">${c.avant.score} / ${c.avant.scoreMax}</td>
                <td class="num">${c.apres.score} / ${c.apres.scoreMax}</td>
                <td class="num" style="color:${c.ecart > 0 ? 'var(--succes)' : 'var(--erreur)'};font-weight:700">
                  ${c.ecart > 0 ? '+' : ''}${c.ecart}
                </td>
              </tr>`).join('')}</tbody>
          </table>
        </div>

        <div class="champ-admin" style="margin-top:1.2rem">
          <label for="motif-recalcul">Motif du recalcul</label>
          <input type="text" id="motif-recalcul" placeholder="Bonne réponse corrigée sur la question 3">
          <p class="discret" style="margin:.3rem 0 0;font-size:.78rem">
            Enregistré au registre des corrections, avec votre identifiant.
          </p>
        </div>

        <div class="rang" style="margin-top:1rem">
          <button class="btn btn-principal" id="btn-appliquer-recalcul">Appliquer le recalcul</button>
          <button class="btn btn-secondaire" id="btn-fermer-recalcul">Fermer</button>
        </div>`
      : `
        <div class="message message-succes">Aucun score ne change : les résultats sont déjà à jour.</div>
        <button class="btn btn-secondaire" id="btn-fermer-recalcul">Fermer</button>`}
    </div>`;

  document.getElementById('btn-fermer-recalcul').addEventListener('click', () => { zone.innerHTML = ''; });

  document.getElementById('btn-appliquer-recalcul')?.addEventListener('click', async () => {
    const motif = document.getElementById('motif-recalcul').value.trim();
    if (motif.length < 5) return alerte('alerte', 'Indiquez le motif du recalcul.');

    const bouton = document.getElementById('btn-appliquer-recalcul');
    bouton.disabled = true;
    bouton.textContent = 'Recalcul en cours…';
    try {
      const r = await api(`/api/admin/defis/${semaine}/recalculer`, {
        method: 'POST', body: { simulation: false, motif },
      });
      alerte('alerte', r.message, 'succes');
      zone.innerHTML = '';
      auTermine();
    } catch (e) {
      alerte('alerte', e.message);
      bouton.disabled = false;
      bouton.textContent = 'Appliquer le recalcul';
    }
  });
}

/* -------------------------------------------- Resultats detailles d'un agent */

export async function formulaireResultatsAgent(agentId, onTermine) {
  if (onTermine) auTermine = onTermine;
  const zone = document.getElementById('zone-formulaire');
  zone.innerHTML = '<div class="carte"><p class="discret">Chargement des résultats…</p></div>';
  zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  let d;
  try {
    d = await api(`/api/admin/agents/${agentId}/resultats`);
  } catch (e) {
    zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }

  const ligneReponse = (r) => {
    const choisies = new Set(r.choix);
    return `
      <div class="editeur-question" data-reponse="${r.id}">
        <div class="rang" style="justify-content:space-between;align-items:flex-start">
          <strong class="ui" style="flex:1">${echapper(r.enonce)}</strong>
          <span class="pastille-etat ${r.correcte ? 'etat-ok' : 'etat-ko'}" style="white-space:nowrap">
            ${r.points_obtenus} / ${r.points} pts
          </span>
        </div>

        <div data-propositions style="margin:.7rem 0">
          ${r.propositions.map((p) => `
            <label style="display:flex;gap:.6rem;align-items:baseline;font-weight:400;padding:.15rem 0">
              <input type="${r.multiple ? 'checkbox' : 'radio'}" name="r${r.id}" value="${p.id}"
                     ${choisies.has(p.id) ? 'checked' : ''}
                     style="width:16px;height:16px;flex:0 0 auto;accent-color:var(--vert-fonce)">
              <span class="ui" style="font-size:.86rem">
                ${echapper(p.libelle)}
                ${p.correcte ? '<span class="pastille-etat etat-ok" style="font-size:.66rem;margin-left:.3rem">bonne réponse</span>' : ''}
              </span>
            </label>`).join('')}
        </div>

        <div class="rang" style="align-items:flex-end">
          <div class="champ-admin" style="flex:1;min-width:220px;margin-bottom:0">
            <label for="motif-${r.id}">Motif de la correction</label>
            <input type="text" id="motif-${r.id}" placeholder="Erreur de saisie signalée par l'agent">
          </div>
          <button class="btn btn-secondaire" data-corriger="${r.id}" style="margin-bottom:0;padding:.45rem .9rem;font-size:.82rem">
            Enregistrer cette réponse
          </button>
        </div>
      </div>`;
  };

  zone.innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--vert-clair)">
      <h2>Résultats de ${echapper(d.agent.nom_complet)}</h2>
      <p class="discret" style="margin-top:-.3em">
        ${echapper(d.agent.login)} · ${echapper(d.agent.service)}
      </p>

      <div class="message message-alerte" style="margin:1rem 0">
        Toute modification est <strong>enregistrée nominativement</strong> — qui, quand, quelle
        réponse, avant et après, avec le motif. Le registre est consultable et exportable.
        Vous ne pouvez pas modifier vos propres résultats.
      </div>

      ${d.participations.length ? d.participations.map((p) => `
        <details style="margin-bottom:1rem" ${d.participations.length === 1 ? 'open' : ''}>
          <summary class="ui" style="cursor:pointer;font-weight:700;padding:.5rem 0">
            Semaine ${p.semaine} — ${echapper(p.titre)}
            <span class="discret" style="font-weight:400">
              · ${p.score} / ${p.score_max} pts · terminé le ${formaterDate(p.termine_le)}
            </span>
          </summary>
          <div style="padding-left:.5rem">${p.reponses.map(ligneReponse).join('')}</div>
        </details>`).join('')
      : '<p class="discret">Cet agent n\'a terminé aucun défi.</p>'}

      <button class="btn btn-secondaire" id="btn-fermer-resultats">Fermer</button>
    </div>`;

  document.getElementById('btn-fermer-resultats').addEventListener('click', () => { zone.innerHTML = ''; });

  zone.querySelectorAll('[data-corriger]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.corriger;
    const bloc = zone.querySelector(`[data-reponse="${id}"]`);
    const choix = [...bloc.querySelectorAll('[data-propositions] input:checked')].map((c) => Number(c.value));
    const motif = document.getElementById(`motif-${id}`).value.trim();

    if (!choix.length) return alerte('alerte', 'Sélectionnez au moins une proposition.');
    if (motif.length < 5) return alerte('alerte', 'Le motif est obligatoire : il justifie la correction.');

    b.disabled = true;
    b.textContent = 'Enregistrement…';
    try {
      const r = await api(`/api/admin/reponses/${id}`, { method: 'PATCH', body: { choix, motif } });
      alerte('alerte', r.message, 'succes');
      await formulaireResultatsAgent(agentId);
      auTermine();
    } catch (e) {
      alerte('alerte', e.message);
      b.disabled = false;
      b.textContent = 'Enregistrer cette réponse';
    }
  }));
}

/* ------------------------------------------------ Registre des corrections */

export async function chargerRegistre(cible) {
  const zone = typeof cible === 'string' ? document.getElementById(cible) : cible;
  if (!zone) return;

  let d;
  try {
    d = await api('/api/admin/corrections');
  } catch (e) {
    zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }

  zone.innerHTML = `
    <p class="discret">
      Toute correction de résultat y figure, avec son auteur et son motif. C'est ce qui
      protège les agents — et les administrateurs — de tout soupçon.
      <a href="/api/admin/export/corrections.csv">Exporter en CSV</a>
    </p>
    <div class="tableau-defilant"><table class="admin">
      <thead><tr>
        <th>Date</th><th>Par</th><th>Type</th><th>Agent</th>
        <th>Question</th><th>Avant</th><th>Après</th><th>Motif</th>
      </tr></thead>
      <tbody>${d.corrections.length ? d.corrections.map((c) => `
        <tr>
          <td style="white-space:nowrap">${echapper((c.horodatage || '').slice(0, 16))}</td>
          <td><strong>${echapper(c.par_qui)}</strong></td>
          <td>${c.type === 'recalcul_defi' ? 'Recalcul' : 'Correction'}</td>
          <td>${echapper(c.agent_nom || '—')}</td>
          <td style="max-width:260px">${echapper((c.question || '').slice(0, 90))}</td>
          <td>${echapper(c.avant || '')}</td>
          <td>${echapper(c.apres || '')}</td>
          <td>${echapper(c.motif || '')}</td>
        </tr>`).join('')
        : '<tr><td colspan="8" class="discret">Aucune correction enregistrée.</td></tr>'}
      </tbody></table></div>`;
}
