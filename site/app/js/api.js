// API simulée : chaque endpoint de registry.js a ici son implémentation en mémoire.
// Les écrans n'accèdent aux données que par CP.api(), comme ils le feront avec la vraie API.
(function () {
  'use strict';
  var S = function () { return CP.state; };
  var P = CP.PARAMS;
  var round = CP.round;

  // ------------------------------------------------------------ routage des endpoints
  var compiled = CP_ENDPOINTS.map(function (e) {
    var keys = [];
    var re = new RegExp('^' + e.path.replace(/\{(\w+)\}/g, function (_, k) { keys.push(k); return '([^/]+)'; }) + '$');
    return { e: e, re: re, keys: keys };
  });

  function ApiError(status, message) { this.status = status; this.message = message; }
  function fail(status, message) { throw new ApiError(status, message); }

  function next(prefix) {
    var s = S();
    s.seq[prefix] = (s.seq[prefix] || 0) + 1;
    var n = String(s.seq[prefix]);
    while (n.length < 4) n = '0' + n;
    return prefix + '-' + n;
  }

  // Appel d'API. opts.quiet : lecture faite par un écran, comptée mais non affichée par défaut.
  CP.api = function (method, url, body, opts) {
    opts = opts || {};
    var actor = opts.actor || CP.actor;
    var parts = url.split('?');
    var path = parts[0], query = {};
    (parts[1] || '').split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      query[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1));
    });
    var match = null, params = {};
    for (var i = 0; i < compiled.length && !match; i++) {
      var c = compiled[i];
      if (c.e.method !== method) continue;
      var m = c.re.exec(path);
      if (m) { match = c; c.keys.forEach(function (k, j) { params[k] = decodeURIComponent(m[j + 1]); }); }
    }
    var res;
    try {
      if (!match) fail(404, 'Endpoint inconnu');
      if (match.e.roles.indexOf(actor.role) < 0) fail(403, 'Rôle « ' + actor.role + ' » non autorisé');
      var data = H[match.e.id]({ params: params, query: query, body: body || {}, actor: actor, org: actor.org && S().orgs[actor.org] });
      res = { status: method === 'POST' && !opts.ok200 ? 201 : 200, data: data };
      if (method !== 'GET') CP.save();
    } catch (err) {
      if (!(err instanceof ApiError)) { console.error(err); err = new ApiError(500, 'Erreur interne de la maquette'); }
      res = { status: err.status, error: err.message };
    }
    var entry = { id: CP.log.length + 1, at: new Date(), actor: actor.label, role: actor.role, method: method, path: url, endpoint: match ? match.e.id : null, status: res.status, req: body || null, res: res.data !== undefined ? res.data : { error: res.error }, quiet: !!opts.quiet };
    CP.log.push(entry);
    if (CP.onLog) CP.onLog(entry);
    return res;
  };

  // Appel fait par la plateforme elle-même (tâche planifiée, webhook entrant).
  var SYSTEM = { id: 'system', role: 'system', label: 'Système', org: 'CP' };
  CP.system = function (method, url, body) { return CP.api(method, url, body, { actor: SYSTEM }); };

  // ------------------------------------------------------------ événements et notifications
  function event(text, ref) {
    S().events.unshift({ id: next('EVT'), day: S().day, text: text, ref: ref || null });
  }
  function notify(to, text, link) {
    S().notifications.unshift({ id: next('NOT'), day: S().day, to: to, text: text, link: link || null });
  }
  function hist(t, text) { t.history.push({ day: S().day, text: text }); event(t.id + ' · ' + text, t.id); }
  function alias(orgId) { var o = S().orgs[orgId]; return o ? o.alias : '—'; }

  // ------------------------------------------------------------ vues filtrées selon l'appelant
  function isOps(a) { return a.role === 'ops' || a.role === 'system'; }

  function demandView(d, a) {
    var v = CP.clone(d);
    if (a.role === 'seller') {
      delete v.buyerId; delete v.bomId; delete v.delivery; delete v.target; delete v.sellers;
      v.buyer = 'Masqué';
    } else if (a.role === 'buyer') {
      delete v.sellers;
    }
    v.bids = CP.values(S().bids).filter(function (b) { return b.demandId === d.id; }).length;
    return v;
  }

  function txView(t, a) {
    var v = CP.clone(t);
    v.buyer = a.role === 'seller' || a.role === 'lab' ? alias(t.buyerId) : S().orgs[t.buyerId].name;
    v.seller = a.role === 'buyer' || a.role === 'lab' ? alias(t.sellerId) : S().orgs[t.sellerId].name;
    if (a.role === 'buyer' || a.role === 'lab') v.sellerProfile = S().orgs[t.sellerId].profile;
    if (a.role === 'seller' || a.role === 'lab') { delete v.unit; delete v.total; v.zone = zoneOf(t.delivery); delete v.delivery; }
    if (a.role === 'buyer') delete v.net;
    if (a.role === 'lab') { delete v.net; delete v.history; }
    v.lot = lotPublic(S().lots[t.lotId]);
    v.labCase = CP.values(S().labCases).filter(function (c) { return c.txId === t.id; })[0] || null;
    v.orders = CP.values(S().orders).filter(function (o) { return o.txId === t.id; });
    if (!isOps(a) && a.role !== 'bank') v.orders = v.orders.map(function (o) { return { id: o.id, type: o.type, status: o.status }; });
    return v;
  }
  function zoneOf(delivery) { var m = /\(([^)]+)\)/.exec(delivery || ''); return m ? m[1] : 'Masquée'; }

  function lotPublic(l) {
    if (!l) return null;
    return { id: l.id, mpn: l.mpn, mfr: l.mfr, qty: l.qty, dc: l.dc, pack: l.pack, q: l.q, docs: l.docs, complete: complete(l) };
  }
  function complete(l) { return CP.QUESTIONS.every(function (x) { return l.q && l.q[x.k]; }); }

  // ------------------------------------------------------------ transactions : transitions
  function due(t, kind, days) { t.due = days == null ? null : { kind: kind, day: S().day + days }; }

  function settle(t, outcome) {
    var rejected = outcome === 'release' ? 0 : (t.rejectedQty || t.qty);
    var accepted = t.qty - rejected;
    // Les frais de laboratoire vont au laboratoire s'il a rendu son certificat, sinon à l'acheteur.
    var lab = t.labLevel ? t.labFee : 0;
    var labDone = CP.values(S().labCases).some(function (x) { return x.txId === t.id && x.verdict; });
    if (accepted > 0) {
      var payout = round(t.net * accepted * (1 - P.sellerCommission));
      var lines = [{ to: t.sellerId, label: 'Paiement du vendeur ' + alias(t.sellerId), amount: payout }];
      if (lab && rejected === 0) lines.push(labDone ? { to: t.labId, label: 'Frais de laboratoire', amount: lab } : { to: t.buyerId, label: 'Frais de laboratoire non engagés, rendus à l\'acheteur', amount: lab });
      var held = round(t.unit * accepted + (rejected === 0 ? lab : 0));
      lines.push({ to: 'CP', label: 'Marge et commissions Central.Parts', amount: round(held - payout - (rejected === 0 ? lab : 0)) });
      order('release', t, lines);
    }
    if (rejected > 0) {
      var rl = [{ to: t.buyerId, label: 'Remboursement de l\'acheteur (principal)', amount: round(t.unit * rejected) }];
      if (lab) rl.push(labDone ? { to: t.labId, label: 'Frais de laboratoire', amount: lab } : { to: t.buyerId, label: 'Frais de laboratoire non engagés', amount: lab });
      order('refund', t, rl);
    }
    t.status = 'settling';
    due(t, null, null);
    hist(t, accepted && rejected ? 'Règlement partiel : ' + accepted + ' unités payées, ' + rejected + ' remboursées.' : outcome === 'release' ? 'Paiement du vendeur à ordonner.' : 'Remboursement de l\'acheteur à ordonner.');
  }

  function order(type, t, lines) {
    var o = { id: next('ORD'), type: type, txId: t.id, lines: lines, amount: round(lines.reduce(function (s, l) { return s + l.amount; }, 0)), approvals: [], status: 'pending', day: S().day };
    S().orders[o.id] = o;
    notify('ops', 'Ordre ' + o.id + ' (' + (type === 'release' ? 'paiement' : 'remboursement') + ') à valider pour ' + t.id + '.', '/ops/paiements');
    return o;
  }

  function cancel(t, why, refund) {
    hist(t, why);
    if (refund) { t.rejectedQty = t.qty; settle(t, 'refund'); }
    else { t.status = 'cancelled'; due(t, null, null); }
  }

  // ------------------------------------------------------------ implémentations
  var H = {};

  // Comptes et KYB
  H['org.create'] = function (c) {
    var b = c.body;
    if (!b.name || !b.type || ['buyer', 'seller', 'lab'].indexOf(b.type) < 0) fail(422, 'Raison sociale et type de compte requis');
    var id = next('ORG');
    S().orgs[id] = { id: id, type: b.type, name: b.name, alias: (b.type === 'buyer' ? 'A-' : b.type === 'seller' ? 'V-' : 'LAB-') + id.slice(-3), city: b.city || '', country: b.country || '', siren: b.siren || '', kyb: 'draft' };
    event('Inscription : ' + b.name + ' (' + b.type + ').', id);
    return S().orgs[id];
  };
  H['org.get'] = function (c) {
    var o = S().orgs[c.params.id];
    if (!o) fail(404, 'Société inconnue');
    if (isOps(c.actor) || c.actor.org === o.id) return o;
    return { id: o.id, alias: o.alias, type: o.type, country: o.country };
  };
  H['org.kyb'] = function (c) {
    var o = S().orgs[c.params.id];
    if (!o) fail(404, 'Société inconnue');
    if (c.actor.role !== 'public' && c.actor.org !== o.id) fail(403, 'Dossier d\'une autre société');
    var b = c.body;
    if (!b.iban || !b.signatory || !b.beneficiaries) fail(422, 'IBAN, signataire et bénéficiaires effectifs requis');
    o.iban = b.iban; o.signatory = b.signatory; o.beneficiaries = b.beneficiaries; o.docs = b.docs || {};
    o.kyb = 'pending';
    notify('ops', 'Dossier KYB à valider : ' + o.name + '.', '/ops/kyb');
    event('KYB déposé : ' + o.name + '.', o.id);
    return o;
  };
  H['org.list'] = function (c) {
    return CP.values(S().orgs).filter(function (o) { return !c.query.kyb || o.kyb === c.query.kyb; });
  };
  H['org.decide'] = function (c) {
    var o = S().orgs[c.params.id];
    if (!o) fail(404, 'Société inconnue');
    if (o.kyb !== 'pending') fail(409, 'Aucun dossier en attente');
    if (['validated', 'rejected'].indexOf(c.body.decision) < 0) fail(422, 'Décision attendue : validated ou rejected');
    if (c.body.decision === 'validated' && !c.body.sanctionsChecked) fail(422, 'Contrôle des listes de sanctions requis');
    o.kyb = c.body.decision;
    o.kybBy = c.actor.user;
    event('KYB ' + (o.kyb === 'validated' ? 'validé' : 'refusé') + ' : ' + o.name + ' (' + c.actor.user + ').', o.id);
    return o;
  };

  // Recherche
  H['search'] = function (c) {
    var q = (c.query.q || '').trim().toUpperCase();
    if (q.length < 2) fail(422, 'Saisir au moins 2 caractères');
    var inv = S().inventory.filter(function (i) { return i.mpn.toUpperCase().indexOf(q) >= 0; });
    var by = {};
    CP.values(S().lots).forEach(function (l) {
      if (l.mpn.toUpperCase().indexOf(q) < 0) return;
      var g = by[l.mpn] || (by[l.mpn] = { mpn: l.mpn, mfr: l.mfr, lots: 0, qty: 0, origins: [] });
      g.lots++; g.qty += l.qty;
      var o = l.q && l.q.origin ? l.q.origin : 'Non renseignée';
      if (g.origins.indexOf(o) < 0) g.origins.push(o);
    });
    return { query: q, inventory: inv, opportunity: CP.values(by) };
  };
  H['advice'] = function (c) {
    var mpn = c.query.mpn;
    var prices = CP.values(S().lots).filter(function (l) { return l.mpn === mpn; }).map(function (l) { return l.price; });
    if (!prices.length) fail(404, 'Pas assez de données pour cette référence');
    var avg = prices.reduce(function (a, b) { return a + b; }, 0) / prices.length;
    return { mpn: mpn, low: round(avg * 0.95), high: round(avg * 1.15), basis: 'Données fictives de la maquette' };
  };

  // Nomenclatures
  H['bom.create'] = function (c) {
    var b = c.body;
    if (!b.lines || !b.lines.length) fail(422, 'Nomenclature vide');
    var lines = b.lines.map(function (l) {
      var mpn = String(l.mpn || '').trim().toUpperCase(), qty = parseInt(l.qty, 10);
      if (!mpn || !(qty > 0)) fail(422, 'Ligne invalide : ' + (l.mpn || '?'));
      var inv = S().inventory.filter(function (i) { return i.mpn.toUpperCase() === mpn; })[0];
      if (inv && inv.stock >= qty) return { mpn: inv.mpn, mfr: inv.mfr, qty: qty, offer: 'inventory', price: inv.price, source: inv.source, lead: inv.lead };
      var lot = CP.values(S().lots).filter(function (x) { return x.mpn.toUpperCase() === mpn; })[0];
      return { mpn: lot ? lot.mpn : mpn, mfr: lot ? lot.mfr : (inv ? inv.mfr : ''), qty: qty, offer: 'opportunity', reason: inv ? 'Stock agréé insuffisant' : 'Aucun stock agréé' };
    });
    var id = next('BOM');
    S().boms[id] = { id: id, buyerId: c.actor.org, name: b.name || 'nomenclature.csv', day: S().day, lines: lines, delivery: b.delivery, zone: b.zone, dcMin: b.dcMin || '' };
    event('Nomenclature ' + id + ' déposée : ' + lines.length + ' lignes.', id);
    return S().boms[id];
  };
  H['bom.list'] = function (c) {
    return CP.values(S().boms).filter(function (b) { return isOps(c.actor) || b.buyerId === c.actor.org; }).reverse();
  };
  H['bom.get'] = function (c) {
    var b = S().boms[c.params.id];
    if (!b || (!isOps(c.actor) && b.buyerId !== c.actor.org)) fail(404, 'Nomenclature inconnue');
    return b;
  };

  // Inventory
  H['inv.order'] = function (c) {
    var b = S().boms[c.body.bomId];
    if (!b || b.buyerId !== c.actor.org) fail(404, 'Nomenclature inconnue');
    if (b.inventoryOrderId) fail(409, 'Lignes Inventory déjà commandées');
    var lines = b.lines.filter(function (l) { return l.offer === 'inventory'; }).map(function (l) { return { mpn: l.mpn, qty: l.qty, price: l.price, source: l.source }; });
    if (!lines.length) fail(409, 'Aucune ligne Inventory');
    var id = next('INV');
    S().inventoryOrders[id] = { id: id, buyerId: c.actor.org, bomId: b.id, day: S().day, status: 'Confirmée', lines: lines };
    b.inventoryOrderId = id;
    event('Commande Inventory ' + id + ' : ' + lines.length + ' lignes.', id);
    return S().inventoryOrders[id];
  };
  H['inv.orders'] = function (c) {
    return CP.values(S().inventoryOrders).filter(function (o) { return isOps(c.actor) || o.buyerId === c.actor.org; }).reverse();
  };

  // Demandes et enchères
  H['dem.create'] = function (c) {
    var b = c.body, buyer = S().orgs[c.actor.org];
    if (buyer.kyb !== 'validated') fail(403, 'KYB non validé');
    var qty = parseInt(b.qty, 10);
    if (!b.mpn || !(qty > 0)) fail(422, 'Référence et quantité requises');
    var mpn = String(b.mpn).toUpperCase();
    var bom = b.bomId ? S().boms[b.bomId] : null;
    if (bom) {
      var line = bom.lines.filter(function (l) { return l.mpn.toUpperCase() === mpn && l.offer === 'opportunity'; })[0];
      if (!line) fail(422, 'Ligne absente de la nomenclature');
      if (line.demandId) fail(409, 'Demande déjà lancée pour cette ligne');
    }
    var sellers = [];
    CP.values(S().lots).forEach(function (l) {
      if (l.mpn.toUpperCase() === mpn && sellers.indexOf(l.sellerId) < 0) sellers.push(l.sellerId);
    });
    var id = next('DEM');
    var lot = CP.values(S().lots).filter(function (l) { return l.mpn.toUpperCase() === mpn; })[0];
    var d = { id: id, buyerId: c.actor.org, bomId: bom ? bom.id : null, mpn: lot ? lot.mpn : mpn, mfr: (lot && lot.mfr) || b.mfr || '', qty: qty, dcMin: b.dcMin || '', pack: b.pack || 'Indifférent', zone: b.zone || zoneOf(b.delivery), delivery: b.delivery || '', leadDays: parseInt(b.leadDays, 10) || 10, target: b.target ? Number(b.target) : null, status: 'auction', day: S().day, closesDay: S().day + P.delays.auction, sellers: sellers };
    S().demands[id] = d;
    if (line) line.demandId = id;
    sellers.forEach(function (s) { notify(s, 'Nouvelle demande ' + id + ' : ' + d.mpn + ' × ' + qty + ' correspond à votre stock.', '/vendeur/demandes/' + id); });
    event('Demande ' + id + ' anonymisée et diffusée à ' + sellers.length + ' vendeur(s).' + (sellers.length ? '' : ' Recherche étendue à prévoir.'), id);
    return demandView(d, c.actor);
  };
  H['dem.list'] = function (c) {
    return CP.values(S().demands).filter(function (d) {
      if (isOps(c.actor)) return true;
      if (c.actor.role === 'buyer') return d.buyerId === c.actor.org;
      return d.sellers.indexOf(c.actor.org) >= 0;
    }).reverse().map(function (d) { return demandView(d, c.actor); });
  };
  H['dem.get'] = function (c) {
    var d = S().demands[c.params.id];
    if (!d) fail(404, 'Demande inconnue');
    if (c.actor.role === 'buyer' && d.buyerId !== c.actor.org) fail(404, 'Demande inconnue');
    if (c.actor.role === 'seller' && d.sellers.indexOf(c.actor.org) < 0) fail(404, 'Demande inconnue');
    return demandView(d, c.actor);
  };
  H['dem.close'] = function (c) {
    var d = S().demands[c.params.id];
    if (!d) fail(404, 'Demande inconnue');
    if (d.status !== 'auction') fail(409, 'Enchère déjà clôturée');
    var bids = CP.values(S().bids).filter(function (b) { return b.demandId === d.id; }).sort(function (a, b) { return a.net - b.net; });
    bids.forEach(function (b, i) {
      var id = next('OFF');
      S().offers[id] = { id: id, demandId: d.id, bidId: b.id, sellerId: b.sellerId, lotId: b.lotId, net: b.net, unit: round(b.net * (1 + P.buyerMargin)), leadDays: b.leadDays, rank: i + 1, status: 'open', validUntil: S().day + 2 };
    });
    d.status = bids.length ? 'offers' : 'no_offer';
    d.closedDay = S().day;
    if (bids.length) notify(d.buyerId, bids.length + ' offre(s) consolidée(s) pour ' + d.id + ' (' + d.mpn + ').', '/acheteur/demandes/' + d.id);
    event('Enchère ' + d.id + ' clôturée : ' + bids.length + ' offre(s).', d.id);
    return demandView(d, c.actor);
  };
  H['bid.create'] = function (c) {
    var d = S().demands[c.params.id], b = c.body;
    if (!d || d.sellers.indexOf(c.actor.org) < 0) fail(404, 'Demande inconnue');
    if (d.status !== 'auction') fail(409, 'Enchère clôturée');
    var lot = S().lots[b.lotId];
    if (!lot || lot.sellerId !== c.actor.org || lot.mpn !== d.mpn) fail(422, 'Lot invalide pour cette demande');
    if (lot.qty < d.qty) fail(422, 'Quantité du lot insuffisante (' + lot.qty + ')');
    if (!complete(lot)) fail(422, 'Questionnaire d\'état du lot incomplet');
    var net = Number(b.net);
    if (!(net > 0)) fail(422, 'Prix net invalide');
    var mine = CP.values(S().bids).filter(function (x) { return x.demandId === d.id && x.sellerId === c.actor.org; })[0];
    if (!mine) { mine = { id: next('BID'), demandId: d.id, sellerId: c.actor.org }; S().bids[mine.id] = mine; }
    mine.lotId = lot.id; mine.net = round(net); mine.leadDays = parseInt(b.leadDays, 10) || 5; mine.day = S().day;
    event('Offre scellée reçue sur ' + d.id + ' (' + alias(c.actor.org) + ').', d.id);
    return H['bid.mine'](c);
  };
  H['bid.mine'] = function (c) {
    var all = CP.values(S().bids).filter(function (x) { return x.demandId === c.params.id; }).sort(function (a, b) { return a.net - b.net; });
    var mine = all.filter(function (x) { return x.sellerId === c.actor.org; })[0] || null;
    return { bid: mine, rank: mine ? all.indexOf(mine) + 1 : null, count: all.length };
  };
  H['offer.list'] = function (c) {
    var d = S().demands[c.params.id];
    if (!d || (c.actor.role === 'buyer' && d.buyerId !== c.actor.org)) fail(404, 'Demande inconnue');
    return CP.values(S().offers).filter(function (o) { return o.demandId === d.id; }).sort(function (a, b) { return a.rank - b.rank; }).map(function (o) {
      var v = { id: o.id, rank: o.rank, unit: o.unit, leadDays: o.leadDays, status: o.status, validUntil: o.validUntil, seller: alias(o.sellerId), sellerProfile: S().orgs[o.sellerId].profile, lot: lotPublic(S().lots[o.lotId]), origin: S().lots[o.lotId].q.origin };
      if (isOps(c.actor)) { v.net = o.net; v.sellerName = S().orgs[o.sellerId].name; }
      return v;
    });
  };
  H['offer.accept'] = function (c) {
    var o = S().offers[c.params.id], b = c.body;
    if (!o) fail(404, 'Offre inconnue');
    var d = S().demands[o.demandId];
    if (d.buyerId !== c.actor.org) fail(404, 'Offre inconnue');
    if (o.status !== 'open' || d.status !== 'offers') fail(409, 'Offre plus disponible');
    var level = P.labLevels[parseInt(b.labLevel, 10) || 0];
    var insp = clampDays(b.inspection, P.delays.inspection), counter = clampDays(b.counter, P.delays.counter);
    var id = next('TX');
    var t = { id: id, demandId: d.id, offerId: o.id, buyerId: d.buyerId, sellerId: o.sellerId, lotId: o.lotId, mpn: d.mpn, mfr: d.mfr, qty: d.qty, net: o.net, unit: o.unit, labLevel: level.id, labId: level.id ? 'L1' : null, labFee: level.price, delivery: d.delivery || 'Adresse de l\'acheteur', incoterm: 'DAP', delays: { inspection: insp, counter: counter }, status: 'to_sign_buyer', signed: { buyer: false, seller: false }, due: null, day: S().day, history: [] };
    t.total = round(t.unit * t.qty + t.labFee);
    S().transactions[id] = t;
    CP.values(S().offers).forEach(function (x) { if (x.demandId === d.id) x.status = x.id === o.id ? 'accepted' : 'declined'; });
    d.status = 'ordered'; d.txId = id;
    if (level.id) {
      var lc = next('LAB');
      S().labCases[lc] = { id: lc, txId: id, labId: 'L1', level: level.id, status: 'awaiting', results: {}, verdict: null, day: S().day };
    }
    hist(t, 'Offre ' + o.id + ' retenue. Fiche transaction créée' + (level.id ? ', test : ' + level.name.toLowerCase() : '') + '.');
    notify(o.sellerId, 'Votre offre sur ' + d.id + ' est retenue : fiche ' + id + ' à signer.', '/vendeur/transactions/' + id);
    return txView(t, c.actor);
  };
  function clampDays(v, def) { var n = parseInt(v, 10); return n >= 1 && n <= 30 ? n : def; }

  // Stock vendeur
  H['stock.import'] = function (c) {
    var rows = String(c.body.csv || '').split(/\r?\n/).map(function (r) { return r.trim(); }).filter(Boolean);
    if (rows.length < 2) fail(422, 'Fichier vide : une ligne d\'en-tête et au moins une ligne attendues');
    var head = rows.shift().split(/[;,\t]/).map(function (h) { return h.trim().toLowerCase(); });
    // Correspondance des colonnes Octopart et ECIA vers le modèle de lot.
    var col = function (names) { for (var i = 0; i < names.length; i++) { var j = head.indexOf(names[i]); if (j >= 0) return j; } return -1; };
    var ix = { mpn: col(['mpn', 'manufacturer part number', 'part number', 'mfr_part_number']), mfr: col(['manufacturer', 'mfr', 'manufacturer_name']), qty: col(['quantity', 'qty', 'stock', 'quantity_available']), dc: col(['date_code', 'datecode', 'date code', 'dc']), pack: col(['packaging', 'package_type', 'pack']), price: col(['price', 'unit_price', 'target_price']) };
    if (ix.mpn < 0 || ix.qty < 0) fail(422, 'Colonnes obligatoires absentes : référence fabricant et quantité');
    var created = [], updated = [], dupes = [];
    rows.forEach(function (r) {
      var f = r.split(/[;,\t]/).map(function (x) { return x.trim(); });
      var mpn = (f[ix.mpn] || '').toUpperCase(), qty = parseInt(f[ix.qty], 10);
      if (!mpn || !(qty > 0)) return;
      var dc = ix.dc >= 0 ? f[ix.dc] : '';
      var same = CP.values(S().lots).filter(function (l) { return l.sellerId === c.actor.org && l.mpn === mpn && l.dc === dc; })[0];
      if (same) { same.qty = qty; updated.push(same.id); return; }
      var other = CP.values(S().lots).filter(function (l) { return l.sellerId !== c.actor.org && l.mpn === mpn && l.dc === dc && l.qty === qty; })[0];
      var id = next('LOT');
      S().lots[id] = { id: id, sellerId: c.actor.org, mpn: mpn, mfr: ix.mfr >= 0 ? f[ix.mfr] : '', qty: qty, dc: dc, pack: ix.pack >= 0 ? f[ix.pack] : '', price: ix.price >= 0 ? Number(f[ix.price]) || null : null, q: {}, docs: {}, duplicateOf: other ? other.id : null };
      created.push(id);
      if (other) dupes.push(id);
    });
    event('Stocklist importée par ' + alias(c.actor.org) + ' : ' + created.length + ' lot(s) créé(s), ' + updated.length + ' mis à jour.', c.actor.org);
    return { format: c.body.format || 'auto', created: created, updated: updated, possibleDuplicates: dupes };
  };
  H['lot.list'] = function (c) {
    return CP.values(S().lots).filter(function (l) { return isOps(c.actor) || l.sellerId === c.actor.org; }).map(function (l) {
      var v = CP.clone(l); v.complete = complete(l); return v;
    });
  };
  H['lot.get'] = function (c) {
    var l = S().lots[c.params.id];
    if (!l || (!isOps(c.actor) && l.sellerId !== c.actor.org)) fail(404, 'Lot inconnu');
    var v = CP.clone(l); v.complete = complete(l); return v;
  };
  H['lot.questionnaire'] = function (c) {
    var l = S().lots[c.params.id];
    if (!l || l.sellerId !== c.actor.org) fail(404, 'Lot inconnu');
    var a = c.body.answers || {};
    CP.QUESTIONS.forEach(function (x) {
      var v = a[x.k];
      if (v && v !== CP.REFUSED && x.a.indexOf(v) < 0) fail(422, 'Réponse invalide : ' + x.q);
    });
    l.q = a; l.comments = c.body.comments || {};
    return H['lot.get'](c);
  };
  H['lot.documents'] = function (c) {
    var l = S().lots[c.params.id];
    if (!l || l.sellerId !== c.actor.org) fail(404, 'Lot inconnu');
    l.docs = c.body.docs || {};
    return H['lot.get'](c);
  };

  // Transactions
  function getTx(c) {
    var t = S().transactions[c.params.id || c.body.txId];
    var a = c.actor;
    if (!t) fail(404, 'Transaction inconnue');
    if (a.role === 'buyer' && t.buyerId !== a.org) fail(404, 'Transaction inconnue');
    if (a.role === 'seller' && t.sellerId !== a.org) fail(404, 'Transaction inconnue');
    if (a.role === 'lab' && t.labId !== a.org) fail(404, 'Transaction inconnue');
    return t;
  }
  function need(t, statuses) { if (statuses.indexOf(t.status) < 0) fail(409, 'Action impossible à l\'étape « ' + CP.TX_STATUS[t.status].label + ' »'); }

  H['tx.list'] = function (c) {
    var a = c.actor;
    return CP.values(S().transactions).filter(function (t) {
      return isOps(a) || a.role === 'bank' || (a.role === 'buyer' && t.buyerId === a.org) || (a.role === 'seller' && t.sellerId === a.org) || (a.role === 'lab' && t.labId === a.org);
    }).reverse().map(function (t) { return txView(t, a); });
  };
  H['tx.get'] = function (c) { return txView(getTx(c), c.actor); };
  H['tx.sign'] = function (c) {
    var t = getTx(c);
    if (c.actor.role === 'buyer') {
      need(t, ['to_sign_buyer']);
      t.signed.buyer = true; t.status = 'to_sign_seller';
      hist(t, 'Fiche signée par l\'acheteur.');
      notify(t.sellerId, 'Fiche ' + t.id + ' signée par l\'acheteur : à votre tour.', '/vendeur/transactions/' + t.id);
    } else {
      need(t, ['to_sign_seller']);
      t.signed.seller = true; t.status = 'awaiting_funds'; due(t, 'funds', P.delays.funds);
      hist(t, 'Fiche signée par le vendeur. Dépôt des fonds attendu, référence ' + t.id + '.');
      notify(t.buyerId, 'Fiche ' + t.id + ' signée. Virez ' + CP.eur(t.total) + ' sur le compte dédié, référence ' + t.id + '.', '/acheteur/transactions/' + t.id);
      notify('BK', 'Virement attendu : ' + CP.eur(t.total) + ', référence ' + t.id + '.', '/banque');
    }
    return txView(t, c.actor);
  };
  H['tx.ship'] = function (c) {
    var t = getTx(c);
    need(t, ['to_ship']);
    if (!c.body.tracking) fail(422, 'Numéro de suivi requis');
    t.tracking = (c.body.carrier || 'Transporteur') + ' ' + c.body.tracking;
    if (t.labLevel) {
      t.status = 'to_lab'; due(t, null, null);
      var lc = CP.values(S().labCases).filter(function (x) { return x.txId === t.id; })[0];
      if (lc) lc.status = 'in_transit';
      hist(t, 'Expédié au laboratoire, suivi ' + t.tracking + '.');
      notify(t.labId, 'Colis en route pour ' + (lc ? lc.id : t.id) + ', suivi ' + t.tracking + '.', lc ? '/labo/dossiers/' + lc.id : '/labo');
    } else {
      t.status = 'to_buyer'; due(t, null, null);
      hist(t, 'Expédié à l\'adresse de livraison, suivi ' + t.tracking + '.');
    }
    notify(t.buyerId, 'Le vendeur a expédié ' + t.id + '.', '/acheteur/transactions/' + t.id);
    return txView(t, c.actor);
  };
  H['tx.delivered'] = function (c) {
    var t = getTx(c);
    need(t, ['to_buyer']);
    t.status = 'inspection'; due(t, 'inspection', t.delays.inspection);
    hist(t, 'Livré (webhook transporteur). Délai d\'inspection : ' + t.delays.inspection + ' j ouvrés.');
    notify(t.buyerId, 'Pièces livrées pour ' + t.id + ' : inspectez avant le ' + CP.fmtDay(t.due.day) + '.', '/acheteur/transactions/' + t.id);
    return txView(t, c.actor);
  };
  H['tx.inspect'] = function (c) {
    var t = getTx(c), b = c.body;
    need(t, ['inspection']);
    if (b.decision === 'accept') {
      hist(t, 'Pièces acceptées par l\'acheteur.');
      settle(t, 'release');
    } else if (b.decision === 'reject') {
      if (P.rejectReasons.indexOf(b.reason) < 0) fail(422, 'Motif de rejet non admis');
      var q = parseInt(b.qty, 10);
      if (!(q > 0 && q <= t.qty)) fail(422, 'Quantité rejetée invalide');
      t.rejectedQty = q; t.rejection = { reason: b.reason, comment: b.comment || '', qty: q };
      t.status = 'return_due'; due(t, 'return', t.delays.inspection);
      hist(t, 'Rejet motivé de ' + q + ' unité(s) : ' + b.reason.toLowerCase() + '. Étiquette de retour générée.');
      notify(t.sellerId, 'Rejet sur ' + t.id + ' : ' + b.reason.toLowerCase() + '.', '/vendeur/transactions/' + t.id);
    } else fail(422, 'Décision attendue : accept ou reject');
    return txView(t, c.actor);
  };
  H['tx.return'] = function (c) {
    var t = getTx(c);
    need(t, ['return_due']);
    if (!c.body.tracking) fail(422, 'Numéro de suivi requis');
    t.returnTracking = c.body.tracking;
    t.status = 'counter_inspection'; due(t, 'counter', t.delays.counter);
    hist(t, 'Retour expédié au vendeur, suivi ' + t.returnTracking + '.');
    notify(t.sellerId, 'Retour en route pour ' + t.id + ' : contre-inspection sous ' + t.delays.counter + ' j ouvrés.', '/vendeur/transactions/' + t.id);
    return txView(t, c.actor);
  };
  H['tx.counter'] = function (c) {
    var t = getTx(c);
    need(t, ['counter_inspection', 'lab_failed']);
    if (c.body.decision === 'accept') {
      hist(t, t.status === 'lab_failed' ? 'Le vendeur accepte le verdict du laboratoire.' : 'Contre-inspection : le vendeur accepte le retour.');
      settle(t, 'refund');
    } else if (c.body.decision === 'contest') {
      return H['tx.dispute'](c);
    } else fail(422, 'Décision attendue : accept ou contest');
    return txView(t, c.actor);
  };
  H['tx.dispute'] = function (c) {
    var t = getTx(c);
    need(t, ['counter_inspection', 'lab_failed', 'inspection']);
    var id = next('DSP');
    S().disputes[id] = { id: id, txId: t.id, openedBy: c.actor.role, reason: c.body.comment || '', from: t.status, day: S().day, status: 'open' };
    t.disputeId = id; t.status = 'dispute'; due(t, 'mediation', P.delays.mediation);
    hist(t, 'Litige ' + id + ' ouvert par ' + (c.actor.role === 'seller' ? 'le vendeur' : 'l\'acheteur') + '. Médiation par Central.Parts.');
    notify('ops', 'Litige ' + id + ' à instruire sur ' + t.id + '.', '/ops/transactions/' + t.id);
    return txView(t, c.actor);
  };
  H['dispute.decide'] = function (c) {
    var d = S().disputes[c.params.id];
    if (!d || d.status !== 'open') fail(404, 'Litige inconnu ou clos');
    var t = S().transactions[d.txId];
    if (['buyer', 'seller'].indexOf(c.body.winner) < 0) fail(422, 'Issue attendue : buyer ou seller');
    d.status = 'closed'; d.winner = c.body.winner; d.basis = c.body.basis || 'Médiation';
    hist(t, 'Litige ' + d.id + ' tranché en faveur ' + (d.winner === 'buyer' ? 'de l\'acheteur' : 'du vendeur') + ' (' + d.basis.toLowerCase() + ').');
    settle(t, d.winner === 'buyer' ? 'refund' : 'release');
    return d;
  };

  // Laboratoires
  function getCase(c) {
    var lc = S().labCases[c.params.id];
    if (!lc || (c.actor.role === 'lab' && lc.labId !== c.actor.org)) fail(404, 'Dossier inconnu');
    return lc;
  }
  function caseView(lc, a) {
    var v = CP.clone(lc);
    v.tx = txView(S().transactions[lc.txId], a.role === 'ops' ? a : { role: 'lab', org: lc.labId });
    v.levelName = P.labLevels[lc.level].name;
    v.tests = P.labLevels[lc.level].tests;
    // Le laboratoire, tiers de confiance, reçoit l'adresse de réexpédition ; jamais le nom du vendeur.
    v.shipTo = S().transactions[lc.txId].delivery;
    return v;
  }
  H['lab.cases'] = function (c) {
    return CP.values(S().labCases).filter(function (lc) { return isOps(c.actor) || lc.labId === c.actor.org; }).reverse().map(function (lc) { return caseView(lc, c.actor); });
  };
  H['lab.receive'] = function (c) {
    var lc = getCase(c), t = S().transactions[lc.txId];
    if (lc.status !== 'in_transit') fail(409, 'Colis non attendu');
    var q = parseInt(c.body.qty, 10);
    if (!(q >= 0)) fail(422, 'Quantité reçue requise');
    lc.status = 'received'; lc.receivedQty = q; lc.receptionNote = c.body.note || '';
    t.status = 'at_lab';
    hist(t, 'Pièces reçues au laboratoire : ' + q + ' unité(s)' + (q !== t.qty ? ', écart de quantité signalé' : '') + '.');
    return caseView(lc, c.actor);
  };
  H['lab.certify'] = function (c) {
    var lc = getCase(c), t = S().transactions[lc.txId], b = c.body;
    if (lc.status !== 'received') fail(409, 'Pièces non reçues ou dossier déjà certifié');
    if (['pass', 'fail', 'counterfeit'].indexOf(b.verdict) < 0) fail(422, 'Verdict attendu : pass, fail ou counterfeit');
    var tests = P.labLevels[lc.level].tests;
    tests.forEach(function (k) { if (!b.results || !b.results[k]) fail(422, 'Résultat manquant : ' + P.testNames[k]); });
    lc.results = b.results; lc.verdict = b.verdict; lc.status = 'certified'; lc.certificate = 'CERT-' + lc.id.slice(4) + '-' + S().day;
    if (b.verdict === 'pass') {
      t.status = 'lab_passed';
      hist(t, 'Certificat ' + lc.certificate + ' : conforme.');
    } else {
      t.status = 'lab_failed'; t.rejectedQty = t.qty; due(t, 'counter', t.delays.counter);
      hist(t, 'Certificat ' + lc.certificate + ' : ' + (b.verdict === 'counterfeit' ? 'contrefaçon. Pièces en quarantaine, jamais renvoyées au vendeur.' : 'non conforme.'));
      notify(t.sellerId, 'Verdict du laboratoire sur ' + t.id + ' : vous pouvez l\'accepter ou le contester.', '/vendeur/transactions/' + t.id);
    }
    notify(t.buyerId, 'Certificat du laboratoire disponible pour ' + t.id + '.', '/acheteur/transactions/' + t.id);
    return caseView(lc, c.actor);
  };
  H['lab.reship'] = function (c) {
    var lc = getCase(c), t = S().transactions[lc.txId];
    if (t.status !== 'lab_passed') fail(409, 'Réexpédition possible seulement après un certificat conforme');
    if (!c.body.tracking) fail(422, 'Numéro de suivi requis');
    lc.status = 'reshipped'; t.status = 'to_buyer'; t.tracking = c.body.tracking;
    hist(t, 'Réexpédié par le laboratoire vers ' + zoneOf(t.delivery) + ', suivi ' + t.tracking + '.');
    return caseView(lc, c.actor);
  };

  // Compte dédié et ordres
  H['escrow.get'] = function () {
    var ledger = {};
    S().escrow.movements.forEach(function (m) { if (m.txId) ledger[m.txId] = round((ledger[m.txId] || 0) + m.amount); });
    return { balance: round(S().escrow.balance), ledger: ledger, movements: S().escrow.movements.slice().reverse() };
  };
  H['order.list'] = function (c) {
    return CP.values(S().orders).filter(function (o) { return c.actor.role !== 'bank' || ['transmitted', 'executed'].indexOf(o.status) >= 0; }).reverse().map(function (o) {
      var v = CP.clone(o);
      v.lines.forEach(function (l) { var org = S().orgs[l.to]; l.beneficiary = org ? org.name : l.to; l.iban = org && org.iban ? org.iban : (l.to === 'CP' ? 'Compte d\'exploitation Central.Parts' : '—'); });
      return v;
    });
  };
  H['order.approve'] = function (c) {
    var o = S().orders[c.params.id];
    if (!o) fail(404, 'Ordre inconnu');
    if (o.status !== 'pending') fail(409, 'Ordre déjà validé');
    if (o.approvals.indexOf(c.actor.user) >= 0) fail(409, 'Déjà validé par ' + c.actor.user + ' : un second opérateur est requis');
    o.approvals.push(c.actor.user);
    if (o.approvals.length >= 2) o.status = 'approved';
    event('Ordre ' + o.id + ' validé par ' + c.actor.user + ' (' + o.approvals.length + '/2).', o.txId);
    return o;
  };
  H['order.transmit'] = function (c) {
    var o = S().orders[c.params.id];
    if (!o) fail(404, 'Ordre inconnu');
    if (o.status !== 'approved') fail(409, 'Double validation requise avant transmission');
    o.status = 'transmitted';
    notify('BK', 'Ordre ' + o.id + ' reçu : ' + CP.eur(o.amount) + '.', '/banque');
    event('Ordre ' + o.id + ' transmis à la banque.', o.txId);
    return o;
  };

  // Banque
  H['bank.incoming'] = function (c) {
    var t = S().transactions[c.body.reference];
    if (!t) fail(404, 'Référence inconnue : virement à renvoyer à l\'émetteur');
    if (t.status !== 'awaiting_funds') fail(409, 'Aucun dépôt attendu pour ' + t.id);
    if (round(Number(c.body.amount)) !== t.total) fail(422, 'Montant ' + CP.eur(Number(c.body.amount)) + ' différent du montant attendu ' + CP.eur(t.total));
    S().escrow.balance = round(S().escrow.balance + t.total);
    S().escrow.movements.push({ day: S().day, label: 'Virement reçu · ' + S().orgs[t.buyerId].name + ' · réf. ' + t.id, amount: t.total, txId: t.id });
    t.status = 'to_ship'; due(t, 'ship', P.delays.ship);
    hist(t, 'Fonds reçus sur le compte dédié (' + CP.eur(t.total) + '). Ordre d\'expédition envoyé au vendeur.');
    notify(t.sellerId, 'Fonds déposés pour ' + t.id + ' : expédiez avant le ' + CP.fmtDay(t.due.day) + '.', '/vendeur/transactions/' + t.id);
    notify(t.buyerId, 'Fonds reçus pour ' + t.id + '.', '/acheteur/transactions/' + t.id);
    return { reference: t.id, credited: t.total };
  };
  H['bank.execute'] = function (c) {
    var o = S().orders[c.params.id];
    if (!o) fail(404, 'Ordre inconnu');
    if (o.status !== 'transmitted') fail(409, 'Ordre non transmis ou déjà exécuté');
    o.lines.forEach(function (l) {
      var org = S().orgs[l.to];
      if (l.to !== 'CP' && (!org || !org.iban || org.kyb !== 'validated')) fail(422, 'IBAN non autorisé pour ' + (org ? org.name : l.to));
    });
    if (S().escrow.balance + 0.001 < o.amount) fail(422, 'Solde du compte dédié insuffisant');
    S().escrow.balance = round(S().escrow.balance - o.amount);
    o.lines.forEach(function (l) {
      var org = S().orgs[l.to];
      S().escrow.movements.push({ day: S().day, label: l.label + ' · ' + (org ? org.name : l.to) + ' · ' + o.id, amount: -l.amount, txId: o.txId });
    });
    o.status = 'executed'; o.executedDay = S().day;
    CP.api('POST', '/v1/webhooks/bank/order-executed', { orderId: o.id }, { actor: c.actor, ok200: true });
    return o;
  };
  H['bank.executed'] = function (c) {
    var o = S().orders[c.body.orderId];
    if (!o || o.status !== 'executed') fail(404, 'Ordre inconnu ou non exécuté');
    var t = S().transactions[o.txId];
    var open = CP.values(S().orders).filter(function (x) { return x.txId === t.id && x.status !== 'executed'; });
    if (!open.length) {
      var types = CP.values(S().orders).filter(function (x) { return x.txId === t.id; }).map(function (x) { return x.type; });
      t.status = types.indexOf('release') >= 0 && types.indexOf('refund') >= 0 ? 'closed_partial' : types.indexOf('release') >= 0 ? 'released' : 'refunded';
      hist(t, t.status === 'released' ? 'Vendeur payé. Transaction soldée.' : t.status === 'refunded' ? 'Acheteur remboursé sur son IBAN autorisé. Transaction soldée.' : 'Paiement et remboursement exécutés. Transaction soldée.');
      if (t.status !== 'refunded') notify(t.sellerId, 'Paiement exécuté pour ' + t.id + '.', '/vendeur/transactions/' + t.id);
      if (t.status !== 'released') notify(t.buyerId, 'Remboursement exécuté pour ' + t.id + '.', '/acheteur/transactions/' + t.id);
    }
    return { order: o.id, transaction: t.id, status: t.status };
  };

  // Plateforme
  H['notif.list'] = function (c) {
    var to = c.actor.role === 'ops' ? 'ops' : c.actor.org;
    return S().notifications.filter(function (n) { return n.to === to; }).slice(0, 30);
  };
  H['events.list'] = function () { return S().events.slice(0, 80); };
  H['jobs.deadlines'] = function () {
    var day = S().day, done = [];
    CP.values(S().demands).forEach(function (d) {
      if (d.status === 'auction' && d.closesDay <= day) { CP.system('POST', '/v1/demands/' + d.id + '/close'); done.push(d.id + ' clôturée'); }
    });
    CP.values(S().transactions).forEach(function (t) {
      if (!t.due || t.due.day > day) return;
      var k = t.due.kind;
      if (k === 'funds') cancel(t, 'Fonds non déposés dans le délai : transaction annulée.', false);
      else if (k === 'ship') cancel(t, 'Non-expédition dans le délai : annulation, principal remboursé à l\'acheteur.', true);
      else if (k === 'inspection') { hist(t, 'Pas de réponse dans le délai d\'inspection : pièces réputées acceptées.'); settle(t, 'release'); }
      else if (k === 'return') { hist(t, 'Retour non expédié dans le délai : rejet abandonné, pièces réputées acceptées.'); t.rejectedQty = 0; settle(t, 'release'); }
      else if (k === 'counter') { hist(t, 'Pas de contre-inspection dans le délai : retour réputé accepté.'); settle(t, 'refund'); }
      else if (k === 'mediation') { hist(t, 'Médiation sans accord dans le délai : expertise par un laboratoire tiers à ordonner.'); t.due = null; }
      else return;
      done.push(t.id + ' : ' + k);
    });
    return { day: day, processed: done };
  };

  CP.implemented = function (id) { return typeof H[id] === 'function'; };

  // ------------------------------------------------------------ libellés des étapes
  // turn : qui doit agir ; step : position dans la frise commune.
  CP.TX_STATUS = {
    to_sign_buyer: { label: 'Signature de l\'acheteur', turn: 'buyer', step: 0 },
    to_sign_seller: { label: 'Signature du vendeur', turn: 'seller', step: 0 },
    awaiting_funds: { label: 'Dépôt des fonds', turn: 'buyer', step: 1 },
    to_ship: { label: 'Expédition par le vendeur', turn: 'seller', step: 2 },
    to_lab: { label: 'En route vers le laboratoire', turn: 'lab', step: 3 },
    at_lab: { label: 'Test en laboratoire', turn: 'lab', step: 3 },
    lab_passed: { label: 'Certificat conforme, réexpédition', turn: 'lab', step: 3 },
    lab_failed: { label: 'Verdict du laboratoire défavorable', turn: 'seller', step: 3 },
    to_buyer: { label: 'En route vers l\'adresse de livraison', turn: 'system', step: 4 },
    inspection: { label: 'Inspection à réception', turn: 'buyer', step: 5 },
    return_due: { label: 'Retour des pièces rejetées', turn: 'buyer', step: 5 },
    counter_inspection: { label: 'Contre-inspection du vendeur', turn: 'seller', step: 5 },
    dispute: { label: 'Litige en médiation', turn: 'ops', step: 5 },
    settling: { label: 'Ordres de paiement en cours', turn: 'ops', step: 6 },
    released: { label: 'Soldée : vendeur payé', turn: null, step: 7 },
    refunded: { label: 'Soldée : acheteur remboursé', turn: null, step: 7 },
    closed_partial: { label: 'Soldée : règlement partiel', turn: null, step: 7 },
    cancelled: { label: 'Annulée', turn: null, step: 7 },
  };
  CP.TX_STEPS = ['Signatures', 'Dépôt des fonds', 'Expédition', 'Laboratoire', 'Livraison', 'Inspection', 'Paiement', 'Soldée'];

  // ------------------------------------------------------------ horloge simulée
  CP.advanceDay = function () {
    S().day++;
    CP.system('POST', '/v1/jobs/deadlines');
    CP.save();
  };
})();
