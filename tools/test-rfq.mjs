// Route RFQ des plateformes (ADR 0023), logique sans réseau : commandes WeChat du fournisseur et de l'administrateur,
// textes envoyés (anonymat, échéance à Pékin et à Paris, langue), erreurs de l'API, empreintes et signature des webhooks.
// Les règles en base (48 h, notation, clôture, idempotence, plafond, droits) : supabase/checks/16_route_rfq.sql.
// La diffusion avec sendText simulé : tools/test-rfq-dispatch.ts (Deno).
// Usage : node tools/test-rfq.mjs
import { readFileSync } from 'node:fs';
import * as Q from '../supabase/functions/_shared/rfq.js';
import * as R from '../supabase/functions/_shared/robot-texts.js';

let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };
const eq = (got, want, label) => ok(JSON.stringify(got) === JSON.stringify(want), label + ' : ' + JSON.stringify(got));
const CJK = /[㐀-鿿＀-￯　-〿]/;

// ---------------------------------------------------------------- commandes du fournisseur
eq(Q.parseSupplierRfq('报价 DEM-0431 0.52 USD 7 2425'), { kind: 'quote', ref: 'DEM-0431', price: 0.52, currency: 'USD', lead: 7, dateCode: '2425', lot: null }, 'fournisseur : 报价 complet');
eq(Q.parseSupplierRfq('报价 dem-0431 0.52 usd 7天 2425 lot LOT-0187').lot, 'LOT-0187', 'fournisseur : lot précisé');
eq(Q.parseSupplierRfq('报价DEM-0431，0.52，RMB，7，DC2425').currency, 'CNH', 'fournisseur : RMB → CNH, virgules chinoises');
eq(Q.parseSupplierRfq('报价DEM-0431，0.52，RMB，7，DC2425').dateCode, '2425', 'fournisseur : préfixe DC retiré');
eq(Q.parseSupplierRfq('报价 DEM-0431 0.52 USD 7'), { kind: 'quote', ref: 'DEM-0431', price: 0.52, currency: 'USD', lead: 7, dateCode: null, lot: null }, 'fournisseur : date code facultatif (celui du lot)');
eq(Q.parseSupplierRfq('报价 DEM-0431'), { kind: 'help', ref: 'DEM-0431' }, 'fournisseur : 报价 incomplet → aide');
eq(Q.parseSupplierRfq('报价 DEM-0431 abc USD 7').kind, 'help', 'fournisseur : prix illisible → aide');
eq(Q.parseSupplierRfq('quote DEM-0431 1.2 EUR 3 2401').kind, 'quote', 'fournisseur : mot-clé anglais');
eq(Q.parseSupplierRfq('无货 DEM-0431'), { kind: 'decline', ref: 'DEM-0431' }, 'fournisseur : 无货');
eq(Q.parseSupplierRfq('no stock DEM-0431').kind, 'decline', 'fournisseur : no stock');
eq(Q.parseSupplierRfq('确认 PR-0001'), null, 'fournisseur : commande de demande d\'achat laissée à son traitement');
eq(Q.parseSupplierRfq('你好'), null, 'fournisseur : message libre non interprété');

// ---------------------------------------------------------------- commandes de l'administrateur
eq(Q.parseOperatorRfq('rfq'), { cmd: 'list' }, 'administrateur : rfq');
eq(Q.parseOperatorRfq('rfq dem-1042'), { cmd: 'show', ref: 'DEM-1042' }, 'administrateur : fiche');
eq(Q.parseOperatorRfq('rfq stats org-0101'), { cmd: 'stats', org: 'ORG-0101' }, 'administrateur : stats');
eq(Q.parseOperatorRfq('approve DEM-1042'), { cmd: 'approve', ref: 'DEM-1042', only: null }, 'administrateur : approve');
eq(Q.parseOperatorRfq('approve DEM-1042 only ORG-0101,ORG-0105').only, ['ORG-0101', 'ORG-0105'], 'administrateur : approve only');
eq(Q.parseOperatorRfq('reject DEM-1042 Référence hors périmètre'), { cmd: 'reject', ref: 'DEM-1042', reason: 'Référence hors périmètre' }, 'administrateur : reject avec motif');
eq(Q.parseOperatorRfq('reject DEM-1042').reason, '', 'administrateur : reject sans motif (refusé ensuite)');
eq(Q.parseOperatorRfq('resend DEM-1042 ORG-0101'), { cmd: 'resend', ref: 'DEM-1042', org: 'ORG-0101' }, 'administrateur : resend');
eq(Q.parseOperatorRfq('approve ORG-0101'), null, 'administrateur : approve ORG-… laissé à l\'approbation des sociétés');
eq(Q.parseOperatorRfq('pending'), null, 'administrateur : autres commandes inchangées');

