import { exigerAdmin } from '../lib/session.js';
import {
  recalculerDefi, participationsAgent, corrigerReponse, lireCorrections,
} from '../lib/corrections.js';
import { csv } from '../lib/csv.js';

export default async function routesCorrections(app) {
  app.addHook('preHandler', exigerAdmin);

  /* ------------------------------------------------------------- Recalcul */

  /**
   * Rejoue toutes les participations d'un defi contre le bareme courant.
   * En simulation par defaut : on annonce qui bouge avant d'ecrire quoi que ce soit.
   */
  app.post('/api/admin/defis/:id/recalculer', async (requete, reponse) => {
    const simulation = requete.body?.simulation !== false;
    const motif = String(requete.body?.motif || '').trim();

    // Le motif est exige des que l'on ecrit, comme pour une correction
    // unitaire : un recalcul deplace des scores et des rangs, il doit pouvoir
    // s'expliquer. En simulation rien n'est ecrit, on n'exige rien.
    if (!simulation && motif.length < 5) {
      return reponse.code(400).send({
        erreur: 'Indiquez le motif du recalcul : il est enregistré au registre des '
          + "corrections, c'est ce qui rend la modification défendable.",
        code: 'MOTIF_REQUIS',
      });
    }

    const resultat = recalculerDefi(requete.params.id, {
      simulation,
      parQui: requete.agent.login,
      ip: requete.ip,
      motif,
    });
    if (!resultat.ok) return reponse.code(400).send({ erreur: resultat.message });
    return resultat;
  });

  /* -------------------------------------------- Resultats detailles d'un agent */

  app.get('/api/admin/agents/:id/resultats', async (requete, reponse) => {
    const detail = participationsAgent(Number(requete.params.id));
    if (!detail) return reponse.code(404).send({ erreur: 'Agent introuvable.' });
    return detail;
  });

  /* ------------------------------------------------------ Correction unitaire */

  app.patch('/api/admin/reponses/:id', async (requete, reponse) => {
    const choix = Array.isArray(requete.body?.choix) ? requete.body.choix : null;
    if (!choix) return reponse.code(400).send({ erreur: 'Liste de propositions attendue.' });

    const motif = String(requete.body?.motif || '').trim();
    if (motif.length < 5) {
      return reponse.code(400).send({
        erreur: 'Indiquez le motif de la correction : il est enregistré et consultable, '
          + "c'est ce qui rend la modification défendable.",
      });
    }

    const resultat = corrigerReponse(requete.params.id, choix, {
      parQui: requete.agent.login, ip: requete.ip, motif,
    });
    if (!resultat.ok) return reponse.code(400).send({ erreur: resultat.message });
    return resultat;
  });

  /* ---------------------------------------------------- Registre des corrections */

  app.get('/api/admin/corrections', async (requete) => ({
    corrections: lireCorrections(Number(requete.query?.limite) || 300),
  }));

  app.get('/api/admin/export/corrections.csv', async (requete, reponse) => {
    const lignes = lireCorrections(100000);
    const entetes = ['horodatage', 'par_qui', 'type', 'agent_login', 'agent_nom',
      'defi_id', 'question', 'avant', 'apres', 'motif', 'ip'];

    // Echappement commun : celui qui vivait ici ne neutralisait pas les
    // cellules que le tableur lit comme des formules. Le motif d'une
    // correction est une saisie libre, il pouvait en porter une.
    return reponse.type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="cybermois-corrections.csv"')
      .send(csv(lignes, entetes));
  });
}
