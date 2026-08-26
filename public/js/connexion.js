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

formulaire.addEventListener('submit', async (evenement) => {
  evenement.preventDefault();
  const login = document.getElementById('login').value.trim();
  const motDePasse = document.getElementById('motDePasse').value;

  if (!login || !motDePasse) return afficher('Merci de saisir votre identifiant et votre mot de passe.');

  bouton.disabled = true;
  bouton.textContent = 'Connexion en cours...';
  afficher('');

  try {
    const reponse = await fetch('/api/connexion', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, motDePasse }),
    });
    const donnees = await reponse.json();
    if (!reponse.ok) throw new Error(donnees.erreur || 'Connexion impossible.');
    location.href = '/accueil';
  } catch (erreur) {
    afficher(erreur.message);
    document.getElementById('motDePasse').value = '';
    document.getElementById('motDePasse').focus();
    bouton.disabled = false;
    bouton.textContent = 'Se connecter';
  }
});