// ---------------------------------------------------------------- textes au fournisseur
const card = { ref: 'DEM-1042', mpn: 'NE555DR', manufacturer: 'Texas Instruments', qty: 2000, dc_min: '2420', ship_to: 'DE' };
const deadline = '2026-11-05T09:00:00Z';
const msg = R.rfqSupplierText(card, deadline);
ok(msg.startsWith('【Central.Parts 新询价】DEM-1042'), 'fournisseur : en-tête chinois d\'abord');
ok(msg.includes('型号：NE555DR') && msg.includes('数量：2000') && msg.includes('最低批号：2420'), 'fournisseur : référence, quantité, date code minimum');
ok(msg.includes('德国'), 'fournisseur : pays de livraison en chinois');
ok(msg.includes('11月5日 17:00（北京时间）') && msg.includes('11月5日 10:00（巴黎时间）'), 'fournisseur : échéance à Pékin et à Paris ' + msg.split('\n')[3]);
ok(msg.includes('报价 DEM-1042 单价 币种 交期天数 批号') && msg.includes('无货 DEM-1042'), 'fournisseur : comment répondre');
ok(msg.includes('超过截止时间的回复无效'), 'fournisseur : règle des 48 h annoncée');
ok(msg.includes('https://central.parts/depot/'), 'fournisseur : lien vers /depot/');
ok(/Reply by 5 Nov 17:00 China time · 5 Nov 10:00 Paris time/.test(msg), 'fournisseur : ligne anglaise avec l\'échéance');
ok(new TextEncoder().encode(msg).length < 2048, 'fournisseur : message de moins de 2 048 octets (limite WeChat)');
// Anonymat : la fiche fournisseur ne contient ni plateforme ni référence client ; même si un appelant en ajoutait,
// le texte n'utilise que les champs connus.
const leaky = { ...card, client: 'Plateforme Alpha', customer_reference: 'ADS-SECRET', target_price: 0.31 };
const leakyMsg = R.rfqSupplierText(leaky, deadline);
ok(!/Plateforme Alpha|ADS-SECRET|0\.31/.test(leakyMsg), 'anonymat : ni plateforme, ni référence client, ni prix cible dans le message');
const rem = R.rfqReminderText({ ...card, deadline_at: deadline });
ok(rem.includes('剩余12小时') && rem.includes('DEM-1042'), 'rappel 36 h : « 剩余12小时 »');
ok(!/Plateforme|ADS-/.test(R.rfqReminderText({ ...leaky, deadline_at: deadline })), 'anonymat : rappel');
ok(R.rfqCancelledText('DEM-1042').includes('已取消'), 'annulation : texte chinois');
ok(R.rfqAnswerErrorText('DEM-1042', 'CP410').includes('已过回复截止时间'), 'réponse tardive : refus expliqué');
ok(R.rfqAnswerErrorText('DEM-1042', 'CP409', 'quoted').includes('您已回复过'), 'deuxième réponse : refus expliqué');
ok(R.rfqAnswerErrorText('DEM-1042', 'CP409', 'cancelled').includes('已结束'), 'demande close : refus expliqué');
ok(R.rfqAnswerErrorText('DEM-1042', '22023', 'currency').includes('EUR、USD、CNH、HKD、GBP、JPY'), 'devise refusée : liste des devises');
ok(R.rfqAnswerErrorText('DEM-1042', '22023', 'date_code').includes('请提供批号'), 'date code manquant : demandé');
ok(R.rfqAnswerErrorText('DEM-1042', 'P0002').includes('未找到询价'), 'contact d\'une autre société : demande inconnue');
ok(R.rfqQuoteOkText({ ref: 'DEM-1042' }, { price: 0.52, currency: 'USD', lead: 7, dateCode: '2425' }).includes('已收到报价 DEM-1042'), 'confirmation du prix');
ok(R.rfqDeclineOkText('DEM-1042').includes('无货'), 'confirmation 无货');

