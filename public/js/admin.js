import {
  api, echapper, initialiserPage, alerte, formaterDate,
  animationsReduites, contactsPublics,
} from '/js/commun.js';
import { chargerAgents, filtrerAgents } from '/js/admin-agents.js';
import { chargerConfiguration } from '/js/admin-config.js';
import { formulaireRecalcul, chargerRegistre } from '/js/admin-corrections.js';
import { ecranProgramme } from '/js/admin-programme.js';
import { formulaireServices } from '/js/admin-services.js';
import { reconnaitreVideo } from '/js/video.js';
import { NIVEAUX, niveauDe, verifierBareme, QUESTIONS_PAR_DEFI, TOTAL_DEFI } from '/js/bareme.js';

await initialiserPage('/administration');

/** Defilement respectueux du reglage « reduire les animations ». */
const glisser = () => (animationsReduites() ? 'auto' : 'smooth');
const remonter = () => window.scrollTo({ top: 0, behavior: glisser() });
const amener = (element, block = 'nearest') =>
  element?.scrollIntoView({ behavior: glisser(), block });

/**
 * Neutralise un bouton le temps d'un appel, et le retablit quoi qu'il arrive.
 *
 * Sans cela, un double clic - ou un clic impatient sur une liaison lente -
 * envoyait deux fois la meme creation, la meme suppression, le meme
 * enregistrement. Le `finally` compte autant que le reste : un bouton laisse
 * desactive apres une erreur oblige a recharger la page.
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

const NOMS = ['suivi', 'defis', 'agents', 'mails', 'exports', 'configuration', 'technique'];
const onglets = NOMS.map((nom) => ({
  nom,
  bouton: document.getElementById(`onglet-${nom}`),
  panneau: document.getElementById(`panneau-${nom}`),
}));

const chargeurs = {};
let dejaCharge = new Set();

// Fleches, Origine et Fin : le motif attendu d'un jeu d'onglets (RGAA 7.3).
// Sur sept onglets, atteindre « Technique » demandait six appuis sur la
// fleche droite.
onglets.forEach(({ bouton }, index) => {
  bouton.addEventListener('click', () => activer(index));
  bouton.addEventListener('keydown', (e) => {
    const dernier = onglets.length - 1;
    let suivant = null;
    if (e.key === 'ArrowRight') suivant = (index + 1) % onglets.length;
    else if (e.key === 'ArrowLeft') suivant = (index + dernier) % onglets.length;
    else if (e.key === 'Home') suivant = 0;
    else if (e.key === 'End') suivant = dernier;
    if (suivant === null) return;
    e.preventDefault();
    activer(suivant);
    onglets[suivant].bouton.focus();
  });
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

      <!-- L'alerte se declenchait sur « connectes === inscrits », ce qui est
           vrai dans une petite collectivite ou tout le monde est venu : elle
           accusait alors a tort la DSI de n'avoir rien importe. Le seul cas ou
           l'effectif manque vraiment est celui ou il n'y a personne. -->
      ${s.inscrits === 0 ? `
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

      <h2>Participation par défi</h2>
      <div class="tableau-defilant"><table class="admin">
        <caption class="sr-only">Participation et réussite moyenne, défi par défi</caption>
        <thead><tr><th scope="col">Parution</th><th scope="col">Défi</th>
          <th scope="col" class="num">Participants</th>
          <th scope="col" class="num">Réussite moyenne</th></tr></thead>
        <tbody>${s.parDefi.map((x) => `
          <tr><td>${echapper(x.ouvre_le)}</td><td>${echapper(x.titre)}</td>
          <td class="num">${x.participants}</td>
          <td class="num">${x.reussite_moyenne === null ? '—' : `${x.reussite_moyenne} %`}</td></tr>`).join('')}
        </tbody></table></div>

      <h2 style="margin-top:2rem">Classement des directions</h2>
      <div class="tableau-defilant"><table class="admin">
        <caption class="sr-only">Classement des directions par réussite</caption>
        <thead><tr><th scope="col">Rang</th><th scope="col">Direction</th>
          <th scope="col" class="num">Réussite</th><th scope="col" class="num">Points</th>
          <th scope="col" class="num">Participation</th>
          <th scope="col" class="num">Joueurs / inscrits</th></tr></thead>
        <tbody>${d.services.map((x, i) => `
          <tr><td>${i + 1}</td><td>${echapper(x.service)}</td>
          <td class="num">${x.pourcentage_moyen} %</td>
          <td class="num discret">${x.score_total} / ${x.points_possibles}</td>
          <td class="num">${x.taux_participation} %</td>
          <td class="num">${x.joueurs} / ${x.inscrits}</td></tr>`).join('')}
        </tbody></table></div>

      <h2 style="margin-top:2rem">Directions à relancer</h2>
      <p class="discret">Agents connectés n'ayant encore terminé aucun défi.</p>
      <div class="tableau-defilant"><table class="admin">
        <caption class="sr-only">Directions comptant des agents connectés mais inactifs</caption>
        <thead><tr><th scope="col">Direction</th><th scope="col" class="num">Agents inactifs</th></tr></thead>
        <tbody>${d.jamaisJoue.length
          ? d.jamaisJoue.map((x) => `<tr><td>${echapper(x.service)}</td><td class="num">${x.n}</td></tr>`).join('')
          : '<tr><td colspan="2" class="discret">Tout le monde a joué. Beau score.</td></tr>'}
        </tbody></table></div>

      <h2 style="margin-top:2rem">Derniers envois</h2>
      <div class="tableau-defilant"><table class="admin">
        <caption class="sr-only">Derniers envois de messages, avec leur résultat</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Défi</th>
          <th scope="col" class="num">Destinataires</th><th scope="col" class="num">Succès</th>
          <th scope="col">Erreur</th></tr></thead>
        <tbody>${d.derniersEnvois.length
          ? d.derniersEnvois.map((e) => `<tr>
              <td>${formaterDate(e.horodatage)}</td><td>${echapper(e.type)}</td>
              <td>${echapper(titreDefi(d.defis, e.defi_id))}</td><td class="num">${e.destinataires}</td>
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
  remonter();
}

/**
 * Le defi d'un envoi, designe par son titre.
 * L'historique garde l'identifiant ; un numero ne dit rien a personne, et le
 * defi peut avoir ete supprime depuis.
 */
