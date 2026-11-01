// Parcours des listes des vendeurs dans Chromium (ADR 0021), avec les fonctions « listes » et « offers » simulées :
// le fichier déposé passe par le vrai lecteur (supabase/functions/import-stock/parse.js), comme en production.
//   1. site/depot/lien/ : lien personnel, dépôt de la liste de test (10 références), rapport, puis d'une liste fausse,
//      raisons traduites (中文, EN, FR), lien invalide.
//   2. site/offres/ : offres anonymes (« Fournisseur partenaire »), date de mise à jour, recherche, trois langues.
// L'expiration et le remplacement sont testés en base (supabase/checks/08_listes.sql).
// Usage : (cd site && python3 -m http.server 8765) & node tools/test-listes-ui.mjs
import { readFileSync } from 'node:fs';
import { decode, mapRows, parseCSV } from '../supabase/functions/import-stock/parse.js';

const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
const SUPA = 'https://tuhbzziqyisdnqzfvtkh.supabase.co';
const TOKEN = 'a'.repeat(48);
const fixture = (n) => new URL('./fixtures/' + n, import.meta.url).pathname;
let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };

// ---------------------------------------------------------------- serveur simulé
const VENDOR = 'Vendeur de démonstration (fictif)';
const state = { imports: [], lots: new Map(), pending: null, external: [] };
const now = () => new Date().toISOString();

// Fichier envoyé au stockage : Playwright ne transmet pas le contenu d'un fichier multipart, seulement son nom ;
// le fichier de test du même nom est relu sur le disque.
function fileFromMultipart(buf) {
  const name = /filename="([^"]+)"/.exec(buf.toString('utf8'))[1];
  return readFileSync(fixture(name));
}

// Traitement d'un dépôt comme import-stock + apply_stock_import_batch + finish_stock_import (fichier complet).
function processUpload(path, bytes) {
  const name = path.split('/').pop();
  const parsed = mapRows(parseCSV(decode(new Uint8Array(bytes))));
  const imp = { id: 'IMP-' + (100 + state.imports.length), file_name: name, received_at: now(), processed_at: now(), withdrawn: 0, updated: 0, created: 0 };
  if (parsed.error) Object.assign(imp, { status: 'failed', error: parsed.error, rejected: 0, report: { rejected: [] } });
  else {
    const seen = new Set();
    for (const r of parsed.rows) {
      seen.add(r.sku);
      state.lots.has(r.sku) ? imp.updated++ : imp.created++;
      state.lots.set(r.sku, { ...r, confirmed_at: now() });
    }
    for (const [sku, l] of state.lots) if (!seen.has(sku) && l.qty > 0) { l.qty = 0; imp.withdrawn++; }
    Object.assign(imp, { status: 'done', rejected: parsed.rejected.length, report: { rejected: parsed.rejected } });
  }
  state.imports.unshift(imp);
}

async function listes(route) {
  const req = route.request(), path = new URL(req.url()).pathname.replace('/functions/v1/listes', '');
  const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' } });
  if (req.headers().authorization !== 'Bearer ' + TOKEN) return reply({ error: 'link_invalid' }, 401);
  const live = [...state.lots.values()].filter((l) => l.qty > 0);
  if (path === '/me') return reply({ name: VENDOR, currency: 'USD', ttl_days: 7, status: { live: live.length, to_reconfirm: 0, last_confirmed: live[0]?.confirmed_at || null } });
  if (path === '/upload-url') {
    const { file_name } = JSON.parse(req.postData() || '{}');
    state.pending = 'P1/20261102-090000-' + file_name.replace(/\.(\w+)$/, '-complet.$1');
    return reply({ signed_url: SUPA + '/storage/v1/object/upload/sign/stock-imports/x', path: state.pending, max_bytes: 52428800 });
  }
  if (path === '/imports') return reply(state.imports);
  return reply({ error: 'not_found' }, 404);
}

async function storage(route) {
  const req = route.request();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'PUT' } });
  processUpload(state.pending, fileFromMultipart(req.postDataBuffer()));
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"Key":"x"}' });
}

