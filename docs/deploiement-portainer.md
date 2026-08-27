# Déploiement sur Portainer derrière Nginx Proxy Manager

Cible : `https://cybermois.chatillon92.fr`

---

## Avant de commencer : une question à trancher

`chatillon92.fr` est un domaine public. Si `cybermois.chatillon92.fr` résout publiquement **et**
que votre Nginx Proxy Manager est joignable depuis Internet, le portail sera exposé au monde
entier — alors que la campagne est prévue pour un usage interne.

Trois configurations possibles, à choisir consciemment :

| Configuration | Conséquence |
|---|---|
| **DNS interne uniquement** (recommandé) | L'enregistrement n'existe que sur vos DNS internes. Le portail n'est joignable que depuis le réseau de la collectivité. Le certificat s'obtient par challenge DNS, ou avec votre AC interne. |
| DNS public + NPM exposé | Le portail est accessible depuis Internet. L'authentification AD protège l'accès, mais votre formulaire de connexion AD devient une surface publique. À éviter. |
| DNS public + restriction par IP dans NPM | Compromis acceptable si le télétravail passe par le VPN : n'autoriser que vos plages internes. |

Vous m'aviez indiqué que l'accès extérieur n'était pas nécessaire : la **première option** est
cohérente avec ce choix. Si vous partez sur la deuxième, dites-le-moi, j'ajouterai une
protection supplémentaire sur le formulaire de connexion.

---

## 1. Préparer les valeurs

### Le secret de session

Généré pour vous, à conserver tel quel (le changer déconnecte tous les agents en cours) :

```
SESSION_SECRET-REVOQUE-A-REGENERER
```

### Le certificat de l'autorité interne

Il est déjà sur le serveur, dans `/home/sysadmin/docker/ca_chatillon` — le même dossier
que bolt monte. La pile le monte en lecture seule sur `/certs`, et
`LDAP_CA_FILE` indique le fichier à lire :

```
LDAP_CA_FILE=/certs/ca.pem
```

Adaptez le nom au contenu réel du dossier :

```bash
ls -l /home/sysadmin/docker/ca_chatillon
```

Pour vérifier quelle autorité signe vos contrôleurs de domaine :

```bash
openssl s_client -connect 192.168.2.9:636 -showcerts
```

### Le dossier de données

Le conteneur tourne en utilisateur non privilégié, **UID 10001**. Le dossier monté doit
lui appartenir, sinon l'écriture de la base échouera au premier défi joué :

```bash
sudo mkdir -p /home/sysadmin/docker/cybermois/data
sudo chown -R 10001:10001 /home/sysadmin/docker/cybermois/data
```

C'est le seul dossier à sauvegarder. Le paramétrage du classement, lui, se rejoue
depuis le fichier embarqué dans l'image (voir `parametrage-classement.md`).

### Le réseau

`containers-lan`, le pont commun déjà utilisé par `nginx-proxy-manager`, `bolt_web` et
`oxidized`. Il est déclaré `external` dans la pile : aucun réglage à faire.

---

## 2. Construire l'image et créer la pile

Comme pour bolt, l'image se construit sur le serveur depuis un clone git.

**La première fois**, il faut créer ce clone. Le dépôt est privé : git demandera
l'identifiant GitHub et, comme mot de passe, un jeton personnel avec la portée `repo`.

```bash
mkdir -p /home/sysadmin/docker/cybermois
cd /home/sysadmin/docker/cybermois
git clone https://github.com/cparfait/cybermois.git app
chown -R sysadmin:sysadmin /home/sysadmin/docker/cybermois/app
```

Puis, à chaque fois :

```bash
cd /home/sysadmin/docker/cybermois/app && git pull
docker build -t cybermois:local .
```

Puis **Stacks → Add stack → Web editor**, en collant le contenu de
`docker-compose.portainer.yml`.

Mise à jour ultérieure : `git pull` + `docker build` avec les commandes ci-dessus, puis
**Update the stack** dans Portainer.

<details>
<summary>Variante : déploiement par dépôt Git</summary>

