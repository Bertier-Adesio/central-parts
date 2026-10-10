# Carte des endpoints et des routes

> Fichier généré par `node tools/build-api-map.mjs` depuis `site/app/js/registry.js` : ne pas modifier à la main.

49 endpoints et 22 routes d'écran, implémentés en mémoire par la maquette vivante (`site/app/`, publiée sur `/app/`). C'est le contrat de départ de la future API : chemins, rôles autorisés et règles métier (`site/app/js/api.js`). Les données sont fictives.

## Conventions

- Préfixe `/v1` pour l'API de la plateforme ; `/bank/v1` désigne l'API attendue de l'établissement qui tient le compte dédié.
- Le rôle de l'appelant (session ou clé d'API de sa société) filtre les données : le vendeur ne voit jamais l'identité ni l'adresse de l'acheteur, l'acheteur ne voit que le pseudonyme du vendeur, le laboratoire ne voit que des pseudonymes.
- Les webhooks entrants (`/v1/webhooks/…`) sont signés par l'émetteur : banque, transporteur.
- Rôle « Système » : tâches planifiées et webhooks traités par la plateforme elle-même.
- Erreurs : `403` rôle non autorisé, `404` ressource absente ou hors du périmètre de l'appelant, `409` action impossible à l'étape en cours, `422` données invalides.

## Comptes et KYB

| Méthode | Chemin | Rôles | Rôle de l'endpoint | Écrans |
|---|---|---|---|---|
| POST | `/v1/organizations` | Public | Inscription d'une société (acheteur, vendeur ou laboratoire) | `/inscription` |
| GET | `/v1/organizations/{id}` | Acheteur, Vendeur, Laboratoire, Central.Parts | Fiche société ; pseudonyme seul pour les autres parties | Hors écran : intégration, webhook ou tâche |
| POST | `/v1/organizations/{id}/kyb` | Public, Acheteur, Vendeur, Laboratoire | Dépôt du dossier KYB : Kbis, bénéficiaires effectifs, signataires, IBAN autorisé | `/inscription` |
| GET | `/v1/organizations` | Central.Parts | Liste des sociétés, filtre par statut KYB | `/ops`, `/ops/kyb` |
| POST | `/v1/organizations/{id}/kyb/decision` | Central.Parts | Validation ou refus du KYB, contrôle des listes de sanctions | `/ops/kyb` |

## Recherche et catalogue

| Méthode | Chemin | Rôles | Rôle de l'endpoint | Écrans |
|---|---|---|---|---|
| GET | `/v1/search` | Public, Acheteur, Vendeur, Laboratoire, Central.Parts | Recherche par référence fabricant dans Inventory et Opportunity (vendeurs anonymes) | `/recherche` |
| GET | `/v1/pricing/advice` | Vendeur, Central.Parts | Fourchette de prix conseillée par Adesio pour une référence et une quantité | `/vendeur/demandes/:id` |

## Nomenclatures

| Méthode | Chemin | Rôles | Rôle de l'endpoint | Écrans |
|---|---|---|---|---|
| POST | `/v1/boms` | Acheteur | Dépôt d'une nomenclature : chaque ligne est affectée à Inventory ou à Opportunity | `/acheteur/nomenclature` |
| GET | `/v1/boms` | Acheteur, Central.Parts | Nomenclatures de l'acheteur | `/acheteur` |
| GET | `/v1/boms/{id}` | Acheteur, Central.Parts | Détail d'une nomenclature et répartition des lignes | `/acheteur/nomenclatures/:id` |

## Offre Inventory

| Méthode | Chemin | Rôles | Rôle de l'endpoint | Écrans |
|---|---|---|---|---|
| POST | `/v1/inventory/orders` | Acheteur | Commande des lignes Inventory (paiement classique, hors escrow) | `/acheteur/nomenclatures/:id` |
| GET | `/v1/inventory/orders` | Acheteur, Central.Parts | Commandes Inventory et leur suivi | `/acheteur` |

## Demandes et enchères (Opportunity)

