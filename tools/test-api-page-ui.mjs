// Page publique de documentation de l'API d'offres (site/api/, ADR 0011) dans Chromium.
//   - la page charge à 1280 px et 390 px, sans erreur console ni défilement horizontal ;
//   - les trois langues basculent (FR, EN, 中文), y compris l'objet du mail de demande d'accès ;
//   - aucune requête ni aucun lien vers un hôte externe (hors mailto) : accès depuis la Chine (ADR 0006) ;
//   - tous les endpoints de la phase 1 (chiffrage) et de la phase 2 (commande) sont présents ;
//   - aucun mot interdit (vocabulaire, noms de fournisseurs ou de services tiers), aucune vraie clé ;
//   - balise noindex, page absente du sitemap ; lisible sans JavaScript (français) ;
//   - lien discret depuis /offres/.
// Usage : (cd site && python3 -m http.server 8765) & node tools/test-api-page-ui.mjs
import { readFileSync } from 'node:fs';

const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };

const ENDPOINTS = [
  // Phase 1 : chiffrage
  'GET /v1/offers', 'POST /v1/offers/search', 'GET /v1/offers/{offer_id}', 'GET /v1/manufacturers',
  'GET /v1/me', 'GET /v1/usage', 'GET /v1/health',
  'POST /v1/demands', 'GET /v1/demands', 'GET /v1/demands/{id}', 'GET /v1/demands/{id}/offers',
  'POST /v1/webhooks', 'GET /v1/webhooks', 'DELETE /v1/webhooks/{id}',
  // Phase 2 : commande
  'POST /v1/inventory/orders', 'POST /v1/offers/{id}/accept', 'GET /v1/transactions', 'GET /v1/transactions/{id}',
  'POST /v1/transactions/{id}/signatures', 'POST /v1/transactions/{id}/inspection',
];
const FORBIDDEN = [/sans stock/i, /ni entrep/i, /without stock/i, /stockless/i, /escrow/i, /s[ée]questre/i, /IC ?Superman/i,
  /Concentric/i, /Octopart/i, /SiliconExpert/i, /\bCGU\b/, /conditions g[ée]n[ée]rales/i, /terms of (use|service)/i, /无库存/, /托管/];

const html = readFileSync(new URL('../site/api/index.html', import.meta.url), 'utf8');
ok(!html.includes('{{'), 'aucun « {{ » dans le HTML');
ok((html.match(/<script\b/g) || []).length === 1 && /<script>[\s\S]*<\/script>\s*<\/body>/.test(html), 'un seul <script>, en fin de page');
for (const re of FORBIDDEN) ok(!re.test(html), 'mot interdit absent : ' + re);
ok((html.match(/cp_(?:live|test)_[A-Za-z0-9]+/g) || []).every((k) => /^cp_(live|test)_X+$/.test(k)), 'exemples de clés neutres (cp_live_XXXXXXXX)');
ok(!/#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i.test(html.match(/<style>[\s\S]*<\/style>/)[0]) && !/style="[^"]*(#[0-9a-f]{3}|rgb|color)/i.test(html), 'aucune couleur en dur (variables de brand/tokens.css)');
ok(!readFileSync(new URL('../site/sitemap.xml', import.meta.url), 'utf8').includes('/api/'), 'page absente du sitemap');

const browser = await chromium.launch();
const external = [];
async function newPage(width, opts = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, ...opts });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(/^(?!http:\/\/localhost)/, (r) => { external.push(r.request().url()); r.abort(); });
  return { page, errors };
}
const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const visibleText = (page, sel) => page.evaluate((s) => document.querySelector(s).innerText, sel);

