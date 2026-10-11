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
    var sub = CP.get('/v1/organizations/' + CP.actor.org + '/subscription') || {};
    var s = sub.subscription;
    var statusCard = ui.card('Statut ' + ui.verified(sub.verified), '<p>Le statut « vérifié » affiché aux acheteurs signifie que votre société a passé le KYB et que son abonnement est à jour. Sans lui, vous ne recevez plus les demandes et ne pouvez plus enchérir ; les transactions en cours vont à leur terme.</p>' +
      ui.kv([['KYB', sub.kyb === 'validated' ? ui.pill('Validé', 'ok') : ui.pill('À valider', 'todo')], ['Abonnement', s ? esc(s.plan) + ' · ' + (s.status === 'active' ? 'jusqu\'au ' + esc(CP.fmtDay(CP.state.orgs[CP.actor.org].subscription.until)) + (s.daysLeft <= 5 ? ' ' + ui.pill('Expire dans ' + s.daysLeft + ' j', 'todo') : '') : ui.pill('Expiré', 'danger')) : 'Aucun']]) +
      '<p>' + ui.btn(s ? 'Renouveler l\'abonnement' : 'Souscrire l\'abonnement', 'sub-renew', {}, s && s.status === 'active' && s.daysLeft > 5 ? 'ghost' : '') + ' <span class="muted small">Tarif à fixer ; paiement en ligne prévu.</span></p>', sub.verified ? '' : 'action');
    return ui.page('Tableau de bord vendeur', esc(me.name) + ' · pseudonyme vu par les acheteurs : <b>' + esc(me.alias) + '</b> · profil : ' + esc(me.profile || '') + ' · ' + ui.verified(sub.verified),
      statusCard + ui.stats([['Enchères ouvertes', open.length], ['Actions à faire', todo.length], ['Lots en stock', lots.length], ['Questionnaires incomplets', incomplete.length]]) +
      '<div class="grid2">' + ui.card('À faire', actions.length ? '<ul class="todo-list">' + actions.join('') + '</ul>' : '<p class="empty">Rien à faire pour le moment.</p>') + ui.card('Notifications', ui.notifs(notifs)) + '</div>' +
      ui.card('Demandes correspondant à votre stock', ui.table(['Demande', 'Référence', '>Qté', 'Zone', 'Acheteur', 'Clôture', 'Statut'], dem.map(function (d) {
        return [ui.link('/vendeur/demandes/' + d.id, d.id) + (d.sandbox ? ' ' + ui.pill('Bac à sable', 'wait') : ''), '<span class="mono">' + esc(d.mpn) + '</span>', CP.num(d.qty), esc(d.zone), '<span class="muted">Masqué</span>', esc(CP.fmtDay(d.closesDay)), CP.demStatus(d)];
      }), 'Aucune demande ne correspond à votre stock.')) +
      ui.card('Transactions', ui.table(['Transaction', 'Référence', '>Qté', 'Acheteur', 'Étape', ''], tx.map(function (t) {
        return [ui.link('/vendeur/transactions/' + t.id, t.id), '<span class="mono">' + esc(t.mpn) + '</span>', CP.num(t.qty), esc(t.buyer), ui.txStatus(t), ui.due(t)];
      }), 'Aucune transaction.')));
  };

  CP.actions['sub-renew'] = function () { CP.call('POST', '/v1/organizations/' + CP.actor.org + '/subscription/renewal', {}, 'Abonnement renouvelé : statut « vérifié » actif.'); };

  // ------------------------------------------------------------ stock et import
  // Exemples fictifs. Le format broker reprend les colonnes annoncées par un broker partenaire.
  var SAMPLES = {
    broker: 'Manufacturer,SKU,MPN,Product URL,Unit Price,Quantity,Price per 10 pcs,Price per 100 pcs,"Price per 1,000 pcs"\nAMD Xilinx,HB-000187,XC2S100-5TQ144C,https://exemple.invalid/p/HB-000187,58.00,600,56.50,54.00,51.00\nNXP,HB-000213,MC68HC10E1CFNE2,https://exemple.invalid/p/HB-000213,24.00,1200,23.20,22.10,20.90\nTexas Instruments,HB-004410,SN74LS245N,https://exemple.invalid/p/HB-004410,0.92,15000,0.88,0.81,0.74\nAnalog Devices,HB-007731,AD7714ARZ-5,https://exemple.invalid/p/HB-007731,11.40,250,11.00,10.50,',
    octopart: 'mpn,manufacturer,quantity,date_code,packaging,price\nXC2S100-5TQ144C,AMD Xilinx,600,2010,Plateau,52\nMC68HC11E1CFNE2,NXP,90,2012,Tube,19\nAD7714ARZ-5,Analog Devices,250,2015,Tube,9.5',
    ecia: 'Manufacturer Part Number;Manufacturer;Quantity Available;Date Code;Package Type;Unit Price\nEP2C8T144C8N;Intel;350;2013;Plateau;24\nMAX232CPE+;Analog Devices;1200;2019;Tube;1.2',
  };
  function money(v) { return Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }); }
  var FORMATS = [['broker', 'Broker (CSV ou XLS)'], ['octopart', 'Octopart'], ['ecia', 'ECIA']];
  function tiers(l) {
    var t = l.tiers || {};
    var k = Object.keys(t);
    return k.length ? '<span class="tiers">' + k.map(function (q) { return CP.num(q) + '+ : ' + CP.money(t[q], l.currency); }).join('<br>') + '</span>' : '—';
  }
  CP.views['/vendeur/stock'] = function (r) {
    var lots = CP.get('/v1/lots') || [];
    var fmt = FORMATS.some(function (f) { return f[0] === r.query.format; }) ? r.query.format : 'broker';
    var me = CP.state.orgs[CP.actor.org];
    var last = CP.lastImport && CP.lastImport.sellerId === CP.actor.org ? CP.get('/v1/stocklists/' + CP.lastImport.id) : null;
    var report = last ? ui.card('Rapport d\'import ' + esc(last.id) + ' ' + ui.pill(last.channel === 'sftp' ? 'SFTP' : 'API', 'inv'),
      ui.stats([['Lignes lues', CP.num(last.rows)], ['Lots créés', last.created.length], ['Mis à jour', last.updated.length], ['Doublons possibles', last.possibleDuplicates.length], ['Lignes rejetées', last.rejected.length], ['Date code à la consultation', last.missingDateCode]]) +
      (last.rejected.length ? '<p class="small">' + last.rejected.map(function (x) { return 'Ligne ' + x.line + ' : ' + esc(x.reason); }).join(' · ') + '</p>' : '') +
      (last.missingDateCode ? '<p class="muted small">' + last.missingDateCode + ' lot(s) sans date code : facultatif dans le stock, il sera demandé au moment de répondre à une demande.</p>' : '')) : '';
    return ui.page('Stock et lots', 'Chaque lot porte son questionnaire d\'état et ses documents. Le date code est facultatif dans le stock : il est demandé quand vous répondez à une demande.',
      report +
      ui.card('Lots déclarés (' + lots.length + ')', ui.table(['Lot', 'SKU', 'Référence', 'Fabricant', '>Qté', 'Date code', '>Prix unitaire', 'Paliers', 'Questionnaire', ''], lots.map(function (l) {
        return [ui.link('/vendeur/lots/' + l.id, l.id), '<span class="mono small">' + esc(l.sku || '—') + '</span>', '<span class="mono">' + esc(l.mpn) + '</span>', esc(l.mfr || '—'), CP.num(l.qty), l.dc ? esc(l.dc) : '<span class="muted small">À la consultation</span>', l.price ? CP.money(l.price, l.currency) : '—', '<span class="small">' + tiers(l) + '</span>', lotState(l), l.duplicateOf ? ui.pill('Doublon possible', 'wait') : ''];
      }), 'Aucun lot. Importez une stocklist.')) +
      '<div class="grid2"><form class="card form" data-form="import"><h2>Importer un fichier</h2>' +
      '<p class="muted small">CSV ou XLS jusqu\'à 500 000 lignes par l\'API. Colonnes reconnues : Manufacturer, SKU, MPN, Product URL, Unit Price, Quantity, Price per 10, 100 et 1 000 pcs, ainsi que les formats Octopart et ECIA. Un même SKU met à jour le lot existant.</p>' +
      '<fieldset class="choice">' + FORMATS.map(function (f) { return '<label><input type="radio" name="format" value="' + f[0] + '"' + (fmt === f[0] ? ' checked' : '') + '> ' + f[1] + ' · ' + ui.link('/vendeur/stock?format=' + f[0], 'exemple') + '</label>'; }).join('') + '</fieldset>' +
      '<label class="field"><span>Contenu du fichier (en maquette : CSV collé)</span><textarea name="csv" rows="7" class="mono">' + esc(SAMPLES[fmt]) + '</textarea></label><button class="btn">Importer</button></form>' +
      ui.card('Dépôt SFTP pour les gros volumes', '<p>Au-delà de 500 000 lignes, le vendeur dépose son fichier par SFTP. Il est traité de façon asynchrone et produit le même rapport d\'import.</p>' +
        ui.kv([['Serveur', '<span class="mono">sftp.central.parts</span> (prévu)'], ['Dossier', '<span class="mono">/inbox/' + esc(me.alias) + '/</span>'], ['Authentification', 'Clé SSH par société, déposée à l\'inscription'], ['Formats', 'CSV ou XLS, mêmes colonnes'], ['Fréquence', 'Quotidienne conseillée : le fichier complet remplace le précédent']]) +
        '<p>' + ui.btn('Simuler un dépôt SFTP du fichier ci-contre', 'sftp-drop', {}, 'ghost') + '</p>') + '</div>');
  };
  CP.forms['import'] = function (d) {
    var res = CP.call('POST', '/v1/stocklists', { format: d.format, csv: d.csv, filename: 'stocklist.' + (d.format === 'broker' ? 'xlsx' : 'csv') });
    if (res) { CP.lastImport = res; CP.toast(res.created.length + ' lot(s) créé(s), ' + res.updated.length + ' mis à jour.', 'ok'); }
  };
  CP.actions['sftp-drop'] = function () {
    var ta = document.querySelector('form[data-form="import"] textarea');
    var fmt = document.querySelector('form[data-form="import"] input[name="format"]:checked');
    var r = CP.system('POST', '/v1/webhooks/sftp/stocklist', { sellerId: CP.actor.org, format: fmt ? fmt.value : 'broker', filename: 'stock_' + CP.state.orgs[CP.actor.org].alias + '.csv', csv: ta ? ta.value : '' });
    if (r.error) CP.toast(r.status + ' · ' + r.error, 'error');
    else { CP.lastImport = r.data; CP.toast('Fichier SFTP traité : ' + r.data.created.length + ' lot(s) créé(s), ' + r.data.updated.length + ' mis à jour.', 'ok'); }
  };

  // ------------------------------------------------------------ lot : questionnaire et documents
  CP.views['/vendeur/lots/:id'] = function (r) {
    var l = CP.get('/v1/lots/' + r.params.id);
    if (!l) return ui.page('Lot introuvable', '', '');
    var q = l.q || {}, cm = l.comments || {};
    return ui.page('Lot ' + esc(l.id), '<span class="mono">' + esc(l.mpn) + '</span> · ' + esc(l.mfr || '') + ' · ' + CP.num(l.qty) + ' pièces · date code ' + esc(l.dc || '—') + ' · ' + lotState(l),
      '<form class="card form" data-form="lot-update"><input type="hidden" name="lot" value="' + esc(l.id) + '"><h2>Lot</h2>' +
      ui.kv([['SKU vendeur', '<span class="mono">' + esc(l.sku || '—') + '</span>'], ['Fiche produit', l.url ? '<a href="' + esc(l.url) + '" rel="noopener nofollow" target="_blank">' + esc(l.url) + '</a>' : '—'], ['Prix unitaire', l.price ? CP.money(l.price, l.currency) : '—'], ['Paliers', tiers(l)]]) +
      '<div class="row"><label class="field"><span>Date code (facultatif, demandé à la consultation)</span><input name="dc" value="' + esc(l.dc || '') + '" placeholder="2014 ou 2209"></label><label class="field"><span>Conditionnement</span><input name="pack" value="' + esc(l.pack || '') + '" placeholder="Plateau, tube, bobine…"></label><label class="field"><span>Quantité</span><input name="qty" type="number" min="1" value="' + l.qty + '"></label></div><button class="btn ghost">Enregistrer le lot</button></form>' +
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
  CP.forms['lot-update'] = function (d) { CP.call('PATCH', '/v1/lots/' + d.lot, { dc: d.dc, pack: d.pack, qty: d.qty }, 'Lot enregistré.'); };
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
    var lots = (CP.get('/v1/lots') || []).filter(function (l) { return l.mpn === d.mpn; });
    var bid = mine.bid;
    var lot0 = lots.filter(function (l) { return bid && l.id === bid.lotId; })[0] || lots[0] || {};
    var cur = (bid && bid.currency) || lot0.currency || CP.state.orgs[CP.actor.org].currency || 'EUR';
    var advice = CP.get('/v1/pricing/advice?mpn=' + encodeURIComponent(d.mpn) + '&qty=' + d.qty + '&currency=' + cur);
    var form = '';
    if (d.status === 'auction') {
      form = '<form class="card form" data-form="bid"><input type="hidden" name="demand" value="' + esc(d.id) + '"><h2>' + (bid ? 'Modifier votre offre' : 'Votre offre scellée') + '</h2>' +
        (advice ? '<p class="hint">Fourchette conseillée par Adesio : <b>' + CP.money(advice.low, cur) + ' à ' + CP.money(advice.high, cur) + '</b> net l\'unité.</p>' : '') +
        '<label class="field"><span>Lot proposé</span><select name="lot">' + lots.map(function (l) {
          return '<option value="' + l.id + '"' + (lot0.id === l.id ? ' selected' : '') + '>' + l.id + ' · ' + CP.num(l.qty) + ' pièces · DC ' + esc(l.dc || 'à préciser') + (l.complete ? '' : ' · questionnaire incomplet') + (l.qty < d.qty ? ' · quantité insuffisante' : '') + '</option>';
        }).join('') + '</select></label>' +
        '<div class="row"><label class="field"><span>Prix net unitaire</span><input type="number" name="net" step="0.0001" min="0.0001" value="' + (bid ? bid.net : advice ? advice.high : '') + '" required></label>' +
        '<label class="field"><span>Devise</span><select name="currency">' + Object.keys(CP.PARAMS.currencies).map(function (c) { return '<option value="' + c + '"' + (c === cur ? ' selected' : '') + '>' + (c === 'CNY' ? 'CNY (RMB)' : c) + '</option>'; }).join('') + '</select></label></div>' +
        '<div class="row"><label class="field"><span>Date code du lot proposé</span><input name="dateCode" value="' + esc((bid && bid.dc) || lot0.dc || '') + '" placeholder="2014, 2209 ou 2009/2012" required></label><label class="field"><span>Expédition sous (j ouvrés)</span><input type="number" name="leadDays" min="1" max="30" value="' + (bid ? bid.leadDays : 5) + '"></label></div>' +
        '<p class="muted small">Le date code peut manquer dans votre stock : il est demandé ici, au moment de la consultation, puis reporté sur le lot. Vous êtes payé dans votre devise, de votre prix net moins la commission vendeur, après acceptation des pièces. Central.Parts convertit en euros et ajoute sa marge pour l\'acheteur.</p><button class="btn">' + (bid ? 'Mettre à jour' : 'Envoyer l\'offre') + '</button>' +
        lots.filter(function (l) { return !l.complete; }).map(function (l) { return '<p class="warn-line">Le lot ' + ui.link('/vendeur/lots/' + l.id, l.id) + ' doit avoir un questionnaire complet pour enchérir.</p>'; }).join('') + '</form>';
    }
    return ui.page('Demande ' + esc(d.id), 'Demande anonymisée : ni le nom ni l\'adresse de l\'acheteur ne sont communiqués.' + (d.liveConfirmed ? ' ' + ui.pill('Stock confirmé par votre API', 'inv') : ''),
      '<div class="grid2">' + ui.card('Ce que demande l\'acheteur', ui.kv([['Référence', '<span class="mono">' + esc(d.mpn) + '</span> · ' + esc(d.mfr)], ['Quantité', CP.num(d.qty)], ['Date code minimum', esc(d.dcMin || '—')], ['Emballage', esc(d.pack)], ['Zone de livraison', esc(d.zone)], ['Délai souhaité', d.leadDays + ' jours ouvrés'], ['Questionnaire', 'Complet, photos obligatoires'], ['Acheteur', '<span class="muted">Masqué</span>'], ['Clôture', esc(CP.fmtDay(d.closesDay))], ['Statut', CP.demStatus(d)]])) +
      ui.card('Position', bid ? '<p class="rank">Votre offre : <b>' + CP.money(bid.net, bid.currency) + '</b> net · date code ' + esc(bid.dc || '—') + ' · rang <b>' + mine.rank + ' sur ' + mine.count + '</b></p><p class="muted small">Les offres concurrentes restent scellées : vous ne voyez que votre rang.</p>' : '<p class="empty">Pas encore d\'offre de votre part.</p>') + '</div>' + form);
  };
  CP.forms.bid = function (d) {
    var r = CP.call('POST', '/v1/demands/' + d.demand + '/bids', { lotId: d.lot, net: d.net, currency: d.currency, dateCode: d.dateCode, leadDays: d.leadDays });
    if (r) CP.toast('Offre enregistrée : rang ' + r.rank + ' sur ' + r.count + '.', 'ok');
  };

  // ------------------------------------------------------------ transaction
  CP.views['/vendeur/transactions/:id'] = function (r) {
    var t = CP.get('/v1/transactions/' + r.params.id);
    if (!t) return ui.page('Transaction introuvable', '', '');
    var payout = t.net * t.qty * (1 - P.sellerCommission), cur = t.netCurrency || 'EUR';
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
      ui.card('Fiche transaction', ui.kv([['Lot', esc(t.lotId) + ' · <span class="mono">' + esc(t.mpn) + '</span>'], ['Quantité', CP.num(t.qty)], ['Votre prix net', CP.money(t.net, cur) + ' l\'unité'], ['Date code', esc(t.dc || t.lot.dc || '—')], ['Paiement estimé', CP.money(payout, cur) + ' <span class="muted small">(commission vendeur fictive de ' + Math.round(P.sellerCommission * 100) + ' %)</span>'], ['Acheteur', esc(t.buyer)], ['Zone de livraison', esc(t.zone)], ['Laboratoire', t.labLevel ? esc(P.labLevels[t.labLevel].name) : 'Pas de test'], ['Délai de contre-inspection', t.delays.counter + ' j ouvrés']])) + '</div>' +
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
