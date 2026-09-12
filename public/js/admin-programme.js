import { api, echapper, alerte, animationsReduites } from '/js/commun.js';

/**
 * Programmation de la campagne.
 *
 * Le catalogue compte une vingtaine de modules ; une campagne n'en joue que
 * quelques-uns. Cet ecran fait le lien : il donne a un module une date de
 * parution, et rien d'autre. Le contenu, lui, ne bouge pas - c'est ce qui
 * permet de changer le calendrier sans reecrire une question.
 *
 * La date se saisit a la main, defi par defi. Rien n'impose un defi par
 * semaine : deux peuvent paraitre le meme jour, ou quinze jours peuvent
 * separer deux themes.
 *
 * Un module deja joue se verrouille : ses participants ont repondu a des
 * questions qui doivent rester celles qu'ils ont vues.
 */

let donnees = null;
let auTermine = () => {};
let brouillon = [];

const amener = (element) =>
  element?.scrollIntoView({ behavior: animationsReduites() ? 'auto' : 'smooth', block: 'nearest' });

/**
 * Signale la premiere ligne fautive au lieu de ne donner qu'un compte.
 *
 * « 3 défi(s) sans date de parution » laissait chercher lesquels dans un
 * tableau de vingt lignes. Le champ se marque invalide et recoit le focus :
 * on tombe directement dessus, au clavier comme au lecteur d'ecran.
 */
function signalerChamp(champ, message) {
  alerte('alerte', message);
  if (!champ) return;
  const idMessage = 'erreur-programme';
  document.getElementById(idMessage)?.remove();
  const bloc = document.createElement('p');
  bloc.id = idMessage;
  bloc.className = 'message message-erreur';
  bloc.style.cssText = 'margin:.3rem 0 0;font-size:.82rem';
  bloc.textContent = message;
  champ.insertAdjacentElement('afterend', bloc);
  champ.setAttribute('aria-invalid', 'true');
  champ.setAttribute('aria-describedby', idMessage);
  champ.focus();
  amener(champ);
}

/** Remet les marques d'erreur a zero avant chaque tentative. */
function effacerSignalements(cible) {
  document.getElementById('erreur-programme')?.remove();
  cible?.querySelectorAll('[aria-invalid="true"]').forEach((c) => {
    c.removeAttribute('aria-invalid');
    c.removeAttribute('aria-describedby');
  });
}

export async function ecranProgramme(cible, onTermine) {
  if (onTermine) auTermine = onTermine;
  cible.innerHTML = '<p class="discret">Chargement du catalogue…</p>';
  try {
    donnees = await api('/api/admin/modules');
  } catch (e) {
    cible.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }
  brouillon = donnees.programme.map((p) => ({ ...p }));
  if (!brouillon.length) {
    brouillon = [{ module_code: '', ouvre_le: aujourdhui(), verrouille: false, participations: 0 }];
  }
  rendre(cible);
}

const parTheme = () => {
  const g = new Map();
  for (const m of donnees.modules) {
    if (!g.has(m.theme)) g.set(m.theme, []);
    g.get(m.theme).push(m);
  }
  return [...g];
};

/**
 * Numero d'ordre du module dans le catalogue.
 *
 * Vingt titres qui se ressemblent (« Mots de passe », « Mots de passe et
 * comptes ») se confondent d'une liste a l'autre. Un numero stable donne un
 * point de repere commun a la liste deroulante et au catalogue : on se dit
 * « le 14 » plutot que de relire quatre titres.
 */
const numero = (code) => donnees.modules.findIndex((m) => m.code === code) + 1;

const deuxChiffres = (n) => String(n).padStart(2, '0');

const options = (choisi) => parTheme().map(([theme, liste]) => `
  <optgroup label="${echapper(theme)}">
    ${liste.map((m) => `<option value="${echapper(m.code)}"${m.code === choisi ? ' selected' : ''}>${deuxChiffres(numero(m.code))} · ${echapper(m.titre)} — ${m.questions} questions</option>`).join('')}
  </optgroup>`).join('');

