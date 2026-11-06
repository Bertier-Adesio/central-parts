// En-tête partagé des pages écrites à la main (maquette 01 de la revue UX, header-spec.md).
// Insère dans chaque page le même balisage (entre deux commentaires repères), le lien d'évitement, la feuille
// /assets/header.css, et le comportement commun à la fin de l'unique <script> de la page :
//   - textes de l'en-tête dans la langue de <html lang> (suivie par un MutationObserver, comme l'ancien menu) ;
//   - compteur du panier (localStorage « cp-cart », ADR 0028) : pastille et texte lu par les lecteurs d'écran ;
//   - liens de langue ?lang= qui gardent les autres paramètres ; au clic, la page change de langue sans
//     rechargement si elle expose window.cpLang(l), et le choix est mémorisé dans « cp-lang » ;
//   - menu <details> (sous 1140 px) : Échap, toucher le voile, retour à la largeur bureau ferment le menu.
// La landing (générée par tools/build-site.mjs), site/app/ et site/proto/ ne sont pas concernées.
// Usage : node tools/build-header.mjs   (puis node tools/build-csp.mjs, les scripts en ligne ayant changé)
//         node tools/build-header.mjs --check   échoue si une page n'a plus l'en-tête à jour (CI)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE = new URL('../site/', import.meta.url).pathname;

// Pages : variante, entrée active (clé du menu, « req » pour le panier), langues proposées.
const PUBLIC = ['fr', 'en', 'zh'];
const PAGES = [
  { path: 'recherche', variant: 'public', cur: null },
  { path: 'recherche/commande', variant: 'public', cur: null },
  { path: 'panier', variant: 'public', cur: 'req' },
  { path: 'offres', variant: 'public', cur: 'offers' },
  { path: 'fabricants', variant: 'public', cur: 'makers' },
  { path: 'sourcing', variant: 'public', cur: 'rare' },
  { path: 'sourcing/suivi', variant: 'public', cur: 'rare', section: true },
  { path: 'conditions', variant: 'public', cur: 'terms' },
  { path: 'api', variant: 'public', cur: 'api' },
  { path: 'depot', variant: 'supplier', cur: null, langs: ['zh', 'en'] },
  { path: 'depot/aide', variant: 'supplier', cur: 'help', langs: ['zh', 'en'] },
  // Lien personnel : le FR reste proposé, il sert aux opérateurs de Central.Parts (accès depuis le back office).
  { path: 'depot/lien', variant: 'supplier-link', cur: null, langs: ['zh', 'en', 'fr'] },
  { path: 'admin', variant: 'admin', cur: null, langs: [] },
];

// Textes de l'en-tête (header-spec.md, « Chaînes nouvelles » ; variante « Panier » tant que le renommage n'est pas tranché).
const H = {
  fr: { sep: ', ', brand: 'Central.Parts, accueil', nav: 'Navigation principale', offers: 'Offres', makers: 'Fabricants', rare: 'Composants rares',
    terms: 'Conditions commerciales', api: 'API', supplier: 'Espace fournisseur', help: 'Aide', lang: 'Langue', menu: 'Menu', req: 'Panier',
    one: '{n} référence', many: '{n} références', tagS: 'Espace fournisseur', tagB: 'Back-office', signed: 'Connecté :', out: 'Déconnexion', skip: 'Aller au contenu' },
  en: { sep: ', ', brand: 'Central.Parts, home', nav: 'Main navigation', offers: 'Offers', makers: 'Manufacturers', rare: 'Hard-to-find parts',
    terms: 'Terms of sale', api: 'API', supplier: 'Supplier centre', help: 'Help', lang: 'Language', menu: 'Menu', req: 'Cart',
    one: '{n} part number', many: '{n} part numbers', tagS: 'Supplier centre', tagB: 'Back office', signed: 'Signed in:', out: 'Sign out', skip: 'Skip to content' },
  zh: { sep: '，', brand: 'Central.Parts 首页', nav: '主导航', offers: '报价', makers: '制造商', rare: '稀缺元器件',
    terms: '交易条件', api: 'API', supplier: '供应商中心', help: '使用帮助', lang: '语言', menu: '菜单', req: '购物车',
    one: '{n} 个型号', many: '{n} 个型号', tagS: '供应商中心', tagB: '管理后台', signed: '已登录：', out: '退出登录', skip: '跳到正文' },
};
const NAV = {
  public: [['offers', '/offres/'], ['makers', '/fabricants/'], ['rare', '/sourcing/'], ['terms', '/conditions/'], ['api', '/api/'], ['supplier', '/depot/', 'sh-sep']],
  supplier: [['help', '/depot/aide/']],
};
const LABEL = { fr: 'FR', en: 'EN', zh: '中文' };

