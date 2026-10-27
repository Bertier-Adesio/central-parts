# Base de données (Supabase)

Schéma PostgreSQL de Central.Parts, tiré de la maquette vivante (`site/app/`). Choix d'hébergement : [ADR 0008](../docs/decisions/0008-hebergement-stockage.md).

```
supabase/
├── migrations/   schéma versionné (tables, contraintes, RLS, vues anonymisées), à appliquer dans l'ordre
├── seed.sql      données fictives de la maquette, pour le projet dev uniquement
└── checks/       contrôles sur un PostgreSQL local (simulation minimale de Supabase, RLS, intégrité)
```

## Ce que contient le schéma

- **Organisations** (acheteur, vendeur, laboratoire, banque, opérateur) avec alias, devise, KYB ; coordonnées bancaires à part ; abonnements. Un utilisateur Supabase Auth est rattaché à une organisation par `members`.
- **Inventory** : offre agrégée, nomenclatures, commandes.
- **Opportunity** : lots (questionnaire et pièces en JSON, paliers de prix), connecteurs aux API produit des brokers et leur journal d'appels, canaux de notification, webhooks, clés d'API (empreinte seule), demandes, vendeurs consultés, enchères, offres.
- **Transactions** : lot figé à l'acceptation, statuts de la maquette, historique, dossiers de laboratoire, litiges.
- **Argent** : ordres de paiement et leurs lignes, double validation par deux opérateurs distincts, registre du compte dédié par devise (EUR, USD, CNH, HKD, GBP, JPY).

Règles appliquées par la base :

- les utilisateurs connectés **lisent** seulement ce qui concerne leur organisation ; ils **n'écrivent rien** : toutes les écritures passent par l'API métier (clé `service_role`, côté serveur) ;
- rien n'est accessible sans connexion (rôle `anon`) ;
- un acheteur voit le vendeur par son alias, sans son prix net ; un vendeur voit l'acheteur par son alias, avec la seule zone de livraison ; le laboratoire ne voit ni l'un ni l'autre, ni les prix ;
- registre du compte dédié, historique des transactions et journal en ajout seul ;
- un ordre de paiement ne passe « approuvé » qu'avec deux validations d'opérateurs distincts ;
- `app.is_verified(org)` : KYB validé et abonnement en cours (bac à sable exempté).

## Appliquer sur le projet dev

Projet : `https://tuhbzziqyisdnqzfvtkh.supabase.co`.

**Par l'éditeur SQL** (le plus simple) : dans le tableau de bord, *SQL Editor* > *New query*, coller et exécuter chaque fichier de `migrations/` dans l'ordre (`20261011000001_schema.sql`, puis `20261011000002_cnh_compte_dedie.sql`) ; puis faire de même avec `seed.sql`. Si le schéma initial est déjà appliqué, n'exécuter que les migrations suivantes. Chaque migration ne s'exécute qu'une fois ; `seed.sql` seulement sur un projet vide.

**Par la CLI Supabase** :

```bash
supabase login
supabase init                       # une fois, crée supabase/config.toml
supabase link --project-ref tuhbzziqyisdnqzfvtkh
supabase db push                    # applique les migrations
psql "$SUPABASE_DB_URL" -f supabase/seed.sql   # dev uniquement
```

Pour les comptes de test : les créer dans *Authentication* > *Users*, puis les rattacher à une organisation fictive (exemple en fin de `seed.sql`).

## Vérifier en local

```bash
tools/test-db.sh        # PostgreSQL local sur /var/tmp:54329 ; crée puis supprime la base cp_test
```

Le script applique une simulation minimale de Supabase (`checks/00_stub_supabase.sql` : rôles, `auth.users`, `auth.uid()`), la migration, les données fictives, puis 60 contrôles (`checks/01_rls.sql`). Ne jamais appliquer `checks/` sur un projet Supabase.

## Secrets

L'URL du projet n'est pas un secret. La clé `service_role`, le mot de passe de la base et la chaîne de connexion le sont : ils vivent dans le gestionnaire de secrets du serveur de l'API, jamais dans ce dépôt public, sur le site ou dans une conversation. Modèle de variables : [`../.env.example`](../.env.example).
