import { api, echapper, alerte } from '/js/commun.js';

/**
 * Programmation de la campagne.
 *
 * Le catalogue compte une vingtaine de modules ; une campagne n'en joue que
 * quelques-uns. Cet ecran fait le lien : il place un module sur une semaine,
 * et rien d'autre. Le contenu, lui, ne bouge pas - c'est ce qui permet de
 * changer l'ordre des themes sans reecrire une question.
 *
 * Une semaine deja jouee se verrouille : ses participants ont repondu a des
 * questions qui doivent rester celles qu'ils ont vues.
 */

let donnees = null;
let auTermine = () => {};
let brouillon = [];

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
  if (!brouillon.length) brouillon = [{ semaine: 1, module_code: '', verrouille: false, participations: 0 }];
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

const options = (choisi) => parTheme().map(([theme, liste]) => `
  <optgroup label="${echapper(theme)}">
    ${liste.map((m) => `<option value="${echapper(m.code)}"${m.code === choisi ? ' selected' : ''}>${echapper(m.titre)} — ${m.questions} questions</option>`).join('')}
  </optgroup>`).join('');

/**
 * Date d'ouverture calculee comme le serveur : debut de campagne + 7 jours par
 * semaine. Elle sert de valeur de depart ; rien n'oblige a la garder.
 */