| Méthode | Chemin | Rôles | Rôle de l'endpoint | Écrans |
|---|---|---|---|---|
| POST | `/v1/demands` | Acheteur | Création d'une demande Opportunity, anonymisée puis diffusée aux vendeurs dont le stock correspond | `/recherche`, `/acheteur/nomenclatures/:id` |
| GET | `/v1/demands` | Acheteur, Vendeur, Central.Parts | Demandes : les siennes (acheteur), celles qui correspondent à son stock (vendeur, anonymisées), toutes (ops) | `/acheteur`, `/vendeur`, `/ops`, `/ops/demandes` |
| GET | `/v1/demands/{id}` | Acheteur, Vendeur, Central.Parts | Détail d'une demande ; le vendeur ne voit ni l'acheteur ni l'adresse | `/acheteur/demandes/:id`, `/vendeur/demandes/:id` |
| POST | `/v1/demands/{id}/close` | Central.Parts, Système | Clôture de l'enchère et calcul des offres consolidées (net + marge + frais) | `/ops/demandes` |
| POST | `/v1/demands/{id}/bids` | Vendeur | Offre scellée du vendeur : lot, prix net, délai. Questionnaire du lot complet exigé | `/vendeur/demandes/:id` |
| GET | `/v1/demands/{id}/bids/mine` | Vendeur | Offre du vendeur et son rang, sans les offres concurrentes | `/vendeur/demandes/:id` |
| GET | `/v1/demands/{id}/offers` | Acheteur, Central.Parts | Offres consolidées, prix tout compris, questionnaire et documents | `/acheteur/demandes/:id`, `/ops/demandes` |
| POST | `/v1/offers/{id}/accept` | Acheteur | Choix d'une offre, du niveau de test et des délais : crée la fiche transaction | `/acheteur/demandes/:id` |

## Stock vendeur et questionnaire

| Méthode | Chemin | Rôles | Rôle de l'endpoint | Écrans |
|---|---|---|---|---|
| POST | `/v1/stocklists` | Vendeur | Import d'une stocklist (formats Octopart ou ECIA), dédoublonnage des lots | `/vendeur/stock` |
| GET | `/v1/lots` | Vendeur, Central.Parts | Lots du vendeur et état du questionnaire | `/vendeur`, `/vendeur/stock` |
| GET | `/v1/lots/{id}` | Vendeur, Central.Parts | Détail d'un lot | `/vendeur/lots/:id` |
| PUT | `/v1/lots/{id}/questionnaire` | Vendeur | Questionnaire d'état (13 questions) : les réponses engagent le vendeur | `/vendeur/lots/:id` |
| PUT | `/v1/lots/{id}/documents` | Vendeur | Documents qualité : photos, CoC, preuve d'achat, datasheet, rapport d'inspection | `/vendeur/lots/:id` |

## Transactions

| Méthode | Chemin | Rôles | Rôle de l'endpoint | Écrans |
|---|---|---|---|---|
| GET | `/v1/transactions` | Acheteur, Vendeur, Laboratoire, Banque, Central.Parts | Transactions de la partie appelante | `/acheteur`, `/vendeur`, `/banque`, `/ops` |
| GET | `/v1/transactions/{id}` | Acheteur, Vendeur, Laboratoire, Banque, Central.Parts | Fiche transaction, étape en cours, délais, documents, historique | `/acheteur/transactions/:id`, `/vendeur/transactions/:id`, `/ops/transactions/:id` |
| POST | `/v1/transactions/{id}/signatures` | Acheteur, Vendeur | Signature électronique de la fiche transaction | `/acheteur/transactions/:id`, `/vendeur/transactions/:id` |
| POST | `/v1/transactions/{id}/shipments` | Vendeur | Expédition sur ordre de Central.Parts : transporteur et numéro de suivi | `/vendeur/transactions/:id` |
| POST | `/v1/webhooks/carrier` | Système | Webhook transporteur : livraison à l'adresse désignée, ouvre le délai d'inspection | `/ops/transactions/:id` |
| POST | `/v1/transactions/{id}/inspection` | Acheteur | Acceptation ou rejet motivé, ligne par ligne, avec justificatifs | `/acheteur/transactions/:id` |
| POST | `/v1/transactions/{id}/returns` | Acheteur | Retour des pièces rejetées avec l'étiquette générée par la plateforme | `/acheteur/transactions/:id` |
| POST | `/v1/transactions/{id}/counter-inspection` | Vendeur | Contre-inspection du retour : acceptation ou contestation | `/vendeur/transactions/:id` |
| POST | `/v1/transactions/{id}/disputes` | Vendeur, Acheteur | Ouverture d'un litige : médiation par Central.Parts | `/acheteur/transactions/:id`, `/vendeur/transactions/:id` |
| POST | `/v1/disputes/{id}/decision` | Central.Parts | Issue de la médiation ou de l'expertise d'un laboratoire tiers | `/ops/transactions/:id` |

