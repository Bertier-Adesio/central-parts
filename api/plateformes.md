# API des plateformes : offres en direct et route RFQ

Guide d'intégration pour les plateformes de chiffrage et d'achat (Adesio d'abord, puis Luminovo, CalcuQuote, ERP) qui envoient des demandes de prix (RFQ) à Central.Parts. Décision : [ADR 0023](../docs/decisions/0023-route-rfq-plateformes-validation-wechat.md). Implémentation : fonction Edge `rfq` (`supabase/functions/rfq/`), règles en base (migration `20261102000020_route_rfq.sql`).

Deux usages, même clé, mêmes règles :

1. **Offres en direct** ([ADR 0024](../docs/decisions/0024-api-offres-en-direct-formats-compatibles.md)) : à chaque recherche ou nomenclature, la plateforme interroge Central.Parts comme l'API produit d'un distributeur et affiche stock, paliers et délai. Formats natif, compatible DigiKey ou compatible TI.
2. **Route RFQ** (ci-dessous) : pour une offre « sur demande » ou une référence absente, une demande de prix aux fournisseurs, réponse sous 48 h.

Central.Parts y est **un fournisseur unique** : la plateforme ne voit jamais le fournisseur, et le fournisseur ne voit jamais la plateforme ni l'acheteur. Les noms de fabricants sont donnés, les fournisseurs sont masqués.

## Offres en direct

| Méthode | Chemin | Rôle |
|---|---|---|
| `GET` | `/v1/offers?mpn=&manufacturer=&qty=&currency=&source_category=` | Offres pour une référence (exacte, espaces ignorés), triées par prix |
| `POST` | `/v1/offers/search` | Nomenclature : `{ "currency"?, "lines": [{ "line_id", "mpn", "manufacturer"?, "quantity"? }] }`, 500 lignes au plus |
| `GET` | `/v1/offers/{offer_id}?qty=&currency=` | Une offre (`cpo_…`) et son prix à la quantité ; `404` si elle n'est plus publiée, `422` sous le MOQ |
| `GET` | `/v1/manufacturers?q=` | Fabricants présents dans le stock |
| `GET` | `/compat/digikey/products/v4/search/{mpn}/productdetails` | Format compatible DigiKey (devise : en-tête `X-DIGIKEY-Locale-Currency`, USD par défaut) |
| `GET` | `/compat/digikey/products/v4/search/{mpn}/pricing?excludeMarketplace=&inStock=` | Format compatible DigiKey ProductPricing (`ProductPricings[].ProductVariations[].StandardPricing[]`) ; `excludeMarketplace=true` écarte les offres de broker et de surplus |
| `POST` | `/compat/digikey/products/v4/search/keyword` | Format compatible DigiKey : `{ "Keywords": "<référence>", "Limit"?, "Offset"? }` |
| `GET` | `/compat/ti/v2/store/products/{mpn}?currency=USD` | Format compatible TI store |

Réponse de `GET /v1/offers?mpn=NE555DR&qty=2000` (valeurs fictives) :

```json
{
  "mpn": "NE555DR", "quantity": 2000, "currency_requested": null,
  "offers": [
    {
      "offer_id": "cpo_5f0c2a9e41d7b3a08c6e", "mpn": "NE555DR", "manufacturer": "Texas Instruments",
      "source_category": "broker_surplus", "price_status": "priced", "stock": 5000, "moq": 100, "order_multiple": 1,
      "currency": "USD",
      "price_breaks": [ { "quantity": 100, "price": 0.22 }, { "quantity": 1000, "price": 0.198 }, { "quantity": 5000, "price": 0.165 } ],
      "quote": { "quantity": 2000, "unit_price": 0.198, "extended_price": 396.0, "covered": true },
      "lead_time_days": 3, "packaging": "Bande et bobine", "date_code": "2430", "ship_from": "HK",
      "datasheet_url": "https://…", "price_valid_until": "2026-11-03T10:00:00Z", "updated_at": "2026-11-02T08:12:00Z"
    },
    { "offer_id": "cpo_…", "source_category": "authorized_distributor", "price_status": "on_request", "stock": 300, "moq": 1, "price_breaks": [], "ship_from": "CN" }
  ]
}
```

- **Prix** : tout compris, aucune marge n'est ajoutée après. **Devise** : celle de l'offre (`currency`), sans conversion pour l'instant ; le paramètre `currency` sera appliqué quand la conversion sera ouverte.
- **Offre « sur demande »** : pas de prix ; la chiffrer par une RFQ (`POST /v1/demands`).
- **Formats compatibles** : une seule devise par réponse ; seules les offres dans cette devise (et les offres sur demande) y figurent. Correspondance :

| Natif | Compatible DigiKey | Compatible TI |
|---|---|---|
| `mpn` | `Product.ManufacturerProductNumber` | `tiPartNumber` |
| `manufacturer` | `Product.Manufacturer.Name` | — |
| `offer_id` | `ProductVariations[].DigiKeyProductNumber` | `centralParts.offerId` |
| `stock` | `ProductVariations[].QuantityAvailableforPackageType` (total : `Product.QuantityAvailable`) | `quantity` |
| `moq` | `ProductVariations[].MinimumOrderQuantity` | `minimumOrderQuantity` |
| `price_breaks[]` | `ProductVariations[].StandardPricing[]` (`BreakQuantity`, `UnitPrice`, `TotalPrice`) | `pricing[0].priceBreaks[]` (`priceBreakQuantity`, `price`) |
| `packaging` | `ProductVariations[].PackageType.Name` | `packageCarrier` |
| `source_category` | `ProductVariations[].MarketPlace` (vrai pour `broker_surplus`) et `CentralParts.sourceCategory` | `centralParts.sourceCategory` |
| `date_code`, `ship_from`, `lead_time_days`, `price_valid_until` | `ProductVariations[].CentralParts.*` | `centralParts.*` |
| fournisseur | `Supplier.Name` = « Central.Parts » | — |

Le format compatible DigiKey reprend la structure d'une réponse réelle de ProductPricing (v4), vérifiée par `tools/test-catalog.mjs` (`tools/fixtures/digikey-productpricing.json`) ; `ProductUrl` renvoie vers la recherche publique de Central.Parts, jamais vers le fournisseur. Le format compatible TI reprend la structure d'un exemple de la réponse « prix et stock » du TI store, en camelCase (`tools/fixtures/ti-product.json`), pas encore d'une capture réelle ; `buyNowUrl` renvoie vers la recherche publique de Central.Parts. La fiche produit TI `/v1` (PascalCase, que les connecteurs rangent sous `productInformation`) n'est pas servie.

## Cycle d'une RFQ

```
Plateforme                 Central.Parts                   Administrateur          Fournisseur (WeChat)
POST /v1/demands  ──────►  DEM-… pending_validation  ───►  fiche dans WeChat
                                                     ◄───  approve / reject
                           open : fournisseurs prévenus ───────────────────────►  报价 / 无货, sous 48 h
                           clôture, offres tout compris ◄──────────────────────
webhook demand.offers_ready ◄──
GET /v1/demands/{id}/offers
```

1. La plateforme envoie une RFQ de 1 à 50 lignes. Chaque ligne devient une demande `DEM-…`, statut `pending_validation`. **Rien n'est envoyé aux fournisseurs avant la validation d'un administrateur Central.Parts.**
2. Validée, la demande passe à `open` : les fournisseurs dont le stock correspond sont prévenus dans WeChat. Refusée, elle passe à `rejected` avec un motif.
3. Chaque fournisseur a **48 heures** après la réception du message pour répondre. Une réponse tardive est refusée.
4. Quand tous ont répondu ou que le délai est passé, Central.Parts consolide les offres : `offers_ready` (au moins une offre) ou `no_offer`.

Statuts vus par la plateforme : `pending_validation`, `rejected`, `open`, `offers_ready`, `no_offer`, `ordered`, `cancelled`.

## Accès

- **Adresse de base actuelle** : `https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/rfq` suivie des chemins ci-dessous, par exemple `…/functions/v1/rfq/v1/demands`. **Adresse prévue** : `https://api.central.parts` (mêmes chemins, même contrat).
- **Authentification** : `Authorization: Bearer cp_live_…` (production) ou `cp_test_…` (bac à sable). Une clé par client, remise par Central.Parts par un canal sûr ; seule son empreinte est gardée. Une clé `cp_test_` ne sert qu'au bac à sable.
- **Limites** : 60 appels par minute et par clé par défaut, réglable par clé (un connecteur qui interroge une référence par appel a besoin de plus) (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` sur chaque réponse ; `429` avec `Retry-After` au-delà) ; 50 lignes par RFQ ; 50 demandes en attente de validation par client.
- JSON en UTF-8, dates ISO 8601, montants en nombres décimaux.

## Endpoints de la route RFQ

| Méthode | Chemin | Rôle |
|---|---|---|
| `POST` | `/v1/demands` | Envoyer une RFQ (en-tête `Idempotency-Key` obligatoire) → `202` |
| `GET` | `/v1/demands` | Demandes du client ; filtres `status`, `customer_reference`, `created_since` (100 au plus) |
| `GET` | `/v1/demands/{id}` | Détail et statut ; `rejected_reason` si refusée |
| `POST` | `/v1/demands/{id}/cancel` | Annuler, tant qu'aucune offre n'est acceptée |
| `GET` | `/v1/demands/{id}/offers` | Offres consolidées, une fois `offers_ready` |
| `POST` | `/v1/webhooks` | S'abonner à des événements ; secret de signature affiché une seule fois |
| `GET` | `/v1/webhooks` | Abonnements et cinq dernières livraisons |
| `DELETE` | `/v1/webhooks/{id}` | Supprimer un abonnement |
| `GET` | `/v1/me` | Client et clé appelants |
| `GET` | `/v1/health` | État du service |
| `POST` | `/v1/sandbox/demands/{id}/approve` | Bac à sable : simule la validation |
| `POST` | `/v1/sandbox/demands/{id}/respond` | Bac à sable : simule la réponse du fournisseur de test |

### Envoyer une RFQ

```http
POST /v1/demands
Authorization: Bearer cp_test_XXXXXXXX
Idempotency-Key: ads-bom-4711-v1
Content-Type: application/json

{
  "customer_reference": "ADS-4711",
  "currency": "EUR",
  "ship_to_country": "DE",
  "lines": [
    { "line_id": "L1", "mpn": "NE555DR", "manufacturer": "Texas Instruments", "quantity": 2000, "date_code_min": "2420" },
    { "line_id": "L2", "mpn": "LM358DR", "quantity": 500, "lead_days_max": 10, "target_price": 0.12 }
  ]
}
```

| Champ | Obligatoire | Description |
|---|---|---|
| `customer_reference` | Non | Référence libre de la plateforme ; renvoyée dans les webhooks, **jamais transmise au fournisseur** |
| `currency` | Oui | EUR, USD, CNH, HKD, GBP ou JPY (CNY et RMB enregistrés en CNH) : devise des offres rendues |
| `ship_to_country` | Oui | Pays de livraison, ISO 3166 alpha-2 ; seule information de livraison donnée au fournisseur |
| `lines[].line_id` | Recommandé | Identifiant de la ligne chez la plateforme, repris dans la réponse et les webhooks |
| `lines[].mpn` | Oui | Référence fabricant |
| `lines[].manufacturer` | Non | Fabricant ; s'il est donné, seuls les lots de ce fabricant sont retenus |
| `lines[].quantity` | Oui | Entier ≥ 1 |
| `lines[].date_code_min` | Non | Date code minimum (AASS, par exemple 2420) |
| `lines[].packaging` | Non | Conditionnement souhaité |
| `lines[].lead_days_max` | Non | Délai maximum en jours |
| `lines[].target_price` | Non | Prix cible ; **non transmis au fournisseur** |

Réponse `202` :

```json
{ "rfq_id": "RFQ-0012", "demands": [ { "line_id": "L1", "id": "DEM-1042", "status": "pending_validation" }, { "line_id": "L2", "id": "DEM-1043", "status": "pending_validation" } ] }
```

Idempotence : le même appel rejoué dans les 24 h (même `Idempotency-Key`, même corps) renvoie la même réponse sans rien créer ; la même clé avec un autre corps renvoie `409`.

### Offres consolidées

```json
{
  "demand_id": "DEM-1042",
  "status": "offers_ready",
  "currency": "EUR",
  "offers": [
    {
      "offer_id": "OFF-3007", "rank": 1, "mpn": "NE555DR", "manufacturer": "Texas Instruments",
      "source_category": "broker_surplus", "price_status": "priced", "quantity": 2000, "stock": 25000,
      "currency": "EUR", "unit_price": 0.1012, "extended_price": 202.4, "lead_time_days": 3,
      "date_code": "2430", "packaging": "Bande et bobine", "ship_from": "HK",
      "price_valid_until": "2026-11-12T09:00:00Z"
    }
  ]
}
```

- `unit_price` est **tout compris** : aucune marge n'est ajoutée après. Pour une offre `broker_surplus`, le détail (prix d'achat converti, commission, frais) est remis à la commande.
- `source_category` : `manufacturer`, `authorized_distributor` ou `broker_surplus` ; une offre de broker n'est jamais présentée comme agréée.
- Jamais dans la réponse : le nom du fournisseur, son pseudonyme, son SKU, son lot, un lien vers sa fiche, son prix d'achat.
- Une offre disparaît de la liste après `price_valid_until`.

## Webhooks

```http
POST /v1/webhooks
{ "url": "https://plateforme.example/central-parts", "events": ["demand.validated", "demand.rejected", "demand.offers_ready", "demand.no_offer"] }
```

Réponse `201` : `{ "id": "WHK-0003", "url": "…", "events": [...], "signing_secret": "whsec_…" }`. **Le secret n'est affiché qu'une fois.**

| Événement | Quand |
|---|---|
| `demand.validated` | La RFQ est validée ; les fournisseurs sont prévenus |
| `demand.rejected` | La RFQ est refusée ; `rejected_reason` donne le motif |
| `demand.offers_ready` | Des offres consolidées sont disponibles ; `offers_count` |
| `demand.no_offer` | Aucun fournisseur n'a répondu avec un prix, ou aucun ne correspondait |
| `offer.expired` | Réservé (pas encore émis) |

Contenu : `{ "event", "occurred_at", "sandbox", "rfq_id", "demand_id", "line_id", "customer_reference", "status", "rejected_reason"?, "offers_count"? }`.

Signature : Central.Parts appelle l'URL en `POST` avec `CP-Timestamp` (secondes Unix) et `CP-Signature: sha256=<hex>`, où `<hex>` = HMAC-SHA256(secret, `CP-Timestamp + "." + corps brut`). Refuser un horodatage de plus de 5 minutes. Réponse `2xx` attendue sous 10 s ; sinon, nouvelles tentatives avec un délai croissant (1, 2, 4… minutes, 2 h au plus) pendant 24 h. Exemple de vérification (Node) :

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
const ok = (secret, rawBody, ts, sig) =>
  Math.abs(Date.now() / 1000 - Number(ts)) <= 300 &&
  timingSafeEqual(Buffer.from(sig), Buffer.from('sha256=' + createHmac('sha256', secret).update(ts + '.' + rawBody).digest('hex')));
```

## Erreurs

Corps : `{ "error": { "code", "message", "field"? } }`.

| Statut | `code` | Cas |
|---|---|---|
| `401` | `unauthorized` | Clé absente, mal formée, révoquée, ou d'un autre environnement |
| `403` | `forbidden` | Clé sans la portée `demands:write`, endpoint de bac à sable avec une clé `cp_live_` |
| `404` | `not_found` | Demande ou abonnement inconnu, ou d'un autre client |
| `409` | `conflict` | `Idempotency-Key` rejouée avec un autre corps, annulation impossible à ce statut |
| `422` | `invalid` | Donnée invalide ; `field` précise le champ (`lines[L1].quantity`, `currency`…) |
| `429` | `rate_limited` | Plus de 60 appels par minute, ou plus de 50 demandes en attente ; `Retry-After` en secondes |

## Bac à sable (offres en direct et RFQ)

Avec une clé `cp_test_`, tout le cycle se teste seul, sans aucun message WeChat et sans fournisseur réel :

0. `GET /v1/offers?mpn=NE555DR` (ou un format compatible) : offre du fournisseur de test, en direct ;
1. `POST /v1/demands` (références du fournisseur de test : `NE555DR`, `LM358DR`, `STM32F103C8T6`, `GRM188R71H104KA93D`) ;
2. `POST /v1/sandbox/demands/{id}/approve` : la demande passe à `open` (webhook `demand.validated`) ;
3. `POST /v1/sandbox/demands/{id}/respond` avec `{ "kind": "quote", "price": 0.10, "currency": "USD", "lead_days": 3, "date_code": "2430" }` (ou `{ "kind": "decline" }`) : la demande est close (`offers_ready` ou `no_offer`, webhook) ;
4. `GET /v1/demands/{id}/offers`.

Les demandes du bac à sable portent `"sandbox": true` et ne sont jamais montrées à un fournisseur réel.

## Côté Central.Parts (pour mémoire)

- Validation : robot WeChat, en anglais (`rfq`, `rfq DEM-…`, `approve DEM-…`, `approve DEM-… only ORG-…,ORG-…`, `reject DEM-… motif`, `resend DEM-… [ORG-…]`, `rfq stats ORG-…`), ou back office (`/admin/rfq`). Rappel à l'administrateur après 24 h sans décision ; jamais de diffusion automatique.
- Fournisseur : message dans WeChat (chinois, puis anglais), réponse `报价 DEM-… prix devise délai date code [lot LOT-…]` ou `无货 DEM-…`, ou sur `/depot/`. Rappel à 36 h. Une réponse après 48 h est refusée et la demande comptée « non traitée » pour ce fournisseur ; un message qui n'a pas pu partir ne compte jamais contre lui.
- Diffusion aux fournisseurs réels fermée tant que `RFQ_WECHAT_OPEN` n'est pas `true`.