Portainer sait aussi construire lui-même depuis le dépôt. Remplacez alors
`image: cybermois:local` par un bloc `build: { context: ., dockerfile: Dockerfile }`,
et renseignez :

| Champ | Valeur |
|---|---|
| Repository URL | `https://github.com/cparfait/cybermois` |
| Repository reference | `refs/heads/main` |
| Compose path | `docker-compose.portainer.yml` |
| Authentication | activée — le dépôt est privé |

Avec *Automatic updates*, Portainer reprend les évolutions du dépôt tout seul.
</details>


### Variables d'environnement

**Une seule est obligatoire.**

| Nom | Valeur | Remarque |
|---|---|---|
| `SESSION_SECRET` | la sortie de `openssl rand -base64 48` | À générer une fois et à ne plus changer |

Tout le reste se règle dans l'application, à **Administration → Configuration**, et vit
en base : adresse de l'annuaire, compte de service et son mot de passe, base de
recherche, groupe d'administration, messagerie, dates de campagne, planification des
relances.

Deux raisons à ce choix, et aucune n'est cosmétique.

**Les secrets.** Le mot de passe du compte de service et celui du relais SMTP sont
chiffrés en AES-256-GCM avec une clé dérivée de `SESSION_SECRET`, et ne sont jamais
renvoyés au navigateur. Dans une pile Portainer, ils seraient en clair, visibles de
quiconque a accès à l'interface.

**La réutilisation.** Les dates de campagne changent chaque année. Les avoir dans la
pile obligerait à redéployer pour rejouer l'opération en 2027.

Trois variables restent malgré tout dans la pile, parce qu'elles décrivent le
déploiement et non la campagne :

| Nom | Défaut | Pourquoi ici |
|---|---|---|
| `PUBLIC_URL` | `https://cybermois.chatillon92.fr` | Conditionne le drapeau `secure` du cookie dès le premier démarrage. Modifiable aussi dans l'application. |
| `ADMIN_LOCAL_LOGIN` | `admin` | Seule porte d'entrée avant que l'annuaire ne soit réglé |
| `LDAP_CA_FILE` | `/certs/ca.pem` | Dépend du montage de volume, pas de la configuration |

### Au premier démarrage

L'application démarre **sans annuaire configuré** — c'est le cas prévu. Les journaux
indiquent :

```
Annuaire non configure : connectez-vous avec le compte local, puis Administration > Configuration.
Configuration incomplete (DN du compte de service, mot de passe du compte de service,
base de recherche, au moins un administrateur).
```

Ce n'est pas une erreur : le conteneur passe *healthy*, `/sante` répond. Le mot de passe
du compte local est affiché **une seule fois** juste au-dessus dans les journaux —
notez-le, il est haché ensuite.

Connectez-vous avec ce compte, puis renseignez l'annuaire depuis la page de
configuration. Un bouton y teste la connexion avant d'enregistrer.

Tant que l'URL de l'annuaire n'est pas en `ldaps://`, l'authentification des agents est
**refusée** en production : les mots de passe circuleraient en clair. Le compte local,
lui, continue de fonctionner — c'est ce qui vous permet de corriger.

---


## 3. Configurer Nginx Proxy Manager

**Hosts → Proxy Hosts → Add Proxy Host**

Onglet **Details** :

| Champ | Valeur |
|---|---|
| Domain Names | `cybermois.chatillon92.fr` |
| Scheme | `http` |
| Forward Hostname / IP | `cybermois` *(le nom du conteneur)* |
| Forward Port | `3000` |
| Cache Assets | désactivé |
| Block Common Exploits | activé |
| Websockets Support | désactivé — l'application n'en utilise pas |

Onglet **SSL** : sélectionnez votre certificat, activez **Force SSL** et **HTTP/2 Support**.
Laissez HSTS désactivé tant que vous testez.

Onglet **Advanced**, collez ceci :

```
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
client_max_body_size 8m;
proxy_read_timeout 120s;
```

Ces en-têtes ne sont pas cosmétiques :

