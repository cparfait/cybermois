import { api, echapper, initialiserPage, alerte } from '/js/commun.js';

/**
 * Ce qu'on montre d'un defi qui n'est pas encore ouvert.
 *
 * Annoncer « Poste sous surveillance » trois semaines a l'avance dissout
 * l'effet de surprise, et donne le temps de reviser le mauvais sujet.
 * Le serveur ne renvoie donc plus rien du contenu ; il reste a occuper la
 * carte avec autre chose qu'un blanc.
 *
 * L'index vient de l'identifiant du defi : le message ne change pas d'un
 * rechargement a l'autre, ce qui serait deroutant.
 */
const TEASERS = [
  { icone: '🛰️', titre: 'Transmission programmée', texte: 'Un signal chiffré est en approche. Rien à décoder pour l’instant.' },
  { icone: '🔐', titre: 'Sous scellés', texte: 'Ce défi existe. Il ne parlera pas avant l’heure.' },
  { icone: '🧩', titre: 'Dossier classé', texte: 'Le contenu est verrouillé. Revenez le jour dit, on vous ouvrira.' },
  { icone: '📡', titre: 'Signal détecté', texte: 'Quelque chose se prépare du côté de la DSI. Patience.' },
  { icone: '🧊', titre: 'En cours de déchiffrement', texte: 'Les questions existent déjà. Elles refroidissent encore.' },
  { icone: '🕵️', titre: 'Confidentiel défense', texte: 'Même vous n’avez pas l’habilitation. Pas encore.' },
];

const agent = await initialiserPage('/accueil');

