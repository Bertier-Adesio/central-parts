// En-tête partagé des pages écrites à la main (tools/build-header.mjs, maquette 01) dans Chromium :
// variante et entrée active de chaque page, paliers 1280 / 1180 / 1024 / 390 / 320 px sans défilement horizontal,
// cibles tactiles de 44 px sous 1140 px, liens de langue qui gardent les paramètres, langue mémorisée (cp-lang),
// changement de langue sans rechargement, compteur du panier, menu (Échap, verrou), back office, sans JavaScript.
// Les fonctions Edge sont coupées (réponse 404) : seul l'en-tête est contrôlé ici.
// Usage : (cd site && python3 -m http.server 8765) & node tools/test-header-ui.mjs
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };

// Page, variante, entrée active attendue ([texte FR ou 中文 de l'entrée, valeur de aria-current]).
const PAGES = [
  ['/recherche/', 'public', null],
  ['/recherche/commande/', 'public', null],
  ['/panier/', 'public', 'req'],
  ['/offres/', 'public', ['Offres', 'page']],
  ['/fabricants/', 'public', ['Fabricants', 'page']],
  ['/sourcing/', 'public', ['Composants rares', 'page']],
  ['/sourcing/suivi/', 'public', ['Composants rares', 'true']],
  ['/conditions/', 'public', ['Conditions commerciales', 'page']],
  ['/api/', 'public', ['API', 'page']],
  ['/depot/', 'supplier', null],
  ['/depot/aide/', 'supplier', ['使用帮助', 'page']],
  ['/depot/lien/', 'supplier-link', null],
  ['/admin/', 'admin', null],
];