async function offers(route) {
  const u = new URL(route.request().url());
  const q = (u.searchParams.get('q') || '').toUpperCase().replace(/\s+/g, '');
  const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
  if (q.length && q.length < 3) return reply({ error: 'too_short' }, 422);
  const band = (x) => (x >= 100000 ? '100000+' : x >= 10000 ? '10000+' : x >= 1000 ? '1000+' : x >= 100 ? '100+' : '1+');
  // Réponse anonyme, comme public.partner_offers : ni nom, ni SKU, ni lien du vendeur.
  const list = [...state.lots.values()].filter((l) => l.qty > 0 && l.mpn.replace(/\s+/g, '').startsWith(q)).map((l) => ({
    mpn: l.mpn, manufacturer: l.mfr, supplier: 'partner', seller_category: null, source: 'broker', ship_from: 'HK',
    availability: band(l.qty), moq: l.moq, price_from: Math.min(l.price, ...Object.values(l.tiers)) * 1.1, updated_at: l.confirmed_at,
  }));
  return reply({ query: q, currency: u.searchParams.get('cur') || 'EUR', ttl_days: 7, offers: list.slice(0, 50) });
}

const browser = await chromium.launch();
async function newPage(width, opts = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, ...opts });
  const errors = [];
  // Les réponses 401 (lien invalide) et 422 (recherche trop courte) sont provoquées par le test : le navigateur les journalise.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|422)/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(SUPA + '/functions/v1/listes/**', listes);
  await page.route(SUPA + '/functions/v1/offers**', offers);
  await page.route(SUPA + '/storage/**', storage);
  await page.route(/^(?!http:\/\/localhost|https:\/\/tuhbzziqyisdnqzfvtkh\.supabase\.co)/, (r) => { state.external.push(r.request().url()); r.abort(); });
  return { page, errors };
}
const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

// ---------------------------------------------------------------- 1. dépôt par lien personnel
{
  const { page, errors } = await newPage(390);
  await page.goto(BASE + '/depot/lien/');
  await page.waitForSelector('#msg:not([hidden])');
  ok((await page.textContent('#msg')).includes('链接无效') && await page.isHidden('#upload-card'), 'sans lien : message, dépôt masqué');

  await page.goto(BASE + '/depot/lien/#k=' + 'b'.repeat(48));
  await page.waitForSelector('#msg:not([hidden])');
  ok((await page.textContent('#msg')).includes('链接无效'), 'lien inconnu : refusé');

  await page.goto(BASE + '/depot/lien/#k=' + TOKEN);
  await page.waitForSelector('#upload-card:not([hidden])');
  ok((await page.textContent('#org-name')) === VENDOR && (await page.textContent('#n-live')) === '0', 'lien valable : vendeur et compteur affichés');
  ok((await page.textContent('#ttl-text')).includes('7 天'), 'seuil de 7 jours expliqué');
  ok(await page.getAttribute('a[download]', 'href') === 'modele.csv', 'modèle téléchargeable');

  await page.setInputFiles('#file', fixture('liste-partenaire.csv'));
  await page.click('#send');
  await page.waitForFunction(() => /10 行通过/.test(document.getElementById('msg').textContent));
  ok((await page.textContent('#msg')).includes('0 行需修改'), 'liste de test : 10 lignes acceptées, aucune à corriger');
  ok((await page.textContent('#n-live')) === '10', 'liste de test : 10 offres en ligne');
  ok(await noScroll(page), '390 px : pas de défilement horizontal après le rapport');

  await page.setInputFiles('#file', fixture('liste-erreurs.csv'));
  await page.click('#send');
  await page.waitForFunction(() => /1 行通过/.test(document.getElementById('msg').textContent));
  const report = await page.textContent('#imports .imp:first-child');
  ok(report.includes('7 行') || (await page.textContent('#msg')).includes('7 行需修改'), 'liste fausse : 7 lignes à corriger');
  for (const [label, want] of [['quantité négative', '数量无效'], ['paliers non croissants', '数量须递增'], ['prix en hausse', '价格不得上涨'],
    ['MPN vide', '型号（mpn）为空'], ['prix nul', '价格无效'], ['palier sans prix', '价格阶梯不完整'], ['MOQ à 0', '最小起订量无效']]) {
    ok(report.includes(want), 'rapport 中文 : ' + label);
  }
  ok((await page.textContent('#n-live')) === '1', 'remplacement : 1 offre en ligne après la liste fausse');
  await page.click('[data-lang=en]');
  ok((await page.textContent('#imports .imp:first-child')).includes('Price breaks: quantities must increase'), 'rapport EN : raisons traduites');
  await page.click('[data-lang=fr]');
  const fr = await page.textContent('#imports .imp:first-child');
  ok(fr.includes('Quantité invalide') && fr.includes('Référence (mpn) vide') && fr.includes('Ligne'), 'rapport FR : raisons traduites');
  ok(await page.evaluate(() => document.documentElement.lang) === 'fr', 'langue de la page suivie');
  ok(await page.getAttribute('meta[name=robots]', 'content') === 'noindex, nofollow', 'page vendeur non indexée');
  ok(await noScroll(page), '390 px : pas de défilement horizontal');
  ok(errors.length === 0, 'page vendeur : aucune erreur console ' + errors.join(' | '));
  await page.close();
}

