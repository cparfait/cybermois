# Déploiement sur Portainer derrière Nginx Proxy Manager

Cible : `https://cybermois.chatillon92.fr`

---

## Avant de commencer : une question à trancher

`chatillon92.fr` est un domaine public. Si `cybermois.chatillon92.fr` résout publiquement **et**
que le Nginx Proxy Manager est joignable depuis Internet, le portail sera exposé au monde
entier — alors que la campagne est prévue pour un usage interne.

Trois configurations possibles, à choisir consciemment :

| Configuration | Conséquence |
|---|---|
| **DNS interne uniquement** (recommandé) | L'enregistrement n'existe que sur les DNS internes. Le portail n'est joignable que depuis le réseau de la collectivité. Le certificat s'obtient par challenge DNS, ou avec l'AC interne. |
| DNS public + NPM exposé | Le portail est accessible depuis Internet. L'authentification AD protège l'accès, mais le formulaire de connexion AD devient une surface publique. À éviter. |
| DNS public + restriction par IP dans NPM | Compromis acceptable si le télétravail passe par le VPN : n'autoriser que les plages internes. |

La **première option** est celle retenue pour ce déploiement, l'accès extérieur n'étant pas
nécessaire. Retenir la deuxième supposerait d'ajouter une protection supplémentaire devant le
formulaire de connexion (restriction par IP, authentification NPM, ou portail VPN) : ce n'est
pas fourni par l'application.

---

## 1. Préparer les valeurs

> **Les valeurs réelles de la collectivité ne se conservent pas dans ce dépôt.** Adresse du
> contrôleur de domaine, compte de service, secret de session, chemins de l'hôte : ils vivent
> dans le gestionnaire de secrets de la DSI et dans la pile Portainer du serveur. Les exemples
> de cette documentation sont volontairement neutres (`dc01.exemple.lan`, `/srv/docker/…`).

### Le secret de session

À générer **une fois**, sur le serveur, et à conserver dans le gestionnaire de secrets de la
DSI — jamais dans le dépôt :

```bash
openssl rand -base64 48
```

ou, si `openssl` n'est pas disponible :

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

> **Ce secret ne signe pas que les cookies.** C'est de lui que dérive la clé AES-256-GCM qui
> chiffre, en base, le mot de passe du compte de service Active Directory et celui du relais
> SMTP. Trois conséquences :
>
> - **il ne doit jamais être commité**, ni dans le dépôt, ni dans un ticket, ni dans un
>   compte rendu — quiconque l'obtient avec une copie de la base obtient le compte de service ;
> - **le changer rend ces mots de passe illisibles** : il faut les ressaisir dans
>   Administration → Configuration après le redémarrage, sinon l'annuaire et les envois
>   tombent ;
> - **le changer déconnecte tous les agents en cours de partie.**
>
> En `NODE_ENV=production`, l'application **refuse de démarrer** si ce secret est absent, s'il
> vaut encore la valeur de développement par défaut, ou s'il fait moins de 32 caractères. Le
> conteneur s'arrête avec un message explicite plutôt que de tourner avec une clé connue.

### Le certificat de l'autorité interne

Il est déjà sur le serveur, dans `/srv/docker/ca-interne` — le même dossier
que bolt monte. La pile le monte en lecture seule sur `/certs`, et
`LDAP_CA_FILE` indique le fichier à lire :

```
LDAP_CA_FILE=/certs/ca.pem
```

Adaptez le nom au contenu réel du dossier :

```bash
ls -l /srv/docker/ca-interne
```

Pour vérifier quelle autorité signe vos contrôleurs de domaine :

```bash
openssl s_client -connect dc01.exemple.lan:636 -showcerts
```

### Le dossier de données

Le conteneur tourne en utilisateur non privilégié, **UID 10001**. Le dossier monté doit
lui appartenir, sinon l'écriture de la base échouera au premier défi joué :

```bash
sudo mkdir -p /srv/docker/cybermois/data
sudo chown -R 10001:10001 /srv/docker/cybermois/data
```

C'est le seul dossier à sauvegarder. Le paramétrage du classement, lui, se rejoue
depuis le fichier embarqué dans l’image (voir [`parametrage-classement.md`](parametrage-classement.md)).

### Le réseau

`containers-lan`, le pont commun déjà utilisé par `nginx-proxy-manager`, `bolt_web` et
`oxidized`. Il est déclaré `external` dans la pile : aucun réglage à faire.

---

## 2. Construire l'image et créer la pile

Comme pour bolt, l'image se construit sur le serveur depuis un clone git.

**La première fois**, il faut créer ce clone. Le dépôt est privé : git demandera
l'identifiant GitHub et, comme mot de passe, un jeton personnel avec la portée `repo`.

```bash
mkdir -p /srv/docker/cybermois
cd /srv/docker/cybermois
git clone https://github.com/cparfait/cybermois.git app
chown -R "$USER:$USER" /srv/docker/cybermois/app
```

