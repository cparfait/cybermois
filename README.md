# Cybermois — Ville de Châtillon

Portail interne de sensibilisation à la cybersécurité, sous forme de campagne gamifiée de
quatre semaines. Les agents s'authentifient avec leur compte Active Directory (LDAPS),
relèvent les défis au fil de leurs parutions, et font gagner des points à leur service.

- **Authentification LDAPS** via un compte de service, sans jamais stocker de mot de passe
- **Rattachement au service déduit de l'annuaire** (OU du DN) : aucune liste à maintenir
- **Double classement** : par service (défis terminés par agent, puis réussite) et individuel nominatif (défis terminés, puis réussite)
- **Questions à choix multiples** avec validation explicite et notation partielle
- **Barème unique** : dix questions par défi, cent points, la difficulté fixant les points
- **Badges, podium, attestation imprimable**
- **Relances et résultats hebdomadaires** envoyés automatiquement par SMTP
- **Import de l'effectif** depuis un export d'annuaire, avec prévisualisation
- **Regroupement des sous-OU** en services, avec proposition automatique
- **Gestion des agents** : ajout, modification, exclusion, suppression, actions groupées
- **Configuration depuis le back-office** : Active Directory, SMTP et planification se règlent dans l'interface, sans redéployer, avec tests intégrés
- **Compte administrateur local**, indépendant de l'annuaire, pour l'amorçage et le dépannage
- **Back-office** : suivi en direct, éditeur de questions, aperçu des mails, exports CSV
- Aux couleurs de la charte graphique de la Ville, conforme aux principes du RGAA 4.1

---

## Démarrage rapide (démonstration, sans Active Directory)

Utile pour montrer l'outil à la direction ou à la DPO avant d'avoir le compte de service AD.

```bash
npm install
cp .env.example .env
```

Dans `.env`, renseignez :

```
LDAP_URL=demo
ADMIN_LOGINS=votre.login
MAIL_ENVOI_ACTIF=false
CAMPAGNE_DEBUT=2026-10-05
```

`NODE_ENV` n'a pas à être touché : il est **volontairement absent** de `.env.example`, et
sans lui l'application démarre en mode développement, qui est celui de la démonstration.
C'est en production que la valeur est imposée — par l'image Docker et par les piles
`docker-compose`. Si vous lancez le serveur à la main hors conteneur pour un déploiement
réel, ajoutez alors `NODE_ENV=production` et un vrai `SESSION_SECRET`.

Puis :

```bash
npm start
```

Le portail est disponible sur http://localhost:3000. Quinze comptes fictifs répartis sur
six services sont fournis (`s.leroy`, `p.martin`, `f.lambert`…), tous avec le mot de passe
`demo2026` — modifiable par `DEMO_MOT_DE_PASSE` si la démonstration doit être montrée sur
un réseau partagé. Le compte administrateur de la démonstration est `c.parfait`.

Le mode démonstration **refuse de démarrer si `NODE_ENV=production`** : il est impossible
de le mettre en service par inadvertance.

Pour remplir la base de résultats fictifs et voir les classements vivre :

```bash
node tests/simulation.mjs
```

---

## Déploiement

Six documents selon votre besoin :

| Document | Contenu |
|---|---|
| [`docs/deploiement-portainer.md`](docs/deploiement-portainer.md) | Pile Portainer + Nginx Proxy Manager, pas à pas |
| [`docs/configuration.md`](docs/configuration.md) | Réglages depuis le back-office, compte local, tests intégrés |
| [`docs/effectif-et-services.md`](docs/effectif-et-services.md) | Import de l'effectif, regroupement des sous-OU |
| [`docs/parametrage-classement.md`](docs/parametrage-classement.md) | Transporter le référentiel des services de la recette vers la production |
| [`docs/exploitation.md`](docs/exploitation.md) | Incidents fréquents, sauvegarde, purge, compromission, dépannage |
| [`docs/planning.md`](docs/planning.md) | Rétroplanning de la campagne, avant / pendant / après |

### Compte administrateur local

```bash
npm run admin -- lister
npm run admin -- definir admin "une phrase de passe"
```

