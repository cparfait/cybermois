import { api, echapper, alerte } from '/js/commun.js';

/**
 * Editeur visuel des textes de mail.
 *
 * Le texte se modifie comme dans un traitement de texte. Les donnees qui
 * changent d'un agent a l'autre (prenom, calendrier, bouton...) y figurent
 * sous forme d'etiquettes grises qu'on ne peut pas retoucher, seulement
 * deplacer ou supprimer : elles deviennent {{nom}} a l'enregistrement, et le
 * serveur les remplace a l'envoi.
 *
 * Pas de bibliotheque : la politique de securite des pages n'accepte que les
 * scripts du portail, et un mail n'a besoin que de paragraphes, titres,
 * gras, listes et liens. Le serveur nettoie de toute facon ce qu'il recoit.
 */

let modeles = null;
// Retire l'ecouteur de selection de l'editeur precedent, rouvert ou ferme.
let detacher = null;

async function chargerModeles() {
  modeles = await api('/api/admin/modeles-mail');
  return modeles;
}

/* ------------------------------------------------- Conversion du texte */

const etiquette = (v) => (v.bloc
  ? `<div class="donnee-bloc" contenteditable="false" data-donnee="${echapper(v.nom)}">${echapper(v.libelle)}</div>`
  : `<span class="donnee" contenteditable="false" data-donnee="${echapper(v.nom)}">${echapper(v.libelle)}</span>`);

/** Texte stocke ({{nom}}) vers le contenu de l'editeur (etiquettes). */
function versEditeur(corps, variables) {
  const parNom = Object.fromEntries(variables.map((v) => [v.nom, v]));
  return corps
    .replace(/<p>\s*\{\{(\w+)\}\}\s*<\/p>/g, (tout, nom) => (parNom[nom]?.bloc ? etiquette(parNom[nom]) : tout))
    .replace(/\{\{(\w+)\}\}/g, (tout, nom) => (parNom[nom] ? etiquette({ ...parNom[nom], bloc: false }) : tout));
}

/** Contenu de l'editeur vers le texte stocke. */
function versTexteStocke(editeur) {
  const copie = editeur.cloneNode(true);
  copie.querySelectorAll('[data-donnee]').forEach((el) => {
    const repere = document.createTextNode(`{{${el.dataset.donnee}}}`);
    if (el.classList.contains('donnee-bloc')) {
      const p = document.createElement('p');
      p.append(repere);
      el.replaceWith(p);
    } else {
      el.replaceWith(repere);
    }
  });
  return copie.innerHTML;
}

/* ------------------------------------------------------------- Ecran */

/**
 * Ouvre l'editeur du mail `type` dans `zone`.
 *
 * @param options.defiId       defi servant a l'apercu et au test
 * @param options.adresseTest  lit l'adresse de test au moment du clic
 * @param options.zoneApercu   ou afficher l'apercu
 */
