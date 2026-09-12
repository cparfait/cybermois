import { SERVICE_NON_RATTACHE } from './db.js';
/**
 * Import d'un effectif depuis un export d'annuaire.
 *
 * Tolerant par construction, parce que les fichiers viennent d'Excel ou de
 * PowerShell et arrivent rarement propres : separateur ; ou , ou tabulation,
 * BOM, guillemets, en-tetes accentues ou non, colonnes dans le desordre.
 */

const SEPARATEURS = [';', ',', '\t', '|'];

/** Retire les accents et normalise, pour reconnaitre les en-tetes quelle que soit leur graphie. */
const cle = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

/** Colonnes reconnues, par ordre de priorite. */
const CORRESPONDANCES = {
  login: ['login', 'samaccountname', 'identifiant', 'utilisateur', 'user', 'username', 'uid', 'compte'],
  nomComplet: ['nomcomplet', 'displayname', 'nomprenom', 'prenomnom', 'nomaffiche', 'name', 'cn'],
  nom: ['nom', 'sn', 'surname', 'lastname'],
  prenom: ['prenom', 'givenname', 'firstname'],
  email: ['email', 'mail', 'adressemail', 'courriel', 'emailaddress', 'userprincipalname'],
  service: ['service', 'department', 'departement', 'direction', 'ou', 'organisationalunit', 'physicaldeliveryofficename', 'bureau'],
  dn: ['dn', 'distinguishedname'],
};

/** Detecte le separateur le plus probable a partir de la premiere ligne. */
function detecterSeparateur(premiereLigne) {
  let meilleur = ';'; let maximum = 0;
  for (const s of SEPARATEURS) {
    // On compte hors guillemets pour ne pas etre trompe par un champ contenant le separateur
    let n = 0; let dansGuillemets = false;
    for (const c of premiereLigne) {
      if (c === '"') dansGuillemets = !dansGuillemets;
      else if (c === s && !dansGuillemets) n++;
    }
    if (n > maximum) { maximum = n; meilleur = s; }
  }
  return meilleur;
}