Le compte est créé au premier démarrage ; son mot de passe s'écrit dans `data/admin-initial.txt`,
jamais dans les journaux, et ce fichier s'efface au premier changement. Perdu, la commande
ci-dessus le redéfinit.
En conteneur : `docker compose exec cybermois npm run admin -- definir admin "…"`.

### Diagnostic préalable

Avant toute chose, vérifiez la configuration sans rien modifier :

```bash
npm run diagnostic
```

Il contrôle la joignabilité du contrôleur de domaine, le certificat, le compte de service,
puis analyse l'annuaire et vous indique **quelle valeur de `SERVICE_OU_DEPTH` retenir** au vu
de la répartition réelle de vos OU. Aucun mot de passe n'est affiché.

> **Il se lance depuis le dépôt, pas depuis le conteneur.** `tests/diagnostic-ad.mjs` est un
> outil d'exploitation malgré son emplacement, mais il **lit sa configuration dans `.env`**
> et jamais dans la base : le lancer dans le conteneur d'une pile Portainer ne verrait que
> des variables vides. Il est d'ailleurs exclu de l'image par `.dockerignore`, volontairement
> — l'image de production n'a pas à embarquer les tests.
>
> Le mode d'emploi est donc : sur le serveur (ou un poste d'administration) où se trouve le
> clone git, renseigner un `.env` avec les valeurs AD, puis `npm install && npm run
> diagnostic`. Une fois l'application configurée depuis le back-office, l'équivalent en
> ligne est **Administration → Configuration → Tester la connexion**, qui, lui, travaille
> sur la configuration réellement enregistrée.

## Mise en service

### 1. Prérequis côté Active Directory

Un **compte de service en lecture seule** est nécessaire. Il sert uniquement à rechercher
l'utilisateur dans l'annuaire ; le mot de passe de l'agent est ensuite vérifié par un bind
sur son propre DN, puis oublié.

Vérifiez la structure de vos OU avant de configurer le rattachement au service :

```bash
Get-ADUser -Filter * -Properties DistinguishedName | Select-Object -First 20 DistinguishedName
```

Pour un DN de la forme
`CN=Jean Dupont,OU=Etat civil,OU=Agents,DC=ville,DC=local`,
`SERVICE_OU_DEPTH=1` retient « Etat civil » et `SERVICE_OU_DEPTH=2` retient « Agents ».

Si vos OU ne correspondent pas au découpage en services souhaité, basculez sur l'attribut
`department` avec `SERVICE_SOURCE=attr`, après avoir vérifié sa couverture :

```bash
Get-ADUser -Filter * -Properties department | Group-Object department | Sort-Object Count -Descending
```

### 2. Chiffrement de la liaison

En `ldaps://` (port 636), la liaison est chiffrée : c'est la configuration attendue en
production. En `ldap://` (port 389), **le mot de passe de chaque agent circule en clair**
sur le réseau.

L'application accepte `ldap://` en développement, pour faciliter une première mise au point.
En production, elle **démarre quand même** — mais avec un avertissement dans les journaux,
et surtout **l'authentification des agents est refusée** tant que la liaison est en clair.
Le compte administrateur local, lui, continue de fonctionner : c'est ce qui permet de
corriger la configuration depuis le back-office.

La variable `LDAP_AUTORISER_NON_CHIFFRE=true` lève ce refus. Elle n'a sa place qu'en
recette, et temporairement : un portail de sensibilisation à la cybersécurité qui
diffuserait les mots de passe en clair serait difficile à défendre.

### 3. Certificat LDAPS

Deux façons de fournir l'autorité de certification interne :

- **`LDAP_CA_BASE64`** — le certificat encodé en base64 sur une ligne. À privilégier :
  aucune manipulation de fichier, ce qui simplifie beaucoup un déploiement via Portainer.
  `[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\temp\ca.cer"))`
- **`LDAP_CA_FILE`** — le chemin d'un fichier monté dans le conteneur. **Il dépend de la
  pile** : `/app/certs/ca-interne.crt` avec `docker-compose.yml`, qui monte `./certs` sur
  `/app/certs` ; `/certs/ca.pem` avec `docker-compose.portainer.yml`, qui monte le dossier
  d'AC de l'hôte sur `/certs`.

