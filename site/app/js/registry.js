// Cartographie des endpoints et des routes de l'application Central.Parts.
// Source unique : la maquette (js/api.js) implémente chaque endpoint en mémoire,
// et tools/build-api-map.mjs génère api/endpoints.md à partir de ce fichier.
// Rôles : public, buyer (acheteur), seller (vendeur), lab (laboratoire),
// bank (établissement teneur du compte dédié), ops (Central.Parts), system (tâches planifiées, webhooks).

var CP_GROUPS = [
  ['accounts', 'Comptes et KYB'],
  ['catalog', 'Recherche et catalogue'],
  ['boms', 'Nomenclatures'],
  ['inventory', 'Offre Inventory'],
  ['demands', 'Demandes et enchères (Opportunity)'],
  ['lots', 'Stock vendeur et questionnaire'],
  ['transactions', 'Transactions'],
  ['lab', 'Laboratoires'],
  ['payments', 'Compte dédié et ordres de paiement'],
  ['bank', 'Banque (API côté établissement)'],
  ['platform', 'Plateforme'],
];

var CP_ENDPOINTS = [
  // Comptes et KYB
  { id: 'org.create', group: 'accounts', method: 'POST', path: '/v1/organizations', roles: ['public'], summary: "Inscription d'une société (acheteur, vendeur ou laboratoire)" },
  { id: 'org.get', group: 'accounts', method: 'GET', path: '/v1/organizations/{id}', roles: ['buyer', 'seller', 'lab', 'ops'], summary: "Fiche société ; pseudonyme seul pour les autres parties" },
  { id: 'org.kyb', group: 'accounts', method: 'POST', path: '/v1/organizations/{id}/kyb', roles: ['public', 'buyer', 'seller', 'lab'], summary: 'Dépôt du dossier KYB : Kbis, bénéficiaires effectifs, signataires, IBAN autorisé' },
  { id: 'org.list', group: 'accounts', method: 'GET', path: '/v1/organizations', roles: ['ops'], summary: 'Liste des sociétés, filtre par statut KYB' },
  { id: 'org.decide', group: 'accounts', method: 'POST', path: '/v1/organizations/{id}/kyb/decision', roles: ['ops'], summary: 'Validation ou refus du KYB, contrôle des listes de sanctions' },

  // Recherche
  { id: 'search', group: 'catalog', method: 'GET', path: '/v1/search', roles: ['public', 'buyer', 'seller', 'lab', 'ops'], summary: 'Recherche par référence fabricant dans Inventory et Opportunity (vendeurs anonymes)' },
  { id: 'advice', group: 'catalog', method: 'GET', path: '/v1/pricing/advice', roles: ['seller', 'ops'], summary: 'Fourchette de prix conseillée par Adesio pour une référence et une quantité' },

  // Nomenclatures
  { id: 'bom.create', group: 'boms', method: 'POST', path: '/v1/boms', roles: ['buyer'], summary: 'Dépôt d\'une nomenclature : chaque ligne est affectée à Inventory ou à Opportunity' },
  { id: 'bom.list', group: 'boms', method: 'GET', path: '/v1/boms', roles: ['buyer', 'ops'], summary: 'Nomenclatures de l\'acheteur' },
  { id: 'bom.get', group: 'boms', method: 'GET', path: '/v1/boms/{id}', roles: ['buyer', 'ops'], summary: 'Détail d\'une nomenclature et répartition des lignes' },

  // Inventory
  { id: 'inv.order', group: 'inventory', method: 'POST', path: '/v1/inventory/orders', roles: ['buyer'], summary: 'Commande des lignes Inventory (paiement classique, hors escrow)' },
  { id: 'inv.orders', group: 'inventory', method: 'GET', path: '/v1/inventory/orders', roles: ['buyer', 'ops'], summary: 'Commandes Inventory et leur suivi' },

  // Demandes et enchères
  { id: 'dem.create', group: 'demands', method: 'POST', path: '/v1/demands', roles: ['buyer'], summary: 'Création d\'une demande Opportunity, anonymisée puis diffusée aux vendeurs dont le stock correspond' },
  { id: 'dem.list', group: 'demands', method: 'GET', path: '/v1/demands', roles: ['buyer', 'seller', 'ops'], summary: 'Demandes : les siennes (acheteur), celles qui correspondent à son stock (vendeur, anonymisées), toutes (ops)' },
  { id: 'dem.get', group: 'demands', method: 'GET', path: '/v1/demands/{id}', roles: ['buyer', 'seller', 'ops'], summary: 'Détail d\'une demande ; le vendeur ne voit ni l\'acheteur ni l\'adresse' },
  { id: 'dem.close', group: 'demands', method: 'POST', path: '/v1/demands/{id}/close', roles: ['ops', 'system'], summary: 'Clôture de l\'enchère et calcul des offres consolidées (net + marge + frais)' },
  { id: 'bid.create', group: 'demands', method: 'POST', path: '/v1/demands/{id}/bids', roles: ['seller'], summary: 'Offre scellée du vendeur : lot, prix net, délai. Questionnaire du lot complet exigé' },
  { id: 'bid.mine', group: 'demands', method: 'GET', path: '/v1/demands/{id}/bids/mine', roles: ['seller'], summary: 'Offre du vendeur et son rang, sans les offres concurrentes' },
  { id: 'offer.list', group: 'demands', method: 'GET', path: '/v1/demands/{id}/offers', roles: ['buyer', 'ops'], summary: 'Offres consolidées, prix tout compris, questionnaire et documents' },
  { id: 'offer.accept', group: 'demands', method: 'POST', path: '/v1/offers/{id}/accept', roles: ['buyer'], summary: 'Choix d\'une offre, du niveau de test et des délais : crée la fiche transaction' },

  // Stock vendeur
  { id: 'stock.import', group: 'lots', method: 'POST', path: '/v1/stocklists', roles: ['seller'], summary: 'Import d\'une stocklist (formats Octopart ou ECIA), dédoublonnage des lots' },
  { id: 'lot.list', group: 'lots', method: 'GET', path: '/v1/lots', roles: ['seller', 'ops'], summary: 'Lots du vendeur et état du questionnaire' },
  { id: 'lot.get', group: 'lots', method: 'GET', path: '/v1/lots/{id}', roles: ['seller', 'ops'], summary: 'Détail d\'un lot' },
  { id: 'lot.questionnaire', group: 'lots', method: 'PUT', path: '/v1/lots/{id}/questionnaire', roles: ['seller'], summary: 'Questionnaire d\'état (13 questions) : les réponses engagent le vendeur' },
  { id: 'lot.documents', group: 'lots', method: 'PUT', path: '/v1/lots/{id}/documents', roles: ['seller'], summary: 'Documents qualité : photos, CoC, preuve d\'achat, datasheet, rapport d\'inspection' },

  // Transactions
  { id: 'tx.list', group: 'transactions', method: 'GET', path: '/v1/transactions', roles: ['buyer', 'seller', 'lab', 'bank', 'ops'], summary: 'Transactions de la partie appelante' },
  { id: 'tx.get', group: 'transactions', method: 'GET', path: '/v1/transactions/{id}', roles: ['buyer', 'seller', 'lab', 'bank', 'ops'], summary: 'Fiche transaction, étape en cours, délais, documents, historique' },
  { id: 'tx.sign', group: 'transactions', method: 'POST', path: '/v1/transactions/{id}/signatures', roles: ['buyer', 'seller'], summary: 'Signature électronique de la fiche transaction' },
  { id: 'tx.ship', group: 'transactions', method: 'POST', path: '/v1/transactions/{id}/shipments', roles: ['seller'], summary: 'Expédition sur ordre de Central.Parts : transporteur et numéro de suivi' },
  { id: 'tx.delivered', group: 'transactions', method: 'POST', path: '/v1/webhooks/carrier', roles: ['system'], summary: 'Webhook transporteur : livraison à l\'adresse désignée, ouvre le délai d\'inspection' },
  { id: 'tx.inspect', group: 'transactions', method: 'POST', path: '/v1/transactions/{id}/inspection', roles: ['buyer'], summary: 'Acceptation ou rejet motivé, ligne par ligne, avec justificatifs' },
  { id: 'tx.return', group: 'transactions', method: 'POST', path: '/v1/transactions/{id}/returns', roles: ['buyer'], summary: 'Retour des pièces rejetées avec l\'étiquette générée par la plateforme' },
  { id: 'tx.counter', group: 'transactions', method: 'POST', path: '/v1/transactions/{id}/counter-inspection', roles: ['seller'], summary: 'Contre-inspection du retour : acceptation ou contestation' },
  { id: 'tx.dispute', group: 'transactions', method: 'POST', path: '/v1/transactions/{id}/disputes', roles: ['seller', 'buyer'], summary: 'Ouverture d\'un litige : médiation par Central.Parts' },
  { id: 'dispute.decide', group: 'transactions', method: 'POST', path: '/v1/disputes/{id}/decision', roles: ['ops'], summary: 'Issue de la médiation ou de l\'expertise d\'un laboratoire tiers' },

  // Laboratoires
  { id: 'lab.cases', group: 'lab', method: 'GET', path: '/v1/lab/cases', roles: ['lab', 'ops'], summary: 'Dossiers de test du laboratoire' },
  { id: 'lab.receive', group: 'lab', method: 'POST', path: '/v1/lab/cases/{id}/reception', roles: ['lab'], summary: 'Réception des pièces : quantité, état, photos' },
  { id: 'lab.certify', group: 'lab', method: 'POST', path: '/v1/lab/cases/{id}/certificate', roles: ['lab'], summary: 'Résultats par test et certificat : conforme, non conforme ou contrefaçon' },
  { id: 'lab.reship', group: 'lab', method: 'POST', path: '/v1/lab/cases/{id}/reshipment', roles: ['lab'], summary: 'Réexpédition à l\'adresse de livraison désignée par l\'acheteur' },

  // Compte dédié et ordres
  { id: 'escrow.get', group: 'payments', method: 'GET', path: '/v1/escrow', roles: ['bank', 'ops'], summary: 'Compte dédié : solde et cantonnement par transaction' },
  { id: 'order.list', group: 'payments', method: 'GET', path: '/v1/payment-orders', roles: ['bank', 'ops'], summary: 'Ordres de paiement et de remboursement' },
  { id: 'order.approve', group: 'payments', method: 'POST', path: '/v1/payment-orders/{id}/approvals', roles: ['ops'], summary: 'Validation d\'un ordre ; deux opérateurs distincts exigés' },
  { id: 'order.transmit', group: 'payments', method: 'POST', path: '/v1/payment-orders/{id}/transmit', roles: ['ops'], summary: 'Transmission de l\'ordre validé à l\'établissement financier' },

  // Banque
  { id: 'bank.incoming', group: 'bank', method: 'POST', path: '/v1/webhooks/bank/incoming-transfer', roles: ['bank'], summary: 'Webhook banque : virement de l\'acheteur reçu sur le compte dédié, rapproché par référence' },
  { id: 'bank.execute', group: 'bank', method: 'POST', path: '/bank/v1/orders/{id}/execution', roles: ['bank'], summary: 'Exécution d\'un ordre par la banque, contrôle de l\'IBAN autorisé' },
  { id: 'bank.executed', group: 'bank', method: 'POST', path: '/v1/webhooks/bank/order-executed', roles: ['bank'], summary: 'Webhook banque : ordre exécuté, la transaction est soldée' },

  // Plateforme
  { id: 'notif.list', group: 'platform', method: 'GET', path: '/v1/notifications', roles: ['buyer', 'seller', 'lab', 'bank', 'ops'], summary: 'Notifications et relances de la partie appelante' },
  { id: 'events.list', group: 'platform', method: 'GET', path: '/v1/events', roles: ['ops'], summary: 'Journal d\'audit de la plateforme' },
  { id: 'jobs.deadlines', group: 'platform', method: 'POST', path: '/v1/jobs/deadlines', roles: ['system'], summary: 'Tâche planifiée : expirations, relances, réputé accepté' },
];