Puis, à chaque fois :

```bash
cd /srv/docker/cybermois/app && git pull
docker build -t cybermois:local .
```

Puis **Stacks → Add stack → Web editor**, en collant le contenu de
`docker-compose.portainer.yml`.

Mise à jour ultérieure : `git pull` + `docker build` avec les commandes ci-dessus, puis
**Update the stack** dans Portainer — **sans cocher « Re-pull image and redeploy »**.
L'image est construite ici, elle n'existe dans aucun registre : Portainer irait la
chercher sur Docker Hub et échouerait sur un `pull access denied` déroutant. La pile
porte `pull_policy: never` pour l'en empêcher, mais l'option reste proposée.

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

**Une seule est obligatoire — et son absence empêche le démarrage.**

| Nom | Valeur | Remarque |
|---|---|---|
| `SESSION_SECRET` | la sortie de `openssl rand -base64 48` | À générer une fois et à ne plus changer. En production, l'application **s'arrête au démarrage** s'il manque, s'il vaut la valeur de développement par défaut, ou s'il fait moins de 32 caractères |

Si la pile est déployée sans cette variable, le conteneur ne démarre pas : il boucle en
redémarrage, avec dans ses journaux le motif exact du refus. C'est délibéré — un portail
dont les cookies de session et les mots de passe stockés seraient chiffrés avec une clé
publiquement connue vaut moins que pas de portail du tout.

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

Quelques variables restent malgré tout dans la pile, parce qu'elles décrivent le
déploiement et non la campagne :

| Nom | Défaut | Pourquoi ici |
|---|---|---|
| `PUBLIC_URL` | `https://cybermois.chatillon92.fr` | Conditionne le drapeau `secure` du cookie dès le premier démarrage, et l'émission de `Strict-Transport-Security` quand l'URL est en `https`. Modifiable aussi dans l'application. |
| `ADMIN_LOCAL_LOGIN` | `admin` | Seule porte d'entrée avant que l'annuaire ne soit réglé |
| `LDAP_CA_FILE` | `/certs/ca.pem` | Dépend du montage de volume, pas de la configuration. Attention : avec `docker-compose.yml`, le montage est différent et la valeur devient `/app/certs/ca-interne.crt`. |
| `PROXY_DE_CONFIANCE` | *(vide)* | Adresse du reverse proxy. Voir ci-dessous. |
| `RETENTION_JOURNAL_JOURS`, `RETENTION_RESULTATS_JOURS`, `RETENTION_PREUVES_JOURS` | `180`, `456`, `1095` | Durées de conservation annoncées dans les mentions légales. À ne changer qu'avec l'accord de la DPO. |

#### `PROXY_DE_CONFIANCE`

Liste d'adresses IP ou de plages CIDR, séparées par des virgules, correspondant au reverse
proxy placé devant l'application.

**Laissée vide, l'application ne fait plus confiance aux en-têtes `X-Forwarded-For` et
`X-Forwarded-Proto`, d'où qu'ils viennent.** Le journal enregistre alors l'adresse du proxy
pour tous les agents, ce qui le rend peu exploitable en cas d'incident — mais au moins
personne ne peut s'inventer une adresse en forgeant un en-tête.

Renseignez l'adresse du conteneur Nginx Proxy Manager, ou la plage du réseau
`containers-lan`, pour retrouver l'adresse réelle des agents :

```yaml
PROXY_DE_CONFIANCE: 172.18.0.0/16
```

Pour connaître la plage réelle du réseau :

