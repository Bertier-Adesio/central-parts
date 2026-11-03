// Guide de l'espace fournisseur (site/depot/aide/) dans Chromium : chinois et anglais, 390 et 1280 px, sans JavaScript,
// images et modèles à télécharger présents, lien depuis site/depot/, aucune requête externe.
// Usage : (cd site && python3 -m http.server 8765) & node tools/test-aide-ui.mjs
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };
const browser = await chromium.launch();
const external = [];

async function open(width, opts = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, ...opts });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(/^(?!http:\/\/localhost)/, (r) => { external.push(r.request().url()); r.abort(); });
  return { page, errors };
}

for (const width of [390, 1280]) {
  const { page, errors } = await open(width, { locale: 'zh-CN' });
  await page.goto(BASE + '/depot/aide/');
  ok(await page.isVisible('[data-l=zh] h1') && await page.isHidden('[data-l=en] h1'), width + ' px : navigateur chinois → guide en chinois');
  ok((await page.textContent('[data-l=zh] #zh-login')).includes('「供应商」→「上传库存」'), width + ' px : chemin du menu WeChat indiqué');
  ok((await page.textContent('[data-l=zh]')).includes('Adesio'), width + ' px : séparé du compte Adesio, dit clairement');
  const imgs = await page.$$eval('[data-l=zh] figure img', (l) => l.map((i) => ({ w: i.naturalWidth, src: i.getAttribute('src') })));
  await page.evaluate(() => Promise.all([...document.images].map((i) => (i.loading = 'eager', i.decode().catch(() => {})))));
  const loaded = await page.$$eval('[data-l=zh] figure img', (l) => l.every((i) => i.naturalWidth > 0));
  ok(imgs.length === 4 && loaded, width + ' px : 4 captures chargées');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + ' px : pas de défilement horizontal');
  await page.click('#lang');
  ok(await page.isVisible('[data-l=en] h1') && (await page.textContent('h1:visible')) === 'Supplier guide' && await page.evaluate(() => document.documentElement.lang) === 'en', width + ' px : bascule en anglais');
  // Modèles à télécharger : chaque lien répond.
  const hrefs = await page.$$eval('#modeles a[download]', (l) => l.map((a) => a.getAttribute('href')));
  const status = await page.evaluate((list) => Promise.all(list.map((h) => fetch(h).then((r) => r.status))), hrefs);
  ok(hrefs.length === 5 && status.every((s) => s === 200), width + ' px : 5 modèles téléchargeables (Excel et CSV)');
  ok(hrefs.includes('/depot/modeles/catalogue-produits.xlsx') && hrefs.includes('/depot/modeles/modele-fabricant.xlsx'), width + ' px : catalogue produit et modèle fabricant en Excel');
  ok(errors.length === 0, width + ' px : aucune erreur console ' + errors.join(' | '));
  await page.close();
}

// Navigateur anglais, puis choix mémorisé avec /depot/ (même clé).
{
  const { page } = await open(1280, { locale: 'en-GB' });
  await page.goto(BASE + '/depot/aide/');
  ok(await page.isVisible('[data-l=en] h1'), 'navigateur anglais → guide en anglais');
  await page.goto(BASE + '/depot/aide/?lang=zh');
  ok(await page.isVisible('[data-l=zh] h1'), '?lang=zh force le chinois');
  await page.close();
}

// Sans JavaScript : les deux langues lisibles.
{
  const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 800 } });
  await page.goto(BASE + '/depot/aide/');
  ok(await page.isVisible('[data-l=zh] h1') && await page.isVisible('[data-l=en] h1') && await page.isVisible('#modeles'), 'sans JavaScript : chinois, anglais et modèles visibles');
  ok(!(await page.content()).includes('{{'), 'aucun « {{ » dans la page');
  await page.close();
}

// Lien depuis l'espace fournisseur.
{
  const { page } = await open(390, { locale: 'zh-CN' });
  await page.route('https://tuhbzziqyisdnqzfvtkh.supabase.co/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' }));
  await page.goto(BASE + '/depot/');
  ok(await page.getAttribute('a[data-t=helpLink]', 'href') === 'aide/' && await page.getAttribute('a[data-t=tplMore]', 'href') === 'aide/#modeles', '/depot/ : liens vers le guide et les modèles Excel');
  await page.close();
}

ok(external.length === 0, 'aucune requête externe : ' + external.join(' '));
await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
