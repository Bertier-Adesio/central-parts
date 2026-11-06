// Page publique d'un fabricant (site/fabricants/, ADR 0032) et liens depuis les offres (site/offres/), dans Chromium,
// avec la fonction « offers » simulée. Fabricant et marque fictifs.
//   1. /offres/ : marque liée à la page du fabricant, « Direct fabricant » sur ses propres offres, vendeur anonyme ailleurs.
//   2. /fabricants/?b=… : présentation, logo et chiffres en trois langues ; jamais de contact, de site web ni de CA.
//   3. Marque sans page : message, rien d'autre.
// Usage : (cd site && python3 -m http.server 8765) & node tools/test-fabricants-ui.mjs
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
const SUPA = 'https://tuhbzziqyisdnqzfvtkh.supabase.co';
let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PAGE = {
  brand: 'Marque Démo', brands: ['Marque Démo', 'MD'], name: 'Fabricant de démonstration (fictif)', founded_year: 2013,
  about: { fr: 'Fabricant fictif de composants analogiques et discrets.\nDeuxième paragraphe.', en: 'Fictitious manufacturer of analog and discrete parts.', zh: '虚构的模拟和分立器件制造商。' },
  positioning: { fr: 'Analogique et discret', en: 'Analog and discrete' }, hq_city: 'Shenzhen', production_site: 'Chongqing', country: 'CN',
  area_m2: 12000, staff: 120, annual_units: 3000000000, certifications: ['IATF 16949', 'ISO 9001'], languages: ['zh', 'en'],
  offers_direct: 2, offers_authorized: 0, updated_at: '2026-11-04T10:00:00Z', logo_url: SUPA + '/storage/v1/object/public/seller-logos/ORG-0110/logo-1.png',
};
const offer = (mpn, direct, brand) => ({ mpn, manufacturer: brand || 'Marque Démo', brand_page: brand === 'Autre' ? null : 'Marque Démo', factory_direct: direct,
  supplier: 'partner', source: direct ? 'manufacturer' : 'distributor', ship_from: 'CN', currency: 'EUR', availability: '10000+', moq: 100, spq: 1,
  min_qty: 100, price_from: 0.05, price_1k: 0.06, updated_at: '2026-11-04T10:00:00Z' });
const external = [];

async function offers(route) {
  const u = new URL(route.request().url());
  const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
  // Annuaire (migration 20261106000037) : un fabricant avec logo, un sans.
  if (u.pathname.endsWith('/manufacturers')) {
    return reply([{ brand: 'Marque Démo', brands: ['Marque Démo', 'MD'], name: PAGE.name, logo_url: PAGE.logo_url, positioning: PAGE.positioning,
      hq_city: 'Shenzhen', founded_year: 2013, offers: 1813 },
      { brand: 'Autre Marque', brands: ['Autre Marque'], name: 'Autre fabricant (fictif)', logo_url: null, positioning: {}, hq_city: null, offers: 0 }]);
  }
  if (u.pathname.endsWith('/manufacturer')) {
    const b = (u.searchParams.get('brand') || '').toLowerCase();
    // « MD » : même fabricant, présenté par son distributeur agréé (migration 20261105000033).
    return b === 'marque démo' ? reply(PAGE) : b === 'md' ? reply({ ...PAGE, offers_direct: 0, offers_authorized: 3 }) : reply({ error: 'not_found' }, 404);
  }
  return reply({ query: '', currency: 'EUR', ttl_days: 7, ttl_days_manufacturer: 14, rates_at: '2026-11-04T15:00:00Z',
    offers: [offer('MDTEST001', true), offer('MDTEST002', false), offer('XYZ123', false, 'Autre'), { ...offer('MDTEST003', false), authorized_distributor: true }] });
}

const browser = await chromium.launch();
async function newPage(width) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, locale: 'fr-FR' });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(SUPA + '/functions/v1/offers**', offers);
  await page.route(SUPA + '/storage/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route(/^(?!http:\/\/localhost|https:\/\/tuhbzziqyisdnqzfvtkh\.supabase\.co)/, (r) => { external.push(r.request().url()); r.abort(); });
  return { page, errors };
}
const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

