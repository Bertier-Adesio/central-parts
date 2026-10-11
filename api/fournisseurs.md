# API fournisseur

Spécification v0 de l'API par laquelle un fournisseur (broker, distributeur, détenteur de surplus, fabricant) pousse son stock vers Central.Parts et reçoit les demandes qui le concernent. Implémentation simulée : `site/app/js/api.js`, écran vendeur « Intégration API » de la maquette (`/app/#/vendeur/api`). Décision : [ADR 0004](../docs/decisions/0004-api-fournisseur.md).

L'API est le canal recommandé. Les fichiers CSV ou XLS (`POST /v1/stocklists`) et le dépôt SFTP restent disponibles en repli ([`data/formats.md`](../data/formats.md)).

## Principes

- **Base** : `https://api.central.parts/v1` (prévu). JSON en UTF-8, dates ISO 8601, montants en nombres décimaux.
- **Authentification** : `Authorization: Bearer <clé>`. Une clé par société et par environnement (`cp_test_…`, `cp_live_…`), créée par `POST /v1/organizations/{id}/api-keys`. Le secret n'est affiché qu'une fois. La clé de production exige un KYB validé.
- **Clé métier : le SKU du fournisseur**. Il doit rester stable dans le temps : c'est lui qui permet de mettre à jour une offre plutôt que d'en créer une nouvelle.
- **Mise à jour partielle** : un champ absent conserve sa valeur ; `quantity` est toujours obligatoire.
- **Idempotence** : en-tête `Idempotency-Key` sur les écritures ; un même appel rejoué dans les 24 h renvoie la même réponse sans double effet.
- **Limites prévues** : 1 000 offres par appel en masse, 60 appels par minute et par clé, soit 3,6 millions d'offres par heure ; un stock de 500 000 lignes se synchronise en une dizaine de minutes. Au-delà, ou pour un instantané complet, SFTP.
- **Anonymat** : rien de ce que le fournisseur envoie n'est montré à l'acheteur sous son nom ; `product_url` ne sert qu'au contrôle interne. Les événements reçus par le fournisseur ne contiennent jamais l'identité ni l'adresse de l'acheteur.

## Endpoints

| Méthode | Chemin | Rôle |
|---|---|---|
| `POST` | `/v1/organizations/{id}/api-keys` | Créer une clé (`environment` : `test` ou `live`) |
| `GET` | `/v1/organizations/{id}/api-keys` | Lister les clés (préfixe seulement) |
| `POST` | `/v1/supplier/offers/bulk` | Créer ou mettre à jour jusqu'à 1 000 offres |
| `PUT` | `/v1/supplier/offers/{sku}` | Créer ou mettre à jour une offre |
| `DELETE` | `/v1/supplier/offers/{sku}` | Retirer une offre vendue ailleurs (quantité à zéro, historique conservé) |
| `GET` | `/v1/supplier/offers?sku=&updated_since=` | Lire ses offres, réconcilier |
| `POST` | `/v1/supplier/webhooks` | S'abonner à des événements |
| `GET` | `/v1/supplier/webhooks` | Abonnements et dernières livraisons |

Une fois une demande reçue, le fournisseur enchérit avec les endpoints communs : `GET /v1/demands/{id}`, `POST /v1/demands/{id}/bids` (`lotId`, `net`, `currency`, `dateCode`, `leadDays`), `GET /v1/demands/{id}/bids/mine`. Le date code est obligatoire à ce moment s'il manque au lot ; il est alors reporté sur le lot. Carte complète : [`endpoints.md`](endpoints.md).

## L'offre

