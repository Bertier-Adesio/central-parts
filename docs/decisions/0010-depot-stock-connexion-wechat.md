# 0010 — Dépôt des fichiers de stock et connexion des fournisseurs par WeChat

- Date : 2026-10-30
- Statut : proposée. Dépôt et transformation : en service. Connexion WeChat : implémentée et testée, **en pause** (30 octobre 2026) ; en attendant, l'opérateur dépose les fichiers reçus des fournisseurs. Reprise : AppID, domaine d'autorisation et secrets, voir `supabase/README.md`.

## Contexte

Un broker partenaire, en Chine, transmet son stock en fichiers CSV ou XLS. Il n'a pas d'API produit (ADR 0007) et ne poussera pas d'offres par l'API fournisseur (ADR 0004) à court terme. Il travaille sur WeChat et attend une page où il se connecte avec son compte WeChat pour déposer ses fichiers. L'hébergement OVH du site ne convient pas à ce dépôt : un seul compte FTP, qui sert au déploiement, 100 Mo, et un dossier `www/` public.

## Décision

### Dépôt et transformation (implémenté)

- Les fichiers vont dans un **compartiment privé Supabase**, `stock-imports`, un dossier par société : `<id de l'organisation>/<fichier>`. Formats CSV, XLS, XLSX, 50 Mo au plus par fichier.
- Chaque dépôt ouvre un **import** (`public.stock_imports`), suivi de bout en bout : reçu, en cours, terminé ou en échec, avec un rapport (lignes rejetées et motif, doublons possibles, lots sans date code).
- La **fonction Edge `import-stock`** lit le fichier, reconnaît les colonnes (format broker, Octopart, ECIA, comme la maquette et `data/formats.md`) et envoie les lignes par paquets à la base, qui crée ou met à jour les lots. Clé de mise à jour : le SKU du fournisseur, sinon référence et date code. Un fichier dont le nom contient « complet » remplace le stock précédent : les lots absents passent à quantité 0.
- Le stock devient interrogeable par l'**API REST de Supabase** : `POST /rest/v1/rpc/search_stock`. Elle renvoie l'offre Inventory et les disponibilités Opportunity des vendeurs vérifiés, agrégées par référence, sans identité ni prix du vendeur.
- Migration `20261030000003_depot_stock_fichiers.sql` ; lecture des fichiers testée par `tools/test-import.mjs`, base par `tools/test-db.sh`.

### Connexion par WeChat (implémentée)

- Central.Parts dispose d'un **compte de service (服务号) vérifié** : la page de dépôt `https://central.parts/depot/` (中文 par défaut, English) s'ouvre **dans WeChat**, sur téléphone ou dans WeChat pour ordinateur, et utilise l'autorisation de page web silencieuse (网页授权, `snsapi_base`) qui renvoie l'`openid` du fournisseur. Hors de WeChat, la page invite à l'ouvrir dans WeChat. La connexion par QR code sur un navigateur ordinaire (WeChat Open Platform, 网站应用) n'est pas retenue pour l'instant.
- **Rattachement** : l'opérateur crée une invitation pour la société (`select public.create_depot_invite('ORG-…')`, usage unique, 14 jours) et envoie le lien `https://central.parts/depot/?invite=<jeton>` sur WeChat. À la première connexion, l'`openid` est rattaché à la société (`wechat_identities`) ; ensuite le fournisseur se connecte sans lien. Révocation : `revoked_at` sur son identité.
- La **fonction Edge `depot`** échange le code WeChat contre l'`openid`, vérifie le rattachement, délivre un jeton de session signé (12 h) puis, à chaque envoi, un **lien de dépôt signé** vers le seul dossier de la société. La page envoie le fichier et affiche le rapport d'import (lignes rejetées comprises). Le fournisseur n'a ni mot de passe, ni accès au reste de la base.
- Le choix « stock complet » est explicite dans la page ; le nom du fichier est horodaté et réduit à des caractères sûrs.
- L'**AppSecret** WeChat et le secret de session sont des **secrets de fonction Edge**, jamais dans le dépôt ni dans la page ; l'AppID, public, figure dans la page.
- Migration `20261030000004_depot_wechat.sql`, fonction `supabase/functions/depot/`, page `site/depot/index.html`.

### En attendant la connexion WeChat

- L'opérateur dépose le fichier reçu par WeChat ou par e-mail dans le tableau de bord Supabase (Storage, dossier de la société), ou envoie au fournisseur un lien de dépôt signé.

## Conséquences

- Mise en service : configurer le domaine d'autorisation de page web du compte de service (`central.parts`, fichier de vérification `MP_verify_….txt` à la racine du site) et les secrets de la fonction ; voir `supabase/README.md`. Si WeChat exige une licence ICP pour ce domaine, il faudra un domaine ou un hébergement adaptés.
- Le compte de service s'appelle « Adesio Central.Parts » ; à sa création, la société dédiée devra le reprendre ou en ouvrir un.
- La page de dépôt et les fonctions Edge appellent `*.supabase.co`, hébergé en Europe : la rapidité de l'envoi depuis la Chine est à mesurer (ADR 0006), comme pour le site.
- Les fichiers bruts des fournisseurs restent dans le compartiment privé, jamais dans le dépôt Git.
