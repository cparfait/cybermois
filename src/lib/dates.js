/**
 * La date du jour, telle que la campagne l'entend.
 *
 * Deux notions de « aujourd'hui » cohabitaient : les routes calculaient la
 * date en heure locale, le calcul des scores comparait a `date('now')`,
 * c'est-a-dire a la date UTC. A Paris en octobre, il y a deux heures d'ecart :
 * entre minuit et deux heures du matin le jour d'une parution, le defi etait
 * jouable mais ses points n'entraient pas encore au total atteignable. Les
 * agents qui jouaient dans cette fenetre voyaient un pourcentage superieur a
 * 100 %, et les denominateurs du classement etaient faux le temps que la date
 * UTC rattrape la date locale.
 *
 * Une seule fonction, utilisee des deux cotes, supprime l'ecart.
 */

/** AAAA-MM-JJ en heure locale. `toISOString` reculerait d'un jour le soir. */
export function aujourdhui(maintenant = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${maintenant.getFullYear()}-${p(maintenant.getMonth() + 1)}-${p(maintenant.getDate())}`;
}

/**
 * AAAA-MM-JJ decale de `jours` jours. Midi plutot que minuit : un changement
 * d'heure ne fait alors jamais sauter ou doubler une date.
 */
export function decalerJours(jour, jours) {
  const d = new Date(`${jour}T12:00:00`);
  d.setDate(d.getDate() + jours);
  return aujourdhui(d);
}

/** Le lundi de la semaine de `jour` : celui ou part l'annonce. */
export function lundiDe(jour) {
  const d = new Date(`${jour}T12:00:00`);
  return decalerJours(jour, -((d.getDay() + 6) % 7));
}

/** « lundi 5 octobre », « jeudi 1er octobre », pour les mails. */
export const dateLisible = (jour) => new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long', day: 'numeric', month: 'long',
}).format(new Date(`${jour}T12:00:00`)).replace(/ 1 /, ' 1er ');