- sans `X-Forwarded-For`, le journal de sécurité enregistrera l'adresse du proxy pour tous
  les agents, ce qui le rend inexploitable en cas d'incident ;
- sans `X-Forwarded-Proto`, l'application ne saura pas qu'elle est servie en HTTPS ;
- `client_max_body_size 8m` est nécessaire pour l'import de l'effectif complet, un export
  de 500 agents pesant quelques centaines de kilo-octets.

---

## 4. Vérifier

Dans l'ordre, chaque étape validant la précédente :

```bash
curl -sk https://cybermois.chatillon92.fr/sante
```

Doit répondre `{"ok":true,...}`. Si vous obtenez une erreur 502, NPM ne joint pas le
conteneur : vérifiez que les deux sont bien sur le même réseau Docker.

Connectez-vous ensuite avec le **compte administrateur local** — ses identifiants sont
affichés une seule fois dans les journaux du conteneur au premier démarrage — puis ouvrez
**Administration → Configuration**. C'est là que tout se règle : saisissez les valeurs,
cliquez sur **Tester la connexion**, corrigez ce que le test signale, puis enregistrez.

Rien n'oblige à passer par les variables de la pile : celles-ci ne servent qu'à démarrer
avec des valeurs de départ. Tout réglage saisi dans l'interface les remplace, et s'applique
sans redémarrer le conteneur.

Enfin, **Administration → Agents → Importer un export d'annuaire** pour charger l'effectif.

---

## 5. Recette avant ouverture

1. Faire tester le parcours par cinq ou six agents de services différents.
2. Vérifier que leur service est correctement déduit — c'est le point qui se règle mal
   après coup, une fois le classement lancé.
3. Simuler un envoi de relance (bouton « Simuler ») pour compter les destinataires.
4. Passer `MAIL_ENVOI_ACTIF` à `true`, puis envoyer un vrai mail de résultats à vous-même
   en mettant temporairement votre adresse dans `MAIL_GROUPE_DIFFUSION`.
5. **Administration → Technique → Réinitialiser les participations** pour effacer les
   résultats de test. Les comptes et les défis sont conservés.
6. Remettre le vrai groupe de distribution.

---

## Mises à jour en direct

Avec **Automatic updates** activé, il suffit que je pousse sur `main` : Portainer
reconstruit et redéploie tout seul. Sinon, Portainer → Stacks → `cybermois` →
**Pull and redeploy**.

Le dossier `/home/sysadmin/docker/cybermois/data` n'est jamais touché par un redéploiement : les résultats,
les comptes et les contenus modifiés depuis le back-office survivent aux mises à jour.

**Attention à une exception.** Les contenus des défis modifiés via le back-office vivent en
base, mais un « Recharger les contenus » depuis l'onglet Technique les réécrit à partir des
fichiers du dépôt. Si vous corrigez une question en direct dans l'interface, dites-le-moi
pour que je reporte la correction dans les fichiers — sinon un rechargement l'effacerait.

---

## Sauvegarde

La base est un fichier unique, dans `/home/sysadmin/docker/cybermois/data`. Elle suit
donc la sauvegarde du reste de `/home/sysadmin/docker`, sans traitement particulier.

Pour une copie ponctuelle avant une opération sensible :

```bash
sudo tar czf /home/sysadmin/sauvegardes/cybermois-$(date +%F).tar.gz   -C /home/sysadmin/docker/cybermois/data .
```

Restauration, conteneur arrêté :

```bash
docker stop cybermois
sudo tar xzf /home/sysadmin/sauvegardes/cybermois-2026-10-15.tar.gz   -C /home/sysadmin/docker/cybermois/data
sudo chown -R 10001:10001 /home/sysadmin/docker/cybermois/data
docker start cybermois
```

Le `chown` après restauration n'est pas facultatif : `tar` restitue les propriétaires
de l'archive, et le conteneur écrit en UID 10001.

C'est la seule donnée à sauvegarder. Le paramétrage du classement — référentiel,
regroupements, exclusions — se rejoue depuis `parametrage/chatillon.json`, embarqué
dans l'image (voir `parametrage-classement.md`).
