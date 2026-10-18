import fs from 'node:fs';
import path from 'node:path';

/**
 * Illustration d'un defi. Seule quand le defi n'a pas de video ; sinon elle
 * sert d'affiche au lecteur, un bouton de lecture pose dessus.
 *
 * Sans video, la page d'un defi n'offrait que du texte avant les questions :
 * rien qui accroche l'oeil, alors que c'est la que l'agent decide s'il joue.
 * Chaque module du catalogue a son illustration, public/img/defis/<module>.svg,
 * dessinee aux couleurs de la Ville. Elle est servie par le portail, comme le
 * reste : aucun tiers n'est appele.
 *
 * Un defi redige dans l'administration n'a pas de module, donc pas
 * d'illustration : la page reste alors ce qu'elle etait.
 */
const DOSSIER = path.resolve(process.cwd(), 'public', 'img', 'defis');

// Lu une fois : les illustrations font partie de l'image deployee, elles ne
// changent pas pendant que le serveur tourne.
const disponibles = new Set(
  fs.existsSync(DOSSIER)
    ? fs.readdirSync(DOSSIER).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4))
    : []
);

/** Adresse de l'illustration du defi, ou `null` s'il n'en a pas. */
export function illustrationDe(defi) {
  const code = defi?.module_code;
  return code && disponibles.has(code) ? `/img/defis/${code}.svg` : null;
}