try {
  const [defis, profil, affichage] = await Promise.all([
    api('/api/defis'), api('/api/profil'), api('/api/defis/affichage'),
  ]);

  // Quatre cartes sur une ligne se lisent mal ; le nombre de colonnes se regle
  // dans l'administration. La largeur minimale se deduit du reglage : elle
  // borne le nombre de colonnes sans le forcer, si bien qu'un ecran etroit
  // repasse de lui-meme sur une seule colonne.
  const largeurMini = Math.round(1040 / (affichage.defisParLigne || 2));
  document.getElementById('defis').style.gridTemplateColumns =
    `repeat(auto-fit, minmax(min(100%, ${largeurMini}px), 1fr))`;

  const faits = defis.filter((d) => d.participation).length;
  // Points rapportes au total atteignable a ce jour - la meme lecture que
  // sur la page de classement, pour ne pas donner deux chiffres du meme
  // resultat.
  const reussite = profil.pointsPossibles
    ? Math.round((profil.scoreTotal * 100) / profil.pointsPossibles) : 0;
  const ouverts = defis.filter((d) => d.ouvert).length;
  const progression = ouverts ? Math.round((faits / defis.length) * 100) : 0;

  // Le titre suit l'avancement plutot que de repeter le nom du service, qui
  // tenait sur deux lignes des qu'il etait long et ecrasait tout le bandeau.
  const titre = faits === 0
    ? 'À vous de jouer'
    : faits >= defis.length
      ? 'Vous avez tout relevé'
      : faits >= ouverts
        ? 'Vous êtes à jour'
        : `Il vous reste ${ouverts - faits} défi${ouverts - faits > 1 ? 's' : ''} à relever`;

  document.getElementById('heros').innerHTML = `
    <section class="heros">
      <p class="surtitre">Bonjour ${echapper(agent.prenom || agent.nomComplet || '')}</p>
      <h1>${echapper(titre)}</h1>
      <p style="max-width:calc(100% - 100px);margin:0;font-size:.95rem;text-wrap:pretty">
        Vous jouez pour <strong>${echapper(agent.service)}</strong> : chaque défi terminé lui rapporte des points.
      </p>
      <div class="compteurs">
        <div>
          <div class="compteur-valeur">${reussite} <span style="font-size:1.1rem;opacity:.75">%</span></div>
          <div class="compteur-libelle">de réussite${profil.pointsPossibles
            ? ` · ${profil.scoreTotal}/${profil.pointsPossibles} pts` : ''}</div>
        </div>
        <div>
          <div class="compteur-valeur">${faits}<span style="font-size:1.1rem;opacity:.75">/${defis.length}</span></div>
          <div class="compteur-libelle">défis terminés</div>
        </div>
        <div>
          <div class="compteur-valeur">${profil.rangService.rang ? `${profil.rangService.rang}<span style="font-size:1.1rem;opacity:.75">e</span>` : '—'}</div>
          <div class="compteur-libelle">rang de mon service</div>
        </div>
        <div>
          <div class="compteur-valeur">${profil.badges.filter((b) => b.obtenu).length}</div>
          <div class="compteur-libelle">badges obtenus</div>
        </div>
      </div>
      <div class="jauge" role="img" aria-label="Progression : ${progression} pour cent"><span style="width:${progression}%"></span></div>
    </section>`;

  document.getElementById('defis').innerHTML = defis.map((defi) => {
    const p = defi.participation;
    // Le defi jouable se signale : sur quatre cartes, il faut voir d'un
    // regard laquelle attend quelque chose.
    const aJouer = defi.ouvert && !p;
    const classe = p ? 'termine' : defi.ouvert ? 'a-jouer' : 'verrouille';
    const pourcentage = p && p.scoreMax ? Math.round((p.score / p.scoreMax) * 100) : 0;

    const date = new Date(defi.ouvreLe + 'T00:00:00')
      .toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

    // Un defi a venir ne dit rien de lui-meme : le serveur ne renvoie ni son
    // titre ni son accroche. On affiche une carte scellee plutot qu'un trou.
    if (!defi.ouvert) {
      const t = TEASERS[defi.id % TEASERS.length];
      return `
        <article class="carte carte-defi verrouille carte-scellee">
          <p class="etiquette-defi">Prochain défi</p>
          <div class="sceau" aria-hidden="true"><span class="sceau-icone">${t.icone}</span></div>
          <h3 style="margin-bottom:.2em">${echapper(t.titre)}</h3>
          <p class="accroche" style="margin-top:0">${echapper(t.texte)}</p>
          <div class="pied-carte">
            <p class="discret" style="margin:0">🔒 Descellement le ${date}</p>
          </div>
        </article>`;
    }

    let action;
    if (p) {
      // Relire, pas rejouer : le lien menait au questionnaire, qui repartait
      // en entrainement et effacait de l'ecran ce qu'on venait chercher.
      action = `
        <a class="btn btn-secondaire btn-bloc" href="/revoir/${defi.id}">Revoir mes réponses</a>
        <a class="lien-discret" href="/defi/${defi.id}"
           style="display:block;text-align:center;margin-top:.5rem;font-size:.84rem">
          Refaire pour m'entraîner
        </a>`;
    } else if (defi.repondues > 0) {
      // Reprendre plutot que recommencer : la page du defi rouvre d'elle-meme
      // a la premiere question sans reponse, encore faut-il que l'accueil le
      // dise - sinon on croit devoir tout refaire, et on remet a plus tard.
      const reste = (defi.nbQuestions || 0) - defi.repondues;
      action = `
        <a class="btn btn-principal btn-bloc" href="/defi/${defi.id}">Continuer mon défi</a>
        <p class="discret" style="text-align:center;margin:.5rem 0 0;font-size:.84rem">
          ${defi.repondues} question${defi.repondues > 1 ? 's' : ''} déjà validée${defi.repondues > 1 ? 's' : ''}${
        reste > 0 ? ` · il en reste ${reste}` : ''}
        </p>`;
    } else {
      action = `<a class="btn btn-principal btn-bloc" href="/defi/${defi.id}">Je relève le défi</a>`;
    }

    return `
      <article class="carte carte-defi ${classe}">
        ${aJouer ? '<span class="halo" aria-hidden="true"></span>' : ''}
        <p class="etiquette-defi">Paru le ${date}${aJouer ? ' · à relever' : ''}</p>
        <h3 style="margin-bottom:.2em">${echapper(defi.titre)}</h3>
        <p class="accroche" style="margin-top:0">${echapper(defi.accroche)}</p>
        <p class="meta-defi">
          <span>⏱️ ${defi.dureeMinutes} min</span>
          <span>❓ ${defi.nbQuestions} questions</span>
        </p>
        ${p ? `<p class="resultat-defi">✅ Terminé — ${p.score} / ${p.scoreMax} points (${pourcentage} %)</p>` : ''}
        <div class="pied-carte">${action}</div>
      </article>`;
  }).join('');
} catch (erreur) {
  alerte('alerte', erreur.message);
  document.getElementById('defis').innerHTML = '';
}
