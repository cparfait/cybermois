import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';

const DUREE_HEURES = 8;
export const COOKIE = 'cybermois_session';

export function creerSession(agentId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expire = new Date(Date.now() + DUREE_HEURES * 3600_000).toISOString();
  db.prepare('INSERT INTO sessions (token, agent_id, expire_le) VALUES (?, ?, ?)').run(token, agentId, expire);
  return token;
}

export function lireSession(token) {
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token = ? AND expire_le > datetime('now')").get(token);
  if (!s) return null;
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(s.agent_id) || null;
}

export function detruireSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function purgerSessions() {
  db.prepare("DELETE FROM sessions WHERE expire_le <= datetime('now')").run();
}

export function optionsCookie() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https://'),
    maxAge: DUREE_HEURES * 3600,
  };
}

/** Hook Fastify : exige une session valide. */
export async function exigerAuth(requete, reponse) {
  const agent = lireSession(requete.cookies?.[COOKIE]);
  if (!agent) {
    if (requete.url.startsWith('/api/')) return reponse.code(401).send({ erreur: 'Session expirée, reconnectez-vous.' });
    return reponse.redirect('/?expire=1');
  }
  requete.agent = agent;
}

/** Hook Fastify : exige une session valide ET les droits d'administration. */
export async function exigerAdmin(requete, reponse) {
  const agent = lireSession(requete.cookies?.[COOKIE]);
  if (!agent) {
    if (requete.url.startsWith('/api/')) return reponse.code(401).send({ erreur: 'Session expirée.' });
    return reponse.redirect('/?expire=1');
  }
  if (!agent.est_admin) {
    if (requete.url.startsWith('/api/')) return reponse.code(403).send({ erreur: 'Accès réservé aux administrateurs.' });
    return reponse.code(403).type('text/html; charset=utf-8').send('<p>Accès réservé aux administrateurs.</p>');
  }
  requete.agent = agent;
}
