import { api, echapper, initialiserPage, alerte, formaterDate } from '/js/commun.js';
import { chargerAgents } from '/js/admin-agents.js';
import { chargerConfiguration } from '/js/admin-config.js';
import { formulaireRecalcul, chargerRegistre } from '/js/admin-corrections.js';
import { ecranProgramme } from '/js/admin-programme.js';
import { filtrerAgents } from '/js/admin-agents.js';
import { formulaireServices } from '/js/admin-services.js';

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
      <p class="discret ui" style="margin:0 0 .5rem;font-size:.84rem">Cliquez sur un chiffre pour ouvrir le détail.</p>
      <div class="grille grille-3" style="margin-bottom:1.5rem">
        <button type="button" class="stat-admin stat-cliquable" data-aller="agents:actifs">
          <div class="v">${s.inscrits}</div><div class="l">agents dans la campagne</div></button>
        <button type="button" class="stat-admin stat-cliquable" data-aller="agents:connectes">
          <div class="v">${s.connectes}</div><div class="l">se sont connectés</div></button>
        <button type="button" class="stat-admin stat-cliquable" data-aller="agents:joueurs">
          <div class="v">${s.joueurs}</div><div class="l">agents ayant joué</div></button>
        <div class="stat-admin"><div class="v">${tauxGlobal} %</div><div class="l">taux de participation</div></div>
        <button type="button" class="stat-admin stat-cliquable" data-aller="defis">
          <div class="v">${s.participations}</div><div class="l">défis terminés</div></button>
        <button type="button" class="stat-admin stat-cliquable" data-aller="services">
          <div class="v">${s.services}</div><div class="l">services représentés</div></button>
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
    cible.querySelectorAll('[data-aller]').forEach((b) =>
      b.addEventListener('click', () => allerVers(b.dataset.aller)));
  } catch (erreur) { cible.innerHTML = `<div class="message message-erreur">${echapper(erreur.message)}</div>`; }
};

/**
 * Ouvre l'onglet qui repond a la tuile cliquee, deja filtre.
 *
 * Un chiffre sur un tableau de bord appelle toujours la meme question :
 * « lesquels ? ». Sans ce raccourci, il faut changer d'onglet puis refaire a
 * la main le filtre que la tuile designait deja.
 */
