// Recherche payante de composants rares (site/sourcing/, ADR 0033) dans Chromium, avec la fonction « sourcing » simulée
// et la page de paiement GoCardless remplacée par une page locale. Demandes et sociétés fictives.
//   1. /offres/ sans résultat : lien vers la recherche, référence pré-remplie.
//   2. /sourcing/ : contrôles du formulaire, TVA selon le pays, montant, envoi, redirection vers le paiement, annulation ;
//      pays sans paiement en ligne : proforma et lien de suivi.
//   3. /sourcing/suivi/ : paiement en cours de confirmation puis payée, note de Central.Parts, proforma, lien invalide, 3 langues.
// Usage : (cd site && python3 -m http.server 8765) & node tools/test-sourcing-ui.mjs
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
const SUPA = 'https://tuhbzziqyisdnqzfvtkh.supabase.co';
const CHECKOUT = 'https://pay.gocardless.com/billing/static/flow?id=BRF_FICTIF';
const TOKEN = 'c'.repeat(48), PF_TOKEN = 'e'.repeat(48);
let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };
const state = { sent: [], statusCalls: 0, external: [] };

async function sourcing(route) {
  const req = route.request(), u = new URL(req.url());
  const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }, body: JSON.stringify(data) });
  if (req.method() === 'OPTIONS') return reply({});
  if (u.pathname.endsWith('/status')) {
    if (req.headers().authorization === 'Bearer ' + PF_TOKEN) {
      state.pfCalls = (state.pfCalls || 0) + 1;
      return reply({ id: 'SRC-0002', status: 'awaiting_payment', payment_mode: 'proforma', mpn: 'XC2S50-5PQ208C', qty: 4, condition: 'any',
        company: 'Bureau d\'études fictif', amount_ht: 4900, amount_ttc: 4900, vat_rate: 0, paid_at: null, buyer_note: null, credit_used: false });
    }
    if (req.headers().authorization !== 'Bearer ' + TOKEN) return reply({ error: 'link_invalid' }, 401);
    state.statusCalls++;
    // Premier appel : l'avis de GoCardless (webhook) n'est pas encore arrivé.
    return reply({ id: 'SRC-0001', payment_mode: 'bank', status: state.statusCalls === 1 ? 'awaiting_payment' : 'offers_sent', mpn: 'CM8071505024905', manufacturer: 'Intel', qty: 10,
      target_price: 120, target_currency: 'EUR', needed_by: '2026-12-01', condition: 'new', company: 'Acheteur de démonstration (fictif)',
      amount_ht: 4900, amount_ttc: 5880, vat_rate: 0.2, paid_at: state.statusCalls === 1 ? null : '2026-11-06T12:00:00Z',
      buyer_note: state.statusCalls === 1 ? null : 'Deux offres envoyées par e-mail.', credit_used: false });
  }
  const b = JSON.parse(req.postData() || '{}');
  state.sent.push(b);
  if (b.vat === 'FR00000000000') return reply({ error: 'vat_invalid' }, 422);
  if (b.country === 'IT') return reply({ id: 'SRC-0002', mode: 'proforma', tracking_url: BASE + '/sourcing/suivi/?lang=fr#' + PF_TOKEN });
  return reply({ id: 'SRC-0001', mode: 'bank', url: CHECKOUT });
}
async function offers(route) {
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ query: 'CM8071505024905', currency: 'EUR', ttl_days: 7, offers: [], manufacturers: [], total_refs: 0, total_offers: 0, total_units: 0 }) });
}

const browser = await chromium.launch();
async function newPage(width) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, locale: 'fr-FR' });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|422)/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(SUPA + '/functions/v1/sourcing**', sourcing);
  await page.route(SUPA + '/functions/v1/offers**', offers);
  await page.route('https://pay.gocardless.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Paiement simulé</title><h1>GoCardless simulé</h1>' }));
  await page.route(/^(?!http:\/\/localhost|https:\/\/tuhbzziqyisdnqzfvtkh\.supabase\.co|https:\/\/pay\.gocardless\.com)/, (r) => { state.external.push(r.request().url()); r.abort(); });
  return { page, errors };
}
const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

