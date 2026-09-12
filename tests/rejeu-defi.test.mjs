/**
 * « Recommencer » ne doit pas devenir une gomme.
 *
 * DELETE /api/defis/:id/tentative existe pour un cas precis : un agent qui
 * s'est trompe de defi, ou qui veut repartir de zero avant d'avoir rien
 * valide. Tel quel, il efface aussi les reponses DEJA validees - et comme une
 * reponse validee est une reponse dont la correction a ete affichee, l'agent
 * peut la reprendre en connaissant la bonne. Le sans-faute est a portee d'un
 * appel, et le classement ne veut plus rien dire.
 *
 * La regle : des qu'une question a ete validee hors entrainement, la tentative
 * en cours est acquise. Elle reste effacable tant que rien n'a ete valide, et
 * en entrainement - ou rien ne compte, par construction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('rejeu-defi', import.meta.url);
// La campagne doit etre ouverte pour que le defi le soit : une date de fin
// heritee de l'environnement rendrait ce test dependant du jour ou on le joue.
process.env.CAMPAGNE_FIN = '2099-12-31';

const { db } = await import('../src/lib/db.js');
await import('../src/lib/tentatives.js'); // cree la table « tentatives »
const {
  apiJeu, agentConnecte, creerDefi, questionsDe, bonneReponse, jour, tentatives,
} = await import('./api-jeu.mjs');
nettoyerALaFin(db);

const app = await apiJeu();
const DEFI = creerDefi({ titre: 'Defi ouvert', ouvreLe: jour(-1), questions: 2 });
const [q1, q2] = questionsDe(DEFI);

/** Valide une question par le meme chemin que l'agent. */
const repondre = (agent, questionId, requete = '') => app.inject({
  method: 'POST',
  url: `/api/defis/${DEFI}/questions/${questionId}${requete}`,
  headers: { cookie: agent.cookie },
  payload: { choix: [bonneReponse(questionId)] },
});

const effacer = (agent, requete = '') => app.inject({
  method: 'DELETE',
  url: `/api/defis/${DEFI}/tentative${requete}`,
  headers: { cookie: agent.cookie },
});

test('une question validee hors entrainement scelle la tentative', async () => {
  const agent = agentConnecte('zz-rejeu-scelle');

  assert.equal((await repondre(agent, q1.id)).statusCode, 200);
  assert.equal(tentatives(agent.id, DEFI), 1);

  const r = await effacer(agent);
  assert.ok(r.statusCode >= 400,
    "effacer une tentative dont une correction a deja ete montree rend le sans-faute gratuit "
    + `(recu ${r.statusCode} : ${r.body})`);
  assert.equal(tentatives(agent.id, DEFI), 1,
    'la reponse validee doit rester en base : c est elle qui empeche de rejouer');
});

test('le refus ne s applique pas a la moitie des reponses seulement', async () => {
  // Le piege serait d'effacer quand meme, en rendant une erreur : le refus
  // doit etre total, pas cosmetique.
  const agent = agentConnecte('zz-rejeu-partiel');

  await repondre(agent, q1.id);
  await repondre(agent, q2.id);
  assert.equal(tentatives(agent.id, DEFI), 2);

  await effacer(agent);
  assert.equal(tentatives(agent.id, DEFI), 2, 'aucune des deux reponses ne doit disparaitre');
});

test('tant que rien n est valide, effacer reste permis', async () => {
  // C'est le cas d'usage legitime : on a ouvert le mauvais defi.
  const agent = agentConnecte('zz-rejeu-vierge');

  const r = await effacer(agent);
  assert.equal(r.statusCode, 200,
    `repartir de zero avant d avoir rien valide doit rester possible (recu ${r.body})`);
  assert.equal(tentatives(agent.id, DEFI), 0);
});

test('en entrainement, effacer reste permis : rien ne compte', async () => {
  // Le defi a deja ete joue pour de vrai : le rejouer est un entrainement, il
  // n'entre ni au classement ni aux badges. Rien a proteger.
  const agent = agentConnecte('zz-rejeu-entrainement');
  db.prepare(`
    INSERT INTO participations (agent_id, defi_id, score, score_max, bonnes, total_questions, entrainement)
    VALUES (?, ?, 20, 20, 2, 2, 0)
  `).run(agent.id, DEFI);

  assert.equal((await repondre(agent, q1.id)).statusCode, 200);
  assert.equal(tentatives(agent.id, DEFI), 1);

  const r = await effacer(agent);
  assert.equal(r.statusCode, 200,
    `un entrainement doit rester reprenable a volonte (recu ${r.statusCode} : ${r.body})`);
  assert.equal(tentatives(agent.id, DEFI), 0);
});

test('en apercu, effacer reste permis : aucune participation n est en jeu', async () => {
  const agent = agentConnecte('zz-rejeu-apercu');
  const { creerJetonApercu } = await import('../src/lib/apercu.js');
  const scelle = creerDefi({ titre: 'Defi scelle', ouvreLe: jour(+7), questions: 1 });
  const [qs] = questionsDe(scelle);
  const jeton = creerJetonApercu(scelle, 'test').jeton;

  const validee = await app.inject({
    method: 'POST',
    url: `/api/defis/${scelle}/questions/${qs.id}?apercu=${jeton}`,
    headers: { cookie: agent.cookie },
    payload: { choix: [bonneReponse(qs.id)] },
  });
  assert.equal(validee.statusCode, 200, "le jeton doit ouvrir un defi encore scelle");

  const r = await app.inject({
    method: 'DELETE',
    url: `/api/defis/${scelle}/tentative?apercu=${jeton}`,
    headers: { cookie: agent.cookie },
  });
  assert.equal(r.statusCode, 200,
    `une relecture doit pouvoir etre reprise autant de fois qu'on veut (recu ${r.body})`);
  assert.equal(tentatives(agent.id, scelle), 0);
});

test('une tentative scellee ne s efface pas non plus par un autre defi', async () => {
  // Le controle doit porter sur le defi vise, pas sur l'agent en general.
  const agent = agentConnecte('zz-rejeu-autre-defi');
  const autre = creerDefi({ titre: 'Autre defi', ouvreLe: jour(-1), questions: 1 });
  const [qa] = questionsDe(autre);

  await repondre(agent, q1.id);
  await app.inject({
    method: 'DELETE',
    url: `/api/defis/${autre}/tentative`,
    headers: { cookie: agent.cookie },
  });
  assert.equal(tentatives(agent.id, DEFI), 1,
    'effacer la tentative d un defi ne doit pas toucher a celle d un autre');
  assert.equal(tentatives(agent.id, autre), 0);
});
