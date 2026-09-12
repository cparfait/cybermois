/**
 * Clore un defi ecrit une participation : c'est l'acte qui fait entrer un
 * resultat au classement, aux statistiques et aux badges. Il ne doit donc etre
 * possible que sur un defi reellement ouvert, et reellement jouable.
 *
 * Trois portes etaient restees ouvertes :
 *
 *   - un defi non paru, ou jamais publie, se cloturait quand meme : l'appel ne
 *     regardait que le nombre de reponses ;
 *   - un defi sans question passait pour complet - « 0 sur 0 » - et ecrivait
 *     une participation vide, sans-faute compris ;
 *   - surtout, une partie jouee avec un lien d'APERCU se transformait en
 *     participation reelle en rappelant la cloture SANS le jeton. L'apercu
 *     devait etre structurellement sans consequence ; il ne l'etait que tant
 *     qu'on presentait le jeton jusqu'au bout.
 *
 * Ces tests appellent les routes par inject() : aucun serveur n'est a lancer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('cloture-defi', import.meta.url);
// Sans cela, une date de fin heritee de l'environnement ferait dependre ces
// tests du jour ou on les joue.
process.env.CAMPAGNE_FIN = '2099-12-31';

const { db } = await import('../src/lib/db.js');
const { repondre } = await import('../src/lib/tentatives.js');
const { creerJetonApercu } = await import('../src/lib/apercu.js');
const {
  apiJeu, agentConnecte, creerDefi, questionsDe, bonneReponse, jour, participations,
} = await import('./api-jeu.mjs');
nettoyerALaFin(db);

const app = await apiJeu();

const terminer = (agent, defiId, requete = '') => app.inject({
  method: 'POST',
  url: `/api/defis/${defiId}/terminer${requete}`,
  headers: { cookie: agent.cookie },
});

/**
 * Remplit la tentative d'un agent sans passer par la route de validation :
 * sur un defi ferme, celle-ci refuserait - or c'est precisement la cloture
 * qu'on veut mettre a l'epreuve.
 */
function repondreATout(agentId, defiId, { apercu = false } = {}) {
  for (const q of questionsDe(defiId)) {
    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(q.id);
    repondre(agentId, defiId, question, [bonneReponse(q.id)], { apercu });
  }
}

test('un defi non paru ne se cloture pas', async () => {
  const agent = agentConnecte('zz-cloture-non-paru');
  const defi = creerDefi({ titre: 'Defi a venir', ouvreLe: jour(+7) });
  repondreATout(agent.id, defi);

  const r = await terminer(agent, defi);
  assert.ok(r.statusCode >= 400, `un defi encore scelle ne doit rien enregistrer (recu ${r.statusCode})`);
  assert.equal(participations(agent.id, defi), 0,
    'une participation sur un defi a venir fausse le classement avant meme la parution');
});

test('un defi non publie ne se cloture pas', async () => {
  // Depublier est la seule facon de retirer un defi de la campagne en cours :
  // si on peut encore le cloturer, retirer ne veut rien dire.
  const agent = agentConnecte('zz-cloture-non-publie');
  const defi = creerDefi({ titre: 'Defi masque', ouvreLe: jour(-1), publie: 0 });
  repondreATout(agent.id, defi);

  const r = await terminer(agent, defi);
  assert.ok(r.statusCode >= 400, `un defi depublie ne doit rien enregistrer (recu ${r.statusCode})`);
  assert.equal(participations(agent.id, defi), 0);
});

test('un defi sans question ne se cloture pas', async () => {
  // « 0 reponse sur 0 » se lisait comme un defi complet : la participation
  // etait ecrite avec un score de 0/0, que le classement compte comme un
  // sans-faute.
  const agent = agentConnecte('zz-cloture-vide');
  const defi = creerDefi({ titre: 'Defi vide', ouvreLe: jour(-1), questions: 0 });

  const r = await terminer(agent, defi);
  assert.ok(r.statusCode >= 400, `un defi sans question n'a rien a valider (recu ${r.statusCode})`);
  assert.equal(participations(agent.id, defi), 0,
    'un 0/0 enregistre vaut un sans-faute au pourcentage : il ne doit jamais etre ecrit');
});

test("un apercu ne devient pas une participation en retirant le jeton", async () => {
  // Le scenario complet de la faille : jouer avec le lien d'apercu, puis
  // appeler la cloture sans le presenter.
  const agent = agentConnecte('zz-cloture-apercu-sans-jeton');
  const defi = creerDefi({ titre: 'Defi en relecture', ouvreLe: jour(+7), questions: 2 });
  const jeton = creerJetonApercu(defi, 'test').jeton;

  // Les reponses passent par la route, avec le jeton : c'est le vrai parcours
  // de relecture.
  for (const q of questionsDe(defi)) {
    const v = await app.inject({
      method: 'POST',
      url: `/api/defis/${defi}/questions/${q.id}?apercu=${jeton}`,
      headers: { cookie: agent.cookie },
      payload: { choix: [bonneReponse(q.id)] },
    });
    assert.equal(v.statusCode, 200, 'le jeton doit ouvrir un defi encore scelle');
  }

  const r = await terminer(agent, defi);
  assert.equal(participations(agent.id, defi), 0,
    "un apercu qui laisse une participation, c'est un resultat au classement sur un defi "
    + "que personne n'a encore vu");
  assert.ok(r.statusCode >= 400 || JSON.parse(r.body).entrainement === true,
    'la cloture doit etre refusee, ou au minimum ne rien compter');
});

test("une cloture d'apercu, jeton presente, ne compte pas davantage", async () => {
  const agent = agentConnecte('zz-cloture-apercu-avec-jeton');
  const defi = creerDefi({ titre: 'Defi relu jusqu au bout', ouvreLe: jour(+7) });
  const jeton = creerJetonApercu(defi, 'test').jeton;
  repondreATout(agent.id, defi, { apercu: true });

  const r = await terminer(agent, defi, `?apercu=${jeton}`);
  assert.equal(r.statusCode, 200, `la relecture doit pouvoir aller a son terme (recu ${r.body})`);
  assert.equal(JSON.parse(r.body).entrainement, true, 'un apercu est toujours un entrainement');
  assert.equal(participations(agent.id, defi), 0, 'aucune participation, meme d entrainement');
});

test('un defi ouvert et complet se cloture, lui', async () => {
  // Le pendant indispensable des refus ci-dessus : a force de fermer des
  // portes, on finirait par fermer la bonne.
  const agent = agentConnecte('zz-cloture-normale');
  const defi = creerDefi({ titre: 'Defi ouvert', ouvreLe: jour(-1), questions: 2 });
  repondreATout(agent.id, defi);

  const r = await terminer(agent, defi);
  assert.equal(r.statusCode, 200, `un defi ouvert et complet doit se terminer (recu ${r.body})`);
  const corps = JSON.parse(r.body);
  assert.equal(corps.entrainement, false);
  assert.equal(corps.pourcentage, 100);
  assert.equal(participations(agent.id, defi), 1);
});

test('un defi incomplet ne se cloture pas non plus', async () => {
  const agent = agentConnecte('zz-cloture-incomplete');
  const defi = creerDefi({ titre: 'Defi a moitie', ouvreLe: jour(-1), questions: 3 });
  const [q1] = questionsDe(defi);
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(q1.id);
  repondre(agent.id, defi, question, [bonneReponse(q1.id)]);

  const r = await terminer(agent, defi);
  assert.ok(r.statusCode >= 400, `une seule question sur trois ne fait pas un defi termine (recu ${r.statusCode})`);
  assert.equal(participations(agent.id, defi), 0);
});
