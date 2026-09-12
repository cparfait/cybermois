/**
 * Renommer un service du referentiel doit le renommer partout : les agents
 * qui y sont rattaches - a la main ou par regle - le suivent, les regles qui
 * pointaient sur l'ancien nom visent le nouveau, et l'ancien libelle
 * d'annuaire retombe sur le nouveau nom a la prochaine connexion.
 * Sans cela, le classement continue d'afficher l'ancien nom.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseJetable, nettoyerALaFin } from './base-jetable.mjs';

baseJetable('renommage-referentiel', import.meta.url);
const { db } = await import('../src/lib/db.js');
const { enregistrerReferentiel, lireReferentiel } = await import('../src/lib/referentiel.js');
const { resoudreService } = await import('../src/lib/services.js');
nettoyerALaFin(db);

const PREFIXE = 'zz-test-renom-';
const ANCIEN = 'ZZ Finances test';
const NOUVEAU = 'ZZ Direction des finances test';
const SOUS_OU = 'ZZ Comptabilite test';

function agent(suffixe, service, ad = service, force = 0) {
  const login = PREFIXE + suffixe;
  db.prepare(`
    INSERT INTO agents (login, nom_complet, email, service, service_ad, service_brut, origine, service_force)
    VALUES (?, ?, ?, ?, ?, 'CN=test', 'annuaire', ?)
  `).run(login, `TEST ${suffixe}`, `${login}@test.local`, service, ad, force);
  return login;
}
const serviceDe = (login) => db.prepare('SELECT service FROM agents WHERE login = ?').get(login).service;

function nettoyer() {
  db.prepare('DELETE FROM agents WHERE login LIKE ?').run(`${PREFIXE}%`);
  db.prepare('DELETE FROM regroupements_service WHERE source LIKE ? OR cible LIKE ?').run('ZZ %', 'ZZ %');
  db.prepare("DELETE FROM referentiel_services WHERE nom LIKE 'ZZ %'").run();
  db.prepare("DELETE FROM journal WHERE action = 'referentiel_enregistre' AND detail LIKE '%ZZ %'").run();
}

test('renommer un service du referentiel deplace ses agents et ses regles', () => {
  const sauvegarde = lireReferentiel();
  try {
    nettoyer();
    enregistrerReferentiel([...sauvegarde.map((s) => s.nom), ANCIEN], 'test');
    db.prepare('INSERT INTO regroupements_service (source, cible) VALUES (?, ?)').run(SOUS_OU, ANCIEN);

    const direct = agent('direct', ANCIEN);
    const regroupe = agent('regroupe', ANCIEN, SOUS_OU);
    const force = agent('force', ANCIEN, 'ZZ Autre OU test', 1);
    const ailleurs = agent('ailleurs', 'ZZ Ailleurs test');

    const entrees = lireReferentiel().map((s) => ({ id: s.id, nom: s.nom === ANCIEN ? NOUVEAU : s.nom }));
    enregistrerReferentiel(entrees, 'test');

    assert.equal(serviceDe(direct), NOUVEAU, 'agent rattache directement');
    assert.equal(serviceDe(regroupe), NOUVEAU, 'agent rattache par regle');
    assert.equal(serviceDe(force), NOUVEAU, 'agent rattache a la main');
    assert.equal(serviceDe(ailleurs), 'ZZ Ailleurs test', 'les autres services ne bougent pas');

    assert.equal(resoudreService(SOUS_OU), NOUVEAU, 'la regle existante vise le nouveau nom');
    assert.equal(resoudreService(ANCIEN), NOUVEAU, "l'ancien libelle d'annuaire retombe sur le nouveau nom");
    assert.ok(lireReferentiel().some((s) => s.nom === NOUVEAU), 'le nouveau nom figure au referentiel');
    assert.ok(!lireReferentiel().some((s) => s.nom === ANCIEN), "l'ancien nom n'y figure plus");
  } finally {
    nettoyer();
    enregistrerReferentiel(sauvegarde.map((s) => s.nom), 'test');
    db.prepare("DELETE FROM journal WHERE action = 'referentiel_enregistre' AND detail LIKE '%ZZ %'").run();
  }
});

test('une liste de simples noms ne declenche aucun renommage', () => {
  const sauvegarde = lireReferentiel();
  try {
    nettoyer();
    enregistrerReferentiel([...sauvegarde.map((s) => s.nom), ANCIEN], 'test');
    const direct = agent('direct', ANCIEN);
    enregistrerReferentiel([...sauvegarde.map((s) => s.nom), NOUVEAU], 'test');
    assert.equal(serviceDe(direct), ANCIEN);
  } finally {
    nettoyer();
    enregistrerReferentiel(sauvegarde.map((s) => s.nom), 'test');
  }
});
