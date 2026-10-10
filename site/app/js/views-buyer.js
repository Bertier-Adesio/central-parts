// Écrans de l'acheteur.
(function () {
  'use strict';
  var esc = CP.esc, ui = CP.ui, P = CP.PARAMS;

  function demStatus(d) {
    var m = { auction: ['Enchère en cours', 'wait'], offers: ['Offres à étudier', 'todo'], no_offer: ['Aucune offre', 'muted'], ordered: ['Commandée', 'ok'] };
    var s = m[d.status] || [d.status, ''];
    return ui.pill(s[0], s[1]);
  }
  CP.demStatus = demStatus;

  // ------------------------------------------------------------ tableau de bord
  CP.views['/acheteur'] = function () {
    var tx = CP.get('/v1/transactions') || [], dem = CP.get('/v1/demands') || [], boms = CP.get('/v1/boms') || [], inv = CP.get('/v1/inventory/orders') || [], notifs = CP.get('/v1/notifications') || [];
    var todo = tx.filter(function (t) { return (CP.TX_STATUS[t.status] || {}).turn === 'buyer'; });
    var offers = dem.filter(function (d) { return d.status === 'offers'; });
    var actions = todo.map(function (t) { return '<li>' + ui.link('/acheteur/transactions/' + t.id, '<b>' + t.id + '</b> · ' + esc(t.mpn)) + ' : ' + esc(CP.TX_STATUS[t.status].label.toLowerCase()) + ' ' + ui.due(t) + '</li>'; })
      .concat(offers.map(function (d) { return '<li>' + ui.link('/acheteur/demandes/' + d.id, '<b>' + d.id + '</b> · ' + esc(d.mpn)) + ' : offres consolidées à étudier</li>'; }));
    return ui.page('Tableau de bord acheteur', 'Atelier Lumen (fictif), Lyon. Pseudonyme vu par les vendeurs : <b>A-7Q2</b>.',
      ui.stats([['Demandes en enchère', dem.filter(function (d) { return d.status === 'auction'; }).length], ['Offres à étudier', offers.length], ['Actions à faire', todo.length], ['Transactions en cours', tx.filter(function (t) { return CP.TX_STATUS[t.status].turn !== null; }).length]]) +
      '<div class="grid2">' + ui.card('À faire', actions.length ? '<ul class="todo-list">' + actions.join('') + '</ul>' : '<p class="empty">Rien à faire pour le moment.</p>') + ui.card('Notifications', ui.notifs(notifs)) + '</div>' +
      ui.card('Transactions Opportunity', ui.table(['Transaction', 'Référence', '>Qté', 'Vendeur', '>Montant', 'Étape', ''], tx.map(function (t) {
        return [ui.link('/acheteur/transactions/' + t.id, t.id), '<span class="mono">' + esc(t.mpn) + '</span>', CP.num(t.qty), esc(t.seller), CP.eur(t.total), ui.txStatus(t), ui.due(t)];
      }), 'Aucune transaction.')) +
      ui.card('Demandes Opportunity', ui.table(['Demande', 'Référence', '>Qté', 'Livraison', 'Clôture', 'Statut'], dem.map(function (d) {
        return [ui.link('/acheteur/demandes/' + d.id, d.id), '<span class="mono">' + esc(d.mpn) + '</span>', CP.num(d.qty), esc(d.delivery), esc(CP.fmtDay(d.closesDay)), demStatus(d)];
      }), 'Aucune demande.')) +
      '<div class="grid2">' + ui.card('Nomenclatures', ui.table(['Nomenclature', 'Fichier', '>Lignes'], boms.map(function (b) {
        return [ui.link('/acheteur/nomenclatures/' + b.id, b.id), esc(b.name), b.lines.length];
      }), 'Aucune nomenclature.') + '<p>' + ui.link('/acheteur/nomenclature', 'Déposer une nomenclature') + '</p>') +
      ui.card('Commandes Inventory', ui.table(['Commande', '>Lignes', '>Montant', 'Statut'], inv.map(function (o) {
        return [o.id, o.lines.length, CP.eur(o.lines.reduce(function (s, l) { return s + l.qty * l.price; }, 0)), ui.pill(o.status, 'ok')];
      }), 'Aucune commande.')) + '</div>');
  };

  // ------------------------------------------------------------ dépôt de nomenclature
  var SAMPLE = 'mpn;qty\nSTM32G071RBT6;250\nTPS62130RGTR;250\nGRM188R71H104KA93D;5000\nCH340C;250\nESP32-C3-MINI-1-N4;250\nLM358DR;500\nMC68HC11E1CFNE2;250\nXC2S50-5TQ144C;250';
  CP.views['/acheteur/nomenclature'] = function () {
    return ui.page('Déposer une nomenclature', 'Chaque ligne est affectée à Inventory si le réseau a le stock, sinon à Opportunity.',
      '<form class="card form" data-form="bom">' +
      '<label class="field"><span>Nomenclature (référence ; quantité, une ligne par composant)</span><textarea name="csv" rows="10" class="mono">' + esc(SAMPLE) + '</textarea></label>' +
      '<div class="row"><label class="field"><span>Nom du fichier</span><input name="name" value="preserie-v3.csv"></label><label class="field"><span>Date code minimum</span><input name="dcMin" value="2010"></label></div>' +
      '<label class="field"><span>Adresse de livraison (peut différer de la facturation)</span><input name="delivery" value="Intégrateur, Shenzhen (Chine)"></label>' +
      '<p class="muted small">Les vendeurs ne verront que le pays de livraison, jamais l\'adresse ni le nom de l\'acheteur.</p><button class="btn">Analyser la nomenclature</button></form>');
  };
  CP.forms.bom = function (d) {
    var lines = d.csv.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean)
      .filter(function (l, i) { return !(i === 0 && /mpn|r[ée]f/i.test(l)); })
      .map(function (l) { var f = l.split(/[;,\t]/); return { mpn: f[0], qty: f[1] }; });
    var bom = CP.call('POST', '/v1/boms', { name: d.name, lines: lines, delivery: d.delivery, dcMin: d.dcMin }, 'Nomenclature analysée.');
    if (bom) { location.hash = '#/acheteur/nomenclatures/' + bom.id; return false; }
  };

  // ------------------------------------------------------------ nomenclature répartie
  CP.views['/acheteur/nomenclatures/:id'] = function (r) {
    var b = CP.get('/v1/boms/' + r.params.id);
    if (!b) return ui.page('Nomenclature introuvable', '', '');
    var inv = b.lines.filter(function (l) { return l.offer === 'inventory'; });
    var opp = b.lines.filter(function (l) { return l.offer === 'opportunity'; });
    var invTotal = inv.reduce(function (s, l) { return s + l.qty * l.price; }, 0);
    var pending = opp.filter(function (l) { return !l.demandId; });
    return ui.page('Nomenclature ' + esc(b.id), esc(b.name) + ' · ' + b.lines.length + ' lignes · livraison : ' + esc(b.delivery || 'non précisée'),
      ui.card('Répartition', ui.table(['#', 'Référence', 'Fabricant', '>Qté', 'Offre', 'Source ou motif', '>Prix unitaire', 'Suite'], b.lines.map(function (l, i) {
        return [i + 1, '<span class="mono">' + esc(l.mpn) + '</span>', esc(l.mfr || '—'), CP.num(l.qty), l.offer === 'inventory' ? ui.pill('Inventory', 'inv') : ui.pill('Opportunity', 'opp'),
          esc(l.offer === 'inventory' ? l.source : l.reason || ''), l.offer === 'inventory' ? CP.eur(l.price) : 'Enchère',
          l.offer === 'inventory' ? (b.inventoryOrderId ? 'Commandée' : '') : l.demandId ? ui.link('/acheteur/demandes/' + l.demandId, l.demandId) : ui.btn('Lancer la demande', 'launch-demand', { bom: b.id, mpn: l.mpn, qty: l.qty }, 'small')];
      }))) +
      '<div class="grid2">' + ui.card('<span class="pill inv">Inventory</span> ' + inv.length + ' ligne(s)', '<p>Prix et délais du réseau, certificat de conformité d\'origine, paiement classique.</p>' + ui.kv([['Montant', CP.eur(invTotal)], ['Commande', b.inventoryOrderId ? esc(b.inventoryOrderId) : 'Non passée']]) +
        (inv.length && !b.inventoryOrderId ? '<p>' + ui.btn('Commander les lignes Inventory', 'order-inventory', { bom: b.id }) + '</p>' : '')) +
      ui.card('<span class="pill opp">Opportunity</span> ' + opp.length + ' ligne(s)', '<p>Chaque ligne devient une demande anonymisée, diffusée aux vendeurs dont le stock correspond. Enchère de ' + P.delays.auction + ' jours ouvrés.</p>' +
        (pending.length ? '<p>' + ui.btn('Lancer les ' + pending.length + ' demande(s)', 'launch-all', { bom: b.id }) + '</p>' : '<p class="muted">Toutes les demandes sont lancées.</p>')) + '</div>');
  };
  CP.actions['order-inventory'] = function (btn) {
    CP.call('POST', '/v1/inventory/orders', { bomId: btn.getAttribute('data-bom') }, 'Lignes Inventory commandées.');
  };
  function launch(bomId, mpn, qty) {
    var b = CP.state.boms[bomId];
    return CP.call('POST', '/v1/demands', { bomId: bomId, mpn: mpn, qty: qty, delivery: b.delivery, dcMin: b.dcMin, leadDays: 10 });
  }
  CP.actions['launch-demand'] = function (btn) {
    if (launch(btn.getAttribute('data-bom'), btn.getAttribute('data-mpn'), btn.getAttribute('data-qty'))) CP.toast('Demande anonymisée et diffusée.', 'ok');
  };
  CP.actions['launch-all'] = function (btn) {
    var id = btn.getAttribute('data-bom'), n = 0;
    CP.state.boms[id].lines.forEach(function (l) { if (l.offer === 'opportunity' && !l.demandId && launch(id, l.mpn, l.qty)) n++; });
    if (n) CP.toast(n + ' demande(s) diffusée(s) aux vendeurs.', 'ok');
  };

  // ------------------------------------------------------------ demande et offres
  CP.views['/acheteur/demandes/:id'] = function (r) {
    var d = CP.get('/v1/demands/' + r.params.id);
    if (!d) return ui.page('Demande introuvable', '', '');
    var head = ui.card('Demande', ui.kv([['Référence', '<span class="mono">' + esc(d.mpn) + '</span> · ' + esc(d.mfr)], ['Quantité', CP.num(d.qty)], ['Date code minimum', esc(d.dcMin || '—')], ['Emballage', esc(d.pack)], ['Livraison', esc(d.delivery)], ['Vue des vendeurs', 'Zone « ' + esc(d.zone) + ' », acheteur masqué'], ['Statut', demStatus(d)]]));
    var body = '';
    if (d.status === 'auction') {
      body = ui.card('Enchère en cours', '<p>Offres scellées reçues : <b>' + d.bids + '</b>. Clôture le <b>' + esc(CP.fmtDay(d.closesDay)) + '</b>, puis Central.Parts présente les offres consolidées, prix tout compris.</p><p class="muted small">Pour avancer : passer en Central.Parts et clôturer l\'enchère, ou faire « +1 jour ouvré ».</p>');
    } else if (d.status === 'no_offer') {
      body = ui.card('Aucune offre', '<p>Aucun vendeur n\'a répondu. Prochaine étape prévue : recherche étendue, avec frais de recherche.</p>');
    } else if (d.status === 'ordered') {
      body = ui.card('Commandée', '<p>Offre retenue : ' + ui.link('/acheteur/transactions/' + d.txId, 'transaction ' + esc(d.txId)) + '.</p>');
    } else {
      var offers = CP.get('/v1/demands/' + d.id + '/offers') || [];
      body = '<form data-form="accept-offer"><div class="offers">' + offers.map(function (o, i) {
        return '<label class="card offer"><input type="radio" name="offer" value="' + o.id + '"' + (i ? '' : ' checked') + '>' +
          '<div class="offer-hd"><b>Offre ' + o.rank + '</b><span class="price">' + CP.eur(o.unit) + ' <small>l\'unité, tout compris</small></span></div>' +
          '<p class="muted small">Vendeur ' + esc(o.seller) + ' · ' + esc(o.sellerProfile) + ' · origine : ' + esc(o.origin) + ' · date code ' + esc(o.lot.dc) + ' · expédition sous ' + o.leadDays + ' j ouvrés · valable jusqu\'au ' + esc(CP.fmtDay(o.validUntil)) + '</p>' +
          '<p class="total-line">Total pour ' + CP.num(d.qty) + ' pièces : <b>' + CP.eur(o.unit * d.qty) + '</b></p>' +
          '<details><summary>Questionnaire d\'état et documents</summary>' + ui.questionnaire(o.lot) + ui.docs(o.lot) + '</details></label>';
      }).join('') + '</div>' +
        ui.card('Test en laboratoire et délais', '<fieldset class="labs">' + P.labLevels.map(function (l) {
          return '<label><input type="radio" name="labLevel" value="' + l.id + '"' + (l.id === 2 ? ' checked' : '') + '> <span>' + esc(l.name) + '</span><span class="muted">' + (l.price ? CP.eur(l.price) + ' · ' + l.days + ' j' : '—') + '</span></label>';
        }).join('') + '</fieldset>' +
        '<p class="muted small">Avec un test, le laboratoire reçoit les pièces du vendeur, les teste puis les réexpédie à l\'adresse de livraison. Son certificat précède le paiement du vendeur.</p>' +
        '<div class="row"><label class="field"><span>Délai d\'inspection à réception (1 à 30 j ouvrés)</span><input type="number" name="inspection" min="1" max="30" value="' + P.delays.inspection + '"></label><label class="field"><span>Délai de contre-inspection du vendeur</span><input type="number" name="counter" min="1" max="30" value="' + P.delays.counter + '"></label></div>' +
        '<button class="btn">Retenir l\'offre et créer la fiche transaction</button>') + '</form>';
    }
    return ui.page('Demande ' + esc(d.id), 'Demande Opportunity, anonymisée pour les vendeurs.', head + body);
  };
  CP.forms['accept-offer'] = function (d) {
    var t = CP.call('POST', '/v1/offers/' + d.offer + '/accept', { labLevel: d.labLevel, inspection: d.inspection, counter: d.counter }, 'Fiche transaction créée.');
    if (t) { location.hash = '#/acheteur/transactions/' + t.id; return false; }
  };

  // ------------------------------------------------------------ transaction
  CP.views['/acheteur/transactions/:id'] = function (r) {
    var t = CP.get('/v1/transactions/' + r.params.id);
    if (!t) return ui.page('Transaction introuvable', '', '');
    var lvl = P.labLevels[t.labLevel];
    var action = '';
    switch (t.status) {
      case 'to_sign_buyer':
        action = '<p>Vérifiez la fiche puis signez. Les réponses du questionnaire font partie de la commande ; sans réponse dans le délai d\'inspection, les pièces sont réputées acceptées.</p>' + ui.btn('Signer la fiche transaction', 'sign', { tx: t.id });
        break;
      case 'awaiting_funds':
        action = '<p>Virez le montant exact sur le compte dédié, avec la référence. Les fonds y restent jusqu\'à l\'acceptation des pièces.</p>' +
          ui.kv([['Montant', '<b>' + CP.eur(t.total) + '</b>'], ['Référence', '<span class="mono">' + esc(t.id) + '</span>'], ['IBAN du compte dédié', '<span class="mono">FR76 0000 0000 0000 0000 0000 000</span> (fictif)']]) +
          '<p class="muted small">La réception est confirmée par la banque (webhook). Pour la simuler : passer en rôle Banque.</p>' + ui.btn('Continuer comme Banque', 'switch-actor', { actor: 'bank' }, 'ghost');
        break;
      case 'to_buyer':
        action = '<p>Colis en route' + (t.tracking ? ', suivi <span class="mono">' + esc(t.tracking) + '</span>' : '') + '. La livraison est confirmée par le transporteur.</p>' + ui.btn('Simuler la livraison (webhook transporteur)', 'deliver', { tx: t.id }, 'ghost');
        break;
      case 'inspection':
        action = '<p>Inspectez les pièces, ou faites-les inspecter par votre intégrateur, avant le <b>' + esc(CP.fmtDay(t.due.day)) + '</b>.</p>' + ui.btn('J\'accepte les pièces', 'accept', { tx: t.id }) +
          '<form class="sub" data-form="reject"><input type="hidden" name="tx" value="' + t.id + '"><h3>Rejeter</h3><div class="row"><label class="field"><span>Motif</span><select name="reason">' + P.rejectReasons.map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('') + '</select></label>' +
          '<label class="field"><span>Quantité rejetée</span><input type="number" name="qty" min="1" max="' + t.qty + '" value="' + t.qty + '"></label></div><label class="field"><span>Commentaire et justificatifs</span><input name="comment" placeholder="Photos, rapport d\'inspection…"></label><button class="btn ghost">Rejeter avec ce motif</button></form>';
        break;
      case 'return_due':
        action = '<p>Retournez les ' + t.rejection.qty + ' pièce(s) rejetée(s) avec l\'étiquette générée par la plateforme, puis saisissez le suivi.</p><p class="label-box mono">Étiquette de retour · RET-' + esc(t.id.slice(3)) + ' · destinataire communiqué au transporteur</p>' +
          '<form class="inline" data-form="return"><input type="hidden" name="tx" value="' + t.id + '"><input name="tracking" placeholder="Numéro de suivi du retour" required><button class="btn">Confirmer le retour</button></form>';
        break;
      default:
        action = waitText(t);
    }
    return ui.page('Transaction ' + esc(t.id), esc(t.mpn) + ' × ' + CP.num(t.qty) + ' · vendeur ' + esc(t.seller) + ' · ' + ui.txStatus(t) + ' ' + ui.due(t),
      ui.timeline(t) +
      '<div class="grid2">' + ui.card('Action', action, 'action') +
      ui.card('Fiche transaction', ui.kv([['Référence', '<span class="mono">' + esc(t.mpn) + '</span> · ' + esc(t.mfr)], ['Quantité', CP.num(t.qty)], ['Prix unitaire tout compris', CP.eur(t.unit)], ['Laboratoire', lvl.id ? esc(lvl.name) + ', ' + CP.eur(t.labFee) : 'Pas de test'], ['Total', '<b>' + CP.eur(t.total) + '</b>'], ['Vendeur', esc(t.seller) + ' · ' + esc(t.sellerProfile || '')], ['Livraison', esc(t.delivery)], ['Délais', 'inspection ' + t.delays.inspection + ' j, contre-inspection ' + t.delays.counter + ' j'], ['Signatures', (t.signed.buyer ? 'acheteur ✓' : 'acheteur ✗') + ' · ' + (t.signed.seller ? 'vendeur ✓' : 'vendeur ✗')]])) + '</div>' +
      certificate(t) +
      '<div class="grid2">' + ui.card('Questionnaire du lot', ui.questionnaire(t.lot) + ui.docs(t.lot)) + ui.card('Historique', ui.history(t)) + '</div>');
  };

  function waitText(t) {
    var s = CP.TX_STATUS[t.status];
    var who = { seller: 'du vendeur', lab: 'du laboratoire', ops: 'de Central.Parts', bank: 'de la banque', system: 'du transporteur' }[s.turn];
    if (!s.turn) return '<p>Transaction terminée : ' + esc(s.label.toLowerCase()) + '.</p>';
    return '<p>En attente ' + (who || '') + ' : ' + esc(s.label.toLowerCase()) + '.</p>' + (s.turn === 'seller' || s.turn === 'lab' || s.turn === 'ops' ? ui.btn('Voir l\'écran ' + who, 'goto-party', { tx: t.id, role: s.turn }, 'ghost') : '');
  }
  CP.waitText = waitText;

  function certificate(t) {
    var lc = t.labCase;
    if (!lc || !lc.verdict) return '';
    var v = { pass: ['Conforme', 'ok'], fail: ['Non conforme', 'danger'], counterfeit: ['Contrefaçon', 'danger'] }[lc.verdict];
    return ui.card('Certificat du laboratoire ' + ui.pill(v[0], v[1]), ui.table(['Test', 'Résultat'], Object.keys(lc.results).map(function (k) { return [esc(P.testNames[k]), lc.results[k] === 'pass' ? ui.pill('Conforme', 'ok') : ui.pill('Non conforme', 'danger')]; })) + '<p class="muted small">Certificat ' + esc(lc.certificate) + '.</p>');
  }
  CP.certificate = certificate;

  CP.actions.sign = function (b) { CP.call('POST', '/v1/transactions/' + b.getAttribute('data-tx') + '/signatures', {}, 'Fiche signée.'); };
  CP.actions.deliver = function (b) {
    var r = CP.system('POST', '/v1/webhooks/carrier', { txId: b.getAttribute('data-tx'), event: 'delivered' });
    CP.toast(r.error ? r.status + ' · ' + r.error : 'Webhook transporteur reçu : livré.', r.error ? 'error' : 'ok');
  };
  CP.actions.accept = function (b) { CP.call('POST', '/v1/transactions/' + b.getAttribute('data-tx') + '/inspection', { decision: 'accept' }, 'Pièces acceptées : le paiement du vendeur va être ordonné.'); };
  CP.forms.reject = function (d) { CP.call('POST', '/v1/transactions/' + d.tx + '/inspection', { decision: 'reject', reason: d.reason, qty: d.qty, comment: d.comment }, 'Rejet enregistré.'); };
  CP.forms['return'] = function (d) { CP.call('POST', '/v1/transactions/' + d.tx + '/returns', { tracking: d.tracking }, 'Retour enregistré.'); };
  CP.actions['goto-party'] = function (b) {
    var role = b.getAttribute('data-role'), id = b.getAttribute('data-tx');
    var t = CP.state.transactions[id];
    if (role === 'seller') { CP.setActor({ S1: 'seller1', S2: 'seller2', S3: 'seller3' }[t.sellerId]); location.hash = '#/vendeur/transactions/' + id; }
    else if (role === 'lab') { var lc = CP.values(CP.state.labCases).filter(function (c) { return c.txId === id; })[0]; CP.setActor('lab'); location.hash = lc ? '#/labo/dossiers/' + lc.id : '#/labo'; }
    else { CP.setActor('ops1'); location.hash = t.status === 'settling' ? '#/ops/paiements' : '#/ops/transactions/' + id; }
  };
})();
