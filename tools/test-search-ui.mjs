// Pages de recherche publique (site/recherche/) et de suivi (site/recherche/commande/) dans Chromium, avec les fonctions
// « search » et « order » simulées : recherche, prix « à partir de » ou sur demande, demande d'achat, suivi,
// trois langues, erreurs, 340 px (petit téléphone) sans défilement horizontal.
// Usage : (cd site && python3 -m http.server 8765) & node tools/test-search-ui.mjs
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
const FN = 'https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/search';
let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };
const calls = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 340, height: 844 }, locale: 'fr-FR' });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
await page.route(FN + '**', (r) => {
  const u = new URL(r.request().url()); calls.push(u.search);
  const reply = (d, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(d) });
  const q = u.searchParams.get('q').toUpperCase();
  if (q === 'LIMIT') return reply({ error: 'rate_limited' }, 429);
  if (q === 'XXX') return reply({ query: 'XXX', currency: 'EUR', results: [] });
  return reply({ query: q, currency: u.searchParams.get('cur'), results: [
    { mpn: 'NE555DR', manufacturer: 'Texas Instruments', source: 'manufacturer', ship_from: 'CN', availability: '10000+', price_from: 0.1234 },
    { mpn: 'NE555DR', manufacturer: 'Texas Instruments', source: 'broker', ship_from: 'HK', availability: '1000+', price_from: null },
  ] });
});
const ORDER = 'https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/order';
let sentOrder = null;
await page.route(ORDER + '**', (r) => {
  const u = new URL(r.request().url());
  const reply = (d, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' }, body: JSON.stringify(d) });
  if (r.request().method() === 'OPTIONS') return reply({});
  if (u.pathname.endsWith('/quote')) { const n = +u.searchParams.get('qty'); return reply({ currency: u.searchParams.get('cur'), qty: n, unit_price: 0.12, total: +(0.12 * n).toFixed(2), covered: n <= 10000 }); }
  if (u.pathname.endsWith('/status')) return u.searchParams.get('k') === 'tok' ? reply({ ref: 'PR-0001', status: 'confirmed', mpn: 'NE555DR', qty: 2000, currency: 'EUR', unit_price: 0.12, total: 240, created_at: '2026-11-01T10:00:00Z' }) : reply({ error: 'not_found' }, 404);
  sentOrder = JSON.parse(r.request().postData());
  if (sentOrder.vat === 'FR00000000000') return reply({ error: 'vat_invalid' }, 422);
  return reply({ ref: 'PR-0001', token: 'tok', currency: 'EUR', unit_price: 0.12, total: 240, covered: true, vat_checked: true, status_url: 'https://central.parts/recherche/commande/?ref=PR-0001&k=tok' });
});
await page.route(/^(?!http:\/\/localhost|https:\/\/tuhbzziqyisdnqzfvtkh)/, (r) => { errors.push('requête externe : ' + r.request().url()); return r.abort(); });

await page.goto(BASE + '/recherche/');
ok((await page.textContent('h1')) === 'Rechercher un composant', 'page en français');
await page.fill('#q', 'ne5');
await page.click('#f button');
await page.waitForSelector('.res');
ok(calls[0] === '?q=ne5&cur=EUR', 'appel avec la référence et la devise');
ok((await page.$$('.res')).length === 2, 'deux offres affichées');
const txt = await page.textContent('#list');
ok(txt.includes('à partir de') && txt.includes('Prix sur demande'), 'prix « à partir de » et prix sur demande');
ok(txt.includes('Fabricant') && txt.includes('Broker vérifié') && txt.includes('Expédié de Chine') && txt.includes('Disponible 10000+'), 'source, pays et tranche affichés');
ok(!/[0-9] (pcs|pièces)/.test(txt), 'pas de quantité exacte');
ok(new URL(page.url()).search === '?q=NE5&cur=EUR', 'adresse partageable');

await page.click('#lang');
ok((await page.textContent('h1')) === 'Search for a component' && (await page.textContent('#list')).includes('Ships from China'), 'anglais');
await page.click('#lang');
ok((await page.textContent('h1')) === '搜索元器件' && (await page.textContent('#list')).includes('价格请询价'), 'chinois');
await page.click('#lang');

await page.fill('#q', 'xx');
await page.click('#f button');
ok((await page.textContent('#msg')).includes('3 caractères'), 'moins de 3 caractères refusé sans appel');
await page.fill('#q', 'limit');
await page.click('#f button');
await page.waitForSelector('#msg:not([hidden])');
ok((await page.textContent('#msg')).includes('Trop de recherches'), 'limite de requêtes expliquée');
await page.fill('#q', 'xxx');
await page.click('#f button');
await page.waitForSelector('#out:not([hidden])');
ok((await page.textContent('#list')).includes('Aucune offre'), 'aucun résultat');

await page.goto(BASE + '/recherche/?q=NE555&cur=USD&lang=zh');
await page.waitForSelector('.res');
ok(calls[calls.length - 1] === '?q=NE555&cur=USD' && (await page.textContent('h1')) === '搜索元器件', 'lien partagé : recherche et langue relancées');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'pas de défilement horizontal à 340 px');

