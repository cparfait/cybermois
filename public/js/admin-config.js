import { api, echapper, alerte, animationsReduites } from '/js/commun.js';
import { decomposerUrlLdap } from '/js/url-ldap.js';

let descripteur = [];
let groupes = [];

const remonter = () =>
  window.scrollTo({ top: 0, behavior: animationsReduites() ? 'auto' : 'smooth' });

/**
 * Etat de l'autorite de certification.
 *
 * Un fichier monte dans le conteneur ne se voit nulle part dans le formulaire :
 * le champ base64 reste vide, et rien ne distingue « certificat fourni par
 * fichier » de « aucun certificat ».
 */
function certificat(etat) {
  if (!etat) return '';
  const titre = etat.source === 'fichier'
    ? (etat.ok ? "Certificat de l'AC : fourni par fichier" : "Certificat de l'AC : fichier introuvable")
    : etat.source === 'base64'
      ? "Certificat de l'AC : saisi dans ce formulaire"
      : "Certificat de l'AC : aucun";

  return `
    <div class="message ${etat.ok ? 'message-succes' : 'message-alerte'}" style="margin-bottom:1rem">
      <strong>${echapper(titre)}</strong>
      ${etat.chemin ? `<br><code>${echapper(etat.chemin)}</code>` : ''}
      <br><span style="font-size:.88rem">${echapper(etat.detail)}</span>
    </div>`;
}

/** Valeurs saisies dans le formulaire, prêtes à être testées ou enregistrées. */
function valeursSaisies() {
  const valeurs = {};
  for (const champ of document.querySelectorAll('[data-parametre]')) {
    const cle = champ.dataset.parametre;
    if (champ.type === 'checkbox') valeurs[cle] = champ.checked;
    else valeurs[cle] = champ.value;
  }
  return valeurs;
}

/** Un secret laissé vide signifie « ne pas changer » : on ne l'envoie pas. */
function valeursAEnregistrer() {
  const valeurs = valeursSaisies();
  for (const d of descripteur) {
    if (d.type === 'secret' && !valeurs[d.cle]) delete valeurs[d.cle];
  }
  return valeurs;
}

function champ(d) {
  const id = `p-${d.cle.replace(/\./g, '-')}`;
  const origine = d.origine === 'interface'
    ? '<span class="pastille-etat etat-ok" style="font-size:.68rem">enregistré ici</span>'
    : '<span class="pastille-etat" style="font-size:.68rem;background:var(--bordure);color:var(--encre-douce)">valeur d\'environnement</span>';

  if (d.type === 'booleen') {
    return `
      <div class="champ-admin" style="grid-column:1/-1">
        <label style="display:flex;gap:.6rem;align-items:flex-start;font-weight:400">
          <input type="checkbox" id="${id}" data-parametre="${d.cle}" ${d.valeur ? 'checked' : ''}
                 style="width:20px;height:20px;flex:0 0 auto;accent-color:var(--vert-fonce)">
          <span><strong>${echapper(d.libelle)}</strong> ${origine}
            ${d.aide ? `<br><span class="discret">${echapper(d.aide)}</span>` : ''}</span>
        </label>
      </div>`;
  }

  // L'adresse de l'annuaire : un hote, et une case pour le chiffrement.
  // Le schema et le port sont de la plomberie, et « ldap:// sur le port 636 »
  // a deja fait circuler des mots de passe en clair sur le port cense les
  // proteger. La case decide, l'administrateur n'a plus a y penser.
  if (d.type === 'ldap-hote') {
    const u = decomposerUrlLdap(d.valeur);
    const standard = u.chiffre ? 636 : 389;
    return `
      <div class="champ-admin">
        <label for="${id}">${echapper(d.libelle)} ${origine}</label>
        <input type="text" id="${id}" data-parametre="${d.cle}" value="${echapper(u.hote || '')}"
               placeholder="10.0.0.1 ou dc01.exemple.lan">
        ${d.aide ? `<p class="discret" style="margin:.3rem 0 0;font-size:.78rem">${echapper(d.aide)}</p>` : ''}
      </div>
      <div class="champ-admin">
        <label style="display:flex;gap:.6rem;align-items:flex-start;font-weight:400;margin-top:1.6rem">
          <input type="checkbox" id="${id}-chiffre" data-parametre="ldap.chiffre" ${u.chiffre ? 'checked' : ''}
                 style="width:20px;height:20px;flex:0 0 auto;accent-color:var(--vert-fonce)">
          <span><strong>Liaison chiffrée (LDAPS)</strong>
            <br><span class="discret" id="apercu-url-ldap">port ${u.port || standard}</span></span>
        </label>
      </div>`;
  }

  if (d.type === 'secret') {
    return `
      <div class="champ-admin">
        <label for="${id}">${echapper(d.libelle)} ${origine}</label>
        <input type="password" id="${id}" data-parametre="${d.cle}" value="" autocomplete="new-password"
               placeholder="${d.renseigne ? '•••••••• (renseigné, laisser vide pour ne pas changer)' : 'non renseigné'}">
        ${d.aide ? `<p class="discret" style="margin:.3rem 0 0;font-size:.78rem">${echapper(d.aide)}</p>` : ''}
      </div>`;
  }

  const type = d.type === 'entier' ? 'number' : 'text';
  return `
    <div class="champ-admin">
      <label for="${id}">${echapper(d.libelle)} ${origine}</label>
      <input type="${type}" id="${id}" data-parametre="${d.cle}" value="${echapper(d.valeur ?? '')}"
             autocapitalize="none" spellcheck="false">
      ${d.aide ? `<p class="discret" style="margin:.3rem 0 0;font-size:.78rem">${echapper(d.aide)}</p>` : ''}
    </div>`;
}