/** Date du jour au format ISO, pour faire paraitre un defi sur-le-champ. */
function aujourdhui() {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** « lundi 12 octobre » : un champ date seul ne dit pas quel jour de semaine. */
function enLettres(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
  return new Date(`${iso}T00:00:00Z`)
    .toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** Le programme se lit dans l'ordre des parutions, pas dans l'ordre de saisie. */
const parDate = (liste) => [...liste].sort((a, b) =>
  String(a.ouvre_le || '').localeCompare(String(b.ouvre_le || '')));

function rendre(cible) {
  const utilises = new Set(brouillon.map((b) => b.module_code).filter(Boolean));
  brouillon = parDate(brouillon);

  cible.innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--vert-clair)">
      <h2>Programme de la campagne</h2>
      <p class="discret" style="margin-top:-.3em">
        ${donnees.modules.length} modules sont prêts. Choisissez ceux que vous jouez, et la date
        à laquelle chacun paraît. Rien n'impose un défi par semaine : vous pouvez en faire
        paraître deux le même jour, ou espacer les thèmes comme vous l'entendez.
        <br>Un défi paraît <strong>tout seul à sa date</strong> : il n'y a rien à publier ensuite.
      </p>

      <div class="tableau-defilant" style="margin-top:1rem">
        <table class="admin">
          <caption class="sr-only">Programme de la campagne : date de parution et module</caption>
          <thead><tr><th scope="col" style="width:190px">Parution</th><th scope="col">Module</th>
            <th scope="col" style="width:110px"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody id="corps-programme">
            ${brouillon.map((b, i) => ligne(b, i)).join('')}
          </tbody>
        </table>
      </div>

      <div class="rang" style="margin-top:.8rem">
        <button class="btn btn-secondaire" id="btn-ajouter-defi" style="padding:.45rem .9rem;font-size:.85rem">
          + Ajouter un défi
        </button>
        <span class="discret ui" id="resume-programme"></span>
      </div>

      <div style="margin-top:1rem;padding:.9rem 1rem;border:1px dashed var(--bordure);border-radius:var(--rayon)">
        <p class="ui" style="margin:0 0 .5rem;font-size:.86rem"><strong>Recette</strong> —
          relire les vingt questionnaires un par un depuis l'aperçu est long, et l'aperçu ne
          dit rien du rendu réel. Ce bouton programme <strong>tous</strong> les modules et les
          fait paraître aujourd'hui : ils deviennent jouables pour de vrai.
          Les modules déjà joués ne bougent pas.
          <br>Pensez à effacer les données de test et à reprogrammer la vraie campagne ensuite.
        </p>
        <button class="btn btn-secondaire" id="btn-tout-ouvrir" style="padding:.4rem .8rem;font-size:.84rem">
          Programmer et ouvrir les ${donnees.modules.length} défis
        </button>
      </div>

      <div class="rang" style="margin-top:1.2rem;border-top:1px solid var(--bordure);padding-top:1.2rem">
        <button class="btn btn-principal" id="btn-enregistrer-programme">Enregistrer le programme</button>
      </div>
    </div>

    <details class="aide-admin" style="margin-bottom:1.5rem">
      <summary>Parcourir les ${donnees.modules.length} modules du catalogue</summary>
      <div id="catalogue" style="margin-top:.8rem">
        ${parTheme().map(([theme, liste]) => `
          <h3 style="margin:1rem 0 .4rem;font-size:.95rem">${echapper(theme)}</h3>
          <div class="tableau-defilant"><table class="admin">
            <caption class="sr-only">Modules du thème ${echapper(theme)}</caption>
            <tbody>${liste.map((m) => `
              <tr>
                <td class="ui discret" style="width:34px;text-align:right;font-variant-numeric:tabular-nums">${deuxChiffres(numero(m.code))}</td>
                <td style="width:34px;font-size:1.3rem" aria-hidden="true">${echapper(m.badge?.emoji || '•')}</td>
                <td>
                  <strong>${echapper(m.titre)}</strong>
                  ${utilises.has(m.code) ? '<span class="pastille-etat etat-ok" style="margin-left:.5rem">programmé</span>' : ''}
                  <br><span class="discret" style="font-size:.84rem">${echapper(m.accroche)}</span>
                </td>
                <td class="num discret" style="white-space:nowrap">${m.questions} q · ${m.points} pts · ${m.duree_minutes} min</td>
                <td style="width:90px"><button class="btn btn-secondaire" data-apercu="${echapper(m.code)}"
                        style="padding:.3rem .6rem;font-size:.8rem">Aperçu</button></td>
              </tr>`).join('')}
            </tbody>
          </table></div>`).join('')}
      </div>
    </details>

    <div id="apercu-module"></div>`;

  brancher(cible);
}

const ligne = (b, i) => {
  const doublon = b.module_code && brouillon.filter((x) => x.module_code === b.module_code).length > 1;
  const libelle = b.module_code
    ? `du module ${deuxChiffres(numero(b.module_code))}`
    : 'du défi';
  return `
  <tr data-index="${i}"${b.verrouille ? ' style="background:var(--vert-fonce-clair)"' : ''}>
    <td>
      <input type="date" class="date-defi" value="${echapper(b.ouvre_le || '')}"
             aria-label="Parution ${libelle}" required style="font-size:.86rem">
      <div class="discret" style="font-size:.78rem;margin-top:.2rem">
        ${echapper(enLettres(b.ouvre_le)) || 'date à saisir'}
      </div>
    </td>
    <td>
      <select class="module-defi" aria-label="Module ${libelle}"${b.verrouille ? ' disabled' : ''}>
        <option value="">— aucun —</option>
        ${options(b.module_code)}
      </select>
      ${b.verrouille
        ? `<div class="discret" style="font-size:.8rem;margin-top:.3rem">Verrouillé : ${b.participations} participation(s) enregistrée(s).</div>`
        : doublon
          ? '<div style="font-size:.8rem;margin-top:.3rem;color:var(--erreur)">Ce module est déjà programmé une autre fois.</div>'
          : ''}
    </td>
    <td>
      ${b.verrouille ? '' : `<button class="btn btn-secondaire" data-retirer="${i}"
             style="padding:.3rem .6rem;font-size:.8rem;border-color:var(--erreur);color:var(--erreur)">Retirer</button>`}
    </td>
  </tr>`;
};

function brancher(cible) {
  const n = brouillon.filter((b) => b.module_code).length;
  const q = brouillon.reduce((t, b) => {
    const m = donnees.modules.find((x) => x.code === b.module_code);
    return t + (m ? m.questions : 0);
  }, 0);
  document.getElementById('resume-programme').textContent =
    n ? `${n} défi(s), ${q} questions au total` : 'Aucun module programmé';

  cible.querySelectorAll('.module-defi').forEach((sel) => sel.addEventListener('change', () => {
    const i = Number(sel.closest('tr').dataset.index);
    const entree = brouillon[i];
    const precedent = entree.module_code;
    const titre = (code) => donnees.modules.find((m) => m.code === code)?.titre || code;

    // Remplacer un module deja place efface un choix precedent, souvent celui
    // d'une autre session : on le dit avant, pas apres.
    if (precedent && sel.value && sel.value !== precedent && !confirm(
      `Ce défi joue déjà « ${titre(precedent)} ».

`
      + `Le remplacer par « ${titre(sel.value)} » ?`
    )) {
      sel.value = precedent;
      return;
    }

    // Le doublon, lui, est deja signale sous la ligne et bloque a
    // l'enregistrement : une modale de plus n'apprendrait rien.
    entree.module_code = sel.value;
    rendre(cible);
  }));

  cible.querySelectorAll('.date-defi').forEach((champ) => champ.addEventListener('change', () => {
    brouillon[Number(champ.closest('tr').dataset.index)].ouvre_le = champ.value || '';
    rendre(cible);
  }));

  cible.querySelectorAll('[data-retirer]').forEach((b) => b.addEventListener('click', () => {
    brouillon.splice(Number(b.dataset.retirer), 1);
    rendre(cible);
  }));

  document.getElementById('btn-ajouter-defi').addEventListener('click', () => {
    // Une semaine apres la derniere parution : c'est le rythme le plus courant,
    // et il ne coute rien de le corriger puisque la date reste saisissable.
    const derniere = brouillon.map((b) => b.ouvre_le).filter(Boolean).sort().pop();
    brouillon.push({
      module_code: '',
      ouvre_le: derniere ? dansSeptJours(derniere) : aujourdhui(),
      verrouille: false,
      participations: 0,
    });
    rendre(cible);
  });

  cible.querySelectorAll('[data-apercu]').forEach((b) =>
    b.addEventListener('click', () => apercu(b.dataset.apercu)));

  // Tout ouvrir d'un coup : la recette a besoin des vingt defis jouables en
  // meme temps, ce que la programmation defi par defi rend fastidieuse.
  document.getElementById('btn-tout-ouvrir').addEventListener('click', async () => {
    const verrouilles = brouillon.filter((b) => b.verrouille);
    const deja = new Set(verrouilles.map((b) => b.module_code));
    const restants = donnees.modules.filter((m) => !deja.has(m.code));

    const saut = String.fromCharCode(10);
    if (!confirm([
      `${restants.length} module(s) vont être programmés et ouverts aujourd'hui.`,
      'Tous les agents pourront les jouer, et leurs résultats compteront.',
      'À ne faire que sur un environnement de test. Continuer ?',
    ].join(saut + saut))) return;

    // Les modules deja joues gardent leur date : la changer ne toucherait pas
    // aux participations, mais deplacerait sans raison un defi deja passe.
    brouillon = verrouilles.map((b) => ({ ...b }));
    for (const m of restants) {
      brouillon.push({
        module_code: m.code,
        ouvre_le: aujourdhui(),
        verrouille: false,
        participations: 0,
      });
    }

    rendre(cible);
    await enregistrer(false);
  });

  document.getElementById('btn-enregistrer-programme')
    .addEventListener('click', () => enregistrer(true));
}

