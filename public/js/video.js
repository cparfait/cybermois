/**
 * Reconnaissance d'une adresse video, partagee par le parcours et l'editeur.
 *
 * Cette fonction vivait en double : une copie complete dans defi.js, une copie
 * amputee dans admin.js. Les deux ont diverge, si bien que l'apercu de
 * l'editeur annoncait « Adresse non reconnue » sur un fichier tout juste
 * depose, alors que le parcours l'aurait lu sans broncher. Une seule
 * implementation, un seul verdict.
 *
 * YouTube pour la plupart des contenus, Dailymotion parce que c'est la que
 * Cybermalveillance.gouv.fr publie son kit de sensibilisation - la source la
 * plus legitime pour une collectivite, et il aurait ete absurde de l'exclure.
 *
 * On accepte watch?v=, youtu.be, /embed/, /shorts/ et /video/ : personne ne
 * retient laquelle de ces adresses est la bonne.
 */

/**
 * @param {string} url adresse saisie ou enregistree
 * @param {{ domainesAutorises?: string[], autoplay?: boolean }} options
 *   `domainesAutorises` : hebergeurs dont l'adresse est inseree telle quelle.
 *   `autoplay` : la lecture demarre seule, apres le clic de consentement.
 * @returns {{ hebergeur: string, id: string, local?: boolean,
 *             source?: string, embed?: string } | null}
 *   `null` quand rien n'est reconnu : l'adresse ne vaut alors qu'en lien.
 */
export function reconnaitreVideo(url, { domainesAutorises = [], autoplay = false } = {}) {
  const brut = String(url || '');
  const lecture = autoplay ? '&autoplay=1' : '';

  // Fichier depose par la collectivite : servi par ce serveur, sur le reseau
  // interne. Aucun tiers n'est appele, donc rien a consentir - la video se
  // lance directement, sans vignette intermediaire.
  if (/^\/videos\/[A-Za-z0-9._-]+$/.test(brut)) {
    return {
      hebergeur: 'la Ville',
      local: true,
      source: brut,
      id: brut.slice('/videos/'.length),
    };
  }

  const yt = brut.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  if (yt) {
    return {
      hebergeur: 'YouTube',
      id: yt[1],
      // Domaine sans cookie : le strict minimum une fois le consentement donne.
      embed: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt[1])}?rel=0${lecture}`,
    };
  }

  const dm = brut.match(/dailymotion\.com\/(?:embed\/)?video\/([A-Za-z0-9]+)|dai\.ly\/([A-Za-z0-9]+)/);
  if (dm) {
    const id = dm[1] || dm[2];
    return {
      hebergeur: 'Dailymotion',
      id,
      // Adresse du lecteur, sans passer par la redirection depuis
      // www.dailymotion.com : une redirection vers un autre domaine se heurte
      // a la politique de securite, et le lecteur reste vide sans rien dire.
      embed: `https://geo.dailymotion.com/player.html?video=${encodeURIComponent(id)}${lecture}`,
    };
  }

  // Plateforme dont on ne connait pas le format d'insertion - l'ANSSI, une
  // autre collectivite. On insere l'adresse telle quelle, a condition que son
  // domaine soit autorise : sinon le navigateur la bloquerait sans rien dire,
  // et mieux vaut un lien qui fonctionne qu'un cadre vide.
  try {
    const u = new URL(brut);
    if (u.protocol === 'https:' && domainesAutorises.includes(u.hostname)) {
      return { hebergeur: u.hostname, id: u.pathname.replace(/^\//, '') || u.hostname, embed: u.href };
    }
  } catch { /* adresse illisible : traitee comme un simple lien */ }

  return null;
}

/**
 * Adresse presentable en lien, ou `null` s'il faut se contenter du texte brut.
 *
 * Une adresse non reconnue finissait dans un `href` sans le moindre controle :
 * « javascript: » et « data: » y passaient, et un contenu de defi est saisi
 * depuis l'administration comme importe d'un module. On n'accepte donc que du
 * https, ou un fichier servi par ce serveur.
 */
export function lienVideoSur(url) {
  const brut = String(url || '').trim();
  if (/^\/videos\/[A-Za-z0-9._-]+$/.test(brut)) return brut;
  try {
    const u = new URL(brut);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}
