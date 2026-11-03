// Panier des acheteurs (ADR 0028) dans Chromium, fonctions Edge « offers » et « order » simulées : ajout depuis
// /offres/ et /recherche/, page /panier/ (devis en euros par ligne, quantité, retrait, offre disparue), envoi d'une
// seule demande CART-…, suivi du panier, trois langues, téléphone (390 px), sans JavaScript, aucune requête externe.
// Usage : (cd site && python3 -m http.server 8765) & node tools/test-panier-ui.mjs
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
const FN = 'https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/';
let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };
const norm = (t) => (t || '').replace(/[  ]/g, ' ');

// Offres fictives, prix en euros comme partner_offers et public_search (migration 20261103000025).
const OFFERS = [
  { mpn: 'NE555DR', manufacturer: 'Texas Instruments', supplier: 'partner', source: 'distributor', ship_from: 'CN', currency: 'EUR', availability: '10000+', moq: 100, spq: 2500, min_qty: 2500, price_from: 0.09, price_1k: 0.1, updated_at: '2026-11-03T08:00:00Z' },
  { mpn: 'LM358DR', manufacturer: 'Texas Instruments', supplier: 'partner', source: 'distributor', ship_from: 'CN', currency: 'EUR', availability: '1000+', moq: 1, price_from: 0.05, price_1k: 0.06, updated_at: '2026-11-03T08:00:00Z' },
  { mpn: 'GONE123', manufacturer: 'Fictif', supplier: 'partner', source: 'broker', ship_from: 'HK', currency: 'EUR', availability: '100+', moq: 1, price_from: 1, price_1k: null, updated_at: '2026-11-03T08:00:00Z' },
];
const PRICE = { NE555DR: 0.1, LM358DR: 0.06, BSS138: null };
// MOQ et SPQ du lot retenu par le devis (public_quote, migration 20261103000027).
const PACK = { NE555DR: { moq: 100, spq: 2500 }, BSS138: { moq: 10, spq: 1 } };
const minOf = (k) => (k.spq > 1 ? Math.ceil(k.moq / k.spq) * k.spq : k.moq);
const state = { carts: [], external: [], quotes: 0 };

async function mock(page, errors) {
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(/^(?!http:\/\/localhost|https:\/\/tuhbzziqyisdnqzfvtkh)/, (r) => { state.external.push(r.request().url()); return r.abort(); });
  await page.route(FN + '**', (r) => {
    const req = r.request(), u = new URL(req.url());
    const reply = (d, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' }, body: JSON.stringify(d) });
    if (req.method() === 'OPTIONS') return reply({});
    if (u.pathname.endsWith('/offers')) return reply({ query: '', currency: 'EUR', rates_at: '2026-11-03T15:00:00Z', ttl_days: 7, ttl_days_manufacturer: 14, offers: OFFERS });
    if (u.pathname.endsWith('/search')) return reply({ query: 'BSS', currency: 'EUR', rates_at: '2026-11-03T15:00:00Z',
      results: [{ mpn: 'BSS138', manufacturer: 'onsemi', source: 'manufacturer', ship_from: 'CN', currency: 'EUR', availability: '10000+', price_from: null }] });
    if (u.pathname.endsWith('/quote')) {
      state.quotes++;
      const mpn = u.searchParams.get('mpn'), qty = +u.searchParams.get('qty');
      if (!(mpn in PRICE)) return reply({ error: 'not_found' }, 404);
      const p = PRICE[mpn], k = PACK[mpn] || { moq: 1, spq: 1 };
      return reply({ currency: u.searchParams.get('cur'), qty, unit_price: p, total: p == null ? null : +(p * qty).toFixed(2), covered: qty <= 10000,
        moq: k.moq, spq: k.spq, min_qty: minOf(k), qty_ok: qty >= k.moq && qty % k.spq === 0 });
    }
    if (u.pathname.endsWith('/cart')) {
      const b = JSON.parse(req.postData());
      state.carts.push(b);
      const missing = b.lines.find((l) => !(l.mpn in PRICE));
      if (missing) return reply({ error: 'not_found', mpn: missing.mpn }, 404);
      return reply({ ref: 'CART-0007', token: 'tok', currency: 'EUR', lines: b.lines.map((l, i) => ({ ref: 'PR-00' + (30 + i), mpn: l.mpn, qty: +l.qty })),
        status_url: 'https://central.parts/recherche/commande/?ref=CART-0007&k=tok' });
    }
    if (u.pathname.endsWith('/status')) return reply({ ref: 'CART-0007', cart: true, currency: 'EUR', created_at: '2026-11-03T20:00:00Z', total: null, lines: [
      { ref: 'PR-0030', status: 'submitted', mpn: 'NE555DR', qty: 2000, unit_price: 0.1, total: 200 },
      { ref: 'PR-0031', status: 'pending_validation', mpn: 'BSS138', qty: 10, unit_price: null, total: null }] });
    return reply({ error: 'not_found' }, 404);
  });
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'fr-FR' });
let page = await ctx.newPage(), errors = [];
await mock(page, errors);

