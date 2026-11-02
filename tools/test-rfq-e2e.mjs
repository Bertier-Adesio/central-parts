// Route RFQ de bout en bout (ADR 0023), en local : base PostgreSQL jetable (migrations, seed.sql, sandbox-rfq.sql),
// passerelle façon PostgREST (tools/rfq-e2e/shim.cjs), fonctions Edge « rfq » et « wechat-events » du dépôt sous Deno,
// WeChat et plateformes simulés (tools/rfq-e2e/main.ts) : aucun appel réseau sortant. Parcours vérifiés :
//   erreurs de l'API (401, 403, 404, 409, 422), X-RateLimit-*, bac à sable complet sans aucun message, webhooks
//   signés ; en production : fiche à l'administrateur, « approve DEM-… » dans WeChat, message anonymisé au
//   fournisseur, échec d'envoi sans délai démarré, 报价 et réponse en double, clôture par la tâche planifiée,
//   offres tout compris, refus avec motif, annulation.
// Prérequis : PostgreSQL (comme tools/test-db.sh), Deno, et le module pg (npm install --no-save pg@8.13.1).
// Usage : node tools/test-rfq-e2e.mjs        (variables : PGHOST, PGPORT, PGPASSWORD, DENO)
import { spawn, execSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const E2E = REPO + '/tools/rfq-e2e/';
const DENO = process.env.DENO || 'deno';
const WORK = mkdtempSync(join(tmpdir(), 'cp-rfq-e2e-'));
const CAPTURE = join(WORK, 'capture.jsonl');
const PGHOST = process.env.PGHOST || '/var/tmp', PGPORT = process.env.PGPORT || '54329';
const P = `psql -h ${PGHOST} -p ${PGPORT} -U postgres -v ON_ERROR_STOP=1 -q`;
let n = 0, bad = 0;
const ok = (c, l) => { n++; if (!c) { bad++; console.log('ÉCHEC ' + l); } else console.log('ok  ' + l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha256').update(s).digest('hex');

const KEY_TEST = 'cp_test_' + 'E2Etest'.padEnd(32, 'x');
const KEY_LIVE = 'cp_live_' + 'E2Elive'.padEnd(32, 'y');
const KEY_READ = 'cp_live_' + 'E2Eread'.padEnd(32, 'z');

// ---------------------------------------------------------------- base
execSync(`${P} -c 'drop database if exists cp_e2e' -c 'create database cp_e2e'`);
const run = (f) => execSync(`${P} -d cp_e2e -f ${f}`, { stdio: ['ignore', 'ignore', 'pipe'] });
run(REPO + '/supabase/checks/00_stub_supabase.sql');
for (const f of execSync(`ls ${REPO}/supabase/migrations/*.sql`).toString().trim().split('\n')) run(f);
run(REPO + '/supabase/seed.sql');
run(REPO + '/supabase/sandbox-rfq.sql');
writeFileSync(join(WORK, 'setup.sql'), `
insert into public.organizations (id, type, name, alias, country, currency, lang, kyb) values ('PLATX', 'buyer', 'Plateforme E2E (fictive)', 'P-E2E', 'FR', 'EUR', 'fr', 'validated');
insert into public.api_keys (org_id, environment, prefix, key_hash, scopes) values
  ('PLATX', 'sandbox', 'cp_test_E2Et', '${sha(KEY_TEST)}', '{demands:write}'),
  ('PLATX', 'live', 'cp_live_E2El', '${sha(KEY_LIVE)}', '{demands:write}'),
  ('PLATX', 'live', 'cp_live_E2Er', '${sha(KEY_READ)}', '{}');
insert into public.operators (openid, label) values ('oOPERATOR', 'Opérateur de test');
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb) values
  ('RSL1', 'seller', 'Fournisseur partenaire A (fictif)', 'V-801', 'Hong Kong', 'HK', 'USD', 'zh', 'Broker', 'validated'),
  ('RSL2', 'seller', 'Fournisseur partenaire B (fictif)', 'V-802', 'Shenzhen', 'CN', 'CNH', 'zh', 'Surplus EMS', 'validated');
insert into public.subscriptions (org_id, plan, until) values ('RSL1', 'Test', current_date + 30), ('RSL2', 'Test', current_date + 30);
insert into public.wechat_identities (openid, org_id, role) values ('oSUP1', 'RSL1', 'admin'), ('oSILENT', 'RSL2', 'admin');
insert into public.lots (id, seller_id, sku, mpn, manufacturer, qty, date_code, unit_price, currency) values
  ('LOT-E1', 'RSL1', 'SKU-E2E-1', 'E2ETEST555', 'Texas Instruments', 1000, '2425', 0.50, 'USD'),
  ('LOT-E2', 'RSL2', 'SKU-E2E-2', 'E2ETEST555', 'Texas Instruments', 800, '2401', 3.00, 'CNH');
insert into app.seller_margins (org_id, margin_pct) values ('RSL1', 10), ('RSL2', 10);
`);
run(join(WORK, 'setup.sql'));
const sql = (q) => execSync(`${P} -d cp_e2e -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim();

// ---------------------------------------------------------------- processus
writeFileSync(CAPTURE, '');
const procs = [];
const start = (cmd, args, env) => { const p = spawn(cmd, args, { cwd: E2E, detached: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(p); p.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d)); return p; };
start('node', [E2E + 'shim.cjs'], { DB: 'cp_e2e', PGHOST, PGPORT });
const fnEnv = { SUPABASE_URL: 'http://localhost:54400', SUPABASE_SERVICE_ROLE_KEY: 'service', CAPTURE, RFQ_WECHAT_OPEN: 'true',
  RFQ_WEBHOOK_KEY: 'cle-maitre-de-test', RFQ_JOBS_SECRET: 'secret-des-taches', WECHAT_TOKEN: 'jeton-wechat', WECHAT_APPID: 'wx', WECHAT_SECRET: 's' };
const denoArgs = ['run', '--allow-env', '--allow-net', '--allow-read', `--allow-write=${CAPTURE}`, E2E + 'main.ts'];
start(DENO, denoArgs, { ...fnEnv, PORT: '54401', FN: 'file://' + REPO + '/supabase/functions/rfq/index.ts' });
start(DENO, denoArgs, { ...fnEnv, PORT: '54402', FN: 'file://' + REPO + '/supabase/functions/wechat-events/index.ts' });
for (let i = 0; i < 120; i++) {
  try { await fetch('http://localhost:54401/rfq/v1/health'); await fetch('http://localhost:54402/'); break; } catch { await sleep(500); }
}

const api = async (method, path, key, body, headers = {}) => {
  const r = await fetch('http://localhost:54401/rfq' + path, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), 'Content-Type': 'application/json', ...headers } });
  const text = await r.text();
  return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null };
};
const wechat = async (from, content) => {
  const ts = String(Math.floor(Date.now() / 1000)), nonce = 'n' + Math.random().toString(36).slice(2);
  const sig = createHash('sha1').update(['jeton-wechat', ts, nonce].sort().join('')).digest('hex');
  const xml = `<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName><CreateTime>${ts}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>${nonce}</MsgId></xml>`;
  const r = await fetch(`http://localhost:54402/wechat-events?timestamp=${ts}&nonce=${nonce}&signature=${sig}`, { method: 'POST', body: xml });
  const t = await r.text();
  return (/<Content><!\[CDATA\[([\s\S]*?)\]\]><\/Content>/.exec(t) || [])[1] || t;
};
const captured = () => readFileSync(CAPTURE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const verify = (secret, body, h) => h['CP-Signature'] === 'sha256=' + createHmac('sha256', secret).update(h['CP-Timestamp'] + '.' + body).digest('hex');

try {
  // ---------------------------------------------------------------- erreurs et en-têtes
  ok((await api('GET', '/v1/health')).status === 401, 'sans clé : 401');
  ok((await api('GET', '/v1/health', 'cp_live_' + 'n'.repeat(32))).status === 401, 'clé inconnue : 401');
  const me = await api('GET', '/v1/me', KEY_LIVE);
  ok(me.status === 200 && me.json.client.id === 'PLATX' && me.json.key.environment === 'live', '/v1/me');
  ok(me.headers.get('x-ratelimit-limit') === '60' && Number(me.headers.get('x-ratelimit-remaining')) <= 59, 'en-têtes X-RateLimit-*');
  ok((await api('POST', '/v1/demands', KEY_READ, { lines: [] }, { 'Idempotency-Key': 'a' })).status === 403, 'clé sans portée demands:write : 403');
  ok((await api('POST', '/v1/demands', KEY_LIVE, { lines: [] })).status === 422, 'sans Idempotency-Key : 422');
  const inv = await api('POST', '/v1/demands', KEY_LIVE, { currency: 'EUR', ship_to_country: 'FR', lines: [{ line_id: 'X', mpn: 'A', quantity: 0 }] }, { 'Idempotency-Key': 'inv' });
  ok(inv.status === 422 && inv.json.error.field === 'lines[X].quantity', 'ligne invalide : 422 avec le champ');
  ok((await api('GET', '/v1/demands/DEM-9999', KEY_LIVE)).status === 404, 'demande inconnue : 404');
  ok((await api('POST', '/jobs/tick', null)).status === 403, 'tâche planifiée sans secret : 403');
  ok((await api('POST', '/v1/sandbox/demands/DEM-1000/approve', KEY_LIVE)).status === 403, 'bac à sable refusé avec une clé cp_live_');

  // ---------------------------------------------------------------- bac à sable : cycle complet, sans aucun message
  const wh = await api('POST', '/v1/webhooks', KEY_TEST, { url: 'https://plateforme.example/hook-test', events: ['demand.validated', 'demand.offers_ready', 'demand.no_offer', 'demand.rejected'] });
  ok(wh.status === 201 && wh.json.signing_secret?.startsWith('whsec_'), 'webhook créé, secret affiché une fois');
  const rfqBody = { customer_reference: 'ADS-E2E-1', currency: 'EUR', ship_to_country: 'DE', lines: [{ line_id: 'L1', mpn: 'NE555DR', manufacturer: 'Texas Instruments', quantity: 1000 }] };
  const c1 = await api('POST', '/v1/demands', KEY_TEST, rfqBody, { 'Idempotency-Key': 'sbx-1' });
  ok(c1.status === 202 && c1.json.demands[0].status === 'pending_validation', 'bac à sable : RFQ créée (202, pending_validation)');
  const dS = c1.json.demands[0].id;
  const c1b = await api('POST', '/v1/demands', KEY_TEST, rfqBody, { 'Idempotency-Key': 'sbx-1' });
  ok(c1b.status === 202 && JSON.stringify(c1b.json) === JSON.stringify(c1.json), 'rejeu : même réponse');
  ok((await api('POST', '/v1/demands', KEY_TEST, { ...rfqBody, customer_reference: 'autre' }, { 'Idempotency-Key': 'sbx-1' })).status === 409, 'même clé, autre corps : 409');
  const ap = await api('POST', `/v1/sandbox/demands/${dS}/approve`, KEY_TEST);
  ok(ap.status === 200 && ap.json.status === 'open', 'bac à sable : validation simulée → open');
  const rp = await api('POST', `/v1/sandbox/demands/${dS}/respond`, KEY_TEST, { kind: 'quote', unit_price: 0.10, currency: 'USD', lead_time_days: 3, date_code: '2430' });
  ok(rp.status === 200 && rp.json.status === 'offers_ready' && rp.json.offers_count === 1, 'bac à sable : réponse simulée → offers_ready');
  const of = await api('GET', `/v1/demands/${dS}/offers`, KEY_TEST);
  const o = of.json.offers[0];
  ok(o && Number(o.unit_price) === 0.1012 && o.currency === 'EUR' && o.manufacturer.id === 'MFR-TI' && o.packaging === 'tape_reel' && o.source_category === 'broker_surplus', 'offre : 0,10 USD → 0,1012 EUR tout compris, fabricant, catégorie ' + JSON.stringify(o));
  ok(!/SBX|V-SBX|LOT-|sandbox-rfq-supplier|Fournisseur partenaire/.test(JSON.stringify(of.json)), 'offre : aucun élément du fournisseur');
  // Lecture agrégée : la RFQ entière en un appel.
  const rq = await api('GET', `/v1/rfqs/${c1.json.rfq_id}`, KEY_TEST);
  ok(rq.status === 200 && rq.json.status === 'offers_ready' && rq.json.lines_count === 1 && rq.json.customer_reference === 'ADS-E2E-1'
    && rq.json.lines[0].id === dS && rq.json.lines[0].line_id === 'L1' && JSON.stringify(rq.json.lines[0].offers) === JSON.stringify(of.json.offers),
    'GET /v1/rfqs/{id} : statut d\'ensemble et offres de la ligne en un appel');
  ok(rq.json.price_valid_until === o.price_valid_until && rq.json.status_counts.offers_ready === 1, 'RFQ : validité la plus proche et décompte');
  ok((await api('GET', '/v1/rfqs/RFQ-999999', KEY_TEST)).status === 404, 'RFQ inconnue : 404');
  const rl1 = await api('GET', '/v1/rfqs?customer_reference=ADS-E2E-1', KEY_TEST);
  ok(rl1.status === 200 && rl1.json.rfqs.length === 1 && rl1.json.rfqs[0].rfq_id === c1.json.rfq_id && !('lines' in rl1.json.rfqs[0]), 'GET /v1/rfqs : liste filtrée, sans les lignes');
  ok((await api('GET', '/v1/rfqs?status=open', KEY_TEST)).status === 422, 'GET /v1/rfqs : statut d\'ensemble inconnu (422)');
  await sleep(1500);
  const cap1 = captured();
  ok(!cap1.some((x) => x.kind === 'wechat'), 'bac à sable : aucun message WeChat (ni fournisseur, ni administrateur)');
  const hooks = cap1.filter((x) => x.kind === 'webhook' && x.url.endsWith('/hook-test'));
  const events = hooks.map((h) => JSON.parse(h.body).event);
  ok(events.includes('demand.validated') && events.includes('demand.offers_ready'), 'webhooks livrés : ' + events.join(', '));
  ok(hooks.every((h) => verify(wh.json.signing_secret, h.body, h.headers)), 'webhooks : signature HMAC vérifiée avec le secret');
  ok(hooks.every((h) => JSON.parse(h.body).customer_reference === 'ADS-E2E-1' && JSON.parse(h.body).sandbox === true), 'webhooks : référence client et drapeau sandbox');

  // ---------------------------------------------------------------- production : administrateur et fournisseurs dans WeChat
  const wh2 = await api('POST', '/v1/webhooks', KEY_LIVE, { url: 'https://plateforme.example/hook-live', events: ['demand.offers_ready'] });
  const c2 = await api('POST', '/v1/demands', KEY_LIVE, { customer_reference: 'ADS-E2E-2', currency: 'EUR', ship_to_country: 'FR',
    lines: [{ line_id: 'B7', mpn: 'E2ETEST555', quantity: 200, target_price: 0.40 }] }, { 'Idempotency-Key': 'live-1' });
  const dL = c2.json.demands[0].id;
  await sleep(1000);
  const opMsg = captured().filter((x) => x.kind === 'wechat' && x.to === 'oOPERATOR');
  ok(opMsg.some((m) => m.text.includes('[New RFQ ' + dL + ']') && m.text.includes('ADS-E2E-2') && m.text.includes('RSL1')), 'administrateur prévenu dans WeChat avec la fiche');
  ok(!captured().some((x) => x.kind === 'wechat' && x.to !== 'oOPERATOR'), 'avant validation : aucun message aux fournisseurs');
  const notOp = await wechat('oSUP1', `approve ${dL}`);
  ok(sql(`select status from public.demands where id = '${dL}'`) === 'pending_validation', 'un fournisseur ne peut pas valider (« approve » ignoré) : ' + notOp.slice(0, 40));
  const appr = await wechat('oOPERATOR', `approve ${dL}`);
  ok(appr.startsWith(`Approved ${dL}`), 'robot : « approve DEM-… » → ' + appr);
  await sleep(1500);
  const toSup = captured().filter((x) => x.kind === 'wechat' && x.to === 'oSUP1');
  ok(toSup.length === 1 && toSup[0].text.includes('【Central.Parts 新询价】' + dL) && toSup[0].text.includes('数量：200'), 'fournisseur prévenu dans WeChat');
  ok(!/PLATX|Plateforme|ADS-E2E|0\.4[^0-9]/.test(toSup[0].text), 'anonymat : ni plateforme, ni référence client, ni prix cible');
  ok(captured().some((x) => x.kind === 'wechat' && x.to === 'oSILENT' && !x.delivered), 'contact hors fenêtre de 48 h : échec');
  ok(captured().some((x) => x.to === 'oOPERATOR' && /Not delivered: RSL2/.test(x.text)), 'administrateur : échec signalé, renvoi proposé');
  ok(sql(`select notify_status || ' ' || coalesce(deadline_at::text, 'none') from public.demand_sellers where demand_id = '${dL}' and seller_id = 'RSL2'`) === 'failed none', 'échec : le délai de 48 h ne démarre pas');
  const q1 = await wechat('oSUP1', `报价 ${dL} 0.45 USD 5 2425`);
  ok(q1.includes('已收到报价 ' + dL), 'fournisseur : 报价 accepté → ' + q1.split('\n')[0]);
  const q2 = await wechat('oSUP1', `无货 ${dL}`);
  ok(q2.includes('您已回复过'), 'fournisseur : deuxième réponse refusée');
  ok((await wechat('oOPERATOR', `rfq ${dL}`)).includes('RSL1: sent · quoted'), 'robot : fiche à jour (rfq DEM-…)');
  ok((await wechat('oOPERATOR', 'rfq stats RSL1')).includes('1 RFQ received · 1 quoted'), 'robot : rfq stats');
  ok((await api('GET', `/v1/demands/${dL}`, KEY_LIVE)).json.status === 'open', 'plateforme : demande ouverte tant que RSL2 peut être relancé');
  // 48 h plus tard (horloge avancée en base) : la tâche planifiée clôt la demande.
  sql(`update public.demands set closes_at = now() - interval '1 minute' where id = '${dL}'`);
  const t = await api('POST', '/jobs/tick', null, undefined, { 'X-CP-Jobs-Secret': 'secret-des-taches' });
  ok(t.status === 200 && t.json.closed >= 1, 'tâche planifiée : clôture ' + JSON.stringify(t.json));
  const of2 = await api('GET', `/v1/demands/${dL}/offers`, KEY_LIVE);
  ok(of2.json.status === 'offers_ready' && of2.json.offers.length === 1 && Number(of2.json.offers[0].unit_price) === 0.4554 && of2.json.offers[0].ship_from === 'HK',
    'offres : 0,45 USD → 0,4554 EUR tout compris, expédié de HK');
  ok(!/RSL|V-80|SKU-E2E|LOT-E/.test(JSON.stringify(of2.json)), 'offres : aucun élément du fournisseur');
  await sleep(1500);
  const live = captured().filter((x) => x.kind === 'webhook' && x.url.endsWith('/hook-live'));
  ok(live.length === 1 && JSON.parse(live[0].body).event === 'demand.offers_ready' && verify(wh2.json.signing_secret, live[0].body, live[0].headers), 'webhook demand.offers_ready livré et signé');
  ok(captured().some((x) => x.to === 'oOPERATOR' && x.text.includes(`[RFQ ${dL}] closed: 1 offer(s)`)), 'administrateur prévenu de la clôture');

  // ---------------------------------------------------------------- API d'offres en direct (ADR 0024)
  const cat = await api('GET', '/v1/offers?mpn=e2etest555&qty=200', KEY_LIVE);
  const catOffers = cat.json.products?.[0]?.offers || [];
  ok(cat.status === 200 && cat.json.products.length === 1 && catOffers.length === 2 && cat.json.products[0].manufacturer.id === 'MFR-TI',
    'offres en direct : un produit (Texas Instruments, référentiel), deux fournisseurs pour E2ETEST555');
  ok(!/RSL|V-80|SKU-E2E|LOT-E|Fournisseur partenaire/.test(JSON.stringify(cat.json)), 'offres en direct : aucun élément du fournisseur');
  const usdOffer = catOffers.find((x) => x.currency === 'USD');
  ok(usdOffer && Number(usdOffer.quote.unit_price) === 0.55 && usdOffer.offer_id.startsWith('cpo_'), 'offres en direct : 0,50 USD + 10 % = 0,55 USD, identifiant opaque');
  const one = await api('GET', `/v1/offers/${usdOffer.offer_id}?qty=300`, KEY_LIVE);
  ok(one.status === 200 && Number(one.json.quote.extended_price) === 165, 'détail d\'une offre : 300 × 0,55 = 165');
  ok((await api('GET', '/v1/offers', KEY_LIVE)).status === 422, 'offres en direct : mpn obligatoire (422)');
  const bom = await api('POST', '/v1/offers/search', KEY_LIVE, { lines: [{ line_id: 'A', mpn: 'E2ETEST555', quantity: 200 }, { line_id: 'B', mpn: 'INCONNU' }] });
  ok(bom.status === 200 && bom.json.lines[0].products[0].offers.length === 2 && bom.json.lines[1].products.length === 0, 'nomenclature en un appel');
  const dk = await api('GET', '/compat/digikey/products/v4/search/E2ETEST555/productdetails', KEY_LIVE, undefined, { 'X-DIGIKEY-Locale-Currency': 'USD' });
  ok(dk.status === 200 && dk.json.Product.ManufacturerProductNumber === 'E2ETEST555' && dk.json.Product.ProductVariations.length === 1
    && dk.json.Product.ProductVariations[0].StandardPricing[0].UnitPrice === 0.55, 'compatible DigiKey : productdetails (offre CNH écartée en USD)');
  ok((await api('GET', '/compat/digikey/products/v4/search/INCONNU/productdetails', KEY_LIVE)).json.StatusCode === 404, 'compatible DigiKey : 404 au format DigiKey');
  const dkp = await api('GET', '/compat/digikey/products/v4/search/E2ETEST555/pricing', KEY_LIVE, undefined, { 'X-DIGIKEY-Locale-Currency': 'USD' });
  ok(dkp.status === 200 && dkp.json.ProductPricings[0].ProductVariations[0].StandardPricing[0].BreakQuantity === 1
    && dkp.json.ProductPricings[0].ProductUrl === 'https://central.parts/recherche/?q=E2ETEST555', 'compatible DigiKey : ProductPricing');
  ok((await api('GET', '/compat/digikey/products/v4/search/E2ETEST555/pricing?excludeMarketplace=true', KEY_LIVE)).status === 404, 'compatible DigiKey : excludeMarketplace écarte les offres de broker');
  const dkw = await api('POST', '/compat/digikey/products/v4/search/keyword', KEY_LIVE, { Keywords: 'E2ETEST555', Limit: 10 }, { 'X-DIGIKEY-Locale-Currency': 'CNH' });
  ok(dkw.status === 200 && dkw.json.ProductsCount === 1 && dkw.json.Products[0].ProductVariations[0].StandardPricing[0].UnitPrice === 3.3, 'compatible DigiKey : keyword, en CNH');
  const ti = await api('GET', '/compat/ti/v2/store/products/E2ETEST555?currency=USD', KEY_LIVE);
  ok(ti.status === 200 && ti.json.tiPartNumber === 'E2ETEST555' && ti.json.pricing[0].priceBreaks[0].price === 0.55, 'compatible TI : pricing[].priceBreaks[]');
  const sbx = await api('GET', '/v1/offers?mpn=NE555DR', KEY_TEST);
  ok(sbx.json.products[0].offers.length === 1 && sbx.json.products[0].offers[0].stock === 25000 && (await api('GET', '/v1/offers?mpn=NE555DR', KEY_LIVE)).json.products.length === 0,
    'bac à sable : stock de test avec cp_test_, invisible avec cp_live_');
  ok(Number(sql(`select coalesce(sum(views), 0) from app.offer_views where seller_id = 'RSL1'`)) >= 4, 'compteur de consultations du fournisseur');

  // ---------------------------------------------------------------- refus et annulation
  const c3 = await api('POST', '/v1/demands', KEY_LIVE, { currency: 'USD', ship_to_country: 'IT', lines: [{ mpn: 'E2ETEST555', quantity: 5 }, { mpn: 'E2ETEST555', quantity: 6 }] }, { 'Idempotency-Key': 'live-2' });
  const [dR, dC] = c3.json.demands.map((x) => x.id);
  ok((await wechat('oOPERATOR', `reject ${dR}`)).includes('reason is required'), 'robot : refus sans motif demandé');
  ok((await wechat('oOPERATOR', `reject ${dR} Quantité trop faible`)).startsWith('Rejected'), 'robot : refus avec motif');
  const r3 = await api('GET', `/v1/demands/${dR}`, KEY_LIVE);
  ok(r3.json.status === 'rejected' && r3.json.rejected_reason === 'Quantité trop faible', 'plateforme : refus et motif visibles');
  const can = await api('POST', `/v1/demands/${dC}/cancel`, KEY_LIVE);
  ok(can.status === 200 && can.json.status === 'cancelled', 'plateforme : annulation');
  ok((await api('POST', `/v1/demands/${dC}/cancel`, KEY_LIVE)).status === 409, 'annulation deux fois : 409');
  const list = await api('GET', '/v1/demands?customer_reference=ADS-E2E-2', KEY_LIVE);
  ok(list.json.demands.length === 1 && list.json.demands[0].id === dL, 'liste filtrée par customer_reference');
  ok(!captured().some((x) => x.kind === 'blocked'), 'aucun appel réseau hors simulation');
} finally {
  // Groupe entier : le lanceur de Deno peut avoir un processus enfant.
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { p.kill(); } }
  try { execSync(`${P} -c 'drop database if exists cp_e2e'`, { stdio: 'ignore' }); } catch { /* base déjà fermée */ }
}
console.log(`\n${n - bad}/${n} vérifications de bout en bout réussies`);
process.exit(bad ? 1 : 0);
