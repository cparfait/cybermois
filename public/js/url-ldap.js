/**
 * Composition et lecture de l'URL d'un annuaire.
 *
 * Le schema et le port sont de la plomberie : on attend d'un administrateur
 * qu'il connaisse l'adresse de son controleur de domaine, pas qu'il retienne
 * que LDAPS ecoute sur 636 et LDAP sur 389, ni qu'une URL en « ldap:// » sur
 * le port 636 ne negocie aucun chiffrement.
 *
 * Cette derniere confusion s'est produite : le port etait juste, le schema
 * non, et le resultat etait du LDAP en clair sur le port du LDAPS.
 *
 * On saisit donc une IP ou un FQDN, on coche « chiffre », et le reste se
 * deduit. Une URL complete reste acceptee : on la lit plutot que de la
 * refuser, pour ne pas casser les configurations existantes.
 */

const PORT_CHIFFRE = 636;
const PORT_CLAIR = 389;

/**
 * Decompose une URL en ses trois elements utiles.
 * Accepte aussi bien « 10.0.0.1 » que « ldaps://dc01.exemple.lan:636 ».
 */
export function decomposerUrlLdap(url) {
  const brut = String(url || '').trim();
  if (!brut || brut === 'demo') {
    return { hote: brut, chiffre: true, port: null, demo: brut === 'demo' };
  }

  const avecSchema = /^ldaps?:\/\//i.test(brut);
  const chiffre = avecSchema ? /^ldaps:\/\//i.test(brut) : true;
  const sansSchema = brut.replace(/^ldaps?:\/\//i, '').replace(/\/+$/, '');

  // Le port est ce qui suit le dernier deux-points, a condition d'etre un
  // nombre : une adresse IPv6 litterale en contient plusieurs.
  const separateur = sansSchema.lastIndexOf(':');
  let hote = sansSchema;
  let port = null;
  if (separateur > 0) {
    const suffixe = sansSchema.slice(separateur + 1);
    if (/^\d+$/.test(suffixe)) {
      hote = sansSchema.slice(0, separateur);
      port = Number(suffixe);
    }
  }

  return { hote, chiffre, port, demo: false };
}

/**
 * Compose l'URL a partir de l'hote et du chiffrement.
 *
 * Le port est toujours ecrit, meme standard : une URL complete se relit sans
 * avoir a connaitre la valeur par defaut de la bibliotheque cliente, et c'est
 * elle qu'on lit dans l'onglet Technique ou dans un journal.
 */
export function composerUrlLdap(hote, { chiffre = true, port = null } = {}) {
  const propre = String(hote || '').trim().replace(/^ldaps?:\/\//i, '').replace(/\/+$/, '');
  if (!propre) return '';
  if (propre === 'demo') return 'demo';

  // L'hote peut deja porter un port : il l'emporte sur celui passe a part,
  // sinon corriger l'un sans l'autre donnerait un resultat surprenant.
  const lu = decomposerUrlLdap(propre);
  const retenu = lu.port ?? port ?? (chiffre ? PORT_CHIFFRE : PORT_CLAIR);

  return `${chiffre ? 'ldaps' : 'ldap'}://${lu.hote}:${retenu}`;
}

/**
 * Normalise ce qui arrive du formulaire ou d'une variable d'environnement.
 *
 * Sans indication de chiffrement, une saisie sans schema est consideree comme
 * chiffree : c'est le seul defaut defendable, et l'inverse exposerait les mots
 * de passe de cinq cents agents sur une simple omission.
 */
export function normaliserUrlLdap(saisie, chiffre = null) {
  const lu = decomposerUrlLdap(saisie);
  if (lu.demo) return 'demo';
  if (!lu.hote) return '';
  return composerUrlLdap(lu.hote, {
    chiffre: chiffre === null ? lu.chiffre : !!chiffre,
    port: lu.port,
  });
}
