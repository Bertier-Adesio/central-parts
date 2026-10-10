// Interface : routeur, mise en page, journal des appels d'API, composants communs.
(function () {
  'use strict';
  var esc = CP.esc;
  CP.views = {};
  CP.actions = {};
  CP.forms = {};

  // ------------------------------------------------------------ acteur courant
  function actorById(id) { return CP.ACTORS.filter(function (a) { return a.id === id; })[0]; }
  var saved = null;
  try { saved = localStorage.getItem('cp-app-actor'); } catch (e) { /* sans effet */ }
  CP.actor = actorById(saved) || CP.ACTORS[0];
  CP.setActor = function (id, go) {
    CP.actor = actorById(id) || CP.ACTORS[0];
    try { localStorage.setItem('cp-app-actor', CP.actor.id); } catch (e) { /* sans effet */ }
    if (go) location.hash = '#' + CP.HOME[CP.actor.role];
    else CP.render();
  };
  // Acteur par défaut pour un rôle (bascule depuis un lien de notification).
  CP.actorForRole = function (role) {
    if (role === CP.actor.role) return CP.actor;
    return CP.ACTORS.filter(function (a) { return a.role === role; })[0];
  };

  // ------------------------------------------------------------ appels depuis les écrans
  CP.get = function (path) {
    var r = CP.api('GET', path, null, { quiet: true });
    return r.status === 200 ? r.data : null;
  };
  CP.call = function (method, path, body, success) {
    var r = CP.api(method, path, body);
    if (r.error) { CP.toast(r.status + ' · ' + r.error, 'error'); return null; }
    if (success) CP.toast(success, 'ok');
    return r.data;
  };

  // ------------------------------------------------------------ composants
  var ROLE_LABEL = { public: 'Public', buyer: 'Acheteur', seller: 'Vendeur', lab: 'Laboratoire', bank: 'Banque', ops: 'Central.Parts', system: 'Système' };
  CP.ROLE_LABEL = ROLE_LABEL;

  CP.ui = {
    page: function (title, intro, body) {
      var r = CP.route;
      var eps = (r && r.def.endpoints || []).map(function (id) {
        var e = CP_ENDPOINTS.filter(function (x) { return x.id === id; })[0];
        return e ? '<a class="ep" href="#/api" data-ep="' + esc(e.id) + '" title="' + esc(e.summary) + '"><b class="m-' + e.method + '">' + e.method + '</b> ' + esc(e.path) + '</a>' : '';
      }).join('');
      return '<header class="ph"><p class="route mono">#' + esc(r ? r.path : '') + '</p><h1>' + title + '</h1>' + (intro ? '<p class="lead">' + intro + '</p>' : '') +
        (eps ? '<details class="eps"><summary>Endpoints de cet écran (' + r.def.endpoints.length + ')</summary><div>' + eps + '</div></details>' : '') + '</header>' + body;
    },
    card: function (title, body, extra) {
      return '<section class="card' + (extra ? ' ' + extra : '') + '">' + (title ? '<h2>' + title + '</h2>' : '') + body + '</section>';
    },
    kv: function (rows) {
      return '<dl class="kv">' + rows.filter(Boolean).map(function (r) { return '<div><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>'; }).join('') + '</dl>';
    },
    table: function (head, rows, empty) {
      if (!rows.length) return '<p class="empty">' + (empty || 'Rien pour le moment.') + '</p>';
      return '<div class="tbl"><table><thead><tr>' + head.map(function (h) { return '<th' + (h.charAt(0) === '>' ? ' class="num">' + h.slice(1) : '>' + h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + (head[i] && head[i].charAt(0) === '>' ? ' class="num"' : '') + '>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
    },
    pill: function (text, kind) { return '<span class="pill ' + (kind || '') + '">' + esc(text) + '</span>'; },
    link: function (href, text) { return '<a href="#' + esc(href) + '">' + text + '</a>'; },
    btn: function (label, act, data, kind, disabled) {
      var attrs = Object.keys(data || {}).map(function (k) { return ' data-' + k + '="' + esc(data[k]) + '"'; }).join('');
      return '<button type="button" class="btn ' + (kind || '') + '" data-act="' + act + '"' + attrs + (disabled ? ' disabled' : '') + '>' + label + '</button>';
    },
    stats: function (items) {
      return '<div class="stats">' + items.map(function (i) { return '<div class="stat"><b>' + i[1] + '</b><span>' + i[0] + '</span></div>'; }).join('') + '</div>';
    },
    txStatus: function (t) {
      var s = CP.TX_STATUS[t.status] || { label: t.status };
      var kind = s.turn === null ? (t.status === 'cancelled' ? 'muted' : 'ok') : s.turn === CP.actor.role ? 'todo' : 'wait';
      return CP.ui.pill(s.label, kind);
    },
    due: function (t) {
      if (!t.due) return '';
      var left = t.due.day - CP.state.day;
      return '<span class="due' + (left <= 1 ? ' soon' : '') + '">Échéance ' + esc(CP.fmtDay(t.due.day)) + ' · ' + (left <= 0 ? 'aujourd\'hui' : left + ' j ouvré' + (left > 1 ? 's' : '')) + '</span>';
    },
    // Frise commune à tous les rôles.
    timeline: function (t) {
      var cur = (CP.TX_STATUS[t.status] || {}).step || 0;
      var steps = CP.TX_STEPS.slice();
      if (!t.labLevel) steps[3] = 'Sans laboratoire';
      return '<ol class="tl">' + steps.map(function (s, i) {
        var cls = i < cur || cur === 7 ? 'done' : i === cur ? 'cur' : '';
        if (i === 3 && !t.labLevel) cls += ' skip';
        return '<li class="' + cls + '"><span>' + s + '</span></li>';
      }).join('') + '</ol>';
    },
    history: function (t) {
      if (!t.history) return '';
      return '<ol class="hist">' + t.history.slice().reverse().map(function (h) { return '<li><span class="mono">' + esc(CP.fmtDay(h.day)) + '</span> ' + esc(h.text) + '</li>'; }).join('') + '</ol>';
    },
    questionnaire: function (lot) {
      if (!lot) return '';
      var q = lot.q || {};
      return '<ul class="qa">' + CP.QUESTIONS.map(function (x) {
        var a = q[x.k];
        var bad = !a || a === CP.REFUSED || !goodAnswer(x.k, a);
        return '<li class="' + (bad ? 'warn' : 'ok') + '"><span>' + esc(x.q) + '</span><b>' + esc(a || 'Sans réponse') + '</b></li>';
      }).join('') + '</ul>';
    },
    docs: function (lot) {
      if (!lot) return '';
      return '<ul class="docs">' + CP.DOCS.map(function (d) { return '<li class="' + (lot.docs && lot.docs[d[0]] ? 'ok' : 'ko') + '">' + esc(d[1]) + '</li>'; }).join('') + '</ul>';
    },
    notifs: function (list) {
      if (!list || !list.length) return '<p class="empty">Aucune notification.</p>';
      return '<ul class="notifs">' + list.slice(0, 8).map(function (n) {
        return '<li><span class="mono">' + esc(CP.fmtDay(n.day)) + '</span> ' + (n.link ? '<a href="#' + esc(n.link) + '">' + esc(n.text) + '</a>' : esc(n.text)) + '</li>';
      }).join('') + '</ul>';
    },
  };
  // Réponses favorables du questionnaire (affichées en vert).
  function goodAnswer(k, a) {
    var good = { resold: 'Non', returns: 'Non', other: 'Non', opened: 'Non', new: 'Neuf', visual: 'Bon', dcHomogeneous: 'Oui', oem: 'Oui', storage: 'Oui' };
    if (k === 'origin') return a !== 'Autre broker';
    if (k === 'functional') return a !== 'Défaillances connues';
    return good[k] ? good[k] === a : true;
  }

  // ------------------------------------------------------------ routeur
  var compiled = CP_ROUTES.map(function (r) {
    var keys = [];
    var re = new RegExp('^' + r.path.replace(/:(\w+)/g, function (_, k) { keys.push(k); return '([^/]+)'; }) + '$');
    return { def: r, re: re, keys: keys };
  });
  function resolve(hash) {
    var full = hash.replace(/^#/, '') || '/';
    var path = full.split('?')[0];
    var query = {};
    (full.split('?')[1] || '').split('&').forEach(function (kv) { if (kv) { var p = kv.split('='); query[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); } });
    for (var i = 0; i < compiled.length; i++) {
      var m = compiled[i].re.exec(path);
      if (m) {
        var params = {};
        compiled[i].keys.forEach(function (k, j) { params[k] = decodeURIComponent(m[j + 1]); });
        return { def: compiled[i].def, path: path, params: params, query: query };
      }
    }
    return { def: { path: path, role: 'public', title: 'Page introuvable', endpoints: [] }, path: path, params: {}, query: query, missing: true };
  }

  var main, nav, clock, sel;
  CP.render = function () {
    CP.route = resolve(location.hash);
    var r = CP.route, a = CP.actor;
    var html;
    if (r.missing) html = CP.ui.page('Page introuvable', 'Cette route n\'existe pas dans la maquette.', '<p><a href="#/">Retour à l\'accueil</a> · <a href="#/api">Carte des routes</a></p>');
    else if (r.def.role !== 'public' && r.def.role !== a.role) {
      var target = CP.actorForRole(r.def.role);
      html = CP.ui.page(esc(r.def.title), 'Cet écran appartient au rôle <b>' + ROLE_LABEL[r.def.role] + '</b>. Vous êtes connecté comme <b>' + esc(a.label) + '</b>.',
        '<p>' + CP.ui.btn('Continuer comme ' + esc(target.label), 'switch-actor', { actor: target.id }) + '</p>');
    } else {
      var view = CP.views[r.def.path];
      try { html = view ? view(r) : CP.ui.page(esc(r.def.title), 'Écran à venir.', ''); }
      catch (e) { console.error(e); html = CP.ui.page('Erreur', 'L\'écran n\'a pas pu s\'afficher : ' + esc(e.message), ''); }
    }
    main.innerHTML = html;
    document.title = r.def.title + ' — Maquette Central.Parts';
    renderChrome();
  };

  function renderChrome() {
    var a = CP.actor;
    sel.value = a.id;
    clock.textContent = CP.fmtDay(CP.state.day);
    var links = {
      public: [['/', 'Accueil'], ['/recherche', 'Recherche'], ['/inscription', 'Inscription'], ['/api', 'Carte de l\'API']],
      buyer: [['/acheteur', 'Tableau de bord'], ['/acheteur/nomenclature', 'Déposer une nomenclature'], ['/recherche', 'Recherche'], ['/api', 'Carte de l\'API']],
      seller: [['/vendeur', 'Tableau de bord'], ['/vendeur/stock', 'Stock et lots'], ['/recherche', 'Recherche'], ['/api', 'Carte de l\'API']],
      lab: [['/labo', 'Dossiers'], ['/api', 'Carte de l\'API']],
      bank: [['/banque', 'Compte dédié'], ['/api', 'Carte de l\'API']],
      ops: [['/ops', 'Vue d\'ensemble'], ['/ops/kyb', 'KYB'], ['/ops/demandes', 'Demandes'], ['/ops/paiements', 'Ordres de paiement'], ['/api', 'Carte de l\'API']],
    }[a.role];
    // Lien actif : le plus long préfixe de la route courante.
    var cur = CP.route.path, best = '';
    links.forEach(function (l) { if ((cur === l[0] || cur.indexOf(l[0] === '/' ? '/\u0000' : l[0] + '/') === 0) && l[0].length > best.length) best = l[0]; });
    nav.innerHTML = '<p class="who">' + esc(ROLE_LABEL[a.role]) + '</p>' + links.map(function (l) {
      return '<a href="#' + l[0] + '"' + (l[0] === best ? ' aria-current="page"' : '') + '>' + l[1] + '</a>';
    }).join('');
  }

  // ------------------------------------------------------------ messages
  var toastBox, toastTimer;
  CP.toast = function (text, kind) {
    toastBox.textContent = text;
    toastBox.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastBox.className = 'toast'; }, kind === 'error' ? 6000 : 3000);
  };

  // ------------------------------------------------------------ journal des appels
  var drawer, logList, showReads = false;
  function logRow(e) {
    var cls = e.status >= 400 ? 'err' : 'ok';
    return '<li class="' + cls + (e.quiet ? ' quiet' : '') + '"><details><summary><b class="m-' + e.method + '">' + e.method + '</b> <span class="mono">' + esc(e.path) + '</span> <span class="st">' + e.status + '</span> <span class="by">' + esc(e.actor) + '</span></summary>' +
      (e.req ? '<p>Requête</p><pre>' + esc(JSON.stringify(e.req, null, 2)) + '</pre>' : '') + '<p>Réponse</p><pre>' + esc(JSON.stringify(e.res, null, 2).slice(0, 4000)) + '</pre></details></li>';
  }
  function renderLog() {
    var items = CP.log.filter(function (e) { return showReads || !e.quiet; }).slice(-60).reverse();
    logList.innerHTML = items.length ? items.map(logRow).join('') : '<li class="empty">Aucun appel pour l\'instant. Chaque action des écrans appelle un endpoint : il s\'affiche ici avec sa requête et sa réponse.</li>';
    $('[data-log-count]').textContent = CP.log.filter(function (e) { return !e.quiet; }).length;
  }
  var logPending = false;
  CP.onLog = function () {
    if (logPending) return;
    logPending = true;
    setTimeout(function () { logPending = false; renderLog(); }, 0);
  };

  // ------------------------------------------------------------ événements
  function $(s) { return document.querySelector(s); }
  function formData(form) {
    var o = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.disabled) return;
      if (el.type === 'checkbox') o[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
      else o[el.name] = el.value;
    });
    return o;
  }

  CP.start = function () {
    main = $('#main'); nav = $('#nav'); clock = $('[data-clock]'); sel = $('#actor');
    toastBox = $('#toast'); drawer = $('#drawer'); logList = $('#log');
    sel.innerHTML = CP.ACTORS.map(function (a) { return '<option value="' + a.id + '">' + esc(a.label) + '</option>'; }).join('');
    sel.addEventListener('change', function () { CP.setActor(sel.value, true); });

    $('[data-act="advance"]').addEventListener('click', function () {
      CP.advanceDay();
      CP.toast('Jour simulé : ' + CP.fmtDay(CP.state.day) + ' Tâche des délais exécutée.', 'ok');
      CP.render();
    });
    $('[data-act="reset"]').addEventListener('click', function () {
      if (!confirm('Réinitialiser la démonstration ? Toutes les actions faites dans ce navigateur seront effacées.')) return;
      CP.reset(); renderLog(); CP.render(); CP.toast('Démonstration réinitialisée.', 'ok');
    });
    $('[data-act="drawer"]').addEventListener('click', function () {
      var open = drawer.classList.toggle('open');
      this.setAttribute('aria-expanded', open);
      if (open) renderLog();
    });
    $('#reads').addEventListener('change', function () { showReads = this.checked; renderLog(); });

    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (b && main.contains(b)) {
        var name = b.getAttribute('data-act');
        if (name === 'switch-actor') { CP.setActor(b.getAttribute('data-actor')); return; }
        if (CP.actions[name]) { e.preventDefault(); CP.actions[name](b); CP.render(); }
        return;
      }
      var ep = e.target.closest('[data-ep]');
      if (ep) { CP.focusEndpoint = ep.getAttribute('data-ep'); }
    });
    document.addEventListener('submit', function (e) {
      var f = e.target.closest('form[data-form]');
      if (!f) return;
      e.preventDefault();
      var name = f.getAttribute('data-form');
      if (CP.forms[name]) { var go = CP.forms[name](formData(f), f); if (go !== false) CP.render(); }
    });
    window.addEventListener('hashchange', function () { CP.render(); window.scrollTo(0, 0); });
    CP.render();
    renderLog();
  };
})();
