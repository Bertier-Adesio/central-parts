# 0029 — Incoterm et conditions de livraison des prix publics (Incoterms® 2020)

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

### Règle de Central.Parts : livraison, retours, garantie (complément du 3 novembre 2026, migration `20261103000029`)
- Décision de Bertier : « on crée notre propre règle en s'inspirant de » celle d'un distributeur partenaire de Hong Kong. Ce distributeur livre en express jusqu'à l'acheteur, droits et taxes à la charge de celui-ci, et offre la livraison au-delà d'un montant de commande.
- **Elle remplace FCA comme règle par défaut** pour toutes les offres :
  - **DAP, à l'adresse de livraison de l'acheteur** : livraison express (DHL, FedEx, UPS ou SF) ; droits, taxes et frais de dédouanement à la charge de l'acheteur ;
  - **livraison offerte au-delà de 2 000 €** par envoi d'un même fournisseur, sinon chiffrée sur la facture proforma ;
  - expédition sous 48 heures, acheminement en 5 à 7 jours ouvrés, paiement d'avance ;
  - retours sous 30 jours pour défaut qualité, 15 % de frais de remise en stock en cas d'erreur de commande, garantie de 90 jours.
- La règle est gardée en base, dans `app.settings` « default_terms » (JSON), et se règle sans code. Avec la valeur `{}`, on revient à FCA au lieu d'expédition, transport sur la proforma.
- **Exception pour un fournisseur** : une ligne dans `app.seller_terms`, saisie par l'opérateur et **jamais dans le dépôt**, remplace la règle pour ses offres.
- Affichage :
  - sur l'offre : « DAP adresse de livraison » et « Livraison offerte dès … » ;
  - dans le panier : un bloc « Livraison » par fournisseur (numéroté, jamais nommé) qui indique la livraison offerte ou le montant manquant, puis les conditions ;
  - la phrase sur les prix dit « Incoterm indiqué sur chaque offre (Incoterms® 2020) ».
- **Les chiffres (seuil, délais, retours, garantie) sont des conditions commerciales à valider** avec la relecture juridique après le 16 novembre 2026. Ils sont affichés à titre d'information jusque-là.

### Piste pour les rails Opportunity (après le 16 novembre 2026)
- Les plateformes de séquestre du marché font régler à la main, en texte libre, ce qu'un Incoterm fixerait : qui paie le transport, l'assurance et les droits ; transporteur et compte transporteur ; délai ; conditions de retour.
- Pour la fiche transaction Opportunity : une liste d'Incoterms 2020 avec lieu nommé obligatoire, complétée par le transporteur, le compte transporteur, le délai d'expédition et les conditions de retour. À concevoir avec la relecture juridique du paiement à l'acceptation.

## Conséquences

- Pour les brokers et le surplus, le lieu exact de remise est moins sûr : la ville du fournisseur est affichée et sera validée avec lui.
- FCA suppose que le fournisseur sait faire l'export. C'est probable pour un fabricant ou un distributeur, mais à vérifier pour un revendeur ou un broker.
- À faire après le 16 novembre 2026, avec la relecture juridique :
  - écrire dans la proforma qui choisit le transporteur (sinon le point de transfert du risque reste flou) ;
  - le transfert de propriété ;
  - un Incoterm différent si Central.Parts organise le transport (DAP).
- Pas encore dans l'API des plateformes : ajout des mêmes champs à décider avec Adesio, sans rupture de format.
- Libellés chinois (香港, 深圳, 发货地 FCA 交货) : à faire relire.