function allerVers(cible) {
  const [onglet, filtre] = cible.split(':');
  const index = onglets.findIndex((o) => o.nom === (onglet === 'services' ? 'agents' : onglet));
  if (index < 0) return;
  activer(index);

  if (onglet === 'agents') filtrerAgents(filtre || '');
  if (onglet === 'services') formulaireServices(() => { dejaCharge.delete('suivi'); });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Date du jour au format AAAA-MM-JJ, en heure locale. */
function aujourdhuiIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ============================================================== Défis */

chargeurs.defis = async () => {
  const cible = document.getElementById('panneau-defis');
  try {
    const defis = await api('/api/admin/defis');
    cible.innerHTML = `
      <details class="aide-admin">
        <summary>Comment fonctionne la planification</summary>
        <p>Le catalogue contient des modules prêts à jouer ; le tableau ci-dessous ne montre que
        ceux que vous avez <strong>programmés</strong>. Pour en ajouter, en retirer ou en changer
        l'ordre, utilisez « Programme de la campagne » juste en dessous — le catalogue complet s'y
        parcourt, avec un aperçu de chaque questionnaire.</p>
        <p>Chaque défi s'ouvre automatiquement à sa date d'ouverture, à condition d'être publié.
        Modifier la date de début de campagne décale les semaines de 7 jours en 7 jours.
        Un défi dépublié disparaît du portail sans que les participations soient perdues.</p>
      </details>

      <div id="zone-programme"></div>

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
        <button class="btn btn-secondaire" id="btn-replanifier">Replanifier les semaines</button>
      </div>

      <div class="tableau-defilant"><table class="admin">
        <thead><tr><th>Semaine</th><th>Titre</th><th>Ouverture</th><th>État</th><th>Actions</th></tr></thead>
        <tbody>${defis.map((d) => `
          <tr>
            <td>S${d.semaine}</td>
            <td>${echapper(d.titre)}</td>
            <td>${d.ouvre_le}</td>
            <td>
              <span class="pastille-etat ${d.publie ? 'etat-ok' : 'etat-ko'}">${d.publie ? 'Publié' : 'Masqué'}</span>
              ${!d.publie && d.ouvre_le <= aujourdhuiIso() ? `
                <br><span class="discret" style="font-size:.76rem;color:var(--alerte)">
                  sa date est passée : publiez-le pour qu'il s'ouvre
                </span>` : ''}
            </td>
            <td>
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem" data-editer="${d.semaine}">Modifier</button>
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem" data-publier="${d.semaine}" data-etat="${d.publie}">
                ${d.publie ? 'Masquer' : 'Publier'}
              </button>
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem"
                      data-tester-defi="${d.semaine}">Tester</button>
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem"
                      data-apercu-defi="${d.semaine}" data-ouvert="${d.apercuOuvert ? '1' : ''}">
                ${d.apercuOuvert ? 'Aperçu actif' : 'Lien d’aperçu'}
              </button>
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem"
                      data-recalculer="${d.semaine}" data-titre="${echapper(d.titre)}">Recalculer</button>
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem;border-color:var(--erreur);color:var(--erreur)"
                      data-supprimer-defi="${d.semaine}" data-titre="${echapper(d.titre)}">Supprimer</button>
            </td>
          </tr>`).join('')}
        </tbody></table></div>

      <div id="editeur" style="margin-top:2rem"></div>`;

    ecranProgramme(document.getElementById('zone-programme'), () => {
      dejaCharge.delete('defis'); dejaCharge.delete('suivi'); chargeurs.defis();
    });

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

    cible.querySelectorAll('[data-apercu-defi]').forEach((b) =>
      b.addEventListener('click', () => lienApercu(Number(b.dataset.apercuDefi), !!b.dataset.ouvert)));

    cible.querySelectorAll('[data-tester-defi]').forEach((b) =>
      b.addEventListener('click', () => testerDefi(Number(b.dataset.testerDefi), b)));

    // Apres correction d'une question, les scores deja enregistres restent
    // calcules sur l'ancien bareme : ce bouton les remet d'aplomb.
    cible.querySelectorAll('[data-recalculer]').forEach((b) =>
      b.addEventListener('click', () => formulaireRecalcul(
        Number(b.dataset.recalculer), b.dataset.titre,
        () => { dejaCharge.delete('suivi'); }
      )));

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
      <div class="rang" style="align-items:flex-end">
        <div class="champ-admin" style="max-width:170px"><label for="ed-duree">Durée annoncée (min)</label>
          <input type="number" id="ed-duree" value="${defi.duree_minutes}" min="1" max="60"></div>
        <div class="champ-admin" style="max-width:210px"><label for="ed-ouvre">Date de parution</label>
          <input type="date" id="ed-ouvre" value="${echapper(defi.ouvre_le || '')}"></div>
        <div class="champ-admin">
          <label style="display:flex;align-items:center;gap:.5rem;font-weight:600">
            <input type="checkbox" id="ed-publie" ${defi.publie ? 'checked' : ''}
                   style="width:20px;height:20px;accent-color:var(--vert-fonce)">
            Publié
          </label>
        </div>
      </div>
      <p class="discret" style="margin-top:-.4rem">
        Le défi n'apparaît aux agents qu'à partir de sa date de parution, et seulement s'il est
        publié. Vous pouvez donc préparer les quatre semaines à l'avance : chacune se dévoilera
        le jour venu. Les défis déjà parus restent accessibles quand les suivants s'ouvrent.
      </p>

      <h3 style="margin-top:1.5rem">Badge de ce défi</h3>
      <p class="discret" style="margin-top:-.3em">
        Décerné à partir de 80 % de réussite. Chaque défi porte le sien : si vous changez de
        thème, changez aussi le badge, sinon il ne voudra plus rien dire.
      </p>
      <div class="grille grille-2">
        <div class="champ-admin"><label for="ed-badge-libelle">Nom du badge</label>
          <input type="text" id="ed-badge-libelle" value="${echapper(defi.badge?.libelle || '')}" placeholder="Coffre-fort"></div>
        <div class="champ-admin" style="max-width:120px"><label for="ed-badge-emoji">Emoji</label>
          <input type="text" id="ed-badge-emoji" value="${echapper(defi.badge?.emoji || '')}" placeholder="🔐" maxlength="4"></div>
        <div class="champ-admin" style="grid-column:1/-1"><label for="ed-badge-description">Description</label>
          <input type="text" id="ed-badge-description" value="${echapper(defi.badge?.description || '')}"
                 placeholder="Défi mots de passe réussi à 80 % ou plus."></div>
      </div>

      <h3 style="margin-top:1.5rem">Vidéo d'introduction</h3>
      <p class="discret" style="margin-top:-.3em">
        Facultative, présentée avant les questions. <strong>Videz le champ pour la retirer.</strong>
        Rien n'est chargé chez l'hébergeur tant que l'agent ne clique pas.
      </p>
      <details class="aide-admin" style="margin-bottom:.8rem">
        <summary>Quelles adresses sont acceptées</summary>
        <p style="margin:.5rem 0">Deux hébergeurs, sous n'importe quelle forme d'adresse :</p>
        <ul class="ui" style="font-size:.86rem;margin:0">
          <li><strong>YouTube</strong> — <code>youtube.com/watch?v=…</code>,
            <code>youtu.be/…</code>, <code>youtube.com/embed/…</code>,
            <code>youtube.com/shorts/…</code></li>
          <li><strong>Dailymotion</strong> — <code>dailymotion.com/video/…</code>,
            <code>dai.ly/…</code></li>
        </ul>
        <p class="discret" style="margin:.6rem 0 0;font-size:.82rem">
          Les paramètres qui suivent l'adresse — playlist, horodatage, suivi de campagne —
          sont ignorés. Cybermalveillance.gouv.fr publie sur Dailymotion : c'est de là que
          viennent les vidéos fournies avec les modules.
        </p>
      </details>
      <div class="grille grille-2">
        <div class="champ-admin" style="grid-column:1/-1"><label for="ed-video-url">Adresse de la vidéo</label>
          <input type="url" id="ed-video-url" value="${echapper(defi.video?.url || '')}"
                 placeholder="https://www.dailymotion.com/video/x8rkmth"></div>
        <div class="champ-admin" style="grid-column:1/-1"><label for="ed-video-titre">Titre affiché</label>
          <input type="text" id="ed-video-titre" value="${echapper(defi.video?.titre || '')}"
                 placeholder="Mots de passe — campagne « Voilà » (0:56)"></div>
      </div>
      <div id="apercu-video-editeur" style="margin-top:.6rem"></div>

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

  brancherApercuVideo();

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
          ouvre_le: document.getElementById('ed-ouvre').value,
          publie: document.getElementById('ed-publie').checked,
          badge: {
            code: defi.badge?.code || null,
            libelle: document.getElementById('ed-badge-libelle').value.trim(),
            emoji: document.getElementById('ed-badge-emoji').value.trim(),
            description: document.getElementById('ed-badge-description').value.trim(),
          },
          // Toujours transmis, meme vide : c'est ce qui permet de retirer une
          // video. Un champ absent signifierait « ne pas changer ».
          video: {
            url: document.getElementById('ed-video-url').value.trim(),
            titre: document.getElementById('ed-video-titre').value.trim(),
          },
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
      <div class="carte" style="border-left:4px solid var(--vert-clair)">
        <h3>Registre des corrections</h3>
        <p class="discret">Toute modification de résultat, avec son auteur et son motif.</p>
        <a class="btn btn-secondaire" href="/api/admin/export/corrections.csv">Télécharger</a>
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

    const v = d.version || {};
    const quand = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR') : '—');

    cible.innerHTML = `
      ${v.perime ? `
        <div class="message message-alerte" style="margin-bottom:1.5rem">
          <strong>Cette instance ne fait pas tourner la dernière version.</strong>
          <p style="margin:.4rem 0 0">${echapper(v.message)}</p>
        </div>` : ''}

      <div class="carte" style="margin-bottom:1.5rem">
        <h3>Version en service</h3>
        <div class="tableau-defilant"><table class="admin"><tbody>
          <tr><td>Application</td><td>${echapper(v.version || '—')} · Node ${echapper(v.node || '—')}</td></tr>
          ${v.commit ? `
            <tr><td>Dernier changement</td><td>
              <code>${echapper(v.commit.court)}</code> — ${echapper(v.commit.sujet)}
              <br><span class="discret" style="font-size:.82rem">${quand(v.commit.date)}</span>
            </td></tr>` : ''}
          <tr><td>Serveur démarré</td><td>${quand(v.demarreLe)}</td></tr>
          <tr><td>Code modifié</td><td>${quand(v.codeModifieLe)}</td></tr>
        </tbody></table></div>
      </div>

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

      <h2 style="margin-top:2rem">Registre des corrections</h2>
      <div id="zone-registre"><p class="discret">Chargement…</p></div>

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

    chargerRegistre('zone-registre');

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

/**
 * Lien d'apercu d'un defi.
 *
 * Faire relire un questionnaire par la DPO, ou l'essayer avec un collegue,
 * suppose de pouvoir y jouer avant l'ouverture. Le lien le permet, et rien de
 * ce qui s'y joue ne compte : aucune participation n'est enregistree, donc ni
 * classement, ni statistiques, ni badges.
 *
 * Le jeton n'est montre qu'a sa creation. Regenerer en produit un nouveau et
 * invalide le precedent - c'est aussi la facon de reprendre la main sur un
 * lien qui aurait trop circule.
 */
async function lienApercu(semaine, dejaOuvert) {
  const zone = document.getElementById('editeur');
  zone.innerHTML = '<div class="carte"><p class="discret">Génération du lien…</p></div>';
  zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const r = await api(`/api/admin/defis/${semaine}/apercu`, { method: 'POST' });
    zone.innerHTML = `
      <div class="carte" style="border-left:4px solid var(--vert-clair)">
        <h2>Aperçu de la semaine ${r.semaine} — ${echapper(r.titre)}</h2>
        <p class="discret" style="margin-top:-.3em">
          Ce lien ouvre le défi <strong>avant sa date</strong>. Rien de ce qui s'y joue
          n'entre au classement, aux statistiques ni aux badges : aucune participation
          n'est enregistrée. Le destinataire doit être connecté au portail.
        </p>

        <div class="champ-admin" style="margin-top:1rem">
          <label for="lien-apercu">Lien à partager</label>
          <input type="text" id="lien-apercu" readonly value="${echapper(r.lien)}"
                 onclick="this.select()" style="font-family:var(--police-ui);font-size:.86rem">
        </div>

        <div class="rang" style="margin-top:1rem">
          <button class="btn btn-principal" id="btn-copier-apercu"
                  style="padding:.45rem .9rem;font-size:.85rem">Copier le lien</button>
          <button class="btn btn-secondaire" id="btn-revoquer-apercu"
                  style="padding:.45rem .9rem;font-size:.85rem;border-color:var(--erreur);color:var(--erreur)">
            Révoquer
          </button>
          <button class="btn btn-secondaire" id="btn-fermer-apercu"
                  style="padding:.45rem .9rem;font-size:.85rem">Fermer</button>
        </div>

        ${dejaOuvert ? `
          <p class="message message-alerte" style="margin-top:1rem">
            Un lien existait déjà pour ce défi : il vient d'être remplacé et ne fonctionne plus.
          </p>` : ''}
      </div>`;

    document.getElementById('btn-copier-apercu').addEventListener('click', async () => {
      const champ = document.getElementById('lien-apercu');
      champ.select();
      try {
        await navigator.clipboard.writeText(champ.value);
        alerte('alerte', 'Lien copié.', 'succes');
      } catch {
        // Le presse-papier est refuse hors contexte securise : la selection
        // laisse au moins le Ctrl+C a portee.
        alerte('alerte', 'Copie automatique refusée par le navigateur : le lien est sélectionné, faites Ctrl+C.');
      }
    });

    document.getElementById('btn-revoquer-apercu').addEventListener('click', async () => {
      try {
        const rep = await api(`/api/admin/defis/${semaine}/apercu`, { method: 'DELETE' });
        alerte('alerte', rep.message, 'succes');
        zone.innerHTML = '';
        dejaCharge.delete('defis'); chargeurs.defis();
      } catch (e) { alerte('alerte', e.message); }
    });

    document.getElementById('btn-fermer-apercu').addEventListener('click', () => {
      zone.innerHTML = '';
      dejaCharge.delete('defis'); chargeurs.defis();
    });
  } catch (e) {
    zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
  }
}

/**
 * Ouvre le defi dans les conditions reelles, sans que rien ne compte.
 *
 * Relire les questions dans l'editeur ne dit pas ce que verra un agent : les
 * animations, le rythme une question a la fois, la correction differee ne se
 * jugent qu'en jouant. Ce bouton cree le jeton d'apercu puis ouvre le parcours
 * dans un onglet - meme mecanique que le lien partageable, sans copier-coller.
 *
 * Aucune participation n'est ecrite : ni classement, ni statistiques, ni badges.
 */
async function testerDefi(semaine, bouton) {
  const libelle = bouton.textContent;
  bouton.disabled = true;
  bouton.textContent = 'Ouverture…';

  // La fenetre s'ouvre avant l'appel : demandee apres, elle passerait pour un
  // surgissement non sollicite et serait bloquee par le navigateur.
  const onglet = window.open('', '_blank');
  try {
    const r = await api(`/api/admin/defis/${semaine}/apercu`, { method: 'POST' });
    if (onglet) onglet.location = r.lien;
    else alerte('alerte', `Fenêtre bloquée. Le lien : ${r.lien}`);
    dejaCharge.delete('defis');
  } catch (e) {
    onglet?.close();
    alerte('alerte', e.message);
  } finally {
    bouton.disabled = false;
    bouton.textContent = libelle;
  }
}

/**
 * Aperçu de l'adresse vidéo saisie, dans l'éditeur de défi.
 *
 * Une adresse mal collée ne se verrait autrement qu'au moment où un agent
 * ouvre le défi — c'est-à-dire trop tard. On dit tout de suite si elle est
 * reconnue, et par quel hébergeur.
 */
function brancherApercuVideo() {
  const champ = document.getElementById('ed-video-url');
  const zone = document.getElementById('apercu-video-editeur');
  if (!champ || !zone) return;

  const reconnaitre = (url) => {
    const brut = String(url || '');
    const yt = brut.match(
      /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
    );
    if (yt) {
      return {
        hebergeur: 'YouTube', id: yt[1],
        embed: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt[1])}?rel=0`,
      };
    }
    const dm = brut.match(/dailymotion\.com\/(?:embed\/)?video\/([A-Za-z0-9]+)|dai\.ly\/([A-Za-z0-9]+)/);
    if (dm) {
      const id = dm[1] || dm[2];
      return {
        hebergeur: 'Dailymotion', id,
        embed: `https://www.dailymotion.com/embed/video/${encodeURIComponent(id)}`,
      };
    }
    return null;
  };

  const majApercu = () => {
    const valeur = champ.value.trim();
    if (!valeur) {
      zone.innerHTML = '<p class="discret" style="margin:0;font-size:.84rem">'
        + 'Aucune vidéo : le défi commence directement par les questions.</p>';
      return;
    }

    const v = reconnaitre(valeur);
    if (!v) {
      zone.innerHTML = `
        <div class="message message-alerte" style="margin:0">
          Adresse non reconnue. Attendu : une adresse YouTube ou Dailymotion —
          <code>watch?v=</code>, <code>youtu.be/</code>, <code>/embed/</code>,
          <code>/shorts/</code>, <code>dailymotion.com/video/</code> ou <code>dai.ly/</code>.
          Telle quelle, elle sera présentée comme un simple lien.
        </div>`;
      return;
    }

    // La prévisualisation se demande : la charger d'office ferait appeler
    // l'hébergeur à chaque frappe dans le champ.
    zone.innerHTML = `
      <div class="message message-succes" style="margin:0">
        Reconnu : <strong>${echapper(v.hebergeur)}</strong> — <code>${echapper(v.id)}</code>
        <button type="button" class="btn btn-secondaire" id="btn-previsualiser-video"
                style="padding:.25rem .7rem;font-size:.8rem;margin-left:.6rem">Prévisualiser</button>
      </div>
      <div id="cadre-apercu-video" style="margin-top:.6rem"></div>`;

    document.getElementById('btn-previsualiser-video').addEventListener('click', (e) => {
      e.target.disabled = true;
      document.getElementById('cadre-apercu-video').innerHTML = `
        <div style="position:relative;aspect-ratio:16/9;max-width:520px;border-radius:var(--rayon);overflow:hidden">
          <iframe src="${echapper(v.embed)}" title="Prévisualisation de la vidéo"
                  style="position:absolute;inset:0;width:100%;height:100%;border:0"
                  referrerpolicy="no-referrer" allowfullscreen loading="lazy"></iframe>
        </div>`;
    });
  };

  champ.addEventListener('input', majApercu);
  majApercu();
}