## Laboratoires

| Méthode | Chemin | Rôles | Rôle de l'endpoint | Écrans |
|---|---|---|---|---|
| GET | `/v1/lab/cases` | Laboratoire, Central.Parts | Dossiers de test du laboratoire | `/labo`, `/labo/dossiers/:id` |
| POST | `/v1/lab/cases/{id}/reception` | Laboratoire | Réception des pièces : quantité, état, photos | `/labo/dossiers/:id` |
| POST | `/v1/lab/cases/{id}/certificate` | Laboratoire | Résultats par test et certificat : conforme, non conforme ou contrefaçon | `/labo/dossiers/:id` |
| POST | `/v1/lab/cases/{id}/reshipment` | Laboratoire | Réexpédition à l'adresse de livraison désignée par l'acheteur | `/labo/dossiers/:id` |

## Compte dédié et ordres de paiement

| Méthode | Chemin | Rôles | Rôle de l'endpoint | Écrans |
|---|---|---|---|---|
| GET | `/v1/escrow` | Banque, Central.Parts | Compte dédié : solde et cantonnement par transaction | `/banque`, `/ops` |
| GET | `/v1/payment-orders` | Banque, Central.Parts | Ordres de paiement et de remboursement | `/banque`, `/ops`, `/ops/paiements` |
| POST | `/v1/payment-orders/{id}/approvals` | Central.Parts | Validation d'un ordre ; deux opérateurs distincts exigés | `/ops/paiements` |
| POST | `/v1/payment-orders/{id}/transmit` | Central.Parts | Transmission de l'ordre validé à l'établissement financier | `/ops/paiements` |

## Banque (API côté établissement)

| Méthode | Chemin | Rôles | Rôle de l'endpoint | Écrans |
|---|---|---|---|---|
| POST | `/v1/webhooks/bank/incoming-transfer` | Banque | Webhook banque : virement de l'acheteur reçu sur le compte dédié, rapproché par référence | `/banque` |
| POST | `/bank/v1/orders/{id}/execution` | Banque | Exécution d'un ordre par la banque, contrôle de l'IBAN autorisé | `/banque` |
| POST | `/v1/webhooks/bank/order-executed` | Banque | Webhook banque : ordre exécuté, la transaction est soldée | `/banque` |

## Plateforme

| Méthode | Chemin | Rôles | Rôle de l'endpoint | Écrans |
|---|---|---|---|---|
| GET | `/v1/notifications` | Acheteur, Vendeur, Laboratoire, Banque, Central.Parts | Notifications et relances de la partie appelante | `/acheteur`, `/vendeur`, `/labo` |
| GET | `/v1/events` | Central.Parts | Journal d'audit de la plateforme | `/ops` |
| POST | `/v1/jobs/deadlines` | Système | Tâche planifiée : expirations, relances, réputé accepté | Hors écran : intégration, webhook ou tâche |

## Routes des écrans

