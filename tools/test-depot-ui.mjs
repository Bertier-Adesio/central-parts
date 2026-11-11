import zlib from 'node:zlib';
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
// En-tête partagé (tools/build-header.mjs) : langue dans la barre (bureau) ou dans le menu (sous 1140 px).
async function setLang(page, l) {
  const bar = page.locator('.sh-tools > .sh-lang a[hreflang=' + l + ']');
  if (await bar.isVisible()) return bar.click();
  await page.click('.sh-menu summary');
  await page.click('.sh-lang-m a[hreflang=' + l + ']');
}
const toggleLang = async (page) => setLang(page, (await page.evaluate(() => document.documentElement.lang)).startsWith('zh') ? 'en' : 'zh');

// État du serveur simulé.
// Logos fictifs, en mémoire : PNG 256 × 256 (transparent) et image de 1 × 1 pixel.
const png = (w, h) => {
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const PNG_256 = png(256, 256);
const JPG_1PX = png(1, 1);   // contenu PNG présenté comme un JPEG : le navigateur le lit d'après son contenu
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
    // Mêmes règles que la base (register_supplier, ADR 0034) : photo OU numéro ; numéro contrôlé selon la région.
    if (!body.code && !body.license_path) return reply({ error: 'verification' }, 422);
    if (!body.contacts?.[0]?.family_name && !body.contacts?.[0]?.given_name) return reply({ error: 'fields', field: 'contact' }, 422);
    if (body.code && !registrationNumberOk(body.region || 'CN', body.code)) return reply({ error: 'code_invalid' }, 422);
    const missing = [!body.license_path && 'license', !body.code && 'number', !body.region && 'region', !body.city && 'city',
      ['Manufacturer', 'Distributor'].includes(body.profile) && !body.brands && 'brands', !body.website && 'website', !body.wecom && 'wecom',
      !body.logo_path && 'logo', !body.contacts.some((c) => c.phone || c.wechat || c.email) && 'contact'].filter(Boolean);
    state.org = { ...ORG, has_license: !!body.license_path, has_code: !!body.code, profile: body.profile,
      signup: { missing, city: body.city, region: body.region, brands: body.brands, website: body.website, wecom: body.wecom, has_logo: !!body.logo_path } };
    state.registered = body;
    return reply({ org: state.org, token: 'T2' });
  }
  // Compléter sa fiche (supplier_signup_save) : après l'approbation, nom et numéro ignorés.
  if (path === '/signup') {
    state.signupSaved = body;
    const g = state.org.signup;
    if (body.city) g.city = body.city;
    if (body.website) g.website = body.website;
    if (body.wecom) g.wecom = body.wecom;
    if (body.logo_path) { if (!/^ORG-0107\/logo-/.test(body.logo_path)) return reply({ error: 'fields', field: 'logo' }, 422); g.has_logo = true; g.missing = g.missing.filter((k) => k !== 'logo'); }
    g.missing = g.missing.filter((k) => !(k === 'city' && body.city) && !(k === 'website' && body.website) && !(k === 'wecom' && body.wecom));
    return reply(state.org);
  }
  // Pièces déposées avant l'inscription (dossier du compte).
  if (path === '/doc-url') {
    (state.docs ||= []).push(body.kind);
    if (body.kind === 'logo' && !/\.(png|jpe?g|webp)$/i.test(body.file_name)) return reply({ error: 'format' }, 422);
    return reply({ signed_url: 'https://tuhbzziqyisdnqzfvtkh.supabase.co/storage/v1/upload/sign/x',
      path: 'pending/' + 'c'.repeat(32) + '/' + body.kind + '-20261111-090000.' + (body.kind === 'logo' ? 'png' : 'jpg') });
  }
  if (path === '/logo-url') {
    if (!/\.(png|jpe?g|webp)$/i.test(body.file_name)) return reply({ error: 'logo_format' }, 422);
    state.logoUrl = body.file_name;
    return reply({ signed_url: 'https://tuhbzziqyisdnqzfvtkh.supabase.co/storage/v1/upload/sign/x', path: 'ORG-0107/logo-20261111-100000.png' });
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
  if (path === '/offers-status') return reply(state.uploaded ? { live: state.expired ? 0 : 3, to_reconfirm: state.expired ? 3 : 0, ttl_days: 14, expires_at: '2026-11-17T02:06:00Z', last_confirmed: '2026-11-03T02:06:00Z', updates: { month_days: 2, days_30: 2, last_update_at: '2026-11-03T02:06:00Z' } } : { live: 0, to_reconfirm: 0, ttl_days: 14 });
  if (path === '/reconfirm') { state.reconfirmed = (state.reconfirmed || 0) + 1; state.expired = false; return reply({ lots: 3, ttl_days: 14, expires_at: '2026-11-18T08:00:00Z' }); }
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
  // Recherches payantes : inscription comme broker volontaire et réponses (ADR 0033).
  if (path === '/sourcing') return reply(state.src || { eligible: false, volunteer: null, requests: [] });
  if (path === '/sourcing/join') {
    state.srcJoin = body;
    state.src.volunteer = { active: body.on, labs: body.labs, joined_at: '2026-11-09T10:00:00Z', left_at: body.on ? null : '2026-11-09T11:00:00Z' };
    return reply(state.src);
  }
  if (path === '/sourcing/answer') {
    state.srcAnswer = body;
    if (body.ref === 'SRC-0031') return reply({ error: 'closed' }, 409);
    const r = state.src.requests.find((x) => x.ref === body.ref);
    if (body.kind === 'quote') { r.response = 'quoted'; r.my_offers.push({ id: 'SOF-0009', net: body.price, currency: body.currency, lead_days: body.lead_days, date_code: body.date_code, qty: body.qty }); }
    else r.response = 'declined';
    return reply({ ref: body.ref, kind: body.kind, on_time: true });
  }
  if (path === '/invite') { state.contacts.invites.push({ label: body.label }); return reply({ link: 'https://central.parts/depot/?invite=' + 'c'.repeat(36) }); }
  // Fiche société et fabricants (migration 20261106000035), comme supplier_company et suivantes.
  const co = state.company ||= { org_id: 'ORG-0107', name: ORG.name, can_edit: true, founded_year: null, website: null, about: {}, hq_city: null, staff: null,
    certifications: [], languages: [], payment_methods: [], payment_terms: null, min_order_usd: null, contacts: [], manufacturers: [] };
  if (path === '/company' && req.method() === 'GET') return reply(co);
  if (!co.can_edit && /^\/(company|manufacturer)/.test(path)) return reply({ error: 'forbidden' }, 403);
  if (path === '/company') {
    const f = body.profile || {};
    if (f.website && !/^https?:\/\//.test(f.website)) return reply({ error: 'invalid', detail: 'Site web : adresse http(s) attendue' }, 422);
    for (const k of ['founded_year', 'staff', 'min_order_usd']) if (k in f) co[k] = f[k] === '' ? null : Number(f[k]);
    for (const k of ['website', 'hq_city', 'payment_terms']) if (k in f) co[k] = f[k] || null;
    for (const k of ['certifications', 'languages', 'payment_methods']) if (k in f) co[k] = f[k];
    if (f.about) co.about = Object.fromEntries(Object.entries(f.about).filter(([, v]) => v));
    state.companySaved = f;
    return reply(co);
  }
  if (path === '/company/contact') {
    const c = { ...body.contact, id: body.contact.id || 'CTC-000' + (co.contacts.length + 1), email: (body.contact.email || '').toLowerCase() || null };
    co.contacts = co.contacts.filter((x) => x.id !== c.id).concat(c);
    return reply(co);
  }
  if (path === '/company/contact/delete') { co.contacts = co.contacts.filter((x) => x.id !== body.id); return reply(co); }
  if (path === '/manufacturer/consent') {
    const m = co.manufacturers.find((x) => x.id === body.id);
    m.consent_at = body.on ? new Date().toISOString() : null;
    return reply(co);
  }
  if (path === '/manufacturer/propose') {
    state.proposal = body;
    co.manufacturers.find((x) => x.id === body.id).pending = true;
    return reply(co);
  }
  return reply({ error: 'not_found' }, 404);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
const errors = [];
// Le 409 (réponse RFQ après l'échéance) et le 422 (site web invalide) sont provoqués par le test : le navigateur les journalise.
page.on('console', (m) => { if (m.type() === 'error' && !/status of (409|422)/.test(m.text())) errors.push(m.text()); });
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
  await toggleLang(phone);
  ok((await phone.textContent('#menu-hint')).includes('to receive your login link'), 'téléphone : indication en anglais');
  ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'téléphone : pas de défilement horizontal');
  await phone.close();
}

