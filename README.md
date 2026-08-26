# Cybermois — Ville de Châtillon

Portail interne de sensibilisation à la cybersécurité, sous forme de campagne gamifiée de
quatre semaines. Les agents s'authentifient avec leur compte Active Directory (LDAPS),
relèvent un défi par semaine, et font gagner des points à leur service.

- **Authentification LDAPS** via un compte de service, sans jamais stocker de mot de passe
- **Rattachement au service déduit de l'annuaire** (OU du DN) : aucune liste à maintenir
- **Double classement** : par service (moyenne par agent + taux de participation) et individuel nominatif
- **Questions à choix multiples** avec validation explicite et notation partielle
- **Badges, podium, attestation imprimable**
- **Relances et résultats hebdomadaires** envoyés automatiquement par SMTP
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
NODE_ENV=development
LDAP_URL=demo
ADMIN_LOGINS=votre.login
MAIL_ENVOI_ACTIF=false
CAMPAGNE_DEBUT=2026-10-05
```

Puis :

```bash
npm start
```

Le portail est disponible sur http://localhost:3000. Quinze comptes fictifs répartis sur
six services sont fournis (`s.leroy`, `p.martin`, `f.lambert`…), tous avec le mot de passe
`demo2026`. Le compte administrateur de la démonstration est `c.parfait`.

Le mode démonstration **refuse de démarrer si `NODE_ENV=production`** : il est impossible
de le mettre en service par inadvertance.

Pour remplir la base de résultats fictifs et voir les classements vivre :

```bash
node tests/simulation.mjs
```

---

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

### 2. Certificat LDAPS

Déposez le certificat de l'autorité de certification interne dans `certs/ca-interne.crt`,
et laissez `LDAP_TLS_REJECT_UNAUTHORIZED=true`. Ne passez cette valeur à `false` qu'en
recette, jamais en production : la validation du certificat est ce qui garantit que vous
parlez bien à votre contrôleur de domaine.

### 3. Configuration

Reportez-vous à `.env.example`, qui documente chaque variable. Les points d'attention :

| Variable | Remarque |
|---|---|
| `SESSION_SECRET` | 32 caractères aléatoires minimum, propre à l'installation |
| `PUBLIC_URL` | URL réellement vue par les agents — elle alimente les liens des mails |
| `ADMIN_LOGINS` | Logins AD autorisés au back-office, séparés par des virgules |
| `CAMPAGNE_DEBUT` | Lundi d'ouverture de la semaine 1 ; les suivantes s'ouvrent à +7 jours |
| `MAIL_ENVOI_ACTIF` | Laisser à `false` tant que la recette n'est pas terminée |

### 4. Déploiement

```bash
docker compose up -d --build
docker compose logs -f cybermois
```

Le conteneur écoute sur `127.0.0.1:3000` uniquement. Publiez-le via Nginx Proxy Manager
en HTTPS.

> **Important — configuration du reverse proxy.** Nginx Proxy Manager doit transmettre
> l'adresse réelle du client :
>
> ```
> proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
> proxy_set_header X-Forwarded-Proto $scheme;
> proxy_set_header X-Real-IP $remote_addr;
> ```
>
> Sans cela, la journalisation enregistrera l'IP du proxy pour tous les agents.
> La limitation des tentatives de connexion, elle, est indexée sur le **compte** et non
> sur l'IP : elle reste correcte même derrière un NAT, et 500 agents peuvent se connecter
> le même matin sans se bloquer mutuellement.

### 5. Vérification

Connectez-vous, ouvrez **Administration → Technique** : le diagnostic teste en direct
la liaison LDAPS et le relais SMTP, et affiche la configuration effectivement chargée.

---

## Exploitation pendant la campagne

### Rythme hebdomadaire

| Jour | Message | Émetteur |
|---|---|---|
| Lundi | Lancement du défi de la semaine | **La DPO**, depuis sa messagerie |
| Mercredi 9h | Relance des agents n'ayant pas joué | Automatique |
| Vendredi 16h | Résultats et classement | Automatique, au groupe de distribution |

Le mail du lundi est volontairement laissé à la main de la DPO : il porte sa signature et
son autorité, ce qui pèse nettement plus qu'un message automatique. Le back-office
(**Administration → Mails**) en génère le texte prêt à copier-coller, en version texte
ou HTML, avec l'objet suggéré.

Les horaires d'envoi automatique se règlent par `CRON_RELANCE` et `CRON_RESULTATS`.
Chaque envoi peut aussi être déclenché manuellement, et **simulé** au préalable pour
compter les destinataires sans rien envoyer.

### Modifier les questions

Deux méthodes, au choix :

- **Par le back-office** — Administration → Défis → Modifier. Édition complète des énoncés,
  contextes, réponses, bonnes réponses, points et explications. C'est la méthode à privilégier
  pendant la campagne.
- **Par les fichiers** — `content/semaine-N.json`, puis Administration → Technique →
  Recharger les contenus. Pratique pour préparer une édition suivante ou versionner les
  contenus dans Git.

Un défi déjà joué n'est jamais écrasé par un rechargement, sauf en forçant explicitement.

### Suivre la participation

**Administration → Suivi** affiche le taux de participation global, le détail par semaine,
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

**Pas de score négatif.** Une mauvaise réponse cochée annule une bonne réponse au sein de
la même question, mais le score d'une question ne descend jamais sous zéro. L'objectif est
pédagogique : on ne punit pas l'erreur, on l'explique.

**Un seul essai comptabilisé.** Rejouer un défi est possible, mais bascule en mode
entraînement et ne modifie pas le classement. Les défis des semaines précédentes restent
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
- Les journaux applicatifs masquent explicitement les mots de passe et les cookies.
- La page `/mentions` porte la notice d'information complète, à faire valider par la DPO
  avant l'ouverture.

**Point à arbitrer avec la DPO avant la mise en service.** Le classement individuel est
nominatif. C'est un choix assumé, mais dans le secteur public un classement nominatif de
performance peut être perçu comme une évaluation individuelle. Deux atténuations sont
prévues et documentées dans les mentions légales : le classement n'a aucune incidence
professionnelle, et un agent peut demander à ne pas y figurer tout en continuant à
alimenter le score de son service. Cette exclusion se fait aujourd'hui par suppression
manuelle en base ; si la DPO le demande, elle peut être exposée comme une case à cocher
dans le profil de l'agent.

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
  routes/
    auth.js              Connexion, déconnexion
    jeu.js               Défis, validation, classements, profil
    admin.js             Back-office, exports, mails
content/semaine-*.json   Contenus pédagogiques, éditables
public/                  Interface (HTML, CSS, modules ES — aucun outil de build)
tests/                   Tests de dates, d'extraction de DN, simulation de campagne
```

**Choix techniques.** Node.js 24 avec le module natif `node:sqlite` : pas de dépendance
native à compiler, donc pas de surprise à la reconstruction de l'image. Front en modules ES
sans build : le code livré est le code exécuté, ce qui facilite l'audit et la reprise par
un tiers.

## Tests

```bash
node tests/dates.test.mjs      # planification des semaines, changement d'heure
node tests/dn.test.mjs         # extraction du service depuis le DN
node tests/simulation.mjs      # campagne complète (serveur démarré requis)
```

## Après la campagne

Conservez la base `data/cybermois.db` : elle porte la preuve de participation.
Pour rejouer une campagne l'année suivante, mettez à jour `CAMPAGNE_DEBUT`, adaptez les
contenus, puis utilisez Administration → Technique → Réinitialiser les participations.
