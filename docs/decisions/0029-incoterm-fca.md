# 0029 — Incoterm des prix publics : FCA au lieu d'expédition, Incoterms® 2020

- Date : 2026-11-03
- Statut : acceptée (Bertier, 3 novembre 2026, sur l'analyse de Cowork) ; migration `20261103000028_incoterm_fca.sql` à appliquer à la main avant la fusion

## Contexte

Les prix publics sont en euros, hors transport, droits et TVA à l'import (ADR 0027, 0028). L'acheteur importe et dédouane lui-même. Les fournisseurs expédient de Hong Kong ou de Chine continentale, surtout en express ou en fret aérien. Il faut dire à l'acheteur, avec un terme standard, où et quand la marchandise lui est remise.

## Décision

- **Une seule règle pour toutes les sources : FCA au lieu d'expédition, Incoterms® 2020.** Le fournisseur dédouane la marchandise à l'export et la remet au transporteur désigné, choisi par l'acheteur ou par Central.Parts pour son compte. Le risque est transféré à la remise.
- Options écartées :
  - **EXW** : l'acheteur européen devrait gérer l'export en Chine ;
  - **DAP et CPT** : il faudrait chiffrer le transport ligne par ligne, alors que les prix sont hors transport.
- **Lieu** : il est déduit de la ville et du pays du fournisseur, sous forme d'un code court (`app.fca_place`) : HK, SZ, DG, GZ, SH, XM, ou le pays faute de ville reconnue (CN, TW…). Les pages l'affichent dans leur langue : « FCA Hong Kong », « FCA Shenzhen », « FCA 深圳 ».
- Ce lieu est affiché sur chaque offre (`/offres/`, `/recherche/`) et sur chaque ligne du panier. La consigne des prix dit « FCA au lieu d'expédition indiqué (Incoterms® 2020) », en FR, EN et 中文.
- `public_search`, `partner_offers` et `public_quote` renvoient `incoterm` (« FCA ») et `fca_place`.

## Conséquences

- Pour les brokers et le surplus, le lieu exact de remise est moins sûr : la ville du fournisseur est affichée et sera validée avec lui.
- FCA suppose que le fournisseur sait faire l'export. C'est probable pour un fabricant ou un distributeur, mais à vérifier pour un revendeur ou un broker.
- À faire après le 16 novembre 2026, avec la relecture juridique :
  - écrire dans la proforma qui choisit le transporteur (sinon le point de transfert du risque reste flou) ;
  - le transfert de propriété ;
  - un Incoterm différent si Central.Parts organise le transport (DAP).
- Pas encore dans l'API des plateformes : ajout des mêmes champs à décider avec Adesio, sans rupture de format.
- Libellés chinois (香港, 深圳, 发货地 FCA 交货) : à faire relire.
