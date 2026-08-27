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
LDAP_CA_FILE=/certs/ca_chatillon.crt
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

Comme pour bolt, l'image se construit sur le serveur depuis le clone git :

```bash
cd /home/sysadmin/docker/cybermois/cybermois && git pull
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

À saisir dans la section **Environment variables** de la pile :

| Nom | Valeur | Remarque |
|---|---|---|
| `SESSION_SECRET` | *(la chaîne ci-dessus)* | |
| `LDAP_URL` | `ldaps://192.168.2.9:636` | Votre contrôleur de domaine |
| `LDAP_BIND_DN` | `ad.cybermois@chatillon.lan` | Le compte de service |
| `LDAP_BIND_PASSWORD` | *(mot de passe du compte de service)* | |
| `LDAP_BASE_DN` | `OU=Utilisateurs,OU=CHATILLON,DC=chatillon,DC=lan` | Racine de recherche. Trop large, la synchronisation ramène les comptes de service ; trop étroite, elle déclare des agents « absents de l'annuaire ». |
| `LDAP_CA_FILE` | `/certs/<nom du fichier>` | L'AC est montée depuis `/home/sysadmin/docker/ca_chatillon`, comme pour bolt |
| `LDAP_ADMIN_GROUP` | `CN=GRP_APPLI_CYBERMOIS_ADMIN,OU=GRP_APPLICATIONS,OU=zzzGroupes,OU=Utilisateurs,OU=CHATILLON,DC=chatillon,DC=lan` | Accès au back-office |
| `SERVICE_SOURCE` | `attr` | Le service se lit dans un attribut, pas dans l'arborescence |
| `SERVICE_ATTRIBUTE` | `department` | Les OU décrivent les sites (TECHNOSUD, MAIRIE, CTM), pas les services |
| `ADMIN_LOGINS` | `c.parfait` | Séparés par des virgules |
| `SMTP_HOST` | `chatillon92-fr.mail.protection.outlook.com` | Direct Send, sans authentification |
| `MAIL_GROUPE_DIFFUSION` | *(groupe de distribution)* | |
| `MAIL_ENVOI_ACTIF` | `false` | **À laisser à false jusqu'à la fin de la recette** |
| `CAMPAGNE_DEBUT` | `2026-10-05` | |

`PUBLIC_URL` est déjà fixé à `https://cybermois.chatillon92.fr` dans la pile : il alimente
les liens des mails et conditionne le drapeau `secure` du cookie de session.

Puis **Deploy the stack**. La première construction prend une à deux minutes.

### Ce que fait le conteneur au premier démarrage

1. Il crée le compte administrateur local et **affiche son mot de passe une seule
   fois** dans les journaux — lisibles dans Portainer, *Containers > cybermois > Logs*.
   Notez-le immédiatement : il est haché ensuite, et plus personne ne peut le relire.
   Pour le redéfinir : `npm run admin -- definir admin "…"` dans une console du conteneur.
2. Il charge les modules programmés dans les défis.
3. Il refuse de démarrer si `LDAP_URL=demo` avec `NODE_ENV=production` : l'annuaire
   simulé n'a rien à faire en service.

Le point de contrôle `/sante` répond `{"ok":true,…}` et sert au *healthcheck* Docker :
la pile passe en **healthy** au bout d'une vingtaine de secondes.

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