const titreDefi = (defis, id) =>
  (id ? (defis.find((d) => d.id === id)?.titre || `défi ${id}`) : '—');

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
        la date, utilisez « Programme de la campagne » juste en dessous — le catalogue complet s'y
        parcourt, avec un aperçu de chaque questionnaire.</p>
        <p>Chaque défi paraît automatiquement à sa date de parution, à condition d'être publié.
        Cette date se fixe défi par défi : rien n'oblige à en publier un par semaine.
        Un défi dépublié disparaît du portail sans que les participations soient perdues.</p>
      </details>

      <div id="zone-programme"></div>

      <div class="rang" style="margin-bottom:1.5rem">
        <button class="btn btn-principal" id="btn-creer-defi">Créer un défi</button>
        <span class="discret ui">Il arrive masqué : rédigez les questions, puis publiez-le.</span>
      </div>

      <div id="zone-suppression"></div>

      <div class="tableau-defilant"><table class="admin">
        <caption class="sr-only">Défis programmés dans la campagne</caption>
        <thead><tr><th scope="col">N°</th><th scope="col">Parution</th><th scope="col">Titre</th>
          <th scope="col">État</th><th scope="col">Actions</th></tr></thead>
        <tbody>${defis.map((d) => `
          <tr>
            <td class="col-numero" title="Numéro du défi, celui de son adresse /defi/${d.id}">${d.id}</td>
            <td style="white-space:nowrap">${echapper(d.ouvre_le)}</td>
            <td>${echapper(d.titre)}</td>
            <td>
              <span class="pastille-etat ${d.publie ? 'etat-ok' : 'etat-ko'}">${d.publie ? 'Publié' : 'Masqué'}</span>
              ${d.hors_programme ? `
                <br><span class="discret" style="font-size:.76rem">
                  hors programme : donnez-lui une date pour qu'il reparaisse
                </span>` : ''}
              ${!d.publie && !d.hors_programme && d.ouvre_le <= aujourdhuiIso() ? `
                <br><span class="discret" style="font-size:.76rem;color:var(--alerte)">
                  sa date est passée : publiez-le pour qu'il paraisse
                </span>` : ''}
              ${d.contenu_modifie ? `
                <br><span class="discret" style="font-size:.76rem"
                      title="Le rechargement des contenus ne remplacera pas ce défi par son module.">
                  ✎ modifié ici — protégé du rechargement
                </span>` : ''}
              ${d.participations || d.essais ? `
                <br><span class="discret" style="font-size:.76rem">
                  ${d.participations} résultat${d.participations > 1 ? 's' : ''}${
                    d.essais ? `, ${d.essais} essai${d.essais > 1 ? 's' : ''}` : ''}
                </span>` : ''}
            </td>
            <td class="col-actions">
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem" data-editer="${d.id}">Modifier</button>
              <!-- « data-etat » est lu comme une chaine : ecrire directement
                   l'entier SQLite faisait dependre le bouton du fait que
                   l'API renvoie 1 plutot que true. On normalise ici. -->
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem" data-publier="${d.id}" data-etat="${d.publie ? 1 : 0}">
                ${d.publie ? 'Masquer' : 'Publier'}
              </button>
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem"
                      data-tester-defi="${d.id}">Tester</button>
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem"
                      data-apercu-defi="${d.id}" data-ouvert="${d.apercuOuvert ? '1' : ''}">
                ${d.apercuOuvert ? 'Aperçu actif' : 'Lien d’aperçu'}
              </button>
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem"
                      data-recalculer="${d.id}" data-titre="${echapper(d.titre)}">Recalculer</button>
              <button class="btn btn-secondaire" style="padding:.35rem .8rem;font-size:.8rem;border-color:var(--erreur);color:var(--erreur)"
                      data-supprimer-defi="${d.id}" data-titre="${echapper(d.titre)}">Supprimer</button>
            </td>
          </tr>`).join('')}
        </tbody></table></div>

      <div id="editeur" style="margin-top:2rem"></div>`;

    ecranProgramme(document.getElementById('zone-programme'), () => {
      dejaCharge.delete('defis'); dejaCharge.delete('suivi'); chargeurs.defis();
    });

    cible.querySelectorAll('[data-publier]').forEach((b) => b.addEventListener('click', () =>
      pendant(b, 'Enregistrement…', async () => {
        try {
          await api(`/api/admin/defis/${b.dataset.publier}/publication`, {
            method: 'POST', body: { publie: b.dataset.etat !== '1' },
          });
          dejaCharge.delete('defis'); chargeurs.defis();
        } catch (e) { alerte('alerte', e.message); }
      })));

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

    const boutonCreer = document.getElementById('btn-creer-defi');
    boutonCreer.addEventListener('click', () => {
      const titre = prompt('Titre du nouveau défi :');
      if (!titre?.trim()) return undefined;
      return pendant(boutonCreer, 'Création…', async () => {
        try {
          const r = await api('/api/admin/defis', { method: 'POST', body: { titre: titre.trim() } });
          alerte('alerte', r.message, 'succes');
          dejaCharge.delete('defis');
          await chargeurs.defis();
          ouvrirEditeur(r.id);
        } catch (e) { alerte('alerte', e.message); }
      });
    });

    cible.querySelectorAll('[data-supprimer-defi]').forEach((b) =>
      b.addEventListener('click', () => formulaireSuppressionDefi(
        defis.find((d) => d.id === Number(b.dataset.supprimerDefi)),
        () => { dejaCharge.delete('defis'); dejaCharge.delete('suivi'); chargeurs.defis(); }
      )));
  } catch (erreur) { cible.innerHTML = `<div class="message message-erreur">${echapper(erreur.message)}</div>`; }
};

/**
 * Suppression d'un defi, resultats compris.
 *
 * Le double « confirm » du navigateur ne disait pas ce qu'il emportait : le
 * premier ne parlait pas des resultats, le second affichait un message
 * d'erreur du serveur, ce qui ressemblait a un echec plutot qu'a une
 * question. On pose la question une fois, en montrant ce qui part - et en
 * rappelant qu'un defi en cours peut simplement se masquer.
 */
function formulaireSuppressionDefi(defi, onTermine) {
  const zone = document.getElementById('zone-suppression');
  const enCours = defi.publie && defi.ouvre_le <= aujourdhuiIso();
  const etat = enCours ? 'en cours' : defi.publie ? 'à venir' : 'masqué';
  const reels = defi.participations || 0;
  const essais = defi.essais || 0;

  zone.innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--erreur)">
      <h2>Supprimer « ${echapper(defi.titre)} » ?</h2>
      <p class="discret" style="margin-top:-.3em">
        Défi <strong>${etat}</strong>, paru le ${echapper(defi.ouvre_le)}.
      </p>

      ${reels || essais ? `
        <div class="message message-alerte" style="margin:1rem 0">
          <strong>${reels} résultat${reels > 1 ? 's' : ''} réel${reels > 1 ? 's' : ''}${
            essais ? ` et ${essais} essai${essais > 1 ? 's' : ''} d’entraînement` : ''} seront effacés.</strong>
          ${reels ? '<br>Les scores, les badges gagnés sur ce défi et les classements en seront modifiés. '
            + 'Cette suppression ne se rattrape pas.' : ''}
        </div>` : `
        <p class="discret" style="margin:1rem 0">Personne n’y a joué : rien ne sera perdu.</p>`}

      <p class="discret" style="font-size:.86rem">
        Sa parution est retirée du programme, pour qu’il ne revienne pas au prochain rechargement
        des contenus. Le module reste au catalogue et peut être reprogrammé plus tard.
      </p>

      <div class="rang" style="margin-top:1rem">
        <button class="btn btn-secondaire" id="btn-confirmer-suppr"
                style="border-color:var(--erreur);color:var(--erreur)">
          ${reels || essais
            ? `Supprimer le défi et ses ${reels + essais} résultat${reels + essais > 1 ? 's' : ''}`
            : 'Supprimer le défi'}
        </button>
        ${defi.publie ? `
          <button class="btn btn-principal" id="btn-masquer-plutot">Masquer seulement, garder les résultats</button>` : ''}
        <button class="btn btn-secondaire" id="btn-annuler-suppr">Annuler</button>
      </div>
    </div>`;

  amener(zone);

  const fermer = () => { zone.innerHTML = ''; };
  document.getElementById('btn-annuler-suppr').addEventListener('click', fermer);

  // Une suppression ne se rattrape pas : un second clic pendant l'appel
  // partait en double, et la seconde requete echouait sur un defi deja
  // supprime - avec un message d'erreur apres une suppression reussie.
  const masquer = document.getElementById('btn-masquer-plutot');
  masquer?.addEventListener('click', () => pendant(masquer, 'Masquage…', async () => {
    try {
      await api(`/api/admin/defis/${defi.id}/publication`, { method: 'POST', body: { publie: false } });
      fermer();
      alerte('alerte', `« ${defi.titre} » est masqué. Les résultats sont conservés.`, 'succes');
      onTermine();
    } catch (e) { alerte('alerte', e.message); }
  }));

  const confirmer = document.getElementById('btn-confirmer-suppr');
  confirmer.addEventListener('click', () => pendant(confirmer, 'Suppression…', async () => {
    try {
      const r = await api(`/api/admin/defis/${defi.id}`, {
        method: 'DELETE', body: { confirmerPerteResultats: true },
      });
      fermer();
      alerte('alerte', r.message, 'succes');
      onTermine();
    } catch (e) { alerte('alerte', e.message); }
  }));
}

