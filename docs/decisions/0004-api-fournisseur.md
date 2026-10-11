# 0004 — API fournisseur en canal principal, fichiers en repli

- Date : 2026-10-10
- Statut : proposée ; ordre des canaux précisé par l'ADR 0006 (API produit du broker en priorité)

## Contexte

Les premiers brokers transmettent leur stock en CSV ou XLS, et en SFTP au-delà de 500 000 lignes. Un fichier quotidien laisse des offres périmées pendant des heures : une pièce vendue ailleurs reste visible, une enchère peut viser un stock qui n'existe plus. Le modèle SNO repose sur des flux à jour.

## Décision

- Central.Parts fournit une **API fournisseur** (spécification : `api/fournisseurs.md`) : clés par société et par environnement, création ou mise à jour en masse par SKU (1 000 offres par appel), mise à jour et retrait unitaires, lecture pour réconciliation, webhooks signés (`demand.created`, `offer.accepted`, `transaction.updated`).
- Le **SKU du fournisseur** est la clé métier des offres.
- Les fichiers CSV, XLS et le **SFTP restent proposés en repli**, avec le même modèle de lot et le même rapport d'import (`data/formats.md`).
- Les règles d'Opportunity ne changent pas : questionnaire d'état exigé avant d'enchérir, quel que soit le canal. Le date code est facultatif dans le stock et demandé au broker quand il répond à une demande.
- Chaque prix porte sa devise (EUR, USD, CNY/RMB…). Le vendeur est payé dans sa devise ; l'acheteur voit et paie dans la devise de son pays ; Central.Parts, qui a un compte dans chaque devise principale, fait la conversion entre ses comptes.
- La maquette implémente ces endpoints (`site/app/js/api.js`, écran `#/vendeur/api`) ; ils figurent dans `registry.js` et `api/endpoints.md`.

## Conséquences

- Les fournisseurs intégrés reçoivent les demandes en temps réel et peuvent enchérir par l'API.
- Il faudra une documentation publique, un bac à sable et une gestion des limites d'appels avant l'ouverture.
- Le choix de la stack de l'API (ADR à venir) doit tenir ces volumes : quelques millions d'offres par heure en pointe.
