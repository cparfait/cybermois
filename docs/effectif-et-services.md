# Constituer l'effectif et regrouper les services

Deux questions se posent avant l'ouverture : **qui participe** et **comment sont regroupés
les services**. Ce document traite les deux.

---

## Pourquoi importer l'effectif

Sans import, un agent n'apparaît qu'à sa première connexion. Trois conséquences :

- le **taux de participation est faux** — il se calcule sur les agents déjà venus, et affiche
  donc en permanence des valeurs proches de 100 % ;
- les **relances n'atteignent pas** ceux qui ne sont jamais venus, c'est-à-dire précisément
  ceux qu'il faudrait relancer ;
- vous ne savez pas quels services sont totalement absents.

L'import règle les trois. C'est l'opération la plus utile de la phase de préparation.

---

## Produire l'export depuis l'Active Directory

Sur un contrôleur de domaine, ou un poste doté des outils RSAT :

```bash
Get-ADUser -Filter "Enabled -eq 'True'" -SearchBase "OU=Utilisateurs,OU=AGENTS,DC=exemple,DC=lan" -Properties DisplayName, Mail, Department | Select-Object SamAccountName, DisplayName, Mail, Department, DistinguishedName | Export-Csv -Path C:\temp\agents.csv -NoTypeInformation -Encoding UTF8 -Delimiter ";"
```

Quelques précisions utiles :

- `-Filter "Enabled -eq 'True'"` écarte d'emblée les comptes désactivés ;
- `-SearchBase` limite au conteneur des agents : sans lui, vous récupérez aussi les comptes
  de service et les comptes machines ;
- **incluez toujours `DistinguishedName`** : c'est lui qui porte l'arborescence des OU, dont
  l'application se sert pour proposer les regroupements ;
- `-Encoding UTF8` évite les accents cassés — l'application sait aussi lire du Windows-1252,
  mais autant partir propre.

Ouvrez ensuite le fichier dans Excel pour retirer ce qui n'a rien à faire dans la campagne :
comptes de service, boîtes partagées, comptes génériques, comptes de test. C'est le seul
tri manuel nécessaire, et il ne se fait qu'une fois.

### Colonnes reconnues

L'import ne vous impose aucun nom de colonne particulier. Sont reconnus, sans distinction
de casse ni d'accents :

| Champ | En-têtes acceptés | |
|---|---|---|
| Identifiant | `login`, `sAMAccountName`, `identifiant`, `utilisateur`, `uid` | **obligatoire** |
| Nom affiché | `DisplayName`, `nom complet`, `cn` — ou `Prénom` + `Nom` séparés | |
| Adresse | `mail`, `email`, `courriel`, `userPrincipalName` | |
| Service | `service`, `department`, `direction`, `bureau` | |
| Arborescence | `DistinguishedName`, `dn` | recommandé |

Le séparateur (point-virgule, virgule, tabulation) est détecté automatiquement, les
guillemets sont respectés, et un identifiant de la forme `DOMAINE\p.dupont` est nettoyé.

### Importer

**Administration → Agents → Importer un export d'annuaire.**

L'analyse s'exécute d'abord **sans rien écrire** : elle annonce combien d'agents seront
ajoutés, combien de fiches seront mises à jour, quels changements de service auront lieu,
quelles lignes sont rejetées et pourquoi. Rien n'est enregistré tant que vous n'avez pas
confirmé.

Si des agents sont déjà en base mais absents du fichier — des départs, typiquement — une
case permet de les **exclure** de la campagne. Ils ne sont pas supprimés : leurs résultats
sont conservés.

---

## Regrouper les services

### Le problème

Un annuaire réel comporte des sous-OU. « Crèches », « Multi-accueil » et « Halte-garderie »
sont trois OU distinctes qui, pour la campagne, ne forment qu'un seul service.

`SERVICE_OU_DEPTH` ne suffit pas : il applique une profondeur **uniforme**, alors que vos
branches n'ont pas toutes la même. Prendre la profondeur 2 regrouperait bien la petite
enfance, mais remonterait aussi les Finances dans un conteneur générique.

### Pourquoi ne pas trier le fichier à la main

Parce que le tri serait contourné. Un agent qui se connecte crée sa fiche à partir de son
DN, sans passer par votre fichier : il repartirait dans sa sous-OU d'origine. Il faudrait
en plus refaire le tri à chaque réimport.

### La solution retenue

**Administration → Agents → Regrouper les services** tient une table de correspondance
« libellé lu dans l'annuaire → service affiché ». Elle s'applique aux deux chemins d'entrée,
l'import comme la connexion, et de façon durable.

L'écran liste les libellés présents, leur effectif, leur arborescence d'OU, et **propose un
regroupement** fondé sur l'OU parente. Les conteneurs techniques présents dans toutes les
branches — `OU=Agents`, `OU=Utilisateurs` — sont automatiquement écartés des propositions :
les retenir fusionnerait toute la collectivité en un seul service.

Exemple sur une arborescence réelle :

