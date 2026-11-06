// En-tête commun des pages écrites à la main (revue UI/UX du 6 novembre 2026, n° 1) : marque « Central.Parts » avec
// le point rouge, navigation, « Ma demande » avec compteur, sélecteur FR · EN · 中文 toujours visible, menu <details>
// sur mobile (sans JavaScript). Une seule source : ce fichier. Il réécrit dans chaque page
//   - le HTML entre <!-- HEADER:BEGIN --> et <!-- HEADER:END --> ;
//   - le petit module JavaScript entre « // HEADER:BEGIN » et « // HEADER:END », placé à la fin du <script> unique de
//     la page (règle du dépôt : un seul script vanilla par page) ;
//   - les feuilles fonts.css et site.css dans le <head>.
// Le module suit l'attribut lang de <html>, que la page met à jour : libellés, liens de langue (?lang=), titre de
// l'onglet, compteur de « Ma demande » (localStorage cp-cart). Sans JavaScript, les liens restent valables.
//
// Usage : node tools/build-header.mjs           met à jour les pages
//         node tools/build-header.mjs --check   échoue si une page n'est plus à jour (CI)
// Après une mise à jour, relancer node tools/build-csp.mjs (le script des pages change).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = fileURLToPath(new URL('../site/', import.meta.url));

// Textes de l'en-tête (copy.md de la revue : brand.aria, nav.*, req.*, lang.aria, menu.*, tag.bo).
const H = {
  fr: { brand: 'Central.Parts, accueil', nav: 'Navigation principale', req: 'Ma demande', reqN: 'Ma demande ({n})', lang: 'Langue', menu: 'Menu', close: 'Fermer', menuNav: 'Navigation', bo: 'Back-office', out: 'Déconnexion' },
  en: { brand: 'Central.Parts, home', nav: 'Main navigation', req: 'My request', reqN: 'My request ({n})', lang: 'Language', menu: 'Menu', close: 'Close', menuNav: 'Navigation', bo: 'Back office', out: 'Sign out' },
  zh: { brand: 'Central.Parts 首页', nav: '主导航', req: '询价单', reqN: '询价单（{n}）', lang: '语言', menu: '菜单', close: '关闭', menuNav: '导航', bo: '管理后台', out: '退出登录' },
};

// Navigation des pages acheteur. « Composants rares » (ADR 0033) est gardé à côté des entrées de la maquette.
const NAV = [
  ['/offres/', 'Offres', 'Offers', '报价'],
  ['/fabricants/', 'Fabricants', 'Manufacturers', '制造商'],
  ['/sourcing/', 'Composants rares', 'Hard-to-find parts', '稀缺元器件'],
  ['/conditions/', 'Conditions', 'Terms', '交易条件'],
  ['/api/', 'API', 'API', 'API'],
  ['/depot/', 'Espace fournisseur', 'Supplier centre', '供应商中心'],
];

// Pages, variante d'en-tête, entrée courante du menu et titre de l'onglet par langue (null : la page le gère).
export const PAGES = {
  'recherche/index.html': { kind: 'buyer', current: null, title: ['Recherche de composants', 'Component search', '元器件搜索'] },
  'recherche/commande/index.html': { kind: 'buyer', current: null, title: ['Suivi de la demande', 'Request tracking', '采购申请跟踪'] },
  'offres/index.html': { kind: 'buyer', current: '/offres/', title: ['Offres', 'Offers', '报价'] },
  'panier/index.html': { kind: 'buyer', current: null, title: ['Ma demande', 'My request', '询价单'] },
  'fabricants/index.html': { kind: 'buyer', current: '/fabricants/', title: null },
  'conditions/index.html': { kind: 'buyer', current: '/conditions/', title: ['Conditions commerciales', 'Terms of sale', '交易条件'] },
  'api/index.html': { kind: 'buyer', current: '/api/', title: ['API d’offres', 'Offers API', '报价 API'] },
  'sourcing/index.html': { kind: 'buyer', current: '/sourcing/', title: ['Composants rares', 'Hard-to-find parts', '稀缺元器件'] },
  'sourcing/suivi/index.html': { kind: 'buyer', current: '/sourcing/', title: ['Suivi de recherche', 'Search status', '寻源进度'] },
  'admin/index.html': { kind: 'admin', current: null, title: ['Back-office', 'Back office', '管理后台'] },
};