// 1. /offres/ : ajout au panier, compteur, bouton « Dans le panier ».
await page.goto(BASE + '/offres/?lang=fr');
await page.waitForSelector('#rows button.add');
ok((await page.textContent('#cart-n')) === '', 'offres : panier vide au départ');
ok(await page.$eval('#rows tr:nth-child(1) button.add', (b) => !!b.querySelector('svg') && b.textContent.trim() === '' && b.getAttribute('aria-label') === 'Ajouter au panier' && b.title === 'Ajouter au panier'),
  'offres : icône de panier, libellé accessible et infobulle');
await page.click('#rows tr:nth-child(1) button.add');
ok(norm(await page.textContent('#msg')).includes('NE555DR ajouté au panier') && (await page.textContent('#cart-n')) === '(1)', 'offres : ajout, message et compteur');
ok(await page.isVisible('#rows tr:nth-child(1) a.in') && (await page.getAttribute('#rows tr:nth-child(1) a.in', 'href')) === '/panier/?lang=fr'
  && (await page.getAttribute('#rows tr:nth-child(1) a.in', 'aria-label')) === 'Dans le panier ✓', 'offres : icône « dans le panier » qui mène au panier');
await page.click('#rows tr:nth-child(2) button.add');
await page.click('#rows tr:nth-child(3) button.add');
ok((await page.textContent('#cart-n')) === '(3)', 'offres : trois références');
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('cp-cart')));
ok(stored[0].qty === 2500 && stored[0].moq === 100 && stored[0].spq === 2500 && stored[1].qty === 1, 'offres : quantité de départ = plus petit multiple du SPQ qui atteint le MOQ');
ok(norm(await page.textContent('#rows tr:nth-child(1)')).includes('SPQ 2 500'), 'offres : SPQ affiché sous le MOQ');

// 2. /recherche/ : ajout d'une offre « sur demande ».
await page.goto(BASE + '/recherche/?q=BSS&lang=fr');
await page.waitForSelector('#list button.add');
await page.click('#list button.add');
ok((await page.textContent('#cart-n')) === '(4)' && await page.isVisible('#list a.in'), 'recherche : ajout au panier, compteur partagé');
ok(await page.$eval('#list a.in', (x) => !!x.querySelector('svg') && x.getAttribute('aria-label') === 'Dans le panier ✓'), 'recherche : icône « dans le panier »');

// 3. /panier/ : devis par ligne, offre disparue bloquante, retrait, quantité.
await page.goto(BASE + '/panier/');
await page.waitForFunction(() => document.querySelectorAll('#lines li').length === 4 && !document.querySelector('#lines').textContent.includes('…'));
let txt = norm(await page.textContent('#cart'));
ok(txt.includes('NE555DR') && /250,00 €/.test(txt) && txt.includes('prix unitaire 0,10 €'), 'panier : devis en euros pour la quantité (2 500 × 0,10 €)');
ok(txt.includes('hors transport, droits et TVA'), 'panier : prix hors transport');
ok(txt.includes('Prix à confirmer') && txt.includes('à confirmer'), 'panier : ligne sur demande et total à confirmer');
ok(await page.isVisible('#lines li.gone') && txt.includes('Offre plus disponible'), 'panier : offre disparue signalée');
ok(txt.includes('minimum 2 500 · par 2 500') && (await page.getAttribute('#q-0', 'step')) === '2500' && (await page.getAttribute('#q-0', 'min')) === '2500', 'panier : minimum et SPQ rappelés, saisie par pas du SPQ');
ok(norm(await page.textContent('#lines li:nth-child(4)')).includes('Quantité ajustée à 10 (minimum 10).') &&
  (await page.evaluate(() => JSON.parse(localStorage.getItem('cp-cart'))))[3].qty === 10, 'panier : quantité d\'une ligne de la recherche ajustée au MOQ donné par le devis');
await page.fill('#o-company', 'Atelier Panier (fictif)');
await page.fill('#o-vat', 'FR00999999999');
await page.fill('#o-name', 'Léa Test');
await page.fill('#o-email', 'panier@example.com');
await page.selectOption('#o-country', 'FR');
await page.fill('#o-address', '3 rue de l\'Exemple, 33000 Bordeaux');
await page.check('#o-terms');
await page.click('#o-send');
ok(norm(await page.textContent('#msg')).includes('Retirez d’abord') && state.carts.length === 0, 'panier : envoi bloqué tant qu\'une offre disparue reste');
await page.click('#lines li.gone button.rm');
await page.waitForFunction(() => document.querySelectorAll('#lines li').length === 3);
await page.fill('#q-0', '6000');
await page.waitForFunction(() => document.getElementById('lines').textContent.replace(/[  ]/g, ' ').includes('750,00 €'));
ok(norm(await page.textContent('#lines li:first-child')).includes('Quantité ajustée à 7 500 (minimum 2 500, par 2 500)'), 'panier : 6 000 ajusté au multiple du SPQ supérieur (7 500), devis recalculé');
ok((await page.evaluate(() => JSON.parse(localStorage.getItem('cp-cart'))))[0].qty === 7500, 'panier : quantité ajustée gardée dans le navigateur');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'panier : pas de défilement horizontal (1280 px)');

