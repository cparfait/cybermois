import crypto from 'node:crypto';
import { db, journaliser } from './db.js';
import './modules.js';

/**
 * Apercu d'un defi avant son ouverture.
 *
 * Faire relire un questionnaire par la DPO, ou le tester avec un collegue,
 * suppose de pouvoir y jouer alors qu'il est encore scelle. Deux exigences
 * s'opposent : que le lien fonctionne pour quelqu'un d'autre, et que rien de
 * ce qui s'y passe ne compte.
 *
 * Le jeton porte la premiere : il ouvre un defi ferme, pour qui detient le
 * lien. La seconde est structurelle - une partie jouee en apercu n'ecrit
 * aucune participation, donc n'entre ni au classement, ni dans les statistiques,
 * ni dans les badges. Ce n'est pas un reglage qu'on pourrait oublier, c'est le
 * chemin de code lui-meme.
 *
 * Le jeton se revoque : le lien partage cesse alors de fonctionner, ce qui
 * evite qu'il ne circule apres la campagne.
 */

/** Genere - ou renouvelle - le jeton d'un defi, et rend le lien complet. */
export function creerJetonApercu(id, parQui) {
  const defi = db.prepare('SELECT id, titre FROM defis WHERE id = ?').get(Number(id));
  if (!defi) return null;

  const jeton = crypto.randomBytes(24).toString('base64url');
  db.prepare('UPDATE defis SET jeton_apercu = ? WHERE id = ?').run(jeton, defi.id);
  journaliser(parQui, 'apercu_cree', `defi ${defi.id} (${defi.titre})`, null);
  return { id: defi.id, titre: defi.titre, jeton };
}

export function revoquerJetonApercu(id, parQui) {
  const res = db.prepare('UPDATE defis SET jeton_apercu = NULL WHERE id = ?').run(Number(id));
  if (res.changes) journaliser(parQui, 'apercu_revoque', `defi ${id}`, null);
  return res.changes > 0;
}

/**
 * Le jeton presente ouvre-t-il ce defi ?
 * La comparaison est a temps constant : un jeton se devine autrement.
 */
export function jetonValide(defi, presente) {
  const attendu = defi?.jeton_apercu;
  if (!attendu || !presente) return false;
  const a = Buffer.from(String(attendu));
  const b = Buffer.from(String(presente));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const lienApercu = (base, id, jeton) =>
  `${String(base || '').replace(/\/+$/, '')}/defi/${id}?apercu=${jeton}`;