// ---------------------------------------------------------------- textes à l'administrateur : anglais seul
const opCard = { id: 'DEM-1042', status: 'pending_validation', client: 'ORG-0150 Adesio', customer_reference: 'ADS-42', mpn: 'NE555DR',
  manufacturer: 'Texas Instruments', qty: 2000, dc_min: '2420', ship_to: 'DE', currency: 'EUR', target_price: 0.3, candidates: ['ORG-0101', 'ORG-0105'] };
const op = R.rfqOperatorCard(opCard, 'New RFQ');
ok(!CJK.test(op), 'administrateur : fiche sans caractère chinois');
ok(op.includes('ORG-0150 Adesio') && op.includes('ADS-42') && op.includes('Matching suppliers: 2 (ORG-0101, ORG-0105)'), 'administrateur : client, référence, appariés');
ok(op.includes('approve DEM-1042') && op.includes('reject DEM-1042 reason'), 'administrateur : commandes rappelées');
ok(!CJK.test(R.rfqOperatorListText([opCard])) && R.rfqOperatorListText([]).startsWith('No RFQ'), 'administrateur : liste');
ok(R.rfqDispatchText('DEM-1042', { closed: true, sent: [], failed: [] }).includes('RFQ_WECHAT_OPEN'), 'administrateur : « diffusion fermée »');
const disp = R.rfqDispatchText('DEM-1042', { closed: false, sent: ['ORG-0101'], failed: ['ORG-0105'], sandbox: false });
ok(disp.includes('sent to 1') && disp.includes('resend DEM-1042 ORG-') && disp.includes('deadline has not started'), 'administrateur : échec d\'envoi et renvoi');
ok(!CJK.test(disp), 'administrateur : résumé d\'envoi en anglais');
ok(R.rfqStatsText({ org: 'ORG-0101', received: 4, quoted: 2, declined: 1, expired: 1, treatment_rate: 0.75, counts_for_ranking: false, expired_demands: ['DEM-1001'] }).includes('Handling rate 75 %'), 'administrateur : taux de traitement');
for (const c of ['rfq', 'approve DEM-1001', 'reject DEM-1001 reason', 'resend DEM-1001', 'rfq stats ORG-0101']) {
  ok(R.operatorHelpText().includes(c), 'aide : commande « ' + c + ' » listée');
}
ok(!CJK.test(R.operatorHelpText()), 'aide : anglais seul');
ok(R.rfqClosedText({ id: 'DEM-1', status: 'offers', offers: 2, no_margin: 1 }).includes('no margin'), 'administrateur : bid sans marge signalé');

// ---------------------------------------------------------------- constantes distinctes
ok(Q.RFQ_RESPONSE_HOURS === 48 && Q.WECHAT_FREE_TEXT_WINDOW_HOURS === 48 && Q.RFQ_REMINDER_HOURS === 36, 'constantes : délai 48 h, fenêtre WeChat 48 h, rappel 36 h');
const mig = readFileSync(new URL('../supabase/migrations/20261102000020_route_rfq.sql', import.meta.url), 'utf8');
ok(/rfq_response_hours\(\) returns int language sql immutable as \$\$ select 48 \$\$/.test(mig), 'base : même délai de 48 h');
ok(/rfq_reminder_hours\(\) returns int language sql immutable as \$\$ select 36 \$\$/.test(mig), 'base : même rappel à 36 h');