function calculee(semaine) {
  const [a, m, j] = (donnees.debut || '').split('-').map(Number);
  if (!a) return '';
  const d = new Date(Date.UTC(a, m - 1, j));
  d.setUTCDate(d.getUTCDate() + (semaine - 1) * 7);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** « lundi 12 octobre » : un champ date seul ne dit pas quel jour de semaine. */
function enLettres(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
  return new Date(`${iso}T00:00:00Z`)
    .toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

function rendre(cible) {
  const utilises = new Set(brouillon.map((b) => b.module_code).filter(Boolean));

  cible.innerHTML = `
    <div class="carte" style="margin-bottom:1.5rem;border-left:4px solid var(--vert-clair)">
      <h2>Programme de la campagne</h2>
      <p class="discret" style="margin-top:-.3em">
        ${donnees.modules.length} modules sont prêts. Choisissez ceux que vous jouez, et dans quel ordre.
        La date d'ouverture se calcule de semaine en semaine, mais chaque ligne se corrige :
        un jour férié ou une semaine de vacances n'attendent pas le lundi suivant.
        <br>Un défi s'ouvre <strong>tout seul à sa date</strong> : il n'y a rien à publier ensuite.
      </p>

      <div class="tableau-defilant" style="margin-top:1rem">
        <table class="admin">
          <thead><tr><th style="width:70px">Semaine</th><th style="width:190px">Ouverture</th><th>Module</th><th style="width:110px"></th></tr></thead>
          <tbody id="corps-programme">
            ${brouillon.map((b, i) => ligne(b, i)).join('')}
          </tbody>
        </table>
      </div>

      <div class="rang" style="margin-top:.8rem">
        <button class="btn btn-secondaire" id="btn-ajouter-semaine" style="padding:.45rem .9rem;font-size:.85rem">
          + Ajouter une semaine
        </button>
        <span class="discret ui" id="resume-programme"></span>
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
            <tbody>${liste.map((m) => `
              <tr>
                <td style="width:34px;font-size:1.3rem">${echapper(m.badge?.emoji || '•')}</td>
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
  return `
  <tr data-index="${i}"${b.verrouille ? ' style="background:var(--fond-doux)"' : ''}>
    <td><strong>S${b.semaine}</strong></td>
    <td>
      <input type="date" class="date-semaine" value="${echapper(b.ouvre_le || calculee(b.semaine))}"
             aria-label="Ouverture de la semaine ${b.semaine}"${b.verrouille ? ' disabled' : ''}
             style="font-size:.86rem">
      <div class="discret" style="font-size:.78rem;margin-top:.2rem">
        ${echapper(enLettres(b.ouvre_le || calculee(b.semaine)))}
        ${b.date_forcee ? ' · fixée à la main' : ''}
      </div>
    </td>
    <td>
      <select class="module-semaine" aria-label="Module de la semaine ${b.semaine}"${b.verrouille ? ' disabled' : ''}>
        <option value="">— aucun —</option>
        ${options(b.module_code)}
      </select>
      ${b.verrouille
        ? `<div class="discret" style="font-size:.8rem;margin-top:.3rem">Verrouillé : ${b.participations} participation(s) enregistrée(s).</div>`
        : doublon
          ? '<div style="font-size:.8rem;margin-top:.3rem;color:var(--erreur)">Ce module est déjà programmé une autre semaine.</div>'
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
    n ? `${n} semaine(s), ${q} questions au total` : 'Aucun module programmé';

  cible.querySelectorAll('.module-semaine').forEach((sel) => sel.addEventListener('change', () => {
    const i = Number(sel.closest('tr').dataset.index);
    const ligne = brouillon[i];
    const precedent = ligne.module_code;
    const titre = (code) => donnees.modules.find((m) => m.code === code)?.titre || code;

    // Remplacer un module deja place efface un choix precedent, souvent celui
    // d'une autre session : on le dit avant, pas apres.
    if (precedent && sel.value && sel.value !== precedent && !confirm(
      `La semaine ${ligne.semaine} joue déjà « ${titre(precedent)} ».

`
      + `Le remplacer par « ${titre(sel.value)} » ?`
    )) {
      sel.value = precedent;
      return;
    }

    // Le doublon, lui, est deja signale sous la ligne et bloque a
    // l'enregistrement : une modale de plus n'apprendrait rien.
    ligne.module_code = sel.value;
    rendre(cible);
  }));

  cible.querySelectorAll('.date-semaine').forEach((champ) => champ.addEventListener('change', () => {
    const b = brouillon[Number(champ.closest('tr').dataset.index)];
    // Une date effacee renvoie au calcul hebdomadaire : c'est le moyen de
    // revenir en arriere sans avoir a retrouver le lundi soi-meme.
    b.ouvre_le = champ.value || null;
    b.date_forcee = champ.value && champ.value !== calculee(b.semaine) ? champ.value : null;
    rendre(cible);
  }));

  cible.querySelectorAll('[data-retirer]').forEach((b) => b.addEventListener('click', () => {
    brouillon.splice(Number(b.dataset.retirer), 1);
    // Les semaines se renumerotent : un trou dans le calendrier n'aurait pas de sens.
    brouillon.forEach((x, i) => { x.semaine = i + 1; });
    rendre(cible);
  }));

  document.getElementById('btn-ajouter-semaine').addEventListener('click', () => {
    brouillon.push({ semaine: brouillon.length + 1, module_code: '', verrouille: false, participations: 0 });
    rendre(cible);
  });

  cible.querySelectorAll('[data-apercu]').forEach((b) =>
    b.addEventListener('click', () => apercu(b.dataset.apercu)));

  document.getElementById('btn-enregistrer-programme').addEventListener('click', async () => {
    const programme = brouillon.filter((b) => b.module_code)
      .map((b) => ({
        semaine: b.semaine,
        module_code: b.module_code,
        // Seule une date differente du calcul est transmise : conserver la
        // date calculee la figerait, et « Replanifier » n'aurait plus d'effet.
        ouvre_le: b.ouvre_le && b.ouvre_le !== calculee(b.semaine) ? b.ouvre_le : null,
      }));
    if (!programme.length) return alerte('alerte', 'Choisissez au moins un module.');

    const codes = programme.map((p) => p.module_code);
    if (new Set(codes).size !== codes.length) {
      return alerte('alerte', 'Un même module est programmé deux fois.');
    }

    // Un defi s'ouvre a sa date. Programme sur une date passee, il s'ouvre
    // donc immediatement - ce qui est parfois voulu, jamais evident.
    const p = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const aujourdhui = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;

    const immediats = brouillon.filter((b) => b.module_code && !b.verrouille
      && (b.ouvre_le || calculee(b.semaine)) <= aujourdhui);

    if (immediats.length) {
      const saut = String.fromCharCode(10);
      const liste = immediats
        .map((b) => `  Semaine ${b.semaine} — ${b.ouvre_le || calculee(b.semaine)}`)
        .join(saut);
      const message = [
        `${immediats.length} défi(s) ont une date déjà passée et s'ouvriront immédiatement aux agents :`,
        liste,
        'Continuer ?',
      ].join(saut + saut);
      if (!confirm(message)) return;
    }

    try {
      const r = await api('/api/admin/programme', { method: 'PUT', body: { programme } });
      alerte('alerte', r.message, 'succes');
      auTermine();
    } catch (e) { alerte('alerte', e.message); }
  });
}

/** Relecture complete d'un module, bonnes reponses comprises. */
async function apercu(code) {
  const zone = document.getElementById('apercu-module');
  zone.innerHTML = '<div class="carte"><p class="discret">Chargement…</p></div>';
  zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

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
          <h2 style="margin-bottom:.2em">${echapper(m.badge?.emoji || '')} ${echapper(m.titre)}</h2>
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
