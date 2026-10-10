// Écrans des vendeurs (détenteurs de surplus et brokers).
(function () {
  'use strict';
  var esc = CP.esc, ui = CP.ui, P = CP.PARAMS;

  function lotState(l) {
    if (!l.complete) return ui.pill('Questionnaire incomplet', 'todo');
    var refused = CP.QUESTIONS.filter(function (x) { return l.q[x.k] === CP.REFUSED; }).length;
    return refused ? ui.pill('Complet, ' + refused + ' refus de répondre', 'wait') : ui.pill('Complet', 'ok');
  }

  // ------------------------------------------------------------ tableau de bord
  CP.views['/vendeur'] = function () {
    var me = CP.state.orgs[CP.actor.org];
    var dem = CP.get('/v1/demands') || [], tx = CP.get('/v1/transactions') || [], lots = CP.get('/v1/lots') || [], notifs = CP.get('/v1/notifications') || [];
    var open = dem.filter(function (d) { return d.status === 'auction'; });
    var todo = tx.filter(function (t) { return (CP.TX_STATUS[t.status] || {}).turn === 'seller'; });
    var incomplete = lots.filter(function (l) { return !l.complete; });
    var actions = todo.map(function (t) { return '<li>' + ui.link('/vendeur/transactions/' + t.id, '<b>' + t.id + '</b> · ' + esc(t.mpn)) + ' : ' + esc(CP.TX_STATUS[t.status].label.toLowerCase()) + ' ' + ui.due(t) + '</li>'; })
      .concat(open.map(function (d) { var b = CP.get('/v1/demands/' + d.id + '/bids/mine'); return '<li>' + ui.link('/vendeur/demandes/' + d.id, '<b>' + d.id + '</b> · ' + esc(d.mpn) + ' × ' + CP.num(d.qty)) + ' : ' + (b && b.bid ? 'votre offre est au rang ' + b.rank + ' sur ' + b.count : 'enchère ouverte, clôture le ' + esc(CP.fmtDay(d.closesDay))) + '</li>'; }))
      .concat(incomplete.map(function (l) { return '<li>' + ui.link('/vendeur/lots/' + l.id, '<b>' + l.id + '</b> · ' + esc(l.mpn)) + ' : questionnaire à compléter pour pouvoir enchérir</li>'; }));
    return ui.page('Tableau de bord vendeur', esc(me.name) + ' · pseudonyme vu par les acheteurs : <b>' + esc(me.alias) + '</b> · profil : ' + esc(me.profile || ''),
      ui.stats([['Enchères ouvertes', open.length], ['Actions à faire', todo.length], ['Lots en stock', lots.length], ['Questionnaires incomplets', incomplete.length]]) +
      '<div class="grid2">' + ui.card('À faire', actions.length ? '<ul class="todo-list">' + actions.join('') + '</ul>' : '<p class="empty">Rien à faire pour le moment.</p>') + ui.card('Notifications', ui.notifs(notifs)) + '</div>' +
      ui.card('Demandes correspondant à votre stock', ui.table(['Demande', 'Référence', '>Qté', 'Zone', 'Acheteur', 'Clôture', 'Statut'], dem.map(function (d) {
        return [ui.link('/vendeur/demandes/' + d.id, d.id), '<span class="mono">' + esc(d.mpn) + '</span>', CP.num(d.qty), esc(d.zone), '<span class="muted">Masqué</span>', esc(CP.fmtDay(d.closesDay)), CP.demStatus(d)];
      }), 'Aucune demande ne correspond à votre stock.')) +
      ui.card('Transactions', ui.table(['Transaction', 'Référence', '>Qté', 'Acheteur', 'Étape', ''], tx.map(function (t) {
        return [ui.link('/vendeur/transactions/' + t.id, t.id), '<span class="mono">' + esc(t.mpn) + '</span>', CP.num(t.qty), esc(t.buyer), ui.txStatus(t), ui.due(t)];
      }), 'Aucune transaction.')));
  };

  // ------------------------------------------------------------ stock et import
  var SAMPLES = {
    octopart: 'mpn,manufacturer,quantity,date_code,packaging,price\nXC2S100-5TQ144C,AMD Xilinx,600,2010,Plateau,52\nMC68HC11E1CFNE2,NXP,90,2012,Tube,19\nAD7714ARZ-5,Analog Devices,250,2015,Tube,9.5',
    ecia: 'Manufacturer Part Number;Manufacturer;Quantity Available;Date Code;Package Type;Unit Price\nEP2C8T144C8N;Intel;350;2013;Plateau;24\nMAX232CPE+;Analog Devices;1200;2019;Tube;1.2',
  };
  CP.views['/vendeur/stock'] = function (r) {
    var lots = CP.get('/v1/lots') || [];
    var fmt = r.query.format === 'ecia' ? 'ecia' : 'octopart';
    return ui.page('Stock et lots', 'Chaque lot porte son questionnaire d\'état et ses documents. Un lot sans questionnaire complet ne peut pas enchérir.',
      ui.card('Lots déclarés', ui.table(['Lot', 'Référence', 'Fabricant', '>Qté', 'Date code', 'Emballage', 'Questionnaire', 'Documents', ''], lots.map(function (l) {
        var n = CP.DOCS.filter(function (d) { return l.docs && l.docs[d[0]]; }).length;
        return [ui.link('/vendeur/lots/' + l.id, l.id), '<span class="mono">' + esc(l.mpn) + '</span>', esc(l.mfr || '—'), CP.num(l.qty), esc(l.dc || '—'), esc(l.pack || '—'), lotState(l), n + ' / ' + CP.DOCS.length, l.duplicateOf ? ui.pill('Doublon possible', 'wait') : ''];
      }), 'Aucun lot. Importez une stocklist.')) +
      '<form class="card form" data-form="import"><h2>Importer une stocklist</h2>' +
      '<p class="muted small">Formats acceptés : flux fournisseur au format Octopart, ECIA Global Standard. Un même lot (référence et date code) est mis à jour plutôt que dupliqué ; un lot identique chez un autre vendeur est signalé comme doublon possible.</p>' +
      '<fieldset class="choice"><label><input type="radio" name="format" value="octopart"' + (fmt === 'octopart' ? ' checked' : '') + ' data-sample="octopart"> Octopart</label><label><input type="radio" name="format" value="ecia"' + (fmt === 'ecia' ? ' checked' : '') + ' data-sample="ecia"> ECIA</label> ' + ui.link('/vendeur/stock?format=' + (fmt === 'ecia' ? 'octopart' : 'ecia'), 'Charger l\'exemple ' + (fmt === 'ecia' ? 'Octopart' : 'ECIA')) + '</fieldset>' +
      '<label class="field"><span>Contenu du fichier</span><textarea name="csv" rows="6" class="mono">' + esc(SAMPLES[fmt]) + '</textarea></label><button class="btn">Importer</button></form>');
  };
  CP.forms['import'] = function (d) {
    var res = CP.call('POST', '/v1/stocklists', { format: d.format, csv: d.csv });
    if (res) CP.toast(res.created.length + ' lot(s) créé(s), ' + res.updated.length + ' mis à jour' + (res.possibleDuplicates.length ? ', ' + res.possibleDuplicates.length + ' doublon(s) possible(s)' : '') + '.', 'ok');
  };

  // ------------------------------------------------------------ lot : questionnaire et documents
  CP.views['/vendeur/lots/:id'] = function (r) {
    var l = CP.get('/v1/lots/' + r.params.id);
    if (!l) return ui.page('Lot introuvable', '', '');
    var q = l.q || {}, cm = l.comments || {};
    return ui.page('Lot ' + esc(l.id), '<span class="mono">' + esc(l.mpn) + '</span> · ' + esc(l.mfr || '') + ' · ' + CP.num(l.qty) + ' pièces · date code ' + esc(l.dc || '—') + ' · ' + lotState(l),
      '<form class="card form" data-form="questionnaire"><input type="hidden" name="lot" value="' + esc(l.id) + '"><h2>Questionnaire d\'état</h2>' +
      '<p class="muted small">Les réponses engagent le vendeur, font partie de la commande et priment sur ses exclusions de garantie. « Refuse de répondre » reste possible mais visible de l\'acheteur, qui peut filtrer sur chaque réponse.</p>' +
      '<ol class="qform">' + CP.QUESTIONS.map(function (x) {
        return '<li><label class="field"><span>' + esc(x.q) + '</span><select name="q_' + x.k + '"><option value="">À renseigner</option>' + x.a.concat([CP.REFUSED]).map(function (a) { return '<option' + (q[x.k] === a ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('') + '</select></label>' +
          '<input name="c_' + x.k + '" value="' + esc(cm[x.k] || '') + '" placeholder="Commentaire (facultatif)" aria-label="Commentaire : ' + esc(x.q) + '"></li>';
      }).join('') + '</ol>' +
      '<h2>Documents qualité</h2><fieldset class="checks">' + CP.DOCS.map(function (d) { return '<label><input type="checkbox" name="d_' + d[0] + '"' + (l.docs && l.docs[d[0]] ? ' checked' : '') + '> ' + esc(d[1]) + '</label>'; }).join('') + '</fieldset>' +
      '<p class="muted small">En maquette, cocher simule le téléversement du document.</p>' +
      '<div class="row-btn"><button class="btn">Enregistrer</button> ' + ui.btn('Tout renseigner (démo)', 'fill-q', { lot: l.id }, 'ghost') + '</div></form>');
  };
  CP.forms.questionnaire = function (d) {
    var answers = {}, comments = {}, docs = {};
    Object.keys(d).forEach(function (k) {
      if (k.indexOf('q_') === 0 && d[k]) answers[k.slice(2)] = d[k];
      if (k.indexOf('c_') === 0 && d[k]) comments[k.slice(2)] = d[k];
      if (k.indexOf('d_') === 0) docs[k.slice(2)] = d[k];
    });
    if (CP.call('PUT', '/v1/lots/' + d.lot + '/questionnaire', { answers: answers, comments: comments }) && CP.call('PUT', '/v1/lots/' + d.lot + '/documents', { docs: docs })) CP.toast('Lot enregistré.', 'ok');
  };
  CP.actions['fill-q'] = function (b) {
    var id = b.getAttribute('data-lot'), a = {};
    CP.QUESTIONS.forEach(function (x) { a[x.k] = x.a[0]; });
    a.opened = 'Oui'; a.pack = CP.state.lots[id].pack || 'Tube';
    if (CP.QUESTIONS[10].a.indexOf(a.pack) < 0) a.pack = 'Tube';
    if (CP.call('PUT', '/v1/lots/' + id + '/questionnaire', { answers: a, comments: {} }) && CP.call('PUT', '/v1/lots/' + id + '/documents', { docs: { photos: true, datasheet: true, proof: true } })) CP.toast('Questionnaire renseigné.', 'ok');
  };

  // ------------------------------------------------------------ demande anonymisée et enchère
  CP.views['/vendeur/demandes/:id'] = function (r) {
    var d = CP.get('/v1/demands/' + r.params.id);
    if (!d) return ui.page('Demande introuvable', 'Cette demande n\'a pas été diffusée à votre société.', '');
    var mine = CP.get('/v1/demands/' + d.id + '/bids/mine') || {};
    var advice = CP.get('/v1/pricing/advice?mpn=' + encodeURIComponent(d.mpn) + '&qty=' + d.qty);
    var lots = (CP.get('/v1/lots') || []).filter(function (l) { return l.mpn === d.mpn; });
    var bid = mine.bid;
    var form = '';
    if (d.status === 'auction') {
      form = '<form class="card form" data-form="bid"><input type="hidden" name="demand" value="' + esc(d.id) + '"><h2>' + (bid ? 'Modifier votre offre' : 'Votre offre scellée') + '</h2>' +
        (advice ? '<p class="hint">Fourchette conseillée par Adesio : <b>' + CP.eur(advice.low) + ' à ' + CP.eur(advice.high) + '</b> net l\'unité.</p>' : '') +
        '<label class="field"><span>Lot proposé</span><select name="lot">' + lots.map(function (l) {
          return '<option value="' + l.id + '"' + (bid && bid.lotId === l.id ? ' selected' : '') + '>' + l.id + ' · ' + CP.num(l.qty) + ' pièces · DC ' + esc(l.dc) + (l.complete ? '' : ' · questionnaire incomplet') + (l.qty < d.qty ? ' · quantité insuffisante' : '') + '</option>';
        }).join('') + '</select></label>' +
        '<div class="row"><label class="field"><span>Prix net unitaire (€)</span><input type="number" name="net" step="0.01" min="0.01" value="' + (bid ? bid.net : advice ? advice.high : '') + '" required></label><label class="field"><span>Expédition sous (j ouvrés)</span><input type="number" name="leadDays" min="1" max="30" value="' + (bid ? bid.leadDays : 5) + '"></label></div>' +
        '<p class="muted small">Central.Parts ajoute sa marge et ses frais pour présenter une offre tout compris à l\'acheteur. Vous êtes payé de votre prix net, moins la commission vendeur, après acceptation des pièces.</p><button class="btn">' + (bid ? 'Mettre à jour' : 'Envoyer l\'offre') + '</button>' +
        lots.filter(function (l) { return !l.complete; }).map(function (l) { return '<p class="warn-line">Le lot ' + ui.link('/vendeur/lots/' + l.id, l.id) + ' doit avoir un questionnaire complet pour enchérir.</p>'; }).join('') + '</form>';
    }
    return ui.page('Demande ' + esc(d.id), 'Demande anonymisée : ni le nom ni l\'adresse de l\'acheteur ne sont communiqués.',
      '<div class="grid2">' + ui.card('Ce que demande l\'acheteur', ui.kv([['Référence', '<span class="mono">' + esc(d.mpn) + '</span> · ' + esc(d.mfr)], ['Quantité', CP.num(d.qty)], ['Date code minimum', esc(d.dcMin || '—')], ['Emballage', esc(d.pack)], ['Zone de livraison', esc(d.zone)], ['Délai souhaité', d.leadDays + ' jours ouvrés'], ['Questionnaire', 'Complet, photos obligatoires'], ['Acheteur', '<span class="muted">Masqué</span>'], ['Clôture', esc(CP.fmtDay(d.closesDay))], ['Statut', CP.demStatus(d)]])) +
      ui.card('Position', bid ? '<p class="rank">Votre offre : <b>' + CP.eur(bid.net) + '</b> net · rang <b>' + mine.rank + ' sur ' + mine.count + '</b></p><p class="muted small">Les offres concurrentes restent scellées : vous ne voyez que votre rang.</p>' : '<p class="empty">Pas encore d\'offre de votre part.</p>') + '</div>' + form);
  };
  CP.forms.bid = function (d) {
    var r = CP.call('POST', '/v1/demands/' + d.demand + '/bids', { lotId: d.lot, net: d.net, leadDays: d.leadDays });
    if (r) CP.toast('Offre enregistrée : rang ' + r.rank + ' sur ' + r.count + '.', 'ok');
  };

  // ------------------------------------------------------------ transaction
  CP.views['/vendeur/transactions/:id'] = function (r) {
    var t = CP.get('/v1/transactions/' + r.params.id);
    if (!t) return ui.page('Transaction introuvable', '', '');
    var payout = t.net * t.qty * (1 - P.sellerCommission);
    var action;
    switch (t.status) {
      case 'to_sign_seller':
        action = '<p>L\'acheteur a signé. Votre signature engage le lot, le questionnaire et les délais de la fiche.</p>' + ui.btn('Signer la fiche transaction', 'sign', { tx: t.id });
        break;
      case 'to_ship':
        action = '<p>Fonds déposés sur le compte dédié : expédiez avant le <b>' + esc(CP.fmtDay(t.due.day)) + '</b>. Sans expédition, la transaction est annulée.</p>' +
          ui.kv([['Destination', t.labLevel ? 'Laboratoire partenaire (adresse sur l\'étiquette fournie)' : 'Adresse sur l\'étiquette neutre fournie, zone ' + esc(t.zone)], ['Étiquette', '<span class="mono">EXP-' + esc(t.id.slice(3)) + '</span> à imprimer']]) +
          '<form class="inline" data-form="ship"><input type="hidden" name="tx" value="' + t.id + '"><select name="carrier" aria-label="Transporteur"><option>DHL Express</option><option>UPS</option><option>FedEx</option></select><input name="tracking" placeholder="Numéro de suivi" required><button class="btn">Confirmer l\'expédition</button></form>';
        break;
      case 'counter_inspection':
        action = '<p>L\'acheteur a rejeté ' + t.rejection.qty + ' pièce(s) : <b>' + esc(t.rejection.reason) + '</b>' + (t.rejection.comment ? ' (« ' + esc(t.rejection.comment) + ' »)' : '') + '. Retour en route, suivi <span class="mono">' + esc(t.returnTracking) + '</span>.</p><p>Contre-inspectez avant le <b>' + esc(CP.fmtDay(t.due.day)) + '</b> ; sans réponse, le retour est réputé accepté.</p>' + counterButtons(t);
        break;
      case 'lab_failed':
        action = '<p>Le laboratoire a rendu un verdict défavorable (voir le certificat). Vous pouvez l\'accepter, l\'acheteur est alors remboursé, ou le contester : un second laboratoire indépendant tranche.</p>' + counterButtons(t);
        break;
      case 'return_due':
        action = '<p>L\'acheteur a rejeté ' + t.rejection.qty + ' pièce(s) : ' + esc(t.rejection.reason.toLowerCase()) + '. Retour attendu.</p>';
        break;
      default:
        action = CP.waitText(t);
    }
    return ui.page('Transaction ' + esc(t.id), esc(t.mpn) + ' × ' + CP.num(t.qty) + ' · acheteur ' + esc(t.buyer) + ' · ' + ui.txStatus(t) + ' ' + ui.due(t),
      ui.timeline(t) +
      '<div class="grid2">' + ui.card('Action', action, 'action') +
      ui.card('Fiche transaction', ui.kv([['Lot', esc(t.lotId) + ' · <span class="mono">' + esc(t.mpn) + '</span>'], ['Quantité', CP.num(t.qty)], ['Votre prix net', CP.eur(t.net) + ' l\'unité'], ['Paiement estimé', CP.eur(payout) + ' <span class="muted small">(commission vendeur fictive de ' + Math.round(P.sellerCommission * 100) + ' %)</span>'], ['Acheteur', esc(t.buyer)], ['Zone de livraison', esc(t.zone)], ['Laboratoire', t.labLevel ? esc(P.labLevels[t.labLevel].name) : 'Pas de test'], ['Délai de contre-inspection', t.delays.counter + ' j ouvrés']])) + '</div>' +
      CP.certificate(t) +
      ui.card('Historique', ui.history(t)));
  };
  function counterButtons(t) {
    return ui.btn(t.status === 'lab_failed' ? 'J\'accepte le verdict' : 'J\'accepte le retour', 'counter-accept', { tx: t.id }) +
      '<form class="sub" data-form="contest"><input type="hidden" name="tx" value="' + t.id + '"><label class="field"><span>Contester (motif)</span><input name="comment" placeholder="Pièces conformes à l\'envoi, photos jointes…" required></label><button class="btn ghost">Ouvrir un litige</button></form>';
  }
  CP.forms.ship = function (d) { CP.call('POST', '/v1/transactions/' + d.tx + '/shipments', { carrier: d.carrier, tracking: d.tracking }, 'Expédition enregistrée.'); };
  CP.actions['counter-accept'] = function (b) { CP.call('POST', '/v1/transactions/' + b.getAttribute('data-tx') + '/counter-inspection', { decision: 'accept' }, 'Retour accepté : l\'acheteur va être remboursé.'); };
  CP.forms.contest = function (d) { CP.call('POST', '/v1/transactions/' + d.tx + '/counter-inspection', { decision: 'contest', comment: d.comment }, 'Litige ouvert : médiation par Central.Parts.'); };
})();
