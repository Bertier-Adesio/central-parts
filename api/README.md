# API Central.Parts

API publique par laquelle les canaux acheteurs (Adesio, Luminovo, CalcuQuote, ERP, site central.parts, sites partenaires) interrogent le réseau.

## Périmètre annoncé sur le site

- Recherche par référence fabricant et par nomenclature (BOM).
- Offres : stock, paliers de prix, délais, devise (EUR, USD, CNH, HKD, GBP, JPY).
- Demandes de cotation avec référence de suivi.
- Commandes et suivi jusqu'à la livraison.

## Carte actuelle

[`endpoints.md`](endpoints.md) liste les 75 endpoints et les 25 routes d'écran de la maquette vivante (`/app/`), avec les rôles autorisés et les étapes d'une transaction. Le fichier est généré depuis `site/app/js/registry.js` ; les règles métier sont implémentées en mémoire dans `site/app/js/api.js` (ADR 0003).

## API fournisseur

[`fournisseurs.md`](fournisseurs.md) : spécification v0 de l'API par laquelle les brokers et distributeurs poussent leur stock et reçoivent les demandes (ADR 0004), ses notifications WeChat, WeCom et e-mail (ADR 0005), et les connecteurs aux API produit des brokers, prioritaires (ADR 0006).

## Prochaines étapes

1. Dériver la spécification OpenAPI (`openapi.yaml`) de la carte des endpoints, avant tout code.
2. Stack : base PostgreSQL sur Supabase (UE) et API métier dans un service Node à part, proposées dans l'ADR 0007 ; schéma dans `supabase/`.
3. Définir l'authentification des partenaires (clé d'API par canal, quotas).