const browser = await chromium.launch();
async function open(path, { width = 1280, cart = 0, lang = null, js = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, locale: 'fr-FR', javaScriptEnabled: js });
  await ctx.route(/^(?!http:\/\/localhost)/, (r) => r.fulfill({ status: 404, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":"not_found"}' }));
  await ctx.addInitScript(([c, l]) => {
    try {
      if (c) localStorage.setItem('cp-cart', JSON.stringify(Array.from({ length: c }, (_, i) => ({ mpn: 'P' + i, source: 'manufacturer', ship_from: 'CN', qty: 1 }))));
      if (l) localStorage.setItem('cp-lang', l);
    } catch (e) {}
  }, [cart, lang]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(150);
  return { page, ctx, errors };
}
const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

// 1. Chaque page : un seul en-tête, sa variante, son entrée active, lien d'évitement, aucune trace de l'ancien en-tête.
for (const [path, variant, active] of PAGES) {
  const { page, ctx, errors } = await open(path);
  const info = await page.evaluate(() => ({
    headers: document.querySelectorAll('header').length, variant: document.querySelector('.site-hdr')?.dataset.variant,
    skip: document.querySelector('.sh-skip')?.getAttribute('href'), main: !!document.getElementById('main'),
    old: !!document.querySelector('.hdr, .topnav, #cart-n, .langs, #lang'),
    current: [...document.querySelectorAll('.sh-nav a[aria-current]')].map((a) => [a.dataset.href, a.getAttribute('aria-current')]),
    reqCurrent: document.querySelector('.sh-req')?.getAttribute('aria-current'),
    dot: getComputedStyle(document.querySelector('.sh-dot')).fill,
  }));
  ok(info.headers === 1 && info.variant === variant && !info.old, `${path} : un seul en-tête, variante ${variant}`);
  ok(info.skip === '#main' && info.main, `${path} : lien d'évitement vers #main`);
  ok(info.dot !== 'none' && info.dot !== 'rgb(0, 0, 0)', `${path} : point du logo en couleur d'accent`);
  if (active === 'req') ok(info.reqCurrent === 'page' && info.current.length === 0, `${path} : le bouton du panier est la page courante`);
  else if (active) {
    const txt = await page.textContent('.sh-nav a[aria-current]');
    ok(info.current.length === 1 && info.current[0][1] === active[1] && (txt === active[0] || variant === 'supplier'), `${path} : entrée active « ${active[0]} » (aria-current=${active[1]})`);
  } else ok(info.current.length === 0 && !info.reqCurrent, `${path} : aucune entrée active`);
  ok(errors.length === 0, `${path} : aucune erreur ${errors.join(' | ')}`);
  await ctx.close();
}

// 2. Paliers : 1280 (barre complète), 1180 (panier réduit à l'icône), 1024 et 390 (menu), 320 (sans débordement).
for (const lang of ['fr', 'en', 'zh']) {
  for (const width of [1280, 1180, 1024, 390, 320]) {
    const { page, ctx } = await open('/offres/?lang=' + lang, { width, cart: 3 });
    const s = await page.evaluate(() => {
      const vis = (sel) => { const e = document.querySelector(sel); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const r = document.querySelector('.sh-req-l').getBoundingClientRect();
      return { nav: vis('.sh-nav'), menu: vis('.sh-menu'), label: r.width > 2, bar: document.querySelector('.sh-bar').getBoundingClientRect().height,
        oneLine: [...document.querySelectorAll('.sh-nav a')].every((a) => a.getClientRects().length <= 1) };
    });
    const wide = width >= 1140;
    ok(s.nav === wide && s.menu === !wide, `${lang} ${width} px : ${wide ? 'navigation dans la barre' : 'navigation dans le menu'}`);
    ok(s.label === (width >= 1240), `${lang} ${width} px : libellé du panier ${width >= 1240 ? 'affiché' : 'réduit à l\'icône'}`);
    ok(Math.round(s.bar) === (wide ? 60 : 56) && s.oneLine, `${lang} ${width} px : barre de ${wide ? 60 : 56} px sur une ligne`);
    ok(await noScroll(page), `${lang} ${width} px : pas de défilement horizontal`);
    if (!wide) {
      const small = await page.$$eval('.sh-bar a, .sh-bar summary', (l) => l.filter((e) => e.getClientRects().length && !e.classList.contains('sh-skip'))
        .map((e) => [e.className || e.tagName, Math.round(e.getBoundingClientRect().height)]).filter(([, h]) => h < 44));
      ok(small.length === 0, `${lang} ${width} px : cibles de 44 px au moins ${JSON.stringify(small)}`);
    }
    await ctx.close();
  }
}
for (const [path, width] of [['/depot/', 320], ['/depot/aide/?lang=en', 390], ['/depot/lien/', 320], ['/admin/', 320]]) {
  const { page, ctx } = await open(path, { width });
  ok(await noScroll(page), `${path} ${width} px : pas de défilement horizontal`);
  await ctx.close();
}

// 3. Langue : liens qui gardent les paramètres, changement sans rechargement, choix mémorisé pour les autres pages.
{
  const { page, ctx, errors } = await open('/recherche/?q=NE555&lang=fr');
  ok(await page.getAttribute('.sh-tools > .sh-lang a[hreflang=en]', 'href') === '/recherche/?q=NE555&lang=en', 'lien EN : garde ?q=');
  ok(await page.getAttribute('.sh-tools > .sh-lang a[hreflang=fr]', 'aria-current') === 'true', 'langue courante marquée (aria-current)');
  await page.evaluate(() => { window.__same = true; });
  await page.click('.sh-tools > .sh-lang a[hreflang=en]');
  ok(await page.evaluate(() => window.__same === true && document.documentElement.lang === 'en'), 'EN : sans rechargement, <html lang="en">');
  ok(new URL(page.url()).search === '?q=NE555&lang=en' && await page.textContent('.sh-nav a[data-href="/offres/"]') === 'Offers', 'EN : adresse et menu traduits');
  ok(await page.getAttribute('.sh-nav a[data-href="/conditions/"]', 'href') === '/conditions/?lang=en' && await page.getAttribute('.sh-nav a[data-href="/depot/"]', 'href') === '/depot/', 'liens du menu dans la langue choisie');
  ok(await page.getAttribute('a.sh-brand', 'href') === '/en/' && await page.getAttribute('.sh-tools > .sh-lang a[hreflang=en]', 'aria-current') === 'true', 'logo vers /en/, EN marqué');
  ok(await page.evaluate(() => localStorage.getItem('cp-lang')) === 'en', 'choix mémorisé (cp-lang)');
  ok(errors.length === 0, 'langue : aucune erreur ' + errors.join(' | '));
  await ctx.close();
}
for (const [path, want] of [['/conditions/', 'zh-Hans'], ['/api/', 'zh-Hans'], ['/depot/', 'zh-Hans'], ['/depot/aide/', 'zh-Hans']]) {
  const { page, ctx } = await open(path, { lang: 'zh' });
  ok(await page.evaluate(() => document.documentElement.lang) === want, `${path} : langue mémorisée appliquée`);
  await ctx.close();
}
{
  const { page, ctx } = await open('/conditions/?lang=fr', { lang: 'zh' });
  ok(await page.evaluate(() => document.documentElement.lang) === 'fr', '?lang= l\'emporte sur la langue mémorisée');
  await ctx.close();
}
{
  const { page, ctx } = await open('/depot/?lang=fr');
  ok(await page.evaluate(() => document.documentElement.lang) === 'en' && (await page.$$('.sh-tools > .sh-lang a')).length === 2, 'centre fournisseur : 中文 · EN seulement, ?lang=fr donne EN');
  await ctx.close();
}

// 4. Compteur du panier : absent à 0, nombre lu, 99+ au-delà.
for (const [cart, pill, lang, read] of [[0, null, 'fr', ''], [1, '1', 'fr', ', 1 référence'], [3, '3', 'fr', ', 3 références'], [3, '3', 'zh', '，3 个型号'], [120, '99+', 'en', ', 120 part numbers']]) {
  const { page, ctx } = await open('/conditions/?lang=' + lang, { cart });
  const c = await page.$eval('.sh-req', (a) => ({ hidden: a.querySelector('.sh-n').hidden, pill: a.querySelector('.sh-n').textContent, read: a.querySelector('.sh-vh').textContent, label: a.querySelector('.sh-req-l').textContent }));
  ok(pill === null ? c.hidden && c.read === '' : !c.hidden && c.pill === pill && c.read === read, `compteur ${cart} (${lang}) : ${pill || 'pastille absente'} ${JSON.stringify(c)}`);
  await ctx.close();
}
{
  const { page, ctx } = await open('/conditions/?lang=fr', { cart: 1 });
  await page.evaluate(() => { localStorage.setItem('cp-cart', '[{"mpn":"A"},{"mpn":"B"}]'); window.cpCount(); });
  ok(await page.textContent('.sh-req .sh-n') === '2', 'compteur mis à jour par cpCount()');
  await ctx.close();
}

// 5. Menu (390 px) : ouverture, verrou du défilement, Échap, langue depuis le menu.
{
  const { page, ctx } = await open('/offres/?lang=fr', { width: 390 });
  await page.click('.sh-menu summary');
  // L'événement « toggle » d'un <details> est asynchrone : on attend le verrou plutôt que de le lire tout de suite.
  const locked = await page.waitForFunction(() => document.documentElement.classList.contains('sh-lock'), null, { timeout: 2000 }).then(() => true, () => false);
  ok(await page.isVisible('.sh-panel a[data-href="/sourcing/"]') && locked, 'menu ouvert : entrées visibles, défilement verrouillé');
  const rows = await page.$$eval('.sh-panel .sh-row', (l) => l.map((e) => Math.round(e.getBoundingClientRect().height)));
  ok(rows.length === 6 && rows.every((h) => h >= 48), 'menu : 6 lignes de 48 px');
  await page.keyboard.press('Escape');
  ok(!(await page.evaluate(() => document.querySelector('.sh-menu').open)) && await page.evaluate(() => document.activeElement.tagName) === 'SUMMARY'
    && !(await page.evaluate(() => document.documentElement.classList.contains('sh-lock'))), 'Échap : menu fermé, focus sur le bouton Menu');
  await page.click('.sh-menu summary');
  await page.click('.sh-lang-m a[hreflang=zh]');
  ok(await page.evaluate(() => document.documentElement.lang) === 'zh-Hans' && !(await page.evaluate(() => document.querySelector('.sh-menu').open)), 'langue choisie dans le menu : 中文, menu refermé');
  await page.setViewportSize({ width: 1280, height: 800 });
  ok(await page.isVisible('.sh-nav'), 'retour à 1280 px : navigation dans la barre');
  await ctx.close();
}

// 6. Back office : langue dans la barre, ni adresse ni menu avant connexion ; logo vers /admin/.
{
  const { page, ctx } = await open('/admin/', { width: 390 });
  ok(!(await page.isVisible('#who')) && !(await page.isVisible('.sh-menu')) && await page.isVisible('.sh-tools > .sh-lang') && (await page.$$('.sh-tools > .sh-lang a')).length === 3,
  'back office avant connexion : ni adresse ni menu, langue FR · EN · 中文 dans la barre');
  ok(await page.getAttribute('a.sh-brand', 'href') === '/admin/', 'back office : logo vers /admin/');
  await ctx.close();
}

// 7. Sans JavaScript : liens réels, menu <details> utilisable, aucune pastille.
{
  const { page, ctx } = await open('/offres/', { width: 390, js: false, cart: 3 });
  await page.click('.sh-menu summary');
  ok(await page.isVisible('.sh-panel a[href="/sourcing/"]') && await page.isVisible('.sh-lang-m a[href="?lang=en"]'), 'sans JavaScript : menu ouvert, liens et langues');
  ok(!(await page.isVisible('.sh-req .sh-n')) && await page.getAttribute('.sh-req', 'href') === '/panier/', 'sans JavaScript : lien du panier sans compteur');
  await ctx.close();
}

await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