Laissez `LDAP_TLS_REJECT_UNAUTHORIZED=true`. Ne passez cette valeur à `false` qu'en
recette, jamais en production : la validation du certificat est ce qui garantit que vous
parlez bien à votre contrôleur de domaine.

### 4. Configuration

Reportez-vous à `.env.example`, qui documente chaque variable. Les points d'attention :

| Variable | Remarque |
|---|---|
| `SESSION_SECRET` | 32 caractères aléatoires minimum, propre à l'installation. **En production, l'application refuse de démarrer** s'il est absent, s'il vaut la valeur de développement par défaut, ou s'il est trop court. Il chiffre aussi les mots de passe AD et SMTP enregistrés : le changer oblige à les ressaisir. Ne jamais le commiter. |
| `PUBLIC_URL` | URL réellement vue par les agents — elle alimente les liens des mails, conditionne le drapeau `secure` du cookie et l'émission de `Strict-Transport-Security` en `https` |
| `PROXY_DE_CONFIANCE` | IP ou CIDR du reverse proxy. **Vide, les en-têtes `X-Forwarded-*` sont ignorés** et le journal porte l'adresse du proxy pour tous les agents |
| `ADMIN_LOGINS` | Logins AD autorisés au back-office, séparés par des virgules |
| `CAMPAGNE_DEBUT` | Date de référence de la campagne ; chaque défi porte sa propre date de parution |
| `MAIL_ENVOI_ACTIF` | Laisser à `false` tant que la recette n'est pas terminée |
| `RETENTION_JOURNAL_JOURS`, `RETENTION_RESULTATS_JOURS`, `RETENTION_PREUVES_JOURS` | Durées de conservation appliquées par la purge automatique (180 / 456 / 1095 jours). Elles correspondent aux mentions légales : ne les changer qu'avec la DPO |

Le chemin du certificat de l'AC dépend de la pile : `docker-compose.yml` monte `./certs`
sur `/app/certs` (`LDAP_CA_FILE=/app/certs/ca-interne.crt`), la pile Portainer monte le
dossier d'AC de l'hôte sur `/certs` (`LDAP_CA_FILE=/certs/ca.pem`). `LDAP_CA_BASE64` évite
la question en se passant de fichier.

### 5. Déploiement

```bash
docker compose up -d --build
docker compose logs -f cybermois
```

Le service n'est joignable que sur `127.0.0.1:3000`. Publiez-le via Nginx Proxy Manager
en HTTPS.

> **Précision utile en cas de doute.** Le serveur, lui, écoute sur `0.0.0.0` à l'intérieur
> du conteneur. Ce qui restreint l'accès à la boucle locale, c'est la publication de port
> `127.0.0.1:3000:3000` dans `docker-compose.yml` — pas l'application. La pile Portainer,
> elle, ne publie **aucun** port : le conteneur n'est joignable que depuis le réseau Docker
> partagé, par Nginx Proxy Manager.

> **Important — configuration du reverse proxy.** Nginx Proxy Manager doit transmettre
> l'adresse réelle du client :
>
> ```
> proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
> proxy_set_header X-Forwarded-Proto $scheme;
> proxy_set_header X-Real-IP $remote_addr;
> ```
>
> **Et l'application doit être autorisée à les croire.** Sans `PROXY_DE_CONFIANCE`, les
> en-têtes `X-Forwarded-*` sont ignorés d'où qu'ils viennent, et la journalisation
> enregistrera l'IP du proxy pour tous les agents. Renseignez-y l'adresse ou la plage CIDR
> du proxy — et rien d'autre : une plage trop large permettrait à n'importe qui de choisir
> l'adresse qui figure au journal.
>
> La limitation des tentatives de connexion, elle, est indexée sur le **compte** et non
> sur l'IP : elle reste correcte même derrière un NAT, et 500 agents peuvent se connecter
> le même matin sans se bloquer mutuellement.

### 6. Vérification

