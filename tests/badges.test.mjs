import { test } from 'node:test';
import assert from 'node:assert/strict';

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
 * Il fait exception a l'isolement des autres tests : il joue CONTRE un serveur
 * en marche, et lit donc forcement la base de ce serveur. C'est son objet. En
 * contrepartie, tant qu'aucun serveur ne repond il n'ouvre aucune base - sans
 * quoi le simple fait de le lancer creait data/cybermois.db.
 *
 *   npm start, puis : node --test tests/badges.test.mjs
 *   sur un autre port : CYBERMOIS_URL=http://localhost:3999 node --test tests/badges.test.mjs
 */
// Sous « node --test », les arguments portent le nom du fichier de test : une
// URL passee en argument y serait confondue avec lui. Elle se donne donc par
// l'environnement, qui traverse les deux modes de lancement.
const BASE = process.env.CYBERMOIS_URL
  || (process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:3000');
const AGENT = process.env.AGENT_TEST || 'i.masson';

/**
 * Se retirer, en le disant - sans quitter le processus.
 *
 * Ce test s'ecartait sur un « exit 0 » discret : dans le compte rendu de la
 * suite, il ressemblait trait pour trait a un test reussi, et un badge devenu
 * inatteignable serait passe inapercu pendant des mois.
 *
 * Le motif s'affiche donc, et le test est declare IGNORE - pas reussi. Quitter
 * le processus, en revanche, ne convient pas : sous « node --test » un arret
 * abrupt compte comme un echec, et fait meme trebucher libuv sous Windows. On
 * renseigne le motif, le lanceur s'occupe du reste.
 */
function motifDeRetrait(raison, remede) {
  console.log("IGNORE - tests/badges.test.mjs n'a RIEN verifie.");
  console.log(`         Motif  : ${raison}`);
  console.log(`         Remede : ${remede}`);
  return raison;
}

/** Le serveur repond-il ? Aucune base n'est ouverte tant qu'on l'ignore. */
async function serveurJoignable() {
  try {
    const r = await fetch(`${BASE}/sante`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false; // aucun serveur a cette adresse
  }
}

// « false », et surtout pas « null » : le lanceur de tests de Node considere
// tout « skip » non booleen comme une demande de saut, y compris null. Le test
// se serait donc derobe en silence meme avec un serveur en marche - exactement
// le travers que ce fichier est cense ne pas avoir.
const absent = (await serveurJoignable())
  ? false
  : motifDeRetrait(
    `aucun serveur Cybermois ne repond sur ${BASE}.`,
    'Lancez « npm start », puis « node --test tests/badges.test.mjs ».'
  );

async function connecter(login, motDePasse) {
  const r = await fetch(`${BASE}/api/connexion`, {
    method: 'POST',
    // Le serveur refuse les requetes modifiantes venues d'une autre origine :
    // on se declare comme le portail lui-meme, ce que fait le navigateur.
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ login, motDePasse }),
  });
  if (!r.ok) throw new Error(`connexion ${login} : ${(await r.json()).erreur}`);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

test('aucun badge du catalogue n est inatteignable', { skip: absent }, async () => {
  // Le serveur repond : sa base est celle qu'il faut lire, celle que designe
  // DB_FILE - ou data/cybermois.db a defaut, comme pour le serveur lui-meme.
  const { db } = await import('../src/lib/db.js');

  // Ce test a besoin d'un agent jouable. Sur une base de production, ou les
  // comptes de demonstration ont ete supprimes, il n'a rien a verifier.
  const fiche = db.prepare('SELECT id FROM agents WHERE login = ?').get(AGENT);
  if (!fiche) {
    db.close();
    const raison = motifDeRetrait(
      `l'agent de demonstration « ${AGENT} » n'existe pas dans la base du serveur.`,
      'Relancez avec AGENT_TEST=<login>, ou peuplez la base de demonstration.'
    );
    return void assert.ok(true, raison);
  }

  // On repart d'une ardoise vierge pour cet agent, sinon les defis deja joues
  // basculent en entrainement et ne decernent plus rien.
  db.prepare('DELETE FROM participations WHERE agent_id = ?').run(fiche.id);
  db.prepare('DELETE FROM badges_agent WHERE agent_id = ?').run(fiche.id);
  db.prepare('DELETE FROM tentatives WHERE agent_id = ?').run(fiche.id);

  const cookie = await connecter(AGENT, process.env.DEMO_MOT_DE_PASSE || 'demo2026');
  const entetes = { cookie, 'Sec-Fetch-Site': 'same-origin' };
  const defis = await (await fetch(`${BASE}/api/defis`, { headers: entetes })).json();
  const ouverts = defis.filter((d) => d.ouvert);

  if (!ouverts.length) {
    db.close();
    const raison = motifDeRetrait(
      'aucun defi n est ouvert sur ce serveur : il n y a rien a jouer.',
      'Programmez au moins un defi a une date passee, puis relancez.'
    );
    return void assert.ok(true, raison);
  }

  const echecs = [];
  console.log(`Agent ${AGENT} joue un sans-faute sur ${ouverts.length} defi(s) :\n`);

  try {
    for (const d of ouverts) {
      const defi = await (await fetch(`${BASE}/api/defis/${d.id}`, { headers: entetes })).json();

      for (const q of defi.questions) {
        const bonnes = db.prepare('SELECT id FROM reponses WHERE question_id = ? AND correcte = 1')
          .all(q.id).map((r) => r.id);
        const rep = await fetch(`${BASE}/api/defis/${d.id}/questions/${q.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...entetes },
          body: JSON.stringify({ choix: bonnes }),
        });
        if (!rep.ok) throw new Error((await rep.json()).erreur);
      }

      const fin = await (await fetch(`${BASE}/api/defis/${d.id}/terminer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...entetes },
        body: '{}',
      })).json();
      const gagnes = fin.nouveauxBadges.map((b) => `${b.emoji} ${b.libelle}`).join(', ') || '-';
      console.log(`  defi ${d.id} ${String(fin.pourcentage).padStart(3)} %   ${gagnes}`);
      if (fin.pourcentage !== 100) {
        echecs.push(`le sans-faute du defi ${d.id} ne donne pas 100 % (${fin.score}/${fin.scoreMax})`);
      }
    }

    const profil = await (await fetch(`${BASE}/api/profil`, { headers: entetes })).json();
    const manquants = profil.badges.filter((b) => !b.obtenu);

    console.log(`\nCatalogue : ${profil.badges.length} badges`);
    console.log(`Obtenus   : ${profil.badges.filter((b) => b.obtenu).length}`);

    if (manquants.length) {
      for (const b of manquants) console.log(`  INATTEIGNABLE  ${b.emoji} ${b.libelle} — ${b.description}`);
      echecs.push(`${manquants.length} badge(s) inatteignable(s) : `
        + manquants.map((b) => b.libelle).join(', '));
    } else {
      console.log('\n  OK    tous les badges sont atteignables');
    }
  } finally {
    db.close();
  }

  assert.deepEqual(echecs, [], echecs.join(' | '));
});
