# API des plateformes (offres en direct et route RFQ) : mise en service avec Adesio

Procédure pour Bertier, dans l'ordre. Décisions : [ADR 0023](decisions/0023-route-rfq-plateformes-validation-wechat.md) (RFQ), [ADR 0024](decisions/0024-api-offres-en-direct-formats-compatibles.md) (offres en direct) ; contrat d'API : [`api/plateformes.md`](../api/plateformes.md). Aucune étape n'envoie de message à un fournisseur réel tant que l'étape 6 n'est pas faite.

## 1. Appliquer la migration (avant la fusion)

SQL Editor de Supabase, projet de production : coller et exécuter `supabase/migrations/20261102000020_route_rfq.sql`, puis `supabase/migrations/20261102000021_api_offres.sql`. Prérequis : migrations jusqu'à `20261102000019` déjà appliquées. Rejouables ; elles n'effacent aucune donnée.

Puis `supabase/sandbox-rfq.sql` : le fournisseur de test du bac à sable (fictif, jamais public, jamais contacté).

## 2. Secrets de la fonction `rfq`

Supabase › Edge Functions › Secrets (partagés par toutes les fonctions) :

| Secret | Valeur |
|---|---|
| `RFQ_WEBHOOK_KEY` | 64 caractères aléatoires (`openssl rand -hex 32`). Sert à dériver les secrets de signature des webhooks : le changer invalide les secrets déjà remis aux plateformes. |
| `RFQ_JOBS_SECRET` | 64 caractères aléatoires, pour la tâche planifiée. |
| `RFQ_WECHAT_OPEN` | `false` pour commencer. |

`WECHAT_APPID`, `WECHAT_SECRET` et `WECHAT_TOKEN` existent déjà (robot).

## 3. Fusionner la PR

La fusion sur `main` déploie automatiquement les fonctions `rfq`, `wechat-events`, `admin` et `depot` (`deploy-supabase-functions.yml`) et publie `/depot/`. À la main sinon : `tools/deploy-functions.sh rfq wechat-events admin depot`.

Vérification : `curl -s https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/rfq/v1/health` répond `401` (clé requise) : la fonction est en ligne. Avec la clé de test (étape 4) :

```bash
curl -s -H "Authorization: Bearer cp_test_…" "https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/rfq/v1/offers?mpn=NE555DR&qty=1000"
```

renvoie l'offre du fournisseur de test ; même chose au format DigiKey : `…/rfq/compat/digikey/products/v4/search/NE555DR/productdetails`.

## 4. Organisation et clés d'Adesio

Sur ton poste, dans le dépôt :

```bash
node tools/create-api-key.mjs --new-org "Adesio" --env test --calls-per-minute 600
```

`--calls-per-minute` : si le connecteur d'Adesio interroge une référence par appel (comme pour DigiKey ou TI), une nomenclature de 300 lignes demande 300 appels ; 60 par minute par défaut ne suffisent pas.

Coller le SQL affiché dans le SQL Editor ; noter l'identifiant `ORG-…` renvoyé. La clé `cp_test_…` affichée n'existe nulle part ailleurs : la transmettre à Adesio par un canal sûr. Clé de production, plus tard :

```bash
node tools/create-api-key.mjs --org ORG-XXXX --env live
```

## 5. Tâche planifiée (toutes les 5 minutes)

Rappels (24 h administrateur, 36 h fournisseur), expirations (48 h), clôtures et livraisons des webhooks. Dans le SQL Editor (extensions `pg_cron` et `pg_net` à activer dans Database › Extensions), en remplaçant `<RFQ_JOBS_SECRET>` :

```sql
select cron.schedule('rfq-tick', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/rfq/jobs/tick',
    headers := '{"Content-Type": "application/json", "X-CP-Jobs-Secret": "<RFQ_JOBS_SECRET>"}'::jsonb,
    body := '{}'::jsonb)
$$);
```

Sans elle, tout fonctionne quand chaque fournisseur répond (clôture immédiate) ; seuls les rappels, les expirations et les nouvelles tentatives de webhooks attendent.

## 6. Ouvrir la diffusion aux fournisseurs réels

Seulement après un essai complet en bac à sable avec Adesio : `RFQ_WECHAT_OPEN` = `true`. Tant que ce n'est pas fait, une validation (`approve DEM-…`) répond « broadcast closed » et rien ne part ; une fois ouvert, `resend DEM-…` envoie les demandes déjà validées.

Avant la première RFQ réelle, prévenir les fournisseurs de la règle : réponse sous 48 h, rappel à 36 h, demande expirée comptée « non traitée » (texte d'information, sans clause).

## 7. Exploitation au quotidien (robot WeChat, en anglais)

| Commande | Effet |
|---|---|
| `rfq` | RFQ en attente de validation |
| `rfq DEM-1042` | Fiche : plateforme, référence client, fournisseurs appariés, état de chaque envoi et réponse |
| `approve DEM-1042` | Valide et prévient les fournisseurs appariés |
| `approve DEM-1042 only ORG-0101,ORG-0105` | Valide en limitant la diffusion |
| `reject DEM-1042 motif` | Refuse ; la plateforme reçoit le motif |
| `resend DEM-1042` / `resend DEM-1042 ORG-0101` | Renvoie aux fournisseurs non joints (fenêtre WeChat de 48 h) |
| `rfq stats ORG-0101` | Taux de traitement d'un fournisseur |

Un fournisseur qui n'a pas écrit au compte de service depuis 48 heures ne peut pas recevoir le message (règle de WeChat, tant qu'aucun message modèle n'est approuvé) : le robot le signale, son délai ne démarre pas, et `resend` le relance une fois qu'il a écrit.