export async function ouvrirEditeur(zone, type, { defiId, adresseTest, zoneApercu }) {
  detacher?.();
  detacher = null;
  zone.innerHTML = '<div class="carte"><p class="discret">Chargement du texte…</p></div>';
  try { await chargerModeles(); } catch (e) {
    zone.innerHTML = `<div class="message message-erreur">${echapper(e.message)}</div>`;
    return;
  }
  const modele = modeles.find((m) => m.type === type);
  if (!modele) {
    zone.innerHTML = '<div class="message message-erreur">Ce mail n’a pas de texte modifiable.</div>';
    return;
  }

  const enLigne = modele.variables.filter((v) => !v.bloc);
  const quand = (h) => new Date(`${h.replace(' ', 'T')}Z`)
    .toLocaleString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

  zone.innerHTML = `
    <section class="carte editeur-mail-carte" aria-labelledby="titre-editeur-mail">
      <div class="rang" style="justify-content:space-between;align-items:flex-start">
        <div>
          <h2 id="titre-editeur-mail" style="margin-bottom:.2em">Modifier : ${echapper(modele.nom)}</h2>
          <p class="discret" style="margin:0;font-size:.86rem">
            ${modele.personnalise
              ? `<span class="pastille-etat etat-ok">texte modifié</span>${modele.majLe
                ? ` le ${echapper(quand(modele.majLe))}${modele.majPar ? ` par ${echapper(modele.majPar)}` : ''}` : ''}`
              : '<span class="pastille-etat">texte d’origine</span>'}
            ${modele.aide ? `<br>${echapper(modele.aide)}` : ''}
          </p>
        </div>
        <button type="button" class="btn btn-secondaire" id="em-fermer" style="padding:.35rem .8rem;font-size:.8rem">Fermer</button>
      </div>

      <div class="champ-admin" style="margin-top:1rem">
        <label for="em-objet">Objet</label>
        <input type="text" id="em-objet" value="${echapper(modele.objet)}" maxlength="250">
        <p class="discret" style="margin:.3rem 0 0;font-size:.8rem">Données possibles dans l'objet :
          ${enLigne.map((v) => `<button type="button" class="lien-donnee" data-objet="${echapper(v.nom)}"
            title="${echapper(v.libelle)}">{{${echapper(v.nom)}}}</button>`).join(' ')}</p>
      </div>

      <p class="ui" style="margin:1rem 0 .3rem;font-weight:700;font-size:.86rem" id="em-libelle-texte">Texte</p>
      <div class="barre-editeur" role="toolbar" aria-label="Mise en forme" aria-controls="em-texte">
        <button type="button" data-bloc="H2" title="Titre">Titre</button>
        <button type="button" data-bloc="H3" title="Sous-titre">Sous-titre</button>
        <button type="button" data-bloc="P" title="Paragraphe normal">Paragraphe</button>
        <span class="separateur" aria-hidden="true"></span>
        <button type="button" data-commande="bold" title="Gras (Ctrl+B)"><strong>G</strong></button>
        <button type="button" data-commande="italic" title="Italique (Ctrl+I)"><em>I</em></button>
        <button type="button" data-commande="underline" title="Souligné (Ctrl+U)"><u>S</u></button>
        <span class="separateur" aria-hidden="true"></span>
        <button type="button" data-commande="insertUnorderedList" title="Liste à puces">• Liste</button>
        <button type="button" data-commande="insertOrderedList" title="Liste numérotée">1. Liste</button>
        <span class="separateur" aria-hidden="true"></span>
        <button type="button" id="em-lien" title="Transformer la sélection en lien">Lien</button>
        <button type="button" data-commande="unlink" title="Retirer le lien">Retirer le lien</button>
        <span class="separateur" aria-hidden="true"></span>
        <label class="sr-only" for="em-donnee">Insérer une donnée</label>
        <select id="em-donnee">
          <option value="">Insérer une donnée…</option>
          <optgroup label="Dans le texte">
            ${enLigne.map((v) => `<option value="${echapper(v.nom)}">${echapper(v.libelle)}</option>`).join('')}
          </optgroup>
          ${modele.variables.some((v) => v.bloc) ? `<optgroup label="Sur sa propre ligne">
            ${modele.variables.filter((v) => v.bloc).map((v) => `<option value="${echapper(v.nom)}">${echapper(v.libelle)}</option>`).join('')}
          </optgroup>` : ''}
        </select>
      </div>
      <div id="em-texte" class="editeur-mail" contenteditable="true" role="textbox" aria-multiline="true"
           aria-labelledby="em-libelle-texte" spellcheck="true">${versEditeur(modele.corps, modele.variables)}</div>
      <p class="discret" style="margin:.4rem 0 0;font-size:.8rem">
        Les étiquettes grises sont remplacées à l'envoi : prénom de l'agent, calendrier, bouton…
        Déplacez-les ou supprimez-les comme un mot. Un texte collé perd sa mise en forme.
      </p>

      <div class="rang" style="margin-top:1rem;border-top:1px solid var(--bordure);padding-top:1rem">
        <button type="button" class="btn btn-principal" id="em-enregistrer">Enregistrer</button>
        <button type="button" class="btn btn-secondaire" id="em-apercu">Aperçu</button>
        <button type="button" class="btn btn-secondaire" id="em-test">Envoyer un test</button>
        ${modele.personnalise ? `<button type="button" class="btn btn-secondaire" id="em-origine"
          style="border-color:var(--erreur);color:var(--erreur)">Revenir au texte d'origine</button>` : ''}
      </div>
      <p class="discret" style="margin:.4rem 0 0;font-size:.8rem">
        L'aperçu et le test utilisent le texte affiché ici, même non enregistré. Les envois aux agents,
        automatiques ou à la main, utilisent le texte enregistré.
      </p>
      <div id="em-alerte" aria-live="polite" style="margin-top:.8rem"></div>
    </section>`;

  const editeur = zone.querySelector('#em-texte');
  const objet = zone.querySelector('#em-objet');
  const message = (texte, variante) => alerte(zone.querySelector('#em-alerte'), texte, variante);
  const brouillon = () => ({ objet: objet.value, corps: versTexteStocke(editeur) });
  let reference = JSON.stringify(brouillon());
  const modifie = () => JSON.stringify(brouillon()) !== reference;

  // Entree cree un paragraphe, pas une <div> : c'est ce que le serveur attend.
  document.execCommand('defaultParagraphSeparator', false, 'p');

  /* ---- Selection : on la memorise, les boutons et la liste la font perdre */
  let selection = null;
  const surSelection = () => {
    const s = document.getSelection();
    if (s.rangeCount && editeur.contains(s.getRangeAt(0).commonAncestorContainer)) {
      selection = s.getRangeAt(0).cloneRange();
    }
  };
  document.addEventListener('selectionchange', surSelection);
  detacher = () => document.removeEventListener('selectionchange', surSelection);
  const restaurer = () => {
    editeur.focus();
    if (!selection) return;
    const s = document.getSelection();
    s.removeAllRanges();
    s.addRange(selection);
  };

  // Les boutons ne prennent pas le focus : la selection reste dans le texte.
  zone.querySelectorAll('.barre-editeur button').forEach((b) =>
    b.addEventListener('mousedown', (e) => e.preventDefault()));

  zone.querySelectorAll('[data-commande]').forEach((b) => b.addEventListener('click', () => {
    restaurer();
    document.execCommand(b.dataset.commande, false, null);
  }));
  zone.querySelectorAll('[data-bloc]').forEach((b) => b.addEventListener('click', () => {
    restaurer();
    document.execCommand('formatBlock', false, b.dataset.bloc);
  }));

  zone.querySelector('#em-lien').addEventListener('click', () => {
    restaurer();
    if (document.getSelection().isCollapsed) {
      message('Sélectionnez d’abord le texte à transformer en lien.', 'alerte');
      return;
    }
    const adresse = prompt('Adresse du lien (https://…, ou mailto:adresse)', 'https://');
    if (!adresse) return;
    if (!/^(https?:\/\/|mailto:)\S+$/i.test(adresse.trim())) {
      message('Adresse refusée : elle doit commencer par https://, http:// ou mailto:.', 'alerte');
      return;
    }
    restaurer();
    document.execCommand('createLink', false, adresse.trim());
  });

  /* ---- Insertion d'une donnee */
  zone.querySelector('#em-donnee').addEventListener('change', (e) => {
    const v = modele.variables.find((x) => x.nom === e.target.value);
    e.target.value = '';
    if (!v) return;
    restaurer();
    const plage = selection && editeur.contains(selection.commonAncestorContainer) ? selection : null;
    const gabarit = document.createElement('template');
    gabarit.innerHTML = etiquette(v);
    const noeud = gabarit.content.firstChild;

    if (v.bloc) {
      // Un bloc s'insere entre deux paragraphes, apres celui ou se trouve le curseur.
      let parent = plage ? plage.startContainer : null;
      while (parent && parent.parentNode !== editeur) parent = parent.parentNode;
      if (parent) parent.after(noeud); else editeur.append(noeud);
      if (!noeud.nextSibling) {
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        noeud.after(p);
      }
    } else if (plage) {
      plage.deleteContents();
      plage.insertNode(noeud);
      const espace = document.createTextNode(' ');
      noeud.after(espace);
      const s = document.getSelection();
      const apres = document.createRange();
      apres.setStartAfter(espace);
      s.removeAllRanges();
      s.addRange(apres);
    } else {
      (editeur.lastElementChild || editeur).append(noeud);
    }
  });

  zone.querySelectorAll('[data-objet]').forEach((b) => b.addEventListener('click', () => {
    const repere = `{{${b.dataset.objet}}}`;
    const debut = objet.selectionStart ?? objet.value.length;
    const fin = objet.selectionEnd ?? debut;
    objet.value = objet.value.slice(0, debut) + repere + objet.value.slice(fin);
    objet.focus();
    objet.setSelectionRange(debut + repere.length, debut + repere.length);
  }));

  // Un collage depuis Word ou une page web apporterait polices et couleurs.
  editeur.addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });

  /* ---- Actions */
  const fermer = () => {
    detacher?.();
    detacher = null;
    zone.innerHTML = '';
  };
  zone.querySelector('#em-fermer').addEventListener('click', () => {
    if (modifie() && !confirm('Les modifications non enregistrées seront perdues. Fermer quand même ?')) return;
    fermer();
  });

  zone.querySelector('#em-apercu').addEventListener('click', async () => {
    try {
      const m = await api('/api/admin/mails/apercu', {
        method: 'POST', body: { type, defiId: defiId(), modele: brouillon() },
      });
      zoneApercu.innerHTML = `
        <div class="carte">
          <p class="ui"><strong>Objet :</strong> ${echapper(m.objet)}</p>
          <iframe class="apercu-mail" title="Aperçu du message" sandbox></iframe>
        </div>`;
      zoneApercu.querySelector('iframe').srcdoc = m.html;
      zoneApercu.scrollIntoView({ block: 'start' });
    } catch (e) { message(e.message); }
  });

  zone.querySelector('#em-test').addEventListener('click', async (e) => {
    const adresse = adresseTest();
    if (!adresse) {
      message('Saisissez une adresse de test, dans le champ au-dessus.', 'alerte');
      return;
    }
    const bouton = e.currentTarget;
    bouton.disabled = true;
    try {
      const r = await api('/api/admin/mails/test', {
        method: 'POST', body: { type, defiId: defiId(), adresse, modele: brouillon() },
      });
      message(r.message, 'succes');
    } catch (err) { message(err.message); } finally { bouton.disabled = false; }
  });

  zone.querySelector('#em-enregistrer').addEventListener('click', async (e) => {
    const bouton = e.currentTarget;
    bouton.disabled = true;
    try {
      const r = await api(`/api/admin/modeles-mail/${encodeURIComponent(type)}`, {
        method: 'PUT', body: brouillon(),
      });
      reference = JSON.stringify(brouillon());
      await ouvrirEditeur(zone, type, { defiId, adresseTest, zoneApercu });
      alerte(zone.querySelector('#em-alerte'), r.message, 'succes');
    } catch (err) { message(err.message); } finally { bouton.disabled = false; }
  });

  zone.querySelector('#em-origine')?.addEventListener('click', async () => {
    if (!confirm('Revenir au texte d’origine ? Le texte modifié sera perdu.')) return;
    try {
      const r = await api(`/api/admin/modeles-mail/${encodeURIComponent(type)}`, { method: 'DELETE' });
      await ouvrirEditeur(zone, type, { defiId, adresseTest, zoneApercu });
      alerte(zone.querySelector('#em-alerte'), r.message, 'succes');
    } catch (err) { message(err.message); }
  });

  editeur.focus();
}
