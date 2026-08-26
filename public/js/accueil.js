import { api, echapper, initialiserPage, alerte } from '/js/commun.js';

/**
 * Ce qu'on montre d'un defi qui n'est pas encore ouvert.
 *
 * Annoncer « Semaine 3 : Poste sous surveillance » trois semaines a l'avance
 * dissout l'effet de surprise, et donne le temps de reviser le mauvais sujet.
 * Le serveur ne renvoie donc plus rien du contenu ; il reste a occuper la
 * carte avec autre chose qu'un blanc.
 *
 * L'index vient du numero de semaine : le message ne change pas d'un
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
  const [defis, profil] = await Promise.all([api('/api/defis'), api('/api/profil')]);

  const faits = defis.filter((d) => d.participation).length;
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
      <p class="surtitre">Bonjour ${echapper((agent.nomComplet || '').split(' ')[0] || '')}</p>
      <h1>${echapper(titre)}</h1>
      <p style="max-width:52ch;margin:0">
        Vous jouez pour <strong>${echapper(agent.service)}</strong>.
        Chaque défi terminé lui rapporte des points. Comptez 5 à 8 minutes,
        et il n'y a rien à installer.
      </p>
      <div class="compteurs">
        <div>
          <div class="compteur-valeur">${profil.scoreTotal}</div>
          <div class="compteur-libelle">points gagnés</div>
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
    const classe = p ? 'termine' : defi.ouvert ? '' : 'verrouille';
    const pourcentage = p && p.scoreMax ? Math.round((p.score / p.scoreMax) * 100) : 0;

    const date = new Date(defi.ouvreLe + 'T00:00:00')
      .toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

    // Un defi a venir ne dit rien de lui-meme : le serveur ne renvoie ni son
    // titre ni son accroche. On affiche une carte scellee plutot qu'un trou.
    if (!defi.ouvert) {
      const t = TEASERS[(defi.semaine - 1) % TEASERS.length];
      return `
        <article class="carte carte-defi verrouille carte-scellee">
          <p class="numero-semaine">Semaine ${defi.semaine}</p>
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
      action = `<a class="btn btn-secondaire btn-bloc" href="/defi/${defi.semaine}">Revoir les corrections</a>`;
    } else {
      action = `<a class="btn btn-principal btn-bloc" href="/defi/${defi.semaine}">Je relève le défi</a>`;
    }

    return `
      <article class="carte carte-defi ${classe}">
        <p class="numero-semaine">Semaine ${defi.semaine}</p>
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