// Repartir de la liste de test complète pour l'écran acheteur.
processUpload('P1/liste-complet.csv', readFileSync(fixture('liste-partenaire.csv')));

// ---------------------------------------------------------------- 2. offres pour les acheteurs
for (const width of [1280, 390]) {
  const { page, errors } = await newPage(width, { locale: 'fr-FR' });
  await page.goto(BASE + '/offres/');
  await page.waitForSelector('#table:not([hidden])');
  const text = await page.textContent('main');
  ok((await page.$$('#rows tr')).length === 10, width + ' px : 10 offres sans recherche');
  ok((text.match(/Fournisseur partenaire/g) || []).length === 10, width + ' px : « Fournisseur partenaire » sur chaque offre');
  ok(!/Vendeur de démonstration|T-00\d\d|example\.com/.test(await page.content()), width + ' px : ni nom, ni SKU, ni lien du vendeur dans la page');
  ok(text.includes('MT41K128M16JT-107 IT:K') && text.includes(new Date().toLocaleDateString('fr-FR')), width + ' px : référence complète et date de mise à jour');
  ok(text.includes('7 jours'), width + ' px : retrait après 7 jours expliqué');
  ok(await noScroll(page), width + ' px : pas de défilement horizontal');
  if (width === 1280) {
    await page.fill('#q', 'ad8');
    await page.click('#form button');
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1);
    ok((await page.textContent('#count')).includes('AD8') && new URL(page.url()).searchParams.get('q') === 'ad8', 'recherche : une offre, adresse partageable');
    await page.fill('#q', 'AD');
    await page.click('#form button');
    await page.waitForSelector('#msg.err');
    ok((await page.textContent('#msg')).includes('3 caractères'), 'recherche trop courte : message');
    await page.fill('#q', '');
    await page.click('#form button');
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 10);
    await page.click('[data-lang=zh]');
    ok((await page.textContent('#rows')).includes('合作供应商') && (await page.textContent('h1')) === '我们的报价', '中文 : 合作供应商');
    await page.click('[data-lang=en]');
    ok((await page.textContent('#rows')).includes('Partner Supplier'), 'EN : Partner Supplier');
    ok(await page.getAttribute('meta[name=robots]', 'content') === 'noindex, nofollow', 'page acheteur non indexée');
    const mail = await page.getAttribute('#rows tr:first-child a', 'href');
    ok(mail.startsWith('mailto:contact@central.parts') && !/T-00|example/.test(decodeURIComponent(mail)), 'demande de prix vers Central.Parts, sans donnée du vendeur');
  }
  ok(errors.length === 0, width + ' px : aucune erreur console ' + errors.join(' | '));
  await page.close();
}

// Sans JavaScript : messages lisibles.
{
  const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 800 } });
  await page.goto(BASE + '/offres/');
  ok((await page.textContent('noscript')).includes('JavaScript') && (await page.textContent('h1')) === 'Nos offres', 'offres sans JavaScript : titre et message');
  await page.goto(BASE + '/depot/lien/');
  ok((await page.textContent('noscript')).includes('JavaScript'), 'dépôt sans JavaScript : message');
  await page.close();
}

ok(state.external.length === 0, 'aucune requête externe : ' + state.external.join(' '));
await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
