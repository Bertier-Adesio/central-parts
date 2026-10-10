# API Central.Parts

API publique par laquelle les canaux acheteurs (Adesio, Luminovo, CalcuQuote, ERP, site central.parts, sites partenaires) interrogent le réseau.

## Périmètre annoncé sur le site

- Recherche par référence fabricant et par nomenclature (BOM).
- Offres : stock, paliers de prix, délais, devise (EUR, USD, CNY).
- Demandes de cotation avec référence de suivi.
- Commandes et suivi jusqu'à la livraison.

## Carte actuelle

[`endpoints.md`](endpoints.md) liste les 49 endpoints et les 22 routes d'écran de la maquette vivante (`/app/`), avec les rôles autorisés et les étapes d'une transaction. Le fichier est généré depuis `site/app/js/registry.js` ; les règles métier sont implémentées en mémoire dans `site/app/js/api.js` (ADR 0003).

## Prochaines étapes

1. Dériver la spécification OpenAPI (`openapi.yaml`) de la carte des endpoints, avant tout code.
2. Choisir la stack (ADR).
3. Définir l'authentification des partenaires (clé d'API par canal, quotas).
