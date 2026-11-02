# API Central.Parts

API publique par laquelle les canaux acheteurs (Adesio, Luminovo, CalcuQuote, ERP, site central.parts, sites partenaires) interrogent le réseau. Central.Parts y est une **API fournisseur unique** qui agrège tous ses fournisseurs sans jamais les nommer ([ADR 0011](../docs/decisions/0011-api-fournisseur-unique.md)).

## Périmètre annoncé sur le site

- Recherche par référence fabricant et par nomenclature (BOM).
- Offres : stock, paliers de prix, délais, devise (EUR, USD, CNH, HKD, GBP, JPY).
- Demandes de cotation avec référence de suivi.
- Commandes et suivi jusqu'à la livraison.

## Carte actuelle

[`endpoints.md`](endpoints.md) liste les 75 endpoints et les 25 routes d'écran de la maquette vivante (`/app/`), avec les rôles autorisés et les étapes d'une transaction. Le fichier est généré depuis `site/app/js/registry.js` ; les règles métier sont implémentées en mémoire dans `site/app/js/api.js` (ADR 0003).

## API des plateformes : route RFQ

[`plateformes.md`](plateformes.md) : guide d'intégration des plateformes de chiffrage (Adesio d'abord) : RFQ de 1 à 50 lignes, validation par un administrateur avant toute diffusion, réponse des fournisseurs dans WeChat sous 48 h, offres consolidées tout compris, webhooks signés, bac à sable ([ADR 0023](../docs/decisions/0023-route-rfq-plateformes-validation-wechat.md)). Servie par la fonction Edge `rfq`, avec le contrat du futur service API.

## API fournisseur

[`fournisseurs.md`](fournisseurs.md) : spécification v0 de l'API par laquelle les brokers et distributeurs poussent leur stock et reçoivent les demandes (ADR 0004), ses notifications WeChat, WeCom et e-mail (ADR 0005), et les connecteurs aux API produit des brokers, prioritaires (ADR 0007).

## Prochaines étapes

1. Dériver la spécification OpenAPI (`openapi.yaml`) de la carte des endpoints, en commençant par l'API d'offres de l'ADR 0011 (chiffrage : stock, paliers de prix tout compris, délais, catégorie de source) et la route RFQ déjà servie (`plateformes.md`).
2. Stack : base PostgreSQL sur Supabase (UE) et API métier dans un service Node à part, proposées dans l'ADR 0008 ; schéma dans `supabase/`.
3. Authentification des partenaires : une clé d'API par client (Adesio d'abord), quotas et journal des appels (ADR 0011) : en place pour la route RFQ (`rfq_auth`, 60 appels par minute, `tools/create-api-key.mjs`).
