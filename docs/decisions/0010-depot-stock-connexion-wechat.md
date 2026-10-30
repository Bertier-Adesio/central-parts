# 0010 — Dépôt des fichiers de stock et connexion des fournisseurs par WeChat

- Date : 2026-10-30
- Statut : proposée (la partie dépôt et transformation est implémentée ; la connexion WeChat attend les comptes WeChat)

## Contexte

Un broker partenaire, en Chine, transmet son stock en fichiers CSV ou XLS. Il n'a pas d'API produit (ADR 0007) et ne poussera pas d'offres par l'API fournisseur (ADR 0004) à court terme. Il travaille sur WeChat et attend une page où il se connecte avec son compte WeChat pour déposer ses fichiers. L'hébergement OVH du site ne convient pas à ce dépôt : un seul compte FTP, qui sert au déploiement, 100 Mo, et un dossier `www/` public.

## Décision

### Dépôt et transformation (implémenté)

- Les fichiers vont dans un **compartiment privé Supabase**, `stock-imports`, un dossier par société : `<id de l'organisation>/<fichier>`. Formats CSV, XLS, XLSX, 50 Mo au plus par fichier.
- Chaque dépôt ouvre un **import** (`public.stock_imports`), suivi de bout en bout : reçu, en cours, terminé ou en échec, avec un rapport (lignes rejetées et motif, doublons possibles, lots sans date code).
- La **fonction Edge `import-stock`** lit le fichier, reconnaît les colonnes (format broker, Octopart, ECIA, comme la maquette et `data/formats.md`) et envoie les lignes par paquets à la base, qui crée ou met à jour les lots. Clé de mise à jour : le SKU du fournisseur, sinon référence et date code. Un fichier dont le nom contient « complet » remplace le stock précédent : les lots absents passent à quantité 0.
- Le stock devient interrogeable par l'**API REST de Supabase** : `POST /rest/v1/rpc/search_stock`. Elle renvoie l'offre Inventory et les disponibilités Opportunity des vendeurs vérifiés, agrégées par référence, sans identité ni prix du vendeur.
- Migration `20261030000003_depot_stock_fichiers.sql` ; lecture des fichiers testée par `tools/test-import.mjs`, base par `tools/test-db.sh`.

### Connexion par WeChat (proposée)

- Une page de dépôt (`/depot/`, en chinois et en anglais) propose « 微信登录 ». Deux chemins, selon l'endroit où la page est ouverte :
  - **dans WeChat** : autorisation de page web du compte de service (网页授权), qui exige un **compte de service (服务号) vérifié** ;
  - **sur ordinateur** : connexion par QR code (网站应用), qui exige un compte développeur **WeChat Open Platform** vérifié et une application « site web ».
- Le compte WeChat est rattaché une fois à la société du fournisseur, par l'opérateur ou par le QR de liaison déjà prévu pour les notifications (ADR 0005). Les deux accès partagent l'identifiant `unionid` si le compte de service et l'application site web sont liés au même compte Open Platform.
- Après la connexion, une fonction Edge vérifie le rattachement et délivre un **lien de dépôt signé** vers le seul dossier de la société, valable deux heures. La page envoie le fichier puis affiche le rapport d'import. Le fournisseur n'a ni mot de passe, ni accès au reste de la base.
- AppID et AppSecret WeChat sont des **secrets de fonction Edge** (tableau de bord Supabase), jamais dans le dépôt ni dans la page.

### En attendant la connexion WeChat

- L'opérateur dépose le fichier reçu par WeChat ou par e-mail dans le tableau de bord Supabase (Storage, dossier de la société), ou envoie au fournisseur un lien de dépôt signé.

## Conséquences

- Le dépôt fonctionne dès l'application de la migration et le déploiement de la fonction Edge ; la connexion WeChat dépend de la vérification des comptes WeChat, à mener au nom de la société dédiée.
- La page de dépôt et les fonctions Edge appellent `*.supabase.co`, hébergé en Europe : la rapidité de l'envoi depuis la Chine est à mesurer (ADR 0006), comme pour le site.
- Les fichiers bruts des fournisseurs restent dans le compartiment privé, jamais dans le dépôt Git.
