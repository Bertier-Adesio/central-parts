// Parcours de la page fournisseur (site/depot/) dans Chromium, avec une fonction « depot » simulée :
// lien personnel reçu dans WeChat, inscription, licence, dépôt d'un fichier, invitation d'un collègue ; puis compte refusé.
// Usage : (cd site && python3 -m http.server 8765) & node tools/test-depot-ui.mjs
import { registrationNumberOk } from '../supabase/functions/_shared/depot.js';
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
const FN = 'https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/depot';
let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };

// État du serveur simulé.
const state = { org: null, contacts: { members: [{ label: null, role: 'admin', me: true, bound_at: '2026-10-31T10:00:00Z' }], invites: [] }, calls: [] };
const ORG = { org_id: 'ORG-0107', name: '深圳测试电子有限公司', alias: 'P-91350100M000100Y43', lang: 'zh', status: 'pending', role: 'admin', has_license: false, rejected_reason: null };

async function api(route) {
  const req = route.request(), path = new URL(req.url()).pathname.replace('/functions/v1/depot', '');
  const body = req.postData() ? JSON.parse(req.postData()) : {};
  state.calls.push(req.method() + ' ' + path);
  const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' } });
  if (path === '/qr/poll') return reply(body.scene === 'dl_' + 'a'.repeat(32) ? { status: 'register', token: 'T0' } : { status: 'consumed' });
  if (path === '/qr') return reply({ scene: 'dl_' + 'b'.repeat(32), expires_in: 300, image: BASE + '/assets/favicon.svg' });
  if (path === '/me') return reply({ org: state.org, token: 'T1' });
  if (path === '/register') {
    // Même règle que la base (app.registration_number_ok) ; région CN par défaut, comme register_supplier.
    if (!registrationNumberOk(body.region || 'CN', body.code)) return reply({ error: 'code_invalid' }, 422);
    state.org = { ...ORG }; state.registered = body;
    return reply({ org: state.org, token: 'T2' });
  }
  if (path === '/license-url') return reply({ signed_url: 'https://tuhbzziqyisdnqzfvtkh.supabase.co/storage/v1/upload/sign/x', path: 'ORG-0107/licence-1.jpg' });
  if (path === '/license') { state.org.has_license = true; return reply({ ok: true }); }
  if (path === '/upload-url') {
    if (!['USD', 'CNH', 'EUR', 'HKD'].includes(body.currency)) return reply({ error: 'currency' }, 422);
    state.uploadCurrency = body.currency;
    return reply({ signed_url: 'https://tuhbzziqyisdnqzfvtkh.supabase.co/storage/v1/upload/sign/y', path: 'ORG-0107/f-devise-' + body.currency + '.csv' });
  }
  if (path === '/imports') return reply(state.uploaded ? [{ id: 'IMP-1', file_name: 'f.csv', status: 'done', created: 3, updated: 0, rejected: 0, duplicates: 0, missing_date_code: 3, withdrawn: 0, received_at: '2026-10-31T10:05:00Z', report: { rejected: [], completeness: { lines: 3, manufacturer: 3, description: 2, datasheet: 3, package_case: 3, lifecycle: 0, eccn: 1, hts_code: 0, unknown_manufacturers: ['ACME Semi'] } }, currency: state.uploadCurrency, currency_used: { [state.uploadCurrency + '|upload']: 3 } }] : []);
  if (path === '/quality') return reply(state.uploaded ? { lots: 3, completeness: 0.571, rates: {} } : {});
  if (path === '/contacts') return reply(state.contacts);
  if (path === '/requests') return reply(state.requests || []);
  if (path === '/requests/answer') { state.answer = body; state.requests[0].status = body.ok ? 'confirmed' : 'unavailable'; return reply(state.requests[0]); }
  if (path === '/rfqs') return reply(state.rfqs || { demands: [], score: null });
  if (path === '/rfqs/answer') {
    state.rfqAnswer = body;
    if (body.ref === 'DEM-1043') return reply({ error: 'expired' }, 409);
    const d = state.rfqs.demands.find((x) => x.ref === body.ref);
    Object.assign(d, body.kind === 'quote' ? { response: 'quoted', my_net: body.price, my_currency: body.currency, my_lead_days: body.lead_days, my_date_code: body.date_code } : { response: 'declined' });
    return reply({ ...d, all_done: true });
  }
  if (path === '/invite') { state.contacts.invites.push({ label: body.label }); return reply({ link: 'https://central.parts/depot/?invite=' + 'c'.repeat(36) }); }
  return reply({ error: 'not_found' }, 404);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
const errors = [];
// Le 409 (réponse RFQ après l'échéance) est provoqué par le test : le navigateur le journalise.
page.on('console', (m) => { if (m.type() === 'error' && !/status of 409/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.route(FN + '/**', api);
await page.route('https://tuhbzziqyisdnqzfvtkh.supabase.co/storage/**', (r) => { if (r.request().url().endsWith('/y')) state.uploaded = true; return r.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' }); });
await page.route(/^(?!http:\/\/localhost|https:\/\/tuhbzziqyisdnqzfvtkh)/, (r) => { errors.push('requête externe : ' + r.request().url()); return r.abort(); });

// 0. Téléphone : indication du menu du compte (le QR code ne se scanne pas sur son propre écran) ; masquée sur ordinateur.
{
  await page.goto(BASE + '/depot/');
  await page.waitForSelector('#v-login:not([hidden])');
  ok(await page.isHidden('#menu-hint'), 'ordinateur : pas d\'indication du menu');
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.route(FN + '/**', api);
  await phone.route(/^(?!http:\/\/localhost|https:\/\/tuhbzziqyisdnqzfvtkh)/, (r) => { errors.push('requête externe : ' + r.request().url()); return r.abort(); });
  await phone.goto(BASE + '/depot/');
  await phone.waitForSelector('#v-login:not([hidden])');
  ok(await phone.isVisible('#menu-hint') && (await phone.textContent('#menu-hint')).includes('「供应商」→「上传库存」'), 'téléphone : indication du menu « 供应商 › 上传库存 »');
  await phone.click('#lang');
  ok((await phone.textContent('#menu-hint')).includes('to receive your login link'), 'téléphone : indication en anglais');
  ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'téléphone : pas de défilement horizontal');
  await phone.close();
}

// 1. Lien personnel reçu dans WeChat : compte sans société → formulaire d'inscription.
await page.goto(BASE + '/depot/?login=dl_' + 'a'.repeat(32));
await page.waitForSelector('#v-register:not([hidden])');
ok(new URL(page.url()).search === '', 'lien personnel retiré de l\'adresse après connexion');
ok(await page.isVisible('text=注册公司'), 'formulaire d\'inscription en chinois');

// 2. Pays / région obligatoire, puis numéro mal saisi : refusés dans la page, sans appel au serveur.
await page.fill('#r-name', '深圳测试电子有限公司');
await page.fill('#r-code', '91350100M000100Y44');
await page.fill('#r-city', '深圳');
await page.selectOption('#r-profile', 'Distributor');
await page.click('#r-send');
ok(await page.evaluate(() => !document.getElementById('r-region').checkValidity()) && !state.calls.includes('POST /register'), 'pays / région obligatoire : envoi bloqué');
ok((await page.textContent('#r-code-label')) === '统一社会信用代码', 'sans choix : libellé du 统一社会信用代码');
await page.selectOption('#r-region', 'CN');
await page.click('#r-send');
ok((await page.textContent('#msg')).includes('统一社会信用代码有误'), 'numéro invalide signalé tout de suite');
ok(!state.calls.includes('POST /register'), 'numéro invalide : aucun appel au serveur');

// 3. Inscription : la société est en attente, la licence est demandée.
await page.fill('#r-code', '91350100m000100y43');
await page.selectOption('#r-currency', 'CNH');
await page.click('#r-send');
await page.waitForSelector('#v-app:not([hidden])');
ok(state.registered.code === '91350100M000100Y43' && state.registered.region === 'CN' && state.registered.currency === 'CNH' && state.registered.profile === 'Distributor', 'inscription envoyée : région CN, numéro en majuscules, devise, type');
ok(await page.isVisible('#lic') && (await page.textContent('#org-alias')) === '审核中', 'société en attente : licence demandée, statut « 审核中 »');

// 4. Licence (photo de téléphone sans extension) : le statut passe à « en cours d'examen ».
await page.setInputFiles('#lic-file', { name: 'image', mimeType: 'image/jpeg', buffer: Buffer.from('jpg') });
await page.click('#lic-send');
await page.waitForSelector('#lic', { state: 'hidden' });
ok(state.calls.includes('POST /license') && (await page.textContent('#status')).includes('审核中'), 'licence envoyée, société en cours d\'examen');

// 5. Dépôt d'un fichier de stock pendant l'examen.
await page.setInputFiles('#file', { name: '库存.csv', mimeType: 'text/csv', buffer: Buffer.from('mpn,quantity\nNE555DR,10\n') });
await page.click('#send');
ok((await page.textContent('#msg')).includes('请选择报价币种') && !state.calls.includes('POST /upload-url'), 'devise non choisie : dépôt refusé dans la page');
await page.selectOption('#cur', 'USD');
await page.click('#send');
await page.waitForSelector('.imp');
ok(state.uploadCurrency === 'USD', 'devise choisie transmise au dépôt');
ok((await page.textContent('#imports')).includes('币种：USD (上传时选择)'), 'rapport : devise et provenance affichées');
ok((await page.textContent('#imports')).includes('新增 3'), 'dépôt pendant l\'examen : rapport affiché');
await page.waitForSelector('#quality:not([hidden])');
ok((await page.textContent('#imports')).includes('资料完整度：品牌（已识别）100 % · 描述 67 % · 规格书 100 % · 封装 100 % · 生命周期 0 % · ECCN 33 % · HS 编码 0 %'),
  'rapport : complétude des fiches produit, champ par champ (ADR 0024)');
ok((await page.textContent('#imports')).includes('未识别的品牌') && (await page.textContent('#imports')).includes('ACME Semi'), 'rapport : marques non reconnues signalées');
ok((await page.textContent('#quality')) === '您的资料完整度（在售库存）：57 %', 'complétude globale de la société affichée');
ok((await page.textContent('[data-t=tpl]')).includes('今后也将计入供应商评分'), 'aide : champs recommandés, comptés plus tard dans la notation');

// 6. Collègues : l'administrateur génère une invitation.
ok(await page.isVisible('#team'), 'administrateur : section « 同事 » visible');
await page.fill('#inv-label', '小王');
await page.click('#inv button[type=submit]');
await page.waitForSelector('#inv-out:not([hidden])');
ok((await page.textContent('#inv-link')).includes('?invite='), 'lien d\'invitation affiché');
ok((await page.textContent('#team-list')).includes('小王'), 'invitation en cours listée');

// 7. Anglais, et pas de défilement horizontal à 390 px.
await page.click('#lang');
ok((await page.textContent('h1')) === 'Supplier centre' && (await page.textContent('#org-alias')) === 'Under review', 'bascule en anglais');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'pas de défilement horizontal à 390 px');

// 7 bis. Société validée : demande d'achat reçue, confirmée depuis la page.
state.org = { ...ORG, status: 'validated', alias: 'V-9', has_license: true };
state.requests = [{ ref: 'PR-0001', status: 'submitted', mpn: 'NE555DR', qty: 2000, unit_price: 0.8, currency: 'CNH', delivery_country: 'FR' }];
await page.click('#lang');
await page.reload();
await page.waitForSelector('#req-card:not([hidden])');
ok((await page.textContent('#req-list')).includes('PR-0001') && !(await page.textContent('#req-list')).match(/@|Atelier/), 'demande d\'achat reçue, sans l\'acheteur');
await page.click('#req-list [data-ok="1"]');
await page.waitForFunction(() => !document.querySelector('#req-list [data-ans]'));
ok(state.answer.ref === 'PR-0001' && state.answer.ok === true && (await page.textContent('#req-list')).includes('已确认'), 'demande confirmée depuis la page');

// 7 ter. RFQ des plateformes : liste, taux propre, réponse avant l'échéance, refus après.
{
  const soon = new Date(Date.now() + 20 * 3600e3).toISOString();
  state.requests = [];
  state.rfqs = { score: { received: 4, quoted: 2, declined: 1, expired: 1, treatment_rate: 0.75 }, demands: [
    { ref: 'DEM-1042', mpn: 'NE555DR', qty: 2000, dc_min: '2420', ship_to: 'DE', status: 'auction', response: 'pending', deadline_at: soon },
    { ref: 'DEM-1043', mpn: 'LM358DR', qty: 500, ship_to: 'FR', status: 'auction', response: 'pending', deadline_at: soon },
    { ref: 'DEM-1001', mpn: 'TL431', qty: 100, ship_to: 'FR', status: 'offers', response: 'expired', deadline_at: '2026-10-30T09:00:00Z' },
  ] };
  await page.reload();
  await page.waitForSelector('#rfq-card:not([hidden])');
  const txt = await page.textContent('#rfq-card');
  ok(txt.includes('DEM-1042') && txt.includes('最低批号 2420') && txt.includes('北京时间'), 'RFQ : demande, date code minimum, échéance (heure de Pékin)');
  ok(txt.includes('您的处理率：75 %') && txt.includes('逾期 1'), 'RFQ : taux de traitement du fournisseur seulement');
  ok(!/Adesio|Plateforme|ADS-|client/i.test(txt), 'RFQ : ni plateforme, ni référence client');
  ok((await page.$$('form[data-rfq]')).length === 2 && txt.includes('已逾期'), 'RFQ : formulaire seulement pour les demandes ouvertes');
  await page.fill('form[data-rfq="DEM-1042"] [name=price]', '0,52');
  await page.selectOption('form[data-rfq="DEM-1042"] [name=currency]', 'USD');
  await page.fill('form[data-rfq="DEM-1042"] [name=lead]', '7');
  await page.fill('form[data-rfq="DEM-1042"] [name=dc]', '2425');
  await page.click('form[data-rfq="DEM-1042"] [type=submit]');
  await page.waitForFunction(() => !document.querySelector('form[data-rfq="DEM-1042"]'));
  ok(JSON.stringify(state.rfqAnswer) === JSON.stringify({ ref: 'DEM-1042', kind: 'quote', price: 0.52, currency: 'USD', lead_days: 7, date_code: '2425' }), 'RFQ : prix envoyé (virgule acceptée) ' + JSON.stringify(state.rfqAnswer));
  ok((await page.textContent('#rfq-card')).includes('您的报价：0.52 USD，交期 7 天，批号 2425'), 'RFQ : prix affiché après envoi');
  await page.click('[data-none="DEM-1043"]');
  await page.waitForSelector('[data-rfq-err="DEM-1043"]:not([hidden])');
  ok((await page.textContent('[data-rfq-err="DEM-1043"]')).includes('已过截止时间'), 'RFQ : réponse après l\'échéance refusée, motif affiché');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'RFQ : pas de défilement horizontal à 390 px');
  await page.click('#lang');
  ok((await page.textContent('#rfq-card')).includes('Platform RFQs') && (await page.textContent('#rfq-card')).includes('Your handling rate: 75 %'), 'RFQ : anglais');
  await page.click('#lang');
}

// 8. Société refusée : motif affiché, dépôt masqué.
state.org = { ...ORG, status: 'rejected', has_license: true, rejected_reason: '营业执照不清晰' };
await page.reload();
await page.waitForSelector('#v-app:not([hidden])');
ok((await page.textContent('#status')).includes('营业执照不清晰') && await page.isHidden('#form'), 'société refusée : motif affiché, dépôt masqué');

// 9. Lien personnel déjà utilisé : retour au QR code.
await page.evaluate(() => sessionStorage.clear());
await page.goto(BASE + '/depot/?login=dl_' + 'd'.repeat(32));
await page.waitForSelector('#v-login:not([hidden])');
ok(await page.isVisible('#qr'), 'lien déjà utilisé : QR code proposé');

// 10. Société de Hong Kong : numéro de 15 caractères, libellé et aide adaptés, en chinois puis en anglais.
state.org = null; state.registered = null; state.calls = [];
for (const width of [390, 1280]) {
  const p2 = await browser.newPage({ viewport: { width, height: 900 }, locale: 'zh-CN' });
  p2.on('pageerror', (e) => errors.push(String(e)));
  await p2.route(FN + '/**', api);
  await p2.route(/^(?!http:\/\/localhost|https:\/\/tuhbzziqyisdnqzfvtkh)/, (r) => { errors.push('requête externe : ' + r.request().url()); return r.abort(); });
  await p2.goto(BASE + '/depot/?login=dl_' + 'a'.repeat(32));
  await p2.waitForSelector('#v-register:not([hidden])');
  await p2.fill('#r-name', 'HK TEST COMPANY LIMITED');
  await p2.fill('#r-city', 'Hong Kong');
  await p2.selectOption('#r-profile', 'Manufacturer');
  await p2.selectOption('#r-region', 'CN');
  await p2.fill('#r-code', '123456789012345');
  await p2.click('#r-send');
  ok((await p2.textContent('#msg')).includes('统一社会信用代码有误') && !state.calls.includes('POST /register'), width + ' px : 15 caractères refusés pour la Chine continentale');
  await p2.selectOption('#r-region', 'HK');
  ok((await p2.textContent('#r-code-label')) === '公司注册号码' && (await p2.textContent('#r-code-hint')).includes('香港商业登记证') && await p2.getAttribute('#r-code', 'maxlength') === '30', width + ' px : Hong Kong : libellé, aide et longueur adaptés');
  await p2.click('#lang');
  ok((await p2.textContent('#r-code-label')) === 'Company registration number' && (await p2.textContent('#r-code-hint')).includes('Hong Kong business registration'), width + ' px : libellé et aide en anglais');
  await p2.fill('#r-code', '12');
  await p2.click('#r-send');
  ok((await p2.textContent('#msg')).includes('Invalid registration number'), width + ' px : numéro trop court refusé, message adapté');
  ok(await p2.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + ' px : pas de défilement horizontal');
  if (width === 1280) {
    await p2.fill('#r-code', ' 1234 5678  90123 ');
    await p2.click('#r-send');
    await p2.waitForSelector('#v-app:not([hidden])');
    ok(state.registered.region === 'HK' && state.registered.code === '1234 5678 90123', 'Hong Kong : inscription envoyée, région HK, numéro normalisé');
  }
  await p2.close();
  state.org = null; state.calls = [];
}

ok(errors.length === 0, 'aucune erreur ni requête externe : ' + errors.join(' | '));
await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
