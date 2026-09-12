import { echapper, contactsPublics, anneeDeCampagne } from '/js/commun.js';

/**
 * Page de connexion.
 *
 * Elle ne passe pas par api() de commun.js : la redirection sur 401 renverrait
 * ici, en boucle, et l'echec d'identification est precisement ce qu'on veut
 * afficher. Le reste des precautions, lui, est le meme.
 */

const formulaire = document.getElementById('formulaire');
const bouton = document.getElementById('bouton');
const zoneAlerte = document.getElementById('alerte');
const champLogin = document.getElementById('login');
const champMotDePasse = document.getElementById('motDePasse');

/**
 * Le message vient du serveur - ou d'un proxy interpose. Il finissait en
 * innerHTML sans echappement : une reponse d'erreur de l'infrastructure, ou un
 * message forge par un intermediaire, s'executait dans la page de connexion,
 * la ou le mot de passe est saisi.
 */
function afficher(message, variante = 'erreur') {
  zoneAlerte.innerHTML = message
    ? `<div class="message message-${variante}" style="margin-bottom:1rem">${echapper(message)}</div>`
    : '';
}

/**
 * Signale le champ fautif au lieu de laisser le message seul en haut de page.
 * Le message porte un identifiant, le champ le designe, et le focus s'y pose :
 * sans cela un lecteur d'ecran annonce une erreur sans dire ou.
 */
function effacerSignalement() {
  afficher('');
  for (const c of [champLogin, champMotDePasse]) {
    c.removeAttribute('aria-invalid');
    if (c.dataset.aideInitiale) c.setAttribute('aria-describedby', c.dataset.aideInitiale);
    else c.removeAttribute('aria-describedby');
  }
}

function signalerChamp(champ, message) {
  effacerSignalement();
  zoneAlerte.innerHTML = `
    <div class="message message-erreur" id="erreur-connexion" style="margin-bottom:1rem">
      ${echapper(message)}
    </div>`;
  if (!champ) return;
  champ.setAttribute('aria-invalid', 'true');
  champ.setAttribute('aria-describedby',
    [champ.dataset.aideInitiale || '', 'erreur-connexion'].filter(Boolean).join(' '));
  champ.focus();
}

// Le champ identifiant porte deja un aria-describedby vers son texte d'aide :
// on le retient pour ne pas l'ecraser en signalant une erreur.
for (const c of [champLogin, champMotDePasse]) {
  const initial = c.getAttribute('aria-describedby');
  if (initial) c.dataset.aideInitiale = initial;
}

if (new URLSearchParams(location.search).get('expire')) {
  afficher('Votre session a expiré. Merci de vous reconnecter.', 'info');
}

/**
 * Periode de la campagne, lue dans la configuration.
 * « Octobre 2026 » etait ecrit dans le gabarit : l'annee suivante, la page de
 * connexion annoncait encore la campagne precedente.
 */
(async () => {
  const cible = document.getElementById('periode-campagne');
  if (!cible) return;
  const { campagne } = await contactsPublics();
  const annee = anneeDeCampagne(campagne);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(campagne?.debut || ''))) {
    cible.textContent = `Campagne ${annee}`;
    return;
  }
  const mois = new Date(`${campagne.debut}T00:00:00Z`)
    .toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  cible.textContent = mois.charAt(0).toUpperCase() + mois.slice(1);
})();

// Si une session est deja active, on va directement a l'accueil
fetch('/api/moi', { credentials: 'same-origin' })
  .then((r) => { if (r.ok) location.href = '/accueil'; })
  .catch(() => {});

formulaire.addEventListener('submit', async (evenement) => {
  evenement.preventDefault();
  const login = champLogin.value.trim();
  const motDePasse = champMotDePasse.value;

  if (!login) {
    return signalerChamp(champLogin, 'Merci de saisir votre identifiant et votre mot de passe.');
  }
  if (!motDePasse) {
    return signalerChamp(champMotDePasse, 'Merci de saisir votre identifiant et votre mot de passe.');
  }

  bouton.disabled = true;
  bouton.textContent = 'Connexion en cours...';
  effacerSignalement();

  try {
    const reponse = await fetch('/api/connexion', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, motDePasse }),
    });

    // Un proxy ou un portail captif qui s'interpose repond en HTML : json()
    // levait alors « Unexpected token < », affiche tel quel a l'agent. On
    // regarde le type avant de decoder, comme le fait api() de commun.js.
    const type = reponse.headers.get('content-type') || '';
    let donnees = {};
    if (type.includes('application/json')) {
      donnees = await reponse.json().catch(() => ({}));
    } else if (!reponse.ok) {
      throw new Error(`Le serveur a répondu ${reponse.status} sans message exploitable.`);
    }

    if (!reponse.ok) throw new Error(donnees.erreur || 'Connexion impossible.');
    // Un compte local sert a administrer : on l'emmene directement au bon endroit
    location.href = donnees.local ? '/administration' : '/accueil';
  } catch (erreur) {
    champMotDePasse.value = '';
    signalerChamp(champMotDePasse, erreur.message);
    bouton.disabled = false;
    bouton.textContent = 'Se connecter';
  }
});
