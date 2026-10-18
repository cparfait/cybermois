/**
 * Simulation d'une campagne : plusieurs agents jouent plusieurs defis,
 * avec des niveaux de reussite differents. Sert a valider le scoring,
 * les badges et les classements avant la mise en service.
 *
 *   node tests/simulation.mjs [url]
 */
const BASE = process.argv[2] || 'http://localhost:3000';
const MOT_DE_PASSE = 'demo2026';

const AGENTS = [
  { login: 's.leroy', niveau: 1.0, nbDefis: 4 },
  { login: 'p.martin', niveau: 0.8, nbDefis: 4 },
  { login: 'a.bernard', niveau: 0.6, nbDefis: 2 },
  { login: 'j.dubois', niveau: 0.9, nbDefis: 3 },
  { login: 'n.moreau', niveau: 0.4, nbDefis: 1 },
  { login: 'l.petit', niveau: 0.7, nbDefis: 4 },
  { login: 'e.roux', niveau: 0.5, nbDefis: 2 },
  { login: 't.girard', niveau: 0.3, nbDefis: 1 },
  { login: 'f.lambert', niveau: 0.95, nbDefis: 4 },
  { login: 'v.chevalier', niveau: 0.85, nbDefis: 3 },
  { login: 'd.robin', niveau: 0.65, nbDefis: 2 },
  { login: 'c.parfait', niveau: 1.0, nbDefis: 4 },
];

// Generateur pseudo-aleatoire deterministe : la simulation est reproductible
let graine = 42;
const alea = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648; };

async function connecter(login) {
  const r = await fetch(`${BASE}/api/connexion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, motDePasse: MOT_DE_PASSE }),
  });
  if (!r.ok) throw new Error(`connexion ${login} : ${(await r.json()).erreur}`);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function jouer(cookie, defiId, niveau) {
  const defi = await (await fetch(`${BASE}/api/defis/${defiId}`, { headers: { cookie } })).json();
  if (defi.erreur) throw new Error(defi.erreur);

  const dejaFaites = new Set(defi.dejaRepondu || []);

  // Le defi se joue question par question : on suit le meme chemin que l'agent.
  for (const q of defi.questions) {
    if (dejaFaites.has(q.id)) continue;

    // Les bonnes reponses ne sont pas connues du client : on simule un agent
    // qui coche un sous-ensemble plausible, module par son niveau.
    const nb = q.multiple ? Math.max(1, Math.round(q.reponses.length * 0.5)) : 1;
    const choix = [];
    for (const r of q.reponses) {
      if (choix.length >= nb) break;
      if (alea() < niveau * 0.75 + 0.15) choix.push(r.id);
    }
    if (!choix.length) choix.push(q.reponses[0].id);

    const rep = await fetch(`${BASE}/api/defis/${defiId}/questions/${q.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ choix }),
    });
    if (!rep.ok) throw new Error((await rep.json()).erreur);
  }

  const fin = await fetch(`${BASE}/api/defis/${defiId}/terminer`, { method: 'POST', headers: { cookie } });
  const res = await fin.json();
  if (!fin.ok) throw new Error(res.erreur);
  return res;
}

/**
 * Se retirer, en le disant.
 *
 * Sans serveur ni agents de demonstration, cette simulation ne verifie rien.
 * Elle s'arretait alors sans expliquer pourquoi : on ne distinguait pas un
 * scoring valide d'un scenario qui n'avait jamais demarre.
 */
function ignorer(raison, remede) {
  console.log("IGNORE - tests/simulation.mjs n'a RIEN verifie.");
  console.log(`         Motif  : ${raison}`);
  console.log(`         Remede : ${remede}`);
  process.exit(0);
}

let serveurEnMarche = false;
try {
  const r = await fetch(`${BASE}/sante`, { signal: AbortSignal.timeout(3000) });
  serveurEnMarche = r.ok;
} catch { /* aucun serveur a cette adresse */ }

if (!serveurEnMarche) {
  ignorer(
    `aucun serveur Cybermois ne repond sur ${BASE}.`,
    'Lancez « npm start », puis « node tests/simulation.mjs [url] ».'
  );
}

console.log(`Simulation sur ${BASE}\n`);
let erreurs = 0;

// Les defis n'ont plus de numero d'ordre : chaque agent joue les N premiers
// deja parus, dans l'ordre des dates de parution.
let cookieAmorce;
try {
  cookieAmorce = await connecter(AGENTS[0].login);
} catch (e) {
  ignorer(
    `impossible de connecter l'agent de demonstration « ${AGENTS[0].login} » (${e.message}).`,
    'Peuplez la base de demonstration, ou visez une instance qui la contient.'
  );
}

const ouverts = (await (await fetch(`${BASE}/api/defis`, {
  headers: { cookie: cookieAmorce },
})).json()).filter((d) => d.ouvert);

if (!ouverts.length) {
  ignorer(
    'aucun defi n\'est ouvert sur cette instance : personne ne peut jouer.',
    'Programmez au moins un defi dont la date de parution est atteinte.'
  );
}

for (const agent of AGENTS) {
  try {
    const cookie = await connecter(agent.login);
    const traces = [];
    for (const d of ouverts.slice(0, agent.nbDefis)) {
      const r = await jouer(cookie, d.id, agent.niveau);
      traces.push(`${d.ouvreLe} ${String(r.pourcentage).padStart(3)}%`);
      if (r.nouveauxBadges?.length) traces.push(`[${r.nouveauxBadges.map((b) => b.libelle).join(', ')}]`);
    }
    console.log(`  ${agent.login.padEnd(13)} ${traces.join('  ')}`);
  } catch (e) {
    erreurs++;
    console.log(`  ${agent.login.padEnd(13)} ECHEC : ${e.message}`);
  }
}

const cookie = await connecter('c.parfait');
const c = await (await fetch(`${BASE}/api/classement`, { headers: { cookie } })).json();

console.log('\nClassement par service (defis par agent, puis reussite) :');
for (const [i, s] of c.services.entries()) {
  console.log(`  ${String(i + 1).padStart(2)}. ${s.service.padEnd(38)} ${String(s.defis_par_agent).padStart(4)}/${s.defis_parus} defis  ${String(s.pourcentage_moyen).padStart(3)}%  ${String(s.taux_participation).padStart(3)}% part.  (${s.joueurs}/${s.inscrits})`);
}

console.log('\nClassement individuel (10 premiers) :');
for (const [i, a] of c.agents.slice(0, 10).entries()) {
  console.log(`  ${String(i + 1).padStart(2)}. ${a.nom_complet.padEnd(20)} ${a.defis_joues}/${a.defis_parus} defis  ${String(a.score_total).padStart(5)} pts  ${a.service}`);
}

console.log('\nStatistiques :', JSON.stringify({
  inscrits: c.stats.inscrits, joueurs: c.stats.joueurs,
  participations: c.stats.participations, points: c.stats.points_cumules,
}));

process.exit(erreurs ? 1 : 0);