/** Analyse un CSV en respectant les guillemets et les retours a la ligne encadres. */
export function analyserCsv(texte) {
  let contenu = String(texte).replace(/^﻿/, '');
  if (!contenu.trim()) return { entetes: [], lignes: [], separateur: ';' };

  const premiereLigne = contenu.split(/\r?\n/)[0];
  const separateur = detecterSeparateur(premiereLigne);

  const lignes = [];
  let champs = [];
  let champ = '';
  let dansGuillemets = false;

  for (let i = 0; i < contenu.length; i++) {
    const c = contenu[i];

    if (dansGuillemets) {
      if (c === '"') {
        if (contenu[i + 1] === '"') { champ += '"'; i++; }
        else dansGuillemets = false;
      } else champ += c;
      continue;
    }

    if (c === '"') { dansGuillemets = true; continue; }
    if (c === separateur) { champs.push(champ); champ = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { champs.push(champ); lignes.push(champs); champs = []; champ = ''; continue; }
    champ += c;
  }
  if (champ !== '' || champs.length) { champs.push(champ); lignes.push(champs); }

  const nonVides = lignes.filter((l) => l.some((v) => String(v).trim() !== ''));
  if (!nonVides.length) return { entetes: [], lignes: [], separateur };

  const entetes = nonVides[0].map((e) => String(e).trim());
  return { entetes, lignes: nonVides.slice(1), separateur };
}

/** Associe chaque champ attendu a l'index de colonne correspondant. */
export function reconnaitreColonnes(entetes) {
  const normalises = entetes.map(cle);
  const trouve = {};
  for (const [champ, alias] of Object.entries(CORRESPONDANCES)) {
    for (const a of alias) {
      const i = normalises.indexOf(a);
      if (i !== -1) { trouve[champ] = i; break; }
    }
  }
  return trouve;
}

/** Extrait le service depuis un DN, comme le fait l'authentification LDAPS. */
function serviceDepuisDn(dn, profondeur = 1) {
  if (!dn) return null;
  const ous = [];
  for (const rdn of String(dn).split(/(?<!\\),/)) {
    const m = rdn.trim().match(/^OU=(.+)$/i);
    if (m) ous.push(m[1].replace(/\\(.)/g, '$1').trim());
  }
  if (!ous.length) return null;
  return ous[Math.min(profondeur, ous.length) - 1] || null;
}

const EMAIL_VALIDE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Transforme un CSV en liste d'agents exploitables, avec le detail des rejets.
 * Ne touche pas a la base : c'est ce qui permet la previsualisation avant import.
 */
export function preparerImport(texte, { ouDepth = 1 } = {}) {
  const { entetes, lignes, separateur } = analyserCsv(texte);
  if (!entetes.length) {
    return { ok: false, erreur: 'Fichier vide ou illisible.' };
  }

  const colonnes = reconnaitreColonnes(entetes);
  if (colonnes.login === undefined) {
    return {
      ok: false,
      erreur: `Aucune colonne d'identifiant reconnue. Colonnes trouvées : ${entetes.join(', ')}. `
        + 'Une colonne nommée « login », « sAMAccountName » ou « identifiant » est indispensable.',
      entetes,
    };
  }

  const valeur = (ligne, champ) => {
    const i = colonnes[champ];
    return i === undefined ? '' : String(ligne[i] ?? '').trim();
  };

  const agents = [];
  const rejets = [];
  const vus = new Map();

  lignes.forEach((ligne, index) => {
    const numero = index + 2; // +1 pour l'en-tete, +1 pour partir de 1
    const login = valeur(ligne, 'login').toLowerCase().replace(/^.*\\/, ''); // DOMAINE\login -> login

    if (!login) return rejets.push({ numero, motif: 'identifiant vide', ligne: ligne.join(' ') });
    if (/[\s,;]/.test(login)) return rejets.push({ numero, motif: `identifiant invalide : « ${login} »` });

    if (vus.has(login)) {
      return rejets.push({ numero, motif: `doublon de « ${login} » (déjà ligne ${vus.get(login)})` });
    }
    vus.set(login, numero);

    let nomComplet = valeur(ligne, 'nomComplet');
    if (!nomComplet) {
      nomComplet = [valeur(ligne, 'prenom'), valeur(ligne, 'nom')].filter(Boolean).join(' ');
    }
    if (!nomComplet) nomComplet = login;

    const dn = valeur(ligne, 'dn') || null;
    let service = valeur(ligne, 'service');
    if (!service && dn) service = serviceDepuisDn(dn, ouDepth) || '';
    service = service.replace(/\s+/g, ' ').trim() || SERVICE_NON_RATTACHE;

    const email = valeur(ligne, 'email');
    const emailValide = email && EMAIL_VALIDE.test(email) ? email.toLowerCase() : null;
    const avertissements = [];
    if (email && !emailValide) avertissements.push(`adresse ignorée : « ${email} »`);
    if (!emailValide) avertissements.push('sans adresse : ne recevra pas de relance');
    if (service === SERVICE_NON_RATTACHE) avertissements.push('service non déterminé');

    agents.push({ login, nomComplet, email: emailValide, service, dn, avertissements });
  });

  const services = [...new Set(agents.map((a) => a.service))].sort((a, b) => a.localeCompare(b, 'fr'));

  return {
    ok: true,
    separateur,
    entetes,
    colonnesReconnues: Object.fromEntries(
      Object.entries(colonnes).map(([champ, i]) => [champ, entetes[i]])
    ),
    agents,
    rejets,
    services,
    resume: {
      lues: lignes.length,
      retenues: agents.length,
      rejetees: rejets.length,
      sansEmail: agents.filter((a) => !a.email).length,
      sansService: agents.filter((a) => a.service === SERVICE_NON_RATTACHE).length,
      services: services.length,
    },
  };
}