for (const width of [1280, 390]) {
  const { page, errors } = await newPage(width, { locale: 'fr-FR' });
  await page.goto(BASE + '/api/');
  ok(await page.getAttribute('meta[name=robots]', 'content') === 'noindex', width + ' px : balise noindex');
  ok((await visibleText(page, 'h1')).trim() === 'API d’offres Central.Parts', width + ' px : titre FR');
  const fr = await visibleText(page, 'main');
  ok(fr.includes('Spécification v1 en cours · accès sur demande · ouverture prévue après electronica'), width + ' px : bandeau de statut');
  ok(fr.includes('Chaque offre, tracée jusqu’à sa source.') && !fr.includes('Every offer, traced'), width + ' px : baseline FR seule');
  ok(fr.includes('Exemple fictif') && fr.includes('NE555DR'), width + ' px : exemple fictif étiqueté');
  ok(fr.includes('Adresse de base prévue') && !(await page.$('a[href*="api.central.parts"]')), width + ' px : adresse de base prévue, sans lien');
  ok(fr.includes('Adesio compris'), width + ' px : mêmes données pour tous les clients, Adesio compris');
  for (const e of ENDPOINTS) ok(await page.$(`[data-endpoint="${e}"]`), width + ' px : endpoint ' + e);
  ok((await page.$$('.ep .badge')).length === (await page.$$('.ep')).length, width + ' px : chaque bloc d’endpoint marqué « Spécification v1 »');
  ok((await page.$$('.copy')).length === (await page.$$('.ex pre')).length, width + ' px : bouton de copie sur chaque exemple');

  // Liens : seulement internes, ancres ou mailto ; ancres existantes.
  const hrefs = await page.$$eval('a[href], link[href], [src]', (els) => els.map((e) => e.getAttribute('href') || e.getAttribute('src')));
  ok(hrefs.every((h) => /^(\/(?!\/)|#|mailto:contact@central\.parts)/.test(h)), width + ' px : aucun lien externe ' + hrefs.filter((h) => !/^(\/|#|mailto:)/.test(h)).join(' '));
  const anchors = hrefs.filter((h) => h.startsWith('#'));
  ok((await page.evaluate((a) => a.filter((h) => !document.getElementById(h.slice(1))), anchors)).length === 0, width + ' px : ancres valides');
  ok(await page.$('a[href="/depot/"]') && await page.$('a[href="/recherche/"]'), width + ' px : liens vers /depot/ et /recherche/');
  ok(decodeURIComponent(await page.getAttribute('#ask', 'href')) === 'mailto:contact@central.parts?subject=Demande d’accès à l’API d’offres Central.Parts', width + ' px : mailto FR prérempli');
  ok(await noScroll(page), width + ' px : FR sans défilement horizontal');

  await page.click('[data-lang=en]');
  ok((await visibleText(page, 'h1')).trim() === 'Central.Parts Offers API' && await page.evaluate(() => document.documentElement.lang) === 'en', width + ' px : EN');
  const en = await visibleText(page, 'main');
  ok(en.includes('Every offer, traced to its source.') && !en.includes('Chaque offre') && en.includes('Fictitious example'), width + ' px : EN seul visible');
  ok(decodeURIComponent(await page.getAttribute('#ask', 'href')).endsWith('Access request: Central.Parts Offers API'), width + ' px : mailto EN');
  ok(await page.getAttribute('#home', 'href') === '/en/', width + ' px : accueil EN');
  ok(await noScroll(page), width + ' px : EN sans défilement horizontal');

  await page.click('[data-lang=zh]');
  ok((await visibleText(page, 'h1')).trim() === 'Central.Parts 报价 API' && await page.evaluate(() => document.documentElement.lang) === 'zh-Hans', width + ' px : 中文');
  const zh = await visibleText(page, 'main');
  ok(zh.includes('每条报价，均可追溯至来源。') && !zh.includes('Every offer') && zh.includes('虚构示例'), width + ' px : 中文 seul visible');
  ok(await page.getAttribute('#home', 'href') === '/zh/', width + ' px : accueil 中文');
  ok(await noScroll(page), width + ' px : 中文 sans défilement horizontal');

  // La langue choisie est retenue.
  await page.reload();
  ok((await visibleText(page, 'h1')).trim() === 'Central.Parts 报价 API', width + ' px : langue retenue au rechargement');
  await page.click('[data-lang=fr]');
  ok(errors.length === 0, width + ' px : aucune erreur console ' + errors.join(' | '));
  await page.close();
}

// ?lang=en l'emporte sur la langue du navigateur.
{
  const { page } = await newPage(1280, { locale: 'zh-CN' });
  await page.goto(BASE + '/api/?lang=en');
  ok((await visibleText(page, 'h1')).trim() === 'Central.Parts Offers API', '?lang=en');
  await page.close();
}

// Copie d'un exemple.
{
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], locale: 'fr-FR' });
  const page = await ctx.newPage();
  await page.route(/^(?!http:\/\/localhost)/, (r) => { external.push(r.request().url()); r.abort(); });
  await page.goto(BASE + '/api/');
  await page.click('#exemple ~ .ex .copy');
  await page.waitForFunction(() => document.querySelector('#exemple ~ .ex .copy').textContent === 'Copié');
  ok((await page.evaluate(() => navigator.clipboard.readText())).startsWith('GET /v1/offers?mpn=NE555DR'), 'copie de l’exemple');
  await ctx.close();
}

// Sans JavaScript : français lisible, autres langues masquées.
for (const width of [1280, 390]) {
  const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width, height: 900 } });
  await page.goto(BASE + '/api/');
  const text = await visibleText(page, 'main');
  ok((await visibleText(page, 'h1')).trim() === 'API d’offres Central.Parts' && text.includes('Référence des endpoints') && text.includes('Le prix publié est tout compris.'), width + ' px sans JavaScript : contenu FR lisible');
  ok(!text.includes('Every offer, traced') && !text.includes('每条报价'), width + ' px sans JavaScript : EN et 中文 masqués');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + ' px sans JavaScript : pas de défilement horizontal');
  await page.close();
}

// Lien discret depuis /offres/ (la fonction Edge n'est pas simulée ici : seul le lien compte).
{
  const page = await browser.newPage({ javaScriptEnabled: false });
  await page.goto(BASE + '/offres/');
  ok(await page.$('a[href="/api/"]'), 'lien vers /api/ depuis /offres/');
  await page.close();
}

ok(external.length === 0, 'aucune requête externe : ' + external.join(' '));
await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
