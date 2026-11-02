# 0024 — API d'offres en direct, formats compatibles DigiKey et TI

- Date : 2026-11-02
- Statut : proposée (migration 20261102000021 à appliquer après 20261102000020 ; fonction Edge `rfq` déployée à la fusion)

## Contexte

Sur Adesio, les autres fournisseurs ont une API produit (ou catalogue) interrogée en direct : pour chaque référence d'une nomenclature, la plateforme affiche leur stock, leurs paliers de prix et leur délai. Central.Parts doit apparaître de la même façon (ADR 0011 : une seule API fournisseur, qui agrège tous ses fournisseurs sans les nommer). La route RFQ (ADR 0023) couvre le prix « sur demande », en 48 heures ; il manquait la réponse immédiate. Décision de Bertier (2 novembre 2026) : les formats de référence sont ceux de **DigiKey** et de **Texas Instruments**, les plus répandus ; l'API montre les noms de fabricants et masque les fournisseurs.

## Décision

### Une API d'offres en direct, dans la fonction `rfq`
- `GET /v1/offers` (une référence), `POST /v1/offers/search` (nomenclature, 500 lignes), `GET /v1/offers/{offer_id}` (prix à la quantité), `GET /v1/manufacturers`. Même clé d'API, même bac à sable, mêmes en-têtes `X-RateLimit-*` que la route RFQ.
- Réponse en quelques millisecondes depuis la base : lots à jour (reconfirmés dans le délai, ADR 0021), quantité positive, fournisseur approuvé. Les API produit des brokers (connecteurs, ADR 0007) viendront s'y ajouter.
- Chaque offre : identifiant opaque `cpo_…` (stable pour un lot, ne révèle rien), référence, fabricant, catégorie de source (`manufacturer`, `authorized_distributor`, `broker_surplus`), stock, MOQ, paliers tout compris, prix à la quantité, délai, conditionnement, date code, pays d'expédition, fiche technique, validité du prix (24 h, jamais au-delà de la reconfirmation du lot). Jamais : fournisseur, pseudonyme, SKU, lien de sa fiche, prix net.
- Sans marge applicable ou sans prix : offre « sur demande » (`price_status: on_request`), qui se chiffre par une RFQ (ADR 0023).
- **Devise** : celle du lot, comme sur le site depuis le 2 novembre (la conversion sera traitée plus tard). Un réglage (`app.settings` `api_convert_currency`) convertit dans la devise demandée au taux de `public.currencies`, quand les taux seront tenus à jour.

### Formats compatibles, pour réutiliser un connecteur existant
- `GET /compat/digikey/products/v4/search/{mpn}/productdetails`, `GET …/{mpn}/pricing` et `POST /compat/digikey/products/v4/search/keyword` : forme de DigiKey Product Information v4 (`Product`, `ProductVariations`, `StandardPricing` avec `BreakQuantity`, `UnitPrice`, `TotalPrice`…). Une variante par offre ; `DigiKeyProductNumber` porte l'identifiant opaque ; `Supplier` vaut toujours Central.Parts ; `MarketPlace` vrai pour une offre de broker ou de surplus.
- `GET /compat/ti/v2/store/products/{mpn}?currency=` : forme du TI store (`tiPartNumber`, `quantity`, `pricing[].priceBreaks[]`…), meilleure offre chiffrée.
- Ces formats n'ont qu'une devise par réponse : sans conversion, ils ne gardent que les offres dans la devise demandée (USD par défaut) et les offres sur demande. Ce que ces formats ne prévoient pas (catégorie de source, date code, pays d'expédition, validité) est dans une extension `CentralParts` / `centralParts`.
- DigiKey : structure vérifiée sur une réponse réelle de ProductPricing transmise par Bertier le 2 novembre (test automatique de forme). TI : structure d'un exemple de la réponse « prix et stock » du store (camelCase), à remplacer par une capture réelle faite avec les identifiants tistore d'un client. La fiche produit TI `/v1` (PascalCase, fusionnée sous `productInformation` par les connecteurs) n'est pas servie, faute d'exemple. `ProductUrl` pointe vers la recherche publique de Central.Parts.

### Limite d'appels par clé
- Un connecteur « une référence par appel » dépasse vite 60 appels par minute sur une nomenclature : la limite se règle par clé (`api_keys.calls_per_minute`, `tools/create-api-key.mjs --calls-per-minute`).

### Compteur de consultations
- Chaque réponse qui contient une offre compte une consultation pour son fournisseur, par référence et par semaine (`app.offer_views`) ; aucune identité de l'appelant n'est gardée. Lecture par l'administrateur (`/admin/offer-views`). L'affichage au fournisseur (sur `/depot/`, récapitulatif WeChat) reste à décider : il montre la demande, ce qui peut pousser un fournisseur à monter son prix.

## Conséquences

- Migration 20261102000021, après 20261102000020.
- À valider avec Adesio en bac à sable : quel format son connecteur lit (natif, DigiKey ou TI), la devise, la limite d'appels.
- À trancher : conversion des devises dans l'API ; affichage du compteur au fournisseur ; durée de validité du prix (24 h retenues).
