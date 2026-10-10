// Écrans publics : accueil de la maquette, recherche, inscription, carte de l'API.
(function () {
  'use strict';
  var esc = CP.esc, ui = CP.ui;

  // ------------------------------------------------------------ accueil
  CP.views['/'] = function () {
    var roles = [
      ['buyer', 'Acheteur', 'Dépose une nomenclature, lance les demandes, choisit une offre et un test, inspecte, accepte ou rejette.'],
      ['seller1', 'Vendeurs', 'Importent leur stocklist, remplissent le questionnaire d\'état, enchérissent sans connaître l\'acheteur, expédient.'],
      ['lab', 'Laboratoire', 'Reçoit les pièces, teste selon le niveau commandé, délivre le certificat, réexpédie.'],
      ['bank', 'Banque', 'Tient le compte dédié : reçoit les dépôts, exécute les ordres validés par Central.Parts.'],
      ['ops1', 'Central.Parts', 'Valide les KYB, clôture les enchères, instruit les litiges, double validation des ordres de paiement.'],
    ];
    var steps = [
      'Acheteur : déposer la nomenclature d\'exemple, commander les lignes Inventory, lancer les demandes Opportunity.',
      'Vendeur V-1 : compléter le questionnaire du lot LOT-104, puis enchérir sur la demande. Vendeur V-3 : enchérir.',
      'Central.Parts : clôturer l\'enchère, ou avancer l\'horloge de deux jours ouvrés.',
      'Acheteur : choisir une offre et un niveau de test, signer la fiche. Vendeur : signer.',
      'Banque : recevoir le virement de l\'acheteur. Vendeur : expédier au laboratoire.',
      'Laboratoire : réceptionner, certifier, réexpédier. Acheteur : simuler la livraison, puis accepter ou rejeter.',
      'Central.Parts : valider l\'ordre (opérateur 1 puis opérateur 2), le transmettre. Banque : l\'exécuter.',
    ];
    return ui.page('Maquette vivante de la plateforme',
      'Toute l\'application de bout en bout, rôle par rôle. Chaque action appelle un endpoint simulé, visible dans le journal <b>API</b> en bas de l\'écran, et l\'état est partagé : ce que fait l\'acheteur, le vendeur le voit en changeant de rôle.',
      '<div class="roles">' + roles.map(function (r) {
        var a = CP.ACTORS.filter(function (x) { return x.id === r[0]; })[0];
        return '<section class="card role"><h2>' + r[1] + '</h2><p>' + r[2] + '</p>' + ui.btn('Entrer comme ' + esc(a.label), 'enter', { actor: a.id }) + '</section>';
      }).join('') + '</div>' +
      ui.card('Scénario de démonstration', '<ol class="steps">' + steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol><p class="muted small">Le bouton « +1 jour ouvré » fait avancer l\'horloge simulée et lance la tâche des délais : clôture des enchères, réputé accepté, annulations.</p>') +
      ui.card('Ce qui est simulé', '<ul class="list"><li>Données fictives : références réelles, sociétés, prix, IBAN et laboratoires inventés.</li><li>L\'API est implémentée dans le navigateur (<span class="mono">site/app/js/api.js</span>) ; la carte des ' + CP_ENDPOINTS.length + ' endpoints et des ' + CP_ROUTES.length + ' routes est sur <a href="#/api">#/api</a>.</li><li>Taux, barèmes, montage juridique et établissement financier sont à arbitrer : les valeurs affichées sont des exemples.</li><li>L\'état est enregistré dans ce navigateur seulement ; « Réinitialiser » repart des données de démonstration.</li></ul>'));
  };
  CP.actions.enter = function (b) { CP.setActor(b.getAttribute('data-actor'), true); };

  // ------------------------------------------------------------ recherche
  CP.views['/recherche'] = function (r) {
    var q = r.query.q || '';
    var res = q ? CP.api('GET', '/v1/search?q=' + encodeURIComponent(q), null, { quiet: true }) : null;
    var body = '<form class="search" data-form="search"><label for="q" class="sr">Référence fabricant</label><input id="q" name="q" value="' + esc(q) + '" placeholder="Référence fabricant, par ex. XC2S50 ou STM32" autocomplete="off"><button class="btn">Rechercher</button></form>' +
      '<p class="muted small">Exemples : ' + ['XC2S50-5TQ144C', 'MC68HC11E1CFNE2', 'STM32G071RBT6', 'LT1086'].map(function (m) { return '<a href="#/recherche?q=' + m + '">' + m + '</a>'; }).join(' · ') + '</p>';
    if (res && res.error) body += '<p class="empty">' + esc(res.error) + '</p>';
    if (res && res.data) {
      var d = res.data;
      body += ui.card('<span class="pill inv">Inventory</span> Réseau fabricants et distributeurs', ui.table(['Référence', 'Fabricant', 'Source', '>Stock', '>Prix unitaire', 'Délai'], d.inventory.map(function (i) {
        return ['<span class="mono">' + esc(i.mpn) + '</span>', esc(i.mfr), esc(i.source), CP.num(i.stock), CP.eur(i.price), i.lead + ' j'];
      }), 'Aucune offre Inventory pour cette référence.'));
      body += ui.card('<span class="pill opp">Opportunity</span> Surplus, obsolètes et brokers', ui.table(['Référence', 'Fabricant', '>Lots', '>Pièces', 'Origines déclarées', ''], d.opportunity.map(function (o) {
        return ['<span class="mono">' + esc(o.mpn) + '</span>', esc(o.mfr), o.lots, CP.num(o.qty), esc(o.origins.join(', ')), CP.actor.role === 'buyer' ? '<form class="inline" data-form="quick-demand"><input type="hidden" name="mpn" value="' + esc(o.mpn) + '"><input name="qty" type="number" min="1" value="100" aria-label="Quantité"><button class="btn small">Lancer une demande</button></form>' : ''];
      }), 'Aucun lot déclaré pour cette référence.') + '<p class="muted small">Les vendeurs restent anonymes : seuls l\'origine déclarée et les quantités sont publiques. Prix sur demande, par enchère.</p>');
    }
    return ui.page('Recherche', 'Une seule recherche couvre les deux offres.', body);
  };
  CP.forms.search = function (d) { location.hash = '#/recherche?q=' + encodeURIComponent(d.q.trim()); return false; };
  CP.forms['quick-demand'] = function (d) {
    var dem = CP.call('POST', '/v1/demands', { mpn: d.mpn, qty: d.qty, delivery: 'Atelier, Lyon (France)' }, 'Demande créée et diffusée aux vendeurs.');
    if (dem) { location.hash = '#/acheteur/demandes/' + dem.id; return false; }
  };

  // ------------------------------------------------------------ inscription et KYB
  CP.views['/inscription'] = function () {
    var done = CP.lastSignup;
    if (done) {
      return ui.page('Inscription envoyée', 'Le dossier de <b>' + esc(done.name) + '</b> est en attente de validation par Central.Parts.',
        ui.card('Et ensuite', '<p>Un opérateur contrôle les pièces, les bénéficiaires effectifs et les listes de sanctions, puis valide le compte. Les remboursements ne partiront que vers l\'IBAN déclaré.</p><p>' + ui.btn('Voir le dossier côté Central.Parts', 'switch-to-kyb', {}) + ' ' + ui.btn('Nouvelle inscription', 'signup-again', {}, 'ghost') + '</p>'));
    }
    var types = [['buyer', 'Acheteur (EMS, OEM, bureau d\'études)'], ['seller', 'Vendeur (détenteur de surplus, broker, distributeur)'], ['lab', 'Laboratoire de test']];
    return ui.page('Inscription et KYB', 'Ouverture d\'un compte société. Aucune transaction avant validation du KYB.',
      '<form class="card form" data-form="signup"><h2>1. Société</h2>' +
      '<fieldset class="choice">' + types.map(function (t, i) { return '<label><input type="radio" name="type" value="' + t[0] + '"' + (i ? '' : ' checked') + '> ' + t[1] + '</label>'; }).join('') + '</fieldset>' +
      field('name', 'Raison sociale', 'Exemple Électronique SAS', true) + '<div class="row">' + field('siren', 'SIREN ou numéro étranger', '000 000 000') + field('country', 'Pays', 'France') + field('city', 'Ville', 'Nantes') + '</div>' +
      '<h2>2. Dossier KYB</h2>' + field('beneficiaries', 'Bénéficiaires effectifs (plus de 25 %)', 'Prénom Nom, 60 %', true) + field('signatory', 'Signataire habilité', 'Prénom Nom, président', true) + field('iban', 'IBAN autorisé (remboursements et paiements)', 'FR76 ...', true) +
      '<fieldset class="checks"><legend>Pièces jointes</legend>' + [['kbis', 'Kbis ou équivalent de moins de 3 mois'], ['id', 'Pièce d\'identité du signataire'], ['rib', 'RIB au nom de la société'], ['statuts', 'Statuts à jour']].map(function (p) { return '<label><input type="checkbox" name="doc_' + p[0] + '" checked> ' + p[1] + '</label>'; }).join('') + '</fieldset>' +
      '<p class="muted small">En maquette, les fichiers ne sont pas envoyés : seule la présence des pièces est simulée.</p><button class="btn">Envoyer le dossier</button></form>');
  };
  function field(name, label, ph, req) {
    return '<label class="field"><span>' + label + '</span><input name="' + name + '" placeholder="' + esc(ph) + '"' + (req ? ' required' : '') + '></label>';
  }
  CP.forms.signup = function (d) {
    var org = CP.call('POST', '/v1/organizations', { type: d.type, name: d.name, siren: d.siren, country: d.country, city: d.city });
    if (!org) return;
    var docs = {};
    Object.keys(d).forEach(function (k) { if (k.indexOf('doc_') === 0) docs[k.slice(4)] = d[k]; });
    var kyb = CP.call('POST', '/v1/organizations/' + org.id + '/kyb', { beneficiaries: d.beneficiaries, signatory: d.signatory, iban: d.iban, docs: docs }, 'Dossier KYB envoyé.');
    if (kyb) CP.lastSignup = kyb;
  };
  CP.actions['switch-to-kyb'] = function () { CP.lastSignup = null; CP.setActor('ops1'); location.hash = '#/ops/kyb'; };
  CP.actions['signup-again'] = function () { CP.lastSignup = null; };

  // ------------------------------------------------------------ carte de l'API
  CP.views['/api'] = function () {
    var calls = {};
    CP.log.forEach(function (e) { if (e.endpoint) calls[e.endpoint] = (calls[e.endpoint] || 0) + 1; });
    var used = {};
    CP_ROUTES.forEach(function (r) { r.endpoints.forEach(function (id) { (used[id] = used[id] || []).push(r.path); }); });
    var groups = CP_GROUPS.map(function (g) {
      var eps = CP_ENDPOINTS.filter(function (e) { return e.group === g[0]; });
      return '<h3 id="g-' + g[0] + '">' + esc(g[1]) + '</h3>' + ui.table(['Méthode et chemin', 'Rôles', 'Rôle de l\'endpoint', 'Écrans', '>Appels'], eps.map(function (e) {
        return ['<span id="ep-' + esc(e.id) + '" class="mono' + (CP.focusEndpoint === e.id ? ' focus' : '') + '"><b class="m-' + e.method + '">' + e.method + '</b> ' + esc(e.path) + '</span>',
          e.roles.map(function (x) { return '<span class="role-tag">' + esc(CP.ROLE_LABEL[x]) + '</span>'; }).join(' '), esc(e.summary),
          (used[e.id] || []).map(function (p) { return '<a class="mono small" href="#' + esc(p.replace(/:id/, sampleId(p))) + '">' + esc(p) + '</a>'; }).join('<br>') || '<span class="muted small">Hors écran : intégration, webhook ou tâche</span>',
          calls[e.id] || '<span class="muted">0</span>'];
      }));
    }).join('');
    var routes = ui.table(['Route', 'Rôle', 'Écran', 'Endpoints'], CP_ROUTES.map(function (r) {
      return ['<a class="mono" href="#' + esc(r.path.replace(/:id/, sampleId(r.path))) + '">#' + esc(r.path) + '</a>', esc(CP.ROLE_LABEL[r.role]), esc(r.title), r.endpoints.map(function (id) { return '<a class="mono small" href="#/api" data-ep="' + id + '">' + id + '</a>'; }).join(' ')];
    }));
    setTimeout(function () {
      var el = CP.focusEndpoint && document.getElementById('ep-' + CP.focusEndpoint);
      if (el) el.scrollIntoView({ block: 'center' });
      CP.focusEndpoint = null;
    }, 0);
    return ui.page('Carte de l\'API et des routes', CP_ENDPOINTS.length + ' endpoints REST et ' + CP_ROUTES.length + ' routes d\'écran. Chaque endpoint est implémenté par la maquette ; le compteur donne les appels de cette session. Version Markdown : <a href="https://github.com/Bertier-Adesio/central-parts/blob/main/api/endpoints.md">api/endpoints.md</a>.',
      ui.stats(CP_GROUPS.map(function (g) { return [g[1], CP_ENDPOINTS.filter(function (e) { return e.group === g[0]; }).length]; })) +
      ui.card('Endpoints', '<p class="muted small">Authentification prévue : session ou clé d\'API par société ; le rôle de l\'appelant filtre les données (anonymat acheteur et vendeur). Les webhooks entrants sont signés par l\'émetteur (banque, transporteur).</p>' + groups) +
      ui.card('Routes des écrans', routes));
  };
  // Identifiant d'exemple pour ouvrir une route paramétrée depuis la carte.
  function sampleId(path) {
    var s = CP.state;
    if (path.indexOf('/nomenclatures/') >= 0) return Object.keys(s.boms).pop();
    if (path.indexOf('/demandes/') >= 0) return Object.keys(s.demands)[0];
    if (path.indexOf('/transactions/') >= 0) return Object.keys(s.transactions).pop();
    if (path.indexOf('/lots/') >= 0) return 'LOT-104';
    if (path.indexOf('/dossiers/') >= 0) return Object.keys(s.labCases).pop();
    return '';
  }
})();
