# API Central.Parts

API publique par laquelle les canaux acheteurs (Adesio, Luminovo, CalcuQuote, ERP, site central.parts, sites partenaires) interrogent le réseau.

## Périmètre annoncé sur le site

- Recherche par référence fabricant et par nomenclature (BOM).
- Offres : stock, paliers de prix, délais, devise (EUR, USD, CNY).
- Demandes de cotation avec référence de suivi.
- Commandes et suivi jusqu'à la livraison.

## Prochaines étapes

1. Rédiger la spécification OpenAPI (`openapi.yaml`) avant tout code.
2. Choisir la stack (ADR).
3. Définir l'authentification des partenaires (clé d'API par canal, quotas).