// 1. Lien personnel reçu dans WeChat : compte sans société → formulaire d'inscription.
await page.goto(BASE + '/depot/?login=dl_' + 'a'.repeat(32));
await page.waitForSelector('#v-register:not([hidden])');
ok(new URL(page.url()).search === '', 'lien personnel retiré de l\'adresse après connexion');
ok(await page.isVisible('text=注册公司'), 'formulaire d\'inscription en chinois');

// 2. Inscription par profil (ADR 0034) : on demande tout, on ne bloque presque sur rien.
ok((await page.$$eval('input[name=r-profile]', (r) => r.map((x) => x.value).join(','))) === 'Manufacturer,Distributor,Spot', '3 profils proposés');
ok((await page.$$('#reg .req')).length === 5, 'cinq marques « 必填 » : nom, profil, pièce, contact principal, devise');
ok((await page.textContent('#reg')).includes('资料越完整，审核越快'), 'ligne d\'encouragement sous le titre');
ok(await page.isVisible('#r-city') && await page.isVisible('#r-web') && await page.isVisible('#r-wecom') && await page.isVisible('#r-region'), 'ville, site web, WeChat pro et région demandés');
ok(!(await page.$$eval('input[name=r-currency]', (r) => r.some((x) => x.checked))), 'devise : aucune valeur présélectionnée');
ok(await page.isHidden('.ct.extra[data-i="1"]') && await page.isVisible('#r-add'), 'contacts supplémentaires repliés derrière « + 添加联系人 »');
ok((await page.textContent('#r-count')).startsWith('必填 0/5') && (await page.textContent('#r-count')).includes('还缺：公司全称'), 'compteur des champs obligatoires : 0/5 et ce qui manque');
ok(await page.isVisible('.ct[data-i="0"] [name=phone]') && await page.isHidden('.ct[data-i="0"] [name=email]'), 'contact principal : téléphone visible, poste, WeChat et e-mail repliés derrière « 更多 »');
await page.click('#r-add'); await page.click('#r-add'); await page.click('#r-add');
ok(await page.isVisible('.ct.extra[data-i="3"]') && await page.isHidden('#r-add'), '3 contacts supplémentaires au plus');
await page.fill('#r-name', '深圳测试电子有限公司');
ok((await page.textContent('#r-count')).startsWith('必填 1/5'), 'compteur mis à jour pendant la saisie');
await page.click('#r-send');
ok((await page.textContent('#msg')).includes('请选择公司类型') && await page.evaluate(() => document.activeElement.name === 'r-profile'), 'profil obligatoire, et il prend le focus');
await page.check('input[name=r-profile][value=Distributor]');
ok(await page.isVisible('#r-brands-d') && await page.isVisible('#r-auth') && await page.isHidden('#r-brands-m'), 'distributeur : marques et lettre d\'agrément');
await page.click('#r-send');
ok((await page.textContent('#msg')).includes('请上传营业执照照片，或填写注册号码（二选一）') && !state.calls.includes('POST /register'), 'marques facultatives ; ni photo ni numéro : refusé dans la page');
await page.fill('#r-code', 'AB-12345');
await page.click('#r-send');
ok((await page.textContent('#msg')).includes('请选择注册地区') && await page.evaluate(() => document.activeElement.id === 'r-region'), 'numéro sans région : région demandée, et elle prend le focus');
await page.fill('#r-code', '91350100M000100Y43');
ok(await page.inputValue('#r-region') === 'CN' && await page.inputValue('#r-city') === '福州', '统一社会信用代码 : région « 中国大陆 » et ville (福州) proposées d\'après le numéro');
await page.fill('#r-city', '');
await page.fill('#r-code', '91350100M000100Y44');
await page.click('#r-send');
ok((await page.textContent('#msg')).includes('统一社会信用代码有误') && !state.calls.includes('POST /register'), 'numéro invalide signalé tout de suite, sans appel au serveur');
await page.fill('#r-code', '91350100m000100y43');
await page.click('#r-send');
ok((await page.textContent('#msg')).includes('请填写主要联系人的姓名') && await page.evaluate(() => document.activeElement.name === 'family_name'), 'nom du contact principal obligatoire, et il prend le focus');
await page.fill('.ct[data-i="0"] [name=family_name]', '王');
await page.click('#r-send');
ok((await page.textContent('#msg')).includes('请选择报价币种') && !state.calls.includes('POST /register'), 'devise obligatoire');
for (const p of ['Manufacturer', 'Spot']) {
  await page.check('input[name=r-profile][value=' + p + ']');
  ok(p === 'Spot' ? await page.isHidden('#r-brands-m') && (await page.textContent('label.opt:has(input[value=Spot])')).includes('48 小时内回复')
      && await page.isVisible('input[name=r-spot-hint][value=surplus]') && (await page.textContent('.prof[data-for=Spot]')).includes('工厂或 EMS 呆滞库存')
    : await page.isVisible('#r-brands-m') && await page.isHidden('#r-brands-d'), 'profil ' + p + ' : son champ seulement');
}
await page.check('input[name=r-spot-hint][value=broker]');   // indication du stock disponible : ignorée pour un autre profil
await page.check('input[name=r-profile][value=Distributor]');
ok(await page.isHidden('input[name=r-spot-hint][value=broker]'), 'question « 库存主要来自 » réservée au stock disponible');
// Formats douteux : avertissement, jamais bloquant.
await page.click('.ct[data-i="0"] details.ct-more summary');
await page.fill('.ct[data-i="0"] [name=email]', 'pas-un-email');
await page.fill('#r-web', 'pas un site');
await page.fill('.ct[data-i="1"] [name=phone]', 'abc');
await page.click('#r-name');
ok(await page.isVisible('[data-w=email]') && await page.isVisible('[data-w=web]') && (await page.textContent('[data-w=email]')).includes('不影响提交'), 'formats douteux : avertissements');
// Logo : format indiqué ; PNG conseillé ; autre format ou plus de 1 Mo : à corriger avant l'envoi.
ok((await page.textContent('label:has(#r-logo)')).includes('格式：PNG（推荐，透明背景），也可 JPG 或 WebP') && (await page.textContent('label:has(#r-logo)')).includes('1 MB')
  && (await page.getAttribute('#r-logo', 'accept')) === 'image/png,image/jpeg,image/webp', 'logo : format indiqué (PNG recommandé, JPG ou WebP, 1 Mo), sélecteur limité aux images');
