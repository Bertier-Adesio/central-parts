// Écran vendeur « Notifications » : e-mail, robot de groupe WeCom (企业微信), compte de service WeChat (服务号).
(function () {
  'use strict';
  var esc = CP.esc, ui = CP.ui;
  var TYPES = { wecom: 'WeCom 企业微信 · robot de groupe', wechat_oa: 'WeChat 服务号 · compte de service', email: 'E-mail' };
  var SHORT = { wecom: 'WeCom 企业微信', wechat_oa: 'WeChat 服务号', email: 'E-mail' };
  var LANGS = { zh: '中文', en: 'English', fr: 'Français' };
  var EVENTS = [['demand.created', 'Nouvelle demande correspondant au stock'], ['offer.accepted', 'Offre retenue'], ['transaction.updated', 'Étapes des transactions']];

  // QR code décoratif (motif fixe) : la maquette ne génère pas de vrai code.
  function fakeQr() {
    var n = 21, cells = '', seed = 7;
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
      var finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
      var on = finder ? (x % 6 === 0 || y % 6 === 0 || (x % 14 > 1 && x % 14 < 5 && y % 14 > 1 && y % 14 < 5) || (x > 13 && (x - 14) % 6 === 0) || (y > 13 && (y - 14) % 6 === 0)) : ((seed = (seed * 9301 + 49297) % 233280) / 233280 > 0.55);
      if (on) cells += '<rect x="' + x + '" y="' + y + '" width="1" height="1"/>';
    }
    return '<svg class="qr" viewBox="-2 -2 25 25" role="img" aria-label="QR code fictif du compte de service"><rect x="-2" y="-2" width="25" height="25" class="qr-bg"/>' + cells + '</svg>';
  }

  function phone(d) {
    var m = d.message;
    return '<figure class="phone"><figcaption>' + esc(TYPES[d.channel] || d.channel) + ' · ' + esc(LANGS[d.lang] || d.lang) + (d.test ? ' · essai' : '') + ' · ' + esc(CP.fmtDay(d.day)) + '</figcaption>' +
      '<div class="bubble" lang="' + esc(d.lang === 'zh' ? 'zh-Hans' : d.lang) + '"><b>' + esc(m.title) + '</b>' + m.lines.map(function (l) { return '<span>' + esc(l) + '</span>'; }).join('') + '<a class="bubble-btn" href="' + esc(m.url.replace('https://central.parts/app/', '')) + '">' + esc(m.button) + ' ›</a></div>' +
      '<details><summary>Requête envoyée</summary><p class="mono small">POST ' + esc(d.url) + '</p><pre class="code">' + esc(JSON.stringify(d.payload, null, 2)) + '</pre></details></figure>';
  }

  CP.views['/vendeur/notifications'] = function () {
    var org = CP.actor.org, me = CP.state.orgs[org];
    var data = CP.get('/v1/organizations/' + org + '/notification-channels') || { channels: [], deliveries: [] };
    var pendingQr = CP.pendingQr && CP.pendingQr.org === org ? CP.pendingQr : null;
    var defLang = me.lang || (me.country === 'Chine' || me.country === 'Hong Kong' ? 'zh' : 'fr');
    return ui.page('Notifications', 'Les demandes qui correspondent à votre stock arrivent là où vous travaillez : e-mail, groupe WeCom (企业微信) ou WeChat (服务号), dans votre langue. Les messages ne contiennent jamais l\'identité ni l\'adresse de l\'acheteur ; le bouton ouvre la demande sur la plateforme.',
      ui.card('Canaux actifs', ui.table(['Canal', 'Libellé', 'Destination', 'Langue', 'Événements', 'Statut', ''], data.channels.map(function (ch) {
        return ['<span class="nowrap">' + esc(SHORT[ch.type]) + '</span>', esc(ch.label || '—'), '<span class="mono small">' + esc(ch.target ? ch.target.replace(/key=.*/, 'key=…') : 'QR code à scanner') + '</span>', esc(LANGS[ch.lang]), '<span class="small">' + esc(ch.events.join(', ')) + '</span>',
          ch.status === 'active' ? ui.pill('Actif', 'ok') : ui.pill('En attente du scan', 'todo'),
          '<span class="row-btn">' + (ch.status === 'active' ? ui.btn('Essai', 'chan-test', { cid: ch.id }, 'small') : ui.btn('QR code', 'chan-qr', { cid: ch.id }, 'small')) + ' ' + ui.btn('Supprimer', 'chan-delete', { cid: ch.id }, 'small ghost') + '</span>'];
      }), 'Aucun canal. Les notifications restent visibles sur le tableau de bord.')) +
      (pendingQr ? ui.card('Lier un compte WeChat', '<div class="qr-wrap">' + fakeQr() + '<div><p>Scannez ce QR code avec WeChat (« 扫一扫 ») : vous suivez le compte de service Central.Parts et ce canal est rattaché à votre compte WeChat. Valable 10 minutes.</p><p class="mono small">scene : ' + esc(pendingQr.scene) + '</p>' + ui.btn('Simuler le scan dans WeChat', 'wechat-scan', { scene: pendingQr.scene }) + '</div></div>', 'action') : '') +
      '<div class="grid2"><form class="card form" data-form="chan-add"><h2>Ajouter un canal</h2>' +
        '<fieldset class="choice">' + Object.keys(TYPES).map(function (k, i) { return '<label><input type="radio" name="type" value="' + k + '"' + (i ? '' : ' checked') + '> ' + esc(TYPES[k]) + '</label>'; }).join('') + '</fieldset>' +
        '<label class="field"><span>Destination : URL du robot WeCom ou adresse e-mail (inutile pour WeChat 服务号, lié par QR code)</span><input name="target" value="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=00000000-fictif"></label>' +
        '<div class="row"><label class="field"><span>Libellé</span><input name="label" placeholder="Groupe ventes, responsable…"></label><label class="field"><span>Langue des messages</span><select name="lang">' + Object.keys(LANGS).map(function (k) { return '<option value="' + k + '"' + (k === defLang ? ' selected' : '') + '>' + LANGS[k] + '</option>'; }).join('') + '</select></label></div>' +
        '<fieldset class="checks"><legend>Événements</legend>' + EVENTS.map(function (e, i) { return '<label><input type="checkbox" name="ev_' + e[0] + '"' + (i < 2 ? ' checked' : '') + '> ' + esc(e[1]) + '</label>'; }).join('') + '</fieldset>' +
        '<button class="btn">Ajouter</button>' +
        '<p class="muted small">WeCom : dans le groupe, « 添加群机器人 », puis copier l\'URL du webhook. WeChat 服务号 : un QR code s\'affiche, à scanner avec le téléphone de la personne à notifier.</p></form>' +
      ui.card('Derniers messages', data.deliveries.length ? data.deliveries.slice(0, 4).map(phone).join('') : '<p class="empty">Aucun message envoyé. Envoyez un essai, ou lancez une demande côté acheteur sur une référence de votre stock.</p>') + '</div>');
  };

  CP.forms['chan-add'] = function (d) {
    var events = EVENTS.map(function (e) { return e[0]; }).filter(function (e) { return d['ev_' + e]; });
    var ch = CP.call('POST', '/v1/organizations/' + CP.actor.org + '/notification-channels', { type: d.type, target: d.target, lang: d.lang, label: d.label, events: events }, 'Canal ajouté.');
    if (ch && ch.type === 'wechat_oa') qr(ch.id);
  };
  function qr(cid) {
    var r = CP.call('POST', '/v1/wechat/qrcodes', { channelId: cid });
    if (r) CP.pendingQr = { org: CP.actor.org, scene: r.scene };
  }
  CP.actions['chan-qr'] = function (b) { qr(b.getAttribute('data-cid')); };
  CP.actions['wechat-scan'] = function (b) {
    var r = CP.system('POST', '/v1/webhooks/wechat', { event: 'subscribe', scene: b.getAttribute('data-scene'), openid: 'o6_' + Math.random().toString(36).slice(2, 14) + ' (fictif)' });
    if (r.error) CP.toast(r.status + ' · ' + r.error, 'error');
    else { CP.pendingQr = null; CP.toast('Compte WeChat lié : le canal est actif.', 'ok'); }
  };
  CP.actions['chan-test'] = function (b) { CP.call('POST', '/v1/organizations/' + CP.actor.org + '/notification-channels/' + b.getAttribute('data-cid') + '/test', {}, 'Message d\'essai envoyé.'); };
  CP.actions['chan-delete'] = function (b) { CP.call('DELETE', '/v1/organizations/' + CP.actor.org + '/notification-channels/' + b.getAttribute('data-cid'), null, 'Canal supprimé.'); };
})();
