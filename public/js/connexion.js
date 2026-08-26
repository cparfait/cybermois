const formulaire = document.getElementById('formulaire');
const bouton = document.getElementById('bouton');
const alerte = document.getElementById('alerte');

function afficher(message, variante = 'erreur') {
  alerte.innerHTML = message ? `<div class="message message-${variante}" style="margin-bottom:1rem">${message}</div>` : '';
}

if (new URLSearchParams(location.search).get('expire')) {
  afficher('Votre session a expiré. Merci de vous reconnecter.', 'info');
}

// Si une session est deja active, on va directement a l'accueil
fetch('/api/moi', { credentials: 'same-origin' })
  .then((r) => { if (r.ok) location.href = '/accueil'; })
  .catch(() => {});

// Deux modes de connexion : annuaire (par defaut) et compte local d'administration.
// Le compte local sert a configurer l'annuaire avant qu'il ne fonctionne,
// et a reprendre la main s'il devient injoignable.
let modeLocal = false;
const bascule = document.getElementById('bascule-mode');
const titre = document.getElementById('titre-connexion');
const sousTitre = document.getElementById('sous-titre-connexion');
const champLogin = document.getElementById('login');

bascule.addEventListener('click', () => {
  modeLocal = !modeLocal;
  titre.textContent = modeLocal ? 'Connexion administrateur local' : 'Connexion';
  sousTitre.textContent = modeLocal
    ? "Compte technique, indépendant de l'annuaire. Réservé à l'administration du portail."
    : 'Utilisez vos identifiants de session Windows habituels.';
  bascule.textContent = modeLocal ? 'Revenir à la connexion habituelle' : 'Connexion administrateur local';
  document.querySelector('.bloc-connexion').classList.toggle('mode-local', modeLocal);
  afficher('');
  champLogin.value = '';
  document.getElementById('motDePasse').value = '';
  champLogin.focus();
});

formulaire.addEventListener('submit', async (evenement) => {
  evenement.preventDefault();
  const login = document.getElementById('login').value.trim();
  const motDePasse = document.getElementById('motDePasse').value;

  if (!login || !motDePasse) return afficher('Merci de saisir votre identifiant et votre mot de passe.');

  bouton.disabled = true;
  bouton.textContent = 'Connexion en cours...';
  afficher('');

  try {
    const reponse = await fetch(modeLocal ? '/api/connexion-locale' : '/api/connexion', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, motDePasse }),
    });
    const donnees = await reponse.json();
    if (!reponse.ok) throw new Error(donnees.erreur || 'Connexion impossible.');
    // Un compte local sert a administrer : on l'emmene directement au bon endroit
    location.href = donnees.local ? '/administration' : '/accueil';
  } catch (erreur) {
    afficher(erreur.message);
    document.getElementById('motDePasse').value = '';
    document.getElementById('motDePasse').focus();
    bouton.disabled = false;
    bouton.textContent = 'Se connecter';
  }
});
