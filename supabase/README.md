# Base de données (Supabase)

Schéma PostgreSQL de Central.Parts, tiré de la maquette vivante (`site/app/`). Choix d'hébergement : [ADR 0008](../docs/decisions/0008-hebergement-stockage.md).

```
supabase/
├── migrations/   schéma versionné (tables, contraintes, RLS, vues anonymisées), à appliquer dans l'ordre
├── wechat/       menu du compte de service WeChat (publié par l'API)
├── functions/    fonctions Edge (import-stock : fichier déposé → lots ; depot : QR code WeChat et liens de dépôt ; wechat-events : scans)
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

**Par l'éditeur SQL** (le plus simple) : dans le tableau de bord, *SQL Editor* > *New query*, coller et exécuter chaque fichier de `migrations/` dans l'ordre (`20261011000001_schema.sql`, `20261011000002_cnh_compte_dedie.sql`, `20261030000003_depot_stock_fichiers.sql`, `20261030000004_depot_wechat.sql`, `20261030000005_ignore_fichiers_caches.sql`, puis `20261030000006_depot_qr_wechat.sql`) ; puis `reference.sql` (devises, niveaux de test). Si le schéma initial est déjà appliqué, n'exécuter que les migrations suivantes ; chaque migration ne s'exécute qu'une fois. `seed.sql` (sociétés et lots fictifs) seulement sur un projet de démonstration, jamais sur un projet qui reçoit de vraies données.

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

### Dépôt par le fournisseur lui-même, connecté par QR code WeChat

Page : `https://central.parts/depot/` (ADR 0010). Le fournisseur scanne un QR code du compte de service avec WeChat.

1. **Migrations** `20261030000004` et `20261030000006`.
2. **Secrets et déploiement** (Terminal, jamais dans le dépôt). `WECHAT_TOKEN` est un mot de passe partagé avec la console WeChat :
   ```bash
   WECHAT_TOKEN=$(openssl rand -hex 16); echo "$WECHAT_TOKEN"
   supabase secrets set --project-ref tuhbzziqyisdnqzfvtkh WECHAT_APPID=… WECHAT_SECRET=… WECHAT_TOKEN=$WECHAT_TOKEN DEPOT_SECRET=$(openssl rand -hex 32)
   supabase functions deploy depot --project-ref tuhbzziqyisdnqzfvtkh --use-api --no-verify-jwt
   supabase functions deploy wechat-events --project-ref tuhbzziqyisdnqzfvtkh --use-api --no-verify-jwt
   ```
   `--no-verify-jwt` : la page n'a pas de compte Supabase et WeChat signe ses propres appels ; chaque fonction vérifie elle-même.
3. **Console WeChat** (developers.weixin.qq.com, compte de service) : *域名与消息推送配置* > *消息推送* > *启用* :
   - URL : `https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/wechat-events`
   - Token : la valeur de `WECHAT_TOKEN`
   - EncodingAESKey : *随机生成* ; 消息加解密方式 : *明文模式* ; 数据格式 : *XML*
   Une fois activé, les réponses automatiques et le menu de la console ne s'appliquent plus.
4. **Inviter chaque contact** (éditeur SQL), puis lui envoyer le lien sur WeChat :
   ```sql
   select 'https://central.parts/depot/?invite=' || public.create_depot_invite('ORG-0100', 'Prénom du contact');
   ```
   Le lien sert une fois, 14 jours ; ensuite le contact rouvre simplement `https://central.parts/depot/` et scanne.
5. **Message d'accueil et menu** : une fois le 消息推送 activé, les réponses automatiques et le menu de la console ne s'appliquent plus. Le message d'accueil (abonnement, scan d'un QR code du compte autre que celui du dépôt) est envoyé par `wechat-events`. Le menu est défini dans `wechat/menu.json` et publié par l'API WeChat, depuis le Terminal (le secret est saisi sans s'afficher) :
   ```bash
   read -s WS; TOKEN=$(curl -s -X POST https://api.weixin.qq.com/cgi-bin/stable_token -H "Content-Type: application/json" \
     -d "{\"grant_type\":\"client_credential\",\"appid\":\"wx90a9a7c046914f5e\",\"secret\":\"$WS\"}" | sed -E 's/.*"access_token":"([^"]+)".*/\1/'); unset WS
   curl -s -X POST "https://api.weixin.qq.com/cgi-bin/menu/create?access_token=$TOKEN" -H "Content-Type: application/json" --data-binary @supabase/wechat/menu.json; echo
   ```
   Réponse attendue : `{"errcode":0,"errmsg":"ok"}`. Le menu apparaît chez les abonnés après quelques minutes (se désabonner puis se réabonner pour le voir tout de suite).
6. **Retirer l'accès** : `update public.wechat_identities set revoked_at = now() where org_id = 'ORG-0100';`

## Vérifier en local

```bash
tools/test-db.sh        # PostgreSQL local sur /var/tmp:54329 ; crée puis supprime la base cp_test
```

Le script applique une simulation minimale de Supabase (`checks/00_stub_supabase.sql` : rôles, `auth.users`, `auth.uid()`, stockage), les migrations, les données fictives, puis 127 contrôles : droits d'accès et intégrité (`checks/01_rls.sql`), dépôt et transformation des fichiers de stock, API de recherche (`checks/02_import.sql`), invitations, rattachement WeChat et connexion par QR code (`checks/03_depot.sql`). Ne jamais appliquer `checks/` sur un projet Supabase.

La lecture des fichiers (colonnes, séparateurs, prix, quantités), le jeton de session, les chemins de dépôt, la signature et les événements WeChat se testent sans base : `node tools/test-import.mjs`.

## Secrets

L'URL du projet n'est pas un secret. La clé `service_role`, le mot de passe de la base et la chaîne de connexion le sont : ils vivent dans le gestionnaire de secrets du serveur de l'API, jamais dans ce dépôt public, sur le site ou dans une conversation. Modèle de variables : [`../.env.example`](../.env.example).
