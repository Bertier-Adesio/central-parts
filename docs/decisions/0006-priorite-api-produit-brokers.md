# 0006 — Priorité aux brokers dotés d'une API produit interrogeable

- Date : 2026-10-11
- Statut : acceptée

## Contexte

Les brokers transmettent leur stock de trois façons possibles : fichier (CSV, XLS, SFTP), envoi vers l'API fournisseur de Central.Parts (ADR 0004), ou API produit à eux que Central.Parts peut interroger. Un stock de 500 000 lignes copié chez Central.Parts vieillit vite : une pièce vendue ailleurs reste visible, une demande peut viser un stock qui n'existe plus. Le stocker coûte aussi en infrastructure.

## Décision

- **Priorité commerciale et technique aux brokers qui ont une API produit interrogeable** (recherche par référence fabricant).
- À chaque demande Opportunity, Central.Parts **interroge en direct** l'API des brokers vérifiés connectés sur la référence demandée. Un broker dont l'API a la pièce reçoit la demande, même si ce stock n'a jamais été envoyé à Central.Parts.
- Central.Parts ne garde qu'un **instantané** des lots concernés (référence, quantité, prix, devise, date code, SKU), figé ensuite dans l'offre et la transaction comme preuve.
- Ordre des canaux : 1. API produit du broker (connecteur), 2. envoi vers l'API fournisseur, 3. fichiers et SFTP.
- Un connecteur est déclaré (URL de base HTTPS, chemin de recherche avec `{mpn}`, authentification), testé avec le broker, puis activé. Une panne de l'API du broker n'empêche pas la diffusion de la demande aux autres vendeurs ; elle est journalisée.
- Seuls les brokers au statut « vérifié » (KYB et abonnement à jour) sont interrogés.
- Implémentation simulée dans la maquette : `site/app/js/api.js` (`queryConnectors`), écrans `#/vendeur/api` et `#/ops/connecteurs`.

## Conséquences

- Moins de données à stocker : la base garde les connecteurs, les instantanés et les transactions, pas l'intégralité des stocks des brokers connectés.
- La recherche publique ne montre que le stock stocké (poussé ou importé) ; le stock des API n'apparaît qu'à la demande. À trancher : interroger aussi les API à la recherche, avec cache court.
- Il faut un module de connecteurs (correspondance des champs par broker, gestion des clés, limites d'appels, temps de réponse, alertes de panne) et des critères d'éligibilité : temps de réponse, disponibilité, champs fournis.
