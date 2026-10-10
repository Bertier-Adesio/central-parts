// Noyau de la maquette : utilitaires, horloge simulée, état et données de démonstration.
// Toutes les données sont fictives. L'état vit dans le navigateur (localStorage).
var CP = window.CP = {};

(function () {
  'use strict';

  // ------------------------------------------------------------ utilitaires
  CP.esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  CP.eur = function (n) {
    return (Math.round(n * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  };
  CP.num = function (n) { return Number(n).toLocaleString('fr-FR'); };
  CP.clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  CP.values = function (o) { return Object.keys(o).map(function (k) { return o[k]; }); };

  // ------------------------------------------------------------ horloge en jours ouvrés
  // Jour 0 = lundi 12 octobre 2026. Les délais se comptent en jours ouvrés.
  var START = new Date(2026, 9, 12);
  CP.date = function (day) {
    var d = new Date(START), n = day;
    while (n > 0) { d.setDate(d.getDate() + 1); if (d.getDay() % 6) n--; }
    return d;
  };
  CP.fmtDay = function (day) {
    return CP.date(day).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  };

  // Paramètres fictifs de la maquette (taux réels à fixer, voir docs/vision/opportunity.md).
  CP.PARAMS = {
    buyerMargin: 0.12,      // marge et frais côté acheteur, fictif
    sellerCommission: 0.03, // commission vendeur, fictif
    delays: { funds: 4, ship: 5, inspection: 10, counter: 10, mediation: 15, auction: 2 },
    labLevels: [
      { id: 0, name: 'Pas de test', price: 0, days: 0, tests: [] },
      { id: 1, name: 'Contrôle visuel et marquage', price: 180, days: 2, tests: ['visual', 'marking'] },
      { id: 2, name: 'Visuel, marquage et rayons X', price: 420, days: 3, tests: ['visual', 'marking', 'xray'] },
      { id: 3, name: 'Niveau 2 et XRF', price: 560, days: 3, tests: ['visual', 'marking', 'xray', 'xrf'] },
      { id: 4, name: 'Niveau 3 et décapsulation', price: 950, days: 5, tests: ['visual', 'marking', 'xray', 'xrf', 'decap'] },
    ],
    testNames: { visual: 'Contrôle visuel', marking: 'Marquage et étiquettes', xray: 'Rayons X', xrf: 'XRF (matériaux)', decap: 'Décapsulation' },
    rejectReasons: ['Contrefaçon ou soupçon de contrefaçon', 'Non-conformité à la commande ou au questionnaire', 'Écart de quantité', 'Dommage de transport'],
  };

  // Questionnaire d'état : 13 questions, réponses fermées.
  CP.QUESTIONS = [
    { k: 'origin', q: 'Origine du stock', a: ['Stock propre', 'Acheté chez un distributeur agréé', 'Surplus OEM/EMS', 'Autre broker'] },
    { k: 'resold', q: 'Pièces déjà vendues une première fois ?', a: ['Non', 'Oui'] },
    { k: 'returns', q: 'Retours qualité déjà subis ?', a: ['Non', 'Oui'] },
    { k: 'new', q: 'Neuf ou usagé', a: ['Neuf', 'Usagé'] },
    { k: 'visual', q: 'État visuel', a: ['Bon', 'Défauts mineurs', 'Défauts majeurs'] },
    { k: 'tested', q: 'Pièces testées ?', a: ['Non', 'Oui, en interne', 'Oui, par un laboratoire'] },
    { k: 'functional', q: 'État fonctionnel', a: ['Non testé', 'Fonctionnel', 'Défaillances connues'] },
    { k: 'dcHomogeneous', q: 'Date codes homogènes ?', a: ['Oui', 'Non'] },
    { k: 'oem', q: "Emballage d'origine du fabricant ?", a: ['Oui', 'Non'] },
    { k: 'opened', q: "Emballage d'origine ouvert ?", a: ['Non', 'Oui'] },
    { k: 'pack', q: "Type d'emballage", a: ['Bande et bobine', 'Plateau', 'Tube', 'Vrac'] },
    { k: 'storage', q: 'Conditions de stockage maîtrisées (température, humidité, sachet étanche) ?', a: ['Oui', 'Non', 'Inconnu'] },
    { k: 'other', q: 'Autre problème connu ?', a: ['Non', 'Oui'] },
  ];
  CP.REFUSED = 'Refuse de répondre';
  CP.DOCS = [['photos', 'Photos (étiquette, marquage, conditionnement)'], ['coc', 'Certificat de conformité (CoC)'], ['proof', "Preuve d'achat d'origine"], ['datasheet', 'Datasheet du fabricant'], ['inspection', "Rapport d'inspection"]];

  // ------------------------------------------------------------ acteurs de la démonstration
  // Chaque acteur correspond à une session authentifiée côté API.
  CP.ACTORS = [
    { id: 'public', role: 'public', label: 'Visiteur', org: null },
    { id: 'buyer', role: 'buyer', label: 'Acheteur · Atelier Lumen', org: 'B1' },
    { id: 'seller1', role: 'seller', label: 'Vendeur V-1 · surplus EMS', org: 'S1' },
    { id: 'seller2', role: 'seller', label: 'Vendeur V-2 · broker', org: 'S2' },
    { id: 'seller3', role: 'seller', label: 'Vendeur V-3 · OEM', org: 'S3' },
    { id: 'lab', role: 'lab', label: 'Laboratoire partenaire', org: 'L1' },
    { id: 'bank', role: 'bank', label: 'Banque · compte dédié', org: 'BK' },
    { id: 'ops1', role: 'ops', label: 'Central.Parts · opérateur 1', org: 'CP', user: 'Opérateur 1' },
    { id: 'ops2', role: 'ops', label: 'Central.Parts · opérateur 2', org: 'CP', user: 'Opérateur 2' },
  ];
  CP.HOME = { public: '/', buyer: '/acheteur', seller: '/vendeur', lab: '/labo', bank: '/banque', ops: '/ops' };

  // ------------------------------------------------------------ données de démonstration (fictives)
  function fullQ(over) {
    var q = { origin: 'Surplus OEM/EMS', resold: 'Non', returns: 'Non', new: 'Neuf', visual: 'Bon', tested: 'Non', functional: 'Non testé', dcHomogeneous: 'Oui', oem: 'Oui', opened: 'Oui', pack: 'Plateau', storage: 'Oui', other: 'Non' };
    for (var k in over) q[k] = over[k];
    return q;
  }

  CP.seed = function () {
    var s = {
      v: 1, day: 0,
      seq: { BOM: 12, DEM: 430, BID: 900, OFF: 500, TX: 43, LAB: 20, ORD: 70, LOT: 106, INV: 18, ORG: 10, DSP: 3, NOT: 0, EVT: 0 },
      orgs: {
        B1: { id: 'B1', type: 'buyer', name: 'Atelier Lumen (fictif)', alias: 'A-7Q2', city: 'Lyon', country: 'France', kyb: 'validated', iban: 'FR76 3000 4000 0000 0000 0452 1', siren: '000 000 001' },
        B2: { id: 'B2', type: 'buyer', name: 'Novatech EMS (fictif)', alias: 'A-3K9', city: 'Grenoble', country: 'France', kyb: 'pending', iban: 'FR76 1000 2000 0000 0000 0781 4', siren: '000 000 002' },
        S1: { id: 'S1', type: 'seller', name: 'Surplus Rhénanie GmbH (fictif)', alias: 'V-1', city: 'Cologne', country: 'Allemagne', kyb: 'validated', iban: 'DE89 3704 0044 0000 0000 01', profile: 'Surplus EMS' },
        S2: { id: 'S2', type: 'seller', name: 'Harbour Components Ltd (fictif)', alias: 'V-2', city: 'Hong Kong', country: 'Hong Kong', kyb: 'validated', iban: 'HK00 0000 0000 0000 0002', profile: 'Broker' },
        S3: { id: 'S3', type: 'seller', name: 'Nord Électronique (fictif)', alias: 'V-3', city: 'Lille', country: 'France', kyb: 'validated', iban: 'FR76 3000 6000 0000 0000 0003 3', profile: 'Surplus OEM' },
        L1: { id: 'L1', type: 'lab', name: 'Laboratoire partenaire Europe (fictif)', alias: 'LAB-EU', city: 'Eindhoven', country: 'Pays-Bas', kyb: 'validated', iban: 'NL91 ABNA 0000 0000 01' },
        BK: { id: 'BK', type: 'bank', name: 'Établissement teneur du compte dédié (à désigner)', alias: 'BANQUE', city: 'Paris', country: 'France', kyb: 'validated' },
        CP: { id: 'CP', type: 'ops', name: 'Central.Parts', alias: 'Central.Parts', city: 'Paris', country: 'France', kyb: 'validated' },
      },
      // Offre Inventory agrégée (fabricants et distributeurs). Prix fictifs.
      inventory: [
        { mpn: 'STM32G071RBT6', mfr: 'STMicroelectronics', source: 'Distributeur agréé', stock: 4800, lead: 3, price: 2.41 },
        { mpn: 'TPS62130RGTR', mfr: 'Texas Instruments', source: 'Distributeur agréé', stock: 12000, lead: 3, price: 1.12 },
        { mpn: 'GRM188R71H104KA93D', mfr: 'Murata', source: 'Distributeur agréé', stock: 900000, lead: 3, price: 0.004 },
        { mpn: 'CH340C', mfr: 'WCH', source: 'Fabricant, Chine', stock: 80000, lead: 7, price: 0.38 },
        { mpn: 'ESP32-C3-MINI-1-N4', mfr: 'Espressif', source: 'Fabricant, Chine', stock: 25000, lead: 7, price: 1.95 },
        { mpn: 'LM358DR', mfr: 'Texas Instruments', source: 'Distributeur agréé', stock: 60000, lead: 3, price: 0.09 },
        { mpn: 'AMS1117-3.3', mfr: 'Advanced Monolithic Systems', source: 'Fabricant, Chine', stock: 150000, lead: 7, price: 0.05 },
        { mpn: 'NE555DR', mfr: 'Texas Instruments', source: 'Distributeur agréé', stock: 30000, lead: 3, price: 0.11 },
      ],
      lots: {
        'LOT-101': { id: 'LOT-101', sellerId: 'S1', mpn: 'XC2S50-5TQ144C', mfr: 'AMD Xilinx', qty: 1200, dc: '2011', pack: 'Plateau', price: 40, q: fullQ({}), docs: { photos: true, coc: false, proof: true, datasheet: true, inspection: false } },
        'LOT-102': { id: 'LOT-102', sellerId: 'S2', mpn: 'XC2S50-5TQ144C', mfr: 'AMD Xilinx', qty: 400, dc: '2009/2012', pack: 'Plateau', price: 38, q: fullQ({ origin: 'Autre broker', resold: CP.REFUSED, dcHomogeneous: 'Non', storage: 'Inconnu' }), docs: { photos: true, coc: false, proof: false, datasheet: true, inspection: false } },
        'LOT-103': { id: 'LOT-103', sellerId: 'S3', mpn: 'MC68HC11E1CFNE2', mfr: 'NXP', qty: 300, dc: '2014', pack: 'Tube', price: 21, q: fullQ({ origin: 'Stock propre', opened: 'Non', pack: 'Tube' }), docs: { photos: true, coc: true, proof: true, datasheet: true, inspection: false } },
        'LOT-104': { id: 'LOT-104', sellerId: 'S1', mpn: 'MC68HC11E1CFNE2', mfr: 'NXP', qty: 90, dc: '2012', pack: 'Tube', price: 19, q: {}, docs: { photos: false, coc: false, proof: false, datasheet: true, inspection: false } },
        'LOT-105': { id: 'LOT-105', sellerId: 'S2', mpn: 'STM32F103C8T6', mfr: 'STMicroelectronics', qty: 5000, dc: '2023', pack: 'Plateau', price: 2.1, q: fullQ({ origin: 'Autre broker' }), docs: { photos: true, coc: false, proof: false, datasheet: true, inspection: false } },
        'LOT-106': { id: 'LOT-106', sellerId: 'S3', mpn: 'LT1086CM#PBF', mfr: 'Analog Devices', qty: 800, dc: '2016', pack: 'Tube', price: 3.4, q: fullQ({ origin: 'Stock propre', pack: 'Tube' }), docs: { photos: true, coc: true, proof: true, datasheet: true, inspection: true } },
      },
      boms: {
        'BOM-0012': { id: 'BOM-0012', buyerId: 'B1', name: 'carte-capteur-v2.csv', day: 0, lines: [
          { mpn: 'STM32G071RBT6', qty: 100, offer: 'inventory' },
          { mpn: 'TPS62130RGTR', qty: 100, offer: 'inventory' },
          { mpn: 'XC2S50-5TQ144C', qty: 250, offer: 'opportunity', demandId: 'DEM-0427' },
        ], inventoryOrderId: 'INV-0018' },
      },
      inventoryOrders: {
        'INV-0018': { id: 'INV-0018', buyerId: 'B1', bomId: 'BOM-0012', day: 0, status: 'Expédiée', lines: [{ mpn: 'STM32G071RBT6', qty: 100, price: 2.41, source: 'Distributeur agréé' }, { mpn: 'TPS62130RGTR', qty: 100, price: 1.12, source: 'Distributeur agréé' }] },
      },
      demands: {
        'DEM-0427': { id: 'DEM-0427', buyerId: 'B1', bomId: 'BOM-0012', mpn: 'XC2S50-5TQ144C', mfr: 'AMD Xilinx', qty: 250, dcMin: '2010', pack: 'Plateau', zone: 'Chine, Guangdong', delivery: 'Intégrateur, Shenzhen (Chine)', leadDays: 10, target: 45, status: 'auction', day: 0, closesDay: 2, sellers: ['S1', 'S2'] },
        'DEM-0428': { id: 'DEM-0428', buyerId: 'B1', bomId: null, mpn: 'MC68HC11E1CFNE2', mfr: 'NXP', qty: 250, dcMin: '2010', pack: 'Indifférent', zone: 'France', delivery: 'Atelier, Lyon (France)', leadDays: 10, target: null, status: 'auction', day: 0, closesDay: 2, sellers: ['S3', 'S1'] },
      },
      bids: {
        'BID-0899': { id: 'BID-0899', demandId: 'DEM-0427', sellerId: 'S1', lotId: 'LOT-101', net: 41.2, leadDays: 5, day: 0 },
        'BID-0900': { id: 'BID-0900', demandId: 'DEM-0427', sellerId: 'S2', lotId: 'LOT-102', net: 39.8, leadDays: 4, day: 0 },
      },
      offers: {},
      // Transaction déjà engagée pour que chaque rôle ait du travail dès l'ouverture.
      transactions: {
        'TX-0041': {
          id: 'TX-0041', demandId: null, offerId: null, buyerId: 'B1', sellerId: 'S3', lotId: 'LOT-106', mpn: 'LT1086CM#PBF', mfr: 'Analog Devices', qty: 200,
          net: 3.4, unit: 3.81, labLevel: 1, labId: 'L1', labFee: 180, delivery: 'Atelier, Lyon (France)', incoterm: 'DAP Lyon',
          delays: { inspection: 10, counter: 10 }, status: 'at_lab', signed: { buyer: true, seller: true }, due: null, day: 0, history: [],
        },
      },
      labCases: {
        'LAB-0020': { id: 'LAB-0020', txId: 'TX-0041', labId: 'L1', level: 1, status: 'received', results: {}, verdict: null, day: 0 },
      },
      escrow: { balance: 0, movements: [] },
      orders: {},
      disputes: {},
      notifications: [],
      events: [],
    };
    var t = s.transactions['TX-0041'];
    t.total = round(t.unit * t.qty + t.labFee);
    s.escrow.balance = t.total;
    s.escrow.movements.push({ day: 0, label: 'Virement reçu · Atelier Lumen (fictif) · réf. TX-0041', amount: t.total, txId: 'TX-0041' });
    t.history.push({ day: 0, text: 'Fiche signée par les deux parties.' }, { day: 0, text: 'Fonds reçus sur le compte dédié.' }, { day: 0, text: 'Expédié au laboratoire, suivi DHL 1Z-FICTIF-0041.' }, { day: 0, text: 'Pièces reçues au laboratoire : 200 unités, emballage intact.' });
    return s;
  };

  function round(n) { return Math.round(n * 100) / 100; }
  CP.round = round;

  // ------------------------------------------------------------ persistance
  var KEY = 'cp-app-state-v1';
  CP.load = function () {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) { var s = JSON.parse(raw); if (s && s.v === 1) return s; }
    } catch (e) { /* stockage indisponible : on repart des données de démonstration */ }
    return CP.seed();
  };
  CP.save = function () {
    try { localStorage.setItem(KEY, JSON.stringify(CP.state)); } catch (e) { /* sans effet */ }
  };
  CP.reset = function () {
    CP.state = CP.seed();
    CP.log = [];
    CP.save();
  };
  CP.state = CP.load();
  CP.log = [];
})();
