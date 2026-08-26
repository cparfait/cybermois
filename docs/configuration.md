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
| Serveur | `ldaps://192.168.2.9:636` | Chiffré. `ldap://…:389` fonctionne aussi, mais fait circuler les mots de passe en clair. |
| Compte de service | `svc-cybermois@chatillon.lan` | Le DN complet est également accepté. |
| Base de recherche | `DC=chatillon,DC=lan` | |
| Groupe des administrateurs | `GG-Cybermois-Admins` | Nom court ou DN complet. |
| Profondeur d'OU | `1` | L'OU contenant directement l'agent. |

### Le bouton « Tester la connexion »

Il utilise **les valeurs affichées à l'écran, pas celles enregistrées**. Vous pouvez donc
vérifier une configuration avant de l'appliquer, sans risquer de vous couper l'accès.

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
| Serveur | `chatillon92-fr.mail.protection.outlook.com` |
| Port | `25` |
| Connexion chiffrée d'emblée | inactif — le port 25 est élevé en TLS par STARTTLS |
| Identifiant / mot de passe | vides — Direct Send n'authentifie pas |
| Expéditeur | `Cybermois <cybermois@chatillon92.fr>` |

Le bouton **Tester** vérifie la joignabilité du relais, et envoie un vrai message si vous
indiquez une adresse.

**Deux limites du Direct Send à connaître avant de compter dessus.** Il ne délivre qu'aux
destinataires de votre propre locataire : parfait pour une campagne interne, inopérant vers
l'extérieur. Et comme le conteneur émettra depuis une adresse IP nouvelle, vos messages
peuvent être classés en indésirables si cette adresse ne figure pas dans l'enregistrement
SPF du domaine. Faites le test grandeur nature tôt, et regardez le dossier « courrier
indésirable » : c'est le genre de détail qui ne se découvre qu'au premier envoi de masse.

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

---

## Ce qui n'est pas modifiable ici

Ces réglages sont lus avant l'ouverture de la base, et exigent un redémarrage :

| Variable | Rôle |
|---|---|
| `SESSION_SECRET` | Chiffrement des sessions et des mots de passe stockés |
| `PORT`, `NODE_ENV` | Serveur |
| `DB_FILE` | Emplacement de la base |
| `ADMIN_LOCAL_LOGIN`, `ADMIN_LOCAL_MOT_DE_PASSE` | Amorçage du compte local seulement |

---

## Ordre de résolution

Pour chaque réglage :

1. valeur enregistrée dans **Administration → Configuration** — prioritaire ;
2. sinon, **variable d'environnement** de la pile Portainer ou du `.env` ;
3. sinon, valeur par défaut de l'application.

L'écran indique pour chaque champ son origine — *enregistré ici* ou *valeur
d'environnement*. Un réglage peut être remis à sa valeur d'environnement à tout moment.