const MARK = '<svg class="mark" width="24" height="24" viewBox="24 24 432 432" aria-hidden="true"><path d="M370.50 99.17A192 192 0 1 0 370.50 380.83" fill="none" stroke="currentColor" stroke-width="48" stroke-linecap="round"/><path d="M302.28 156.72A104 104 0 1 0 302.28 323.28" fill="none" stroke="currentColor" stroke-width="48" stroke-linecap="round"/><circle cx="240" cy="240" r="40" class="dot"/></svg>';
const ICON_REQ = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 10h6M9 14h6M9 18h3"/></svg>';
const ICON_MENU = '<svg class="i-open" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg><svg class="i-close" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function navLinks(current, indent) {
  return NAV.map(([href, fr, en, zh]) => `${indent}<a href="${href}" data-href="${href}" data-fr="${fr}" data-en="${en}" data-zh="${zh}"${href === current ? ' aria-current="page"' : ''}>${fr}</a>`).join('\n');
}
function langLinks(indent, path) {
  return [['fr', 'FR'], ['en', 'EN'], ['zh', '中文']].map(([l, label]) =>
    `${indent}<a href="${path}?lang=${l}" data-lang="${l}" lang="${l === 'zh' ? 'zh-Hans' : l}" hreflang="${l === 'zh' ? 'zh-Hans' : l}"${l === 'fr' ? ' aria-current="true"' : ''}>${label}</a>`).join('\n');
}

export function headerHtml(page) {
  const fr = H.fr;
  const brand = `    <a class="brand" href="/" id="home" aria-label="${fr.brand}" data-ha="brand">\n      ${MARK}\n      <span class="wm" aria-hidden="true">Central<span class="pt">.</span>Parts</span>\n    </a>`;
  const menu = (inner) => `      <details class="menu">\n        <summary aria-label="${fr.menu}" data-ha="menu">${ICON_MENU}</summary>\n        <div class="menu-body">\n${inner}\n        </div>\n      </details>`;
  if (page.kind === 'admin') {
    return `<!-- HEADER:BEGIN — généré par node tools/build-header.mjs : modifier l'outil, pas cette page -->
<header class="site-hdr">
  <div class="bar">
${brand}
    <span class="tag" data-h="bo">${fr.bo}</span>
    <div class="tools">
      <div class="langs d-only" role="group" aria-label="${fr.lang}" data-ha="lang">
${langLinks('        ', page.path)}
      </div>
      <div class="who" id="who" hidden><span id="who-email"></span><button type="button" id="logout" data-h="out">${fr.out}</button></div>
${menu(`          <p class="menu-h" data-h="lang">${fr.lang}</p>\n          <div class="langs" role="group" aria-label="${fr.lang}" data-ha="lang">\n${langLinks('            ', page.path)}\n          </div>`)}
    </div>
  </div>
</header>
<!-- HEADER:END -->`;
  }
  return `<!-- HEADER:BEGIN — généré par node tools/build-header.mjs : modifier l'outil, pas cette page -->
<header class="site-hdr">
  <div class="bar">
${brand}
    <nav class="topnav d-only" aria-label="${fr.nav}" data-ha="nav">
${navLinks(page.current, '      ')}
    </nav>
    <div class="tools">
      <a class="req" href="/panier/" id="cart-link" aria-label="${fr.req}">${ICON_REQ}<span class="req-l" data-h="req">${fr.req}</span><span class="count" id="cart-n" hidden></span></a>
      <div class="langs d-only" role="group" aria-label="${fr.lang}" data-ha="lang">
${langLinks('        ', page.path)}
      </div>
${menu(`          <nav class="topnav" aria-label="${fr.menuNav}" data-ha="menuNav">\n${navLinks(page.current, '            ')}\n          </nav>\n          <p class="menu-h" data-h="lang">${fr.lang}</p>\n          <div class="langs" role="group" aria-label="${fr.lang}" data-ha="lang">\n${langLinks('            ', page.path)}\n          </div>`)}
    </div>
  </div>
</header>
<!-- HEADER:END -->`;
}