await page.setInputFiles('#r-logo', { name: 'logo.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
ok((await page.textContent('#r-logo-warn')).includes('PNG（推荐）、JPG 或 WebP'), 'logo en PDF : signalé dès le choix');
await page.setInputFiles('#r-logo', { name: 'logo.jpg', mimeType: 'image/jpeg', buffer: JPG_1PX });
await page.waitForFunction(() => /200 × 200/.test(document.getElementById('r-logo-warn').textContent));
ok((await page.textContent('#r-logo-warn')).includes('建议使用 PNG') && (await page.textContent('#r-logo-warn')).includes('1 × 1') && await page.isVisible('#r-logo-prev'),
  'logo en JPG, 1 × 1 pixel : conseils PNG et taille, non bloquants, aperçu');
await page.setInputFiles('#r-logo', { name: 'logo.png', mimeType: 'image/png', buffer: Buffer.concat([PNG_256, Buffer.alloc(1048577)]) });
await page.click('#r-send');
ok((await page.textContent('#msg')).includes('公司标志太大') && await page.evaluate(() => document.activeElement.id === 'r-logo') && !state.calls.includes('POST /register'),
  'logo de plus de 1 Mo : refusé dans la page, le champ prend le focus');
await page.setInputFiles('#r-logo', { name: 'logo.png', mimeType: 'image/png', buffer: PNG_256 });
await page.waitForFunction(() => !document.getElementById('r-logo-prev').hidden);
ok(await page.isHidden('#r-logo-warn'), 'logo PNG de 256 × 256 : aucun avertissement');

// 3. Inscription complète : numéro, ville, site, WeChat pro, lettre d'agrément, 3 contacts (dont une ligne vide).
await page.fill('#r-web', 'exemple-fictif.cn');
await page.fill('#r-wecom', '示例公众号');
await page.fill('#r-city', '深圳');
await page.fill('#r-brands-d', 'Marque A, Marque B');
await page.fill('.ct[data-i="0"] [name=given_name]', '伟');
await page.fill('.ct[data-i="1"] [name=family_name]', '陈');
await page.selectOption('.ct[data-i="1"] [name=duty]', 'sales');
await page.fill('.ct[data-i="2"] [name=wechat]', 'logistique_fictif');
await page.selectOption('.ct[data-i="2"] [name=duty]', 'logistics');
await page.check('input[name=r-currency][value=CNH]');
ok((await page.textContent('#r-count')) === '必填 5/5，可以提交', 'compteur : 5/5, prêt à envoyer');
await page.setInputFiles('#r-auth', { name: 'shouquan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
await page.click('#r-send');
await page.waitForSelector('#v-app:not([hidden])');
const R = state.registered;
ok(R.code === '91350100M000100Y43' && R.region === 'CN' && R.city === '深圳' && R.currency === 'CNH' && R.profile === 'Distributor'
  && R.brands === 'Marque A, Marque B' && /agrement-/.test(R.auth_path) && !R.license_path && R.website === 'exemple-fictif.cn' && R.wecom === '示例公众号',
  'inscription envoyée malgré les avertissements : numéro, région, ville, site, WeChat pro, marques, lettre');
ok(R.contacts.length === 4 && R.contacts[0].family_name === '王' && R.contacts[0].email === 'pas-un-email' && R.contacts[1].duty === 'sales'
  && R.contacts[2].wechat === 'logistique_fictif' && !R.contacts[3].family_name && R.spot_hint === null
  && /\/logo-[0-9-]+\.png$/.test(R.logo_path) && state.docs.includes('logo'), 'contacts envoyés (la ligne vide est ignorée par le serveur), sans indication de stock disponible, logo déposé avant l\'inscription');
await page.waitForSelector('#reg-inv-list li');
ok(state.contacts.invites.length === 1 && state.contacts.invites[0].label === '陈' && (await page.textContent('#reg-inv')).includes('陈')
  && (await page.textContent('#reg-inv')).includes('?invite=') && (await page.textContent('#reg-inv')).includes('14 天'),
  'contact supplémentaire nommé : lien d\'invitation créé et montré à transférer (14 jours) ; sans nom, aucun');
ok((await page.textContent('#msg')).includes('已收到。审核结果会通过微信通知您') && (await page.textContent('#org-alias')) === '审核中', 'après l\'envoi : message de réception, statut « 审核中 »');
ok(await page.isVisible('#more-card') && (await page.textContent('#more-missing')).includes('还可以补充：营业执照照片'), 'après l\'envoi : ce qui manque encore');
ok(await page.isVisible('#lic') && (await page.getAttribute('#status', 'class')).includes('info'), 'numéro seul : photo de la licence proposée, sans erreur');
// Compléter sa fiche tout de suite.
await page.click('#more-open');
ok((await page.textContent('#more-form')).includes('更换公司标志') && (await page.textContent('#more-form')).includes('已上传公司标志'), '补充资料 : logo déjà fourni, remplaçable');
await page.setInputFiles('#m-logo', { name: 'nouveau.png', mimeType: 'image/png', buffer: PNG_256 });
await page.fill('#m-city', '东莞');
await page.click('#more-form [type=submit]');
await page.waitForFunction(() => document.getElementById('more-form').hidden);
ok(state.signupSaved.city === '东莞' && state.signupSaved.name === '深圳测试电子有限公司', 'fiche complétée après l\'envoi (avant l\'approbation : nom modifiable)');
ok(state.logoUrl === 'nouveau.png' && state.signupSaved.logo_path === 'ORG-0107/logo-20261111-100000.png', '补充资料 : nouveau logo déposé dans le dossier de la société, puis enregistré');

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

// 5 bis. Validité des offres et reconfirmation sans nouveau fichier (ADR 0025).
await page.waitForSelector('#validity:not([hidden])');
ok((await page.textContent('#val-text')).includes('3 条报价在线') && (await page.textContent('#val-text')).includes('有效期 14 天'), 'validité : offres en ligne, échéance et durée de 14 jours');
ok((await page.textContent('#val-upd')).includes('本月已更新 2 天') && (await page.textContent('#val-upd')).includes('供应商评分'), 'validité : jours mis à jour ce mois-ci, comptés dans la note (ADR 0023)');
state.expired = true;
await page.click('#reconfirm');
await page.waitForFunction(() => /已确认：3 条报价/.test(document.getElementById('msg').textContent));
ok(state.reconfirmed === 1 && state.calls.includes('POST /reconfirm'), 'stock inchangé : reconfirmé en un geste');
await page.waitForFunction(() => !/已过期/.test(document.getElementById('val-text').textContent));
ok((await page.textContent('#val-text')).includes('3 条报价在线'), 'après reconfirmation : offres de nouveau en ligne');

// 6. Collègues : l'administrateur génère une invitation.
ok(await page.isVisible('#team'), 'administrateur : section « 同事 » visible');
await page.fill('#inv-label', '小王');
await page.click('#inv button[type=submit]');
await page.waitForSelector('#inv-out:not([hidden])');
ok((await page.textContent('#inv-link')).includes('?invite='), 'lien d\'invitation affiché');
ok((await page.textContent('#team-list')).includes('小王'), 'invitation en cours listée');

// 7. Anglais, et pas de défilement horizontal à 390 px.
await toggleLang(page);
ok((await page.textContent('h1')) === 'Supplier centre' && (await page.textContent('#org-alias')) === 'Under review', 'bascule en anglais');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'pas de défilement horizontal à 390 px');

// 7 bis. Société validée : demande d'achat reçue, confirmée depuis la page.
state.org = { ...ORG, status: 'validated', alias: 'V-9', has_license: true };
state.requests = [{ ref: 'PR-0001', status: 'submitted', mpn: 'NE555DR', qty: 2000, unit_price: 0.8, currency: 'CNH', delivery_country: 'FR' }];
await toggleLang(page);
await page.reload();
await page.waitForSelector('#req-card:not([hidden])');
ok((await page.textContent('#req-list')).includes('PR-0001') && !(await page.textContent('#req-list')).match(/@|Atelier/), 'demande d\'achat reçue, sans l\'acheteur');
await page.click('#req-list [data-ok="1"]');
await page.waitForFunction(() => !document.querySelector('#req-list [data-ans]'));
ok(state.answer.ref === 'PR-0001' && state.answer.ok === true && (await page.textContent('#req-list')).includes('已确认'), 'demande confirmée depuis la page');

// 7 bis bis. Fiche société, contacts, page du fabricant rattaché : corrections proposées et accord (migration 20261106000035).
{
  state.company = null;
  await page.reload();
  await page.waitForSelector('#co-card:not([hidden])');
  ok(await page.isHidden('#mf-card'), 'sans fabricant rattaché : pas de section fabricant');
  await page.click('#co-card button[data-co=edit]');
  await page.fill('#co-web', 'ftp://exemple');
  await page.click('#co-form button[type=submit]');
  await page.waitForSelector('#msg.err');
  ok((await page.textContent('#msg')).includes('Site web'), 'fiche société : site web invalide refusé');
  await page.fill('#co-web', 'https://societe.example');
  await page.fill('#co-staff', '170');
  await page.fill('#co-langs', 'zh，EN');
  await page.fill('#co-about-zh', '虚构的分销公司。');
  await page.click('#co-form button[type=submit]');
  await page.waitForSelector('#co-body button[data-co=edit]');
  ok(state.companySaved.staff === '170' && state.companySaved.languages.join(',') === 'zh,en' && (await page.textContent('#co-body')).includes('虚构的分销公司。'),
    'fiche société enregistrée : effectif, langues (virgule chinoise acceptée), présentation');
  await page.click('#co-card button[data-co=cadd]');
  await page.fill('#ct-name', 'Contact fictif');
  await page.fill('#ct-email', 'Ventes@Societe.Example');
  await page.check('#ct-rfq');
  await page.check('#ct-po');
  await page.click('#ct-f button[type=submit]');
  await page.waitForFunction(() => /ventes@societe\.example/.test(document.getElementById('ct-list').textContent));
  ok((await page.textContent('#ct-list')).includes('询价') && (await page.textContent('#ct-list')).includes('订单'), 'contact ajouté, adresses préférées RFQ et commandes');

  state.company.manufacturers = [{ id: 'MFR-0001', name: '虚构制造商', brands: ['Marque Démo'], role: 'self', consent_at: null, public_page: false, pending: false,
    about: { en: 'Fictitious manufacturer.' }, positioning: {}, founded_year: 2013, hq_city: 'Shenzhen', production_site: null, area_m2: null, staff: 120,
    annual_units: null, certifications: [], languages: ['zh'] }];
  await page.reload();
  await page.waitForSelector('#mf-card:not([hidden])');
  const mf = await page.textContent('#mf-list');
  ok(mf.includes('虚构制造商') && mf.includes('原厂直供') && mf.includes('未发布') && mf.includes('由 Central.Parts 在欧洲分销') && mf.includes('贸易商'),
    'page du fabricant : rôle, état, texte de l\'accord (canal officiel seulement)');
  await page.click('#mf-list button[data-mf=propose]');
  await page.click('form.mf-prop button[type=submit]');
  ok((await page.textContent('#msg')).includes('没有修改') && !state.proposal, 'aucune modification : rien n\'est envoyé');
  await page.fill('#mp-staff', '130');
  await page.fill('#mp-about-zh', '虚构的制造商。');
  await page.click('form.mf-prop button[type=submit]');
  await page.waitForFunction(() => /等待 Central\.Parts 审核/.test(document.getElementById('mf-list').textContent));
  ok(state.proposal.id === 'MFR-0001' && state.proposal.proposed.staff === '130' && state.proposal.proposed.about.zh === '虚构的制造商。'
    && !('en' in state.proposal.proposed.about) && !('hq_city' in state.proposal.proposed), 'correction proposée : seuls les champs modifiés partent');
  await page.click('#mf-list button[data-mf=consent]');
  await page.waitForFunction(() => /已于/.test(document.getElementById('mf-list').textContent));
  ok(!!state.company.manufacturers[0].consent_at && await page.isVisible('#mf-list button[data-mf=unconsent]'), 'accord donné, retrait possible');
  page.once('dialog', (d) => d.accept());
  await page.click('#mf-list button[data-mf=unconsent]');
  await page.waitForSelector('#mf-list button[data-mf=consent]');
  ok(!state.company.manufacturers[0].consent_at, 'accord retiré');
  await toggleLang(page);
  ok((await page.textContent('#mf-list')).includes('Distributed in Europe by Central.Parts') && (await page.textContent('#co-card h2')) === 'Company profile', 'textes en anglais');
  await toggleLang(page);
  // Collègue (pas responsable de la fiche) : lecture seule.
  state.company.can_edit = false;
  await page.reload();
  await page.waitForSelector('#mf-card:not([hidden])');
  ok(!(await page.$('#co-body button[data-co=edit]')) && !(await page.$('#mf-list button[data-mf]')) && !(await page.$('#ct-form button')), 'collègue : lecture seule');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'fiche société : pas de défilement horizontal à 390 px');
  state.company = null;
}

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
  await toggleLang(page);
  ok((await page.textContent('#rfq-card')).includes('Platform RFQs') && (await page.textContent('#rfq-card')).includes('Your handling rate: 75 %'), 'RFQ : anglais');
  await toggleLang(page);
}

// 7 quater. Recherches payantes : inscription comme broker volontaire, laboratoires, réponses (ADR 0033).
{
  const soon = new Date(Date.now() + 30 * 3600e3).toISOString(), week = new Date(Date.now() + 6 * 86400e3).toISOString();
  state.rfqs = { demands: [], score: null };
  state.src = { eligible: true, volunteer: null, score: null, requests: [] };
  await page.reload();
  await page.waitForSelector('#src-card:not([hidden])');
  let txt = await page.textContent('#src-card');
  ok(txt.includes('48 小时内回复') && txt.includes('不显示您的公司名称') && txt.includes('只有 Central.Parts 可见'), 'volontaires : engagement, anonymat et laboratoires expliqués');
  ok(await page.isDisabled('#src-join-btn'), 'volontaires : inscription impossible sans cocher l\'engagement');
  await page.fill('#src-labs', 'Laboratoire fictif, Shenzhen');
  await page.check('#src-commit');
  await page.click('#src-join-btn');
  await page.waitForSelector('#src-leave');
  ok(state.srcJoin.on === true && state.srcJoin.labs === 'Laboratoire fictif, Shenzhen' && (await page.textContent('#src-card')).includes('您已参加寻货'), 'volontaires : inscription avec laboratoires');
  // Recherches reçues : offre avec quantité partielle ; 无货 ; recherche close.
  state.src.score = { received: 3, quoted: 1, declined: 1, expired: 1 };
  state.src.requests = [
    { ref: 'SRC-0030', mpn: 'LM317HVK', manufacturer: 'Texas Instruments', qty: 500, ship_to: 'FR', open: true, open_until: week, deadline_at: soon, response: 'pending', my_offers: [] },
    { ref: 'SRC-0029', mpn: 'XC2S50', qty: 4, ship_to: 'DE', open: true, open_until: week, deadline_at: soon, response: 'pending', my_offers: [] },
    { ref: 'SRC-0031', mpn: 'AD7714', qty: 10, ship_to: 'IT', open: true, open_until: week, deadline_at: soon, response: 'pending', my_offers: [] },
    { ref: 'SRC-0020', mpn: 'MC68000', qty: 20, ship_to: 'FR', open: false, open_until: '2026-11-01T08:00:00Z', deadline_at: '2026-10-27T08:00:00Z', response: 'expired', my_offers: [] },
  ];
  await page.reload();
  await page.waitForSelector('form[data-src="SRC-0030"]');
  txt = await page.textContent('#src-card');
  ok(txt.includes('SRC-0030 · LM317HVK (Texas Instruments)') && txt.includes('开放至') && txt.includes('北京时间') && txt.includes('收到 3'), 'volontaires : recherches reçues, échéances, note');
  ok(!/Acheteur|company|@|prix cible|target/i.test(txt), 'volontaires : rien sur l\'acheteur');
  ok((await page.$$('form[data-src]')).length === 3 && txt.includes('已逾期'), 'volontaires : formulaire seulement pour les recherches ouvertes');
  await page.fill('form[data-src="SRC-0030"] [name=price]', '2,1');
  await page.selectOption('form[data-src="SRC-0030"] [name=currency]', 'USD');
  await page.fill('form[data-src="SRC-0030"] [name=lead]', '30');
  await page.fill('form[data-src="SRC-0030"] [name=dc]', '2318');
  await page.fill('form[data-src="SRC-0030"] [name=qty]', '400');
  await page.click('form[data-src="SRC-0030"] [type=submit]');
  await page.waitForFunction(() => /2\.1 USD/.test(document.getElementById('src-card').textContent));
  ok(JSON.stringify(state.srcAnswer) === JSON.stringify({ ref: 'SRC-0030', kind: 'quote', price: 2.1, currency: 'USD', lead_days: 30, date_code: '2318', qty: 400 }),
    'volontaires : offre envoyée, quantité partielle ' + JSON.stringify(state.srcAnswer));
  ok(await page.$('form[data-src="SRC-0030"]') !== null && !(await page.$('[data-src-none="SRC-0030"]')), 'volontaires : après une offre, nouvelle offre possible, plus de 无货');
  await page.click('[data-src-none="SRC-0029"]');
  await page.waitForFunction(() => !document.querySelector('[data-src-none="SRC-0029"]'));
  ok(state.srcAnswer.kind === 'decline', 'volontaires : 无货');
  await page.fill('form[data-src="SRC-0031"] [name=price]', '1');
  await page.fill('form[data-src="SRC-0031"] [name=lead]', '1');
  await page.click('form[data-src="SRC-0031"] [type=submit]');
  await page.waitForFunction(() => /寻货已结束/.test(document.getElementById('src-card').textContent));
  ok(true, 'volontaires : recherche close, motif affiché');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'volontaires : pas de défilement horizontal à 390 px');
  await toggleLang(page);
  ok((await page.textContent('#src-card')).includes('Paid sourcing requests'), 'volontaires : anglais');
  await toggleLang(page);
  page.once('dialog', (d) => d.accept());
  await page.click('#src-leave');
  await page.waitForSelector('#src-join-btn');
  ok(state.srcJoin.on === false && (await page.textContent('#src-card')).includes('您已退出寻货'), 'volontaires : retrait');
  state.src = { eligible: false, volunteer: null, requests: [] };
  await page.reload();
  await page.waitForSelector('#v-app:not([hidden])');
  await page.waitForTimeout(300);
  ok(await page.isHidden('#src-card'), 'volontaires : carte masquée pour un fabricant ou un distributeur');
}

