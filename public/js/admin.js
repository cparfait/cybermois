import { api, echapper, initialiserPage, alerte, formaterDate } from '/js/commun.js';
import { chargerAgents } from '/js/admin-agents.js';
import { chargerConfiguration } from '/js/admin-config.js';

await initialiserPage('/administration');

const NOMS = ['suivi', 'defis', 'agents', 'mails', 'exports', 'configuration', 'technique'];
const onglets = NOMS.map((nom) => ({
  nom,
  bouton: document.getElementById(`onglet-${nom}`),
  panneau: document.getElementById(`panneau-${nom}`),
}));

const chargeurs = {};
let dejaCharge = new Set();

onglets.forEach(({ nom, bouton }, index) => {
  bouton.addEventListener('click', () => activer(index));
  bouton.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const suivant = (index + (e.key === 'ArrowRight' ? 1 : onglets.length - 1)) % onglets.length;
    activer(suivant);
    onglets[suivant].bouton.focus();
  });
  void nom;
});

function activer(actif) {
  onglets.forEach(({ bouton, panneau }, i) => {
    bouton.setAttribute('aria-selected', String(i === actif));
    panneau.hidden = i !== actif;
  });
  const nom = onglets[actif].nom;
  if (!dejaCharge.has(nom)) { dejaCharge.add(nom); chargeurs[nom]?.(); }
}

/* ============================================================== Suivi */

chargeurs.suivi = async () => {
  const cible = document.getElementById('panneau-suivi');
  try {
    const d = await api('/api/admin/tableau-de-bord');
    const s = d.stats;
    const tauxGlobal = s.inscrits ? Math.round((s.joueurs / s.inscrits) * 100) : 0;

    cible.innerHTML = `
      <div class="grille grille-3" style="margin-bottom:1.5rem">
        <div class="stat-admin"><div class="v">${s.inscrits}</div><div class="l">agents dans la campagne</div></div>
        <div class="stat-admin"><div class="v">${s.connectes}</div><div class="l">se sont connectés</div></div>
        <div class="stat-admin"><div class="v">${s.joueurs}</div><div class="l">agents ayant joué</div></div>
        <div class="stat-admin"><div class="v">${tauxGlobal} %</div><div class="l">taux de participation</div></div>
        <div class="stat-admin"><div class="v">${s.participations}</div><div class="l">défis terminés</div></div>
        <div class="stat-admin"><div class="v">${s.services}</div><div class="l">services représentés</div></div>
        <div class="stat-admin"><div class="v">${s.points_cumules}</div><div class="l">points cumulés</div></div>
      </div>

      ${s.connectes === s.inscrits ? `
        <div class="message message-alerte" style="margin-bottom:1.5rem">
          Aucun effectif n'a été importé : les agents n'apparaissent qu'à leur première connexion,
          donc le taux de participation affiché est trompeur. Importez votre export d'annuaire dans
          l'onglet <strong>Agents</strong> pour obtenir un taux juste et pouvoir relancer ceux qui
          ne sont jamais venus.
        </div>` : `
        <div class="message message-info" style="margin-bottom:1.5rem">
          Effectif de référence : <strong>${s.inscrits} agents</strong>, dont ${s.connectes} se sont
          déjà connectés et ${s.joueurs} ont terminé au moins un défi.
        </div>`}

      <h2>Participation par semaine</h2>
      <div class="tableau-defilant"><table class="admin">
        <thead><tr><th>Semaine</th><th>Défi</th><th class="num">Participants</th><th class="num">Réussite moyenne</th></tr></thead>
        <tbody>${s.parSemaine.map((x) => `
          <tr><td>S${x.semaine}</td><td>${echapper(x.titre)}</td>
          <td class="num">${x.participants}</td>
          <td class="num">${x.reussite_moyenne === null ? '—' : `${x.reussite_moyenne} %`}</td></tr>`).join('')}
        </tbody></table></div>

      <h2 style="margin-top:2rem">Classement des services</h2>
      <div class="tableau-defilant"><table class="admin">
        <thead><tr><th>Rang</th><th>Service</th><th class="num">Score moyen</th><th class="num">Participation</th><th class="num">Joueurs / inscrits</th></tr></thead>
        <tbody>${d.services.map((x, i) => `
          <tr><td>${i + 1}</td><td>${echapper(x.service)}</td>
          <td class="num">${x.score_moyen}</td>
          <td class="num">${x.taux_participation} %</td>
          <td class="num">${x.joueurs} / ${x.inscrits}</td></tr>`).join('')}
        </tbody></table></div>

      <h2 style="margin-top:2rem">Services à relancer</h2>
      <p class="discret">Agents connectés n'ayant encore terminé aucun défi.</p>
      <div class="tableau-defilant"><table class="admin">
        <thead><tr><th>Service</th><th class="num">Agents inactifs</th></tr></thead>
        <tbody>${d.jamaisJoue.length
          ? d.jamaisJoue.map((x) => `<tr><td>${echapper(x.service)}</td><td class="num">${x.n}</td></tr>`).join('')
          : '<tr><td colspan="2" class="discret">Tout le monde a joué. Beau score.</td></tr>'}
        </tbody></table></div>

      <h2 style="margin-top:2rem">Derniers envois</h2>
      <div class="tableau-defilant"><table class="admin">
        <thead><tr><th>Date</th><th>Type</th><th class="num">Semaine</th><th class="num">Destinataires</th><th class="num">Succès</th><th>Erreur</th></tr></thead>
        <tbody>${d.derniersEnvois.length
          ? d.derniersEnvois.map((e) => `<tr>
              <td>${formaterDate(e.horodatage)}</td><td>${echapper(e.type)}</td>
              <td class="num">${e.semaine ?? '—'}</td><td class="num">${e.destinataires}</td>
              <td class="num">${e.succes}</td><td>${echapper(e.erreur || '')}</td></tr>`).join('')
          : '<tr><td colspan="6" class="discret">Aucun envoi pour le moment.</td></tr>'}
        </tbody></table></div>`;
  } catch (erreur) { cible.innerHTML = `<div class="message message-erreur">${echapper(erreur.message)}</div>`; }
};