async function ouvrirEditeur(id) {
  const zone = document.getElementById('editeur');
  zone.innerHTML = '<p class="discret">Chargement du défi…</p>';

  // Sans ce filet, une session expiree ou une panne laissait l'ecran sur
  // « Chargement du défi… » indefiniment : l'exception se perdait dans la
  // promesse d'un gestionnaire de clic, et rien ne le disait.
  let defi;
  let seuilBadge = 80;
  try {
    [defi, { seuilBadgeDefi: seuilBadge = 80 } = {}] = await Promise.all([
      api(`/api/admin/defis/${id}`),
      contactsPublics(),
    ]);
  } catch (e) {
    zone.innerHTML = `
      <div class="message message-erreur">
        Le défi n'a pas pu être chargé : ${echapper(e.message)}
      </div>`;
    return;
  }

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
        <div class="champ-admin" style="width:220px">
          <label for="difficulte-${i}">Difficulté</label>
          <select id="difficulte-${i}" data-champ="difficulte">
            ${NIVEAUX.map((n) => `<option value="${n.cle}" ${niveauDe(q).cle === n.cle ? 'selected' : ''}>${n.libelle} — ${n.points} points</option>`).join('')}
          </select>
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
              <button type="button" class="btn btn-secondaire" style="padding:.3rem .6rem;font-size:.78rem"
                      data-supprimer-reponse aria-label="Supprimer cette réponse"><span aria-hidden="true">✕</span></button>
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
      <h2>${echapper(defi.titre)} — édition</h2>
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
        publié. Vous pouvez donc préparer toute la campagne à l'avance : chaque défi se dévoilera
        le jour venu. Les défis déjà parus restent accessibles quand les suivants s'ouvrent.
      </p>

      <h3 style="margin-top:1.5rem">Badge de ce défi</h3>
      <p class="discret" style="margin-top:-.3em">
        <!-- Le seuil vient du serveur : ecrit en dur, il continuait d'annoncer
             80 % apres que la configuration l'eut change. -->
        Décerné à partir de ${Number(seuilBadge) || 80} % de réussite. Chaque défi porte le sien : si vous changez de
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
        <p class="message message-alerte" style="margin:.6rem 0 0;font-size:.82rem">
          <strong>Dailymotion refuse désormais son lecteur inséré</strong> : l'agent voit
          « Forbidden » à la place de la vidéo. Collez le lien puis cliquez sur
          « Télécharger sur le serveur » : la vidéo est rapatriée et servie par le portail,
          sans dépendre d'un hébergeur. Vous pouvez aussi déposer un fichier MP4.
        </p>
      </details>
      <div class="grille grille-2">
        <div class="champ-admin" style="grid-column:1/-1"><label for="ed-video-url">Adresse de la vidéo</label>
          <input type="url" id="ed-video-url" value="${echapper(defi.video?.url || '')}"
                 placeholder="https://www.dailymotion.com/video/x8rkmth"></div>
        <div class="champ-admin" style="grid-column:1/-1">
          <label for="ed-video-titre">Repère interne</label>
          <input type="text" id="ed-video-titre" value="${echapper(defi.video?.titre || '')}"
                 placeholder="Mots de passe — campagne « Voilà » (0:56)">
          <p class="discret" style="margin:.3rem 0 0;font-size:.78rem">
            Sert à reconnaître la vidéo depuis cet écran. <strong>Il n'est pas montré aux
            agents</strong> : un second titre sous celui du défi prêtait à confusion.
          </p>
        </div>
        <div class="champ-admin" style="grid-column:1/-1">
          <label for="ed-video-transcription">Transcription de la vidéo</label>
          <textarea id="ed-video-transcription" style="min-height:120px"
                    placeholder="Ce qui est dit et montré dans la vidéo, dans l'ordre.">${echapper(defi.video?.transcription || '')}</textarea>
          <p class="discret" style="margin:.3rem 0 0;font-size:.78rem">
            Affichée sous le lecteur, repliée. <strong>C'est la seule alternative pour un agent
            qui n'entend pas la vidéo</strong>, ou qui ne peut pas la regarder depuis son poste
            (RGAA 4.1, critère 4.3). Les retours à la ligne sont conservés.
          </p>
        </div>
      </div>
      <!-- L'input passe avant le label : c'est ce qui permet a la regle CSS
           « .depot-fichier:focus-visible + label » de rendre le focus visible,
           un champ fichier invisible ne pouvant pas le montrer lui-meme. -->
      <div class="rang" style="margin-top:.6rem;align-items:center;flex-wrap:wrap">
        <input type="file" id="ed-video-fichier" class="depot-fichier"
               accept="video/mp4,video/webm,video/ogg">
        <label for="ed-video-fichier" class="btn btn-secondaire"
               style="padding:.45rem .9rem;font-size:.85rem;cursor:pointer;margin:0">
          Déposer un fichier vidéo
        </label>
        <button type="button" class="btn btn-secondaire" id="btn-telecharger-video" hidden
                style="padding:.45rem .9rem;font-size:.85rem;margin:0">
          Télécharger sur le serveur
        </button>
        <button type="button" class="btn btn-secondaire" id="btn-retirer-video" hidden
                style="padding:.45rem .9rem;font-size:.85rem;margin:0;border-color:var(--erreur);color:var(--erreur)">
          Retirer la vidéo
        </button>
        <span class="discret ui" id="etat-envoi-video" style="font-size:.84rem">
          MP4, WebM ou OGV — servi depuis le serveur, sans passer par Internet.
          En remplaçant ou en retirant une vidéo, l'ancien fichier est effacé du serveur
          à l'enregistrement du défi.
        </span>
      </div>

      <div id="apercu-video-editeur" style="margin-top:.6rem"></div>

      <h3 style="margin-top:1.5rem">Questions</h3>
      <p class="discret" style="margin-top:-.4em">
        Chaque défi compte ${QUESTIONS_PAR_DEFI} questions pour ${TOTAL_DEFI} points :
        ${NIVEAUX.map((n) => `${n.attendues} ${n.libelle.toLowerCase()}${n.attendues > 1 ? 's' : ''} à ${n.points} points`).join(', ')}.
        Les points découlent de la difficulté — ils ne se saisissent pas. Deux défis pèsent ainsi
        le même poids au classement, quelle que soit la semaine où l'agent a joué.
      </p>
      <p id="etat-bareme" class="ui" style="font-weight:700;margin:.6rem 0"></p>
      <div id="liste-questions">${defi.questions.map(rendreQuestion).join('')}</div>
      <button type="button" class="btn btn-secondaire" id="btn-ajouter-question">+ Ajouter une question</button>

      <div class="rang" style="margin-top:1.5rem;border-top:1px solid var(--bordure);padding-top:1.2rem">
        <button type="button" class="btn btn-principal" id="btn-enregistrer">Enregistrer ce défi</button>
        <button type="button" class="btn btn-secondaire" id="btn-fermer">Fermer</button>
      </div>
      <p class="discret" style="margin-top:.8rem">
        Attention : enregistrer remplace toutes les questions de ce défi. Les participations déjà
        enregistrées conservent leur score, mais les corrections affichées seront celles du nouveau contenu.
      </p>
    </div>`;

  const liste = document.getElementById('liste-questions');

  /**
   * Etat du bareme, en continu. Le serveur refuse un defi qui ne le respecte
   * pas : le dire au moment ou l'on ecrit evite de le decouvrir en cliquant
   * sur « Enregistrer », dix questions plus tard.
   */
  const rafraichirBareme = () => {
    const niveaux = [...liste.querySelectorAll('[data-champ="difficulte"]')]
      .map((select) => ({ difficulte: select.value }));
    const v = verifierBareme(niveaux);
    const etat = document.getElementById('etat-bareme');
    etat.textContent = v.ok
      ? `✅ ${niveaux.length} questions · ${v.total} points · barème respecté`
      : `⚠️ ${niveaux.length} question(s) · ${v.total} points · ${v.ecarts.join(', ')}`;
    etat.style.color = v.ok ? 'var(--vert-fonce)' : 'var(--alerte)';
  };
  rafraichirBareme();
  liste.addEventListener('change', rafraichirBareme);

  liste.addEventListener('click', (e) => {
    if (e.target.matches('[data-supprimer-question]')) {
      if (liste.children.length <= 1) return alerte('alerte', 'Un défi doit comporter au moins une question.');
      e.target.closest('.editeur-question').remove();
      rafraichirBareme();
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
        <button type="button" class="btn btn-secondaire" style="padding:.3rem .6rem;font-size:.78rem"
                data-supprimer-reponse aria-label="Supprimer cette réponse"><span aria-hidden="true">✕</span></button>`;
      conteneur.appendChild(ligne);
      ligne.querySelector('input[type="text"]').focus();
    }
  });

  document.getElementById('btn-ajouter-question').addEventListener('click', () => {
    const i = liste.children.length;
    liste.insertAdjacentHTML('beforeend', rendreQuestion({
      enonce: '', contexte: '', multiple: true, difficulte: 'moyen', explication: '',
      reponses: [{ libelle: '', correcte: true }, { libelle: '', correcte: false }],
    }, i));
    amener(liste.lastElementChild, 'center');
    rafraichirBareme();
  });

  document.getElementById('btn-fermer').addEventListener('click', () => { zone.innerHTML = ''; });

  brancherApercuVideo(defi.illustration, defi.telechargementVideo);

  const boutonEnregistrer = document.getElementById('btn-enregistrer');
  boutonEnregistrer.addEventListener('click', () => pendant(boutonEnregistrer, 'Enregistrement…', async () => {
    const questions = [...liste.querySelectorAll('.editeur-question')].map((bloc) => ({
      enonce: bloc.querySelector('[data-champ="enonce"]').value.trim(),
      contexte: bloc.querySelector('[data-champ="contexte"]').value.trim() || null,
      difficulte: bloc.querySelector('[data-champ="difficulte"]').value,
      multiple: bloc.querySelector('[data-champ="multiple"]').checked,
      explication: bloc.querySelector('[data-champ="explication"]').value.trim(),
      reponses: [...bloc.querySelectorAll('.ligne-reponse')].map((l) => ({
        libelle: l.querySelector('input[type="text"]').value.trim(),
        correcte: l.querySelector('input[type="checkbox"]').checked,
      })).filter((r) => r.libelle),
    }));

    try {
      const r = await api(`/api/admin/defis/${defi.id}`, {
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
            transcription: document.getElementById('ed-video-transcription').value.trim(),
          },
          questions,
        },
      });
      alerte('alerte', r.message, 'succes');
      remonter();
    } catch (e) { alerte('alerte', e.message); }
  }));

  amener(zone, 'start');
}

