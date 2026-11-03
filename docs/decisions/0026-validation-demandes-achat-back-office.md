# 0026 — Demandes de prix validées par l'administrateur, site web et API dans le même back office

- Date : 2026-11-03
- Statut : acceptée (Bertier, 3 novembre 2026) ; migration `20261103000024_validation_demandes_achat.sql` à appliquer à la main avant la fusion

## Contexte

Central.Parts reçoit des demandes de prix par deux routes :
- **le site web** : un acheteur choisit une offre sur `/recherche/` et envoie une demande d'achat (PR-…, ADR 0014) ;
- **l'API** : une plateforme de chiffrage envoie une RFQ (DEM-…, ADR 0023).

Pour les RFQ de l'API, rien n'est envoyé à un fournisseur sans la validation d'un administrateur (ADR 0023). Les demandes du site, elles, partaient directement chez le fournisseur, dans WeChat et dans son espace `/depot/`, sans que l'administrateur ne les voie avant. Le back office (ADR 0018) ne montrait aucune des deux.

Circuit voulu par Bertier : la demande arrive dans son back office, il la valide, elle passe dans l'espace du fournisseur avec une alerte WeChat, et le fournisseur répond dans WeChat ou dans son espace.

## Décision

### Même règle pour les deux routes
- Une demande d'achat du site arrive **« à valider »** (`pending_validation`). Le fournisseur ne la voit pas, dans `/depot/` comme dans WeChat, et ne peut pas y répondre.
- L'administrateur reçoit tout de suite la fiche dans WeChat (acheteur, TVA, livraison, prix des deux côtés), avec les commandes pour décider.
- **Validation** : la demande passe « transmise au fournisseur » (`submitted`), apparaît dans son espace, et ses contacts WeChat actifs reçoivent l'alerte habituelle (référence, quantité, son prix net, pays de livraison ; jamais l'acheteur).
- **Refus** : motif obligatoire, **interne** : il n'est montré ni à l'acheteur ni au fournisseur. L'acheteur voit « demande non retenue » sur sa page de suivi, avec l'adresse de contact.
- La décision se prend au même endroit pour les deux routes, au choix :
  - dans le back office, onglet **« Demandes »** : site web et API côte à côte, avec un compteur des demandes à valider ;
  - dans WeChat : `approve PR-…` / `reject PR-… motif`, comme `approve DEM-…` / `reject DEM-… motif`.
- Une seule décision par demande : la seconde, depuis l'autre canal, est refusée sans effet (`CP409`). La décision (date, auteur, motif) est gardée sur la demande et inscrite au journal des événements.
- Les demandes déjà envoyées aux fournisseurs avant la migration ne changent pas.

### Logique en base
- `decide_purchase_request` (robot, clé de service) et `admin_request_approve` / `admin_request_reject` / `admin_requests` (back office, jeton de l'administrateur, contrôle `app.require_admin`) appellent la même fonction.
- `supplier_requests` et `supplier_answer` ignorent les demandes à valider ou refusées.
- La fonction `order` ne prévient plus que les opérateurs à la création ; le message au fournisseur part de `admin` ou de `wechat-events` après la validation (`notifySupplierOfRequest`, texte unique dans `_shared/robot-texts.js`).

## Conséquences

- L'acheteur attend la validation avant que le fournisseur ne soit prévenu. Pendant electronica, chaque demande est validée par Bertier ; l'alerte WeChat arrive tout de suite et la validation se fait en un geste.
- Les textes de la page de suivi et du message de confirmation disent que Central.Parts vérifie la demande avant de la transmettre (FR, EN, 中文 ; chinois à faire relire).
- Remplace, dans l'ADR 0014, l'envoi immédiat au fournisseur. Réalise, dans l'ADR 0018, la phase 2 « demandes d'achat PR-… » pour la validation.
- À faire ensuite : panier (une demande à plusieurs lignes, même circuit), réponse du fournisseur et devis visibles dans le back office, validation automatique par règles (acheteur de confiance, montant), messages modèles WeChat pour lever la règle des 48 heures.
