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
const OP_TOKEN = 'c'.repeat(48); // lien ouvert depuis le back office (accès opérateur, 8 heures)
const OP_EXPIRES = '2026-11-04T18:30:00Z';
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
  // Devise et provenance, comme stock_imports.currency_used : en-têtes price-usd-N → lue dans le fichier.
  const okRows = (imp.created || 0) + (imp.updated || 0);
  imp.currency_used = okRows ? { 'USD|file': okRows } : {};
  state.imports.unshift(imp);
}

async function listes(route) {
  const req = route.request(), path = new URL(req.url()).pathname.replace('/functions/v1/listes', '');
  const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' } });
  const operator = req.headers().authorization === 'Bearer ' + OP_TOKEN;
  if (req.headers().authorization !== 'Bearer ' + TOKEN && !operator) return reply({ error: 'link_invalid' }, 401);
  const live = [...state.lots.values()].filter((l) => l.qty > 0);
  if (path === '/me') return reply({ name: VENDOR, currency: 'USD', ttl_days: 7, status: { live: live.length, to_reconfirm: 0, last_confirmed: live[0]?.confirmed_at || null },
    operator, expires_at: operator ? OP_EXPIRES : null });
  if (path === '/upload-url') {
    const { file_name, currency } = JSON.parse(req.postData() || '{}');
    if (!['USD', 'CNH', 'EUR', 'HKD'].includes(currency)) return reply({ error: 'currency' }, 422);
    state.currency = currency;
    state.pending = 'P1/20261102-090000-' + file_name.replace(/\.(\w+)$/, '-complet-devise-' + currency + '.$1');
    return reply({ signed_url: SUPA + '/storage/v1/object/upload/sign/stock-imports/x', path: state.pending, max_bytes: 52428800 });
  }
  if (path === '/imports') return reply(state.imports);
  if (path === '/reconfirm') {
    if (!live.length) return reply({ error: 'no_stock' }, 422);
    for (const l of live) l.confirmed_at = now();
    state.reconfirmed = (state.reconfirmed || 0) + 1;
    return reply({ lots: live.length, ttl_days: 7, expires_at: new Date(Date.now() + 7 * 864e5).toISOString() });
  }
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
  const mfr = (u.searchParams.get('mfr') || '').toUpperCase();
  const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
  if (q.length && q.length < 3) return reply({ error: 'too_short' }, 422);
  const band = (x) => (x >= 100000 ? '100000+' : x >= 10000 ? '10000+' : x >= 1000 ? '1000+' : x >= 100 ? '100+' : '1+');
  // Réponse anonyme, comme public.partner_offers : ni nom, ni SKU, ni lien du vendeur.
  const base = [...state.lots.values()].filter((l) => l.qty > 0 && l.mpn.replace(/\s+/g, '').startsWith(q));
  // Boutons des fabricants : comptés sur la recherche, sans le filtre fabricant (comme partner_offers).
  const counts = {};
  for (const l of base) counts[l.mfr] = (counts[l.mfr] || 0) + 1;
  const manufacturers = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, offers]) => ({ name, offers }));
  const list = base.filter((l) => !mfr || l.mfr.toUpperCase() === mfr).map((l) => ({
    mpn: l.mpn, manufacturer: l.mfr, supplier: 'partner', seller_category: null, source: 'broker', ship_from: 'HK', currency: 'EUR',
    availability: band(l.qty), moq: l.moq, price_from: Math.min(l.price, ...Object.values(l.tiers)) * 1.1,
    // Prix 1KU : palier qui couvre 1 000 pièces (comme app.lot_price_for), marge comprise.
    price_1k: (Object.entries(l.tiers).filter(([q]) => +q <= 1000).sort((a, b) => b[0] - a[0])[0]?.[1] ?? l.price) * 1.1, updated_at: l.confirmed_at,
  }));
  // Prix convertis en euros au taux de la BCE (migration 20261103000025), date du taux.
  // Totaux (migration 20261106000036) : références distinctes et pièces, sur toutes les offres trouvées.
  return reply({ query: q, currency: 'EUR', rates_at: '2026-11-03T15:00:00Z', ttl_days: 7, ttl_days_manufacturer: 14, offers: list.slice(0, 50),
    manufacturer: mfr || null, manufacturers,
    total_refs: new Set(list.map((o) => o.mpn)).size, total_offers: q ? list.length : 1863, total_units: list.reduce((s, o) => s + (state.lots.get(o.sku)?.qty || 0), 0) || 245300000 });
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
  ok(await page.isHidden('#operator'), 'lien du vendeur : pas de bandeau opérateur');

  await page.setInputFiles('#file', fixture('liste-partenaire.csv'));
  await page.click('#send');
  ok((await page.textContent('#msg')).includes('请选择报价币种') && !state.pending, 'devise non choisie : dépôt refusé dans la page, rien n\'est envoyé');
  await page.selectOption('#cur', 'USD');
  await page.click('#send');
  await page.waitForFunction(() => /10 行通过/.test(document.getElementById('msg').textContent));
  ok(state.currency === 'USD' && state.pending.includes('-devise-USD.'), 'devise choisie transmise au dépôt');
  ok((await page.textContent('#imports .imp:first-child')).includes('币种：USD (读取自文件)'), 'rapport : devise et provenance affichées');
  ok((await page.textContent('#msg')).includes('0 行需修改'), 'liste de test : 10 lignes acceptées, aucune à corriger');
  await page.waitForFunction(() => document.getElementById('n-live').textContent === '10', null, { timeout: 5000 }).catch(() => {});
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
  // Le compteur se met à jour après le message d'import (second appel) : on l'attend, sans changer la valeur attendue.
  await page.waitForFunction(() => document.getElementById('n-live').textContent === '1', null, { timeout: 5000 }).catch(() => {});
  ok((await page.textContent('#n-live')) === '1', 'remplacement : 1 offre en ligne après la liste fausse');
  await page.click('[data-lang=en]');
  ok((await page.textContent('#imports .imp:first-child')).includes('Price breaks: quantities must increase'), 'rapport EN : raisons traduites');
  await page.click('[data-lang=fr]');
  const fr = await page.textContent('#imports .imp:first-child');
  ok(fr.includes('Quantité invalide') && fr.includes('Référence (mpn) vide') && fr.includes('Ligne'), 'rapport FR : raisons traduites');
  ok(await page.evaluate(() => document.documentElement.lang) === 'fr', 'langue de la page suivie');
  // Reconfirmation sans nouveau fichier (ADR 0025).
  await page.click('#reconfirm');
  await page.waitForFunction(() => /Reconfirmé/.test(document.getElementById('msg').textContent));
  ok(state.reconfirmed === 1 && (await page.textContent('#msg')).includes('1 offres visibles pendant 7 jours'), 'stock inchangé : reconfirmé en un geste');
  ok(await page.getAttribute('meta[name=robots]', 'content') === 'noindex, nofollow', 'page vendeur non indexée');
  ok(await noScroll(page), '390 px : pas de défilement horizontal');
  ok(errors.length === 0, 'page vendeur : aucune erreur console ' + errors.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------- 1 bis. lien ouvert depuis le back office
{
  const { page, errors } = await newPage(390);
  await page.goto(BASE + '/depot/lien/#k=' + OP_TOKEN);
  await page.waitForSelector('#upload-card:not([hidden])');
  const banner = () => page.textContent('#operator');
  ok(await page.isVisible('#operator') && (await banner()).includes('运营人员') && (await page.textContent('#org-name')) === VENDOR,
    'accès opérateur : bandeau affiché, dépôt du fournisseur ouvert');
  await page.click('[data-lang=en]');
  ok((await banner()).includes('Central.Parts operator access'), 'accès opérateur : bandeau EN');
  await page.click('[data-lang=fr]');
  ok((await banner()).includes('Accès opérateur Central.Parts') && (await banner()).includes('2026'), 'accès opérateur : bandeau FR et échéance');
  ok(await noScroll(page), 'accès opérateur, 390 px : pas de défilement horizontal');
  ok(errors.length === 0, 'accès opérateur : aucune erreur console ' + errors.join(' | '));
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
  ok(text.includes('7 jours') && text.includes('14 jours pour un fabricant'), width + ' px : retrait après 7 jours, 14 pour un fabricant, expliqué');
  ok((text.match(/prix 1 k :/g) || []).length === 10 && (text.match(/à partir de/g) || []).length === 10, width + ' px : « à partir de » et prix 1KU sur chaque offre');
  ok(/€/.test(text) && !/\$US/.test(text) && !(await page.$('#cur')), width + ' px : prix en euros, sans choix de devise');
  ok(text.includes('Taux de référence de la BCE du 03/11/2026') && text.includes('convertis au taux de référence de la BCE'), width + ' px : taux de la BCE et sa date');
  ok(await noScroll(page), width + ' px : pas de défilement horizontal');
  const totals = (await page.textContent('#totals')).replace(/[\u202f\u00a0]/g, ' ');
  ok(totals.includes('10') && totals.includes('références en ligne') && totals.includes('pièces en stock'), width + ' px : nombre de références et taille de l\'inventaire');
  ok((await page.textContent('#count')).includes('10 offres affichées sur 1') , width + ' px : offres affichées sur le total');
  if (width === 1280) {
    await page.fill('#q', 'ad8');
    await page.click('#form button');
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1);
    ok((await page.textContent('#count')).includes('AD8') && new URL(page.url()).searchParams.get('q') === 'ad8', 'recherche : une offre, adresse partageable');
    ok((await page.textContent('#totals')).includes('référence(s) pour « AD8 »') && (await page.textContent('#n-refs')) === '1', 'recherche : totaux de la recherche');
    // Recherche rapide par fabricant (migration 20261106000038).
    await page.fill('#q', '');
    await page.click('#form button');
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 10);
    const chips = await page.$$eval('#mfrs button[data-m]', (b) => b.map((x) => x.getAttribute('data-m')));
    ok(chips[0] === '' && chips.length > 2, 'fabricants : boutons « Tous » et un par fabricant présent');
    const pick = chips[1];
    await page.click('#mfrs button[data-m="' + pick + '"]');
    await page.waitForFunction((m) => document.querySelector('#mfrs button[aria-pressed=true]').getAttribute('data-m') === m, pick);
    const mfrs = await page.$$eval('#rows .mfr', (d) => d.map((x) => x.textContent));
    ok(mfrs.length > 0 && mfrs.every((m) => m === pick) && new URL(page.url()).searchParams.get('mfr') === pick, 'fabricant choisi : offres filtrées, adresse partageable');
    await page.click('#mfrs button[data-m=""]');
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 10);
    ok(!new URL(page.url()).searchParams.get('mfr'), '« Tous » : filtre retiré');
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
    // « Demander » est devenu « Ajouter au panier » (ADR 0028) : plus de lien mailto.
    ok((await page.$$('#rows button.add')).length === 10 && (await page.$$('#rows a[href^="mailto:"]')).length === 0, 'bouton « Add to cart » sur chaque offre, plus de mailto');
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