/* ============================================================== Agents */

chargeurs.agents = chargerAgents;
chargeurs.configuration = chargerConfiguration;

/* ============================================================== Mails */

/** Les mails de campagne, tels que l'onglet Mails les presente. */
const ENVOIS = {
  ouverture: {
    nom: "Mail d'ouverture", quand: 'Premier jour', cible: 'chaque agent, une fois',
    confirmer: "Envoyer maintenant le mail d'ouverture à tous les agents ?",
  },
  annonce: {
    nom: 'Annonce de la semaine', quand: 'Lundis suivants', cible: 'chaque agent',
    confirmer: 'Envoyer maintenant l’annonce des défis de la semaine à tous les agents ?',
  },
  'relance-semaine': {
    nom: 'Relance', quand: 'Mercredi', cible: 'agents en retard sur la semaine',
    confirmer: 'Relancer maintenant les agents qui n’ont pas fait tous les défis des sept derniers jours ?',
  },
  resultats: {
    nom: 'Résultats', quand: 'Vendredi', cible: 'groupe de diffusion',
    confirmer: 'Envoyer maintenant les résultats du dernier défi paru au groupe de diffusion ?',
  },
};

chargeurs.mails = async () => {
  const cible = document.getElementById('panneau-mails');

  // La liste des defis remplace le choix d'un numero de semaine : les defis ne
  // sont plus numerotes, et un menu fige a « 1, 2, 3, 4 » designait de toute
  // facon des semaines qui pouvaient ne pas exister.
  // Un echec de chargement se disait « aucun défi programmé » : on partait
  // alors relancer une campagne dont on croyait le programme vide, et le
  // selecteur envoyait un identifiant vide au serveur. Panne et absence sont
  // deux situations differentes, et une seule appelle un appel a la DSI.
  let defis = [];
  let pannePorgramme = null;
  try { defis = await api('/api/admin/defis'); } catch (e) { pannePorgramme = e.message; }

  cible.innerHTML = `
    ${pannePorgramme ? `
      <div class="message message-erreur" style="margin-bottom:1rem">
        <strong>La liste des défis n'a pas pu être chargée</strong> — ${echapper(pannePorgramme)}.
        Aucun envoi n'est possible tant que ce n'est pas réglé : rechargez la page.
      </div>` : ''}

    <div id="zone-envois" class="carte" style="margin-bottom:1.5rem">
      <p class="discret">Chargement…</p>
    </div>

    <details class="aide-admin">
      <summary>Qui envoie quoi</summary>
      <p>Quand les envois automatiques sont actifs (tableau ci-dessus), l'application envoie :</p>
      <ul class="ui" style="font-size:.9rem">
        <li><strong>Ouverture (premier jour)</strong> — à chaque agent, le jour de parution du premier
          défi : ce qu'est le Cybermois, comment il se déroule, le calendrier, les données. Une seule fois.</li>
        <li><strong>Annonce (lundis suivants)</strong> — à chaque agent : les défis de la semaine, et
          ceux d'avant qu'il n'a pas encore faits, toujours ouverts. Une fois par semaine.</li>
        <li><strong>Relance (mercredi)</strong> — aux seuls agents qui n'ont pas terminé tous les défis
          parus ces sept derniers jours. Un seul message, qui liste ceux qui manquent.</li>
        <li><strong>Résultats (vendredi)</strong> — au groupe de distribution, sur le dernier défi paru.</li>
      </ul>
      <p>Chacun se déclenche aussi à la main ci-dessous. Pour les mails de semaine, le défi choisi
      sert à l'aperçu : il montre le message tel qu'il partira la semaine de ce défi.</p>
    </details>

    <div class="carte" style="margin-bottom:1.5rem">
      <div class="rang" style="align-items:flex-end">
        <div class="champ-admin" style="width:280px">
          <label for="mail-defi">Défi concerné</label>
          <select id="mail-defi">
            ${defis.length
              ? defis.map((d) => `<option value="${d.id}">${echapper(d.ouvre_le)} — ${echapper(d.titre)}</option>`).join('')
              : `<option value="">${pannePorgramme ? 'liste indisponible' : 'aucun défi programmé'}</option>`}
          </select>
        </div>
        <div class="champ-admin" style="width:200px">
          <label for="mail-type">Type de message</label>
          <select id="mail-type">
            <option value="ouverture">Ouverture (premier jour)</option>
            <option value="annonce">Annonce du lundi</option>
            <option value="relance-semaine">Relance du mercredi</option>
            <option value="resultats">Résultats du vendredi</option>
            <option value="relance">Relance d'un seul défi</option>
            <option value="lancement">Texte pour la DPO (copier-coller)</option>
          </select>
        </div>
        <div class="champ-admin"><button class="btn btn-principal" id="btn-apercu">Prévisualiser</button></div>
      </div>

      <div id="zone-actions" class="rang" style="border-top:1px solid var(--bordure);padding-top:1rem"></div>

      <div class="rang" style="align-items:flex-end;border-top:1px solid var(--bordure);padding-top:1rem;margin-top:1rem">
        <div class="champ-admin" style="width:320px">
          <label for="mail-test-adresse">Adresse de test</label>
          <input type="email" id="mail-test-adresse" autocomplete="email" placeholder="prenom.nom@chatillon92.fr">
        </div>
        <div class="champ-admin">
          <button class="btn btn-secondaire" id="btn-test-mail">Envoyer un test à cette adresse</button>
        </div>
      </div>
      <p class="discret" style="margin:.4rem 0 0;font-size:.82rem">
        Envoie le message choisi ci-dessus à cette seule adresse, avec « [TEST] » dans l'objet,
        pour le valider dans une vraie boîte. Il n'est pas compté comme envoyé : le vrai envoi
        reste à faire.
      </p>
    </div>

    <div id="zone-apercu"></div>`;

  document.getElementById('btn-apercu').addEventListener('click', apercu);
  document.getElementById('mail-type').addEventListener('change', majActions);
  document.getElementById('btn-test-mail').addEventListener('click', envoyerTest);
  majActions();
  afficherEnvois();

  /**
   * Un message a une seule adresse, pour le valider avant l'envoi reel. Le
   * serveur le construit exactement comme l'apercu.
   */
  async function envoyerTest() {
    const defiId = defiChoisi();
    if (!defiId) return;
    const champ = document.getElementById('mail-test-adresse');
    const adresse = champ.value.trim();
    if (!adresse || !champ.checkValidity()) {
      champ.focus();
      alerte('alerte', 'Saisissez une adresse de test valide.');
      return;
    }
    const bouton = document.getElementById('btn-test-mail');
    await pendant(bouton, 'Envoi…', async () => {
      try {
        const r = await api('/api/admin/mails/test', {
          method: 'POST',
          body: { type: document.getElementById('mail-type').value, defiId, adresse },
        });
        alerte('alerte', r.message, 'succes');
      } catch (e) { alerte('alerte', e.message); }
    });
  }

  /**
   * Les mails de campagne, chacun avec son interrupteur et son bouton
   * d'envoi. Couper l'automatique n'empeche jamais d'envoyer a la main : les
   * deux reglages sont independants, et c'est ce qui permet de tout piloter
   * soi-meme pendant la recette.
   */
  async function afficherEnvois() {
    const zone = document.getElementById('zone-envois');
    let etat;
    try { etat = await api('/api/admin/mails/etat'); } catch (e) {
      zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
      return;
    }
    // L'adresse de test proposee est la sienne, sans ecraser une saisie.
    const champTest = document.getElementById('mail-test-adresse');
    if (champTest && !champTest.value && etat.monAdresse) champTest.value = etat.monAdresse;
    // L'horodatage est ecrit en UTC par SQLite.
    const quand = (h) => new Date(`${h.replace(' ', 'T')}Z`).toLocaleString('fr-FR', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    const ligne = (m) => {
      const d = ENVOIS[m.type];
      const e = m.dernierEnvoi;
      return `<tr>
        <td><strong>${echapper(d.nom)}</strong><br>
          <span class="discret" style="font-size:.78rem">${echapper(d.quand)} — ${echapper(d.cible)}</span></td>
        <td><label class="ui" style="display:flex;gap:.4rem;align-items:center;cursor:pointer">
            <input type="checkbox" data-reglage="${echapper(m.cle)}" ${m.actif ? 'checked' : ''}>
            ${m.actif ? (etat.automatique ? 'oui' : 'oui, en pause') : 'non'}</label>
          <code style="font-size:.74rem">${echapper(m.planification)}</code></td>
        <td style="font-size:.84rem">${e
          ? `${echapper(quand(e.horodatage))}<br><span class="discret">${e.succes} / ${e.destinataires} envoyé(s)</span>${
            e.erreur ? `<br><span style="color:var(--erreur)">${echapper(e.erreur)}</span>` : ''}`
          : '<span class="discret">jamais</span>'}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-secondaire" style="padding:.3rem .7rem;font-size:.8rem" data-simuler="${m.type}">Simuler</button>
          <button class="btn btn-principal" style="padding:.3rem .7rem;font-size:.8rem" data-envoyer="${m.type}">Envoyer maintenant</button>
        </td></tr>`;
    };

    zone.innerHTML = `
      <h2 style="margin-top:0">Envois de la campagne</h2>
      ${etat.smtpConfigure ? '' : `<div class="message message-alerte" style="margin-bottom:.8rem">
        Aucun serveur SMTP n'est configuré (onglet Configuration) : aucun envoi n'est possible.</div>`}
      <label class="ui" style="display:flex;gap:.5rem;align-items:center;cursor:pointer;margin-bottom:.3rem">
        <input type="checkbox" data-reglage="smtp.actif" ${etat.automatique ? 'checked' : ''}>
        <strong>Envois automatiques</strong>
        <span class="pastille-etat ${etat.automatique ? 'etat-ok' : 'etat-ko'}">${etat.automatique ? 'actifs' : 'en pause'}</span>
      </label>
      <p class="discret" style="margin:0 0 1rem;font-size:.84rem">Interrupteur général : en pause, rien ne part
        tout seul, quels que soient les réglages ci-dessous. L'envoi à la main reste toujours possible.</p>
      <div class="tableau-defilant"><table class="admin">
        <caption class="sr-only">Mails de la campagne : envoi automatique et envoi à la main</caption>
        <thead><tr><th scope="col">Mail</th><th scope="col">Automatique</th>
          <th scope="col">Dernier envoi</th><th scope="col">À la main</th></tr></thead>
        <tbody>${etat.mails.map(ligne).join('')}</tbody></table></div>`;

    zone.querySelectorAll('[data-reglage]').forEach((c) => c.addEventListener('change', async () => {
      c.disabled = true;
      try {
        await api('/api/admin/configuration', { method: 'PUT', body: { valeurs: { [c.dataset.reglage]: c.checked } } });
        alerte('alerte', c.checked ? 'Envoi automatique activé.' : 'Envoi automatique coupé.', 'succes');
      } catch (e) { alerte('alerte', e.message); }
      afficherEnvois();
    }));
    zone.querySelectorAll('[data-simuler]').forEach((b) =>
      b.addEventListener('click', () => envoyerCampagne(b.dataset.simuler, true)));
    zone.querySelectorAll('[data-envoyer]').forEach((b) => b.addEventListener('click', () => {
      if (!confirm(ENVOIS[b.dataset.envoyer].confirmer)) return undefined;
      return pendant(b, 'Envoi…', async () => {
        await envoyerCampagne(b.dataset.envoyer, false);
        afficherEnvois();
      });
    }));
  }

  function majActions() {
    const type = document.getElementById('mail-type').value;
    const zone = document.getElementById('zone-actions');
    // Un seul endroit pour envoyer un mail de campagne : le tableau du haut.
    // Ici, on ne fait que le previsualiser.
    if (ENVOIS[type] && type !== 'resultats') {
      zone.innerHTML = `<span class="discret ui">Pour l'envoyer, utilisez « Envoyer maintenant »
        sur la ligne « ${echapper(ENVOIS[type].nom)} » du tableau ci-dessus.</span>`;
    } else if (type === 'lancement') {
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

  /** Sans defi choisi, l'URL se terminait par un identifiant vide. */
  function defiChoisi() {
    const valeur = document.getElementById('mail-defi').value;
    if (valeur) return valeur;
    alerte('alerte', pannePorgramme
      ? 'La liste des défis n’a pas pu être chargée : rechargez la page.'
      : 'Aucun défi n’est programmé : ajoutez-en un dans l’onglet Défis.');
    return null;
  }

  async function apercu() {
    const defiId = defiChoisi();
    if (!defiId) return;
    const type = document.getElementById('mail-type').value;
    try {
      dernierMail = await api(`/api/admin/mails/${type}/${defiId}`);
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

  /**
   * Ouverture, annonce, relance de la semaine : ils ne portent pas sur le defi
   * choisi mais sur la campagne. Un envoi deja fait se confirme une seconde
   * fois plutot que de partir en double par megarde.
   */
  async function envoyerCampagne(type, simulation, forcer = false) {
    try {
      const r = await api(`/api/admin/mails/campagne/${type}`, { method: 'POST', body: { simulation, forcer } });
      if (r.code === 'DEJA_ENVOYE' && !forcer) {
        if (confirm(`${r.message}\n\nLe renvoyer quand même à tous les agents ?`)) envoyerCampagne(type, false, true);
        return undefined;
      }
      if (!r.ok) return alerte('alerte', r.message || 'Envoi impossible.');
      // « Envoi effectué : 0 / 1 » se lisait comme un succes.
      if (!simulation && r.destinataires && !r.succes) {
        return alerte('alerte', `Aucun message n'est parti${r.erreur ? ` : ${r.erreur}` : ''}.`);
      }
      return alerte('alerte', simulation
        ? `Simulation : ${r.destinataires} destinataire(s)${r.defis ? ` — défis : ${r.defis.join(', ')}` : ''}.`
          + (r.dejaEnvoye ? ' Attention : ce mail est déjà parti.' : '')
        : `Envoi effectué : ${r.succes} / ${r.destinataires} message(s) transmis.${r.erreur ? ` Dernière erreur : ${r.erreur}` : ''}`,
      'succes');
    } catch (e) { return alerte('alerte', e.message); }
  }

  async function envoyer(quoi, simulation) {
    const defiId = defiChoisi();
    if (!defiId) return;
    try {
      const r = await api(`/api/admin/mails/${quoi}/${defiId}`, { method: 'POST', body: { simulation } });
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
        <!-- Tableau cle / valeur : l'intitule de chaque ligne est son en-tete,
             d'ou th scope="row". Sans cela, un lecteur d'ecran enonce deux
             cellules sans dire laquelle nomme l'autre. -->
        <div class="tableau-defilant"><table class="admin">
          <caption class="sr-only">Version de l'application en service</caption>
          <tbody>
          <tr><th scope="row">Application</th><td>${echapper(v.version || '—')} · Node ${echapper(v.node || '—')}</td></tr>
          ${v.commit ? `
            <tr><th scope="row">Dernier changement</th><td>
              <code>${echapper(v.commit.court)}</code> — ${echapper(v.commit.sujet)}
              <br><span class="discret" style="font-size:.82rem">${quand(v.commit.date)}</span>
            </td></tr>` : ''}
          <tr><th scope="row">Serveur démarré</th><td>${quand(v.demarreLe)}</td></tr>
          <tr><th scope="row">Code modifié</th><td>${quand(v.codeModifieLe)}</td></tr>
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
        <caption class="sr-only">Réglages appliqués par le serveur</caption>
        <tbody>
          <tr><th scope="row">Serveur LDAPS</th><td>${echapper(c.ldapUrl)}</td></tr>
          <tr><th scope="row">Base de recherche</th><td>${echapper(c.baseDn)}</td></tr>
          <tr><th scope="row">Source du service</th><td>${echapper(c.sourceService)}</td></tr>
          <tr><th scope="row">Groupe requis</th><td>${echapper(c.groupeRequis)}</td></tr>
          <tr><th scope="row">Envoi de mails</th><td>${c.envoiMailActif ? 'Actif' : 'Désactivé'}</td></tr>
          <tr><th scope="row">Groupe de diffusion</th><td>${echapper(c.groupeDiffusion)}</td></tr>
          <tr><th scope="row">Mail d'ouverture</th><td><code>${echapper(c.cronOuverture)}</code></td></tr>
          <tr><th scope="row">Annonce du lundi</th><td><code>${echapper(c.cronAnnonce)}</code></td></tr>
          <tr><th scope="row">Planification des relances</th><td><code>${echapper(c.cronRelance)}</code></td></tr>
          <tr><th scope="row">Planification des résultats</th><td><code>${echapper(c.cronResultats)}</code></td></tr>
          <tr><th scope="row">URL publique</th><td>${echapper(c.urlPublique)}</td></tr>
          <tr><th scope="row">Administrateurs</th><td>${echapper(c.administrateurs.join(', ') || '(aucun)')}</td></tr>
        </tbody></table></div>

      <h2 style="margin-top:2rem">Contenus</h2>
      <p class="discret">Recharge les modules de <code>content/modules/</code> dans les défis programmés.
      Les défis déjà joués, et ceux que vous avez modifiés dans l'éditeur, sont préservés.</p>
      <div class="message message-alerte" style="margin-bottom:.8rem">
        <strong>Forcer réécrit aussi les défis déjà joués</strong>, à partir du texte du fichier
        du module : les réponses enregistrées de leurs participants sont perdues, sans retour
        en arrière. Les défis modifiés dans l'éditeur ne sont jamais touchés, même en forçant.
      </div>
      <div class="rang">
        <button class="btn btn-secondaire" id="btn-reimport">Recharger les contenus</button>
        <button class="btn btn-secondaire" id="btn-reimport-force"
                style="border-color:var(--erreur);color:var(--erreur)">Recharger en forçant</button>
      </div>

      <h2 style="margin-top:2rem">Registre des corrections</h2>
      <div id="zone-registre"><p class="discret">Chargement…</p></div>

      <h2 style="margin-top:2rem">Journal récent</h2>
      <div class="tableau-defilant"><table class="admin" id="table-journal"><tbody><tr><td class="discret">Chargement…</td></tr></tbody></table></div>

      <h2 style="margin-top:2rem">Remettre la campagne à zéro</h2>
      <div class="message message-alerte">
        <strong>Efface</strong> les participations, les réponses, les tentatives en cours, les badges,
        l'historique des envois et les dates de première connexion : les statistiques et le classement
        repartent de zéro.<br>
        <strong>Conserve</strong> tout le paramétrage : annuaire Active Directory, messagerie, référentiel
        des directions, regroupements, exclusions, comptes agents et questionnaires des défis.
        À utiliser à l'issue de la phase de test, ou pour lancer une nouvelle campagne.
      </div>
      <p style="margin:.8rem 0">
        <label class="ui" style="display:flex;gap:.5rem;align-items:flex-start;cursor:pointer">
          <input type="checkbox" id="reinit-programme" style="margin-top:.25rem">
          <span><strong>Vider aussi le programme des parutions.</strong>
            Plus aucun défi n'est planifié : leurs questionnaires sont conservés, masqués
            jusqu'à ce que vous leur redonniez une date dans l'onglet Défis.</span>
        </label>
      </p>
      <button class="btn btn-secondaire" id="btn-reinit" style="border-color:var(--erreur);color:var(--erreur)">Remettre la campagne à zéro</button>`;

    document.getElementById('btn-reimport').addEventListener('click', () => reimporter(false));
    document.getElementById('btn-reimport-force').addEventListener('click', () => {
      const saut = String.fromCharCode(10);
      if (confirm([
        'Forcer le rechargement écrase les questions par le texte des fichiers de modules.',
        'Sont concernés les défis déjà joués : les réponses de leurs participants seront '
          + 'définitivement perdues. Les défis modifiés dans l\'éditeur, eux, ne sont pas touchés.',
        'Continuer ?',
      ].join(saut + saut))) reimporter(true);
    });

    document.getElementById('btn-reinit').addEventListener('click', async () => {
      // On enumere ce qui part : « participations et badges » laissait croire
      // que les dates de connexion survivaient, ce qui n'est plus le cas.
      const viderProgramme = document.getElementById('reinit-programme').checked;
      if (!confirm(
        'Remettre la campagne à zéro ?'
        + String.fromCharCode(10, 10)
        + 'Effacés : participations, réponses, tentatives en cours, badges, historique des envois '
        + 'et dates de première connexion'
        + (viderProgramme ? ', programme des parutions' : '')
        + '. Le classement repart de zéro.'
        + String.fromCharCode(10, 10)
        + 'Conservés : annuaire, messagerie, référentiel des directions, regroupements, exclusions, '
        + 'comptes agents, questionnaires des défis'
        + (viderProgramme ? ' (masqués jusqu’à leur reprogrammation)' : ' et programmation')
        + '.'
        + String.fromCharCode(10, 10)
        + 'Action irréversible.'
      )) return;
      try {
        const r = await api('/api/admin/reinitialiser', {
          method: 'POST', body: { confirmation: 'REINITIALISER', viderProgramme },
        });
        alerte('alerte', r.message, 'succes');
        // Le suivi et la liste des defis refletent l'ancien etat : on les
        // recharge a la prochaine ouverture.
        dejaCharge.delete('defis'); dejaCharge.delete('suivi');
      } catch (e) { alerte('alerte', e.message); }
    });

    chargerRegistre('zone-registre');

    const journal = await api('/api/admin/journal');
    document.getElementById('table-journal').innerHTML = `
      <caption class="sr-only">Soixante dernières entrées du journal des actions</caption>
      <thead><tr><th scope="col">Horodatage</th><th scope="col">Login</th><th scope="col">Action</th>
        <th scope="col">Détail</th><th scope="col">IP</th></tr></thead>
      <tbody>${journal.slice(0, 60).map((l) => `
        <tr><td style="white-space:nowrap">${echapper(l.horodatage)}</td><td>${echapper(l.login || '')}</td>
        <td>${echapper(l.action)}</td><td style="word-break:break-word">${echapper(l.detail || '')}</td>
        <td>${echapper(l.ip || '')}</td></tr>`).join('')}</tbody>`;
  } catch (erreur) { cible.innerHTML = `<div class="message message-erreur">${echapper(erreur.message)}</div>`; }

  async function reimporter(force) {
    try {
      const r = await api('/api/admin/reimporter', { method: 'POST', body: { force } });
      alerte('alerte', r.rapport.map((x) => `${x.module} : ${x.statut}${x.motif ? ` (${x.motif})` : ''}`).join(' · '), 'succes');
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
async function lienApercu(id, dejaOuvert) {
  const zone = document.getElementById('editeur');
  zone.innerHTML = '<div class="carte"><p class="discret">Génération du lien…</p></div>';
  amener(zone);

  try {
    const r = await api(`/api/admin/defis/${id}/apercu`, { method: 'POST' });
    zone.innerHTML = `
      <div class="carte" style="border-left:4px solid var(--vert-clair)">
        <h2>Aperçu du défi « ${echapper(r.titre)} »</h2>
        <p class="discret" style="margin-top:-.3em">
          Ce lien ouvre le défi <strong>avant sa date</strong>. Rien de ce qui s'y joue
          n'entre au classement, aux statistiques ni aux badges : aucune participation
          n'est enregistrée. Le destinataire doit être connecté au portail.
        </p>

        <div class="champ-admin" style="margin-top:1rem">
          <label for="lien-apercu">Lien à partager</label>
          <!-- « onclick » en attribut ne s'executait pas : la politique de
               securite de contenu du portail est « script-src 'self' », qui
               interdit le script en ligne. Le champ ne se selectionnait donc
               jamais, sans le moindre message. -->
          <input type="text" id="lien-apercu" readonly value="${echapper(r.lien)}"
                 style="font-family:var(--police-ui);font-size:.86rem">
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

    // Le lien se selectionne des qu'on l'atteint, a la souris comme au
    // clavier : c'est ce qui rend le Ctrl+C possible quand le presse-papier
    // est refuse hors contexte securise.
    const champLien = document.getElementById('lien-apercu');
    champLien.addEventListener('focus', () => champLien.select());
    champLien.addEventListener('click', () => champLien.select());

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
        const rep = await api(`/api/admin/defis/${id}/apercu`, { method: 'DELETE' });
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
async function testerDefi(id, bouton) {
  const libelle = bouton.textContent;
  bouton.disabled = true;
  bouton.textContent = 'Ouverture…';

  // La fenetre s'ouvre avant l'appel : demandee apres, elle passerait pour un
  // surgissement non sollicite et serait bloquee par le navigateur.
  const onglet = window.open('', '_blank');
  try {
    const r = await api(`/api/admin/defis/${id}/apercu`, { method: 'POST' });
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
function brancherApercuVideo(illustration = null, telechargement = false) {
  const champ = document.getElementById('ed-video-url');
  const zone = document.getElementById('apercu-video-editeur');
  const boutonTelecharger = document.getElementById('btn-telecharger-video');
  const boutonRetirer = document.getElementById('btn-retirer-video');
  if (!champ || !zone) return;

  // Hebergeurs autorises : ils servent a reconnaitre une adresse qui n'est ni
  // YouTube ni Dailymotion - l'ANSSI, une autre collectivite. Remplis plus bas,
  // de facon asynchrone ; leur absence ne bloque rien, la branche
  // correspondante reste simplement inactive.
  let domainesAutorises = [];

  const majApercu = () => {
    const valeur = champ.value.trim();
    // Le bouton de telechargement ne vaut que pour un lien YouTube ou
    // Dailymotion reconnu : cache par defaut, montre plus bas le cas echeant.
    if (boutonTelecharger) boutonTelecharger.hidden = true;
    if (boutonRetirer) boutonRetirer.hidden = !valeur;
    if (!valeur) {
      zone.innerHTML = illustration
        ? `<p class="discret" style="margin:0 0 .5rem;font-size:.84rem">Aucune vidéo :
            les agents verront l'illustration seule, sans bouton de lecture. Avec une vidéo,
            elle en devient l'affiche, un bouton de lecture posé dessus.</p>
          <img src="${echapper(illustration)}" alt="" style="width:100%;max-width:520px;border-radius:var(--rayon)">`
        : '<p class="discret" style="margin:0;font-size:.84rem">'
          + 'Aucune vidéo : le défi commence directement par les questions.</p>';
      return;
    }

    // Meme fonction que le parcours de l'agent : la copie locale avait perdu
    // les branches « fichier local » et « domaine autorise », si bien qu'un
    // fichier tout juste depose s'annoncait « Adresse non reconnue ».
    const v = reconnaitreVideo(valeur, { domainesAutorises });
    if (!v) {
      zone.innerHTML = `
        <div class="message message-alerte" style="margin:0">
          Adresse non reconnue. Attendu : une adresse YouTube ou Dailymotion —
          <code>watch?v=</code>, <code>youtu.be/</code>, <code>/embed/</code>,
          <code>/shorts/</code>, <code>dailymotion.com/video/</code> ou <code>dai.ly/</code> —
          ou un fichier déposé ici. Telle quelle, elle sera présentée comme un simple lien.
        </div>`;
      return;
    }

    // Fichier servi par la collectivite : rien a demander a un tiers, le
    // lecteur du navigateur suffit.
    if (v.local) {
      zone.innerHTML = `
        <div class="message message-succes" style="margin:0">
          Fichier servi par la Ville — <code>${echapper(v.id)}</code>
        </div>
        <div style="margin-top:.6rem;max-width:520px">
          <video src="${echapper(v.source)}" controls preload="metadata"
                 style="width:100%;border-radius:var(--rayon)"></video>
        </div>`;
      return;
    }

    // La prévisualisation se demande : la charger d'office ferait appeler
    // l'hébergeur à chaque frappe dans le champ.
    // Dailymotion repond « Forbidden » a son lecteur insere sans identifiant
    // de lecteur : l'adresse est bien reconnue, mais l'agent ne verra rien.
    const refusee = v.hebergeur === 'Dailymotion';
    const rapatriable = telechargement && ['YouTube', 'Dailymotion'].includes(v.hebergeur);
    if (boutonTelecharger) boutonTelecharger.hidden = !rapatriable;
    zone.innerHTML = `
      <div class="message ${refusee ? 'message-alerte' : 'message-succes'}" style="margin:0">
        Reconnu : <strong>${echapper(v.hebergeur)}</strong> — <code>${echapper(v.id)}</code>
        ${refusee ? `<br>Dailymotion refuse désormais son lecteur inséré : les agents verront
          « Forbidden ». ${rapatriable
            ? 'Cliquez sur « Télécharger sur le serveur » pour que le portail la serve lui-même.'
            : 'Déposez plutôt le fichier vidéo ci-dessous.'}` : ''}
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
                  referrerpolicy="strict-origin-when-cross-origin" allowfullscreen loading="lazy"></iframe>
        </div>`;
    });
  };

  brancherEnvoiVideo(champ, majApercu);
  if (telechargement) brancherTelechargementVideo(champ, majApercu);
  // Retirer vide le champ : c'est l'enregistrement du defi qui detache la
  // video et efface son fichier du serveur, rien ne part avant.
  boutonRetirer?.addEventListener('click', () => {
    champ.value = '';
    majApercu();
    const etat = document.getElementById('etat-envoi-video');
    if (etat) etat.textContent = 'Vidéo retirée. Enregistrez le défi pour confirmer : '
      + 'son fichier sera alors effacé du serveur.';
    champ.focus();
  });
  champ.addEventListener('input', majApercu);
  majApercu();

  api('/api/admin/configuration')
    .then((c) => {
      const brut = (c.parametres || []).find((x) => x.cle === 'videoDomaines')?.valeur;
      domainesAutorises = Array.isArray(brut)
        ? brut
        : String(brut || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      majApercu();
    })
    .catch(() => { /* on se contente des deux hebergeurs connus */ });
}

/**
 * Téléchargement par le serveur d'une vidéo YouTube ou Dailymotion.
 *
 * Le serveur rapatrie le fichier puis le sert lui-même, comme un fichier
 * déposé. L'opération prend de quelques secondes à quelques minutes : elle
 * tourne en tâche de fond, que l'on interroge jusqu'à sa fin.
 */
function brancherTelechargementVideo(champUrl, majApercu) {
  const bouton = document.getElementById('btn-telecharger-video');
  const etat = document.getElementById('etat-envoi-video');
  const champTitre = document.getElementById('ed-video-titre');
  if (!bouton || !etat) return;

  bouton.addEventListener('click', async () => {
    const lien = champUrl.value.trim();
    bouton.disabled = true;
    etat.textContent = 'Téléchargement lancé sur le serveur…';
    try {
      let tache = await api('/api/admin/videos/telechargement', { method: 'POST', body: { url: lien } });
      while (tache.etat === 'en cours') {
        etat.textContent = `${tache.message}${tache.progression ? ` ${tache.progression} %` : ''}`;
        await new Promise((r) => { setTimeout(r, 1500); });
        tache = await api(`/api/admin/videos/telechargement/${tache.id}`);
      }
      if (tache.etat !== 'termine') throw new Error(tache.message || 'Téléchargement impossible.');

      champUrl.value = tache.resultat.url;
      // Le titre d'origine fait un bon repère interne, s'il n'y en a pas déjà un.
      if (champTitre && !champTitre.value.trim() && tache.titre) champTitre.value = tache.titre;
      majApercu();
      const mo = Math.round(tache.resultat.octets / 1024 / 1024);
      etat.textContent = `Vidéo téléchargée (${mo} Mo) : elle est désormais servie par le portail.`;
      alerte('alerte', "Vidéo téléchargée sur le serveur. Enregistrez le défi pour qu'elle s'applique.", 'succes');
    } catch (e) {
      etat.textContent = `Échec du téléchargement : ${e.message}`;
      alerte('alerte', etat.textContent);
    } finally {
      bouton.disabled = false;
    }
  });
}

/**
 * Dépôt d'un fichier vidéo servi par la collectivité.
 *
 * Cinq cents agents qui regardent la même vidéo sur YouTube en même temps,
 * cela se voit sur le lien Internet d'une commune. Un fichier déposé ici est
 * servi depuis le serveur : le trafic reste interne, et aucun tiers n'est
 * appelé — donc plus de vignette de consentement côté agent non plus.
 *
 * L'envoi passe par XMLHttpRequest et non fetch : lui seul rend la progression,
 * et sur trente méga-octets une barre immobile ferait croire à un blocage.
 */
function brancherEnvoiVideo(champUrl, majApercu) {
  const entree = document.getElementById('ed-video-fichier');
  const etat = document.getElementById('etat-envoi-video');
  if (!entree || !etat) return;

  entree.addEventListener('change', () => {
    const fichier = entree.files?.[0];
    if (!fichier) return;

    const mo = (fichier.size / 1024 / 1024).toFixed(1);
    etat.textContent = `Envoi de ${fichier.name} (${mo} Mo)…`;

    const donnees = new FormData();
    donnees.append('fichier', fichier);

    const requete = new XMLHttpRequest();
    requete.open('POST', '/api/admin/videos');

    requete.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      etat.textContent = `Envoi… ${Math.round((e.loaded / e.total) * 100)} %`;
    });

    requete.addEventListener('load', () => {
      // Une session expiree pendant l'envoi d'un fichier de trente Mo se
      // traduisait par « Échec de l'envoi (code 401) » : on restait sur un
      // ecran d'administration devenu inerte, sans comprendre qu'il suffisait
      // de se reconnecter. Meme traitement que api() de commun.js.
      if (requete.status === 401) {
        window.location.href = '/?expire=1';
        return;
      }

      let r = {};
      try { r = JSON.parse(requete.responseText); } catch { /* reponse illisible */ }

      if (requete.status >= 200 && requete.status < 300 && r.url) {
        champUrl.value = r.url;
        majApercu();
        etat.textContent = r.message || 'Vidéo déposée.';
        alerte('alerte', "Vidéo déposée. Enregistrez le défi pour qu'elle s'applique.", 'succes');
      } else if (requete.status === 413 && !r.erreur) {
        // Refus du reverse proxy, et non de l'application : sa page d'erreur
        // n'est pas du JSON. « Échec de l'envoi (code 413) » ne disait pas
        // qu'il fallait relever client_max_body_size dans nginx.
        etat.textContent = `Fichier de ${mo} Mo refusé par le reverse proxy, avant même `
          + "d'atteindre le portail. Une directive « client_max_body_size » trop basse a dû "
          + "être ajoutée dans l'onglet Advanced de nginx-proxy-manager : retirez-la, la "
          + 'valeur par défaut suffit (docs/deploiement-portainer.md).';
        alerte('alerte', etat.textContent);
      } else {
        etat.textContent = r.erreur || `Échec de l'envoi (code ${requete.status}).`;
        alerte('alerte', etat.textContent);
      }
      entree.value = '';
    });

    requete.addEventListener('error', () => {
      etat.textContent = "L'envoi a échoué : le serveur n'a pas répondu.";
      entree.value = '';
    });

    requete.send(donnees);
  });
}