export async function chargerConfiguration() {
  const cible = document.getElementById('panneau-configuration');
  cible.innerHTML = '<p class="discret">Chargement…</p>';

  let d;
  try {
    d = await api('/api/admin/configuration');
  } catch (e) {
    cible.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }

  descripteur = d.parametres;
  groupes = d.groupes;

  const parGroupe = (cle) => descripteur.filter((p) => p.groupe === cle).map(champ).join('');

  cible.innerHTML = `
    ${d.etat.ok ? `
      <div class="message message-succes" style="margin-bottom:1.5rem">
        Configuration complète : les agents peuvent se connecter
        ${d.etat.mode === 'demonstration' ? '(mode démonstration, annuaire simulé)' : 'avec leur compte Active Directory'}.
      </div>` : `
      <div class="message message-alerte" style="margin-bottom:1.5rem">
        <strong>Configuration incomplète.</strong> Il manque : ${echapper(d.etat.manquants.join(', '))}.
        Les agents ne peuvent pas encore se connecter.
        <br><span style="font-size:.88rem">Le compte administrateur local, lui, reste
        utilisable : c'est ce qui vous permet de compléter cette page.</span>
      </div>`}

    <details class="aide-admin">
      <summary>Comment fonctionne cette page</summary>
      <p>Chaque réglage est enregistré en base et <strong>appliqué immédiatement</strong>, sans
      redémarrer le conteneur. Il prend le pas sur la variable d'environnement correspondante,
      qui ne sert plus que d'amorçage.</p>
      <p>Les mots de passe sont <strong>chiffrés en base</strong> et ne sont jamais renvoyés au
      navigateur : un champ laissé vide signifie « ne pas changer ». Une sauvegarde de la base
      ne divulgue donc pas le compte de service.</p>
      <p>Les boutons <strong>Tester</strong> utilisent les valeurs affichées à l'écran, pas
      celles enregistrées : vous pouvez vérifier une configuration avant de l'appliquer, et donc
      sans risquer de vous couper l'accès.</p>
    </details>

    <form id="formulaire-config">
      ${groupes.map((g) => `
        <section class="carte" style="margin-bottom:1.5rem">
          <h2>${echapper(g.libelle)}</h2>
          ${g.cle === 'ldap' ? `
            ${certificat(d.environnement?.certificat)}
            <div class="rang" style="margin-bottom:1rem">
              <button type="button" class="btn btn-secondaire" id="btn-test-ldap">Tester la connexion</button>
              <button type="button" class="btn btn-secondaire" id="btn-test-agent">Tester un agent</button>
            </div>
            <div id="resultat-ldap"></div>` : ''}
          ${g.cle === 'smtp' ? `
            <div class="rang" style="margin-bottom:1rem;align-items:flex-end">
              <div class="champ-admin" style="min-width:260px;margin-bottom:0">
                <label for="test-destinataire">Envoyer un message de test à</label>
                <input type="email" id="test-destinataire" placeholder="votre.adresse@chatillon92.fr">
              </div>
              <button type="button" class="btn btn-secondaire" id="btn-test-smtp" style="margin-bottom:0">Tester</button>
            </div>
            <div id="resultat-smtp"></div>` : ''}
          <div class="grille grille-2">${parGroupe(g.cle)}</div>
        </section>`).join('')}
    </form>

    <div class="rang" style="position:sticky;bottom:0;background:var(--fond);padding:1rem 0;border-top:1px solid var(--bordure)">
      <button class="btn btn-principal" id="btn-enregistrer-config">Enregistrer et appliquer</button>
      <button class="btn btn-secondaire" id="btn-recharger-config">Annuler les modifications</button>
    </div>

    <section class="carte" style="margin-top:2rem">
      <h2>Comptes administrateurs locaux</h2>
      <p class="discret" style="margin-top:-.3em">
        Indépendants de l'annuaire. Ils permettent de configurer l'Active Directory avant qu'il ne
        fonctionne, et de reprendre la main s'il devient injoignable. Ils ne comptent ni dans les
        effectifs, ni dans les classements.
      </p>

      <div class="tableau-defilant"><table class="admin">
        <caption class="sr-only">Comptes administrateurs locaux</caption>
        <thead><tr><th scope="col">Identifiant</th><th scope="col">Créé le</th>
          <th scope="col">Modifié le</th><th scope="col">Dernière connexion</th>
          <th scope="col">État</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${d.adminsLocaux.map((a) => `
          <tr>
            <td><strong>${echapper(a.login)}</strong></td>
            <td>${echapper((a.cree_le || '').slice(0, 10))}</td>
            <td>${echapper((a.maj_le || '').slice(0, 10) || '—')}</td>
            <td>${echapper((a.vu_le || '').slice(0, 16) || 'jamais')}</td>
            <td>${a.provisoire
              ? '<span class="pastille-etat" style="background:var(--alerte-fond);color:var(--alerte)">mot de passe provisoire</span>'
              : '<span class="pastille-etat etat-ok">actif</span>'}</td>
            <td class="rang" style="gap:.4rem">
              <button class="btn btn-secondaire" style="padding:.25rem .6rem;font-size:.78rem"
                      data-changer-local="${echapper(a.login)}">Changer le mot de passe</button>
              <button class="btn btn-secondaire" style="padding:.25rem .6rem;font-size:.78rem;border-color:var(--erreur);color:var(--erreur)"
                      data-supprimer-local="${echapper(a.login)}">Supprimer</button>
            </td>
          </tr>`).join('')}
        </tbody></table></div>

      <h3 style="margin-top:1.5rem">Créer un compte, ou changer un mot de passe</h3>
      <div class="grille grille-2">
        <div class="champ-admin">
          <label for="local-login">Identifiant</label>
          <input type="text" id="local-login" placeholder="ex. admin" autocapitalize="none" spellcheck="false">
          <p class="discret" style="margin:.3rem 0 0;font-size:.78rem">Un identifiant existant voit son mot de passe remplacé.
            Pour un compte du tableau ci-dessus, « Changer le mot de passe » le remplit pour vous.</p>
        </div>
        <div class="champ-admin">
          <label for="local-mdp">Mot de passe</label>
          <input type="password" id="local-mdp" autocomplete="new-password">
          <p class="discret" style="margin:.3rem 0 0;font-size:.78rem">12 caractères minimum. Une phrase de passe fait très bien l'affaire.</p>
        </div>
      </div>
      <button class="btn btn-secondaire" id="btn-creer-local">Enregistrer le compte local</button>
    </section>

    <section class="carte" style="margin-top:1.5rem">
      <h2>Réglages non modifiables ici</h2>
      <p class="discret" style="margin-top:-.3em">
        Ils viennent du fichier d'environnement ou de la pile Docker, et exigent un redémarrage.
      </p>
      <div class="tableau-defilant"><table class="admin">
        <caption class="sr-only">Réglages issus de l'environnement, non modifiables ici</caption>
        <tbody>
        <tr><th scope="row">Environnement</th><td>${echapper(d.environnement.env)}</td></tr>
        <tr><th scope="row">Base de données</th><td>${echapper(d.environnement.dbFile)}</td></tr>
        <tr><th scope="row">Secret de session</th><td>${d.environnement.sessionSecretDefini
          ? '<span class="pastille-etat etat-ok">défini</span>'
          : '<span class="pastille-etat etat-ko">valeur par défaut — à changer avant la mise en service</span>'}</td></tr>
      </tbody></table></div>
      <p class="discret" style="margin-top:1rem">
        <strong>Attention au secret de session.</strong> Il sert à chiffrer les mots de passe stockés
        sur cette page. Le modifier rendra ces secrets illisibles : il faudra les ressaisir.
      </p>
    </section>`;

  brancher();
}

