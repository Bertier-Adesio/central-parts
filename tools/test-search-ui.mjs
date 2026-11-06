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
let quoteCur = null, netFails = 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 340, height: 844 }, locale: 'fr-FR' });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// Panne réseau simulée (« Réessayer ») : le navigateur journalise net::ERR_FAILED.
page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d|net::ERR_FAILED/.test(m.text())) errors.push(m.text()); });
await page.route(FN + '**', (r) => {
  const u = new URL(r.request().url()); calls.push(u.search);
  const reply = (d, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(d) });
  const q = u.searchParams.get('q').toUpperCase();
  if (q === 'LIMIT') return reply({ error: 'rate_limited' }, 429);
  // Panne réseau à la première tentative, réponse à la seconde (« Réessayer »).
  if (q === 'PANNE') { netFails++; return netFails === 1 ? r.abort('failed') : reply({ query: 'PANNE', currency: 'EUR', results: [] }); }
  // Réponse lente : laisse voir l'état de chargement.
  if (q === 'LENT') return new Promise((res) => setTimeout(res, 800)).then(() => reply({ query: 'LENT', currency: 'EUR', results: [] }));
  if (q === 'UN1') return reply({ query: 'UN1', currency: 'EUR', rates_at: '2026-11-03T15:00:00Z', results: [
    { mpn: 'UN1', manufacturer: 'Texas Instruments', source: 'distributor', ship_from: 'HK', currency: 'EUR', availability: '100+', price_from: 1.5 }] });
  if (q === 'XXX' || q.startsWith('ZZ')) return reply({ query: q, currency: 'EUR', results: [] });
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
// Décompte et date du taux : deux phrases, vrai pluriel (review n° 17).
ok((await page.textContent('#res-count')) === '2 offres pour « NE5 ».' && (await page.textContent('#res-rate')) === 'Taux de référence de la BCE du 03/11/2026.', 'décompte et taux : deux phrases, pluriel');
// Bandeau « Comment demander un prix » (handoff 02) : trois étapes et « Rien n'est facturé ».
ok(await page.$$eval('.how li', (l) => l.length) === 3 && (await page.textContent('.how')).includes('Rien n\'est facturé à cette étape.'), 'bandeau : trois étapes et rien de facturé');
// Bouton texte « Ajouter à la demande » (review n° 2), 44 px de haut sur téléphone ; pas encore de barre.
ok(await page.$$eval('.res button.add', (b) => b.every((x) => x.textContent === 'Ajouter à la demande' && x.getBoundingClientRect().height >= 44)), 'bouton texte « Ajouter à la demande », 44 px');
ok(await page.isHidden('#reqbar'), 'barre « Ma demande » masquée tant que la demande est vide');
// Compte acheteur (review n° 5) : le bouton dit ce qu'il fait, avec une ligne d'explication.
ok((await page.textContent('#cta-buyer')) === 'Demander un accès acheteur' && (await page.getAttribute('#cta-buyer', 'href')) === '/#contact'
  && (await page.textContent('.acct')).includes('ouverts sur demande'), 'compte acheteur : « Demander un accès acheteur » vers le contact');
ok(await page.$$eval('main .btn-accent', (b) => b.filter((x) => x.offsetParent).length) === 0, 'aucun bouton rouge avant l\'ajout');
await page.click('.res:nth-of-type(1) button.add');
ok(await page.isVisible('.res a.in.btn-done') && (await page.textContent('.res a.in')).trim() === 'Ajouté · Voir ma demande' && (await page.getAttribute('.res a.in', 'href')) === '/panier/?lang=fr'
  && await page.evaluate(() => document.activeElement.classList.contains('in')), 'après ajout : « Ajouté · Voir ma demande » vers la demande, focus gardé');
ok(await page.isVisible('#reqbar') && (await page.textContent('#reqbar-n')) === '1 référence' && (await page.getAttribute('#reqbar-go', 'href')) === '/panier/?lang=fr'
  && (await page.textContent('#cart-n')) === '1', 'barre « Ma demande » : une référence, lien vers la demande, compteur de l\'en-tête');
ok(await page.$$eval('main .btn-accent', (b) => b.filter((x) => x.offsetParent).length) === 1, 'un seul bouton rouge : celui de la barre');
ok(await page.evaluate(() => { const b = document.getElementById('reqbar').getBoundingClientRect(); return getComputedStyle(document.getElementById('reqbar')).position === 'sticky' && b.bottom <= innerHeight + 1; }), 'barre collante en bas de l\'écran');
await page.click('.res button.add');
ok((await page.textContent('#reqbar-n')) === '2 références', 'barre : pluriel');
ok((await page.textContent('main')).includes('Prix tout compris en euros, convertis au taux de référence de la BCE, hors transport'), 'consigne : prix en euros, hors transport');
ok(!/DAP|FCA/.test(txt) && (await page.getAttribute('#to-terms', 'href')) === '/conditions/?lang=fr', 'livraison : pas sur les offres, lien vers les conditions commerciales');
ok((txt.match(/prix 1 k/g) || []).length === 1, 'pas de prix 1KU pour une offre sur demande');
ok(txt.includes('Fabricant') && txt.includes('Broker vérifié') && txt.includes('Expédié de Chine') && txt.includes('Disponible 10000+'), 'source, pays et tranche affichés');
ok(!/[0-9] (pcs|pièces)/.test(txt), 'pas de quantité exacte');
ok(new URL(page.url()).search === '?q=NE5', 'adresse partageable');

await page.$eval('.site-hdr [data-lang=en]', (a) => a.click());
ok((await page.textContent('h1')) === 'Search for a component' && (await page.textContent('#list')).includes('Ships from China'), 'anglais');
ok((await page.textContent('#res-count')) === '2 offers for "NE5".' && (await page.textContent('#reqbar')).includes('2 part numbers') && (await page.textContent('#reqbar-go')) === 'View my request'
  && (await page.textContent('.res a.in')).includes('Added · View my request') && (await page.textContent('#cta-buyer')) === 'Request buyer access' && (await page.getAttribute('#cta-buyer', 'href')) === '/en/#contact', 'anglais : décompte, barre, compte');
await page.$eval('.site-hdr [data-lang=zh]', (a) => a.click());
ok((await page.textContent('h1')) === '搜索元器件' && (await page.textContent('#list')).includes('价格请询价') && (await page.textContent('#list')).includes('千颗单价'), 'chinois');
ok((await page.textContent('#res-count')) === '「NE5」共 2 条报价。' && (await page.textContent('#reqbar-go')) === '查看询价单' && (await page.textContent('.how')).includes('此阶段不产生任何费用')
  && (await page.textContent('#cta-buyer')) === '申请采购方账号', 'chinois : décompte, barre, bandeau, compte');
await page.evaluate(() => localStorage.removeItem('cp-cart'));
await page.$eval('.site-hdr [data-lang=fr]', (a) => a.click());

await page.fill('#q', 'xx');
await page.click('#f button');
ok((await page.textContent('#msg')).includes('3 caractères'), 'moins de 3 caractères refusé sans appel');
await page.fill('#q', 'limit');
await page.click('#f button');
await page.waitForSelector('#err:not([hidden])');
ok((await page.textContent('#err')).includes('Trop de recherches') && await page.isHidden('#out'), 'limite de requêtes expliquée');
await page.fill('#q', 'xxx');
await page.click('#f button');
await page.waitForSelector('#out:not([hidden]) #list .res-head');
ok((await page.textContent('#list')).includes('Aucune offre') && await page.isHidden('#err'), 'aucun résultat');
ok((await page.textContent('#none-hint')).includes('début de référence plus court') && !(await page.$('#try-short')), 'aucun résultat : suggestion, sans raccourci pour 3 caractères');
await page.fill('#q', 'zzzzz');
await page.click('#f button');
await page.waitForSelector('#try-short');
ok((await page.textContent('#try-short')) === 'Rechercher « ZZZ »', 'aucun résultat : début de référence plus court proposé');
await page.click('#try-short');
await page.waitForFunction(() => new URLSearchParams(location.search).get('q') === 'ZZZ');
ok(calls[calls.length - 1] === '?cur=EUR&q=ZZZ', 'suggestion : recherche relancée sur le début plus court');
// Une offre : singulier.
await page.fill('#q', 'un1');
await page.click('#f button');
await page.waitForSelector('#res-count');
ok((await page.textContent('#res-count')) === '1 offre pour « UN1 ».', 'une offre : singulier');
// Chargement : trois lignes grises de 72 px, puis le résultat.
await page.fill('#q', 'lent');
await page.click('#f button');
await page.waitForSelector('#list .skel');
ok(await page.$$eval('#list .skel', (s) => s.length === 3 && s.every((x) => Math.round(x.getBoundingClientRect().height) === 72)) && (await page.getAttribute('#out', 'aria-busy')) === 'true', 'chargement : trois lignes grises de 72 px');
await page.waitForSelector('#list .skel', { state: 'detached' });
ok((await page.textContent('#list')).includes('Aucune offre'), 'chargement terminé : résultat affiché');
// Erreur réseau : message et « Réessayer ».
await page.fill('#q', 'panne');
await page.click('#f button');
await page.waitForSelector('#err:not([hidden])');
ok((await page.textContent('#err-t')).includes('Erreur réseau') && (await page.textContent('#retry')) === 'Réessayer', 'erreur réseau : message et « Réessayer »');
await page.click('#retry');
await page.waitForSelector('#none-hint');
ok(netFails === 2 && (await page.textContent('#list')).includes('PANNE'), 'Réessayer : la recherche est relancée');

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
ok(/not found|no request found/i.test(await page.textContent('#msg')), 'suivi : lien faux');
ok(errors.length === 0, 'aucune erreur ni requête externe : ' + errors.join(' | '));

await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
