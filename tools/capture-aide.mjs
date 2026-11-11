// Captures d'écran de la page d'aide (site/depot/aide/img/), prises sur site/depot/ avec une fonction « depot » simulée
// et des données fictives : formulaire d'inscription (Hong Kong), dépôt de la licence, chargement du stock et rapport.
// À relancer quand l'espace fournisseur change.
// Usage : (cd site && python3 -m http.server 8765) & node tools/capture-aide.mjs
import { mkdirSync } from 'node:fs';

const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;
const BASE = process.env.BASE || 'http://localhost:8765';
const FN = 'https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/depot';
const OUT = new URL('../site/depot/aide/img/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// Société et dépôt fictifs.
const ORG = { org_id: 'ORG-0199', name: 'EXAMPLE ELECTRONICS LIMITED', alias: 'P-12345678', lang: 'zh', status: 'pending', role: 'admin', has_license: false, rejected_reason: null };
const IMPORT = { id: 'IMP-1', file_name: '20261103-090000-stock-complet-devise-USD.xlsx', status: 'done', created: 1806, updated: 0, rejected: 6,
  duplicates: 0, missing_date_code: 0, withdrawn: 0, received_at: '2026-11-03T09:00:00Z',
  report: { rejected: [{ line: 14, code: 'qty_invalid', reason: 'Quantité invalide' }, { line: 377, code: 'breaks_price_order', reason: 'Prix des paliers en hausse' }] } };

async function run(lang) {
  const state = { org: null, uploaded: false };
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: lang === 'zh' ? 'zh-CN' : 'en-GB' });
  await page.addInitScript((l) => { try { localStorage.setItem('cp-depot-lang', l); } catch (e) {} }, lang);
  await page.route(FN + '/**', (route) => {
    const req = route.request(), path = new URL(req.url()).pathname.replace('/functions/v1/depot', '');
    const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' } });
    if (path === '/qr/poll') return reply({ status: 'register', token: 'T0' });
    if (path === '/me') return reply({ org: state.org, token: 'T1' });
    if (path === '/register') { state.org = { ...ORG }; return reply({ org: state.org, token: 'T2' }); }
    if (path === '/imports') return reply(state.uploaded ? [IMPORT] : []);
    if (path === '/quality') return reply(state.uploaded ? { lots: 1806, completeness: 0.62, rates: {} } : {});
    if (path === '/contacts') return reply({ members: [{ label: null, role: 'admin', me: true, bound_at: '2026-11-03T08:00:00Z' }], invites: [] });
    if (path === '/requests') return reply([]);
    if (path === '/rfqs') return reply({ demands: [], score: null });
    return reply({});
  });
  await page.route(/^(?!http:\/\/localhost|https:\/\/tuhbzziqyisdnqzfvtkh)/, (r) => r.abort());
  const shot = async (sel, name) => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.locator(sel).first().screenshot({ path: `${OUT}${lang}-${name}.jpg`, type: 'jpeg', quality: 80 });
  };

  // 1. Formulaire d'inscription, société de Hong Kong.
  await page.goto(BASE + '/depot/?login=dl_' + 'a'.repeat(32));
  await page.waitForSelector('#v-register:not([hidden])');
  await page.fill('#r-name', 'EXAMPLE ELECTRONICS LIMITED');
  // Formulaire par profil (ADR 0034) : fabricant, sa marque, le numéro (l'un des deux suffit), la devise.
  // En-tête partagé collant : rendu statique pour qu'il n'apparaisse pas au milieu des captures d'éléments.
  await page.addStyleTag({ content: '.site-hdr{position:static!important}' });
  await page.check('input[name=r-profile][value=Manufacturer]');
  await page.fill('#r-brands-m', 'HKTC');
  await page.selectOption('#r-region', 'HK');
  await page.fill('#r-code', '12345678');
  await page.fill('#r-city', lang === 'zh' ? '香港' : 'Hong Kong');
  await page.fill('.ct[data-i="0"] [name=family_name]', lang === 'zh' ? '陈' : 'Chan');
  await page.fill('.ct[data-i="0"] [name=given_name]', lang === 'zh' ? '小姐' : 'Mary');
  await page.check('input[name=r-currency][value=USD]');
  await shot('#reg', 'inscription');

  // 2. Société en attente : dépôt de la licence.
  await page.click('#r-send');
  await page.waitForSelector('#lic:not([hidden])');
  await shot('#lic', 'licence');

  // 3. Chargement du stock (devise, liste complète), puis rapport.
  await page.selectOption('#cur', 'USD');
  await page.check('#complete');
  await shot('#form', 'stock');
  state.uploaded = true;
  await page.reload();
  await page.waitForSelector('#imports .imp, #imports li, #imports div:not(.muted)');
  await page.waitForTimeout(300);
  await shot('#imports-card', 'rapport');
  await browser.close();
}

for (const lang of ['zh', 'en']) await run(lang);
console.log('Captures enregistrées dans site/depot/aide/img/');