const MARK = '<svg class="sh-mark" viewBox="24 24 432 432" aria-hidden="true" focusable="false"><path d="M370.50 99.17A192 192 0 1 0 370.50 380.83" fill="none" stroke="currentColor" stroke-width="48" stroke-linecap="round"/><path d="M302.28 156.72A104 104 0 1 0 302.28 323.28" fill="none" stroke="currentColor" stroke-width="48" stroke-linecap="round"/><circle cx="240" cy="240" r="40" class="sh-dot"/></svg>';
const ICO = {
  cart: '<svg class="sh-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>',
  open: '<svg class="sh-ico sh-i-open" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>',
  close: '<svg class="sh-ico sh-i-close" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
};

const BEGIN = '<!-- en-tête partagé : généré par tools/build-header.mjs, ne pas modifier à la main -->';
const END = '<!-- fin de l\'en-tête partagé -->';
const JS_BEGIN = '// --- en-tête partagé : généré par tools/build-header.mjs, ne pas modifier à la main ---';
const JS_END = '// --- fin de l\'en-tête partagé ---';

function header(p, lang) {
  const h = H[lang], langs = p.langs || PUBLIC, admin = p.variant === 'admin';
  const t = (k) => `data-sh="${k}">${h[k]}`;
  const cur = (k) => (p.cur === k ? (p.section ? ' aria-current="true"' : ' aria-current="page"') : '');
  const items = NAV[p.variant] || [];
  const navBar = items.map(([k, href, cls]) => `      <a${cls ? ` class="${cls}"` : ''} href="${href}" data-href="${href}"${cur(k)} ${t(k)}</a>`).join('\n');
  const navRows = items.map(([k, href]) => `            <a class="sh-row" href="${href}" data-href="${href}"${cur(k)} ${t(k)}</a>`).join('\n');
  const langLinks = (ind) => langs.map((l) => `${ind}<a href="?lang=${l}" hreflang="${l}" lang="${l === 'zh' ? 'zh-Hans' : l}"${l === lang ? ' aria-current="true"' : ''}>${LABEL[l]}</a>`).join('\n');
  const home = admin ? '/admin/' : '/';
  const out = [];
  out.push(BEGIN);
  out.push(`<a class="sh-skip" href="#main" ${t('skip')}</a>`);
  out.push(`<header class="site-hdr" data-variant="${p.variant}">`);
  out.push('  <div class="sh-bar">');
  out.push(`    <a class="sh-brand" href="${home}"${admin ? '' : ' data-home'} aria-label="${h.brand}" data-sh-aria="brand">${MARK}<span class="sh-word">Central<span class="sh-dotc">.</span>Parts</span></a>`);
  if (p.variant !== 'public') out.push(`    <span class="sh-tag" ${t(admin ? 'tagB' : 'tagS')}</span>`);
  if (items.length) out.push(`    <nav class="sh-nav" aria-label="${h.nav}" data-sh-aria="nav">\n${navBar}\n    </nav>`);
  out.push('    <div class="sh-tools">');
  if (p.variant === 'public') {
    out.push(`      <a class="sh-req" href="/panier/"${p.cur === 'req' ? ' aria-current="page"' : ''}>${ICO.cart}<span class="sh-req-l" ${t('req')}</span><span class="sh-n" aria-hidden="true" hidden></span><span class="sh-vh"></span></a>`);
  }
  if (langs.length) out.push(`      <div class="sh-lang" role="group" aria-label="${h.lang}" data-sh-aria="lang">\n${langLinks('        ')}\n      </div>`);
  if (admin) {
    // Adresse et Déconnexion : affichées par le script du back office une fois connecté (id="who", ADR 0018).
    out.push('      <span class="sh-who" id="who" hidden><span class="sh-user" id="who-email"></span><button class="sh-out" type="button" id="logout" data-sh="out">' + h.out + '</button></span>');
  }
  if (p.variant !== 'supplier-link') {
    out.push(`      <details class="sh-menu"${admin ? ' id="who-menu" hidden' : ''}>`);
    out.push(`        <summary aria-label="${h.menu}" data-sh-aria="menu">${ICO.open}${ICO.close}</summary>`);
    out.push('        <div class="sh-panel">');
    if (items.length) out.push(`          <nav aria-label="${h.nav}" data-sh-aria="nav">\n${navRows}\n          </nav>`);
    if (admin) {
      out.push(`          <p class="sh-user-m"><span data-sh="signed">${h.signed}</span> <span id="who-email-m"></span></p>`);
      out.push(`          <button class="sh-row" type="button" id="logout-m" data-sh="out">${h.out}</button>`);
    }
    if (langs.length) {
      out.push(`          <p class="sh-lbl" id="sh-l" ${t('lang')}</p>`);
      out.push(`          <div class="sh-lang sh-lang-m" role="group" aria-labelledby="sh-l">\n${langLinks('            ')}\n          </div>`);
    }
    out.push('        </div>');
    out.push('      </details>');
  }
  out.push('    </div>');
  out.push('  </div>');
  out.push('</header>');
  out.push(END);
  return out.join('\n');
}

