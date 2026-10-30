// Parcours de la page fournisseur (site/depot/) dans Chromium, avec une fonction « depot » simulée :
// lien personnel reçu dans WeChat, inscription, licence, dépôt d'un fichier, invitation d'un collègue ; puis compte refusé.
// Usage : (cd site && python3 -m http.server 8765) & node tools/test-depot-ui.mjs
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
    if (body.code !== '91350100M000100Y43') return reply({ error: 'code_invalid' }, 422);
    state.org = { ...ORG }; state.registered = body;
    return reply({ org: state.org, token: 'T2' });
  }
  if (path === '/license-url') return reply({ signed_url: 'https://tuhbzziqyisdnqzfvtkh.supabase.co/storage/v1/upload/sign/x', path: 'ORG-0107/licence-1.jpg' });
  if (path === '/license') { state.org.has_license = true; return reply({ ok: true }); }
  if (path === '/upload-url') return reply({ signed_url: 'https://tuhbzziqyisdnqzfvtkh.supabase.co/storage/v1/upload/sign/y', path: 'ORG-0107/f.csv' });
  if (path === '/imports') return reply(state.uploaded ? [{ id: 'IMP-1', file_name: 'f.csv', status: 'done', created: 3, updated: 0, rejected: 0, duplicates: 0, missing_date_code: 3, withdrawn: 0, received_at: '2026-10-31T10:05:00Z', report: { rejected: [] } }] : []);
  if (path === '/contacts') return reply(state.contacts);
  if (path === '/invite') { state.contacts.invites.push({ label: body.label }); return reply({ link: 'https://central.parts/depot/?invite=' + 'c'.repeat(36) }); }
  return reply({ error: 'not_found' }, 404);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.route(FN + '/**', api);
await page.route('https://tuhbzziqyisdnqzfvtkh.supabase.co/storage/**', (r) => { if (r.request().url().endsWith('/y')) state.uploaded = true; return r.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' }); });
await page.route(/^(?!http:\/\/localhost|https:\/\/tuhbzziqyisdnqzfvtkh)/, (r) => { errors.push('requête externe : ' + r.request().url()); return r.abort(); });

// 1. Lien personnel reçu dans WeChat : compte sans société → formulaire d'inscription.
await page.goto(BASE + '/depot/?login=dl_' + 'a'.repeat(32));
await page.waitForSelector('#v-register:not([hidden])');
ok(new URL(page.url()).search === '', 'lien personnel retiré de l\'adresse après connexion');
ok(await page.isVisible('text=注册公司'), 'formulaire d\'inscription en chinois');

// 2. Numéro mal saisi : refusé dans la page, sans appel au serveur.
await page.fill('#r-name', '深圳测试电子有限公司');
await page.fill('#r-code', '91350100M000100Y44');
await page.fill('#r-city', '深圳');
await page.selectOption('#r-profile', 'Distributor');
await page.click('#r-send');
ok((await page.textContent('#msg')).includes('统一社会信用代码有误'), 'numéro invalide signalé tout de suite');
ok(!state.calls.includes('POST /register'), 'numéro invalide : aucun appel au serveur');

// 3. Inscription : la société est en attente, la licence est demandée.
await page.fill('#r-code', '91350100m000100y43');
await page.selectOption('#r-currency', 'CNH');
await page.click('#r-send');
await page.waitForSelector('#v-app:not([hidden])');
ok(state.registered.code === '91350100M000100Y43' && state.registered.currency === 'CNH' && state.registered.profile === 'Distributor', 'inscription envoyée : numéro en majuscules, devise, type');
ok(await page.isVisible('#lic') && (await page.textContent('#org-alias')) === '审核中', 'société en attente : licence demandée, statut « 审核中 »');

// 4. Licence (photo de téléphone sans extension) : le statut passe à « en cours d'examen ».
await page.setInputFiles('#lic-file', { name: 'image', mimeType: 'image/jpeg', buffer: Buffer.from('jpg') });
await page.click('#lic-send');
await page.waitForSelector('#lic', { state: 'hidden' });
ok(state.calls.includes('POST /license') && (await page.textContent('#status')).includes('审核中'), 'licence envoyée, société en cours d\'examen');

// 5. Dépôt d'un fichier de stock pendant l'examen.
await page.setInputFiles('#file', { name: '库存.csv', mimeType: 'text/csv', buffer: Buffer.from('mpn,quantity\nNE555DR,10\n') });
await page.click('#send');
await page.waitForSelector('.imp');
ok((await page.textContent('#imports')).includes('新增 3'), 'dépôt pendant l\'examen : rapport affiché');

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

ok(errors.length === 0, 'aucune erreur ni requête externe : ' + errors.join(' | '));
await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