| Libellé annuaire | Arborescence | Proposition |
|---|---|---|
| Crèches | Crèches ← Petite enfance ← Agents | Petite enfance |
| Multi-accueil | Multi-accueil ← Petite enfance ← Agents | Petite enfance |
| Écoles maternelles | Écoles maternelles ← Affaires scolaires ← Agents | Affaires scolaires |
| Restauration scolaire | Restauration scolaire ← Affaires scolaires ← Agents | Affaires scolaires |
| Finances | Finances ← Agents | *(aucune — déjà au bon niveau)* |

Le bouton « Appliquer les propositions » remplit le tableau ; vous ajustez ce qui ne convient
pas, puis vous enregistrez. Les agents sont réaffectés immédiatement et le classement est
recalculé.

**Le libellé d'origine est conservé** dans la fiche de chaque agent. Vous pouvez donc revenir
sur un regroupement à tout moment, sans réimporter : c'est recalculé à partir de l'annuaire
d'origine.

### Combien de services viser

Entre 10 et 25 pour 500 agents. En dessous, la compétition perd son sel — un agent ne se sent
pas concerné par un score de « Direction générale » à 200 personnes. Au-delà de 30, le
classement devient illisible et beaucoup de services n'ont qu'un ou deux agents, ce qui rend
leur score très instable.

---

## Ajouter, modifier, écarter un agent

**Administration → Agents** permet de rechercher, filtrer par service et par état
(jamais connectés, sans adresse, aucun défi terminé, exclus), puis d'agir en masse.

Trois notions à distinguer :

| Action | Effet |
|---|---|
| **Ajouter** | Crée une fiche. **Ne crée aucun compte** : l'agent se connectera avec son compte AD. Utile pour un arrivant. |
| **Exclure** | L'agent ne peut plus se connecter, sort des effectifs et des relances. Ses résultats sont conservés. **C'est le bon réflexe** pour un départ ou un compte hors périmètre. |
| **Supprimer** | Efface la fiche et tous ses résultats. Irréversible, et modifie le score de son service. L'application demande confirmation si l'agent a déjà joué. |

Une subtilité qui explique pourquoi l'exclusion est préférable : un agent **supprimé** qui se
reconnecte voit sa fiche recréée automatiquement. Un agent **exclu** est refusé à la connexion.

### Droit d'opposition au classement nominatif

La case **« Masquer du classement individuel »** répond au cas d'un agent qui ne souhaite pas
voir son nom affiché. Il apparaît alors comme « Agent anonyme » mais continue d'alimenter le
score de son service, et conserve l'accès à ses propres résultats.

C'est l'atténuation annoncée dans les mentions légales. Si la DPO préfère que les agents
puissent l'activer eux-mêmes depuis leur profil, c'est une évolution à demander : la case
existe déjà côté données, il ne manque que son exposition dans le profil de l'agent.

---

## Quand l'annuaire ne dit pas le service

Aucun annuaire de collectivité n'est renseigné à 100 %. Deux règles protègent les
rattachements de ce qui manque :

- **Repli d'une source sur l'autre.** La source configurée — l'attribut `department`, ou
  l'OU du DN — reste prioritaire, mais l'autre prend le relais quand elle est vide. Un agent
  dont le `department` n'est pas rempli est donc rattaché d'après son OU, au lieu de tomber
  dans « Non rattaché ».
- **Le silence n'écrase rien.** Quand l'annuaire ne dit rien du tout — ni attribut, ni OU —
  la synchronisation et la connexion **laissent la fiche telle quelle**. Un agent déjà
  rattaché garde sa direction ; seul un compte inconnu arrive en « Non rattaché ».

Le sas de synchronisation affiche le nombre de comptes concernés, sous l'intitulé
« sans service dans l'annuaire ». C'est le chiffre à surveiller : il désigne les fiches à
compléter dans l'AD, et **Administration → Agents → Rattachement** permet en attendant de
les affecter à la main — un rattachement manuel résiste ensuite à toutes les
synchronisations.

---

## Vérifier avant l'ouverture

Un outil de diagnostic lit votre configuration et contrôle tout ce qui peut coincer, sans
rien modifier ni afficher aucun mot de passe :

```bash
npm run diagnostic
```

> **Depuis le dépôt, pas depuis le conteneur.** L'outil lit sa configuration dans `.env`,
> jamais dans la base, et il est volontairement exclu de l'image par `.dockerignore`.
> Lancez-le sur la machine où se trouve le clone git, avec un `.env` renseigné et
> `npm install` fait. Une fois l'annuaire réglé dans le back-office, l'équivalent en ligne
> est **Administration → Configuration → Tester la connexion**, qui travaille sur la
> configuration réellement enregistrée.

Il vérifie la joignabilité du contrôleur de domaine, le certificat présenté, le compte de
service, puis analyse l'annuaire : nombre de comptes actifs, couverture des adresses mail
et de l'attribut `department`, et surtout **la répartition des services pour chaque valeur
de `SERVICE_OU_DEPTH`** — ce qui vous permet de choisir la bonne profondeur en connaissance
de cause.

```bash
npm run diagnostic -- --ou
```

affiche la répartition complète, et

```bash
npm run diagnostic -- --agent p.dupont
```

montre exactement à quel service un agent donné serait rattaché.