/* ============================================================== Défis */

chargeurs.defis = async () => {
  const cible = document.getElementById('panneau-defis');
  try {
    const defis = await api('/api/admin/defis');
    cible.innerHTML = `
      <details class="aide-admin">
        <summary>Comment fonctionne la planification</summary>
        <p>Chaque défi s'ouvre automatiquement à sa date d'ouverture, à condition d'être publié.
        Modifier la date de début de campagne décale les quatre semaines de 7 jours en 7 jours.
        Un défi dépublié disparaît du portail sans que les participations soient perdues.</p>
      </details>

      <div class="rang" style="margin-bottom:1.5rem">
        <button class="btn btn-principal" id="btn-creer-defi">Créer un défi</button>
        <span class="discret ui">Il arrive masqué : rédigez les questions, puis publiez-le.</span>
      </div>

      <div class="carte" style="margin-bottom:1.5rem">
        <h2>Calendrier de la campagne</h2>
        <div class="champ-admin" style="max-width:280px">
          <label for="debut-campagne">Ouverture de la semaine 1</label>
          <input type="date" id="debut-campagne" value="${defis[0]?.ouvre_le || ''}">
        </div>
        <button class="btn btn-secondaire" id="btn-replanifier">Replanifier les 4 semaines</button>
      </div>

      <div class="tableau-defilant"><table class="admin">
        <thead><tr><th>Semaine</th><th>Titre</th><th>Ouverture</th><th>État</th><th>Actions</th></tr></thead>
        <tbody>${defis.map((d) => `
          <tr>
            <td>S${d.semaine}</td>
            <td>${echapper(d.titre)}</td>
            <td>${d.ouvre_le}</td>
            <td><span class="pastille-etat ${d.publie ? 'etat-ok' : 'etat-ko'}">${d.publie ? 'Publié' : 'Masqué'}</span></td>
            <td>
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem" data-editer="${d.semaine}">Modifier</button>
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem" data-publier="${d.semaine}" data-etat="${d.publie}">
                ${d.publie ? 'Masquer' : 'Publier'}
              </button>
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem;border-color:var(--erreur);color:var(--erreur)"
                      data-supprimer-defi="${d.semaine}" data-titre="${echapper(d.titre)}">Supprimer</button>
            </td>
          </tr>`).join('')}
        </tbody></table></div>

      <div id="editeur" style="margin-top:2rem"></div>`;

    document.getElementById('btn-replanifier').addEventListener('click', async () => {
      const debut = document.getElementById('debut-campagne').value;
      try {
        const r = await api('/api/admin/campagne', { method: 'POST', body: { debut } });
        alerte('alerte', r.message, 'succes');
        dejaCharge.delete('defis'); chargeurs.defis();
      } catch (e) { alerte('alerte', e.message); }
    });

    cible.querySelectorAll('[data-publier]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/api/admin/defis/${b.dataset.publier}/publication`, {
          method: 'POST', body: { publie: b.dataset.etat !== '1' },
        });
        dejaCharge.delete('defis'); chargeurs.defis();
      } catch (e) { alerte('alerte', e.message); }
    }));

    cible.querySelectorAll('[data-editer]').forEach((b) =>
      b.addEventListener('click', () => ouvrirEditeur(Number(b.dataset.editer))));

    document.getElementById('btn-creer-defi').addEventListener('click', async () => {
      const titre = prompt('Titre du nouveau défi :');
      if (!titre?.trim()) return;
      try {
        const r = await api('/api/admin/defis', { method: 'POST', body: { titre: titre.trim() } });
        alerte('alerte', r.message, 'succes');
        dejaCharge.delete('defis');
        await chargeurs.defis();
        ouvrirEditeur(r.semaine);
      } catch (e) { alerte('alerte', e.message); }
    });

    cible.querySelectorAll('[data-supprimer-defi]').forEach((b) =>
      b.addEventListener('click', async () => {
        const semaine = Number(b.dataset.supprimerDefi);
        if (!confirm(`Supprimer le défi « ${b.dataset.titre} » ?`)) return;
        try {
          const r = await api(`/api/admin/defis/${semaine}`, { method: 'DELETE' });
          alerte('alerte', r.message, 'succes');
          dejaCharge.delete('defis'); chargeurs.defis();
        } catch (e) {
          // Le serveur refuse tant que la perte des resultats n'est pas confirmee
          if (/a été joué/.test(e.message)) {
            if (!confirm(`${e.message}

Confirmer la suppression définitive ?`)) return;
            try {
              const r = await api(`/api/admin/defis/${semaine}`, {
                method: 'DELETE', body: { confirmerPerteResultats: true },
              });
              alerte('alerte', r.message, 'succes');
              dejaCharge.delete('defis'); chargeurs.defis();
            } catch (e2) { alerte('alerte', e2.message); }
          } else alerte('alerte', e.message);
        }
      }));
  } catch (erreur) { cible.innerHTML = `<div class="message message-erreur">${echapper(erreur.message)}</div>`; }
};

