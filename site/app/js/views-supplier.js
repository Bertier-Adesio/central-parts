// Écran vendeur « Intégration par API » : clés, envoi d'offres, webhooks.
(function () {
  'use strict';
  var esc = CP.esc, ui = CP.ui;

  // Exemple fictif au format de l'API fournisseur (voir api/fournisseurs.md).
  var SAMPLE = {
    offers: [
      { sku: 'HB-000187', mpn: 'XC2S100-5TQ144C', manufacturer: 'AMD Xilinx', quantity: 600, unit_price: 58.0, currency: 'USD', price_breaks: [{ quantity: 10, price: 56.5 }, { quantity: 100, price: 54.0 }, { quantity: 1000, price: 51.0 }], date_code: '2010', packaging: 'Plateau', country_of_origin: 'TW', lead_time_days: 3, product_url: 'https://exemple.invalid/p/HB-000187' },
      { sku: 'HB-000213', mpn: 'MC68HC11E1CFNE2', manufacturer: 'NXP', quantity: 1200, unit_price: 168.0, currency: 'CNY', price_breaks: [{ quantity: 100, price: 155.0 }], packaging: 'Tube' },
      { sku: 'HB-000999', mpn: '', manufacturer: 'Texas Instruments', quantity: 10 },
    ],
    idempotency_key: 'lot-2026-10-12-0001',
  };

  CP.views['/vendeur/api'] = function () {
    var org = CP.actor.org, me = CP.state.orgs[org];
    var keys = CP.get('/v1/organizations/' + org + '/api-keys') || [];
    var hooks = CP.get('/v1/supplier/webhooks') || { webhooks: [], deliveries: [] };
    var offers = (CP.get('/v1/supplier/offers') || []).filter(function (o) { return o.sku; });
    var secret = CP.lastSecret && CP.lastSecret.org === org ? CP.lastSecret : null;
    var res = CP.lastBulk && CP.lastBulk.org === org ? CP.lastBulk.res : null;
    return ui.page('Intégration par API', 'Le fournisseur pousse son stock depuis son propre système : chaque changement de quantité ou de prix arrive en quelques secondes, sans fichier. Les fichiers CSV, XLS et le SFTP restent disponibles en repli. Spécification : <a href="https://github.com/Bertier-Adesio/central-parts/blob/main/api/fournisseurs.md">api/fournisseurs.md</a>.',
      ui.card('1. Clés d\'API', '<p class="muted small">Une clé par société et par environnement. En-tête <span class="mono">Authorization: Bearer &lt;clé&gt;</span>. La clé de production exige un KYB validé.</p>' +
        (secret ? '<p class="label-box mono">' + esc(secret.secret) + '</p><p class="warn-line">Copiez ce secret maintenant : il ne sera plus affiché.</p>' : '') +
        ui.table(['Clé', 'Environnement', 'Créée le', 'Libellé'], keys.map(function (k) { return ['<span class="mono">' + esc(k.prefix) + '…</span>', ui.pill(k.environment === 'live' ? 'Production' : 'Test', k.environment === 'live' ? 'ok' : 'wait'), esc(CP.fmtDay(k.day)), esc(k.label)]; }), 'Aucune clé.') +
        '<p class="row-btn">' + ui.btn('Créer une clé de test', 'key-create', { env: 'test' }) + ' ' + ui.btn('Créer une clé de production', 'key-create', { env: 'live' }, 'ghost') + '</p>') +
      '<div class="grid2">' +
      '<form class="card form" data-form="bulk"><h2>2. Envoyer des offres</h2><p class="muted small"><span class="mono">POST /v1/supplier/offers/bulk</span> : 1 000 offres au plus par appel, clé SKU. Une offre invalide n\'empêche pas les autres : chaque erreur est renvoyée avec son index. La troisième offre de l\'exemple est volontairement invalide.</p>' +
        '<label class="field"><span>Corps de la requête (JSON)</span><textarea name="json" rows="14" class="mono">' + esc(JSON.stringify(SAMPLE, null, 2)) + '</textarea></label><button class="btn">Envoyer</button>' +
        (res ? '<h3>Réponse</h3>' + ui.stats([['Reçues', res.received], ['Créées', res.created], ['Mises à jour', res.updated], ['Erreurs', res.errors.length]]) + (res.errors.length ? '<ul class="list">' + res.errors.map(function (e) { return '<li>Offre ' + e.index + (e.sku ? ' (' + esc(e.sku) + ')' : '') + ' : ' + esc(e.error) + '</li>'; }).join('') + '</ul>' : '') : '') + '</form>' +
      ui.card('Requête équivalente', '<pre class="code">curl -X POST https://api.central.parts/v1/supplier/offers/bulk \\\n  -H "Authorization: Bearer cp_test_…" \\\n  -H "Idempotency-Key: lot-2026-10-12-0001" \\\n  -H "Content-Type: application/json" \\\n  -d @offres.json</pre>' +
        '<p class="muted small">Retrait d\'une offre vendue ailleurs : <span class="mono">DELETE /v1/supplier/offers/{sku}</span>. Réconciliation : <span class="mono">GET /v1/supplier/offers?updated_since=…</span>. Domaine <span class="mono">api.central.parts</span> prévu.</p>') + '</div>' +
      ui.card('Offres reçues par l\'API (' + offers.length + ')', ui.table(['SKU', 'Référence', '>Qté', '>Prix', 'Paliers', 'Date code', 'Questionnaire', ''], offers.map(function (o) {
        return ['<span class="mono">' + esc(o.sku) + '</span>', '<span class="mono">' + esc(o.mpn) + '</span>', CP.num(o.quantity), o.unit_price ? CP.money(o.unit_price, o.currency) : '—', String(o.price_breaks.length), o.date_code ? esc(o.date_code) : '<span class="muted small">À la consultation</span>', o.questionnaire_complete ? ui.pill('Complet', 'ok') : ui.link('/vendeur/lots/' + o.lot_id, 'À compléter'), o.withdrawn ? ui.pill('Retirée', 'muted') : ui.btn('Retirer', 'sup-delete', { sku: o.sku }, 'small ghost')];
      }), 'Aucune offre avec SKU pour le moment.')) +
      sandboxCard(org) +
      '<div class="grid2"><form class="card form" data-form="hook"><h2>3. Webhooks</h2><p class="muted small">Central.Parts appelle votre URL à chaque événement, signé HMAC-SHA256 (en-tête <span class="mono">CP-Signature</span>). Une demande qui correspond à votre stock peut ainsi recevoir une offre par l\'API sans passer par l\'écran.</p>' +
        (CP.lastHookSecret && CP.lastHookSecret.org === org ? '<p class="label-box mono">Secret de signature : ' + esc(CP.lastHookSecret.secret) + '</p><p class="warn-line">Copiez ce secret maintenant : il ne sera plus affiché.</p>' : '') +
        '<label class="field"><span>URL HTTPS</span><input name="url" value="https://erp.exemple.invalid/central-parts/webhooks"></label>' +
        '<fieldset class="checks">' + [['demand.created', 'demand.created : nouvelle demande correspondant à votre stock'], ['offer.accepted', 'offer.accepted : votre offre est retenue'], ['transaction.updated', 'transaction.updated : chaque étape d\'une transaction']].map(function (e) { return '<label><input type="checkbox" name="ev_' + e[0] + '" checked> <span class="mono small">' + esc(e[1]) + '</span></label>'; }).join('') + '</fieldset><button class="btn">S\'abonner</button>' +
        ui.table(['Abonnement', 'URL', 'Événements'], hooks.webhooks.map(function (h) { return [esc(h.id), '<span class="mono small">' + esc(h.url) + '</span>', esc(h.events.join(', '))]; }), 'Aucun abonnement.') + '</form>' +
      ui.card('Dernières livraisons', hooks.deliveries.length ? '<ol class="hist">' + hooks.deliveries.map(function (d) { return '<li><span class="mono">' + esc(CP.fmtDay(d.day)) + '</span> <b class="mono small">' + esc(d.type) + '</b> → ' + d.status + '<pre class="code">' + esc(JSON.stringify(d.payload, null, 1)) + '</pre></li>'; }).join('') + '</ol>' : '<p class="empty">Aucun événement livré. Abonnez-vous, puis lancez une demande côté acheteur sur une référence de votre stock.</p>') + '</div>' +
      '<p class="muted small">' + esc(me.name) + ' · pseudonyme ' + esc(me.alias) + '. Toute offre de broker passe par les rails Opportunity : le questionnaire d\'état est exigé avant d\'enchérir, le date code au plus tard quand vous répondez à une demande. Devises acceptées : EUR, USD, CNY (RMB), HKD, GBP, JPY, TWD, SGD.</p>');
  };

  function sandboxCard(org) {
    var lots = (CP.get('/v1/lots') || []).filter(function (l) { return l.qty > 0; });
    var dems = (CP.get('/v1/demands') || []).filter(function (d) { return d.sandbox; });
    return ui.card('4. Bac à sable', '<p>Environnement de test isolé : <span class="mono">https://sandbox.api.central.parts/v1</span> (prévu), clés <span class="mono">cp_test_…</span> uniquement, données fictives effacées chaque nuit, aucun argent réel. Un acheteur fictif permet de tester toute la chaîne : offre poussée, demande reçue par webhook ou WeChat, enchère, offre retenue, signature, dépôt simulé, expédition.</p>' +
      '<form class="inline" data-form="sbx-demand"><select name="mpn" aria-label="Référence">' + lots.map(function (l) { return '<option>' + esc(l.mpn) + '</option>'; }).join('') + '</select><input type="number" name="quantity" min="1" value="100" aria-label="Quantité"><button class="btn">Simuler une demande d\'acheteur</button></form>' +
      ui.table(['Demande', 'Référence', '>Qté', 'Statut', ''], dems.map(function (d) {
        return [ui.link('/vendeur/demandes/' + d.id, d.id), '<span class="mono">' + esc(d.mpn) + '</span>', CP.num(d.qty), CP.demStatus(d), d.status === 'auction' ? ui.btn('Simuler l\'acceptation de mon offre', 'sbx-accept', { id: d.id }, 'small') : d.txId ? ui.link('/vendeur/transactions/' + d.txId, d.txId) : ''];
      }), 'Aucune demande de test.'));
  }
  CP.forms['sbx-demand'] = function (d) { CP.call('POST', '/v1/sandbox/demands', { mpn: d.mpn, quantity: d.quantity }, 'Demande de test créée : webhooks et notifications envoyés.'); };
  CP.actions['sbx-accept'] = function (b) { CP.call('POST', '/v1/sandbox/demands/' + b.getAttribute('data-id') + '/accept', {}, 'Offre acceptée par l\'acheteur fictif : fiche à signer.'); };

  CP.actions['key-create'] = function (b) {
    var k = CP.call('POST', '/v1/organizations/' + CP.actor.org + '/api-keys', { environment: b.getAttribute('data-env') }, 'Clé créée.');
    if (k) CP.lastSecret = { org: CP.actor.org, secret: k.secret };
  };
  CP.forms.bulk = function (d) {
    var body;
    try { body = JSON.parse(d.json); } catch (e) { CP.toast('JSON invalide : ' + e.message, 'error'); return; }
    var r = CP.call('POST', '/v1/supplier/offers/bulk', body);
    if (r) { CP.lastBulk = { org: CP.actor.org, res: r }; CP.toast(r.created + ' créée(s), ' + r.updated + ' mise(s) à jour, ' + r.errors.length + ' erreur(s).', r.errors.length ? 'error' : 'ok'); }
  };
  CP.actions['sup-delete'] = function (b) { CP.call('DELETE', '/v1/supplier/offers/' + encodeURIComponent(b.getAttribute('data-sku')), null, 'Offre retirée.'); };
  CP.forms.hook = function (d) {
    var ev = Object.keys(d).filter(function (k) { return k.indexOf('ev_') === 0 && d[k]; }).map(function (k) { return k.slice(3); });
    var h = CP.call('POST', '/v1/supplier/webhooks', { url: d.url, events: ev }, 'Abonnement créé.');
    if (h) CP.lastHookSecret = { org: CP.actor.org, secret: h.signing_secret };
  };
})();