// Achats fermés jusqu'à leur lancement : pas de bouton « Acheter ».
ok((await page.$$('.res .buy')).length === 0, 'achats fermés : pas de bouton « Acheter »');

// Demande d'achat sur la première offre (fabricant, Chine), achats ouverts pour le test.
await page.route(BASE + '/recherche/?*', async (r) => {
  const res = await r.fetch();
  return r.fulfill({ response: res, body: (await res.text()).replace('var BUY_OPEN = false;', 'var BUY_OPEN = true;') });
});
await page.goto(BASE + '/recherche/?q=NE555&cur=EUR&lang=fr');
await page.waitForSelector('.res');
await page.click('.res .buy');
await page.waitForSelector('#buy:not([hidden])');
ok((await page.textContent('#buy-meta')).includes('Fabricant'), 'achat : offre choisie rappelée');
await page.fill('#o-qty', '2000');
await page.waitForFunction(() => document.getElementById('quote').textContent.includes('Total'));
ok((await page.textContent('#quote')).includes('240'), 'achat : devis pour la quantité');
await page.click('#o-send');
ok((await page.textContent('#msg')).includes('Vérifiez'), 'achat : champs manquants signalés');
await page.fill('#o-company', 'Atelier Test (fictif)');
await page.fill('#o-vat', 'FR00000000000');
await page.fill('#o-name', 'Jeanne Test');
await page.fill('#o-email', 'achats@example.com');
await page.selectOption('#o-country', 'FR');
await page.fill('#o-address', '1 rue de l\'Exemple, 69000 Lyon');
await page.click('#o-send');
ok((await page.textContent('#msg')).includes('Cochez'), 'achat : conditions à accepter');
await page.check('#o-terms');
await page.click('#o-send');
await page.waitForFunction(() => document.getElementById('msg').textContent.includes('VIES'));
ok(true, 'achat : numéro de TVA refusé par VIES expliqué');
await page.fill('#o-vat', 'FR12345678901');
await page.click('#o-send');
await page.waitForSelector('#done:not([hidden])');
ok(sentOrder.mpn === 'NE555DR' && sentOrder.source === 'manufacturer' && sentOrder.ship_from === 'CN' && sentOrder.qty === '2000' && sentOrder.country === 'FR', 'achat : demande envoyée avec l\'offre et la quantité');
ok((await page.textContent('#done-msg')).includes('PR-0001') && (await page.getAttribute('#done-link', 'href')).includes('k=tok'), 'achat : référence et lien de suivi');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'achat : pas de défilement horizontal à 340 px');

// Suivi de la demande.
await page.goto(BASE + '/recherche/commande/?ref=PR-0001&k=tok&lang=fr');
await page.waitForSelector('#out:not([hidden])');
ok((await page.$$('.steps li.done')).length === 2 && (await page.textContent('#steps')).includes('confirmée'), 'suivi : étapes franchies');
ok(!(await page.textContent('main')).match(/V-\d|ORG-/), 'suivi : jamais le fournisseur');
await page.goto(BASE + '/recherche/commande/?ref=PR-0001&k=faux&lang=en');
await page.waitForSelector('#msg:not([hidden])');
ok((await page.textContent('#msg')).includes('not found'), 'suivi : lien faux');
ok(errors.length === 0, 'aucune erreur ni requête externe : ' + errors.join(' | '));

await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
