# Base de données (Supabase)

Schéma PostgreSQL de Central.Parts, tiré de la maquette vivante (`site/app/`). Choix d'hébergement : [ADR 0008](../docs/decisions/0008-hebergement-stockage.md).

```
supabase/
├── migrations/   schéma versionné (tables, contraintes, RLS, vues anonymisées), à appliquer dans l'ordre
├── functions/    fonctions Edge (import-stock : fichier déposé → lots ; depot : connexion WeChat et liens de dépôt)
├── reference.sql données de référence (devises, niveaux de test, opérateur) : sur tout projet, après les migrations
├── seed.sql      données fictives de la maquette, pour un projet de démonstration uniquement
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

**Par l'éditeur SQL** (le plus simple) : dans le tableau de bord, *SQL Editor* > *New query*, coller et exécuter chaque fichier de `migrations/` dans l'ordre (`20261011000001_schema.sql`, `20261011000002_cnh_compte_dedie.sql`, `20261030000003_depot_stock_fichiers.sql`, `20261030000004_depot_wechat.sql`, puis `20261030000005_ignore_fichiers_caches.sql`) ; puis `reference.sql` (devises, niveaux de test). Si le schéma initial est déjà appliqué, n'exécuter que les migrations suivantes ; chaque migration ne s'exécute qu'une fois. `seed.sql` (sociétés et lots fictifs) seulement sur un projet de démonstration, jamais sur un projet qui reçoit de vraies données.

**Par la CLI Supabase** :

```bash
supabase login
supabase init                       # une fois, crée supabase/config.toml
supabase link --project-ref tuhbzziqyisdnqzfvtkh
supabase db push                    # applique les migrations
psql "$SUPABASE_DB_URL" -f supabase/seed.sql   # dev uniquement
```

Pour les comptes de test : les créer dans *Authentication* > *Users*, puis les rattacher à une organisation fictive (exemple en fin de `seed.sql`).

## Dépôt des fichiers de stock

Un fournisseur sans API (ADR 0010) dépose ses fichiers CSV, XLS ou XLSX ; ils deviennent des lots, interrogeables par l'API.

1. **Une fois** : appliquer la migration `20261030000003`, puis déployer la fonction et la brancher.
   ```bash
   supabase functions deploy import-stock
   ```
   Dans le tableau de bord, *Database* > *Webhooks* : un webhook sur la table `stock_imports`, événement *Insert*, qui appelle la fonction Edge `import-stock` (méthode POST).
2. **Créer la société du fournisseur** (éditeur SQL), une fois son KYB fait. Exemple, avec des valeurs à adapter :
   ```sql
   insert into public.organizations (type, name, alias, city, country, currency, lang, profile, kyb)
   values ('seller', 'Nom de la société', 'V-5', 'Shenzhen', 'CN', 'USD', 'zh', 'Broker', 'validated')
   returning id;   -- par exemple ORG-0100 : c'est le nom de son dossier
   insert into public.subscriptions (org_id, plan, until) values ('ORG-0100', 'Vendeur Opportunity', current_date + 365);
   ```
3. **Déposer un fichier** dans *Storage* > `stock-imports` > dossier `ORG-0100/`. Donner un nouveau nom à chaque dépôt (la date dans le nom) ; un nom qui contient « complet » remplace tout le stock précédent de la société.
4. **Suivre l'import** : table `stock_imports` (statut, compteurs, `report` avec les lignes rejetées et les doublons possibles). En cas d'échec, corriger le fichier et le déposer sous un nouveau nom.
5. **Interroger le stock** (utilisateur connecté) :
   ```bash
   curl -X POST "$SUPABASE_URL/rest/v1/rpc/search_stock" \
     -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer <jeton de l'utilisateur>" \
     -H "Content-Type: application/json" -d '{"q": "XC2S50"}'
   ```

### Dépôt par le fournisseur lui-même, connecté avec WeChat

Page : `https://central.parts/depot/`, à ouvrir dans WeChat (ADR 0010).

1. **Compte de service WeChat** (mp.weixin.qq.com) :
   - *设置与开发* > *接口权限* > *网页授权* > *修改* : domaine d'autorisation `central.parts`. WeChat fournit un fichier `MP_verify_….txt` : le placer à la racine de `site/`, publier, puis valider.
   - *设置与开发* > *基本配置* : relever l'AppID (public) et l'AppSecret (secret).
2. **AppID dans la page** : renseigné dans `site/depot/index.html` (`var APPID`). Vide, la page s'affiche « en configuration ».
3. **Secrets de la fonction** (Terminal, jamais dans le dépôt) puis déploiement :
   ```bash
   supabase secrets set --project-ref tuhbzziqyisdnqzfvtkh WECHAT_APPID=… WECHAT_SECRET=… DEPOT_SECRET=$(openssl rand -hex 32)
   supabase functions deploy depot --project-ref tuhbzziqyisdnqzfvtkh --use-api --no-verify-jwt
   ```
   `--no-verify-jwt` : la page n'a pas de compte Supabase ; la fonction vérifie elle-même sa session.
4. **Inviter le fournisseur** (éditeur SQL), puis lui envoyer le lien sur WeChat :
   ```sql
   select 'https://central.parts/depot/?invite=' || public.create_depot_invite('ORG-0100', 'Prénom du contact');
   ```
   Le lien sert une fois, 14 jours ; ensuite le fournisseur rouvre simplement `https://central.parts/depot/` dans WeChat.
5. **Retirer l'accès** : `update public.wechat_identities set revoked_at = now() where org_id = 'ORG-0100';`

## Vérifier en local

```bash
tools/test-db.sh        # PostgreSQL local sur /var/tmp:54329 ; crée puis supprime la base cp_test
```

Le script applique une simulation minimale de Supabase (`checks/00_stub_supabase.sql` : rôles, `auth.users`, `auth.uid()`, stockage), les migrations, les données fictives, puis 110 contrôles : droits d'accès et intégrité (`checks/01_rls.sql`), dépôt et transformation des fichiers de stock, API de recherche (`checks/02_import.sql`), invitations et rattachement WeChat (`checks/03_depot.sql`). Ne jamais appliquer `checks/` sur un projet Supabase.

La lecture des fichiers (colonnes, séparateurs, prix, quantités), le jeton de session et les chemins de dépôt se testent sans base : `node tools/test-import.mjs`.

## Secrets

L'URL du projet n'est pas un secret. La clé `service_role`, le mot de passe de la base et la chaîne de connexion le sont : ils vivent dans le gestionnaire de secrets du serveur de l'API, jamais dans ce dépôt public, sur le site ou dans une conversation. Modèle de variables : [`../.env.example`](../.env.example).
