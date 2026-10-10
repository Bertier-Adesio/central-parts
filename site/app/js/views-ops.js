// Écrans du laboratoire, de la banque et de Central.Parts (opérateurs).
(function () {
  'use strict';
  var esc = CP.esc, ui = CP.ui, P = CP.PARAMS;

  // ============================================================ laboratoire
  var CASE_STATUS = { awaiting: ['Attente de l\'expédition', 'muted'], in_transit: ['Colis en route', 'todo'], received: ['À tester', 'todo'], certified: ['Certifié', 'ok'], reshipped: ['Réexpédié', 'ok'] };
  function caseStatus(c) {
    if (c.status === 'certified' && c.tx.status === 'lab_passed') return ui.pill('À réexpédier', 'todo');
    var s = CASE_STATUS[c.status] || [c.status, ''];
    return ui.pill(s[0], s[1]);
  }

  CP.views['/labo'] = function () {
    var cases = CP.get('/v1/lab/cases') || [], notifs = CP.get('/v1/notifications') || [];
    var todo = cases.filter(function (c) { return ['in_transit', 'received'].indexOf(c.status) >= 0 || (c.status === 'certified' && c.tx.status === 'lab_passed'); });
    return ui.page('Dossiers du laboratoire', 'Laboratoire partenaire Europe (fictif), Eindhoven. Le laboratoire voit les pseudonymes des parties, jamais leur identité.',
      ui.stats([['À traiter', todo.length], ['Certifiés', cases.filter(function (c) { return c.verdict; }).length], ['Dossiers', cases.length]]) +
      ui.card('Dossiers', ui.table(['Dossier', 'Transaction', 'Référence', '>Qté', 'Niveau de test', 'Statut', 'Verdict'], cases.map(function (c) {
        return [ui.link('/labo/dossiers/' + c.id, c.id), esc(c.txId), '<span class="mono">' + esc(c.tx.mpn) + '</span>', CP.num(c.tx.qty), esc(c.levelName), caseStatus(c), c.verdict ? verdictPill(c.verdict) : '—'];
      }), 'Aucun dossier.')) +
      ui.card('Notifications', ui.notifs(notifs)));
  };
  function verdictPill(v) { return v === 'pass' ? ui.pill('Conforme', 'ok') : v === 'fail' ? ui.pill('Non conforme', 'danger') : ui.pill('Contrefaçon', 'danger'); }

  CP.views['/labo/dossiers/:id'] = function (r) {
    var c = (CP.get('/v1/lab/cases') || []).filter(function (x) { return x.id === r.params.id; })[0];
    if (!c) return ui.page('Dossier introuvable', '', '');
    var t = c.tx, action;
    if (c.status === 'awaiting') action = '<p>Le vendeur n\'a pas encore expédié. Vous serez notifié avec le numéro de suivi.</p>';
    else if (c.status === 'in_transit') {
      action = '<p>Colis en route, suivi <span class="mono">' + esc(t.tracking || '—') + '</span>. À réception, contrôlez la quantité et l\'état des emballages.</p>' +
        '<form class="form" data-form="lab-receive"><input type="hidden" name="case" value="' + c.id + '"><div class="row"><label class="field"><span>Quantité reçue (attendue : ' + t.qty + ')</span><input type="number" name="qty" min="0" value="' + t.qty + '"></label><label class="field"><span>Observations</span><input name="note" placeholder="Emballage intact, sachets étanches…"></label></div><button class="btn">Enregistrer la réception</button></form>';
    } else if (c.status === 'received') {
      action = '<form class="form" data-form="lab-certify"><input type="hidden" name="case" value="' + c.id + '"><h3>Résultats par test</h3>' +
        ui.table(['Test', 'Résultat'], c.tests.map(function (k) {
          return [esc(P.testNames[k]), '<select name="t_' + k + '" aria-label="' + esc(P.testNames[k]) + '"><option value="pass">Conforme</option><option value="fail">Non conforme</option></select>'];
        })) +
        '<h3>Verdict du certificat</h3><fieldset class="choice"><label><input type="radio" name="verdict" value="pass" checked> Conforme : réexpédition à l\'adresse de livraison</label><label><input type="radio" name="verdict" value="fail"> Non conforme</label><label><input type="radio" name="verdict" value="counterfeit"> Contrefaçon : quarantaine, jamais renvoyé au vendeur</label></fieldset>' +
        '<button class="btn">Délivrer le certificat</button></form>';
    } else if (c.status === 'certified' && t.status === 'lab_passed') {
      action = '<p>Certificat conforme délivré. Réexpédiez à l\'adresse désignée par l\'acheteur.</p>' + ui.kv([['Adresse de réexpédition', esc(c.shipTo)]]) +
        '<form class="inline" data-form="lab-reship"><input type="hidden" name="case" value="' + c.id + '"><input name="tracking" placeholder="Numéro de suivi" required><button class="btn">Confirmer la réexpédition</button></form>';
    } else if (c.verdict && c.verdict !== 'pass') action = '<p>Verdict défavorable. Les pièces restent en quarantaine au laboratoire jusqu\'à la décision ; en cas de contestation, un second laboratoire indépendant tranche.</p>';
    else action = '<p>Dossier terminé.</p>';
    return ui.page('Dossier ' + esc(c.id), 'Transaction ' + esc(c.txId) + ' · ' + esc(c.levelName) + ' · ' + caseStatus(c),
      '<div class="grid2">' + ui.card('Action', action, 'action') +
      ui.card('Dossier', ui.kv([['Référence', '<span class="mono">' + esc(t.mpn) + '</span> · ' + esc(t.mfr)], ['Quantité attendue', CP.num(t.qty)], ['Reçue', c.receivedQty != null ? CP.num(c.receivedQty) : '—'], ['Date code déclaré', esc(t.lot.dc)], ['Vendeur', esc(t.seller)], ['Acheteur', esc(t.buyer)], ['Niveau de test', esc(c.levelName) + ', ' + CP.eur(P.labLevels[c.level].price)], ['Certificat', c.certificate ? esc(c.certificate) + ' · ' + verdictPill(c.verdict) : '—']])) + '</div>' +
      ui.card('Questionnaire déclaré par le vendeur', '<p class="muted small">À confronter aux pièces reçues.</p>' + ui.questionnaire(t.lot)));
  };
  CP.forms['lab-receive'] = function (d) { CP.call('POST', '/v1/lab/cases/' + d['case'] + '/reception', { qty: d.qty, note: d.note }, 'Réception enregistrée.'); };
  CP.forms['lab-certify'] = function (d) {
    var results = {};
    Object.keys(d).forEach(function (k) { if (k.indexOf('t_') === 0) results[k.slice(2)] = d[k]; });
    CP.call('POST', '/v1/lab/cases/' + d['case'] + '/certificate', { verdict: d.verdict, results: results }, 'Certificat délivré.');
  };
  CP.forms['lab-reship'] = function (d) { CP.call('POST', '/v1/lab/cases/' + d['case'] + '/reshipment', { tracking: d.tracking }, 'Réexpédition enregistrée.'); };

  // ============================================================ banque
  CP.views['/banque'] = function () {
    var esc_ = CP.get('/v1/escrow') || { balance: 0, ledger: {}, movements: [] };
    var tx = CP.get('/v1/transactions') || [], orders = CP.get('/v1/payment-orders') || [], notifs = CP.get('/v1/notifications') || [];
    var expected = tx.filter(function (t) { return t.status === 'awaiting_funds'; });
    var toExec = orders.filter(function (o) { return o.status === 'transmitted'; });
    var held = Object.keys(esc_.ledger).filter(function (k) { return esc_.ledger[k] > 0.005; });
    return ui.page('Compte dédié', 'Vue de l\'établissement qui tient le compte où les dépôts des acheteurs sont cantonnés. Établissement et montage juridique à désigner : cette console décrit l\'API attendue de la banque.',
      ui.stats([['Solde du compte dédié', CP.eur(esc_.balance)], ['Transactions cantonnées', held.length], ['Virements attendus', expected.length], ['Ordres à exécuter', toExec.length]]) +
      ui.card('Virements attendus', ui.table(['Référence', 'Donneur d\'ordre', '>Montant attendu', 'Échéance', ''], expected.map(function (t) {
        return ['<span class="mono">' + esc(t.id) + '</span>', esc(t.buyer), CP.eur(t.total), ui.due(t), ui.btn('Simuler la réception', 'bank-in', { tx: t.id, amount: t.total }, 'small') + ' ' + ui.btn('Montant erroné', 'bank-in', { tx: t.id, amount: CP.round(t.total - 100) }, 'small ghost')];
      }), 'Aucun virement attendu.') + '<p class="muted small">À réception, la banque appelle le webhook <span class="mono">POST /v1/webhooks/bank/incoming-transfer</span> ; Central.Parts rapproche par référence et montant.</p>') +
      ui.card('Ordres reçus de Central.Parts', ui.table(['Ordre', 'Type', 'Transaction', 'Bénéficiaires', '>Montant', 'Validations', ''], orders.map(function (o) {
        return [esc(o.id), o.type === 'release' ? 'Paiement' : 'Remboursement', esc(o.txId), o.lines.map(function (l) { return esc(l.beneficiary) + ' <span class="mono small iban">' + esc(l.iban) + '</span> · ' + CP.eur(l.amount); }).join('<br>'), CP.eur(o.amount), esc(o.approvals.join(', ')),
          o.status === 'transmitted' ? ui.btn('Exécuter', 'bank-exec', { order: o.id }, 'small') : ui.pill('Exécuté', 'ok')];
      }), 'Aucun ordre transmis.') + '<p class="muted small">La banque contrôle que chaque bénéficiaire est une société dont le KYB est validé et dont l\'IBAN est celui déclaré, puis notifie l\'exécution par webhook.</p>') +
      '<div class="grid2">' + ui.card('Cantonnement par transaction', ui.table(['Transaction', '>Montant cantonné'], held.map(function (k) { return [esc(k), CP.eur(esc_.ledger[k])]; }), 'Aucun fonds cantonné.')) + ui.card('Notifications', ui.notifs(notifs)) + '</div>' +
      ui.card('Mouvements', ui.table(['Date', 'Libellé', '>Montant'], esc_.movements.map(function (m) { return [esc(CP.fmtDay(m.day)), esc(m.label), '<span class="' + (m.amount < 0 ? 'neg' : 'pos') + '">' + CP.eur(m.amount) + '</span>']; }), 'Aucun mouvement.')));
  };
  CP.actions['bank-in'] = function (b) {
    CP.call('POST', '/v1/webhooks/bank/incoming-transfer', { reference: b.getAttribute('data-tx'), amount: Number(b.getAttribute('data-amount')) }, 'Virement rapproché : fonds cantonnés.');
  };
  CP.actions['bank-exec'] = function (b) { CP.call('POST', '/bank/v1/orders/' + b.getAttribute('data-order') + '/execution', {}, 'Ordre exécuté.'); };

  // ============================================================ Central.Parts
  CP.views['/ops'] = function () {
    var esc_ = CP.get('/v1/escrow') || { balance: 0 };
    var orgs = CP.get('/v1/organizations?kyb=pending') || [], dem = CP.get('/v1/demands') || [], tx = CP.get('/v1/transactions') || [], orders = CP.get('/v1/payment-orders') || [], events = CP.get('/v1/events') || [], notifs = CP.get('/v1/notifications') || [];
    var disputes = tx.filter(function (t) { return t.status === 'dispute'; });
    var pendingOrders = orders.filter(function (o) { return o.status === 'pending' || o.status === 'approved'; });
    var todo = orgs.map(function (o) { return '<li>' + ui.link('/ops/kyb', 'KYB à valider : <b>' + esc(o.name) + '</b>') + '</li>'; })
      .concat(dem.filter(function (d) { return d.status === 'auction'; }).map(function (d) { return '<li>' + ui.link('/ops/demandes', '<b>' + d.id + '</b> · ' + esc(d.mpn)) + ' : enchère, ' + d.bids + ' offre(s), clôture ' + esc(CP.fmtDay(d.closesDay)) + '</li>'; }))
      .concat(disputes.map(function (t) { return '<li>' + ui.link('/ops/transactions/' + t.id, '<b>' + t.id + '</b>') + ' : litige à trancher ' + ui.due(t) + '</li>'; }))
      .concat(pendingOrders.map(function (o) { return '<li>' + ui.link('/ops/paiements', '<b>' + o.id + '</b>') + ' : ' + (o.type === 'release' ? 'paiement' : 'remboursement') + ' de ' + CP.eur(o.amount) + ', ' + (o.status === 'approved' ? 'à transmettre' : o.approvals.length + '/2 validation') + '</li>'; }))
      .concat(tx.filter(function (t) { return t.status === 'to_buyer'; }).map(function (t) { return '<li>' + ui.link('/ops/transactions/' + t.id, '<b>' + t.id + '</b>') + ' : en livraison, webhook transporteur attendu</li>'; }));
    return ui.page('Console Central.Parts', 'Vue opérateur : toutes les parties en clair. Connecté comme <b>' + esc(CP.actor.user) + '</b>.',
      ui.stats([['Compte dédié', CP.eur(esc_.balance)], ['KYB en attente', orgs.length], ['Enchères ouvertes', dem.filter(function (d) { return d.status === 'auction'; }).length], ['Litiges', disputes.length], ['Ordres à traiter', pendingOrders.length]]) +
      '<div class="grid2">' + ui.card('À traiter', todo.length ? '<ul class="todo-list">' + todo.join('') + '</ul>' : '<p class="empty">Rien à traiter.</p>') + ui.card('Notifications', ui.notifs(notifs)) + '</div>' +
      ui.card('Transactions', ui.table(['Transaction', 'Référence', 'Acheteur', 'Vendeur', '>Total', '>Marge brute', 'Étape', ''], tx.map(function (t) {
        return [ui.link('/ops/transactions/' + t.id, t.id), '<span class="mono">' + esc(t.mpn) + '</span>', esc(t.buyer), esc(t.seller), CP.eur(t.total), CP.eur((t.unit - t.net) * t.qty), ui.txStatus(t), ui.due(t)];
      }), 'Aucune transaction.')) +
      ui.card('Journal d\'audit', '<ol class="hist">' + events.slice(0, 25).map(function (e) { return '<li><span class="mono">' + esc(CP.fmtDay(e.day)) + '</span> ' + esc(e.text) + '</li>'; }).join('') + '</ol>'));
  };

  CP.views['/ops/kyb'] = function () {
    var all = CP.get('/v1/organizations') || [];
    var pending = all.filter(function (o) { return o.kyb === 'pending'; });
    return ui.page('KYB à valider', 'Contrôle des pièces, des bénéficiaires effectifs, des signataires et des listes de sanctions UE avant toute transaction.',
      (pending.length ? pending.map(function (o) {
        return '<form class="card form" data-form="kyb"><input type="hidden" name="org" value="' + o.id + '"><h2>' + esc(o.name) + ' ' + ui.pill({ buyer: 'Acheteur', seller: 'Vendeur', lab: 'Laboratoire' }[o.type] || o.type) + '</h2>' +
          ui.kv([['Identifiant', esc(o.id) + ' · pseudonyme ' + esc(o.alias)], ['SIREN', esc(o.siren || '—')], ['Pays', esc(o.country || '—') + (o.city ? ', ' + esc(o.city) : '')], ['Bénéficiaires effectifs', esc(o.beneficiaries || '—')], ['Signataire', esc(o.signatory || '—')], ['IBAN autorisé', '<span class="mono">' + esc(o.iban || '—') + '</span>'], ['Pièces', Object.keys(o.docs || {}).filter(function (k) { return o.docs[k]; }).join(', ') || 'Dossier de démonstration']]) +
          '<label class="check"><input type="checkbox" name="sanctions"> Listes de sanctions UE vérifiées, aucune correspondance</label>' +
          '<div class="row-btn"><button class="btn" name="decision" value="validated">Valider</button> <button class="btn ghost" name="decision" value="rejected" formnovalidate>Refuser</button></div></form>';
      }).join('') : ui.card('', '<p class="empty">Aucun dossier en attente. Créez-en un depuis ' + ui.link('/inscription', 'l\'inscription') + ' (rôle Visiteur).</p>')) +
      ui.card('Sociétés', ui.table(['Société', 'Type', 'Pseudonyme', 'Pays', 'KYB'], all.filter(function (o) { return ['buyer', 'seller', 'lab'].indexOf(o.type) >= 0; }).map(function (o) {
        var k = { validated: ['Validé', 'ok'], pending: ['En attente', 'todo'], rejected: ['Refusé', 'danger'], draft: ['Incomplet', 'muted'] }[o.kyb];
        return [esc(o.name), esc(o.type), esc(o.alias), esc(o.country), ui.pill(k[0], k[1])];
      }))));
  };
  // Le bouton cliqué porte la décision : on la lit au moment de l'envoi.
  var lastDecision = null;
  document.addEventListener('click', function (e) { var b = e.target.closest('button[name="decision"]'); if (b) lastDecision = b.value; }, true);
  CP.forms.kyb = function (d) {
    CP.call('POST', '/v1/organizations/' + d.org + '/kyb/decision', { decision: lastDecision || 'validated', sanctionsChecked: d.sanctions }, lastDecision === 'rejected' ? 'Dossier refusé.' : 'KYB validé.');
  };

  CP.views['/ops/demandes'] = function () {
    var dem = CP.get('/v1/demands') || [];
    return ui.page('Demandes et enchères', 'Les demandes sont anonymisées et diffusées automatiquement aux vendeurs dont le stock correspond. La clôture calcule les offres consolidées.',
      ui.card('Demandes', ui.table(['Demande', 'Acheteur', 'Référence', '>Qté', 'Vendeurs sollicités', '>Offres', 'Clôture', 'Statut', ''], dem.map(function (d) {
        return [esc(d.id), esc(CP.state.orgs[d.buyerId].name), '<span class="mono">' + esc(d.mpn) + '</span>', CP.num(d.qty), esc(d.sellers.map(function (s) { return CP.state.orgs[s].alias; }).join(', ') || 'Aucun : recherche étendue'), d.bids, esc(CP.fmtDay(d.closesDay)), CP.demStatus(d),
          d.status === 'auction' ? ui.btn('Clôturer l\'enchère', 'close-demand', { demand: d.id }, 'small') : ''];
      }), 'Aucune demande.')) +
      dem.filter(function (d) { return d.status === 'offers' || d.status === 'ordered'; }).map(function (d) {
        var offers = CP.get('/v1/demands/' + d.id + '/offers') || [];
        return ui.card('Offres consolidées · ' + esc(d.id), ui.table(['Rang', 'Vendeur', '>Net vendeur', '>Prix acheteur', '>Écart unitaire', 'Statut'], offers.map(function (o) {
          return [o.rank, esc(o.sellerName) + ' (' + esc(o.seller) + ')', CP.eur(o.net), CP.eur(o.unit), CP.eur(o.unit - o.net), esc({ open: 'Ouverte', accepted: 'Retenue', declined: 'Non retenue' }[o.status])];
        })) + '<p class="muted small">Marge de la maquette fictive (' + Math.round(P.buyerMargin * 100) + ' %), taux réels à fixer.</p>');
      }).join(''));
  };
  CP.actions['close-demand'] = function (b) { CP.call('POST', '/v1/demands/' + b.getAttribute('data-demand') + '/close', {}, 'Enchère clôturée.'); };

  CP.views['/ops/transactions/:id'] = function (r) {
    var t = CP.get('/v1/transactions/' + r.params.id);
    if (!t) return ui.page('Transaction introuvable', '', '');
    var action = '';
    if (t.status === 'to_buyer') action = '<p>Colis en route vers ' + esc(t.delivery) + '.</p>' + ui.btn('Simuler le webhook transporteur (livré)', 'deliver', { tx: t.id });
    else if (t.status === 'dispute') {
      var d = CP.state.disputes[t.disputeId];
      action = '<p>Litige <b>' + esc(d.id) + '</b> ouvert par ' + (d.openedBy === 'seller' ? 'le vendeur' : 'l\'acheteur') + ' : « ' + esc(d.reason) + ' ». Médiation sous ' + P.delays.mediation + ' j, puis expertise d\'un laboratoire tiers à la charge de la partie perdante.</p>' +
        '<form class="form" data-form="dispute"><input type="hidden" name="dispute" value="' + d.id + '"><div class="row"><label class="field"><span>Issue</span><select name="winner"><option value="buyer">En faveur de l\'acheteur (remboursement)</option><option value="seller">En faveur du vendeur (paiement)</option></select></label><label class="field"><span>Fondement</span><select name="basis"><option>Médiation</option><option>Expertise d\'un laboratoire tiers</option></select></label></div><button class="btn">Trancher</button></form>';
    } else if (t.status === 'settling') action = '<p>Ordres de paiement en cours de validation.</p>' + ui.link('/ops/paiements', 'Aller aux ordres de paiement');
    else action = CP.waitText(t);
    return ui.page('Transaction ' + esc(t.id), esc(t.buyer) + ' → ' + esc(t.seller) + ' · ' + ui.txStatus(t) + ' ' + ui.due(t),
      ui.timeline(t) +
      '<div class="grid2">' + ui.card('Action', action, 'action') +
      ui.card('Économie de la transaction', ui.kv([['Référence', '<span class="mono">' + esc(t.mpn) + '</span> × ' + CP.num(t.qty)], ['Net vendeur', CP.eur(t.net) + ' l\'unité'], ['Prix acheteur', CP.eur(t.unit) + ' l\'unité'], ['Laboratoire', t.labLevel ? CP.eur(t.labFee) : '—'], ['Total cantonné', '<b>' + CP.eur(t.total) + '</b>'], ['Commission vendeur', CP.eur(t.net * t.qty * P.sellerCommission)], ['Livraison', esc(t.delivery)]])) + '</div>' +
      (t.orders.length ? ui.card('Ordres', ui.table(['Ordre', 'Type', '>Montant', 'Validations', 'Statut'], t.orders.map(function (o) { return [esc(o.id), o.type === 'release' ? 'Paiement' : 'Remboursement', CP.eur(o.amount), esc(o.approvals.join(', ')), orderStatus(o)]; }))) : '') +
      CP.certificate(t) + ui.card('Historique', ui.history(t)));
  };
  CP.forms.dispute = function (d) { CP.call('POST', '/v1/disputes/' + d.dispute + '/decision', { winner: d.winner, basis: d.basis }, 'Litige tranché.'); };

  function orderStatus(o) {
    var m = { pending: ['À valider (' + o.approvals.length + '/2)', 'todo'], approved: ['À transmettre', 'todo'], transmitted: ['Transmis à la banque', 'wait'], executed: ['Exécuté', 'ok'] }[o.status];
    return ui.pill(m[0], m[1]);
  }

  CP.views['/ops/paiements'] = function () {
    var orders = CP.get('/v1/payment-orders') || [];
    var me = CP.actor.user;
    var other = CP.actor.id === 'ops1' ? 'ops2' : 'ops1';
    return ui.page('Ordres de paiement', 'Chaque ordre de paiement ou de remboursement exige la validation de deux opérateurs distincts avant sa transmission à la banque. Vous êtes <b>' + esc(me) + '</b>.',
      ui.card('', '<p>' + ui.btn('Passer en ' + esc(CP.ACTORS.filter(function (a) { return a.id === other; })[0].label), 'switch-actor', { actor: other }, 'ghost') + '</p>') +
      (orders.length ? orders.map(function (o) {
        var mine = o.approvals.indexOf(me) >= 0;
        return ui.card(esc(o.id) + ' · ' + (o.type === 'release' ? 'Paiement' : 'Remboursement') + ' · ' + esc(o.txId) + ' ' + orderStatus(o),
          ui.table(['Bénéficiaire', 'IBAN', 'Libellé', '>Montant'], o.lines.map(function (l) { return [esc(l.beneficiary), '<span class="mono small iban">' + esc(l.iban) + '</span>', esc(l.label), CP.eur(l.amount)]; })) +
          '<p class="total-line">Total <b>' + CP.eur(o.amount) + '</b> · validations : ' + (o.approvals.length ? esc(o.approvals.join(', ')) : 'aucune') + '</p>' +
          (o.status === 'pending' ? ui.btn(mine ? 'Déjà validé par vous' : 'Valider', 'approve', { order: o.id }, '', mine) : '') +
          (o.status === 'approved' ? ui.btn('Transmettre à la banque', 'transmit', { order: o.id }) : ''));
      }).join('') : ui.card('', '<p class="empty">Aucun ordre. Ils sont créés quand une transaction arrive au paiement ou au remboursement.</p>')));
  };
  CP.actions.approve = function (b) { CP.call('POST', '/v1/payment-orders/' + b.getAttribute('data-order') + '/approvals', {}, 'Ordre validé.'); };
  CP.actions.transmit = function (b) { CP.call('POST', '/v1/payment-orders/' + b.getAttribute('data-order') + '/transmit', {}, 'Ordre transmis à la banque.'); };
})();