// 4. Envoi : une seule demande, panier vidé, lien de suivi.
await page.click('#o-send');
await page.waitForSelector('#done:not([hidden])');
const sent = state.carts.at(-1);
ok(sent.lines.length === 3 && sent.lines[0].qty === '7500' && sent.currency === 'EUR' && sent.company === 'Atelier Panier (fictif)', 'envoi : trois lignes, quantités, coordonnées, en euros');
ok(norm(await page.textContent('#done-msg')).includes('CART-0007') && (await page.getAttribute('#done-link', 'href')).includes('k=tok'), 'envoi : référence du panier et lien de suivi');
ok((await page.evaluate(() => JSON.parse(localStorage.getItem('cp-cart')))).length === 0 && await page.isHidden('#cart') && await page.isHidden('#empty'), 'envoi : panier vidé');

// 5. Suivi d'un panier.
await page.goto(BASE + '/recherche/commande/?ref=CART-0007&k=tok&lang=fr');
await page.waitForSelector('#cart-lines:not([hidden]) .cl');
txt = norm(await page.textContent('#out'));
ok(txt.includes('CART-0007') && txt.includes('NE555DR × 2000') && txt.includes('Demande transmise au fournisseur') && txt.includes('en cours de vérification'), 'suivi : chaque ligne et son statut');
ok(await page.isHidden('#steps') && !/V-\d|ORG-/.test(txt), 'suivi : pas d\'étapes uniques, jamais le fournisseur');

// 6. Panier vide, langues.
await page.goto(BASE + '/panier/?lang=zh');
await page.waitForSelector('#empty:not([hidden])');
ok((await page.textContent('h1')) === '购物车' && (await page.getAttribute('#to-offers', 'href')) === '/offres/?lang=zh', '中文 : panier vide, lien vers les offres');
await page.click('[data-lang=en]');
ok((await page.textContent('#empty')).includes('Your cart is empty'), 'EN : panier vide');
ok(await page.getAttribute('meta[name=robots]', 'content') === 'noindex, nofollow', 'panier non indexé');

// 7. Envoi refusé par le serveur : la ligne disparue est désignée.
await page.evaluate(() => localStorage.setItem('cp-cart', JSON.stringify([{ mpn: 'LM358DR', source: 'distributor', ship_from: 'CN', qty: 5, moq: 1 }])));
PRICE.LM358DR = 0.06;
await page.goto(BASE + '/panier/?lang=fr');
await page.waitForSelector('#lines li');
delete PRICE.LM358DR;
for (const [id, v] of [['#o-company', 'A'], ['#o-vat', 'DE123456789'], ['#o-name', 'B'], ['#o-email', 'b@example.com'], ['#o-address', 'C']]) await page.fill(id, v);
await page.selectOption('#o-country', 'DE');
await page.check('#o-terms');
await page.click('#o-send');
await page.waitForSelector('#msg.err');
ok(norm(await page.textContent('#msg')).includes('LM358DR n’est plus disponible') && await page.isVisible('#lines li.gone'), 'refus du serveur : référence désignée et ligne marquée');
ok(errors.length === 0, 'aucune erreur console (1280 px) : ' + errors.join(' | '));
await page.close();

// 8. Téléphone (390 px).
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR' });
  const p = await c.newPage(), errs = [];
  await mock(p, errs);
  PRICE.LM358DR = 0.06;
  await p.goto(BASE + '/offres/?lang=fr');
  await p.waitForSelector('#rows button.add');
  await p.click('#rows tr:nth-child(1) button.add');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '390 px : offres sans défilement horizontal');
  await p.goto(BASE + '/panier/');
  await p.waitForSelector('#lines li');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '390 px : panier sans défilement horizontal');
  ok(errs.length === 0, 'aucune erreur console (390 px) : ' + errs.join(' | '));
  await c.close();
}

// 9. Sans JavaScript.
{
  const p = await browser.newPage({ javaScriptEnabled: false });
  await p.goto(BASE + '/panier/');
  ok((await p.textContent('noscript')).includes('JavaScript') && (await p.textContent('h1')) === 'Panier', 'sans JavaScript : titre et message');
  await p.close();
}

ok(state.external.length === 0, 'aucune requête externe : ' + state.external.join(' '));
await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
