// Recherche du héros de la landing (/, /en/ ; /zh/ garde son héros de fabricants) dans Chromium, API simulée :
// chiffres du réseau, offres affichées sur place, ajout au panier (cp-cart, ADR 0028), pièce introuvable transformée
// en demande (formulaire de contact pré-rempli) ou en recherche prioritaire (/sourcing/), recherche en panne,
// sans JavaScript (le formulaire mène à /recherche/), 1280 et 390 px sans défilement horizontal ni requête externe.
// Usage : (cd site && python3 -m http.server 8765) & node tools/test-landing-ui.mjs
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
const SUPA = 'https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/';
let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };

const OFFERS = { query: '', total_refs: 1811, total_units: 393101811, rates_at: '2026-11-09T15:00:00Z', offers: [] };
const HIT = { query: 'AMS1117', currency: 'EUR', rates_at: '2026-11-09T15:00:00Z', results: [
  { mpn: 'AMS1117-3.3', manufacturer: 'UMW', source: 'manufacturer', ship_from: 'CN', availability: '100000+', price_from: 0.1639, price_1k: 0.2295, currency: 'EUR' },
  { mpn: 'AMS1117-5.0', manufacturer: 'UMW', source: 'manufacturer', ship_from: 'CN', availability: '100000+', price_from: 0.163, price_1k: 0.2238, currency: 'EUR' },
  { mpn: 'AMS1117-1.8', manufacturer: 'UMW', source: 'distributor', ship_from: 'HK', availability: '10000+', price_from: null, price_1k: null, currency: 'EUR' }] };

