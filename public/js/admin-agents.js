import { api, echapper, alerte, formaterDate } from '/js/commun.js';
import { formulaireSynchronisation } from '/js/admin-sync.js';

let etatFiltres = { recherche: '', service: '', etat: '' };
let dernierImport = null;

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

export async function chargerAgents() {
  const cible = document.getElementById('panneau-agents');

  const parametres = new URLSearchParams();
  if (etatFiltres.recherche) parametres.set('recherche', etatFiltres.recherche);
  if (etatFiltres.service) parametres.set('service', etatFiltres.service);
  if (etatFiltres.etat) parametres.set('etat', etatFiltres.etat);

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

    <div class="grille grille-3" style="margin-bottom:1.5rem">
      <div class="stat-admin"><div class="v">${r.total - r.exclus}</div><div class="l">agents dans la campagne</div></div>
      <div class="stat-admin"><div class="v">${r.jamais_connectes}</div><div class="l">jamais connectés</div></div>
      <div class="stat-admin"><div class="v">${r.sans_email}</div><div class="l">sans adresse mail</div></div>
      <div class="stat-admin"><div class="v">${r.importes}</div><div class="l">issus d'un import</div></div>
      <div class="stat-admin"><div class="v">${r.exclus}</div><div class="l">exclus de la campagne</div></div>
      <div class="stat-admin"><div class="v">${r.anonymes}</div><div class="l">masqués du classement</div></div>
    </div>

    <div class="rang" style="margin-bottom:1.5rem">
      <button class="btn btn-principal" id="btn-ouvrir-sync">Synchroniser depuis l'annuaire</button>
      <button class="btn btn-secondaire" id="btn-ouvrir-import">Importer un fichier CSV</button>
      <button class="btn btn-secondaire" id="btn-ouvrir-ajout">Ajouter un agent</button>
      <button class="btn btn-secondaire" id="btn-ouvrir-services">Renommer et regrouper les services</button>
      <a class="btn btn-secondaire" href="/api/admin/agents/modele.csv">Télécharger un modèle CSV</a>
    </div>

    <div id="zone-formulaire"></div>

    <h2>Liste des agents</h2>
    <div class="rang" style="align-items:flex-end;margin-bottom:1rem">
      <div class="champ-admin" style="flex:1;min-width:200px;margin-bottom:0">
        <label for="f-recherche">Rechercher</label>
        <input type="search" id="f-recherche" value="${echapper(etatFiltres.recherche)}" placeholder="nom, identifiant ou adresse">
      </div>
      <div class="champ-admin" style="min-width:200px;margin-bottom:0">
        <label for="f-service">Service</label>
        <select id="f-service">
          <option value="">Tous les services</option>
          ${d.services.map((s) => `<option value="${echapper(s.service)}"${s.service === etatFiltres.service ? ' selected' : ''}>${echapper(s.service)} (${s.n})</option>`).join('')}
        </select>
      </div>
      <div class="champ-admin" style="min-width:200px;margin-bottom:0">
        <label for="f-etat">État</label>
        <select id="f-etat">
          <option value="">Tous</option>
          <option value="actifs"${etatFiltres.etat === 'actifs' ? ' selected' : ''}>Dans la campagne</option>
          <option value="jamais_connecte"${etatFiltres.etat === 'jamais_connecte' ? ' selected' : ''}>Jamais connectés</option>
          <option value="inactifs"${etatFiltres.etat === 'inactifs' ? ' selected' : ''}>Aucun défi terminé</option>
          <option value="sans_email"${etatFiltres.etat === 'sans_email' ? ' selected' : ''}>Sans adresse mail</option>
          <option value="exclus"${etatFiltres.etat === 'exclus' ? ' selected' : ''}>Exclus</option>
        </select>
      </div>
      <button class="btn btn-secondaire" id="btn-reinit-filtres" style="margin-bottom:0">Réinitialiser</button>
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

    ${d.tronque ? '<div class="message message-alerte" style="margin-bottom:1rem">Affichage limité à 1000 agents. Affinez la recherche pour voir les autres.</div>' : ''}

    <div class="tableau-defilant"><table class="admin">
      <thead><tr>
        <th style="width:32px"><input type="checkbox" id="tout-selectionner" aria-label="Tout sélectionner" style="width:18px;height:18px;accent-color:var(--vert-fonce)"></th>
        <th>Agent</th><th>Service</th><th>Adresse</th>
        <th class="num">Défis</th><th class="num">Points</th><th>État</th><th>Actions</th>
      </tr></thead>
      <tbody>${d.agents.length ? d.agents.map(ligneAgent).join('')
        : '<tr><td colspan="8" class="discret">Aucun agent ne correspond à ces critères.</td></tr>'}</tbody>
    </table></div>`;

  brancher(d);
}

function ligneAgent(a) {
  const etats = [];
  if (a.exclu) etats.push('<span class="pastille-etat etat-ko">Exclu</span>');
  else if (!a.vu_le) etats.push('<span class="pastille-etat" style="background:var(--alerte-fond);color:var(--alerte)">Jamais connecté</span>');
  if (a.anonyme) etats.push('<span class="pastille-etat" style="background:var(--info-fond);color:var(--info)">Masqué</span>');
  if (a.est_admin) etats.push('<span class="pastille-etat etat-ok">Admin</span>');

  return `
    <tr data-id="${a.id}">
      <td><input type="checkbox" class="case-agent" value="${a.id}" aria-label="Sélectionner ${echapper(a.nom_complet)}" style="width:18px;height:18px;accent-color:var(--vert-fonce)"></td>
      <td><strong>${echapper(a.nom_complet)}</strong><br><span class="discret">${echapper(a.login)}</span></td>
      <td>${echapper(a.service)}
        ${a.service_ad && a.service_ad !== a.service
          ? `<br><span class="discret" style="font-size:.75rem">annuaire : ${echapper(a.service_ad)}</span>` : ''}</td>
      <td>${a.email ? echapper(a.email) : '<span class="discret">—</span>'}</td>
      <td class="num">${a.defis_joues}</td>
      <td class="num">${a.score_total}</td>
      <td>${etats.join(' ') || '<span class="discret">—</span>'}${a.vu_le ? `<br><span class="discret" style="font-size:.75rem">vu le ${formaterDate(a.vu_le)}</span>` : ''}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-secondaire" style="padding:.25rem .6rem;font-size:.78rem" data-modifier="${a.id}">Modifier</button>
        <button class="btn btn-secondaire" style="padding:.25rem .6rem;font-size:.78rem;border-color:var(--erreur);color:var(--erreur)" data-supprimer="${a.id}">Supprimer</button>
      </td>
    </tr>`;
}

function brancher(d) {
  const cible = document.getElementById('panneau-agents');

  // --- Filtres
  let minuteur;
  document.getElementById('f-recherche').addEventListener('input', (e) => {
    clearTimeout(minuteur);
    minuteur = setTimeout(() => { etatFiltres.recherche = e.target.value.trim(); chargerAgents(); }, 350);
  });
  document.getElementById('f-service').addEventListener('change', (e) => { etatFiltres.service = e.target.value; chargerAgents(); });
  document.getElementById('f-etat').addEventListener('change', (e) => { etatFiltres.etat = e.target.value; chargerAgents(); });
  document.getElementById('btn-reinit-filtres').addEventListener('click', () => {
    etatFiltres = { recherche: '', service: '', etat: '' }; chargerAgents();
  });

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

  cible.querySelectorAll('[data-groupe]').forEach((b) => b.addEventListener('click', async () => {
    const ids = sel();
    const action = b.dataset.groupe;
    if (!ids.length) return;
    if (action === 'supprimer' && !confirm(
      `Supprimer définitivement ${ids.length} agent(s) et tous leurs résultats ?\n\n`
      + "L'exclusion est préférable : elle les écarte de la campagne en conservant l'historique."
    )) return;

    try {
      const r = await api('/api/admin/agents/action-groupee', { method: 'POST', body: { ids, action } });
      alerte('alerte', r.message, 'succes');
      chargerAgents();
    } catch (e) { alerte('alerte', e.message); }
  }));

  // --- Actions unitaires
  cible.querySelectorAll('[data-modifier]').forEach((b) =>
    b.addEventListener('click', () => formulaireAgent(d.agents.find((a) => a.id === Number(b.dataset.modifier)), d.services)));

  cible.querySelectorAll('[data-supprimer]').forEach((b) =>
    b.addEventListener('click', () => supprimer(d.agents.find((a) => a.id === Number(b.dataset.supprimer)))));

  // --- Ouverture des formulaires
  document.getElementById('btn-ouvrir-ajout').addEventListener('click', () => formulaireAgent(null, d.services));
  document.getElementById('btn-ouvrir-import').addEventListener('click', () => formulaireImport());
  document.getElementById('btn-ouvrir-services').addEventListener('click', () => formulaireServices());
  document.getElementById('btn-ouvrir-sync')
    .addEventListener('click', () => formulaireSynchronisation(chargerAgents));
}

/* ------------------------------------------------- Ajout et modification */

function formulaireAgent(agent, services) {
  const zone = document.getElementById('zone-formulaire');
  const creation = !agent;

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
          <input type="email" id="a-email" value="${creation || !agent.email ? '' : echapper(agent.email)}" placeholder="p.dupont@ville-chatillon.fr">
          <p class="discret" style="margin:.3rem 0 0;font-size:.8rem">Sans adresse, l'agent ne recevra aucune relance.</p>
        </div>
        <div class="champ-admin">
          <label for="a-service">Service</label>
          <input type="text" id="a-service" list="liste-services" value="${creation ? '' : echapper(agent.service)}" placeholder="Etat civil">
          <datalist id="liste-services">${services.map((s) => `<option value="${echapper(s.service)}">`).join('')}</datalist>
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

  zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  document.getElementById(creation ? 'a-login' : 'a-nom').focus();
  document.getElementById('btn-annuler-agent').addEventListener('click', () => { zone.innerHTML = ''; });

  document.getElementById('btn-enregistrer-agent').addEventListener('click', async () => {
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
      chargerAgents();
    } catch (e) { alerte('alerte', e.message); }
  });
}

/* --------------------------------------------------------- Suppression */

async function supprimer(agent) {
  if (!confirm(`Supprimer « ${agent.nom_complet} » ?`)) return;
  try {
    const r = await api(`/api/admin/agents/${agent.id}`, { method: 'DELETE' });
    alerte('alerte', r.message, 'succes');
    chargerAgents();
  } catch (e) {
    // Le serveur refuse tant que la perte des resultats n'est pas confirmee
    if (/défi\(s\)/.test(e.message)) {
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
        <textarea id="colle-import" style="min-height:110px;font-family:monospace;font-size:.82rem" placeholder="login;nom_complet;email;service&#10;p.dupont;Paul DUPONT;p.dupont@ville-chatillon.fr;Etat civil"></textarea>
      </div>

      <div class="rang">
        <button class="btn btn-principal" id="btn-analyser">Analyser le fichier</button>
        <button class="btn btn-secondaire" id="btn-annuler-import">Annuler</button>
      </div>

      <div id="apercu-import" style="margin-top:1.5rem"></div>
    </div>`;

  zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
      ${d.resume.sansService} agent(s) sans service identifiable seront rattachés à « Non rattache ».
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
      <thead><tr><th>Identifiant</th><th>Nom</th><th>Adresse</th><th>Service</th><th>Remarques</th></tr></thead>
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
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      alerte('alerte', e.message);
      bouton.disabled = false;
      bouton.textContent = 'Relancer l\'import';
    }
  });
}

