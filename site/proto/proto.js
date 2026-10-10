// Prototype de la plateforme : navigation par étapes et simulation de la transaction.
// Sans JavaScript, toutes les étapes restent lisibles à la suite.
(function () {
  document.documentElement.classList.add('has-js');
  document.body.classList.add('has-js');

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var eur = function (n) { return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; };

  // ------------------------------------------------------------ étapes
  var steps = $$('.step');
  var links = $$('.steps a');
  var open = $('.open');
  var prev = $('[data-prev]');
  var next = $('[data-next]');
  var cur = 0;

  function show(i, scroll) {
    cur = Math.max(0, Math.min(steps.length - 1, i));
    steps.forEach(function (s, k) { s.classList.toggle('on', k === cur); });
    links.forEach(function (a, k) {
      if (k === cur) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current');
      a.classList.toggle('done', k < cur);
    });
    open.classList.toggle('on', cur === steps.length - 1);
    prev.disabled = cur === 0;
    next.hidden = cur === steps.length - 1;
    if (history.replaceState) history.replaceState(null, '', '#' + steps[cur].id);
    if (scroll) $('.steps').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  links.forEach(function (a, k) { a.addEventListener('click', function (e) { e.preventDefault(); show(k, true); }); });
  prev.addEventListener('click', function () { show(cur - 1, true); });
  next.addEventListener('click', function () { show(cur + 1, true); });
  var start = steps.map(function (s) { return '#' + s.id; }).indexOf(location.hash);
  show(start < 0 ? 0 : start, false);

  // ------------------------------------------------------------ compte à rebours de l'enchère
  var cd = $('[data-countdown]');
  var end = Date.now() + Number(cd.getAttribute('data-countdown')) * 1000;
  function hms(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(Math.floor(s / 3600)) + ':' + p(Math.floor(s / 60) % 60) + ':' + p(s % 60);
  }
  setInterval(function () { cd.textContent = hms(end - Date.now()); }, 1000);

  // ------------------------------------------------------------ enchère scellée (offres concurrentes fictives)
  var others = [41.20, 39.80];
  $('[data-bid]').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = parseFloat($('#bid').value);
    if (!(v > 0)) return;
    var rank = 1 + others.filter(function (o) { return o < v; }).length;
    $('[data-rank]').textContent = rank + ' sur 3' + (rank === 1 ? ' : meilleure offre' : '');
  });

  // ------------------------------------------------------------ offre, laboratoire et total
  var QTY = 250;
  var labNames = ['Pas de test', 'Contrôle visuel et marquage', 'Rayons X', 'XRF', 'Décapsulation'];
  var labLine = $('.timeline [data-k="lab"] span');
  function sync() {
    var o = $('input[name="offer"]:checked');
    var l = $('input[name="lab"]:checked');
    var unit = parseFloat(o.getAttribute('data-price'));
    var lab = parseFloat(l.getAttribute('data-price'));
    $('[data-out="offer"]').textContent = 'Offre ' + o.value + ', ' + eur(unit) + " l'unité";
    $('[data-out="lab"]').textContent = lab ? labNames[l.value] + ', ' + eur(lab) : 'Aucun test';
    $('[data-out="total"]').textContent = eur(unit * QTY + lab);
    labLine.textContent = lab ? labNames[l.value] + ' ; certificat déposé sur la plateforme' : 'Non commandé : livraison directe';
  }
  $$('input[name="offer"], input[name="lab"]').forEach(function (r) { r.addEventListener('change', sync); });
  sync();

  // ------------------------------------------------------------ signature et dépôt
  var signBtn = $('[data-act="sign"]');
  var fundBtn = $('[data-act="fund"]');
  var signOut = $('[data-out="sign"]');
  signBtn.addEventListener('click', function () {
    signBtn.disabled = true;
    signOut.textContent = 'Fiche signée par l\'acheteur, puis par le vendeur V-1. Dépôt attendu sous 4 j ouvrés.';
    fundBtn.disabled = false;
  });
  fundBtn.addEventListener('click', function () {
    fundBtn.disabled = true;
    signOut.textContent = 'Fonds reçus sur le compte dédié. Ordre d\'expédition envoyé au vendeur.';
    go('ship');
    setTimeout(function () { show(4, true); }, 600);
  });

  // ------------------------------------------------------------ tableau de bord : machine à états
  var items = {};
  $$('[data-timeline] li').forEach(function (li) { items[li.getAttribute('data-k')] = li; });
  var order = ['fund', 'ship', 'lab', 'deliver', 'inspect', 'pay'];
  var now = $('[data-now]');
  var acts = $('[data-actions]');
  var log = $('[data-log]');
  var timerBox = $('[data-step-timer]');
  var deadline = $('[data-deadline]');

  // Chaque état : étape de la frise, libellé, délai affiché, actions possibles.
  var STATES = {
    wait:    { k: 'fund', label: 'En attente du dépôt des fonds', acts: [] },
    ship:    { k: 'ship', label: 'Expédition par le vendeur', days: 5, acts: [['Simuler : le vendeur expédie', 'lab', 'Le vendeur a expédié, numéro de suivi transmis.']] },
    lab:     { k: 'lab', label: 'Test en laboratoire', days: 3, acts: [['Simuler : certificat conforme', 'deliver', 'Certificat du laboratoire : conforme. Pièces réexpédiées à Shenzhen.'], ['Simuler : contrefaçon détectée', 'fake', 'Laboratoire : contrefaçon. Pièces en quarantaine, jamais renvoyées au vendeur.']] },
    deliver: { k: 'deliver', label: 'Livraison à Shenzhen', days: 4, acts: [['Simuler : livré à l\'intégrateur', 'inspect', 'Livré à l\'intégrateur à Shenzhen. Le délai d\'inspection commence.']] },
    inspect: { k: 'inspect', label: 'Inspection par l\'intégrateur', days: 10, acts: [['J\'accepte', 'paid', 'Pièces acceptées par l\'acheteur.'], ['Je rejette', 'reject']] },
    paid:    { k: 'pay', label: 'Terminée : vendeur payé', done: true, acts: [] },
    back:    { k: 'pay', label: 'Retour au vendeur, contre-inspection', alt: true, days: 10, acts: [['Simuler : le vendeur accepte le retour', 'refund', 'Contre-inspection : le vendeur accepte le retour.'], ['Simuler : le vendeur conteste', 'dispute', 'Le vendeur conteste. Médiation ouverte par Central.Parts.']] },
    dispute: { k: 'pay', label: 'Médiation, puis expertise par un laboratoire tiers', alt: true, days: 15, acts: [['Simuler : expertise en faveur de l\'acheteur', 'refund', 'Expertise : non conforme. Frais à la charge du vendeur.']] },
    refund:  { k: 'pay', label: 'Terminée : acheteur remboursé', done: true, acts: [] },
  };

  function entry(t) {
    var li = document.createElement('li');
    li.textContent = t;
    log.appendChild(li);
  }

  function render(state) {
    var st = STATES[state];
    var idx = order.indexOf(st.k);
    order.forEach(function (k, i) {
      var li = items[k];
      li.classList.toggle('done', i < idx || (i === idx && !!st.done));
      li.classList.toggle('cur', i === idx && !st.done && !st.alt);
      li.classList.toggle('alt', i === idx && !!st.alt);
    });
    items.pay.querySelector('b').textContent = state === 'refund' ? 'Acheteur remboursé' : state === 'back' || state === 'dispute' ? 'Retour et contre-inspection' : 'Paiement du vendeur';
    now.textContent = st.label;
    timerBox.hidden = !st.days;
    if (st.days) deadline.textContent = st.days + ' j ouvrés, relance automatique à mi-délai';
    acts.innerHTML = '';
    st.acts.forEach(function (a, i) {
      var b = document.createElement('button');
      b.className = 'btn' + (i ? ' ghost' : '');
      b.textContent = a[0];
      b.addEventListener('click', function () {
        if (a[1] === 'reject') return askReason();
        if (a[2]) entry(a[2]);
        go(a[1]);
      });
      acts.appendChild(b);
    });
    if (st.done) {
      var r = document.createElement('button');
      r.className = 'btn ghost';
      r.textContent = 'Rejouer la transaction';
      r.addEventListener('click', function () { log.innerHTML = ''; entry('Fonds déposés sur le compte dédié.'); go('ship'); });
      acts.appendChild(r);
    }
  }

  function askReason() {
    acts.innerHTML = '';
    var sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Motif du rejet');
    ['Contrefaçon ou soupçon de contrefaçon', 'Non-conformité à la commande ou au questionnaire', 'Écart de quantité', 'Dommage de transport'].forEach(function (m) {
      var o = document.createElement('option'); o.textContent = m; sel.appendChild(o);
    });
    var ok = document.createElement('button');
    ok.className = 'btn';
    ok.textContent = 'Rejeter avec ce motif';
    ok.addEventListener('click', function () {
      var fake = sel.selectedIndex === 0;
      entry('Rejet motivé : ' + sel.value.toLowerCase() + '. Justificatifs téléversés, ' +
        (fake ? 'pièces en quarantaine, jamais renvoyées au vendeur.' : 'étiquette de retour générée.'));
      go('back');
    });
    acts.appendChild(sel);
    acts.appendChild(ok);
  }

  function go(state) {
    if (state === 'lab' && !parseFloat($('input[name="lab"]:checked').getAttribute('data-price'))) {
      entry('Pas de test commandé : livraison directe à Shenzhen.');
      state = 'deliver';
    }
    if (state === 'fake') { entry('Vendeur sans contestation dans son délai.'); state = 'refund'; }
    if (state === 'paid') { entry('Vendeur payé, commissions encaissées.'); }
    if (state === 'refund') { entry('Acheteur remboursé sur l\'IBAN autorisé.'); }
    if (state === 'ship' && !log.children.length) entry('Fonds déposés sur le compte dédié.');
    render(state);
  }

  render('wait');
})();