const browser = await chromium.launch();
async function open(path, { width = 1280, js = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: 'fr-FR', javaScriptEnabled: js });
  const state = { external: [], searches: [] };
  await ctx.route(SUPA + 'offers**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(OFFERS) }));
  await ctx.route(SUPA + 'search**', (r) => {
    const q = new URL(r.request().url()).searchParams.get('q');
    state.searches.push(q);
    if (q === 'PANNE') return r.fulfill({ status: 500, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":"other"}' });
    const body = q.startsWith('AMS') ? HIT : { query: q, currency: 'EUR', results: [] };
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });
  await ctx.route(/^(?!http:\/\/localhost|https:\/\/tuhbzziqyisdnqzfvtkh\.supabase\.co)/, (r) => { state.external.push(r.request().url()); r.abort(); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Le 500 de la recherche en panne est provoqué par le test : le navigateur le journalise.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 500/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE + path, { waitUntil: 'load' });
  return { page, ctx, state, errors };
}
const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const search = async (page, q) => { await page.fill('#hero-q', q); await page.click('#hero-search button[type=submit]'); };

for (const width of [1280, 390]) {
  // FR : chiffres du réseau, offres, panier.
  const { page, ctx, state, errors } = await open('/', { width });
  ok((await page.textContent('h1')) === 'Le prix de votre composant, tout de suite.', `${width} px : accroche FR`);
  await page.waitForFunction(() => /références en ligne/.test(document.getElementById('hero-live').textContent));
  const live = (await page.textContent('#hero-live')).replace(/[  ]/g, ' ');
  ok(live.includes('1 811 références en ligne') && live.includes('393 101 811 pièces en stock') && live.includes('09/11/2026'), `${width} px : réseau vivant (références, pièces, taux de la BCE)`);
  await search(page, ' ams1117 ');
  await page.waitForSelector('#hero-res .hs-row');
  ok(state.searches.at(-1) === 'AMS1117', `${width} px : référence nettoyée (espaces, majuscules)`);
  ok((await page.$$('#hero-res .hs-row')).length === 3, `${width} px : offres affichées sur place`);
  const first = await page.textContent('#hero-res .hs-row');
  ok(first.includes('AMS1117-3.3') && first.includes('Direct fabricant') && /0,1639/.test(first) && first.includes('Chine'), `${width} px : référence, source, prix, pays d'expédition`);
  ok((await page.textContent('#hero-res .hs-row:nth-child(3)')).includes('Prix sur demande'), `${width} px : prix sur demande`);
  ok((await page.getAttribute('#hero-res .hs-foot a', 'href')) === '/recherche/?lang=fr&q=AMS1117', `${width} px : lien vers toutes les offres`);
  await page.click('#hero-res button.hs-add');
  await page.waitForSelector('#hero-res a.hs-add.in');
  const cart = await page.evaluate(() => JSON.parse(localStorage.getItem('cp-cart')));
  ok(cart.length === 1 && cart[0].mpn === 'AMS1117-3.3' && cart[0].source === 'manufacturer', `${width} px : ajout au panier commun (cp-cart)`);
  ok((await page.getAttribute('#hero-res a.hs-add.in', 'href')) === '/panier/?lang=fr', `${width} px : « Dans le panier » mène au panier`);
  ok(await noScroll(page), `${width} px : pas de défilement horizontal avec les résultats`);
  if (width === 390) {
    const h = await page.$eval('#hero-res button.hs-add', (b) => b.getBoundingClientRect().height);
    ok(h >= 44, '390 px : bouton d\'ajout de 44 px');
  }

  // Pièce introuvable : demande pré-remplie dans le formulaire de contact, ou recherche prioritaire.
  await search(page, 'STM32F103');
  await page.waitForSelector('#hero-res .hs-none');
  ok((await page.textContent('#hero-res h3')) === 'STM32F103 n’est pas en stock en ligne aujourd’hui.', `${width} px : pièce introuvable, sans impasse`);
  ok((await page.getAttribute('#hero-res .hs-alt', 'href')) === '/sourcing/?lang=fr&q=STM32F103', `${width} px : recherche prioritaire (/sourcing/)`);
  await page.fill('#hs-find input[name=qty]', '2000');
  await page.click('#hs-find button');
  await page.waitForFunction(() => /STM32F103/.test(document.querySelector('#contact-form textarea').value));
  const msg = await page.$eval('#contact-form textarea', (t) => t.value);
  ok(msg.includes('STM32F103') && msg.includes('2000'), `${width} px : formulaire de contact pré-rempli (référence, quantité)`);
  ok(await page.$eval('#contact-form [data-tab=buyer]', (b) => b.getAttribute('aria-pressed')) === 'true', `${width} px : onglet Acheteur choisi`);
  ok(await page.evaluate(() => document.activeElement && document.activeElement.name === 'nom'), `${width} px : curseur dans le premier champ`);

  // Recherche en panne, référence trop courte.
  await search(page, 'PANNE');
  await page.waitForFunction(() => /ne répond pas/.test(document.getElementById('hero-res').textContent));
  ok((await page.getAttribute('#hero-res .hs-msg a', 'href')) === '/recherche/?lang=fr&q=PANNE', `${width} px : panne de recherche, lien de secours`);
  const before = state.searches.length;
  await page.fill('#hero-q', 'AB');
  await page.$eval('#hero-search', (f) => f.requestSubmit());
  ok(state.searches.length === before && !(await page.$eval('#hero-q', (i) => i.checkValidity())), `${width} px : 2 caractères refusés par le navigateur (minlength)`);
  await page.fill('#hero-q', ' A B ');
  await page.$eval('#hero-search', (f) => f.requestSubmit());
  ok((await page.textContent('#hero-res')).includes('au moins 3 caractères') && state.searches.length === before, `${width} px : référence trop courte une fois les espaces retirés`);
  ok(state.external.length === 0, `${width} px : aucune requête externe ${state.external.join(' ')}`);
  ok(errors.length === 0, `${width} px : aucune erreur ${errors.join(' | ')}`);
  await ctx.close();
}

// EN : textes et liens dans la langue.
{
  const { page, ctx, errors } = await open('/en/');
  ok((await page.textContent('h1')) === 'The price of your component, right now.', 'EN : accroche');
  await search(page, 'AMS1117');
  await page.waitForSelector('#hero-res .hs-row');
  ok((await page.textContent('#hero-res')).includes('Add to my request') && (await page.getAttribute('#hero-res .hs-foot a', 'href')) === '/recherche/?lang=en&q=AMS1117', 'EN : offres et liens en anglais');
  ok(errors.length === 0, 'EN : aucune erreur ' + errors.join(' | '));
  await ctx.close();
}

// 中文 : page des fabricants, héros inchangé (pas de recherche, deux boutons).
{
  const { page, ctx, errors } = await open('/zh/');
  ok(!(await page.$('#hero-search')) && (await page.$$('#top a[data-pick-tab]')).length === 2, '中文 : héros des fabricants, sans recherche');
  ok(errors.length === 0, '中文 : aucune erreur ' + errors.join(' | '));
  await ctx.close();
}

// Sans JavaScript : la recherche mène à /recherche/ avec la langue.
{
  const { page, ctx } = await open('/', { js: false });
  await page.fill('#hero-q', 'AMS1117');
  await Promise.all([page.waitForURL(/\/recherche\//), page.click('#hero-search button[type=submit]')]);
  const u = new URL(page.url());
  ok(u.pathname === '/recherche/' && u.searchParams.get('q') === 'AMS1117' && u.searchParams.get('lang') === 'fr', 'sans JavaScript : /recherche/?lang=fr&q=AMS1117');
  await ctx.close();
}

await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