Connectez-vous, ouvrez **Administration → Technique** : le diagnostic teste en direct
la liaison LDAPS et le relais SMTP, et affiche la configuration effectivement chargée.

Un détail qui surprend la première fois : laisser le champ mot de passe vide lors d'un test
ne reprend le mot de passe enregistré **que si l'hôte testé est celui qui est enregistré**.
Changer d'adresse de serveur impose de ressaisir le mot de passe, et chaque test est
journalisé avec l'hôte visé. Voir
[`docs/configuration.md`](docs/configuration.md).

---

## Exploitation pendant la campagne

### Rythme hebdomadaire

| Jour | Message | Émetteur |
|---|---|---|
| Lundi | Lancement du défi qui vient de paraître | **La DPO**, depuis sa messagerie |
| Mercredi 9h | Relance des agents n'ayant pas joué | Automatique |
| Vendredi 16h | Résultats et classement | Automatique, au groupe de distribution |

Le mail du lundi est volontairement laissé à la main de la DPO : il porte sa signature et
son autorité, ce qui pèse nettement plus qu'un message automatique. Le back-office
(**Administration → Mails**) en génère le texte prêt à copier-coller, en version texte
ou HTML, avec l'objet suggéré.

Les horaires d'envoi automatique se règlent par `CRON_RELANCE` et `CRON_RESULTATS`.
Chaque envoi peut aussi être déclenché manuellement, et **simulé** au préalable pour
compter les destinataires sans rien envoyer.

Un verrou empêche deux envois simultanés de relances, ou de résultats, sur le même défi :
le double-clic sur « Envoyer », ou l'envoi manuel lancé à la minute où la tâche planifiée
démarre, ne produit plus de message en double. Le second envoi est refusé avec un message
explicite.

### Modifier les questions

Deux méthodes, au choix :

- **Par le back-office** — Administration → Défis → Modifier. Édition complète des énoncés,
  contextes, réponses, bonnes réponses, difficulté et explications. C'est la méthode à
  privilégier pendant la campagne.
- **Par les fichiers** — `content/modules/<code>.json`, puis Administration → Technique →
  Recharger les contenus. Pratique pour préparer une édition suivante ou versionner les
  contenus dans Git.

Les deux ne se mélangent pas : **un défi modifié dans le back-office n'est plus jamais
réécrit depuis son fichier**, ni au redémarrage qui suit chaque mise à jour de
l'application, ni par « Recharger les contenus », ni en forçant. Retiré du programme, il
est masqué plutôt que supprimé. La liste des défis le signale par « ✎ modifié ici —
protégé du rechargement ». Un défi déjà joué n'est écrasé qu'en forçant explicitement.

### Le barème : dix questions, cent points

Chaque défi compte **dix questions pour cent points**, répartis ainsi :

| Difficulté | Points | Par défi |
|---|---|---|
| Facile — un réflexe, une définition | 5 | 3 questions |
| Moyenne — choisir entre des conduites plausibles | 10 | 4 questions |
| Difficile — cas limite, piège, procédure | 15 | 3 questions |

Les points **ne se saisissent pas** : ils découlent de la difficulté, et l'enregistrement
d'un défi qui s'écarte de cette répartition est refusé, en disant ce qui manque.

Les deux exigences derrière cette règle sont également fortes. Une question difficile doit
rapporter davantage qu'une question de réflexe — sans quoi reconnaître une signature de
domaine vaut autant que reconnaître une pièce jointe suspecte. Et deux défis doivent peser
le même poids au classement : quand un questionnaire valait 115 points et un autre 70,
c'était la semaine, et non l'agent, qui décidait du classement — celui qui avait manqué la
semaine lourde ne rattrapait plus, quoi qu'il fasse ensuite.

Le catalogue est vérifié par `node --test tests/modules.test.mjs`, et l'écran de
programmation signale tout module qui ne tiendrait pas le barème.

### Suivre la participation

**Administration → Suivi** affiche le taux de participation global, le détail par défi,
le classement des services et la liste des services à relancer.

