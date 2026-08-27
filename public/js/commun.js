/* Fonctions partagees par toutes les pages du portail Cybermois */

export const echapper = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export async function api(chemin, options = {}) {
  const reponse = await fetch(chemin, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (reponse.status === 401 && !chemin.endsWith('/moi')) {
    window.location.href = '/?expire=1';
    throw new Error('Session expirée');
  }

  const type = reponse.headers.get('content-type') || '';
  const donnees = type.includes('application/json') ? await reponse.json() : await reponse.text();
  if (!reponse.ok) throw new Error(donnees?.erreur || `Erreur ${reponse.status}`);
  return donnees;
}

export function alerte(conteneur, message, variante = 'erreur') {
  const el = typeof conteneur === 'string' ? document.getElementById(conteneur) : conteneur;
  if (!el) return;
  el.innerHTML = message
    ? `<div class="message message-${variante}" style="margin-bottom:1rem">${echapper(message)}</div>`
    : '';
}

/** Entete commun : logo, navigation, deconnexion. */
export function construireEntete(agent, pageActive) {
  const liens = [
    { href: '/accueil', libelle: 'Les défis' },
    { href: '/classement', libelle: 'Classement' },
    { href: '/profil', libelle: 'Mon profil' },
  ];
  if (agent?.estAdmin) liens.push({ href: '/administration', libelle: 'Administration' });

  return `
  <header class="entete-site">
    <div class="conteneur entete-interne">
      <img src="/img/Logo_Chatillon.png" alt="Ville de Châtillon" class="logo-ville">
      <p class="marque">Cybermois 2026</p>
      <nav class="nav-principale" aria-label="Navigation principale">
        ${liens.map((l) => `<a href="${l.href}"${l.href === pageActive ? ' aria-current="page"' : ''}>${l.libelle}</a>`).join('')}
        <button type="button" class="btn btn-secondaire" id="btn-deconnexion"
                style="padding:.45rem .9rem;font-size:.85rem;margin-left:.4rem">Déconnexion</button>
      </nav>
    </div>
  </header>`;
}

export function construirePied() {
  return `
  <footer class="pied-site">
    <div class="conteneur">
      <p style="margin:0 0 .4rem">Cybermois 2026 — Ville de Châtillon, Direction des systèmes d'information.</p>
      <p style="margin:0"><a href="/mentions">Mentions légales et protection des données</a> · <a href="/mentions#accessibilite">Accessibilité : partiellement conforme</a></p>
    </div>
  </footer>`;
}

export function brancherDeconnexion() {
  document.getElementById('btn-deconnexion')?.addEventListener('click', async () => {
    await api('/api/deconnexion', { method: 'POST' }).catch(() => {});
    window.location.href = '/';
  });
}

/** Charge l'agent connecte, redirige vers la connexion si la session a expire. */
export async function exigerSession() {
  try {
    return await api('/api/moi');
  } catch {
    window.location.href = '/?expire=1';
    throw new Error('non connecté');
  }
}

/** Prepare la page : entete + pied + deconnexion. */
export async function initialiserPage(pageActive) {
  const agent = await exigerSession();
  document.getElementById('entete').innerHTML = construireEntete(agent, pageActive);
  document.getElementById('pied').innerHTML = construirePied();
  brancherDeconnexion();
  return agent;
}

export const formaterDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
};

export const medaille = (rang) => ['🥇', '🥈', '🥉'][rang - 1] || '';

/** Petite pluie de confettis, desactivee si l'agent a demande la reduction des animations. */
export const animationsReduites = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Pluie de confettis.
 * `depuis` permet de partir d'un element plutot que du haut de l'ecran : une
 * petite salve au niveau de la reponse validee se remarque sans envahir la page,
 * alors qu'une pluie pleine hauteur est reservee a la fin du defi.
 */
export function confettis({ nombre = 70, duree = 2200, depuis = null } = {}) {
  if (animationsReduites()) return;

  const couleurs = ['#006e46', '#aec80c', '#4fbf8b', '#c8e04a', '#ffffff'];
  const zone = document.createElement('div');
  zone.setAttribute('aria-hidden', 'true');
  zone.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:999;overflow:hidden';
  document.body.appendChild(zone);

  const cadre = depuis?.getBoundingClientRect();

  for (let i = 0; i < nombre; i++) {
    const p = document.createElement('span');
    const taille = 6 + Math.random() * 7;

    if (cadre) {
      // Salve : projection vers le haut depuis l'element, puis retombee
      const angle = (Math.random() - 0.5) * Math.PI * 0.9;
      const force = 90 + Math.random() * 140;
      p.style.setProperty('--dx', `${Math.sin(angle) * force}px`);
      p.style.setProperty('--dy', `${-Math.abs(Math.cos(angle)) * force}px`);
      p.style.cssText += `position:absolute;left:${cadre.left + cadre.width * (0.2 + Math.random() * 0.6)}px;
        top:${cadre.top + cadre.height / 2}px;
        width:${taille}px;height:${taille * 0.5}px;background:${couleurs[i % couleurs.length]};
        border-radius:2px;animation:salve ${0.8 + Math.random() * 0.5}s cubic-bezier(.2,.7,.4,1) forwards`;
    } else {
      p.style.cssText = `position:absolute;top:-20px;left:${Math.random() * 100}%;
        width:${taille}px;height:${taille * 0.5}px;background:${couleurs[i % couleurs.length]};
        opacity:${0.7 + Math.random() * 0.3};border-radius:2px;
        animation:tomber ${1.4 + Math.random() * 1.4}s linear ${Math.random() * 0.6}s forwards`;
    }
    zone.appendChild(p);
  }

  if (!document.getElementById('style-confettis')) {
    const style = document.createElement('style');
    style.id = 'style-confettis';
    style.textContent = `
      @keyframes tomber { to { transform: translateY(105vh) rotate(720deg); opacity: 0 } }
      @keyframes salve {
        0%   { transform: translate(0, 0) rotate(0); opacity: 1 }
        100% { transform: translate(var(--dx), calc(var(--dy) + 90px)) rotate(540deg); opacity: 0 }
      }`;
    document.head.appendChild(style);
  }
  setTimeout(() => zone.remove(), duree + 800);
}