/* ------------------------------------------- Regroupement des services */

async function formulaireServices() {
  const zone = document.getElementById('zone-formulaire');
  zone.innerHTML = '<p class="discret">Analyse des services…</p>';

  let d;
  try {
    d = await api('/api/admin/services');
  } catch (e) {
    zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }

  const cibles = [...new Set(d.inventaire.map((i) => i.cible))].sort((a, b) => a.localeCompare(b, 'fr'));
  const avecProposition = d.inventaire.filter((i) => !i.regroupe && i.proposition).length;

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

      ${avecProposition ? `
        <div class="message message-info" style="margin-bottom:1rem">
          ${avecProposition} service(s) ont une OU parente identifiable dans l'annuaire.
          <button class="btn btn-secondaire" id="btn-appliquer-propositions"
                  style="padding:.3rem .8rem;font-size:.82rem;margin-left:.5rem">Appliquer les propositions</button>
        </div>` : ''}

      <div class="tableau-defilant"><table class="admin">
        <thead><tr>
          <th>Libellé dans l'annuaire</th>
          <th class="num">Agents</th>
          <th>Arborescence des OU</th>
          <th>Nom affiché dans la campagne</th>
        </tr></thead>
        <tbody>${d.inventaire.map((i, index) => `
          <tr${i.regroupe ? ' style="background:var(--vert-clair-fond)"' : ''}>
            <td><strong>${echapper(i.source)}</strong></td>
            <td class="num">${i.effectif}</td>
            <td class="discret" style="font-size:.8rem">
              ${i.chaineOu.length ? echapper(i.chaineOu.join(' ← ')) : '<span class="discret">—</span>'}
            </td>
            <td>
              <input type="text" class="cible-service" data-source="${echapper(i.source)}"
                     data-proposition="${echapper(i.proposition || '')}"
                     value="${echapper(i.cible)}" list="cibles-connues"
                     aria-label="Service affiché pour ${echapper(i.source)}"
                     style="min-width:220px">
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>
      <datalist id="cibles-connues">${cibles.map((c) => `<option value="${echapper(c)}">`).join('')}</datalist>

      <div class="rang" style="margin-top:1.2rem;border-top:1px solid var(--bordure);padding-top:1.2rem">
        <button class="btn btn-principal" id="btn-enregistrer-services">Enregistrer et recalculer</button>
        <button class="btn btn-secondaire" id="btn-fermer-services">Fermer</button>
        <span class="discret ui" id="apercu-regroupement"></span>
      </div>
    </div>`;

  zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const champs = () => [...zone.querySelectorAll('.cible-service')];

  const majApercu = () => {
    const distincts = new Set(champs().map((c) => c.value.trim()).filter(Boolean));
    document.getElementById('apercu-regroupement').textContent =
      `${d.inventaire.length} libellés → ${distincts.size} service(s) au classement`;
  };
  majApercu();
  zone.addEventListener('input', (e) => { if (e.target.matches('.cible-service')) majApercu(); });

  document.getElementById('btn-appliquer-propositions')?.addEventListener('click', () => {
    for (const c of champs()) {
      if (c.dataset.proposition) c.value = c.dataset.proposition;
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
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { alerte('alerte', e.message); }
  });
}