export function headerJs(page) {
  const title = page.title ? JSON.stringify({ fr: page.title[0], en: page.title[1], zh: page.title[2] }) : 'null';
  return `// HEADER:BEGIN — en-tête commun, généré par node tools/build-header.mjs : modifier l'outil, pas cette page.
// Suit l'attribut lang de <html> (mis à jour par la page) : libellés, liens de langue, titre, compteur de « Ma demande ».
(function () {
  var H = ${JSON.stringify(H)};
  var TITLE = ${title};
  function cur() { var l = (document.documentElement.lang || 'fr').slice(0, 2); return H[l] ? l : 'fr'; }
  function count() { try { var a = JSON.parse(localStorage.getItem('cp-cart') || '[]'); return Array.isArray(a) ? a.length : 0; } catch (e) { return 0; } }
  function sync() {
    var l = cur(), h = H[l], n = count(), all = function (s, f) { Array.prototype.forEach.call(document.querySelectorAll(s), f); };
    if (TITLE) document.title = TITLE[l] + ' — Central.Parts';
    all('.site-hdr [data-h]', function (el) { el.textContent = h[el.getAttribute('data-h')]; });
    all('.site-hdr [data-ha]', function (el) { el.setAttribute('aria-label', h[el.getAttribute('data-ha')]); });
    all('.site-hdr .topnav a[data-href]', function (a) {
      var href = a.getAttribute('data-href');
      a.textContent = a.getAttribute('data-' + l);
      a.href = href + (href === '/depot/' ? '' : '?lang=' + l);
    });
    all('.site-hdr a[data-lang]', function (a) {
      var k = a.getAttribute('data-lang'), p = new URLSearchParams(location.search);
      p.set('lang', k); a.href = location.pathname + '?' + p.toString();
      if (k === l) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    });
    var c = document.getElementById('cart-n'), r = document.getElementById('cart-link'), home = document.getElementById('home');
    if (c) { c.textContent = n ? String(n) : ''; c.hidden = !n; }
    if (r) { r.href = '/panier/?lang=' + l; r.setAttribute('aria-label', n ? h.reqN.replace('{n}', n) : h.req); }
    if (home) home.setAttribute('href', l === 'fr' ? '/' : '/' + l + '/');
  }
  // Changement de langue : la page s'en charge sur place (écouteurs [data-lang]) ; l'adresse garde ?lang=. Si la page
  // ne l'a pas fait, le lien recharge la page avec ?lang=.
  document.addEventListener('click', function (ev) {
    var a = ev.target.closest && ev.target.closest('.site-hdr a[data-lang]');
    if (!a || cur() !== a.getAttribute('data-lang')) return;
    ev.preventDefault();
    try { var u = new URL(location.href); u.searchParams.set('lang', cur()); history.replaceState(history.state, '', u); } catch (e) {}
    var d = a.closest('details'); if (d) d.open = false;
    sync();
  });
  window.addEventListener('storage', function (ev) { if (ev.key === 'cp-cart') sync(); });
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  window.cpHeader = sync;
  sync();
})();
// HEADER:END`;
}

function apply(rel, html) {
  const page = { ...PAGES[rel], path: '/' + rel.replace(/index\.html$/, '') };
  let out = html;
  // Feuilles communes : polices avant tokens.css, site.css après.
  if (!out.includes('/assets/fonts.css')) out = out.replace('<link rel="stylesheet" href="/assets/tokens.css">', '<link rel="stylesheet" href="/assets/fonts.css">\n<link rel="stylesheet" href="/assets/tokens.css">');
  if (!out.includes('/assets/site.css')) out = out.replace('<link rel="stylesheet" href="/assets/tokens.css">', '<link rel="stylesheet" href="/assets/tokens.css">\n<link rel="stylesheet" href="/assets/site.css">');
  // HTML de l'en-tête.
  const h = headerHtml(page);
  if (/<!-- HEADER:BEGIN[\s\S]*?<!-- HEADER:END -->/.test(out)) out = out.replace(/<!-- HEADER:BEGIN[\s\S]*?<!-- HEADER:END -->/, () => h);
  else if (/<header class="hdr">[\s\S]*?<\/header>/.test(out)) out = out.replace(/<header class="hdr">[\s\S]*?<\/header>/, () => h);
  else throw new Error(rel + ' : en-tête introuvable');
  // Module JavaScript, à la fin du script unique de la page.
  const js = headerJs(page);
  if (/\/\/ HEADER:BEGIN[\s\S]*?\/\/ HEADER:END/.test(out)) out = out.replace(/\/\/ HEADER:BEGIN[\s\S]*?\/\/ HEADER:END/, () => js);
  else {
    // Ancien module du menu (« Menu de navigation : … ») remplacé, sinon ajout avant la fin du dernier script.
    const old = /\/\/ Menu de navigation : libellés et liens[\s\S]*?\n\}\)\(\);\n/;
    if (old.test(out)) out = out.replace(old, () => js + '\n');
    else {
      const i = out.lastIndexOf('</script>');
      if (i < 0) throw new Error(rel + ' : script introuvable');
      out = out.slice(0, i) + js + '\n' + out.slice(i);
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const rel of Object.keys(PAGES)) {
    const f = join(SITE, rel), html = readFileSync(f, 'utf8'), out = apply(rel, html);
    if (out === html) continue;
    stale++;
    if (check) console.error('En-tête à régénérer : site/' + rel);
    else { writeFileSync(f, out); console.log('En-tête mis à jour : site/' + rel); }
  }
  if (check && stale) { console.error('Lancer node tools/build-header.mjs puis node tools/build-csp.mjs.'); process.exit(1); }
  if (!check) console.log(stale ? stale + ' page(s) mise(s) à jour.' : 'En-têtes à jour.');
}
