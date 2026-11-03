# 0030 — Adresses des acheteurs et des vendeurs, choix du transport, complétion d'adresses libre

- Date : 2026-11-03
- Statut : acceptée (Bertier, 3 novembre 2026) ; migration `20261103000030_adresses_transport.sql` à appliquer à la main avant la fusion

## Contexte

- Une demande d'achat ne portait qu'une adresse de livraison en texte libre.
- Les vendeurs n'avaient pas d'adresse d'expédition : le lieu FCA venait de la ville de la société.
- En DAP, c'est le vendeur (ou Central.Parts) qui choisit et paie le transporteur. Un acheteur qui veut utiliser son propre compte DHL, FedEx ou UPS (« freight collect ») relève de FCA.

## Décision

### Acheteur
- **Adresse de facturation** (pays et adresse) et **adresse de livraison**. La case « Livrer à l'adresse de facturation » est cochée par défaut.
- **Transport**, au choix :
  - **par Central.Parts** (DAP, adresse de livraison), avec un transporteur préféré facultatif (DHL, FedEx, UPS, SF) ;
  - **sur le compte transporteur de l'acheteur** (FCA au lieu d'expédition), avec le transporteur et le numéro de compte. La livraison offerte ne s'applique pas.
- Enregistré sur chaque ligne de la demande (`billing_*`, `transport_mode`, `carrier`, `carrier_account`). Visible dans le back office et dans l'avis WeChat aux opérateurs. Jamais montré au public ; le numéro de compte n'est pas transmis au fournisseur.

### Vendeur
- **Une ou plusieurs adresses d'expédition** (`public.seller_addresses`), dont une par défaut. Elles sont saisies par l'opérateur pour l'instant ; l'espace fournisseur viendra ensuite.
- Un lot peut être rattaché à l'une d'elles (`lots.ship_address_id`). Le lieu FCA affiché vient de l'adresse du lot, sinon de l'adresse par défaut, sinon de la société.
- Les acheteurs ne voient que le code du lieu (HK, SZ…), jamais l'adresse. Le back office montre les adresses dans la fiche du vendeur.

### Complétion d'adresses : Photon (OpenStreetMap)
- Pourquoi Photon :
  - moteur **libre** (Apache 2.0), conçu pour la complétion, sur les données **OpenStreetMap** (ODbL) ;
  - Nominatim interdit la complétion sur son instance publique ;
  - la BAN (adresse.data.gouv.fr) ne couvre que la France.
- **Appel côté serveur seulement** (`GET /order/address`, fonction `order`) : la page ne charge rien d'un tiers, condition de l'accès depuis la Chine (ADR 0006). Mêmes limites que la recherche publique.
- Instance publique de Komoot par défaut, pour un usage modéré. Une instance auto-hébergée se règle par la variable `ADDRESS_API`, sans changer le code.
- La complétion est facultative : sans réponse, la saisie libre reste possible. La mention « © contributeurs OpenStreetMap » s'affiche sous les suggestions.

## Conséquences

- Le texte saisi pour l'adresse est envoyé au service de complétion (Komoot GmbH, Allemagne, ou notre instance). À ajouter à la politique de confidentialité lors de la relecture juridique (après le 16 novembre 2026).
- À faire ensuite :
  - adresses structurées (rue, code postal, ville) pour les API des transporteurs ;
  - saisie des adresses d'expédition par les vendeurs dans `/depot/` ;
  - rattachement d'une adresse à l'import du fichier de stock ;
  - création des étiquettes par API (DAP sur le compte de Central.Parts, FCA sur le compte de l'acheteur).
