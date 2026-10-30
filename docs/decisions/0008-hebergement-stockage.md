# 0008 — Hébergement et stockage des données

- Date : 2026-10-11
- Statut : proposée

## Contexte

La maquette (`site/app/`, ADR 0003) garde tout en mémoire dans le navigateur. Pour connecter de vrais vendeurs, acheteurs, laboratoires et la banque, il faut une base, une authentification, un stockage de pièces jointes et un endroit où faire tourner l'API métier et les tâches longues (échéances, appels aux connecteurs, imports SFTP, notifications WeChat). Contraintes :

- des données de sociétés européennes et un compte dédié aux fonds des acheteurs : hébergement dans l'Union européenne ;
- l'anonymat entre acheteurs et vendeurs est au cœur de l'offre Opportunity ;
- une petite équipe : peu d'exploitation, mise en route rapide ;
- pouvoir partir sans réécrire l'application.

## Décision

- **Une seule base PostgreSQL**, hébergée par **Supabase en région UE**. Le projet a été créé à Francfort (`eu-central-1`) ; Paris était préféré, mais la région ne se change pas après création et Francfort reste dans l'UE. Elle porte les organisations, abonnements, lots, demandes, enchères, offres, transactions, dossiers de laboratoire, litiges, ordres de paiement et le registre du compte dédié.
- **Deux projets** : `central-parts-dev` (données fictives, sert aussi de bac à sable aux brokers) et `central-parts-prod`, créé avant les premiers vrais vendeurs. Aucune donnée réelle dans `dev`.
- **L'API métier fait toutes les écritures** (clé `service_role`, côté serveur uniquement). Elle porte les règles de la maquette (`site/app/js/api.js`) : transitions de transaction, double validation des ordres, statut « vérifié ». Elle tourne dans un service Node à part, sur un PaaS français (Clever Cloud ou Scaleway), avec les tâches planifiées.
- **La RLS est la seconde ceinture** : les utilisateurs connectés n'ont que des droits de lecture, limités à leur organisation ; rien pour les visiteurs anonymes. Les lectures croisées passent par des vues qui ne montrent que les alias (`v_seller_demands`, `v_buyer_offers`, `v_my_transactions`, `v_seller_status`).
- **Aucun secret en base** : clés d'API fournisseur en empreinte seulement ; secrets des connecteurs, des webhooks et URL des robots WeCom dans un coffre (Supabase Vault ou celui du PaaS), référencés par une colonne `*_ref`.
- **Pièces jointes** (photos, CoC, certificats de laboratoire) dans le stockage objet Supabase, compartiments privés, liens signés à durée courte.
- **KYB chez un prestataire KYC** : la base ne garde que la référence du dossier et la décision, pas les pièces d'identité.
- **Les fonds restent à la banque.** Les tables `payment_orders` et `funds_movements` (anciennement `escrow_movements`, ADR 0009) sont le registre de Central.Parts, rapproché des relevés ; journaux en ajout seul.
- **Sauvegardes** : celles de Supabase, plus un export quotidien chiffré chez un second hébergeur européen (OVH Object Storage), pour pouvoir restaurer ailleurs.
- **Le site public reste sur OVH**, inchangé (ADR 0002).
- Schéma initial : `supabase/migrations/20261011000001_schema.sql`, données fictives `supabase/seed.sql`, contrôles `tools/test-db.sh` (60 contrôles de RLS et d'intégrité sur un PostgreSQL local).

## Conséquences

- Mise en route en quelques heures : base, authentification, stockage et sauvegardes déjà fournis.
- Supabase est une société américaine : le Cloud Act s'applique malgré l'hébergement en UE. Acceptable pour le démarrage ; à réévaluer avant d'y mettre des données sensibles à grande échelle ou si un client l'exige.
- **Critères de sortie** : rester sur du PostgreSQL standard (pas de dépendance aux fonctions propriétaires dans la logique métier), migrations SQL versionnées dans le dépôt, API métier hors de Supabase. Une migration vers un PostgreSQL managé français (Scaleway, Clever Cloud, OVH) se fait alors par export et restauration, plus un changement de fournisseur d'authentification.
- La clé `anon` ne sert dans un navigateur qu'une fois la RLS en place et testée ; la clé `service_role` et le mot de passe de la base ne quittent jamais le serveur : ni dépôt, ni site, ni conversation.
- Les vues anonymisées s'exécutent avec les droits de leur propriétaire : l'avertissement « security definer view » du conseiller Supabase est attendu ; chaque vue filtre elle-même sur l'organisation de l'utilisateur et est couverte par les contrôles.
