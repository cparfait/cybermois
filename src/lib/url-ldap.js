/**
 * Composition de l'URL de l'annuaire - source unique.
 *
 * Le module vit dans public/js parce que le navigateur doit le charger tel
 * quel : l'ecran de configuration decompose l'URL enregistree pour remplir le
 * champ « hote » et la case « chiffre », et le serveur la recompose a
 * l'enregistrement. Deux copies auraient fini par diverger, et la divergence
 * se serait vue le jour ou l'ecran affiche autre chose que ce qui est utilise.
 */
export { decomposerUrlLdap, composerUrlLdap, normaliserUrlLdap } from '../../public/js/url-ldap.js';
