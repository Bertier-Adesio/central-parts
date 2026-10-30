# 0014 — Achat par les visiteurs : demande d'achat, proforma et virement

- Date : 2026-10-31
- Statut : acceptée (la vente par Central.Parts en achat-revente, la TVA et les conditions de vente restent à valider par l'avocat et l'expert-comptable)

## Contexte

La recherche publique (ADR 0013) montre l'offre aux visiteurs du site. Il faut qu'ils puissent acheter, dès electronica 2026. Ce qui manque aujourd'hui : le compte dédié et le paiement à l'acceptation (rails Opportunity), qui attendent la banque et la validation juridique ; un prestataire de paiement par carte ; les conditions générales de vente.

## Décision

### Qui vend, qui achète

- **Central.Parts vend**, en achat-revente : il achète au fournisseur et revend à l'acheteur au prix tout compris. Il n'y a qu'une facture, et le fournisseur n'est jamais nommé (ADR 0011).
- **Seules des sociétés achètent.** L'acheteur donne le nom de la société, son numéro de TVA (Union européenne, Royaume-Uni, Suisse ou Norvège), un nom, un e-mail, le pays et l'adresse de livraison. Le numéro est vérifié auprès du service VIES de la Commission européenne. S'il est refusé, la demande est refusée ; si VIES ne répond pas, la demande est acceptée et marquée « non vérifiée ».
- **L'acheteur importe** et dédouane : droits et TVA à l'import (ADR 0013).

### Parcours

1. Sur `/recherche/`, l'acheteur clique sur « Acheter » pour une offre et saisit une quantité. Il voit le **prix unitaire et le total tout compris** pour cette quantité : palier atteint, conversion, marge. La quantité exacte du lot n'est jamais révélée ; si la demande dépasse le stock, il est prévenu que le fournisseur confirmera la quantité disponible.
2. Il envoie la **demande d'achat**, sans engagement. Il reçoit une référence `PR-…` et un **lien de suivi** personnel (`/recherche/commande/`). Seule l'empreinte de ce lien est gardée en base.
3. Le **fournisseur** est prévenu dans WeChat. Il voit la référence, la quantité, son prix net et le pays de livraison, jamais l'acheteur. Il confirme ou refuse dans WeChat (`确认 PR-…`, `无货 PR-…`) ou sur `/depot/`. Ces messages ne sont délivrés qu'aux comptes actifs dans les 48 dernières heures : la page `/depot/` et l'opérateur prennent le relais.
4. L'**opérateur** reçoit la fiche complète dans WeChat : acheteur, fournisseur, prix des deux côtés. Il envoie la **facture proforma** par e-mail, hors plateforme dans cette version. Il note chaque étape avec les commandes `发票`, `收款`, `发货` et `取消 PR-…`, qui correspondent à proforma envoyée, virement reçu, expédiée et annulée.
5. La vente est conclue à la réception du **virement**. Le fournisseur est payé et expédie ; l'acheteur suit chaque étape avec son lien.

Le prix est figé à la demande, des deux côtés : prix tout compris pour l'acheteur, prix net pour le fournisseur. Le lot retenu est le moins cher qui couvre la quantité dans l'offre choisie (même référence, catégorie de source et pays d'expédition).

Limite contre les abus : 5 demandes par heure et par adresse IP.

## Ce qui reste hors de cette version

- Le paiement en ligne (carte, prestataire de paiement) : il demandera un ADR, puisqu'il fait exception à la règle « aucun service tiers ».
- Le paiement à l'acceptation sur compte dédié (rails Opportunity) : il attend la banque et la validation juridique.
- L'envoi d'e-mails par la plateforme (accusé de réception, proforma) : l'opérateur écrit lui-même.
- Les conditions générales de vente : la case à cocher dit seulement que la demande est sans engagement, et que la vente est conclue à la réception du virement.

## Conséquences

- Migration `20261031000009_demandes_achat.sql`, fonction Edge `order`. Les commandes WeChat sont dans `wechat-events`, les demandes reçues sur `/depot/`. Pages `site/recherche/` (bouton « Acheter ») et `site/recherche/commande/` (suivi).
- Contrôles : `checks/06_achat.sql`, `tools/test-search-ui.mjs`, `tools/test-depot-ui.mjs`.
- Avant la première vente réelle : les marges (`app.price_rules`), le compte bancaire de réception, le modèle de proforma, et la validation juridique et fiscale de l'achat-revente.