Attention à une subtilité de lecture : le nombre d'agents « inscrits » correspond aux agents
**s'étant connectés au moins une fois**. Le taux affiché est donc un taux de participation
parmi les agents touchés, et non parmi l'effectif total de la collectivité. Pour le taux
réel, rapportez le nombre de joueurs à votre effectif de référence.

### Exports

Cinq exports CSV (UTF-8 avec BOM, séparateur point-virgule, directement lisibles par Excel) :
participations détaillées, classement des services, classement individuel, **preuve de
participation** exploitable en audit SSI, et journal des actions.

---

## Choix de conception

**Le classement par service est une moyenne par agent, pas un total.** Un total brut
ferait mécaniquement gagner le service le plus nombreux, ce qui décourage les petits
services dès la première semaine. Le taux de participation est affiché à côté du score :
c'est en pratique le chiffre qui fait bouger les chefs de service.

**La participation passe avant la réussite.** Les agents se classent d'abord au nombre de
défis terminés, puis à la réussite ; les services, au nombre moyen de défis terminés par agent
inscrit, puis à la réussite. La réussite se lit sur les seuls défis faits : classé à la
réussite d'abord, un agent qui n'avait fait que deux défis sans faute passait devant un
collègue qui les avait tous faits à 90 %. Le détail est dans `docs/parametrage-classement.md`.

**Pas de score négatif.** Une mauvaise réponse cochée annule une bonne réponse au sein de
la même question, mais le score d'une question ne descend jamais sous zéro. L'objectif est
pédagogique : on ne punit pas l'erreur, on l'explique.

**Un seul essai comptabilisé.** Rejouer un défi est possible, mais bascule en mode
entraînement et ne modifie pas le classement. Les défis déjà parus restent
ouverts jusqu'à la fin de la campagne : mieux vaut un agent qui rattrape tardivement qu'un
agent qui abandonne.

**Bonus de rapidité plafonné et encadré.** Il vaut au maximum 20 % du score, et n'est
attribué qu'entre 12 et 45 secondes par question : répondre au hasard en dix secondes ne
rapporte rien.

**Les bonnes réponses ne sont jamais envoyées au navigateur avant validation.** La
correction est calculée côté serveur.

---

## Protection des données

- Le mot de passe de l'agent n'est **jamais** stocké, ni en clair ni sous forme dérivée.
- Un unique cookie technique de session, sans traceur ni mesure d'audience — donc aucun
  bandeau de consentement.
- **Aucune ressource externe** : les polices sont celles du système, plus rien n'est
  chargé depuis `fonts.googleapis.com`. Aucune requête ne part vers un tiers à l'ouverture
  d'une page, et la CSP n'a plus à les autoriser.
- Les journaux applicatifs masquent explicitement les mots de passe et les cookies.
- **Les durées de conservation annoncées sont appliquées** par une purge automatique :
  journaux à 6 mois, participations et réponses nominatives jusqu'à la fin de l'année
  civile suivant la campagne, preuves de participation agrégées à 3 ans. Voir
  [`docs/exploitation.md`](docs/exploitation.md).
- La page `/mentions` porte la notice d'information complète, à faire valider par la DPO
  avant l'ouverture. Les durées qu'elle annonce et les variables `RETENTION_*` doivent
  rester cohérentes.

**Point à arbitrer avec la DPO avant la mise en service.** Le classement individuel est
nominatif. C'est un choix assumé, mais dans le secteur public un classement nominatif de
performance peut être perçu comme une évaluation individuelle. Deux atténuations sont
prévues et documentées dans les mentions légales : le classement n'a aucune incidence
professionnelle, et un agent peut demander à ne pas y figurer tout en continuant à
alimenter le score de son service. Cette exclusion se fait dans le back-office, par la case
**« Masquer du classement individuel »** de la fiche de l'agent (Administration → Agents),
sans aucune manipulation en base ; si la DPO le demande, elle peut aussi être exposée
directement dans le profil de l'agent.

---

## Architecture

