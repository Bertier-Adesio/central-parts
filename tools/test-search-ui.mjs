// Page de recherche publique (site/recherche/) dans Chromium, avec une fonction « search » simulée :
// recherche, prix « à partir de » ou sur demande, trois langues, erreurs, 390 px sans défilement horizontal.
// Usage : (cd site && python3 -m http.server 8765) & node tools/test-search-ui.mjs
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
const FN = 'https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/search';
let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };
const calls = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'fr-FR' });
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
ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'pas de défilement horizontal à 390 px');
ok(errors.length === 0, 'aucune erreur ni requête externe : ' + errors.join(' | '));

await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