```bash
docker network inspect containers-lan --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

N'y déclarez que des adresses réellement maîtrisées : une plage trop large redonne à
n'importe quel client la possibilité de choisir l'adresse qui figurera au journal.

### Au premier démarrage

L'application démarre **sans annuaire configuré** — c'est le cas prévu. Les journaux
indiquent :

```
Annuaire non configure : connectez-vous avec le compte local, puis Administration > Configuration.
Configuration incomplete (DN du compte de service, mot de passe du compte de service,
base de recherche, au moins un administrateur).
```

Ce n'est pas une erreur : le conteneur passe *healthy*, `/sante` répond — avec
`{"ok":true,"version":"…"}` et rien d'autre, puisqu'il est interrogeable sans
authentification. Le mot de passe du compte local est affiché **une seule fois** juste
au-dessus dans les journaux — notez-le, il est haché ensuite.

Si au contraire le conteneur redémarre en boucle sans jamais afficher ces lignes, lisez
le tout début des journaux : c'est très probablement le contrôle de `SESSION_SECRET` qui
a refusé la valeur fournie.

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

> **Les envoyer ne suffit pas : il faut aussi que l'application ait le droit de les
> croire.** Sans `PROXY_DE_CONFIANCE` renseignée dans la pile, ces en-têtes sont ignorés et
> le journal portera l'adresse du proxy quoi qu'il arrive. Voir la section
> [`PROXY_DE_CONFIANCE`](#proxy_de_confiance) plus haut.

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

## Mises à jour

Avec **Automatic updates** activé, toute poussée sur `main` déclenche la reconstruction et
le redéploiement par Portainer. Sinon : Portainer → Stacks → `cybermois` →
**Pull and redeploy**.

Le dossier `/srv/docker/cybermois/data` n'est jamais touché par un redéploiement : les résultats,
les comptes et les contenus modifiés depuis le back-office survivent aux mises à jour.

**Attention à une exception.** Les contenus des défis modifiés via le back-office vivent en
base, mais un « Recharger les contenus » depuis l'onglet Technique les réécrit à partir des
fichiers du dépôt. Toute question corrigée directement dans l'interface doit donc être
reportée dans `content/modules/<code>.json` et commitée, faute de quoi le prochain
rechargement l'effacera.

---

## Sauvegarde

La base est un fichier unique, dans `/srv/docker/cybermois/data`.

> **Ne l'archivez pas à chaud avec `tar` ou `cp`.** SQLite tourne en mode WAL : à tout
> instant, une partie des écritures validées n'est pas encore dans `cybermois.db` mais dans
> `cybermois.db-wal`. Une archive prise pendant que le service tourne peut donc contenir un
> fichier `.db` en retard sur la réalité, et une archive qui prend les trois fichiers au fil
> de la copie peut les prendre à des instants différents — donc incohérents entre eux.
> Ces sauvegardes-là ne se voient défaillantes qu'au moment où on en a besoin.

La méthode à retenir est `VACUUM INTO`, qui produit **en une opération atomique** une copie
complète et cohérente de la base, sans arrêter le service ni bloquer les agents :

```bash
sudo mkdir -p /srv/docker/cybermois/data/sauvegardes
sudo chown 10001:10001 /srv/docker/cybermois/data/sauvegardes

docker exec cybermois node -e "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync('/app/data/cybermois.db'); d.exec(\`VACUUM INTO '/app/data/sauvegardes/cybermois-\${new Date().toISOString().slice(0,10)}.db'\`); d.close();"
```

Le fichier obtenu est une base SQLite ordinaire, défragmentée, sans `-wal` ni `-shm` à
transporter. Trois points de comportement à connaître :

- la commande **échoue si le fichier de destination existe déjà** (`output file already
  exists`) : deux sauvegardes le même jour demandent un horodatage plus fin, par exemple
  `.slice(0,19).replace(/[:T]/g,'-')` ;
- elle **échoue si le dossier de destination n'existe pas** — d'où le `mkdir` ci-dessus ;
- elle affiche un avertissement `ExperimentalWarning: SQLite is an experimental feature`
  sur la sortie d'erreur. C'est normal et sans conséquence.

Vérifier une sauvegarde, ce qui vaut mieux que de le découvrir un jour d'incident :

```bash
docker exec cybermois node -e "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync('/app/data/sauvegardes/cybermois-2026-10-15.db',{readOnly:true}); console.log(d.prepare('PRAGMA integrity_check').get()); d.close();"
```

### Rotation

Une sauvegarde quotidienne pendant la campagne, conservée un mois, suffit largement — la
base pèse quelques centaines de kilo-octets. En cron sur l'hôte :

```cron
# Sauvegarde quotidienne a 2h, purge des copies de plus de 30 jours
0 2 * * * docker exec cybermois node -e "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync('/app/data/cybermois.db'); d.exec(\`VACUUM INTO '/app/data/sauvegardes/cybermois-\${new Date().toISOString().slice(0,10)}.db'\`); d.close();" 2>/dev/null
30 2 * * * find /srv/docker/cybermois/data/sauvegardes -name 'cybermois-*.db' -mtime +30 -delete
```

Le dossier `sauvegardes/` étant sous `/srv/docker`, il est emporté par la sauvegarde
générale du serveur : c'est elle qui assure la copie hors machine.

### Restauration

Conteneur arrêté, pour ne pas écrire par-dessus une base ouverte :

```bash
docker stop cybermois
cd /srv/docker/cybermois/data
sudo cp cybermois.db cybermois.db.avant-restauration   # filet de sécurité
sudo cp sauvegardes/cybermois-2026-10-15.db cybermois.db
sudo rm -f cybermois.db-wal cybermois.db-shm
sudo chown 10001:10001 cybermois.db
docker start cybermois
```

La suppression de `-wal` et `-shm` n'est pas facultative : laissés en place, ils
correspondraient à l'ancienne base et seraient rejoués par-dessus la copie restaurée.
Le `chown` non plus : le conteneur écrit en UID 10001.

C'est la seule donnée à sauvegarder. Le paramétrage du classement — référentiel,
regroupements, exclusions — se rejoue depuis `parametrage/chatillon.json`, embarqué
dans l'image (voir [`parametrage-classement.md`](parametrage-classement.md)).
