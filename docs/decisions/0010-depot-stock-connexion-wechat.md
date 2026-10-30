# 0010 — Dépôt des fichiers de stock et connexion des fournisseurs par WeChat

- Date : 2026-10-30
- Statut : acceptée. Dépôt, transformation et connexion par QR code WeChat (扫码登录) en service : parcours complet vérifié le 30 octobre 2026 sur le projet Supabase (invitation, scan, dépôt, rapport d'import).

## Contexte

Un broker partenaire, en Chine, transmet son stock en fichiers CSV ou XLS. Il n'a pas d'API produit (ADR 0007) et ne poussera pas d'offres par l'API fournisseur (ADR 0004) à court terme. Il travaille sur WeChat et attend une page où il se connecte avec son compte WeChat pour déposer ses fichiers. L'hébergement OVH du site ne convient pas à ce dépôt : un seul compte FTP, qui sert au déploiement, 100 Mo, et un dossier `www/` public.

## Décision

### Dépôt et transformation (implémenté)

- Les fichiers vont dans un **compartiment privé Supabase**, `stock-imports`, un dossier par société : `<id de l'organisation>/<fichier>`. Formats CSV, XLS, XLSX, 50 Mo au plus par fichier.
- Chaque dépôt ouvre un **import** (`public.stock_imports`), suivi de bout en bout : reçu, en cours, terminé ou en échec, avec un rapport (lignes rejetées et motif, doublons possibles, lots sans date code).
- La **fonction Edge `import-stock`** lit le fichier, reconnaît les colonnes (format broker, Octopart, ECIA, comme la maquette et `data/formats.md`) et envoie les lignes par paquets à la base, qui crée ou met à jour les lots. Clé de mise à jour : le SKU du fournisseur, sinon référence et date code. Un fichier dont le nom contient « complet » remplace le stock précédent : les lots absents passent à quantité 0.
- Le stock devient interrogeable par l'**API REST de Supabase** : `POST /rest/v1/rpc/search_stock`. Elle renvoie l'offre Inventory et les disponibilités Opportunity des vendeurs vérifiés, agrégées par référence, sans identité ni prix du vendeur.
- Migration `20261030000003_depot_stock_fichiers.sql` ; lecture des fichiers testée par `tools/test-import.mjs`, base par `tools/test-db.sh`.

### Connexion par QR code WeChat (implémentée)

- Central.Parts dispose d'un **compte de service (服务号) vérifié**. L'autorisation de page web (网页授权) a été écartée : le domaine d'autorisation, comme le domaine JS, exige une **licence ICP** que `central.parts` n'a pas (constaté dans la console WeChat le 30 octobre 2026).
- La page `https://central.parts/depot/` (中文 par défaut, English) affiche un **QR code temporaire du compte de service** (5 minutes, scène aléatoire). Le fournisseur le scanne avec WeChat ; sur téléphone, il fait un appui long sur le QR code. WeChat envoie l'événement de scan à la fonction Edge **`wechat-events`** (消息推送, mode clair, signature vérifiée), qui rattache l'`openid` à la tentative et répond au fournisseur dans WeChat. La page interroge la tentative et reçoit son jeton de session (12 h). C'est la connexion « 扫码登录 » habituelle des sites chinois ; elle marche aussi dans un navigateur ordinaire, là où sont les fichiers Excel.
- **Rattachement** : l'opérateur crée une invitation par contact (`select public.create_depot_invite('ORG-…', 'Prénom')`, usage unique, 14 jours) et envoie le lien `https://central.parts/depot/?invite=<jeton>` ; au premier scan, l'`openid` est rattaché à la société (`wechat_identities`). Une société peut avoir plusieurs contacts. Révocation : `revoked_at`.
- La **fonction Edge `depot`** crée le QR code (jeton d'accès WeChat `stable_token`, gardé en base), remet la session, puis délivre à chaque envoi un **lien de dépôt signé** vers le seul dossier de la société, et la liste des imports avec leur rapport.
- Le choix « stock complet » est explicite dans la page ; le nom du fichier est horodaté et réduit à des caractères sûrs.
- Secrets de fonction Edge, jamais dans le dépôt ni dans la page : `WECHAT_APPID`, `WECHAT_SECRET`, `WECHAT_TOKEN` (jeton du 消息推送), `DEPOT_SECRET`. Aucune liste blanche d'adresses IP n'est exigée pour le jeton d'accès (vérifié le 30 octobre 2026).
- Migrations `20261030000004_depot_wechat.sql` et `20261030000006_depot_qr_wechat.sql`, fonctions `supabase/functions/depot/` et `wechat-events/`, outils partagés `_shared/depot.js`, page `site/depot/index.html`.

### En attendant la connexion WeChat

- L'opérateur dépose le fichier reçu par WeChat ou par e-mail dans le tableau de bord Supabase (Storage, dossier de la société), ou envoie au fournisseur un lien de dépôt signé.

## Conséquences

- Mise en service : activer le 消息推送 du compte de service vers `wechat-events`, déployer les fonctions avec leurs secrets ; voir `supabase/README.md`. Une fois le 消息推送 activé, les réponses automatiques et le menu définis dans la console WeChat ne s'appliquent plus : ils devront être repris par `wechat-events` si on en a besoin.
- Le compte de service s'appelle « Adesio Central.Parts » ; à sa création, la société dédiée devra le reprendre ou en ouvrir un.
- La page de dépôt et les fonctions Edge appellent `*.supabase.co`, hébergé en Europe : la rapidité de l'envoi depuis la Chine est à mesurer (ADR 0006), comme pour le site.
- Les fichiers bruts des fournisseurs restent dans le compartiment privé, jamais dans le dépôt Git.
