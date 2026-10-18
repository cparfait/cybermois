# Rétroplanning Cybermois

Campagne visée : **lundi 5 octobre au samedi 31 octobre 2026**, quatre défis hebdomadaires.

## Avant l'ouverture

| Échéance | Action | Qui |
|---|---|---|
| J-30 | Valider le principe et le calendrier avec la direction | DSI + DPO |
| J-30 | Créer le compte de service AD en lecture seule | DSI |
| J-28 | Vérifier la structure des OU et la couverture de l'attribut `mail` | DSI |
| J-25 | Déployer sur la VM, configurer Nginx Proxy Manager et le certificat | DSI |
| J-21 | Recette technique : diagnostic LDAPS et SMTP au vert | DSI |
| J-21 | Faire valider la notice d'information et le classement nominatif | DPO |
| J-14 | Relecture des contenus des 4 défis | DSI + DPO |
| J-10 | Test avec 5 à 6 agents de services différents | DSI |
| J-7 | Corriger ce que remonte le test, réinitialiser les participations | DSI |
| J-3 | Relire l'aperçu du mail d'ouverture (onglet Mails) | DPO |
| J-1 | Passer `MAIL_ENVOI_ACTIF=true`, vérifier les tâches planifiées | DSI |

## Pendant la campagne

| Semaine | Ouverture | Défi |
|---|---|---|
| 1 | lundi 5 octobre | Le coffre-fort — mots de passe et double authentification |
| 2 | lundi 12 octobre | Légitime ou piège ? — hameçonnage |
| 3 | lundi 19 octobre | Poste sous surveillance — données et poste de travail |
| 4 | lundi 26 octobre | L'art de la manipulation — ingénierie sociale |

Rythme hebdomadaire :

- **premier jour, 8h** — mail d'ouverture à chaque agent : ce qu'est le Cybermois, comment
  il se déroule, le calendrier des défis et l'information sur les données ;
- **lundis suivants, 8h** — annonce des défis de la semaine à chaque agent, avec les défis
  précédents qu'il n'a pas encore faits, toujours ouverts ;
- **mercredi 9h** — relance des seuls agents qui n'ont pas fait tous les défis des sept
  derniers jours, en un seul message ;
- **vendredi 16h** — résultats et classement envoyés au groupe de distribution.

Tout se pilote depuis l'onglet Mails du back-office : un interrupteur général des envois
automatiques, un interrupteur par mail, et pour chacun un bouton « Envoyer maintenant » qui
fonctionne même quand l'automatique est coupé.

Deux points de vigilance en cours de campagne :

- surveiller le taux de participation dès le mercredi de la semaine 1 ; s'il est faible,
  un mot de la direction en réunion d'encadrement est le levier le plus efficace ;
- consulter « Services à relancer » dans le back-office, et cibler individuellement les
  services les plus en retrait plutôt que de multiplier les envois généraux.

## Après la campagne

| Échéance | Action |
|---|---|
| 31 octobre | Clôture, dernier mail de résultats |
| Début novembre | Export de la preuve de participation, archivage |
| Début novembre | Bilan : taux de participation par service, thèmes les moins réussis |
| Novembre | Utiliser les résultats pour orienter le plan de sensibilisation de l'année |

Les questions les moins réussies sont les plus instructives : elles indiquent où porter
l'effort de formation. Le back-office affiche le taux de réussite moyen par défi, et
l'export des participations permet une analyse question par question.
