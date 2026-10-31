# 0015 — Comptes clients B2B, identifiés par l'INPI et VIES

- Date : 2026-10-31
- Statut : acceptée ; construction après electronica 2026, avec le lancement des achats (ADR 0014)

## Contexte

Les acheteurs doivent pouvoir créer eux-mêmes leur compte pour acheter et voir le détail réservé aux comptes : quantités exactes, paliers, délais (ADR 0013). Aujourd'hui, la demande d'achat (ADR 0014) se fait sans compte, et les sociétés acheteuses sont créées à la main. Central.Parts ne vend qu'aux entreprises.

## Décision

- **Uniquement des comptes B2B.** Chaque compte est rattaché à une société identifiée par un numéro officiel. Aucun particulier.
- **Connexion par code à 6 chiffres envoyé par e-mail** (Supabase Auth, sans mot de passe), sur l'adresse professionnelle ; une société acheteuse est limitée au domaine de son adresse (ADR 0017, qui remplace le lien initialement prévu). Il faut brancher un service d'envoi d'e-mails (SMTP) à Supabase : l'envoi intégré est limité à quelques messages par heure. Le service reste à choisir.
- **Identification de la société** :
  - **France** : numéro SIREN, vérifié auprès de l'**API du Registre national des entreprises (INPI)**. La société doit être active ; on reprend sa dénomination et l'adresse de son siège.
  - **Autres pays de l'Union européenne** : numéro de TVA vérifié auprès de **VIES** (Commission européenne), qui donne la raison sociale et l'adresse quand le pays les fournit.
  - **Royaume-Uni, Suisse, Norvège** : examen par l'opérateur.
- **Validation automatique** quand la société est identifiée : SIREN actif à l'INPI, ou numéro de TVA valide dans VIES, et nom saisi cohérent avec le registre. Sinon, la société est examinée par l'opérateur.
- **Une société n'existe qu'une fois.** Son numéro est unique (`organizations.registration_number`, ADR 0012). Le premier utilisateur en devient l'administrateur et invite ses collègues ; un nouvel utilisateur d'une société déjà inscrite demande à la rejoindre.
- Les appels à l'INPI et à VIES se font **côté serveur**, dans une fonction Edge. Les identifiants de l'API INPI sont des secrets de fonction, jamais dans ce dépôt public. Les pages ne chargent aucune ressource de ces services.
- Les comptes acheteurs utilisent `auth.users` et `members` (schéma initial), et non les identités WeChat réservées aux fournisseurs (ADR 0010, 0012).

## À préparer d'ici là

- Un compte sur le portail de l'INPI, avec accès à l'API du RNE (identifiants à mettre dans les secrets Supabase). En secours, sans compte, l'API publique « Recherche d'entreprises » de l'État donne le SIREN, la dénomination et l'état administratif.
- Le service d'envoi d'e-mails (SMTP) et l'adresse d'expédition (par exemple compte@central.parts), avec les enregistrements SPF et DKIM du domaine.
- Les conditions générales de vente, avant l'ouverture des achats.

## Conséquences

- La demande d'achat sans compte (ADR 0014) reste possible, ou devient réservée aux comptes : à trancher au lancement.
- Les vérifications VIES de la demande d'achat et de l'inscription partagent le même code.
