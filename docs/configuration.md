# Configurer l'application depuis le back-office

Tous les réglages — Active Directory, messagerie, planification, dates de campagne —
se saisissent dans **Administration → Configuration**. Ils sont enregistrés en base,
appliqués immédiatement, et **prennent le pas sur les variables d'environnement**, qui
ne servent plus que d'amorçage.

Concrètement : changer l'adresse du contrôleur de domaine ne demande plus de modifier
la pile Portainer ni de redémarrer le conteneur.

---

## Entrer la première fois : le compte administrateur local

Il y a un problème d'amorçage évident : la configuration LDAP se saisit dans le
back-office, mais le back-office exige de s'authentifier… par le LDAP.

D'où le **compte administrateur local**, indépendant de l'annuaire. Au premier démarrage,
l'application en crée un et affiche ses identifiants **une seule fois** dans les journaux
du conteneur :

```
================= COMPTE ADMINISTRATEUR LOCAL CREE =================
  Identifiant  : admin
  Mot de passe : xxxxxxxxxxxxxxxx
===================================================================
```

*(le mot de passe réel est une chaîne aléatoire de seize caractères ; il est masqué ici,
et ne doit figurer ni dans une documentation, ni dans un ticket, ni dans une copie
d'écran.)*

Dans Portainer : **Containers → cybermois → Logs**. Notez le mot de passe, il ne sera
plus affiché.

Vous pouvez aussi le fixer d'avance avec `ADMIN_LOCAL_LOGIN` et `ADMIN_LOCAL_MOT_DE_PASSE`
dans la pile.

Sur la page de connexion, le lien **« Connexion administrateur local »** bascule le
formulaire vers ce compte.

Ce compte n'est pas un compte d'agent : il est marqué exclu, donc il ne compte ni dans les
effectifs, ni dans les taux de participation, ni dans les classements. Changez son mot de
passe dès la première connexion, dans la section **Comptes administrateurs locaux**.

Gardez-en toujours au moins un : c'est votre seul recours si l'annuaire tombe pendant la
campagne. L'application refuse d'ailleurs de supprimer le dernier.

---

## Configurer l'Active Directory

Les valeurs par défaut reprennent celles de vos autres applications :

| Réglage | Valeur | Remarque |
|---|---|---|
| Serveur | `ldaps://dc01.exemple.lan:636` | Chiffré. `ldap://…:389` fonctionne aussi, mais fait circuler les mots de passe en clair. |
| Compte de service | `ad.cybermois@exemple.lan` | Le DN complet est également accepté. |
| Base de recherche | `DC=exemple,DC=lan` | |
| Groupe des administrateurs | `GG-Cybermois-Admins` | Nom court ou DN complet. |
| Profondeur d'OU | `1` | L'OU contenant directement l'agent. |

### Le bouton « Tester la connexion »

Il utilise **les valeurs affichées à l'écran, pas celles enregistrées**. Vous pouvez donc
vérifier une configuration avant de l'appliquer, sans risquer de vous couper l'accès.

> **Le mot de passe enregistré n'est réutilisé que si l'hôte visé est le même.** Laisser
> le champ mot de passe vide signifie « reprendre celui qui est en base » — mais
> uniquement tant que l'adresse du serveur testé est identique à celle enregistrée. Dès
> que vous changez d'hôte, il faut **ressaisir le mot de passe** pour tester.
>
> Ce n'est pas une gêne gratuite : sans cette règle, il suffisait de remplacer l'adresse
> du contrôleur de domaine par celle d'un serveur que l'on contrôle, puis de cliquer sur
> « Tester », pour que l'application aille présenter d'elle-même le mot de passe du compte
> de service à ce serveur. Le même contrôle s'applique au test SMTP.
>
> **Chaque test est journalisé avec l'hôte réellement contacté.** Un test dirigé vers un
> serveur inconnu laisse donc une trace exploitable dans Administration → Journal.

Le test se déroule en quatre temps, et chacun vous dit quoi corriger :

1. **Joignabilité** du contrôleur de domaine sur le port indiqué ;
2. **Certificat présenté** — sujet, émetteur, date d'expiration. L'émetteur est
   précisément l'autorité à fournir dans « Certificat de l'AC interne » ;
3. **Compte de service** — les erreurs Active Directory sont traduites : mot de passe
   expiré, identifiants incorrects, certificat non validable ;
4. **Lecture de l'annuaire** — nombre de comptes actifs, comptes sans adresse mail, et
   surtout **la répartition des services pour chaque profondeur d'OU**, ce qui vous permet
   de choisir la bonne valeur en connaissance de cause.

### Le bouton « Tester un agent »

Saisissez un identifiant réel : l'écran affiche son DN, son arborescence d'OU, ses
attributs, et **le service qui lui serait attribué**. C'est le moyen le plus rapide de
vérifier que le rattachement fonctionne avant d'ouvrir la campagne.

### Deux points de vigilance

**Le compte de service.** Utilisez un compte dédié, pas un compte personnel. Un compte
nominatif dont le mot de passe expire ou change fait tomber l'authentification de toute
la campagne — et le jour où son propriétaire part, le portail s'arrête. Pensez aussi à
cocher « le mot de passe n'expire jamais » sur ce compte.

**La validation du certificat.** Elle est active par défaut. Si vous obtenez
*« unable to verify the first certificate »*, la bonne réponse est de fournir l'autorité
interne, pas de désactiver la validation : sans elle, la liaison est chiffrée mais plus
authentifiée, et redevient interceptable.

---

## Configurer la messagerie

Vos autres applications utilisent le **Direct Send Microsoft 365** :

| Réglage | Valeur |
|---|---|
| Serveur | `votredomaine-fr.mail.protection.outlook.com` |
| Port | `25` |
| Connexion chiffrée d'emblée | inactif — le port 25 est élevé en TLS par STARTTLS |
| Identifiant / mot de passe | vides — Direct Send n'authentifie pas |
| Expéditeur | `Cybermois <cybermois@chatillon92.fr>` |

Le bouton **Tester** vérifie la joignabilité du relais, et envoie un vrai message si vous
indiquez une adresse. Comme pour l'annuaire, **le mot de passe SMTP enregistré n'est
réutilisé que si le serveur testé est celui qui est enregistré** ; changer d'hôte impose
de le ressaisir, et l'hôte visé est inscrit au journal.

**Le Direct Send a deux limites, levées dans notre cas.** Il ne délivre qu'aux destinataires
du locataire : sans objet ici, la campagne n'écrit qu'à des adresses `@chatillon92.fr`.
Et il exige que l'adresse IP émettrice figure dans l'enregistrement SPF du domaine :
c'est déjà le cas, l'infrastructure émet depuis une adresse connue.

Faites malgré tout un envoi réel avant l'ouverture, en vous mettant temporairement comme
groupe de diffusion : c'est la seule façon de vérifier le rendu du message dans Outlook, et
de s'assurer qu'il n'atterrit pas en indésirables.

---

## Les réglages de planification

Les expressions de planification suivent la syntaxe cron habituelle :

| Réglage | Valeur par défaut | Signification |
|---|---|---|
| Relance des non-joueurs | `0 9 * * 3` | mercredi à 9h |
| Envoi des résultats | `0 16 * * 5` | vendredi à 16h |

Les modifier **replanifie les tâches immédiatement**, sans redémarrage. Une expression
invalide est refusée, et signalée dans les journaux plutôt que d'arrêter les envois
silencieusement.

Laissez **« Envois automatiques actifs »** inactif jusqu'à la fin de la recette : rien ne
part tant qu'il l'est.

---

## Comment sont protégés les mots de passe

Les mots de passe saisis sur cette page — compte de service AD, relais SMTP — sont
**chiffrés en AES-256-GCM avant d'être stockés**. Une sauvegarde de la base, ou son
exfiltration, ne divulgue donc pas le compte de service Active Directory.

Ils ne sont **jamais renvoyés au navigateur** : le champ apparaît vide, avec la mention
« renseigné ». Un champ laissé vide signifie « ne pas changer ».

La clé de chiffrement dérive de `SESSION_SECRET`. Conséquence à connaître : **changer
`SESSION_SECRET` rend ces mots de passe illisibles**, il faudra les ressaisir. Ce n'est pas
un défaut mais le principe même — la clé reste hors de la base, donc la base seule ne suffit
pas à déchiffrer.

Corollaire moins agréable : une fuite du secret **et** d'une copie de la base redonne le
compte de service Active Directory en clair. La marche à suivre dans ce cas est décrite
dans [`exploitation.md`](exploitation.md), section
« Compromission d'une clé ou d'un mot de passe ».

En `NODE_ENV=production`, l'application **refuse de démarrer** si `SESSION_SECRET` est
absent, s'il vaut encore la valeur de développement par défaut, ou s'il fait moins de
32 caractères.

---

## Les durées de conservation

Elles ne se règlent pas ici mais dans l'environnement, et une **purge automatique** les
applique — ce sont les durées annoncées dans les mentions légales :

| Donnée | Défaut | Variable |
|---|---|---|
| Journal applicatif | 180 jours (6 mois) | `RETENTION_JOURNAL_JOURS` |
| Participations et réponses nominatives | 456 jours, soit la fin de l'année civile suivant la campagne | `RETENTION_RESULTATS_JOURS` |
| Preuves de participation agrégées | 1095 jours (3 ans) | `RETENTION_PREUVES_JOURS` |

Avant d'effacer les résultats détaillés, la purge en conserve la trace agrégée — combien
de défis chaque agent a suivis — qui est ce qui sert de preuve en audit SSI.

Ces valeurs sont **engagées vis-à-vis des agents** par la page `/mentions`. Les modifier
suppose de mettre à jour la notice d'information et d'en informer la DPO. Voir
[`exploitation.md`](exploitation.md) pour le détail du fonctionnement de la purge.

---

## Ce qui n'est pas modifiable ici

Ces réglages sont lus avant l'ouverture de la base, ou décrivent le déploiement plutôt que
la campagne. Ils viennent de l'environnement — pile Portainer ou `.env` — et exigent un
redémarrage :

| Variable | Rôle |
|---|---|
| `SESSION_SECRET` | Chiffrement des sessions et des mots de passe stockés |
| `PORT`, `NODE_ENV` | Serveur |
| `DB_FILE` | Emplacement de la base |
| `ENV_FILE` | Emplacement du fichier `.env` à charger |
| `ADMIN_LOCAL_LOGIN`, `ADMIN_LOCAL_MOT_DE_PASSE` | Amorçage du compte local seulement |
| `LDAP_CA_FILE` | Dépend du montage de volume, pas de la configuration de la campagne |
| `TIMEZONE` | Fuseau des tâches planifiées |
| `PROXY_DE_CONFIANCE` | Adresses du reverse proxy dont les en-têtes `X-Forwarded-*` sont acceptés |
| `RETENTION_JOURNAL_JOURS`, `RETENTION_RESULTATS_JOURS`, `RETENTION_PREUVES_JOURS` | Durées de conservation |
| `DEMO_MOT_DE_PASSE` | Mot de passe des comptes fictifs, mode démonstration uniquement |

`.env.example` documente l'ensemble des variables lues par l'application, y compris celles
que le back-office sait remplacer.

---

## Ordre de résolution

Pour chaque réglage :

1. valeur enregistrée dans **Administration → Configuration** — prioritaire ;
2. sinon, **variable d'environnement** de la pile Portainer ou du `.env` ;
3. sinon, valeur par défaut de l'application.

L'écran indique pour chaque champ son origine — *enregistré ici* ou *valeur
d'environnement*. Un réglage peut être remis à sa valeur d'environnement à tout moment.