// ---------------------------------------------------------------- 1. offres sans résultat
{
  const { page, errors } = await newPage(1280);
  await page.goto(BASE + '/offres/?lang=fr&q=CM8071505024905');
  await page.waitForSelector('#to-sourcing:not([hidden])');
  ok((await page.textContent('#to-sourcing-a')).includes('49 € HT') && (await page.getAttribute('#to-sourcing-a', 'href')) === '/sourcing/?lang=fr&q=CM8071505024905',
    'offres sans résultat : lien vers la recherche de sourcing, référence transmise');
  ok((await page.getAttribute('.topnav a[data-href="/sourcing/"]', 'href')) === '/sourcing/?lang=fr', 'menu : « Composants rares »');
  ok(errors.length === 0, 'offres : aucune erreur console ' + errors.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------- 2. formulaire et paiement
for (const width of [1280, 390]) {
  const { page, errors } = await newPage(width);
  await page.goto(BASE + '/sourcing/?lang=fr&q=CM8071505024905');
  ok((await page.inputValue('#f-mpn')) === 'CM8071505024905' && (await page.textContent('h1')) === 'Composants rares ou introuvables', width + ' px : référence pré-remplie');
  ok((await page.textContent('#send')).includes('49,00') && (await page.getAttribute('.topnav a[aria-current=page]', 'data-href')) === '/sourcing/', width + ' px : 49 € HT affiché, menu');
  ok(await noScroll(page), width + ' px : pas de défilement horizontal');
  if (width === 1280) {
    await page.click('#send');
    ok((await page.textContent('#msg')).includes('Renseignez') && !state.sent.length, 'champs manquants : rien n\'est envoyé');
    await page.fill('#f-qty', '10');
    await page.fill('#f-company', 'Acheteur de démonstration (fictif)');
    await page.fill('#f-contact', 'Contact fictif');
    await page.fill('#f-email', 'achat@exemple.test');
    await page.selectOption('#f-country', 'FR');
    ok(await page.isVisible('#vat-l') && (await page.textContent('#ttc')).includes('58,80') && (await page.textContent('#send')).includes('58,80'), 'France : TVA 20 %, 58,80 € TTC');
    await page.selectOption('#f-country', 'US');
    ok(await page.isHidden('#vat-l') && (await page.textContent('#ttc')).includes('sans TVA') && (await page.textContent('#send')).includes('49,00'), 'hors Union : sans TVA ni numéro');
    ok((await page.textContent('#send')).includes('proforma') && (await page.textContent('#pay-note')).includes('virement'), 'pays sans paiement en ligne : proforma annoncée');
    await page.selectOption('#f-country', 'DE');
    ok((await page.textContent('#ttc')).includes('Autoliquidation') && (await page.textContent('#send')).includes('virement bancaire'), 'Allemagne : autoliquidation, virement bancaire');
    await page.click('#send');
    ok((await page.textContent('#msg')).includes('TVA est obligatoire') && !state.sent.length, 'Union sans numéro de TVA : refusé dans la page');
    await page.fill('#f-vat', 'DE123456789');
    await page.click('#send');
    ok((await page.textContent('#msg')).includes('Cochez') && !state.sent.length, 'conditions des frais non acceptées : refusé dans la page');
    await page.selectOption('#f-country', 'FR');
    await page.fill('#f-vat', 'FR00000000000');
    await page.check('#f-ok');
    await page.click('#send');
    await page.waitForFunction(() => /VIES/.test(document.getElementById('msg').textContent));
    ok(state.sent.length === 1 && !(await page.isDisabled('#send')), 'TVA refusée par VIES : message, bouton réactivé');
    await page.fill('#f-vat', 'FR12345678901');
    await page.fill('#f-notes', 'Date code 2023 ou plus récent.');
    await Promise.all([page.waitForURL(CHECKOUT), page.click('#send')]);
    const b = state.sent[1];
    ok(b.mpn === 'CM8071505024905' && b.qty === '10' && b.country === 'FR' && b.vat === 'FR12345678901' && b.lang === 'fr' && b.notes.includes('2023'),
      'demande envoyée complète, redirection vers la page de paiement');
    await page.goto(BASE + '/sourcing/?lang=fr&cancel=1');
    ok((await page.textContent('#msg')).includes('Paiement annulé'), 'retour sans paiement : message');
    // Italie (hors liste du paiement en ligne) : proforma, l'acheteur arrive sur son suivi.
    await page.fill('#f-mpn', 'XC2S50-5PQ208C');
    await page.fill('#f-qty', '4');
    await page.fill('#f-company', 'Bureau d\'études fictif');
    await page.fill('#f-contact', 'Contact fictif 2');
    await page.fill('#f-email', 'be@exemple.test');
    await page.selectOption('#f-country', 'IT');
    await page.fill('#f-vat', 'IT12345678901');
    await page.check('#f-ok');
    await Promise.all([page.waitForURL(/\/sourcing\/suivi\//), page.click('#send')]);
    await page.waitForSelector('#card:not([hidden])');
    const pf = (await page.textContent('#card')).replace(/[\u202f\u00a0]/g, ' ');
    ok(state.sent[2].country === 'IT' && (await page.textContent('#st')) === 'En attente de votre virement' && pf.includes('proforma de 49,00 €'),
      'proforma : demande enregistrée, suivi « en attente de votre virement »');
    await page.waitForTimeout(4500);
    ok(state.pfCalls === 1, 'proforma : pas d\'interrogation en boucle');
    await page.click('[data-lang=zh]');
    ok((await page.textContent('h1')).includes('寻源') && (await page.textContent('.topnav a[aria-current=page]')) === '稀缺元器件', '中文 : titre et menu');
  }
  ok(errors.length === 0, width + ' px : aucune erreur console ' + errors.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------- 3. suivi
{
  const { page, errors } = await newPage(390);
  await page.goto(BASE + '/sourcing/suivi/?lang=fr#' + TOKEN);
  await page.waitForSelector('#card:not([hidden])');
  ok((await page.textContent('#st')).includes('Paiement en cours de confirmation'), 'retour du paiement : confirmation en attente');
  await page.waitForFunction(() => /Offres envoyées/.test(document.getElementById('st').textContent), null, { timeout: 8000 });
  const txt = (await page.textContent('#card')).replace(/[  ]/g, ' ');
  ok(state.statusCalls >= 2 && txt.includes('CM8071505024905') && txt.includes('Deux offres envoyées') && txt.includes('(49,00 € HT) seront déduits'), 'mise à jour automatique : offres envoyées, note, déduction');
  ok(await noScroll(page), 'suivi, 390 px : pas de défilement horizontal');
  await page.click('[data-lang=en]');
  ok((await page.textContent('#st')) === 'Offers sent', 'suivi EN');
  // Autre adresse (pas seulement un autre fragment) : la page se recharge.
  await page.goto(BASE + '/sourcing/suivi/?lang=fr&v=2#' + 'd'.repeat(48));
  await page.waitForSelector('#msg:not([hidden])');
  ok((await page.textContent('#msg')).includes('pas valide') && await page.isHidden('#card'), 'lien invalide : message');
  ok(await page.getAttribute('meta[name=robots]', 'content') === 'noindex, nofollow', 'suivi non indexé');
  ok(errors.length === 0, 'suivi : aucune erreur console ' + errors.join(' | '));
  await page.close();
}

{
  const page = await browser.newPage({ javaScriptEnabled: false });
  await page.goto(BASE + '/sourcing/');
  ok((await page.textContent('noscript')).includes('JavaScript') && (await page.textContent('h1')) === 'Composants rares ou introuvables', 'sans JavaScript : titre et message');
  await page.close();
}

ok(state.external.length === 0, 'aucune requête externe : ' + state.external.join(' '));
await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
