# 0017 — Accès des comptes européens : code par e-mail, un domaine par société

- Date : 2026-11-01
- Statut : acceptée ; construction après electronica 2026, avec les comptes clients (ADR 0015)

## Contexte

Les fournisseurs chinois se connectent avec WeChat (ADR 0010, 0012), qui fonctionne aussi hors de Chine. Il faut décider de l'accès des autres comptes : les fournisseurs européens (surplus d'EMS ou d'OEM, distributeurs) et les acheteurs (EMS, OEM, bureaux d'études). L'ADR 0015 prévoyait un lien de connexion par e-mail. Les comptes doivent rester ceux d'entreprises (B2B seulement) et ne pas laisser n'importe qui se rattacher à une société.

## Décision

### Deux systèmes d'accès, sans lien entre eux
- **Fournisseurs chinois** : WeChat uniquement (identités WeChat rattachées à leur société, inchangé).
- **Fournisseurs européens et acheteurs** : **code à 6 chiffres envoyé par e-mail**, sans mot de passe (Supabase Auth, connexion par code à usage unique). Un compte Supabase est rattaché à sa société par `members` (schéma initial).
- Chaque personne n'a qu'un mode d'accès ; il n'y a pas de table des personnes à plusieurs accès.
- Un code plutôt qu'un lien : les antivirus des messageries d'entreprise ouvrent les liens des e-mails pour les analyser et les consomment avant l'utilisateur ; un code se tape aussi d'un appareil à l'autre.
- Pas de connexion par Microsoft, Google ni SSO d'entreprise pour l'instant. Si un grand compte l'exige, on l'ajoutera (Microsoft d'abord), sans changer le reste.

### Un domaine par société (acheteurs et fournisseurs européens)
- Une société européenne, acheteuse ou fournisseur, est rattachée au **domaine de l'adresse professionnelle** de la personne qui l'inscrit (par exemple `atelier-lumen.fr`). Seules des adresses de ce domaine peuvent ensuite rejoindre la société.
- **Les messageries gratuites sont refusées** pour un compte européen (gmail.com, outlook.com, hotmail.*, yahoo.*, icloud.com, orange.fr, free.fr, laposte.net, gmx.*, web.de, qq.com, 163.com…) : la liste est tenue en base et complétable par l'opérateur.
- **Un domaine n'appartient qu'à une société.** Une nouvelle personne dont l'adresse correspond au domaine d'une société déjà inscrite ne crée pas de doublon : elle demande à rejoindre la société, et l'administrateur l'accepte. Les invitations envoyées par l'administrateur sont limitées au domaine.
- **Exceptions par l'opérateur** : un groupe aux filiales sur plusieurs domaines, ou deux sociétés distinctes sur un même domaine, se règlent en ajoutant ou en déplaçant un domaine, depuis la base.
- La vérification de la société par l'INPI ou VIES (ADR 0015) reste requise : le domaine dit qui peut rejoindre la société, pas que la société existe.
- Les fournisseurs chinois ne sont pas concernés : leur société est identifiée par le 统一社会信用代码 et leurs contacts par WeChat (ADR 0012).

## Points ouverts
- Le service d'envoi d'e-mails (SMTP) et l'adresse d'expédition des codes, avec SPF et DKIM du domaine central.parts.

## Conséquences
- Remplace, dans l'ADR 0015, le « lien de connexion par e-mail » par un code à 6 chiffres.
- À construire après electronica : table des domaines par société et liste des messageries gratuites, demandes d'adhésion des acheteurs, contrôle du domaine à l'inscription et à l'invitation, page de connexion par code.