function script(p) {
  const fallback = (p.langs || PUBLIC)[0] || 'fr';
  return `${JS_BEGIN}
(function () {
  'use strict';
  var hdr = document.querySelector('.site-hdr'); if (!hdr) return;
  var root = document.documentElement, menu = hdr.querySelector('.sh-menu');
  var H = ${JSON.stringify(H)};
  function cur() { var l = (root.lang || '').slice(0, 2); return H[l] ? l : '${fallback}'; }
  // Lien de langue : garde les autres paramètres (?q=…) et l'ancre.
  function withLang(l) { var q = new URLSearchParams(location.search); q.set('lang', l); return location.pathname + '?' + q + location.hash; }
  // Compteur du panier (ADR 0028) : pastille visible, nombre lu dans le nom du lien.
  function count() {
    var a = hdr.querySelector('.sh-req'); if (!a) return;
    var n = 0, h = H[cur()];
    try { var c = JSON.parse(localStorage.getItem('cp-cart') || '[]'); n = Array.isArray(c) ? c.length : 0; } catch (e) {}
    var pill = a.querySelector('.sh-n');
    pill.hidden = !n; pill.textContent = n > 99 ? '99+' : String(n);
    a.querySelector('.sh-vh').textContent = n ? h.sep + (n === 1 ? h.one : h.many).replace('{n}', n) : '';
  }
  function paint() {
    var l = cur(), h = H[l];
    document.querySelectorAll('[data-sh]').forEach(function (e) { e.textContent = h[e.getAttribute('data-sh')]; });
    hdr.querySelectorAll('[data-sh-aria]').forEach(function (e) { e.setAttribute('aria-label', h[e.getAttribute('data-sh-aria')]); });
    hdr.querySelectorAll('[data-home]').forEach(function (a) { a.href = l === 'fr' ? '/' : '/' + l + '/'; });
    hdr.querySelectorAll('a[data-href]').forEach(function (a) { var p = a.getAttribute('data-href'); a.href = p === '/depot/' ? p : p + '?lang=' + l; });
    hdr.querySelectorAll('.sh-lang a').forEach(function (a) {
      var x = a.getAttribute('hreflang'); a.href = withLang(x);
      if (x === l) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    });
    count();
  }
  function close() { if (menu && menu.open) menu.open = false; root.classList.remove('sh-lock'); }
  // Langue : sans rechargement si la page expose cpLang(l), sinon le lien ?lang= fait la navigation.
  hdr.querySelectorAll('.sh-lang a').forEach(function (a) {
    a.addEventListener('click', function (ev) {
      var l = a.getAttribute('hreflang');
      try { localStorage.setItem('cp-lang', l); } catch (e) {}
      if (typeof window.cpLang !== 'function') return;
      ev.preventDefault(); window.cpLang(l); history.replaceState(history.state, '', withLang(l)); close();
    });
  });
  if (menu) {
    menu.addEventListener('toggle', function () { root.classList.toggle('sh-lock', menu.open); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && menu.open) { close(); menu.querySelector('summary').focus(); } });
    menu.addEventListener('click', function (ev) { if (ev.target === menu) close(); });   // voile (::after du menu ouvert)
    var wide = window.matchMedia('(min-width: 1140px)'), onWide = function () { if (wide.matches) close(); };
    if (wide.addEventListener) wide.addEventListener('change', onWide); else wide.addListener(onWide);
  }
  window.cpCount = count;
  window.addEventListener('storage', function (ev) { if (ev.key === 'cp-cart') count(); });
  new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ['lang'] });
  paint();
})();
${JS_END}`;
}