| Route | Rôle | Écran | Endpoints |
|---|---|---|---|
| `#/` | Public | Accueil de la maquette | — |
| `#/recherche` | Public | Recherche par référence | `search`, `dem.create` |
| `#/inscription` | Public | Inscription et KYB | `org.create`, `org.kyb` |
| `#/acheteur` | Acheteur | Tableau de bord acheteur | `bom.list`, `dem.list`, `tx.list`, `inv.orders`, `notif.list` |
| `#/acheteur/nomenclature` | Acheteur | Dépôt de nomenclature | `bom.create` |
| `#/acheteur/nomenclatures/:id` | Acheteur | Nomenclature répartie | `bom.get`, `inv.order`, `dem.create` |
| `#/acheteur/demandes/:id` | Acheteur | Demande et offres consolidées | `dem.get`, `offer.list`, `offer.accept` |
| `#/acheteur/transactions/:id` | Acheteur | Transaction (vue acheteur) | `tx.get`, `tx.sign`, `tx.inspect`, `tx.return`, `tx.dispute` |
| `#/vendeur` | Vendeur | Tableau de bord vendeur | `dem.list`, `lot.list`, `tx.list`, `notif.list` |
| `#/vendeur/stock` | Vendeur | Stock et import de stocklist | `lot.list`, `stock.import` |
| `#/vendeur/lots/:id` | Vendeur | Lot : questionnaire et documents | `lot.get`, `lot.questionnaire`, `lot.documents` |
| `#/vendeur/demandes/:id` | Vendeur | Demande anonymisée et enchère | `dem.get`, `advice`, `bid.mine`, `bid.create` |
| `#/vendeur/transactions/:id` | Vendeur | Transaction (vue vendeur) | `tx.get`, `tx.sign`, `tx.ship`, `tx.counter`, `tx.dispute` |
| `#/labo` | Laboratoire | Dossiers du laboratoire | `lab.cases`, `notif.list` |
| `#/labo/dossiers/:id` | Laboratoire | Dossier de test | `lab.cases`, `lab.receive`, `lab.certify`, `lab.reship` |
| `#/banque` | Banque | Console de l'établissement teneur du compte | `escrow.get`, `tx.list`, `order.list`, `bank.incoming`, `bank.execute`, `bank.executed` |
| `#/ops` | Central.Parts | Console Central.Parts | `org.list`, `dem.list`, `tx.list`, `order.list`, `escrow.get`, `events.list` |
| `#/ops/kyb` | Central.Parts | KYB à valider | `org.list`, `org.decide` |
| `#/ops/demandes` | Central.Parts | Demandes et enchères | `dem.list`, `dem.close`, `offer.list` |
| `#/ops/transactions/:id` | Central.Parts | Transaction (vue opérateur) | `tx.get`, `tx.delivered`, `dispute.decide` |
| `#/ops/paiements` | Central.Parts | Ordres de paiement, double validation | `order.list`, `order.approve`, `order.transmit` |
| `#/api` | Public | Carte des endpoints et des routes | — |

## Étapes d'une transaction Opportunity

| Statut | Étape | Qui agit | Endpoint qui fait avancer |
|---|---|---|---|
| `to_sign_buyer`, `to_sign_seller` | Signatures | Acheteur, puis vendeur | `POST /v1/transactions/{id}/signatures` |
| `awaiting_funds` | Dépôt des fonds | Acheteur (virement), banque (webhook) | `POST /v1/webhooks/bank/incoming-transfer` |
| `to_ship` | Expédition | Vendeur | `POST /v1/transactions/{id}/shipments` |
| `to_lab`, `at_lab`, `lab_passed` | Laboratoire | Laboratoire | `…/reception`, `…/certificate`, `…/reshipment` |
| `lab_failed` | Verdict défavorable | Vendeur | `POST /v1/transactions/{id}/counter-inspection` |
| `to_buyer` | Livraison | Transporteur (webhook) | `POST /v1/webhooks/carrier` |
| `inspection` | Inspection | Acheteur | `POST /v1/transactions/{id}/inspection` |
| `return_due`, `counter_inspection` | Retour, contre-inspection | Acheteur, puis vendeur | `…/returns`, `…/counter-inspection` |
| `dispute` | Litige | Central.Parts | `POST /v1/disputes/{id}/decision` |
| `settling` | Ordres de paiement | Central.Parts (deux opérateurs), banque | `…/approvals`, `…/transmit`, `POST /bank/v1/orders/{id}/execution` |
| `released`, `refunded`, `closed_partial`, `cancelled` | Soldée | — | `POST /v1/webhooks/bank/order-executed` |

Les délais dépassés sont traités par `POST /v1/jobs/deadlines` : fonds non déposés (annulation), non-expédition (annulation et remboursement du principal), silence à l'inspection (réputé accepté), silence à la contre-inspection (retour réputé accepté).
