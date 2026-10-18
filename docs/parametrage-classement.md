# Transporter le paramétrage du classement

Rendre un classement par service lisible demande un travail qui ne se devine pas :
regrouper les libellés d'annuaire, écarter les comptes fonctionnels, rattacher à la
main les agents dont la fiche AD est incomplète. À Châtillon, cela représente
96 libellés ramenés à 38 services, 10 règles de regroupement et 24 décisions
individuelles.

Ce travail vit dans un **fichier**, pas dans le code. Deux raisons : le refaire après
chaque déploiement serait absurde, et l'inscrire en dur interdirait à une autre
collectivité d'utiliser l'application.

---

## Comment le classement est calculé

Le paramétrage décide **qui** est classé et dans quelle direction. Le calcul, lui, est
fixé dans le code (`src/lib/scoring.js`) et ne se règle pas ; on le rappelle ici parce que
c'est la première question que posent les directions.

Seuls les **défis déjà parus** comptent : un défi publié dont la date d'ouverture n'est pas
arrivée n'entre ni dans le nombre de défis, ni dans la réussite.

La **réussite** se lit sur les défis **faits** : les points obtenus sur le maximum des défis
que l'agent a terminés. Elle dit si l'on a bien répondu, pas combien de défis on a faits —
c'est le rôle du nombre de défis, qui passe donc en premier.

**Classement individuel** — dans cet ordre :

1. le nombre de défis terminés ;
2. à égalité, la réussite ;
3. à égalité encore, la première participation la plus ancienne.

Classé à la réussite d'abord, un agent qui n'avait fait que deux défis, sans faute, passait
devant un collègue qui les avait tous faits presque aussi bien :

| 4 défis parus | Défis | Réussite | Avant | Désormais |
|---|---|---|---|---|
| A : deux défis, sans faute | 2 / 4 | 100 % | 1er | 2e |
| B : les quatre, à 90 % | 4 / 4 | 90 % | 2e | 1er |

**Classement par direction** — dans cet ordre :

1. le nombre moyen de défis terminés par agent **inscrit**, joueurs ou non (« 2,6 / 4 ») :
   rapporté aux inscrits, il met sur le même pied une direction de 4 agents et une de 40,
   et un agent qui ne joue pas fait baisser la moyenne ;
2. à égalité, la réussite : la moyenne des résultats des agents qui ont joué ;
3. à égalité encore, le taux de participation (part des inscrits ayant joué au moins une fois).

Seules les directions du référentiel sont classées (voir plus bas).

---

## La procédure de mise en production

L'ordre compte. L'import **ne crée aucun agent** : il applique des décisions à des
fiches qui doivent déjà exister.

```
1. Exporter depuis la recette
2. Déployer la production
3. Synchroniser l'annuaire   ← indispensable avant l'étape 4
4. Importer le paramétrage
```

### 1. Exporter

```bash
npm run parametrage -- exporter parametrage/chatillon.json \
  --collectivite "Ville de Châtillon" \
  --note "Cybermois 2026"
```

Le fichier est versionné dans le dépôt : il suit donc l'application jusqu'en
production sans manipulation supplémentaire.

### 2 et 3. Déployer, puis synchroniser

Déployez la pile (voir `deploiement-portainer.md`), connectez-vous au back-office,
réglez l'annuaire, puis lancez **Agents → Synchroniser depuis l'annuaire** et validez
le sas. À ce stade le classement est brut : un service par libellé d'annuaire.

### 4. Importer

Dans Portainer, *Containers → cybermois → Console* :

```bash
npm run parametrage -- importer parametrage/chatillon.json
```

Le compte rendu indique ce qui a été appliqué et, surtout, **les identifiants absents
de la base**. S'il y en a beaucoup, c'est le signe que la synchronisation n'a pas
tourné, ou que la base de recherche LDAP est trop étroite.

---

## Ce que le fichier contient

| Section | Contenu |
|---|---|
| `referentiel` | La liste des services reconnus, dans son ordre |
| `regroupements` | Libellé d'annuaire → service du référentiel |
| `exclusionsSync` | Les règles qui écartent des comptes dès la synchronisation |
| `agents` | Les décisions individuelles : exclusion manuelle, rattachement forcé, masquage |

**Ce qu'il ne contient pas** : participations, scores, badges, sessions. Un paramétrage
n'est pas une sauvegarde — un test le vérifie explicitement. Pour sauvegarder les
résultats, c'est `/srv/docker/cybermois/data` qu'il faut copier.

Les agents sont désignés par leur identifiant, jamais par leur clé primaire : une base
neuve leur en donnera d'autres.

Seules les décisions **prises à la main** voyagent. Une exclusion prononcée par
l'annuaire — compte désactivé, compte disparu — se reconstitue d'elle-même à la
synchronisation suivante ; la transporter figerait un état périmé.

---

## Les deux modes d'import

```bash
npm run parametrage -- importer <fichier>              # remplacement (défaut)
npm run parametrage -- importer <fichier> --completer  # complément
```

**Remplacement** : le référentiel et les regroupements existants sont réécrits. C'est
le mode d'une mise en production.

**Complément** : rien n'est effacé, le fichier vient s'ajouter. C'est le mode d'un
rejeu après synchronisation, quand des décisions ont été prises entre-temps dans le
back-office.

Dans les deux cas l'import est **idempotent** : le rejouer ne change rien de plus.

Pour regarder un fichier sans rien écrire :

```bash
npm run parametrage -- resumer parametrage/chatillon.json
```

---

## Pour une autre collectivité

Aucune donnée de Châtillon n'est dans le code. Une autre commune part d'un référentiel
vide et le construit depuis le back-office : *Agents → Référentiel des services*, puis
*Services non référencés* pour rattacher les libellés de son annuaire. Elle exporte
ensuite son propre fichier.

Le fichier `parametrage/chatillon.json` peut simplement être supprimé : rien ne le lit
automatiquement, l'import se demande.