var CP_ROUTES = [
  { path: '/', role: 'public', title: 'Accueil de la maquette', endpoints: [] },
  { path: '/recherche', role: 'public', title: 'Recherche par référence', endpoints: ['search', 'dem.create'] },
  { path: '/inscription', role: 'public', title: 'Inscription et KYB', endpoints: ['org.create', 'org.kyb'] },
  { path: '/acheteur', role: 'buyer', title: 'Tableau de bord acheteur', endpoints: ['bom.list', 'dem.list', 'tx.list', 'inv.orders', 'notif.list'] },
  { path: '/acheteur/nomenclature', role: 'buyer', title: 'Dépôt de nomenclature', endpoints: ['bom.create'] },
  { path: '/acheteur/nomenclatures/:id', role: 'buyer', title: 'Nomenclature répartie', endpoints: ['bom.get', 'inv.order', 'dem.create'] },
  { path: '/acheteur/demandes/:id', role: 'buyer', title: 'Demande et offres consolidées', endpoints: ['dem.get', 'offer.list', 'offer.accept'] },
  { path: '/acheteur/transactions/:id', role: 'buyer', title: 'Transaction (vue acheteur)', endpoints: ['tx.get', 'tx.sign', 'tx.inspect', 'tx.return', 'tx.dispute'] },
  { path: '/vendeur', role: 'seller', title: 'Tableau de bord vendeur', endpoints: ['dem.list', 'lot.list', 'tx.list', 'notif.list'] },
  { path: '/vendeur/stock', role: 'seller', title: 'Stock et import de stocklist', endpoints: ['lot.list', 'stock.import'] },
  { path: '/vendeur/lots/:id', role: 'seller', title: 'Lot : questionnaire et documents', endpoints: ['lot.get', 'lot.questionnaire', 'lot.documents'] },
  { path: '/vendeur/demandes/:id', role: 'seller', title: 'Demande anonymisée et enchère', endpoints: ['dem.get', 'advice', 'bid.mine', 'bid.create'] },
  { path: '/vendeur/transactions/:id', role: 'seller', title: 'Transaction (vue vendeur)', endpoints: ['tx.get', 'tx.sign', 'tx.ship', 'tx.counter', 'tx.dispute'] },
  { path: '/labo', role: 'lab', title: 'Dossiers du laboratoire', endpoints: ['lab.cases', 'notif.list'] },
  { path: '/labo/dossiers/:id', role: 'lab', title: 'Dossier de test', endpoints: ['lab.cases', 'lab.receive', 'lab.certify', 'lab.reship'] },
  { path: '/banque', role: 'bank', title: 'Console de l\'établissement teneur du compte', endpoints: ['escrow.get', 'tx.list', 'order.list', 'bank.incoming', 'bank.execute', 'bank.executed'] },
  { path: '/ops', role: 'ops', title: 'Console Central.Parts', endpoints: ['org.list', 'dem.list', 'tx.list', 'order.list', 'escrow.get', 'events.list'] },
  { path: '/ops/kyb', role: 'ops', title: 'KYB à valider', endpoints: ['org.list', 'org.decide'] },
  { path: '/ops/demandes', role: 'ops', title: 'Demandes et enchères', endpoints: ['dem.list', 'dem.close', 'offer.list'] },
  { path: '/ops/transactions/:id', role: 'ops', title: 'Transaction (vue opérateur)', endpoints: ['tx.get', 'tx.delivered', 'dispute.decide'] },
  { path: '/ops/paiements', role: 'ops', title: 'Ordres de paiement, double validation', endpoints: ['order.list', 'order.approve', 'order.transmit'] },
  { path: '/api', role: 'public', title: 'Carte des endpoints et des routes', endpoints: [] },
];