| Champ | Type | Obligatoire | Description |
|---|---|---|---|
| `sku` | texte | Oui | Référence interne du fournisseur, stable |
| `mpn` | texte | Oui | Référence fabricant |
| `manufacturer` | texte | Recommandé | Fabricant |
| `quantity` | entier ≥ 0 | Oui | Quantité disponible ; 0 retire l'offre |
| `unit_price` | décimal | Non | Prix unitaire catalogue |
| `currency` | ISO 4217 | Non | `EUR`, `USD`, `CNY` (`RMB` accepté), `HKD`, `GBP`, `JPY`, `TWD`, `SGD` ; devise par défaut de la société sinon |
| `price_breaks` | liste de `{quantity, price}` | Non | Paliers (10, 100, 1 000 pcs…) |
| `date_code` | texte | Non | Facultatif dans le stock ; donné au plus tard en répondant à une demande |
| `packaging` | texte | Non | Plateau, tube, bande et bobine, vrac |
| `country_of_origin` | ISO 3166 alpha-2 | Non | Pays d'origine |
| `lead_time_days` | entier | Non | Délai d'expédition en jours ouvrés |
| `product_url` | URL | Non | Fiche du fournisseur, usage interne |

Exemple :

```http
POST /v1/supplier/offers/bulk
Authorization: Bearer cp_live_…
Idempotency-Key: lot-2026-10-12-0001
Content-Type: application/json

{
  "offers": [
    {
      "sku": "HB-000187",
      "mpn": "XC2S100-5TQ144C",
      "manufacturer": "AMD Xilinx",
      "quantity": 600,
      "unit_price": 58.0,
      "currency": "USD",
      "price_breaks": [{ "quantity": 10, "price": 56.5 }, { "quantity": 100, "price": 54.0 }, { "quantity": 1000, "price": 51.0 }],
      "date_code": "2010",
      "packaging": "Plateau",
      "country_of_origin": "TW",
      "lead_time_days": 3
    }
  ]
}
```

Réponse `200` : les offres valides sont enregistrées même si d'autres sont en erreur.

```json
{ "received": 3, "created": 2, "updated": 0, "errors": [{ "index": 2, "sku": "HB-000999", "error": "mpn requis" }], "idempotency_key": "lot-2026-10-12-0001" }
```

## Devises

Le fournisseur fixe ses prix et enchérit dans sa devise (EUR, USD, CNY/RMB…) ; il est payé dans cette devise, de son prix net moins la commission vendeur. Central.Parts convertit en euros pour classer les offres et présenter à l'acheteur un prix tout compris en euros ; le compte dédié est tenu en euros. Source des taux, moment de la conversion et couverture du risque de change : à arbitrer avec l'établissement financier. La maquette utilise des taux fictifs.

## Webhooks

`POST /v1/supplier/webhooks` avec `{ "url": "https://…", "events": [...] }`. Central.Parts appelle l'URL en `POST`, signé HMAC-SHA256 avec le secret de l'abonnement (en-tête `CP-Signature: sha256=…`, horodatage `CP-Timestamp`). Réponse `2xx` attendue sous 10 s ; nouvelles tentatives avec délai croissant pendant 24 h.

| Événement | Quand | Contenu |
|---|---|---|
| `demand.created` | Une demande Opportunity correspond à une offre en stock | `demand_id`, `mpn`, `quantity`, `date_code_min`, `zone`, `closes_on` |
| `offer.accepted` | L'acheteur retient l'offre du fournisseur | `demand_id`, `transaction_id`, `lot_sku`, `quantity`, `net_unit_price`, `currency`, `date_code` |
| `transaction.updated` | Chaque étape de la transaction (signature, dépôt, expédition, laboratoire, inspection, paiement) | `transaction_id`, `status`, `text` |

## Bac à sable

Décidé pour les premiers brokers. Environnement isolé : `https://sandbox.api.central.parts/v1` (prévu), clés `cp_test_…` uniquement, mêmes endpoints, données fictives effacées chaque nuit, aucun argent réel ni banque réelle. Deux endpoints propres au bac à sable simulent l'acheteur :