// ---------------------------------------------------------------- erreurs de l'API
eq(Q.apiError({ code: 'CP401', message: 'x' }).status, 401, 'API : clé refusée → 401');
eq(Q.apiError({ code: 'P0002', message: 'x' }).status, 404, 'API : inconnue → 404');
eq(Q.apiError({ code: 'CP409', message: 'x' }).status, 409, 'API : conflit → 409');
const e422 = Q.apiError({ code: '22023', message: 'Quantité invalide', details: 'lines[L1].quantity' });
eq([e422.status, e422.body.error.field], [422, 'lines[L1].quantity'], 'API : 422 avec le champ');
const e429 = Q.apiError({ code: 'CP429', message: 'x', details: '17' });
eq([e429.status, e429.headers['Retry-After']], [429, '17'], 'API : 429 avec Retry-After');
const e500 = Q.apiError({ code: 'XX000', message: 'secret interne' });
ok(e500.status === 500 && !JSON.stringify(e500.body).includes('secret interne'), 'API : erreur interne sans détail');

// ---------------------------------------------------------------- clés et webhooks
eq(Q.bearerKey('Bearer cp_live_0123456789abcdef0123'), 'cp_live_0123456789abcdef0123', 'clé : Bearer cp_live_');
eq(Q.bearerKey('Bearer cp_test_0123456789abcdef0123'), 'cp_test_0123456789abcdef0123', 'clé : Bearer cp_test_');
eq(Q.bearerKey('Bearer sk_live_0123456789abcdef'), null, 'clé : autre préfixe refusé');
eq(Q.bearerKey('cp_live_0123456789abcdef'), null, 'clé : sans Bearer refusée');
ok((await Q.sha256Hex('a')) === 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb', 'empreinte : valeur de référence sha256("a")');
const s1 = await Q.webhookSecret('cle-maitre', 'WHK-0001'), s2 = await Q.webhookSecret('cle-maitre', 'WHK-0002');
ok(s1.startsWith('whsec_') && s1 !== s2 && s1 === await Q.webhookSecret('cle-maitre', 'WHK-0001'), 'webhook : secret dérivé, stable, propre à l\'abonnement');
const body = JSON.stringify({ event: 'demand.offers_ready', demand_id: 'DEM-1042' });
const h = await Q.signWebhook(s1, body, 1762160000);
ok(h['CP-Timestamp'] === '1762160000' && /^sha256=[0-9a-f]{64}$/.test(h['CP-Signature']), 'webhook : en-têtes CP-Timestamp et CP-Signature');
ok(await Q.verifyWebhook(s1, body, h, 1762160100), 'webhook : signature vérifiée');
ok(!(await Q.verifyWebhook(s2, body, h, 1762160100)), 'webhook : autre secret refusé');
ok(!(await Q.verifyWebhook(s1, body + ' ', h, 1762160100)), 'webhook : corps modifié refusé');
ok(!(await Q.verifyWebhook(s1, body, h, 1762160000 + 301)), 'webhook : horodatage trop ancien refusé');
eq([Q.retryDelayMinutes(0), Q.retryDelayMinutes(3), Q.retryDelayMinutes(20)], [1, 8, 120], 'webhook : délai croissant, 2 h au plus');

// ---------------------------------------------------------------- fonction rfq : contrat
const fn = readFileSync(new URL('../supabase/functions/rfq/index.ts', import.meta.url), 'utf8');
for (const route of ['/v1/demands', '/v1/webhooks', '/v1/me', '/v1/health', '/jobs/tick', '/v1/sandbox/demands']) ok(fn.includes(route), 'fonction rfq : route ' + route);
ok(/demands:write/.test(fn) && /Idempotency-Key header is required/.test(fn) && /, 202\)/.test(fn), 'fonction rfq : portée, Idempotency-Key, 202');
ok(/X-RateLimit-Limit/.test(fn) && /X-RateLimit-Remaining/.test(fn) && /X-RateLimit-Reset/.test(fn), 'fonction rfq : en-têtes X-RateLimit-*');
ok(/Sandbox endpoints need a cp_test_ key/.test(fn), 'fonction rfq : bac à sable réservé aux clés de test');
ok(/RFQ_JOBS_SECRET/.test(fn) && /x-cp-jobs-secret/.test(fn), 'fonction rfq : tâche planifiée protégée');
const dep = readFileSync(new URL('./deploy-functions.sh', import.meta.url), 'utf8');
ok(/^ALL=".*\brfq\b/m.test(dep) && /^PUBLIC=".*\brfq\b/m.test(dep) && /^SHARED=".*\brfq\b/m.test(dep), 'déploiement : rfq déclarée, sans jeton Supabase, avec _shared');

console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