const CHECK = process.argv.includes('--check');
let changed = 0;
for (const p of PAGES) {
  const file = join(SITE, p.path, 'index.html');
  let s = readFileSync(file, 'utf8');
  const before = s;
  const lang = (s.match(/<html lang="([a-z]{2})/) || [])[1] || 'fr';
  const block = header(p, H[lang] ? lang : 'fr');
  // 1. Balisage : entre les repères, sinon à la place du premier <header>.
  if (s.includes(BEGIN)) s = s.slice(0, s.indexOf(BEGIN)) + block + s.slice(s.indexOf(END) + END.length);
  else {
    const a = s.indexOf('<header'), b = s.indexOf('</header>', a);
    if (a < 0 || b < 0) throw new Error(p.path + ' : <header> introuvable');
    s = s.slice(0, a) + block + s.slice(b + '</header>'.length);
  }
  // 2. Feuille de style partagée, après tokens.css (et fonts.css).
  if (!s.includes('/assets/header.css')) {
    const anchor = s.includes('<link rel="stylesheet" href="/assets/fonts.css">') ? '<link rel="stylesheet" href="/assets/fonts.css">' : '<link rel="stylesheet" href="/assets/tokens.css">';
    s = s.replace(anchor, anchor + '\n<link rel="stylesheet" href="/assets/header.css">');
  }
  // 3. Cible du lien d'évitement.
  s = s.replace(/<main(?![^>]*\bid=)([^>]*)>/, '<main id="main"$1>');
  // 4. Comportement : à la fin de l'unique <script> de la page ; l'ancien menu commun (PR 69) est retiré.
  s = s.replace(/\/\/ Menu de navigation : libellés et liens[^\n]*\n\(function \(\) \{[\s\S]*?\n\}\)\(\);\n/, '');
  if (s.includes(JS_BEGIN)) s = s.slice(0, s.indexOf(JS_BEGIN)) + script(p) + s.slice(s.indexOf(JS_END) + JS_END.length);
  else {
    const i = s.lastIndexOf('</script>');
    s = s.slice(0, i) + script(p) + '\n' + s.slice(i);
  }
  if (s !== before) { if (!CHECK) writeFileSync(file, s); changed++; console.log('site/' + p.path + '/index.html'); }
}
if (CHECK) {
  if (changed) { console.error(changed + ' page(s) sans l\'en-tête à jour : lancer node tools/build-header.mjs puis node tools/build-csp.mjs'); process.exit(1); }
  console.log('En-tête partagé à jour sur ' + PAGES.length + ' pages.');
} else console.log(changed + ' page(s) mise(s) à jour.');