// 7 quinquies. Contacts saisis à l'inscription : relié ou non au robot ; invitation d'un contact non relié (ADR 0034).
{
  state.company = { org_id: 'ORG-0107', name: ORG.name, can_edit: true, founded_year: null, website: null, about: {}, hq_city: null, staff: null,
    certifications: [], languages: [], payment_methods: [], payment_terms: null, min_order_usd: null, manufacturers: [],
    contacts: [{ id: 'CTC-1', name: '王伟', duty: 'main', linked: true, languages: [] }, { id: 'CTC-2', name: '陈小姐', duty: 'sales', linked: false, languages: [] }] };
  await page.reload();
  await page.waitForSelector('#co-card:not([hidden]) [data-co=cinvite]');
  const t = await page.textContent('#ct-list');
  ok(t.includes('已关联微信') && t.includes('未关联微信：收不到询单和通知') && (await page.$$('[data-co=cinvite]')).length === 1, 'contacts : relié ou non au robot, invitation seulement pour un contact non relié');
  await page.click('[data-co=cinvite]');
  await page.waitForSelector('[data-inv-out]:not([hidden])');
  ok(state.contacts.invites.some((i) => i.label === '陈小姐') && (await page.textContent('[data-inv-out]:not([hidden])')).includes('?invite='), 'invitation créée au nom du contact, lien à transmettre');
  state.company = null;
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
  await p2.route('https://tuhbzziqyisdnqzfvtkh.supabase.co/storage/**', (r) => r.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' }));
  await p2.route(/^(?!http:\/\/localhost|https:\/\/tuhbzziqyisdnqzfvtkh)/, (r) => { errors.push('requête externe : ' + r.request().url()); return r.abort(); });
  await p2.goto(BASE + '/depot/?login=dl_' + 'a'.repeat(32));
  await p2.waitForSelector('#v-register:not([hidden])');
  await p2.fill('#r-name', 'HK TEST COMPANY LIMITED');
  await p2.check('input[name=r-profile][value=Manufacturer]');
  await p2.fill('#r-brands-m', 'Marque HK');
  await p2.fill('.ct[data-i="0"] [name=given_name]', 'Mary');
  await p2.check('input[name=r-currency][value=HKD]');
  await p2.selectOption('#r-region', 'CN');
  await p2.fill('#r-code', '123456789012345');
  await p2.click('#r-send');
  ok((await p2.textContent('#msg')).includes('统一社会信用代码有误') && !state.calls.includes('POST /register'), width + ' px : 15 caractères refusés pour la Chine continentale');
  await p2.selectOption('#r-region', 'HK');
  ok((await p2.textContent('#r-code-hint')).includes('香港商业登记证') && await p2.getAttribute('#r-code', 'maxlength') === '30', width + ' px : Hong Kong : aide et longueur adaptées');
  await toggleLang(p2);
  ok((await p2.textContent('#r-code-hint')).includes('Hong Kong business registration') && (await p2.textContent('#r-verif legend')).includes('Company check')
    && (await p2.textContent('label.opt:has(input[value=Spot]) strong')) === 'Spot stock (trader, broker, surplus)', width + ' px : textes en anglais');
  await p2.fill('#r-code', '12');
  await p2.click('#r-send');
  ok((await p2.textContent('#msg')).includes('Invalid registration number'), width + ' px : numéro trop court refusé, message adapté');
  ok(await p2.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + ' px : pas de défilement horizontal');
  if (width === 1280) {
    await p2.fill('#r-code', ' 1234 5678  90123 ');
    await p2.click('#r-send');
    await p2.waitForSelector('#v-app:not([hidden])');
    ok(state.registered.region === 'HK' && state.registered.code === '1234 5678 90123' && state.registered.brands === 'Marque HK', 'Hong Kong : inscription envoyée, région HK, numéro normalisé, marque');
  } else {
    // Photo seule, sans numéro : stock disponible, la photo part d'abord dans le dossier du compte.
    await p2.check('input[name=r-profile][value=Spot]');
    await p2.fill('#r-code', '');
    await p2.selectOption('#r-region', '');
    await p2.setInputFiles('#r-lic', { name: 'image', mimeType: 'image/jpeg', buffer: Buffer.from('jpg') });
    await p2.click('#r-send');
    await p2.waitForSelector('#v-app:not([hidden])');
    ok(state.registered.profile === 'Spot' && /^pending\/c{32}\/licence-/.test(state.registered.license_path) && !state.registered.code && !state.registered.region && !state.registered.brands
      && !state.registered.city && !state.registered.website,
      width + ' px : inscription minimale (nom, profil, photo, contact, devise) : aucun autre champ, aucune erreur');
    ok(await p2.isHidden('#lic') && /审核中|Under review/.test(await p2.textContent('#status')), width + ' px : photo déjà fournie, plus de demande de licence');
  }
  await p2.close();
  state.org = null; state.calls = [];
}

ok(errors.length === 0, 'aucune erreur ni requête externe : ' + errors.join(' | '));
await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
