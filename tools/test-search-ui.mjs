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
let quoteCur = null;

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
  // Prix convertis en euros au taux de la BCE (migration 20261103000025) : devise sur chaque offre, date du taux.
  return reply({ query: q, currency: 'EUR', rates_at: '2026-11-03T15:00:00Z', results: [
    { mpn: 'NE555DR', manufacturer: 'Texas Instruments', source: 'manufacturer', ship_from: 'CN', currency: 'EUR', availability: '10000+', price_from: 0.1234, price_1k: 0.1456 },
    { mpn: 'NE555DR', manufacturer: 'Texas Instruments', source: 'broker', ship_from: 'HK', currency: 'EUR', availability: '1000+', price_from: null },
  ] });
});
const ORDER = 'https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/order';
let sentOrder = null;
await page.route(ORDER + '**', (r) => {
  const u = new URL(r.request().url());
  const reply = (d, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' }, body: JSON.stringify(d) });
  if (r.request().method() === 'OPTIONS') return reply({});
  if (u.pathname.endsWith('/quote')) { quoteCur = u.searchParams.get('cur'); const n = +u.searchParams.get('qty'); return reply({ currency: u.searchParams.get('cur'), qty: n, unit_price: 0.12, total: +(0.12 * n).toFixed(2), covered: n <= 10000 }); }
  const st = { attente: 'pending_validation', refus: 'rejected' }[u.searchParams.get('k')];
  if (u.pathname.endsWith('/status') && st) return reply({ ref: 'PR-0001', status: st, mpn: 'NE555DR', qty: 2000, currency: 'EUR', unit_price: 0.12, total: 240, created_at: '2026-11-01T10:00:00Z' });
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
ok(calls[0] === '?cur=EUR&q=ne5', 'appel avec la référence, prix demandés en euros');
ok(!(await page.$('#cur')), 'plus de choix de devise');
ok((await page.$$('.res')).length === 2, 'deux offres affichées');
const txt = await page.textContent('#list');
ok(txt.includes('à partir de') && txt.includes('Prix sur demande'), 'prix « à partir de » et prix sur demande');
ok(/à partir de 0,1234\s*€/.test(txt.replace(/[\u202f\u00a0]/g, ' ')), 'prix affiché en euros');
ok(/prix 1 k : 0,1456\s*€/.test(txt.replace(/[\u202f\u00a0]/g, ' ')), 'prix 1KU affiché sous « à partir de », en euros');
ok(txt.includes('Taux de référence de la BCE du 03/11/2026'), 'date du taux de la BCE affichée');
ok((await page.textContent('main')).includes('Prix tout compris en euros, convertis au taux de référence de la BCE, hors transport'), 'consigne : prix en euros, hors transport');
ok(!/DAP|FCA/.test(txt) && (await page.getAttribute('#to-terms', 'href')) === '/conditions/?lang=fr', 'livraison : pas sur les offres, lien vers les conditions commerciales');
ok((txt.match(/prix 1 k/g) || []).length === 1, 'pas de prix 1KU pour une offre sur demande');
ok(txt.includes('Fabricant') && txt.includes('Broker vérifié') && txt.includes('Expédié de Chine') && txt.includes('Disponible 10000+'), 'source, pays et tranche affichés');
ok(!/[0-9] (pcs|pièces)/.test(txt), 'pas de quantité exacte');
ok(new URL(page.url()).search === '?q=NE5', 'adresse partageable');

await page.click('#lang');
ok((await page.textContent('h1')) === 'Search for a component' && (await page.textContent('#list')).includes('Ships from China'), 'anglais');
await page.click('#lang');
ok((await page.textContent('h1')) === '搜索元器件' && (await page.textContent('#list')).includes('价格请询价') && (await page.textContent('#list')).includes('千颗单价'), 'chinois');
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
ok(calls[calls.length - 1] === '?cur=EUR&q=NE555' && (await page.textContent('h1')) === '搜索元器件', 'lien partagé (ancien paramètre cur ignoré) : recherche et langue relancées');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'pas de défilement horizontal à 340 px');
// Marge pour des polices plus larges (CI) : la liste et l'icône du panier tiennent aussi à 320 px.
await page.setViewportSize({ width: 320, height: 844 });
ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'pas de défilement horizontal à 320 px (icône du panier comprise)');
await page.setViewportSize({ width: 340, height: 844 });

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
ok(quoteCur === 'EUR', 'achat : devis demandé en euros, comme le prix affiché');
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
ok((await page.$$('.steps li.done')).length === 3 && (await page.textContent('#steps')).includes('confirmée'), 'suivi : étapes franchies (vérifiée, transmise, confirmée)');
ok(!(await page.textContent('main')).match(/V-\d|ORG-/), 'suivi : jamais le fournisseur');
await page.goto(BASE + '/recherche/commande/?ref=PR-0001&k=attente&lang=fr');
await page.waitForSelector('#out:not([hidden])');
ok((await page.$$('.steps li.done')).length === 1 && (await page.textContent('#steps')).includes('en cours de vérification'), 'suivi : en attente de validation par Central.Parts');
await page.goto(BASE + '/recherche/commande/?ref=PR-0001&k=refus&lang=en');
await page.waitForSelector('#out:not([hidden])');
ok((await page.textContent('#steps')).includes('cannot follow up') && !(await page.textContent('main')).includes('rejected'), 'suivi : demande refusée, sans motif ni code');
await page.goto(BASE + '/recherche/commande/?ref=PR-0001&k=faux&lang=en');
await page.waitForSelector('#msg:not([hidden])');
ok((await page.textContent('#msg')).includes('not found'), 'suivi : lien faux');
ok(errors.length === 0, 'aucune erreur ni requête externe : ' + errors.join(' | '));

await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