async function ouvrirEditeur(semaine) {
  const zone = document.getElementById('editeur');
  zone.innerHTML = '<p class="discret">Chargement du défi…</p>';
  const defi = await api(`/api/admin/defis/${semaine}`);

  const rendreQuestion = (q, i) => `
    <div class="editeur-question" data-question="${i}">
      <div class="rang" style="justify-content:space-between;margin-bottom:.8rem">
        <strong class="ui">Question ${i + 1}</strong>
        <button type="button" class="btn btn-secondaire" style="padding:.25rem .7rem;font-size:.78rem" data-supprimer-question="${i}">Supprimer</button>
      </div>
      <div class="champ-admin">
        <label for="enonce-${i}">Énoncé</label>
        <textarea id="enonce-${i}" data-champ="enonce">${echapper(q.enonce)}</textarea>
      </div>
      <div class="champ-admin">
        <label for="contexte-${i}">Contexte (facultatif : mail à analyser, mise en situation)</label>
        <textarea id="contexte-${i}" data-champ="contexte">${echapper(q.contexte || '')}</textarea>
      </div>
      <div class="rang" style="align-items:flex-end">
        <div class="champ-admin" style="width:120px">
          <label for="points-${i}">Points</label>
          <input type="number" id="points-${i}" data-champ="points" value="${q.points}" min="1" max="100">
        </div>
        <div class="champ-admin">
          <label style="display:flex;align-items:center;gap:.5rem;font-weight:600">
            <input type="checkbox" data-champ="multiple" ${q.multiple ? 'checked' : ''} style="width:20px;height:20px;accent-color:var(--vert-fonce)">
            Plusieurs réponses possibles
          </label>
        </div>
      </div>
      <fieldset style="border:none;padding:0;margin:0 0 .9rem">
        <legend class="ui" style="font-weight:600;font-size:.9rem;margin-bottom:.5rem">Réponses — cochez les bonnes</legend>
        <div data-reponses>
          ${q.reponses.map((r) => `
            <div class="ligne-reponse">
              <input type="checkbox" ${r.correcte ? 'checked' : ''} aria-label="Bonne réponse">
              <input type="text" value="${echapper(r.libelle)}" aria-label="Libellé de la réponse">
              <button type="button" class="btn btn-secondaire" style="padding:.3rem .6rem;font-size:.78rem" data-supprimer-reponse>✕</button>
            </div>`).join('')}
        </div>
        <button type="button" class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem" data-ajouter-reponse>+ Ajouter une réponse</button>
      </fieldset>
      <div class="champ-admin">
        <label for="explication-${i}">Explication affichée après validation</label>
        <textarea id="explication-${i}" data-champ="explication">${echapper(q.explication || '')}</textarea>
      </div>
    </div>`;

  zone.innerHTML = `
    <div class="carte">
      <h2>Semaine ${defi.semaine} — édition</h2>
      <div class="champ-admin"><label for="ed-titre">Titre</label><input type="text" id="ed-titre" value="${echapper(defi.titre)}"></div>
      <div class="champ-admin"><label for="ed-accroche">Accroche</label><input type="text" id="ed-accroche" value="${echapper(defi.accroche)}"></div>
      <div class="champ-admin"><label for="ed-intro">Introduction</label><textarea id="ed-intro" style="min-height:90px">${echapper(defi.intro)}</textarea></div>
      <div class="champ-admin" style="max-width:160px"><label for="ed-duree">Durée annoncée (min)</label><input type="number" id="ed-duree" value="${defi.duree_minutes}" min="1" max="60"></div>

      <h3 style="margin-top:1.5rem">Questions</h3>
      <div id="liste-questions">${defi.questions.map(rendreQuestion).join('')}</div>
      <button type="button" class="btn btn-secondaire" id="btn-ajouter-question">+ Ajouter une question</button>

      <div class="rang" style="margin-top:1.5rem;border-top:1px solid var(--bordure);padding-top:1.2rem">
        <button type="button" class="btn btn-principal" id="btn-enregistrer">Enregistrer la semaine ${defi.semaine}</button>
        <button type="button" class="btn btn-secondaire" id="btn-fermer">Fermer</button>
      </div>
      <p class="discret" style="margin-top:.8rem">
        Attention : enregistrer remplace toutes les questions de cette semaine. Les participations déjà
        enregistrées conservent leur score, mais les corrections affichées seront celles du nouveau contenu.
      </p>
    </div>`;

  const liste = document.getElementById('liste-questions');

  liste.addEventListener('click', (e) => {
    if (e.target.matches('[data-supprimer-question]')) {
      if (liste.children.length <= 1) return alerte('alerte', 'Un défi doit comporter au moins une question.');
      e.target.closest('.editeur-question').remove();
    }
    if (e.target.matches('[data-supprimer-reponse]')) {
      const conteneur = e.target.closest('[data-reponses]');
      if (conteneur.children.length <= 2) return alerte('alerte', 'Une question doit comporter au moins deux réponses.');
      e.target.closest('.ligne-reponse').remove();
    }
    if (e.target.matches('[data-ajouter-reponse]')) {
      const conteneur = e.target.previousElementSibling;
      const ligne = document.createElement('div');
      ligne.className = 'ligne-reponse';
      ligne.innerHTML = `
        <input type="checkbox" aria-label="Bonne réponse">
        <input type="text" value="" aria-label="Libellé de la réponse">
        <button type="button" class="btn btn-secondaire" style="padding:.3rem .6rem;font-size:.78rem" data-supprimer-reponse>✕</button>`;
      conteneur.appendChild(ligne);
      ligne.querySelector('input[type="text"]').focus();
    }
  });

  document.getElementById('btn-ajouter-question').addEventListener('click', () => {
    const i = liste.children.length;
    liste.insertAdjacentHTML('beforeend', rendreQuestion({
      enonce: '', contexte: '', multiple: true, points: 10, explication: '',
      reponses: [{ libelle: '', correcte: true }, { libelle: '', correcte: false }],
    }, i));
    liste.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  document.getElementById('btn-fermer').addEventListener('click', () => { zone.innerHTML = ''; });

  document.getElementById('btn-enregistrer').addEventListener('click', async () => {
    const questions = [...liste.querySelectorAll('.editeur-question')].map((bloc) => ({
      enonce: bloc.querySelector('[data-champ="enonce"]').value.trim(),
      contexte: bloc.querySelector('[data-champ="contexte"]').value.trim() || null,
      points: Number(bloc.querySelector('[data-champ="points"]').value) || 10,
      multiple: bloc.querySelector('[data-champ="multiple"]').checked,
      explication: bloc.querySelector('[data-champ="explication"]').value.trim(),
      reponses: [...bloc.querySelectorAll('.ligne-reponse')].map((l) => ({
        libelle: l.querySelector('input[type="text"]').value.trim(),
        correcte: l.querySelector('input[type="checkbox"]').checked,
      })).filter((r) => r.libelle),
    }));

    try {
      const r = await api(`/api/admin/defis/${defi.semaine}`, {
        method: 'POST',
        body: {
          titre: document.getElementById('ed-titre').value.trim(),
          accroche: document.getElementById('ed-accroche').value.trim(),
          intro: document.getElementById('ed-intro').value.trim(),
          duree_minutes: Number(document.getElementById('ed-duree').value),
          questions,
        },
      });
      alerte('alerte', r.message, 'succes');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { alerte('alerte', e.message); }
  });

  zone.scrollIntoView({ behavior: 'smooth' });
}

/* ============================================================== Agents */

chargeurs.agents = chargerAgents;
chargeurs.configuration = chargerConfiguration;

/* ============================================================== Mails */

chargeurs.mails = async () => {
  const cible = document.getElementById('panneau-mails');
  cible.innerHTML = `
    <details class="aide-admin">
      <summary>Qui envoie quoi</summary>
      <p><strong>Lancement (lundi)</strong> — à copier-coller par la DPO, pour qu'il parte de sa propre boîte
      et porte sa signature. Utilisez le bouton « Copier le texte » ci-dessous.<br>
      <strong>Relance (mercredi)</strong> — envoyée automatiquement par l'application aux seuls agents
      n'ayant pas encore fait le défi de la semaine.<br>
      <strong>Résultats (vendredi)</strong> — envoyés automatiquement au groupe de distribution.</p>
    </details>

    <div class="carte" style="margin-bottom:1.5rem">
      <div class="rang" style="align-items:flex-end">
        <div class="champ-admin" style="width:150px">
          <label for="mail-semaine">Semaine</label>
          <select id="mail-semaine"><option>1</option><option>2</option><option>3</option><option>4</option></select>
        </div>
        <div class="champ-admin" style="width:200px">
          <label for="mail-type">Type de message</label>
          <select id="mail-type">
            <option value="lancement">Lancement (DPO)</option>
            <option value="relance">Relance</option>
            <option value="resultats">Résultats</option>
          </select>
        </div>
        <div class="champ-admin"><button class="btn btn-principal" id="btn-apercu">Prévisualiser</button></div>
      </div>

      <div id="zone-actions" class="rang" style="border-top:1px solid var(--bordure);padding-top:1rem"></div>
    </div>

    <div id="zone-apercu"></div>`;

  document.getElementById('btn-apercu').addEventListener('click', apercu);
  document.getElementById('mail-type').addEventListener('change', majActions);
  majActions();

  function majActions() {
    const type = document.getElementById('mail-type').value;
    const zone = document.getElementById('zone-actions');
    if (type === 'lancement') {
      zone.innerHTML = `
        <button class="btn btn-secondaire" id="btn-copier-texte">Copier le texte brut</button>
        <button class="btn btn-secondaire" id="btn-copier-html">Copier le HTML</button>
        <span class="discret ui">Ce message est destiné à être envoyé par la DPO depuis sa messagerie.</span>`;
      document.getElementById('btn-copier-texte').addEventListener('click', () => copier('texte'));
      document.getElementById('btn-copier-html').addEventListener('click', () => copier('html'));
    } else if (type === 'relance') {
      zone.innerHTML = `
        <button class="btn btn-secondaire" id="btn-simuler">Simuler (compter les destinataires)</button>
        <button class="btn btn-principal" id="btn-envoyer">Envoyer les relances maintenant</button>`;
      document.getElementById('btn-simuler').addEventListener('click', () => envoyer('relances', true));
      document.getElementById('btn-envoyer').addEventListener('click', () => {
        if (confirm('Envoyer les relances à tous les agents n\'ayant pas fait ce défi ?')) envoyer('relances', false);
      });
    } else {
      zone.innerHTML = `
        <button class="btn btn-secondaire" id="btn-simuler">Simuler</button>
        <button class="btn btn-principal" id="btn-envoyer">Envoyer les résultats au groupe</button>`;
      document.getElementById('btn-simuler').addEventListener('click', () => envoyer('resultats', true));
      document.getElementById('btn-envoyer').addEventListener('click', () => {
        if (confirm('Envoyer le mail de résultats au groupe de distribution ?')) envoyer('resultats', false);
      });
    }
  }

  let dernierMail = null;

  async function apercu() {
    const semaine = document.getElementById('mail-semaine').value;
    const type = document.getElementById('mail-type').value;
    try {
      dernierMail = await api(`/api/admin/mails/${type}/${semaine}`);
      const zone = document.getElementById('zone-apercu');
      zone.innerHTML = `
        <div class="carte">
          <p class="ui"><strong>Objet :</strong> ${echapper(dernierMail.objet)}</p>
          <iframe class="apercu-mail" title="Aperçu du message" sandbox></iframe>
        </div>`;
      zone.querySelector('iframe').srcdoc = dernierMail.html;
    } catch (e) { alerte('alerte', e.message); }
  }

  async function copier(format) {
    if (!dernierMail) { await apercu(); }
    if (!dernierMail) return;
    try {
      await navigator.clipboard.writeText(format === 'html' ? dernierMail.html : dernierMail.texte);
      alerte('alerte', `Message copié (${format}). Objet : « ${dernierMail.objet} »`, 'succes');
    } catch {
      alerte('alerte', 'Copie automatique refusée par le navigateur : sélectionnez le texte de l\'aperçu.', 'alerte');
    }
  }

  async function envoyer(quoi, simulation) {
    const semaine = document.getElementById('mail-semaine').value;
    try {
      const r = await api(`/api/admin/mails/${quoi}/${semaine}`, { method: 'POST', body: { simulation } });
      if (!r.ok) return alerte('alerte', r.message || 'Envoi impossible.');
      alerte('alerte', simulation
        ? `Simulation : ${r.destinataires} destinataire(s) seraient concernés.`
        : `Envoi effectué : ${r.succes} / ${r.destinataires} message(s) transmis.${r.erreur ? ` Dernière erreur : ${r.erreur}` : ''}`,
        'succes');
    } catch (e) { alerte('alerte', e.message); }
  }
};

/* ============================================================== Exports */

chargeurs.exports = async () => {
  document.getElementById('panneau-exports').innerHTML = `
    <p class="discret">Fichiers CSV encodés en UTF-8 avec BOM et séparateur point-virgule : ils s'ouvrent directement dans Excel.</p>
    <div class="grille grille-2" style="margin-top:1.5rem">
      <div class="carte">
        <h3>Participations détaillées</h3>
        <p class="discret">Une ligne par agent et par défi : score, durée, date.</p>
        <a class="btn btn-secondaire" href="/api/admin/export/participations.csv">Télécharger</a>
      </div>
      <div class="carte">
        <h3>Classement des services</h3>
        <p class="discret">Score moyen, taux de participation, effectifs.</p>
        <a class="btn btn-secondaire" href="/api/admin/export/services.csv">Télécharger</a>
      </div>
      <div class="carte">
        <h3>Classement individuel</h3>
        <p class="discret">Agents, service, points cumulés.</p>
        <a class="btn btn-secondaire" href="/api/admin/export/agents.csv">Télécharger</a>
      </div>
      <div class="carte" style="border-left:4px solid var(--vert-clair)">
        <h3>Preuve de participation</h3>
        <p class="discret">Synthèse par agent, exploitable comme preuve d'action de sensibilisation en audit SSI.</p>
        <a class="btn btn-secondaire" href="/api/admin/export/attestation.csv">Télécharger</a>
      </div>
      <div class="carte">
        <h3>Journal des actions</h3>
        <p class="discret">Connexions, validations, actions d'administration.</p>
        <a class="btn btn-secondaire" href="/api/admin/export/journal.csv">Télécharger</a>
      </div>
    </div>`;
};

/* ============================================================== Technique */

chargeurs.technique = async () => {
  const cible = document.getElementById('panneau-technique');
  cible.innerHTML = '<p class="discret">Test des connexions en cours…</p>';
  try {
    const d = await api('/api/admin/diagnostic');
    const c = d.configuration;

    cible.innerHTML = `
      <div class="grille grille-2" style="margin-bottom:1.5rem">
        <div class="carte">
          <h3>Annuaire LDAPS <span class="pastille-etat ${d.ldap.ok ? 'etat-ok' : 'etat-ko'}">${d.ldap.ok ? 'OK' : 'Erreur'}</span></h3>
          <p class="discret" style="word-break:break-word">${echapper(d.ldap.message)}</p>
        </div>
        <div class="carte">
          <h3>Relais SMTP <span class="pastille-etat ${d.smtp.ok ? 'etat-ok' : 'etat-ko'}">${d.smtp.ok ? 'OK' : 'Erreur'}</span></h3>
          <p class="discret" style="word-break:break-word">${echapper(d.smtp.message)}</p>
        </div>
      </div>

      <h2>Configuration active</h2>
      <div class="tableau-defilant"><table class="admin">
        <tbody>
          <tr><td>Serveur LDAPS</td><td>${echapper(c.ldapUrl)}</td></tr>
          <tr><td>Base de recherche</td><td>${echapper(c.baseDn)}</td></tr>
          <tr><td>Source du service</td><td>${echapper(c.sourceService)}</td></tr>
          <tr><td>Groupe requis</td><td>${echapper(c.groupeRequis)}</td></tr>
          <tr><td>Envoi de mails</td><td>${c.envoiMailActif ? 'Actif' : 'Désactivé'}</td></tr>
          <tr><td>Groupe de diffusion</td><td>${echapper(c.groupeDiffusion)}</td></tr>
          <tr><td>Planification des relances</td><td><code>${echapper(c.cronRelance)}</code></td></tr>
          <tr><td>Planification des résultats</td><td><code>${echapper(c.cronResultats)}</code></td></tr>
          <tr><td>URL publique</td><td>${echapper(c.urlPublique)}</td></tr>
          <tr><td>Administrateurs</td><td>${echapper(c.administrateurs.join(', ') || '(aucun)')}</td></tr>
        </tbody></table></div>

      <h2 style="margin-top:2rem">Contenus</h2>
      <p class="discret">Recharge les fichiers <code>content/semaine-*.json</code>. Les défis déjà joués sont préservés sauf si vous forcez.</p>
      <div class="rang">
        <button class="btn btn-secondaire" id="btn-reimport">Recharger les contenus</button>
        <button class="btn btn-secondaire" id="btn-reimport-force">Recharger en forçant</button>
      </div>

      <h2 style="margin-top:2rem">Journal récent</h2>
      <div class="tableau-defilant"><table class="admin" id="table-journal"><tbody><tr><td class="discret">Chargement…</td></tr></tbody></table></div>

      <h2 style="margin-top:2rem">Réinitialisation</h2>
      <div class="message message-alerte">
        Efface toutes les participations, badges et historiques d'envoi. Les comptes agents et les défis
        sont conservés. À n'utiliser qu'à l'issue de la phase de test, avant l'ouverture réelle.
      </div>
      <button class="btn btn-secondaire" id="btn-reinit" style="border-color:var(--erreur);color:var(--erreur)">Réinitialiser les participations</button>`;

    document.getElementById('btn-reimport').addEventListener('click', () => reimporter(false));
    document.getElementById('btn-reimport-force').addEventListener('click', () => {
      if (confirm('Forcer le rechargement écrase les questions des défis déjà joués. Continuer ?')) reimporter(true);
    });

    document.getElementById('btn-reinit').addEventListener('click', async () => {
      if (!confirm('Effacer toutes les participations et tous les badges ? Cette action est irréversible.')) return;
      try {
        const r = await api('/api/admin/reinitialiser', { method: 'POST', body: { confirmation: 'REINITIALISER' } });
        alerte('alerte', r.message, 'succes');
      } catch (e) { alerte('alerte', e.message); }
    });

    const journal = await api('/api/admin/journal');
    document.getElementById('table-journal').innerHTML = `
      <thead><tr><th>Horodatage</th><th>Login</th><th>Action</th><th>Détail</th><th>IP</th></tr></thead>
      <tbody>${journal.slice(0, 60).map((l) => `
        <tr><td style="white-space:nowrap">${echapper(l.horodatage)}</td><td>${echapper(l.login || '')}</td>
        <td>${echapper(l.action)}</td><td style="word-break:break-word">${echapper(l.detail || '')}</td>
        <td>${echapper(l.ip || '')}</td></tr>`).join('')}</tbody>`;
  } catch (erreur) { cible.innerHTML = `<div class="message message-erreur">${echapper(erreur.message)}</div>`; }

  async function reimporter(force) {
    try {
      const r = await api('/api/admin/reimporter', { method: 'POST', body: { force } });
      alerte('alerte', r.rapport.map((x) => `S${x.semaine} : ${x.statut}${x.motif ? ` (${x.motif})` : ''}`).join(' · '), 'succes');
    } catch (e) { alerte('alerte', e.message); }
  }
};

chargeurs.suivi();
dejaCharge.add('suivi');