/** Meme jour, sept jours plus tard, sans dependre du fuseau de l'utilisateur. */
function dansSeptJours(iso) {
  const [a, m, j] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1, j));
  d.setUTCDate(d.getUTCDate() + 7);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * Ecrit la programmation. `prevenirImmediats` demande confirmation quand une
 * date deja passee fait paraitre un defi sur-le-champ : c'est parfois voulu,
 * jamais evident. La recette, elle, vient de le confirmer.
 */
async function enregistrer(prevenirImmediats) {
  const corps = document.getElementById('corps-programme');
  effacerSignalements(corps);

  const retenus = brouillon.filter((b) => b.module_code);
  if (!retenus.length) {
    const premierModule = corps?.querySelector('.module-defi:not([disabled])');
    return signalerChamp(premierModule, 'Choisissez au moins un module.');
  }

  const sansDate = retenus.filter((b) => !/^\d{4}-\d{2}-\d{2}$/.test(b.ouvre_le || ''));
  if (sansDate.length) {
    const rang = brouillon.indexOf(sansDate[0]);
    const champ = corps?.querySelector(`tr[data-index="${rang}"] .date-defi`);
    return signalerChamp(champ, `${sansDate.length} défi(s) sans date de parution. `
      + "La date est ce qui fait paraître le défi : sans elle, il n'existe pas.");
  }

  const codes = retenus.map((p) => p.module_code);
  if (new Set(codes).size !== codes.length) {
    const doublon = codes.find((c, i) => codes.indexOf(c) !== i);
    // La seconde occurrence dans le brouillon : c'est celle qu'on vient de
    // poser, donc celle qu'on veut corriger.
    const rangs = brouillon.reduce((acc, b, i) => (b.module_code === doublon ? [...acc, i] : acc), []);
    const champ = corps?.querySelector(`tr[data-index="${rangs[1] ?? rangs[0]}"] .module-defi`);
    return signalerChamp(champ, 'Un même module est programmé deux fois.');
  }

  // Un defi parait a sa date. Programme sur une date passee, il parait donc
  // immediatement - ce qui est parfois voulu, jamais evident.
  const immediats = retenus.filter((b) => !b.verrouille && b.ouvre_le <= aujourdhui());

  if (prevenirImmediats && immediats.length) {
    const saut = String.fromCharCode(10);
    const titre = (code) => donnees.modules.find((m) => m.code === code)?.titre || code;
    const liste = immediats
      .map((b) => `  ${b.ouvre_le} — ${titre(b.module_code)}`)
      .join(saut);
    const message = [
      `${immediats.length} défi(s) ont une date déjà passée et paraîtront immédiatement aux agents :`,
      liste,
      'Continuer ?',
    ].join(saut + saut);
    if (!confirm(message)) return;
  }

  const programme = retenus.map((b) => ({ module_code: b.module_code, ouvre_le: b.ouvre_le }));

  try {
    const r = await api('/api/admin/programme', { method: 'PUT', body: { programme } });
    alerte('alerte', r.message, 'succes');
    auTermine();
  } catch (e) { alerte('alerte', e.message); }
}
/** Relecture complete d'un module, bonnes reponses comprises. */
async function apercu(code) {
  const zone = document.getElementById('apercu-module');
  zone.innerHTML = '<div class="carte"><p class="discret">Chargement…</p></div>';
  amener(zone);

  let m;
  try {
    m = await api(`/api/admin/modules/${encodeURIComponent(code)}`);
  } catch (e) {
    zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }

  zone.innerHTML = `
    <div class="carte">
      <div class="rang" style="justify-content:space-between;align-items:flex-start">
        <div>
          <h2 style="margin-bottom:.2em"><span aria-hidden="true">${echapper(m.badge?.emoji || '')}</span> ${echapper(m.titre)}</h2>
          <p class="discret" style="margin:0">${echapper(m.accroche)}</p>
        </div>
        <button class="btn btn-secondaire" id="btn-fermer-apercu" style="padding:.35rem .8rem;font-size:.8rem">Fermer</button>
      </div>
      <p style="margin-top:1rem">${echapper(m.intro)}</p>

      ${m.questions.map((q, i) => `
        <div class="editeur-question">
          <strong class="ui">${i + 1}. ${echapper(q.enonce)}</strong>
          ${q.contexte ? `<p class="discret" style="font-size:.86rem;margin:.3rem 0">${echapper(q.contexte)}</p>` : ''}
          <ul style="list-style:none;padding:0;margin:.5rem 0">
            ${q.reponses.map((r) => `
              <li style="padding:.15rem 0">
                <span aria-hidden="true">${r.correcte ? '✔' : '✕'}</span>
                <span${r.correcte ? ' style="font-weight:700"' : ''}>${echapper(r.libelle)}</span>
                <span class="sr-only">${r.correcte ? '(bonne réponse)' : '(mauvaise réponse)'}</span>
              </li>`).join('')}
          </ul>
          <p class="discret" style="font-size:.86rem;margin:0">${echapper(q.explication)}</p>
        </div>`).join('')}
    </div>`;

  document.getElementById('btn-fermer-apercu')
    .addEventListener('click', () => { zone.innerHTML = ''; });
}