// ---------------------------------------------------------------- 1. liens depuis les offres
{
  const { page, errors } = await newPage(1280);
  await page.goto(BASE + '/offres/?lang=fr');
  await page.waitForSelector('#table:not([hidden])');
  const rows = await page.$$eval('#rows tr', (t) => t.map((r) => r.textContent));
  ok(rows[0].includes('Direct fabricant') && !rows[0].includes('Fournisseur partenaire'), 'offre du fabricant : « Direct fabricant »');
  ok(await page.getAttribute('#rows tr:first-child .tag', 'title') === 'Distribué en Europe par Central.Parts', 'badge : distribution en Europe par Central.Parts');
  ok(rows[1].includes('Fournisseur partenaire') && rows[2].includes('Fournisseur partenaire'), 'autres offres : vendeur anonyme');
  ok(rows[3].includes('Distributeur agréé') && !rows[3].includes('Direct fabricant'), 'offre du distributeur agréé : « Distributeur agréé »');
  const links = await page.$$eval('#rows a.mfr', (a) => a.map((x) => x.getAttribute('href')));
  ok((await page.getAttribute('#to-mfrs', 'href')) === '/fabricants/?lang=fr', 'offres : lien vers l\'annuaire des fabricants');
  ok(links.length === 3 && links[0] === '/fabricants/?b=Marque%20D%C3%A9mo&lang=fr', 'marque liée à la page du fabricant, marque sans page non liée');
  await page.click('[data-lang=zh]');
  ok((await page.textContent('#rows tr:first-child')).includes('原厂直供') && (await page.getAttribute('#rows a.mfr', 'href')).endsWith('lang=zh'), '中文 : 原厂直供, lien dans la langue');
  ok(errors.length === 0, 'offres : aucune erreur console ' + errors.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------- 2. page publique du fabricant
for (const width of [1280, 390]) {
  const { page, errors } = await newPage(width);
  await page.goto(BASE + '/fabricants/?b=Marque%20D%C3%A9mo&lang=fr');
  await page.waitForSelector('#page:not([hidden])');
  const text = (await page.textContent('main')).replace(/[  ]/g, ' ');
  ok((await page.textContent('#name')) === PAGE.name && await page.isVisible('#logo') && (await page.getAttribute('#logo', 'src')) === PAGE.logo_url, width + ' px : nom et logo');
  ok(text.includes('2013') && text.includes('12 000 m²') && text.includes('120+') && text.includes('3 milliard(s)') && text.includes('Chongqing'), width + ' px : chiffres clés');
  ok((await page.$$('#about p')).length === 2 && text.includes('Fabricant fictif'), width + ' px : présentation FR en paragraphes');
  ok(text.includes('ISO 9001') && text.includes('中文, English') && text.includes('2 offre(s) en ligne en direct'), width + ' px : certifications, langues, offres');
  ok(text.includes('Distribué en Europe par Central.Parts') && text.includes('revendeurs, brokers, excédents de stock'), width + ' px : distribution en Europe, limitée au canal officiel');
  ok(!/@|https?:\/\/(?!localhost)|USD|téléphone|WeChat/i.test(text), width + ' px : ni contact, ni site web, ni chiffre d\'affaires');
  ok(await noScroll(page), width + ' px : pas de défilement horizontal');
  if (width === 1280) {
    await page.click('[data-lang=en]');
    ok((await page.textContent('#about')).includes('Fictitious manufacturer') && (await page.textContent('main')).includes('3 billion'), 'EN : présentation et chiffres');
    await page.click('[data-lang=zh]');
    ok((await page.textContent('#about')).includes('虚构') && (await page.textContent('main')).includes('30 亿'), '中文 : présentation et 30 亿');
    ok((await page.getAttribute('#to-offers', 'href')) === '/offres/?lang=zh' && await page.getAttribute('meta[name=robots]', 'content') === 'noindex, nofollow',
      'lien vers les offres dans la langue, page non indexée');
  }
  ok(errors.length === 0, width + ' px : aucune erreur console ' + errors.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------- 3. marque sans page, sans JavaScript
{
  const { page, errors } = await newPage(390);
  await page.goto(BASE + '/fabricants/?b=MD&lang=fr');
  await page.waitForSelector('#page:not([hidden])');
  ok((await page.textContent('#offers-n')).includes('3 offre(s) en ligne par son distributeur agréé'), 'distributeur agréé : offres présentées comme telles');
  await page.goto(BASE + '/fabricants/?b=Inconnue&lang=fr');
  await page.waitForSelector('#msg:not([hidden])');
  ok((await page.textContent('#msg')).includes('Aucune page publiée') && await page.isHidden('#page'), 'marque sans page : message, rien d\'autre');
  await page.goto(BASE + '/fabricants/?lang=fr');
  await page.waitForSelector('#dir:not([hidden])');
  const cards = await page.$$eval('#dir-list a', (a) => a.map((x) => [x.getAttribute('href'), x.textContent.replace(/[\u202f\u00a0]/g, ' ')]));
  ok(cards.length === 2 && cards[0][0] === '?b=Marque%20D%C3%A9mo&lang=fr' && cards[0][1].includes('1 813 offre(s) en ligne') && await page.isVisible('#dir-list img.logo'),
    'annuaire : fabricants en direct avec logo, offres, lien vers leur page');
  ok(cards[1][1].includes('Autre fabricant') && (await page.textContent('#dir-list .logo-none')) === 'Aut', 'annuaire : fabricant sans logo, initiales à la place');
  ok((await page.textContent('h1')) === 'Fabricants en direct' && await noScroll(page), 'annuaire : titre, 390 px sans défilement');
  await page.click('#dir-list a');
  await page.waitForSelector('#page:not([hidden])');
  ok((await page.textContent('#name')) === PAGE.name && (await page.getAttribute('#to-dir', 'href')) === '/fabricants/?lang=fr', 'carte → page du fabricant, retour vers l\'annuaire');
  await page.goto(BASE + '/fabricants/?lang=zh');
  await page.waitForSelector('#dir:not([hidden])');
  ok((await page.textContent('h1')) === '原厂直供制造商' && (await page.textContent('#dir-list')).includes('在线报价'), 'annuaire 中文');
  ok(errors.length === 0, 'marque sans page : aucune erreur console ' + errors.join(' | '));
  await page.close();
  const nojs = await browser.newPage({ javaScriptEnabled: false });
  await nojs.goto(BASE + '/fabricants/?b=MD');
  ok((await nojs.textContent('noscript')).includes('JavaScript'), 'sans JavaScript : message lisible');
  await nojs.close();
}

ok(external.length === 0, 'aucune requête externe : ' + external.join(' '));
await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