| Méthode | Chemin | Effet |
|---|---|---|
| `POST` | `/v1/sandbox/demands` | Crée une demande d'un acheteur fictif sur une référence du stock du fournisseur (`mpn`, `quantity`) ; webhooks et notifications partent comme en production, avec `"sandbox": true` |
| `POST` | `/v1/sandbox/demands/{id}/accept` | Clôture la demande, retient l'offre du fournisseur et signe côté acheteur ; à la signature du fournisseur, le dépôt est simulé et l'expédition demandée |

Parcours de recette conseillé : pousser des offres, s'abonner aux webhooks ou à WeChat, simuler une demande, enchérir par l'API, simuler l'acceptation, signer, déclarer l'expédition.

## Notifications : e-mail, WeCom, WeChat

Pour un fournisseur sans intégration, ou en plus des webhooks, les mêmes événements sont envoyés sur des canaux de messagerie, dans la langue choisie (中文, English, Français). Écran vendeur « Notifications » de la maquette.

| Canal | Mise en place | Envoi par Central.Parts |
|---|---|---|
| Robot de groupe WeCom (企业微信) | Le vendeur ajoute un robot à son groupe (« 添加群机器人 ») et colle l'URL du webhook | `POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…`, message `markdown` |
| Compte de service WeChat (服务号) | Le vendeur scanne un QR code temporaire du compte de service Central.Parts ; l'événement `subscribe` ou `SCAN` rattache son openid au canal | Message modèle : `POST https://api.weixin.qq.com/cgi-bin/message/template/send` (`touser`, `template_id`, `url`, `data`) |
| E-mail | Adresse de l'équipe commerciale | SMTP |

Endpoints : `GET` et `POST /v1/organizations/{id}/notification-channels`, `DELETE …/{cid}`, `POST …/{cid}/test`, `POST /v1/wechat/qrcodes`, et `POST /v1/webhooks/wechat` pour les événements reçus de WeChat.

Exemple de message `demand.created` en chinois :

```
【Central.Parts 新询价】XC2S50-5TQ144C
型号：XC2S50-5TQ144C
数量：250
最低批号 (D/C)：2010
交货区域：中国 广东
报价截止：10月14日
买方信息已匿名，请在平台内报价。
立即报价 › https://central.parts/app/#/vendeur/demandes/DEM-0431
```

Le message ne contient jamais l'identité ni l'adresse de l'acheteur. Le bouton ouvre la demande sur la plateforme, où le vendeur répond (prix, devise, date code).

## Erreurs

| Code | Cas |
|---|---|
| `401` | Clé absente ou révoquée |
| `403` | KYB non validé, ou ressource d'une autre société |
| `404` | Offre ou ressource inconnue |
| `409` | Action impossible à l'étape en cours |
| `413` | Plus de 1 000 offres dans un appel |
| `422` | Donnée invalide (le corps précise le champ) |
| `429` | Limite d'appels atteinte (en-tête `Retry-After`) |

## Règles qui s'appliquent aux offres de broker

Toute offre de broker ou de surplus passe par les rails Opportunity : questionnaire d'état complet avant d'enchérir, date code au plus tard dans la réponse à la demande, paiement à l'acceptation des pièces. L'API alimente le stock ; elle ne dispense pas du questionnaire, qui se remplit une fois par lot (écran ou API à venir).

## À trancher

5. WeChat : compte de service vérifié au nom de Central.Parts (vérification d'une société étrangère possible, payante) ou passage par un partenaire en Chine ; modèles de message à faire approuver par WeChat.
6. Page de réponse en chinois, servie rapidement depuis la Chine (hébergement ou CDN avec licence ICP, ou mini-programme WeChat pour répondre sans quitter WeChat).
7. Autres messageries : DingTalk (钉钉), Feishu (飞书) ; WhatsApp pour d'autres pays.

1. Questionnaire d'état par API (même schéma que l'écran) ou modèle par défaut par fournisseur, appliqué à tous ses lots et modifiable lot par lot.
2. Instantané complet par API (les SKU absents sont retirés) ou seulement par SFTP.
4. Clients de référence fournis (exemples Python et Node) pour les premiers brokers.