function brancher() {
  // Le port suit la case a cocher : le voir changer evite de se demander
  // lequel s'appliquera.
  const caseChiffre = document.querySelector('[data-parametre="ldap.chiffre"]');
  const apercu = document.getElementById('apercu-url-ldap');
  if (caseChiffre && apercu) {
    caseChiffre.addEventListener('change', () => {
      apercu.textContent = `port ${caseChiffre.checked ? 636 : 389}`;
    });
  }

  const cible = document.getElementById('panneau-configuration');

  document.getElementById('btn-recharger-config').addEventListener('click', () => chargerConfiguration());


  document.getElementById('btn-enregistrer-config').addEventListener('click', async () => {
    const bouton = document.getElementById('btn-enregistrer-config');
    bouton.disabled = true;
    bouton.textContent = 'Enregistrement…';
    try {
      const r = await api('/api/admin/configuration', { method: 'PUT', body: { valeurs: valeursAEnregistrer() } });
      alerte('alerte', r.message, r.etat?.ok ? 'succes' : 'alerte');
      await chargerConfiguration();
      remonter();
    } catch (e) {
      alerte('alerte', e.message);
      bouton.disabled = false;
      bouton.textContent = 'Enregistrer et appliquer';
    }
  });

  /* ---------------------------------------------------------- Tests LDAP */

  document.getElementById('btn-test-ldap')?.addEventListener('click', async () => {
    const zone = document.getElementById('resultat-ldap');
    zone.innerHTML = '<p class="discret">Test en cours…</p>';
    try {
      const r = await api('/api/admin/configuration/test-ldap', { method: 'POST', body: { valeurs: valeursSaisies() } });

      const repartition = r.repartition
        ? Object.entries(r.repartition).map(([profondeur, services]) => `
            <details style="margin-top:.6rem">
              <summary class="ui" style="cursor:pointer;font-weight:700">
                Profondeur ${profondeur} : ${services.length} service(s)
              </summary>
              <ul class="ui" style="font-size:.84rem;columns:2;margin:.5rem 0">
                ${services.slice(0, 60).map((s) => `<li>${echapper(s.nom)} — ${s.n} agent(s)</li>`).join('')}
              </ul>
              ${services.length > 60 ? `<p class="discret">… ${services.length - 60} autre(s)</p>` : ''}
            </details>`).join('')
        : '';

      zone.innerHTML = `
        <div class="message message-${r.ok ? 'succes' : 'erreur'}" style="margin-bottom:1rem">
          <strong>${r.ok ? 'Connexion opérationnelle' : 'La connexion a échoué'}</strong>
          <ul style="margin:.6rem 0 0;padding-left:1.2rem">
            <!-- La coche et la croix portent le verdict de chaque etape : sans
                 texte a cote, un lecteur d'ecran lit huit lignes sans dire
                 laquelle a echoue. -->
            ${r.etapes.map((e) => `<li>
              <span aria-hidden="true">${e.ok ? '✅' : '❌'}</span>
              <span class="sr-only">${e.ok ? 'Réussi :' : 'Échec :'}</span>
              <strong>${echapper(e.libelle)}</strong> — ${echapper(e.detail || '')}</li>`).join('')}
          </ul>
          ${repartition ? `<div style="margin-top:.8rem"><strong>Répartition des services selon la profondeur d'OU :</strong>${repartition}</div>` : ''}
        </div>`;
    } catch (e) {
      zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    }
  });

  document.getElementById('btn-test-agent')?.addEventListener('click', async () => {
    const login = prompt('Identifiant de l\'agent à rechercher dans l\'annuaire :');
    if (!login) return;
    const zone = document.getElementById('resultat-ldap');
    zone.innerHTML = '<p class="discret">Recherche…</p>';
    try {
      const r = await api('/api/admin/configuration/test-agent', {
        method: 'POST', body: { valeurs: valeursSaisies(), login },
      });
      if (!r.ok) {
        zone.innerHTML = `<div class="message message-erreur">${echapper(r.message)}</div>`;
        return;
      }
      const a = r.agent;
      zone.innerHTML = `
        <div class="message message-succes">
          <strong>Compte trouvé</strong>
          <table class="admin" style="margin-top:.6rem;background:transparent">
            <caption class="sr-only">Attributs lus dans l'annuaire pour ce compte</caption>
            <tbody>
            <tr><th scope="row">DN</th><td style="word-break:break-all">${echapper(a.dn)}</td></tr>
            <tr><th scope="row">Identifiant</th><td>${echapper(a.login || '')}</td></tr>
            <tr><th scope="row">Nom affiché</th><td>${echapper(a.nomComplet || '(vide)')}</td></tr>
            <tr><th scope="row">Adresse</th><td>${echapper(a.email || '(vide)')}</td></tr>
            <tr><th scope="row">department</th><td>${echapper(a.department || '(vide)')}</td></tr>
            <tr><th scope="row">Arborescence OU</th><td>${echapper(a.chaineOu.join(' ← ') || '(aucune)')}</td></tr>
            <tr><th scope="row">Service retenu</th><td><strong>${echapper(a.serviceRetenu)}</strong></td></tr>
            <tr><th scope="row">Groupes</th><td>${a.nbGroupes}</td></tr>
          </tbody></table>
        </div>`;
    } catch (e) {
      zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    }
  });

  /* ---------------------------------------------------------- Test SMTP */

  document.getElementById('btn-test-smtp')?.addEventListener('click', async () => {
    const zone = document.getElementById('resultat-smtp');
    zone.innerHTML = '<p class="discret">Test en cours…</p>';
    try {
      const r = await api('/api/admin/configuration/test-smtp', {
        method: 'POST',
        body: { valeurs: valeursSaisies(), destinataire: document.getElementById('test-destinataire').value.trim() },
      });
      zone.innerHTML = `<div class="message message-${r.ok ? 'succes' : 'erreur'}">${echapper(r.message)}</div>`;
    } catch (e) {
      zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    }
  });

  /* -------------------------------------------------------- Comptes locaux */

  // Un double clic creait deux fois le compte - ou, plus exactement, ecrasait
  // le mot de passe qui venait d'etre pose. Le bouton se neutralise le temps
  // de l'appel, et se retablit dans tous les cas.
  const boutonLocal = document.getElementById('btn-creer-local');
  boutonLocal.addEventListener('click', async () => {
    const login = document.getElementById('local-login').value.trim();
    const motDePasse = document.getElementById('local-mdp').value;
    const libelle = boutonLocal.textContent;
    boutonLocal.disabled = true;
    boutonLocal.textContent = 'Enregistrement…';
    try {
      const r = await api('/api/admin/configuration/admin-local', { method: 'POST', body: { login, motDePasse } });
      alerte('alerte', r.message, 'succes');
      await chargerConfiguration();
    } catch (e) {
      alerte('alerte', e.message);
    } finally {
      boutonLocal.disabled = false;
      boutonLocal.textContent = libelle;
    }
  });

  /**
   * « Changer le mot de passe » amene au formulaire, identifiant deja rempli.
   *
   * Le formulaire sert a creer un compte ET a changer un mot de passe, mais
   * rien ne le disait sur la ligne du compte, qui n'offrait que « Supprimer ».
   * Pire : le champ Identifiant porte « admin » en texte de substitution, ce
   * qui le fait passer pour deja rempli - l'enregistrement echouait alors sur
   * un identifiant manquant.
   */
  cible.querySelectorAll('[data-changer-local]').forEach((b) =>
    b.addEventListener('click', () => {
      const champLogin = document.getElementById('local-login');
      const champMdp = document.getElementById('local-mdp');
      champLogin.value = b.dataset.changerLocal;
      champMdp.value = '';
      champMdp.scrollIntoView({ block: 'center', behavior: animationsReduites() ? 'auto' : 'smooth' });
      champMdp.focus();
      alerte('alerte',
        `Saisissez le nouveau mot de passe de « ${b.dataset.changerLocal} », `
        + 'puis « Enregistrer le compte local ».', 'succes');
    }));

  cible.querySelectorAll('[data-supprimer-local]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`Supprimer le compte local « ${b.dataset.supprimerLocal} » ?`)) return;
      try {
        const r = await api(`/api/admin/configuration/admin-local/${encodeURIComponent(b.dataset.supprimerLocal)}`, { method: 'DELETE' });
        alerte('alerte', r.message, 'succes');
        await chargerConfiguration();
      } catch (e) { alerte('alerte', e.message); }
    }));
}
