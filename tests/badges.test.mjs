/**
 * Verifie qu'AUCUN badge n'est inatteignable.
 *
 * Un agent qui repond parfaitement a tous les defis doit obtenir la totalite
 * du catalogue. Ce test existe parce qu'un badge s'etait retrouve hors
 * d'atteinte apres la suppression du bonus de rapidite, sans que rien ne le
 * signale : un badge impossible est pire que pas de badge du tout.
 *
 * Le test lit les bonnes reponses directement en base - ce qu'aucun agent ne
 * peut faire - pour jouer un sans-faute et confronter le resultat au catalogue.
 *
 *   node tests/badges.test.mjs [url]
 */
const BASE = process.argv[2] || 'http://localhost:3000';
const AGENT = process.env.AGENT_TEST || 'i.masson';

const { db } = await import('../src/lib/db.js');

async function connecter(login, motDePasse) {
  const r = await fetch(`${BASE}/api/connexion`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, motDePasse }),
  });
  if (!r.ok) throw new Error(`connexion ${login} : ${(await r.json()).erreur}`);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

// On repart d'une ardoise vierge pour cet agent, sinon les defis deja joues
// basculent en entrainement et ne decernent plus rien.
// Ce test a besoin d'un agent jouable et d'un serveur en marche. Sur une base
// de production, ou les comptes de demonstration ont ete supprimes, il n'a rien
// a verifier : il le dit et se retire, plutot que de signaler un echec.
const fiche = db.prepare('SELECT id FROM agents WHERE login = ?').get(AGENT);
if (!fiche) {
  console.log(`Agent ${AGENT} absent : test ignore.`);
  console.log('Rejouez-le avec AGENT_TEST=<login> apres « npm run seed ».');
  db.close();
  process.exit(0);
}
db.prepare('DELETE FROM participations WHERE agent_id = ?').run(fiche.id);
db.prepare('DELETE FROM badges_agent WHERE agent_id = ?').run(fiche.id);
db.prepare('DELETE FROM tentatives WHERE agent_id = ?').run(fiche.id);

const cookie = await connecter(AGENT, 'demo2026');
const defis = await (await fetch(`${BASE}/api/defis`, { headers: { cookie } })).json();

let echecs = 0;
console.log(`Agent ${AGENT} joue un sans-faute sur ${defis.filter((d) => d.ouvert).length} defi(s) :\n`);

for (const d of defis.filter((x) => x.ouvert)) {
  const defi = await (await fetch(`${BASE}/api/defis/${d.id}`, { headers: { cookie } })).json();

  for (const q of defi.questions) {
    const bonnes = db.prepare('SELECT id FROM reponses WHERE question_id = ? AND correcte = 1').all(q.id).map((r) => r.id);
    const rep = await fetch(`${BASE}/api/defis/${d.id}/questions/${q.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ choix: bonnes }),
    });
    if (!rep.ok) throw new Error((await rep.json()).erreur);
  }

  const fin = await (await fetch(`${BASE}/api/defis/${d.id}/terminer`, { method: 'POST', headers: { cookie } })).json();
  const gagnes = fin.nouveauxBadges.map((b) => `${b.emoji} ${b.libelle}`).join(', ') || '-';
  console.log(`  S${d.id} ${String(fin.pourcentage).padStart(3)} %   ${gagnes}`);
  if (fin.pourcentage !== 100) {
    echecs++;
    console.log(`   ECHEC : le sans-faute ne donne pas 100 % (${fin.score}/${fin.scoreMax})`);
  }
}

const profil = await (await fetch(`${BASE}/api/profil`, { headers: { cookie } })).json();
const manquants = profil.badges.filter((b) => !b.obtenu);

console.log(`\nCatalogue : ${profil.badges.length} badges`);
console.log(`Obtenus   : ${profil.badges.filter((b) => b.obtenu).length}`);

if (manquants.length) {
  echecs++;
  console.log(`\n ECHEC  badge(s) inatteignable(s) meme en repondant parfaitement :`);
  for (const b of manquants) console.log(`         ${b.emoji} ${b.libelle} — ${b.description}`);
} else {
  console.log('\n  OK    tous les badges sont atteignables');
  for (const b of profil.badges) console.log(`        ${b.emoji} ${b.libelle}`);
}

db.close();
process.exit(echecs ? 1 : 0);
