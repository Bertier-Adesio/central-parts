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
      res = { status: method === 'POST' && !opts.ok200 && !(data && data.__ok200) ? 201 : 200, data: data };
      if (data && data.__ok200) delete data.__ok200;
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
  function hist(t, text) {
    t.history.push({ day: S().day, text: text });
    event(t.id + ' · ' + text, t.id);
    if (typeof deliver === 'function') deliver(t.sellerId, 'transaction.updated', { transaction_id: t.id, status: t.status, text: text });
  }
  function alias(orgId) { var o = S().orgs[orgId]; return o ? o.alias : '—'; }

  // ------------------------------------------------------------ vues filtrées selon l'appelant
  function isOps(a) { return a.role === 'ops' || a.role === 'system'; }

  // Statut « vérifié » d'un vendeur : KYB validé et abonnement à jour.
  function subStatus(o) {
    var sub = o && o.subscription;
    if (!sub) return 'none';
    return sub.until >= S().day ? 'active' : 'expired';
  }
  function verified(o) { return !!o && o.kyb === 'validated' && subStatus(o) === 'active'; }
  CP.isVerified = function (orgId) { return verified(S().orgs[orgId]); };

  function buyerCur(orgId) { var o = S().orgs[orgId]; return (o && o.currency) || 'EUR'; }
  CP.buyerCurrency = buyerCur;

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
    if (a.role === 'buyer') { delete v.net; delete v.netCurrency; delete v.netEur; }
    if (a.role === 'lab') { delete v.net; delete v.netCurrency; delete v.netEur; delete v.history; }
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
      var cur = t.currency || 'EUR';
      var payout = CP.fromEur(t.netEur * accepted * (1 - P.sellerCommission), cur);
      var payCur = round(t.net * accepted * (1 - P.sellerCommission));
      var lines = [{ to: t.sellerId, label: 'Paiement du vendeur ' + alias(t.sellerId) + (t.netCurrency !== cur ? ', versé ' + CP.money(payCur, t.netCurrency) : ''), amount: payout, currency: t.netCurrency, amountCurrency: payCur }];
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
    var o = { id: next('ORD'), type: type, txId: t.id, currency: t.currency || 'EUR', lines: lines, amount: round(lines.reduce(function (s, l) { return s + l.amount; }, 0)), approvals: [], status: 'pending', day: S().day };
    S().orders[o.id] = o;
    notify('ops', 'Ordre ' + o.id + ' (' + (type === 'release' ? 'paiement' : 'remboursement') + ', ' + CP.money(o.amount, o.currency) + ') à valider pour ' + t.id + '.', '/ops/paiements');
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
    var v = CP.clone(o); v.verified = verified(o); v.subscriptionStatus = subStatus(o);
    if (isOps(c.actor) || c.actor.org === o.id) return v;
    return { id: o.id, alias: o.alias, type: o.type, country: o.country, verified: v.verified };
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
    return CP.values(S().orgs).filter(function (o) { return !c.query.kyb || o.kyb === c.query.kyb; }).map(function (o) { var v = CP.clone(o); v.verified = verified(o); v.subscriptionStatus = subStatus(o); return v; });
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

  H['sub.get'] = function (c) {
    var o = S().orgs[c.params.id];
    if (!o || o.type !== 'seller') fail(404, 'Vendeur inconnu');
    if (!isOps(c.actor) && c.actor.org !== o.id) fail(403, 'Ressource d\'une autre société');
    var sub = o.subscription || null;
    return { organization: o.id, kyb: o.kyb, subscription: sub ? { plan: sub.plan, until: CP.date(sub.until).toISOString().slice(0, 10), status: subStatus(o), daysLeft: sub.until - S().day } : null, verified: verified(o) };
  };
  H['sub.renew'] = function (c) {
    var o = S().orgs[c.params.id];
    if (!o || o.type !== 'seller') fail(404, 'Vendeur inconnu');
    if (!isOps(c.actor) && c.actor.org !== o.id) fail(403, 'Ressource d\'une autre société');
    if (o.kyb !== 'validated') fail(409, 'KYB à valider avant l\'abonnement');
    var from = o.subscription && o.subscription.until >= S().day ? o.subscription.until : S().day;
    o.subscription = { plan: 'Vendeur Opportunity', until: from + P.subscriptionDays, renewedDay: S().day, by: c.actor.role === 'ops' ? c.actor.user : 'vendeur' };
    event('Abonnement de ' + o.alias + ' renouvelé jusqu\'au ' + CP.fmtDay(o.subscription.until) + '.', o.id);
    notify(o.id, 'Abonnement renouvelé : statut « vérifié » jusqu\'au ' + CP.fmtDay(o.subscription.until) + '.', '/vendeur');
    return H['sub.get'](c);
  };

  // Recherche
  H['search'] = function (c) {
    var q = (c.query.q || '').trim().toUpperCase();
    if (q.length < 2) fail(422, 'Saisir au moins 2 caractères');
    var inv = S().inventory.filter(function (i) { return i.mpn.toUpperCase().indexOf(q) >= 0; });
    var by = {};
    CP.values(S().lots).forEach(function (l) {
      if (l.mpn.toUpperCase().indexOf(q) < 0 || !(l.qty > 0)) return;
      if (!verified(S().orgs[l.sellerId])) return;
      var g = by[l.mpn] || (by[l.mpn] = { mpn: l.mpn, mfr: l.mfr, lots: 0, qty: 0, origins: [], verified: true });
      g.lots++; g.qty += l.qty;
      var o = l.q && l.q.origin ? l.q.origin : 'Non renseignée';
      if (g.origins.indexOf(o) < 0) g.origins.push(o);
    });
    return { query: q, inventory: inv, opportunity: CP.values(by) };
  };
  H['advice'] = function (c) {
    var mpn = c.query.mpn;
    var cur = CP.currency(c.query.currency, 'EUR');
    if (!cur) fail(422, 'Devise non prise en charge');
    var prices = CP.values(S().lots).filter(function (l) { return l.mpn === mpn && l.price; }).map(function (l) { return CP.toEur(l.price, l.currency || 'EUR'); });
    if (!prices.length) fail(404, 'Pas assez de données pour cette référence');
    var avg = prices.reduce(function (a, b) { return a + b; }, 0) / prices.length;
    return { mpn: mpn, currency: cur, low: CP.fromEur(avg * 0.95, cur), high: CP.fromEur(avg * 1.15, cur), basis: 'Données fictives de la maquette' };
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
      // Seuls les vendeurs vérifiés reçoivent les demandes.
      if (l.mpn.toUpperCase() === mpn && l.qty > 0 && sellers.indexOf(l.sellerId) < 0 && verified(S().orgs[l.sellerId])) sellers.push(l.sellerId);
    });
    var id = next('DEM');
    var lot = CP.values(S().lots).filter(function (l) { return l.mpn.toUpperCase() === mpn; })[0];
    var d = { id: id, buyerId: c.actor.org, bomId: bom ? bom.id : null, mpn: lot ? lot.mpn : mpn, mfr: (lot && lot.mfr) || b.mfr || '', qty: qty, dcMin: b.dcMin || '', pack: b.pack || 'Indifférent', zone: b.zone || zoneOf(b.delivery), delivery: b.delivery || '', leadDays: parseInt(b.leadDays, 10) || 10, target: b.target ? Number(b.target) : null, status: 'auction', day: S().day, closesDay: S().day + P.delays.auction, sellers: sellers };
    S().demands[id] = d;
    if (line) line.demandId = id;
    sellers.forEach(function (s) {
      notify(s, 'Nouvelle demande ' + id + ' : ' + d.mpn + ' × ' + qty + ' correspond à votre stock.', '/vendeur/demandes/' + id);
      deliver(s, 'demand.created', { demand_id: id, mpn: d.mpn, quantity: qty, date_code_min: d.dcMin, zone: d.zone, closes_on: CP.date(d.closesDay).toISOString().slice(0, 10) });
    });
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
    var bids = CP.values(S().bids).filter(function (b) { return b.demandId === d.id; }).sort(function (a, b) { return a.netEur - b.netEur; });
    bids.forEach(function (b, i) {
      var id = next('OFF');
      S().offers[id] = { id: id, demandId: d.id, bidId: b.id, sellerId: b.sellerId, lotId: b.lotId, net: b.net, currency: b.currency, netEur: b.netEur, dc: b.dc, buyerCurrency: buyerCur(d.buyerId), unit: CP.fromEur(b.netEur * (1 + P.buyerMargin), buyerCur(d.buyerId)), leadDays: b.leadDays, rank: i + 1, status: 'open', validUntil: S().day + 2 };
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
    if (!d.sandbox && !verified(S().orgs[c.actor.org])) fail(403, 'Statut « vérifié » requis pour enchérir : KYB validé et abonnement à jour');
    var lot = S().lots[b.lotId];
    if (!lot || lot.sellerId !== c.actor.org || lot.mpn !== d.mpn) fail(422, 'Lot invalide pour cette demande');
    if (lot.qty < d.qty) fail(422, 'Quantité du lot insuffisante (' + lot.qty + ')');
    if (!complete(lot)) fail(422, 'Questionnaire d\'état du lot incomplet');
    var net = Number(b.net);
    if (!(net > 0)) fail(422, 'Prix net invalide');
    // Le date code peut manquer au stock : le vendeur le donne quand il répond à la demande.
    var dc = String(b.dateCode || lot.dc || '').trim();
    if (!dc) fail(422, 'Date code requis pour répondre à une demande');
    var cur = CP.currency(b.currency, lot.currency || S().orgs[c.actor.org].currency || 'EUR');
    if (!cur) fail(422, 'Devise non prise en charge : ' + b.currency);
    if (!lot.dc) lot.dc = dc;
    var mine = CP.values(S().bids).filter(function (x) { return x.demandId === d.id && x.sellerId === c.actor.org; })[0];
    if (!mine) { mine = { id: next('BID'), demandId: d.id, sellerId: c.actor.org }; S().bids[mine.id] = mine; }
    mine.lotId = lot.id; mine.net = round(net); mine.currency = cur; mine.netEur = CP.toEur(net, cur); mine.dc = dc; mine.leadDays = parseInt(b.leadDays, 10) || 5; mine.day = S().day;
    event('Offre scellée reçue sur ' + d.id + ' (' + alias(c.actor.org) + ').', d.id);
    return H['bid.mine'](c);
  };
  H['bid.mine'] = function (c) {
    var all = CP.values(S().bids).filter(function (x) { return x.demandId === c.params.id; }).sort(function (a, b) { return a.netEur - b.netEur; });
    var mine = all.filter(function (x) { return x.sellerId === c.actor.org; })[0] || null;
    return { bid: mine, rank: mine ? all.indexOf(mine) + 1 : null, count: all.length };
  };
  H['offer.list'] = function (c) {
    var d = S().demands[c.params.id];
    if (!d || (c.actor.role === 'buyer' && d.buyerId !== c.actor.org)) fail(404, 'Demande inconnue');
    return CP.values(S().offers).filter(function (o) { return o.demandId === d.id; }).sort(function (a, b) { return a.rank - b.rank; }).map(function (o) {
      var v = { id: o.id, rank: o.rank, unit: o.unit, unitCurrency: o.buyerCurrency || buyerCur(d.buyerId), leadDays: o.leadDays, sellerVerified: verified(S().orgs[o.sellerId]), status: o.status, validUntil: o.validUntil, seller: alias(o.sellerId), sellerProfile: S().orgs[o.sellerId].profile, lot: lotPublic(S().lots[o.lotId]), origin: S().lots[o.lotId].q.origin };
      v.dc = o.dc || S().lots[o.lotId].dc;
      if (isOps(c.actor)) { v.net = o.net; v.currency = o.currency; v.netEur = o.netEur; v.sellerName = S().orgs[o.sellerId].name; }
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
    var t = { id: id, demandId: d.id, offerId: o.id, buyerId: d.buyerId, sellerId: o.sellerId, lotId: o.lotId, mpn: d.mpn, mfr: d.mfr, qty: d.qty, net: o.net, netCurrency: o.currency || 'EUR', netEur: o.netEur != null ? o.netEur : o.net, dc: o.dc, currency: o.buyerCurrency || buyerCur(d.buyerId), unit: o.unit, labLevel: level.id, labId: level.id ? 'L1' : null, labFee: CP.fromEur(level.price, o.buyerCurrency || buyerCur(d.buyerId)), delivery: d.delivery || 'Adresse de l\'acheteur', incoterm: 'DAP', delays: { inspection: insp, counter: counter }, status: 'to_sign_buyer', signed: { buyer: false, seller: false }, due: null, day: S().day, history: [] };
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
    deliver(o.sellerId, 'offer.accepted', { demand_id: d.id, transaction_id: id, lot_sku: S().lots[o.lotId].sku || null, quantity: d.qty, net_unit_price: o.net, currency: o.currency, date_code: o.dc });
    return txView(t, c.actor);
  };
  function clampDays(v, def) { var n = parseInt(v, 10); return n >= 1 && n <= 30 ? n : def; }

  // Stock vendeur
  // Lecture CSV : séparateur détecté (; , tabulation), champs entre guillemets acceptés
  // (« Price per 1,000 pcs »). Les fichiers XLS seront convertis côté serveur.
  function parseCSV(text) {
    var first = (text.split(/\r?\n/)[0] || '');
    var sep = [';', '\t', ','].sort(function (a, b) { return first.split(b).length - first.split(a).length; })[0];
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cur.trim()); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cur.trim()); cur = '';
        if (row.some(function (x) { return x; })) rows.push(row);
        row = [];
      } else cur += ch;
    }
    row.push(cur.trim());
    if (row.some(function (x) { return x; })) rows.push(row);
    return rows;
  }
  function price(v) {
    if (v == null || v === '') return null;
    var n = Number(String(v).replace(/[^\d,.\-]/g, '').replace(/,(\d{1,4})$/, '.$1').replace(/,/g, ''));
    return n > 0 ? n : null;
  }

  // Correspondance des colonnes (Octopart, ECIA, format broker) vers le modèle de lot.
  var COLUMNS = {
    mpn: ['mpn', 'manufacturer part number', 'part number', 'mfr_part_number'],
    mfr: ['manufacturer', 'mfr', 'manufacturer_name', 'brand'],
    sku: ['sku', 'seller sku', 'distributor part number'],
    url: ['product url', 'product_url', 'url', 'link'],
    qty: ['quantity', 'qty', 'stock', 'quantity_available', 'quantity available'],
    dc: ['date_code', 'datecode', 'date code', 'dc'],
    pack: ['packaging', 'package_type', 'package type', 'pack'],
    price: ['unit price', 'unit_price', 'price', 'target_price'],
    p10: ['price per 10 pcs', 'price_10', 'price break 10'],
    p100: ['price per 100 pcs', 'price_100', 'price break 100'],
    p1000: ['price per 1,000 pcs', 'price per 1000 pcs', 'price_1000', 'price break 1000'],
    currency: ['currency', 'devise'],
  };

  function importRows(c, csv, format, channel) {
    var org = c.actor.role === 'system' ? c.body.sellerId : c.actor.org;
    if (!S().orgs[org] || S().orgs[org].type !== 'seller') fail(422, 'Vendeur inconnu');
    var rows = parseCSV(String(csv || ''));
    if (rows.length < 2) fail(422, 'Fichier vide : une ligne d\'en-tête et au moins une ligne attendues');
    var head = rows.shift().map(function (h) { return h.toLowerCase().replace(/\s+/g, ' '); });
    var ix = {};
    Object.keys(COLUMNS).forEach(function (k) { ix[k] = -1; COLUMNS[k].forEach(function (n) { if (ix[k] < 0) ix[k] = head.indexOf(n); }); });
    if (ix.mpn < 0 || ix.qty < 0) fail(422, 'Colonnes obligatoires absentes : référence fabricant (MPN) et quantité');
    var get = function (f, k) { return ix[k] >= 0 ? (f[ix[k]] || '') : ''; };
    var created = [], updated = [], dupes = [], rejected = [], noDc = 0;
    rows.forEach(function (f, n) {
      var mpn = get(f, 'mpn').toUpperCase(), qty = parseInt(get(f, 'qty').replace(/[^\d]/g, ''), 10);
      if (!mpn || !(qty > 0)) { rejected.push({ line: n + 2, reason: !mpn ? 'MPN manquant' : 'Quantité invalide' }); return; }
      var dc = get(f, 'dc'), sku = get(f, 'sku');
      if (!dc) noDc++;
      var cur = CP.currency(get(f, 'currency'), c.body.currency || S().orgs[org].currency || 'USD');
      if (!cur) { rejected.push({ line: n + 2, reason: 'Devise non prise en charge : ' + get(f, 'currency') }); return; }
      var tiers = {};
      [['p10', 10], ['p100', 100], ['p1000', 1000]].forEach(function (t) { var v = price(get(f, t[0])); if (v) tiers[t[1]] = v; });
      var data = { mpn: mpn, mfr: get(f, 'mfr'), sku: sku, url: get(f, 'url'), qty: qty, dc: dc, pack: get(f, 'pack'), price: price(get(f, 'price')), tiers: tiers, currency: cur };
      // Même lot chez le même vendeur : même SKU s'il existe, sinon même référence et même date code.
      var same = CP.values(S().lots).filter(function (l) { return l.sellerId === org && (sku ? l.sku === sku : l.mpn === mpn && l.dc === dc); })[0];
      if (same) { Object.keys(data).forEach(function (k) { if (data[k] !== '' && data[k] != null) same[k] = data[k]; }); updated.push(same.id); return; }
      var other = CP.values(S().lots).filter(function (l) { return l.sellerId !== org && l.mpn === mpn && l.dc === dc && l.qty === qty; })[0];
      var id = next('LOT');
      data.id = id; data.sellerId = org; data.q = {}; data.docs = {}; data.duplicateOf = other ? other.id : null;
      S().lots[id] = data;
      created.push(id);
      if (other) dupes.push(id);
    });
    var job = { id: next('STK'), sellerId: org, channel: channel, format: format || 'auto', filename: c.body.filename || null, day: S().day, rows: rows.length, created: created, updated: updated, possibleDuplicates: dupes, rejected: rejected, missingDateCode: noDc, status: 'done' };
    S().stocklists = S().stocklists || {};
    S().stocklists[job.id] = job;
    event('Stocklist ' + job.id + ' (' + channel + ') de ' + alias(org) + ' : ' + created.length + ' lot(s) créé(s), ' + updated.length + ' mis à jour, ' + rejected.length + ' ligne(s) rejetée(s).', org);
    return job;
  }
  H['stock.import'] = function (c) { return importRows(c, c.body.csv, c.body.format, 'api'); };
  H['stock.sftp'] = function (c) { return importRows(c, c.body.csv, c.body.format, 'sftp'); };
  H['stock.job'] = function (c) {
    var j = (S().stocklists || {})[c.params.id];
    if (!j || (!isOps(c.actor) && j.sellerId !== c.actor.org)) fail(404, 'Import inconnu');
    return j;
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
  H['lot.update'] = function (c) {
    var l = S().lots[c.params.id], b = c.body;
    if (!l || l.sellerId !== c.actor.org) fail(404, 'Lot inconnu');
    if (b.qty != null && b.qty !== '') { var q = parseInt(b.qty, 10); if (!(q > 0)) fail(422, 'Quantité invalide'); l.qty = q; }
    if (b.dc != null) l.dc = String(b.dc).trim();
    if (b.pack != null) l.pack = String(b.pack).trim();
    return H['lot.get'](c);
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

  // API fournisseur
  // Événements poussés au système du fournisseur (livraison simulée, signature HMAC prévue).
  function deliver(org, type, payload) {
    S().deliveries = S().deliveries || [];
    CP.values(S().webhooks || {}).filter(function (h) { return h.sellerId === org && h.events.indexOf(type) >= 0; }).forEach(function (h) {
      S().deliveries.unshift({ id: next('DLV'), hookId: h.id, sellerId: org, type: type, day: S().day, url: h.url, payload: payload, status: 200, signature: 'sha256=…' });
    });
    CP.values(S().channels || {}).filter(function (ch) { return ch.orgId === org && ch.status === 'active' && ch.events.indexOf(type) >= 0; }).forEach(function (ch) {
      S().deliveries.unshift(channelMessage(ch, type, payload));
    });
  }

  // Messages des canaux, dans la langue du vendeur. Liens vers la plateforme, jamais d'identité de l'acheteur.
  var LINK = 'https://central.parts/app/#';
  var ZH_STATUS = { to_sign_buyer: '待买方签署', to_sign_seller: '待您签署', awaiting_funds: '待买方付款至托管账户', to_ship: '已付款，请发货', to_lab: '运往检测实验室', at_lab: '实验室检测中', lab_passed: '检测合格', lab_failed: '检测不合格', to_buyer: '运往收货地址', inspection: '买方验货中', return_due: '买方退货中', counter_inspection: '待您复检退货', dispute: '争议调解中', settling: '付款处理中', released: '已付款给您', refunded: '已退款给买方', closed_partial: '部分付款已完成', cancelled: '已取消' };
  var ZH_COUNTRY = { France: '法国', Chine: '中国', Allemagne: '德国', 'Hong Kong': '香港', 'Pays-Bas': '荷兰' };
  function zhZone(z) { return String(z || '').split(/,\s*/).map(function (x) { return ZH_COUNTRY[x] || x; }).join(' '); }
  function dayLabel(day, lang) {
    return CP.date(day).toLocaleDateString(lang === 'zh' ? 'zh-CN' : lang === 'en' ? 'en-GB' : 'fr-FR', { month: 'long', day: 'numeric' });
  }
  function renderMessage(type, p, lang) {
    var d = p.demand_id && S().demands[p.demand_id], t = p.transaction_id && S().transactions[p.transaction_id];
    var closes = d ? dayLabel(d.closesDay, lang) : '';
    if (type === 'demand.created') {
      var url = LINK + '/vendeur/demandes/' + p.demand_id;
      if (lang === 'zh') return { title: '【Central.Parts 新询价】' + p.mpn, lines: ['型号：' + p.mpn, '数量：' + CP.num(p.quantity), '最低批号 (D/C)：' + (p.date_code_min || '不限'), '交货区域：' + zhZone(p.zone), '报价截止：' + closes, '买方信息已匿名，请在平台内报价。'], button: '立即报价', url: url };
      if (lang === 'en') return { title: '[Central.Parts] New RFQ: ' + p.mpn, lines: ['Part: ' + p.mpn, 'Quantity: ' + CP.num(p.quantity), 'Min. date code: ' + (p.date_code_min || 'any'), 'Delivery zone: ' + p.zone, 'Closes: ' + closes, 'Buyer kept anonymous. Quote on the platform.'], button: 'Quote now', url: url };
      return { title: '[Central.Parts] Nouvelle demande : ' + p.mpn, lines: ['Référence : ' + p.mpn, 'Quantité : ' + CP.num(p.quantity), 'Date code minimum : ' + (p.date_code_min || 'indifférent'), 'Zone de livraison : ' + p.zone, 'Clôture : ' + closes, 'Acheteur anonyme. Répondez sur la plateforme.'], button: 'Répondre', url: url };
    }
    if (type === 'offer.accepted') {
      var u2 = LINK + '/vendeur/transactions/' + p.transaction_id;
      if (lang === 'zh') return { title: '【Central.Parts 报价已中标】' + p.transaction_id, lines: ['询价：' + p.demand_id, '数量：' + CP.num(p.quantity), '您的净价：' + CP.money(p.net_unit_price, p.currency), '请签署交易单。'], button: '查看交易', url: u2 };
      if (lang === 'en') return { title: '[Central.Parts] Your offer won: ' + p.transaction_id, lines: ['RFQ: ' + p.demand_id, 'Quantity: ' + CP.num(p.quantity), 'Your net price: ' + CP.money(p.net_unit_price, p.currency), 'Please sign the transaction sheet.'], button: 'Open', url: u2 };
      return { title: '[Central.Parts] Offre retenue : ' + p.transaction_id, lines: ['Demande : ' + p.demand_id, 'Quantité : ' + CP.num(p.quantity), 'Votre prix net : ' + CP.money(p.net_unit_price, p.currency), 'Fiche transaction à signer.'], button: 'Ouvrir', url: u2 };
    }
    if (type === 'transaction.updated') {
      var u3 = LINK + '/vendeur/transactions/' + p.transaction_id;
      if (lang === 'zh') return { title: '【Central.Parts 交易更新】' + p.transaction_id, lines: ['状态：' + (ZH_STATUS[t ? t.status : p.status] || p.status)], button: '查看交易', url: u3 };
      if (lang === 'en') return { title: '[Central.Parts] Transaction update: ' + p.transaction_id, lines: [p.text], button: 'Open', url: u3 };
      return { title: '[Central.Parts] ' + p.transaction_id, lines: [p.text], button: 'Ouvrir', url: u3 };
    }
    return { title: type, lines: [JSON.stringify(p)], button: 'Ouvrir', url: LINK + '/vendeur' };
  }
  function channelMessage(ch, type, payload) {
    var m = renderMessage(type, payload, ch.lang);
    var body;
    if (ch.type === 'wecom') body = { msgtype: 'markdown', markdown: { content: '**' + m.title + '**\n' + m.lines.map(function (l) { return '> ' + l; }).join('\n') + '\n[' + m.button + '](' + m.url + ')' } };
    else if (ch.type === 'wechat_oa') body = { touser: ch.target, template_id: 'TPL_' + type.replace('.', '_').toUpperCase(), url: m.url, data: { first: { value: m.title }, keyword1: { value: m.lines[0] || '' }, keyword2: { value: m.lines[1] || '' }, keyword3: { value: m.lines[2] || '' }, keyword4: { value: m.lines[4] || m.lines[3] || '' }, remark: { value: m.lines[m.lines.length - 1] } } };
    else body = { to: ch.target, subject: m.title, text: m.lines.join('\n') + '\n\n' + m.button + ' : ' + m.url };
    var endpoint = ch.type === 'wecom' ? ch.target.replace(/key=.*/, 'key=…') : ch.type === 'wechat_oa' ? 'https://api.weixin.qq.com/cgi-bin/message/template/send' : 'smtp';
    return { id: next('DLV'), channelId: ch.id, channel: ch.type, lang: ch.lang, sellerId: ch.orgId, type: type, day: S().day, url: endpoint, message: m, payload: body, status: 200 };
  }

  var CHANNEL_TYPES = ['email', 'wecom', 'wechat_oa'];
  H['chan.list'] = function (c) {
    var o = ownOrg(c);
    return {
      channels: CP.values(S().channels || {}).filter(function (ch) { return ch.orgId === o.id; }),
      deliveries: (S().deliveries || []).filter(function (d) { return d.sellerId === o.id && d.channelId; }).slice(0, 20),
    };
  };
  H['chan.create'] = function (c) {
    var o = ownOrg(c), b = c.body;
    if (CHANNEL_TYPES.indexOf(b.type) < 0) fail(422, 'Type attendu : email, wecom ou wechat_oa');
    if (b.type === 'wecom' && !/^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[\w-]+$/.test(b.target || '')) fail(422, 'URL du robot WeCom attendue : https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…');
    if (b.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.target || '')) fail(422, 'Adresse e-mail invalide');
    var lang = ['zh', 'en', 'fr'].indexOf(b.lang) >= 0 ? b.lang : (o.lang || 'en');
    var events = (b.events || []).filter(function (e) { return EVENTS.indexOf(e) >= 0; });
    if (!events.length) fail(422, 'Au moins un événement');
    S().channels = S().channels || {};
    var id = next('CH');
    // Le compte de service s'active quand l'utilisateur scanne le QR code (webhook WeChat).
    S().channels[id] = { id: id, orgId: o.id, type: b.type, target: b.type === 'wechat_oa' ? null : b.target, lang: lang, events: events, status: b.type === 'wechat_oa' ? 'pending' : 'active', label: b.label || '' };
    return S().channels[id];
  };
  function getChannel(c) {
    var o = ownOrg(c), ch = (S().channels || {})[c.params.cid];
    if (!ch || ch.orgId !== o.id) fail(404, 'Canal inconnu');
    return ch;
  }
  H['chan.delete'] = function (c) { var ch = getChannel(c); delete S().channels[ch.id]; return { id: ch.id, deleted: true }; };
  H['chan.test'] = function (c) {
    var ch = getChannel(c);
    if (ch.status !== 'active') fail(409, 'Canal pas encore activé');
    var d = CP.values(S().demands).filter(function (x) { return x.sellers.indexOf(ch.orgId) >= 0; })[0] || { id: 'DEM-TEST', mpn: 'XC2S50-5TQ144C', qty: 250, dcMin: '2010', zone: 'Chine, Guangdong', closesDay: S().day + 2 };
    var dlv = channelMessage(ch, 'demand.created', { demand_id: d.id, mpn: d.mpn, quantity: d.qty, date_code_min: d.dcMin, zone: d.zone });
    dlv.test = true;
    S().deliveries = S().deliveries || [];
    S().deliveries.unshift(dlv);
    return dlv;
  };
  H['wechat.qr'] = function (c) {
    var ch = (S().channels || {})[c.body.channelId];
    if (!ch || ch.orgId !== c.actor.org || ch.type !== 'wechat_oa') fail(404, 'Canal WeChat inconnu');
    ch.scene = 'cp_' + ch.id + '_' + Math.random().toString(36).slice(2, 8);
    return { channel_id: ch.id, scene: ch.scene, ticket: 'gQH47joAAAAAAAAAASxodHRwOi8v…(fictif)', expire_seconds: 600, url: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=…' };
  };
  H['wechat.event'] = function (c) {
    var b = c.body;
    var ch = CP.values(S().channels || {}).filter(function (x) { return x.scene && x.scene === b.scene; })[0];
    if (!ch) fail(404, 'QR code inconnu ou expiré');
    if (['subscribe', 'SCAN'].indexOf(b.event) < 0 || !b.openid) fail(422, 'Événement subscribe ou SCAN avec openid attendu');
    ch.target = b.openid; ch.status = 'active'; ch.scene = null;
    event('Canal WeChat ' + ch.id + ' lié pour ' + alias(ch.orgId) + '.', ch.orgId);
    return { channel_id: ch.id, status: 'active' };
  };

  function ownOrg(c) {
    if (c.actor.role !== 'ops' && c.actor.org !== c.params.id) fail(403, 'Ressource d\'une autre société');
    var o = S().orgs[c.params.id];
    if (!o) fail(404, 'Société inconnue');
    return o;
  }
  H['key.create'] = function (c) {
    var o = ownOrg(c);
    var env = c.body.environment === 'live' ? 'live' : 'test';
    if (env === 'live' && o.kyb !== 'validated') fail(403, 'Clé de production réservée aux sociétés dont le KYB est validé');
    S().apiKeys = S().apiKeys || {};
    var id = next('KEY');
    var secret = 'cp_' + env + '_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    S().apiKeys[id] = { id: id, orgId: o.id, environment: env, prefix: secret.slice(0, 12), label: c.body.label || 'Clé ' + env, day: S().day, lastUsed: null };
    event('Clé d\'API ' + env + ' créée pour ' + o.alias + '.', o.id);
    var v = CP.clone(S().apiKeys[id]); v.secret = secret; v.note = 'Secret affiché une seule fois (maquette : clé fictive)';
    return v;
  };
  H['key.list'] = function (c) {
    var o = ownOrg(c);
    return CP.values(S().apiKeys || {}).filter(function (k) { return k.orgId === o.id; });
  };

  // Une offre fournisseur devient un lot. Renvoie l'action faite ou une erreur de validation.
  function upsertOffer(org, o, skuFromPath) {
    if (!o || typeof o !== 'object') return { error: 'Offre invalide' };
    var sku = String(skuFromPath || o.sku || '').trim();
    var mpn = String(o.mpn || '').trim().toUpperCase();
    var qty = Number(o.quantity);
    if (!sku) return { error: 'sku requis' };
    if (!mpn) return { error: 'mpn requis' };
    if (!(qty >= 0) || Math.floor(qty) !== qty) return { error: 'quantity doit être un entier positif ou nul' };
    if (o.unit_price != null && !(Number(o.unit_price) > 0)) return { error: 'unit_price doit être positif' };
    var cur = CP.currency(o.currency, S().orgs[org].currency || 'USD');
    if (!cur) return { error: 'currency non prise en charge (EUR, USD, CNY/RMB, HKD, GBP, JPY)' };
    var tiers = {};
    var breaks = o.price_breaks || [];
    if (!Array.isArray(breaks)) return { error: 'price_breaks doit être une liste' };
    for (var i = 0; i < breaks.length; i++) {
      var b = breaks[i];
      if (!(b && Number(b.quantity) > 0 && Number(b.price) > 0)) return { error: 'price_breaks[' + i + '] invalide' };
      tiers[Number(b.quantity)] = Number(b.price);
    }
    var lot = CP.values(S().lots).filter(function (l) { return l.sellerId === org && l.sku === sku; })[0];
    var engaged = lot && CP.values(S().transactions).some(function (t) { return t.lotId === lot.id && ['released', 'refunded', 'closed_partial', 'cancelled'].indexOf(t.status) < 0; });
    var data = { mpn: mpn, mfr: o.manufacturer || '', sku: sku, url: o.product_url || '', qty: qty, dc: o.date_code || '', pack: o.packaging || '', price: o.unit_price != null ? Number(o.unit_price) : null, tiers: o.price_breaks ? tiers : null, currency: cur, origin: o.country_of_origin || '', leadDays: o.lead_time_days || null, updated: S().day, source: 'api' };
    if (lot) {
      if (engaged && lot.mpn !== mpn) return { error: 'Lot engagé dans une transaction : référence non modifiable' };
      Object.keys(data).forEach(function (k) { if (data[k] !== '' && data[k] != null) lot[k] = data[k]; });
      lot.qty = qty; lot.withdrawn = qty === 0;
      return { sku: sku, lot: lot.id, action: 'updated' };
    }
    var id = next('LOT');
    data.id = id; data.sellerId = org; data.q = {}; data.docs = {}; data.duplicateOf = null; data.withdrawn = qty === 0; data.tiers = data.tiers || {};
    S().lots[id] = data;
    return { sku: sku, lot: id, action: 'created' };
  }
  function supplier(c) {
    var o = S().orgs[c.actor.org];
    if (o.kyb !== 'validated') fail(403, 'KYB non validé');
    return o;
  }
  H['sup.bulk'] = function (c) {
    var org = supplier(c).id, list = c.body.offers;
    if (!Array.isArray(list) || !list.length) fail(422, 'offers : liste d\'offres attendue');
    if (list.length > 1000) fail(413, '1 000 offres au plus par appel (' + list.length + ' reçues)');
    var res = { received: list.length, created: 0, updated: 0, errors: [], idempotency_key: c.body.idempotency_key || null };
    list.forEach(function (o, i) {
      var r = upsertOffer(org, o);
      if (r.error) res.errors.push({ index: i, sku: o && o.sku || null, error: r.error });
      else res[r.action]++;
    });
    event('API fournisseur ' + alias(org) + ' : ' + res.created + ' offre(s) créée(s), ' + res.updated + ' mise(s) à jour, ' + res.errors.length + ' erreur(s).', org);
    res.__ok200 = true;
    return res;
  };
  H['sup.upsert'] = function (c) {
    var org = supplier(c).id;
    var r = upsertOffer(org, c.body, c.params.sku);
    if (r.error) fail(422, r.error);
    return H['lot.get']({ params: { id: r.lot }, actor: c.actor });
  };
  H['sup.delete'] = function (c) {
    var org = supplier(c).id;
    var lot = CP.values(S().lots).filter(function (l) { return l.sellerId === org && l.sku === c.params.sku; })[0];
    if (!lot) fail(404, 'Offre inconnue');
    lot.qty = 0; lot.withdrawn = true; lot.updated = S().day;
    return { sku: lot.sku, lot: lot.id, withdrawn: true };
  };
  H['sup.list'] = function (c) {
    var since = c.query.updated_since != null ? Number(c.query.updated_since) : null;
    return CP.values(S().lots).filter(function (l) {
      return l.sellerId === c.actor.org && (!c.query.sku || l.sku === c.query.sku) && (since == null || (l.updated || 0) >= since);
    }).map(function (l) {
      return { sku: l.sku || null, lot_id: l.id, mpn: l.mpn, manufacturer: l.mfr, quantity: l.qty, unit_price: l.price, currency: l.currency || null, price_breaks: Object.keys(l.tiers || {}).map(function (q) { return { quantity: Number(q), price: l.tiers[q] }; }), date_code: l.dc || null, questionnaire_complete: complete(l), withdrawn: !!l.withdrawn };
    });
  };
  // Bac à sable : un acheteur fictif (SBX) permet au fournisseur de tester son intégration de bout en bout.
  H['sbx.demand'] = function (c) {
    var org = c.actor.org, b = c.body;
    var mpn = String(b.mpn || '').toUpperCase();
    var lot = CP.values(S().lots).filter(function (l) { return l.sellerId === org && l.mpn.toUpperCase() === mpn && l.qty > 0; })[0];
    if (!lot) fail(422, 'Référence absente de votre stock : poussez d\'abord une offre');
    var qty = Math.min(parseInt(b.quantity, 10) || lot.qty, lot.qty);
    var id = next('DEM');
    var d = { id: id, buyerId: 'SBX', bomId: null, mpn: lot.mpn, mfr: lot.mfr, qty: qty, dcMin: b.date_code_min || '', pack: 'Indifférent', zone: 'France', delivery: 'Bac à sable (France)', leadDays: 10, target: null, status: 'auction', day: S().day, closesDay: S().day + P.delays.auction, sellers: [org], sandbox: true };
    S().demands[id] = d;
    notify(org, 'Bac à sable : demande ' + id + ' (' + d.mpn + ' × ' + qty + ').', '/vendeur/demandes/' + id);
    deliver(org, 'demand.created', { demand_id: id, mpn: d.mpn, quantity: qty, date_code_min: d.dcMin, zone: d.zone, closes_on: CP.date(d.closesDay).toISOString().slice(0, 10), sandbox: true });
    return demandView(d, c.actor);
  };
  H['sbx.accept'] = function (c) {
    var d = S().demands[c.params.id];
    if (!d || !d.sandbox || d.sellers.indexOf(c.actor.org) < 0) fail(404, 'Demande du bac à sable inconnue');
    var mine = CP.values(S().bids).filter(function (x) { return x.demandId === d.id && x.sellerId === c.actor.org; })[0];
    if (!mine) fail(409, 'Envoyez d\'abord une offre sur cette demande');
    var buyer = { role: 'buyer', org: 'SBX', label: 'Acheteur du bac à sable' };
    if (d.status === 'auction') H['dem.close']({ params: { id: d.id }, actor: SYSTEM, body: {} });
    var o = CP.values(S().offers).filter(function (x) { return x.demandId === d.id && x.sellerId === c.actor.org; })[0];
    var t = H['offer.accept']({ params: { id: o.id }, actor: buyer, body: { labLevel: 0 } });
    H['tx.sign']({ params: { id: t.id }, actor: buyer, body: {} });
    S().transactions[t.id].sandbox = true;
    return txView(S().transactions[t.id], c.actor);
  };

  var EVENTS = ['demand.created', 'offer.accepted', 'transaction.updated'];
  H['hook.create'] = function (c) {
    var org = supplier(c).id, b = c.body;
    if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(b.url || '')) fail(422, 'URL HTTPS requise');
    var ev = (b.events || []).filter(function (e) { return EVENTS.indexOf(e) >= 0; });
    if (!ev.length) fail(422, 'Au moins un événement parmi : ' + EVENTS.join(', '));
    S().webhooks = S().webhooks || {};
    var id = next('HOOK');
    S().webhooks[id] = { id: id, sellerId: org, url: b.url, events: ev, day: S().day };
    return { id: id, url: b.url, events: ev, signing_secret: 'whsec_' + Math.random().toString(36).slice(2, 14), note: 'Secret de signature affiché une seule fois (maquette)' };
  };
  H['hook.list'] = function (c) {
    return {
      webhooks: CP.values(S().webhooks || {}).filter(function (h) { return h.sellerId === c.actor.org; }),
      deliveries: (S().deliveries || []).filter(function (d) { return d.sellerId === c.actor.org; }).slice(0, 20),
    };
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
      notify(t.buyerId, 'Fiche ' + t.id + ' signée. Virez ' + CP.money(t.total, t.currency) + ' sur le compte dédié, référence ' + t.id + '.', '/acheteur/transactions/' + t.id);
      notify('BK', 'Virement attendu : ' + CP.money(t.total, t.currency) + ', référence ' + t.id + '.', '/banque');
      // Bac à sable : le dépôt de l'acheteur fictif est simulé aussitôt.
      if (t.sandbox) H['bank.incoming']({ body: { reference: t.id, amount: t.total }, actor: { role: 'bank', org: 'BK' } });
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
    var ledger = {}, e = S().escrow, eurTotal = 0;
    var accounts = Object.keys(P.accounts).map(function (c) { return { currency: c, account: P.accounts[c], balance: round(e.balances[c] || 0) }; });
    e.movements.forEach(function (m) {
      if (!m.txId) return;
      var l = ledger[m.txId] || (ledger[m.txId] = { amount: 0, currency: m.currency || 'EUR' });
      l.amount = round(l.amount + m.amount);
    });
    Object.keys(e.balances).forEach(function (c) { e.balances[c] = round(e.balances[c]); eurTotal += CP.toEur(e.balances[c], c); });
    return { accounts: accounts, balances: e.balances, balance: round(eurTotal), ledger: ledger, movements: e.movements.slice().reverse() };
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
    notify('BK', 'Ordre ' + o.id + ' reçu : ' + CP.money(o.amount, o.currency) + '.', '/banque');
    event('Ordre ' + o.id + ' transmis à la banque.', o.txId);
    return o;
  };

  // Banque
  H['bank.incoming'] = function (c) {
    var t = S().transactions[c.body.reference];
    if (!t) fail(404, 'Référence inconnue : virement à renvoyer à l\'émetteur');
    if (t.status !== 'awaiting_funds') fail(409, 'Aucun dépôt attendu pour ' + t.id);
    var cur = t.currency || 'EUR';
    if (c.body.currency && CP.currency(c.body.currency) !== cur) fail(422, 'Devise du virement différente de la devise de la transaction (' + cur + ')');
    if (round(Number(c.body.amount)) !== t.total) fail(422, 'Montant ' + CP.money(Number(c.body.amount), cur) + ' différent du montant attendu ' + CP.money(t.total, cur));
    S().escrow.balances[cur] = round((S().escrow.balances[cur] || 0) + t.total);
    S().escrow.movements.push({ day: S().day, label: 'Virement reçu · ' + S().orgs[t.buyerId].name + ' · réf. ' + t.id, amount: t.total, currency: cur, txId: t.id });
    t.status = 'to_ship'; due(t, 'ship', P.delays.ship);
    hist(t, 'Fonds reçus sur le compte dédié (' + CP.money(t.total, cur) + '). Ordre d\'expédition envoyé au vendeur.');
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
    var oc = o.currency || 'EUR';
    if ((S().escrow.balances[oc] || 0) + 0.001 < o.amount) fail(422, 'Solde ' + oc + ' du compte dédié insuffisant');
    S().escrow.balances[oc] = round(S().escrow.balances[oc] - o.amount);
    o.lines.forEach(function (l) {
      var org = S().orgs[l.to];
      // Paiement dans une autre devise : conversion entre deux comptes de Central.Parts, puis virement.
      if (l.currency && l.currency !== oc && l.amountCurrency != null) {
        S().escrow.movements.push({ day: S().day, label: 'Conversion ' + oc + ' → ' + l.currency + ' · ' + o.id, amount: -l.amount, currency: oc, txId: o.txId, fx: true });
        S().escrow.movements.push({ day: S().day, label: 'Conversion ' + oc + ' → ' + l.currency + ' · ' + o.id, amount: l.amountCurrency, currency: l.currency, fx: true });
        S().escrow.movements.push({ day: S().day, label: l.label.replace(/, versé .*$/, '') + ' · ' + (org ? org.name : l.to) + ' · ' + o.id, amount: -l.amountCurrency, currency: l.currency });
      } else {
        S().escrow.movements.push({ day: S().day, label: l.label + ' · ' + (org ? org.name : l.to) + ' · ' + o.id, amount: -l.amount, currency: oc, txId: o.txId });
      }
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
    CP.values(S().orgs).forEach(function (o) {
      if (o.type !== 'seller' || !o.subscription) return;
      var left = o.subscription.until - day;
      if (left === 3) notify(o.id, 'Votre abonnement expire le ' + CP.fmtDay(o.subscription.until) + ' : renouvelez-le pour garder le statut « vérifié ».', '/vendeur');
      if (left === -1) { notify(o.id, 'Abonnement expiré : vous ne recevez plus les demandes. Les transactions en cours continuent.', '/vendeur'); event('Abonnement expiré : ' + o.alias + ' n\'est plus vérifié.', o.id); done.push(o.alias + ' : abonnement expiré'); }
    });
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