```
src/
  server.js              Serveur Fastify, en-têtes de sécurité, planification
  lib/
    config.js            Chargement de la configuration (.env)
    db.js                Schéma SQLite et journalisation
    ldap.js              Authentification LDAPS, extraction du service depuis le DN
    annuaire-demo.js     Annuaire simulé (démonstration et recette)
    session.js           Sessions en base, cookies, contrôle d'accès
    scoring.js           Barème, badges, classements
    mail.js              Gabarits et envoi des messages
    seed.js              Import et export des contenus
    services.js          Regroupement des sous-OU en services
    parametres.js        Reglages en base, secrets chiffres
    admin-local.js       Compte administrateur independant de l'annuaire
    import-csv.js        Analyse tolérante des exports d'annuaire
    retention.js         Purge des donnees au-dela de leur duree de conservation
  routes/
    auth.js              Connexion, déconnexion
    jeu.js               Défis, validation, classements, profil
    admin.js             Back-office, exports, mails
    utilisateurs.js      Agents : import, ajout, exclusion, regroupements
    configuration.js     Reglages, tests LDAP et SMTP, comptes locaux
content/modules/          Catalogue des questionnaires, éditables
public/                  Interface (HTML, CSS, modules ES — aucun outil de build)
tests/                   Tests unitaires (*.test.mjs), plus deux outils :
                         simulation.mjs et diagnostic-ad.mjs
```

*(Vue d'ensemble, non exhaustive : `src/lib/` comporte d'autres modules de moindre portée.)*

Le dossier `tests/` ne contient pas que des tests. Deux fichiers y sont des **outils
d'exploitation**, lancés à la main depuis le dépôt :

| Fichier | Commande | Rôle |
|---|---|---|
| `tests/diagnostic-ad.mjs` | `npm run diagnostic` | Diagnostic AD et SMTP sur la configuration lue dans `.env` |
| `tests/simulation.mjs` | `node tests/simulation.mjs` | Remplit une base de démonstration de résultats fictifs |

Ils vivent là pour ne pas être embarqués dans l'image de production : `.dockerignore`
exclut `tests`. Corollaire à retenir — **ils ne se lancent pas dans le conteneur**, mais
depuis le clone git, avec `npm install` fait.

**Choix techniques.** Node.js 24 avec le module natif `node:sqlite` : pas de dépendance
native à compiler, donc pas de surprise à la reconstruction de l'image. Front en modules ES
sans build : le code livré est le code exécuté, ce qui facilite l'audit et la reprise par
un tiers.

## Tests

```bash
npm test
```

C'est la commande de référence : elle lance la vingtaine de fichiers `tests/*.test.mjs`,
sans dépendance externe ni serveur démarré. En repli, ou pour la lancer à la main :

```bash
node --test "tests/*.test.mjs"
```

**Les guillemets ne sont pas décoratifs.** `node --test tests/` échoue sous Windows, où le
chemin de dossier est pris pour un fichier ; les guillemets confient le motif à Node plutôt
qu'au shell, ce qui donne le même comportement sous Windows, macOS et Linux.

Un fichier isolé se lance directement, par exemple `node --test tests/dn.test.mjs`. Le
détail de ce que chacun couvre est en tête de fichier.

Les deux autres fichiers de `tests/` ne sont pas des tests mais des outils, décrits plus
haut : `npm run diagnostic` (AD et SMTP sur configuration réelle) et
`node tests/simulation.mjs` (campagne fictive complète, serveur démarré requis).

## Après la campagne

Conservez la base `data/cybermois.db` : elle porte la preuve de participation.
Sauvegardez-la avec `VACUUM INTO` et non par une simple copie de fichier — la base est en
mode WAL, voir [`docs/exploitation.md`](docs/exploitation.md).

Pour rejouer une campagne l'année suivante, mettez à jour `CAMPAGNE_DEBUT`, adaptez les
contenus, puis utilisez Administration → Technique → Réinitialiser les participations.

Ne comptez pas sur la base pour un archivage long : la purge automatique efface les
résultats nominatifs au-delà de la fin de l'année civile suivant la campagne, en n'en
conservant que la trace agrégée pendant trois ans. Un bilan à conserver plus longtemps se
sort par les exports CSV, avant l'échéance.
