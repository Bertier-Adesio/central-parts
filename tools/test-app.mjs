#!/usr/bin/env node
// Teste de bout en bout l'API simulée de la maquette (site/app/js), sans navigateur.
// Usage : node tools/test-app.mjs   (aucune dépendance). Sort en erreur au premier échec.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function boot() {
  const ctx = { console, localStorage: { getItem: () => null, setItem: () => {} } };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['registry', 'core', 'api']) vm.runInContext(readFileSync(join(ROOT, 'site/app/js', f + '.js'), 'utf8'), ctx, { filename: f + '.js' });
  ctx.CP.endpoints = ctx.CP_ENDPOINTS;
  return ctx.CP;
}

let failures = 0, checks = 0;
function ok(cond, msg) { checks++; if (!cond) { failures++; console.error('  ✗ ' + msg); } }
function as(CP, id) { CP.actor = CP.ACTORS.find((a) => a.id === id); }
function call(CP, actor, method, path, body, expect = [200, 201]) {
  as(CP, actor);
  const r = CP.api(method, path, body);
  ok(expect.includes(r.status), `${actor} ${method} ${path} → ${r.status} ${r.error || ''}`);
  return r.data;
}
function scenario(name, fn) { const CP = boot(); console.log('• ' + name); fn(CP); }

// Chaque endpoint du registre a une implémentation.
scenario('registre complet', (CP) => {
  for (const e of CP.endpoints) ok(CP.implemented(e.id), 'endpoint sans implémentation : ' + e.id);
  ok(CP.endpoints.length > 40, 'registre chargé');
});

scenario('nomenclature, enchère, transaction avec laboratoire, acceptation, paiement', (CP) => {
  const bom = call(CP, 'buyer', 'POST', '/v1/boms', { name: 't.csv', delivery: 'Intégrateur, Shenzhen (Chine)', lines: [{ mpn: 'STM32G071RBT6', qty: 100 }, { mpn: 'MC68HC11E1CFNE2', qty: 250 }, { mpn: 'INCONNU-1', qty: 5 }] });
  ok(bom.lines[0].offer === 'inventory' && bom.lines[1].offer === 'opportunity' && bom.lines[2].offer === 'opportunity', 'répartition des lignes');
  call(CP, 'buyer', 'POST', '/v1/inventory/orders', { bomId: bom.id });
  call(CP, 'buyer', 'POST', '/v1/inventory/orders', { bomId: bom.id }, [409]);
  const dem = call(CP, 'buyer', 'POST', '/v1/demands', { bomId: bom.id, mpn: 'MC68HC11E1CFNE2', qty: 250, delivery: bom.delivery });
  ok(dem.status === 'auction', 'demande en enchère');
  call(CP, 'buyer', 'POST', '/v1/demands', { bomId: bom.id, mpn: 'MC68HC11E1CFNE2', qty: 250 }, [409]);
  // Le vendeur ne voit ni l'acheteur ni l'adresse.
  const seen = call(CP, 'seller3', 'GET', '/v1/demands/' + dem.id);
  ok(!seen.buyerId && !seen.delivery && seen.zone === 'Chine', 'anonymisation de la demande');
  call(CP, 'seller2', 'GET', '/v1/demands/' + dem.id, null, [404]);
  // V-1 : lot de 90 pièces, insuffisant ; V-3 : lot complet.
  call(CP, 'seller1', 'POST', `/v1/demands/${dem.id}/bids`, { lotId: 'LOT-104', net: 18 }, [422]);
  const mine = call(CP, 'seller3', 'POST', `/v1/demands/${dem.id}/bids`, { lotId: 'LOT-103', net: 22, leadDays: 4 });
  ok(mine.rank === 1, 'rang du vendeur');
  call(CP, 'buyer', 'POST', `/v1/demands/${dem.id}/close`, {}, [403]);
  call(CP, 'ops1', 'POST', `/v1/demands/${dem.id}/close`, {});
  const offers = call(CP, 'buyer', 'GET', `/v1/demands/${dem.id}/offers`);
  ok(offers.length === 1 && offers[0].seller === 'V-3' && offers[0].net === undefined, 'offre consolidée sans prix net');
  const tx = call(CP, 'buyer', 'POST', `/v1/offers/${offers[0].id}/accept`, { labLevel: 2, inspection: 10, counter: 10 });
  ok(tx.status === 'to_sign_buyer' && tx.total === CP.round(offers[0].unit * 250 + 420), 'montant de la transaction');
  call(CP, 'seller3', 'POST', `/v1/transactions/${tx.id}/signatures`, {}, [409]);
  call(CP, 'buyer', 'POST', `/v1/transactions/${tx.id}/signatures`, {});
  call(CP, 'seller3', 'POST', `/v1/transactions/${tx.id}/signatures`, {});
  call(CP, 'bank', 'POST', '/v1/webhooks/bank/incoming-transfer', { reference: tx.id, amount: 1 }, [422]);
  call(CP, 'bank', 'POST', '/v1/webhooks/bank/incoming-transfer', { reference: tx.id, amount: tx.total });
  call(CP, 'seller3', 'POST', `/v1/transactions/${tx.id}/shipments`, { carrier: 'DHL', tracking: 'X1' });
  const lc = call(CP, 'lab', 'GET', '/v1/lab/cases').find((c) => c.txId === tx.id);
  ok(lc && lc.status === 'in_transit', 'dossier laboratoire en transit');
  call(CP, 'lab', 'POST', `/v1/lab/cases/${lc.id}/reship`, { tracking: 'R1' }, [404]);
  call(CP, 'lab', 'POST', `/v1/lab/cases/${lc.id}/reception`, { qty: 250 });
  call(CP, 'lab', 'POST', `/v1/lab/cases/${lc.id}/certificate`, { verdict: 'pass', results: { visual: 'pass' } }, [422]);
  call(CP, 'lab', 'POST', `/v1/lab/cases/${lc.id}/certificate`, { verdict: 'pass', results: { visual: 'pass', marking: 'pass', xray: 'pass' } });
  call(CP, 'lab', 'POST', `/v1/lab/cases/${lc.id}/reshipment`, { tracking: 'R1' });
  as(CP, 'ops1'); CP.system('POST', '/v1/webhooks/carrier', { txId: tx.id });
  call(CP, 'buyer', 'POST', `/v1/transactions/${tx.id}/inspection`, { decision: 'accept' });
  const orders = call(CP, 'ops1', 'GET', '/v1/payment-orders').filter((o) => o.txId === tx.id);
  ok(orders.length === 1 && orders[0].type === 'release', 'ordre de paiement créé');
  const o = orders[0];
  ok(Math.abs(o.amount - tx.total) < 0.01, 'ordre = montant cantonné');
  call(CP, 'ops1', 'POST', `/v1/payment-orders/${o.id}/approvals`, {});
  call(CP, 'ops1', 'POST', `/v1/payment-orders/${o.id}/approvals`, {}, [409]);
  call(CP, 'ops1', 'POST', `/v1/payment-orders/${o.id}/transmit`, {}, [409]);
  call(CP, 'ops2', 'POST', `/v1/payment-orders/${o.id}/approvals`, {});
  call(CP, 'ops2', 'POST', `/v1/payment-orders/${o.id}/transmit`, {});
  const before = call(CP, 'bank', 'GET', '/v1/escrow').balance;
  call(CP, 'bank', 'POST', `/bank/v1/orders/${o.id}/execution`, {});
  const after = call(CP, 'bank', 'GET', '/v1/escrow').balance;
  ok(Math.abs(before - after - o.amount) < 0.01, 'débit du compte dédié');
  ok(call(CP, 'buyer', 'GET', '/v1/transactions/' + tx.id).status === 'released', 'transaction soldée');
});

scenario('rejet partiel, retour, contestation, médiation', (CP) => {
  call(CP, 'ops1', 'POST', '/v1/demands/DEM-0427/close', {});
  const offers = call(CP, 'buyer', 'GET', '/v1/demands/DEM-0427/offers');
  ok(offers.length === 2 && offers[0].unit < offers[1].unit, 'offres classées');
  const tx = call(CP, 'buyer', 'POST', `/v1/offers/${offers[1].id}/accept`, { labLevel: 0 });
  call(CP, 'buyer', 'POST', `/v1/transactions/${tx.id}/signatures`, {});
  call(CP, 'seller1', 'POST', `/v1/transactions/${tx.id}/signatures`, {});
  call(CP, 'bank', 'POST', '/v1/webhooks/bank/incoming-transfer', { reference: tx.id, amount: tx.total });
  call(CP, 'seller1', 'POST', `/v1/transactions/${tx.id}/shipments`, { tracking: 'S9' });
  ok(call(CP, 'buyer', 'GET', '/v1/transactions/' + tx.id).status === 'to_buyer', 'livraison directe sans laboratoire');
  as(CP, 'ops1'); CP.system('POST', '/v1/webhooks/carrier', { txId: tx.id });
  call(CP, 'buyer', 'POST', `/v1/transactions/${tx.id}/inspection`, { decision: 'reject', reason: 'Autre', qty: 10 }, [422]);
  call(CP, 'buyer', 'POST', `/v1/transactions/${tx.id}/inspection`, { decision: 'reject', reason: 'Écart de quantité', qty: 50 });
  call(CP, 'buyer', 'POST', `/v1/transactions/${tx.id}/returns`, { tracking: 'RET1' });
  call(CP, 'seller1', 'POST', `/v1/transactions/${tx.id}/counter-inspection`, { decision: 'contest', comment: 'Quantité complète à l\'envoi' });
  const t = call(CP, 'ops1', 'GET', '/v1/transactions/' + tx.id);
  ok(t.status === 'dispute', 'litige ouvert');
  call(CP, 'ops1', 'POST', `/v1/disputes/${t.disputeId}/decision`, { winner: 'buyer', basis: 'Expertise' });
  const orders = call(CP, 'ops1', 'GET', '/v1/payment-orders').filter((o) => o.txId === tx.id);
  ok(orders.length === 2, 'paiement partiel et remboursement');
  const sum = orders.reduce((s, o) => s + o.amount, 0);
  ok(Math.abs(sum - tx.total) < 0.01, 'les ordres soldent le montant cantonné');
  for (const o of orders) {
    call(CP, 'ops1', 'POST', `/v1/payment-orders/${o.id}/approvals`, {});
    call(CP, 'ops2', 'POST', `/v1/payment-orders/${o.id}/approvals`, {});
    call(CP, 'ops1', 'POST', `/v1/payment-orders/${o.id}/transmit`, {});
    call(CP, 'bank', 'POST', `/bank/v1/orders/${o.id}/execution`, {});
  }
  ok(call(CP, 'buyer', 'GET', '/v1/transactions/' + tx.id).status === 'closed_partial', 'règlement partiel soldé');
});

scenario('contrefaçon au laboratoire, délais dépassés', (CP) => {
  // TX-0041 est au laboratoire dans les données de démonstration.
  const lc = call(CP, 'lab', 'GET', '/v1/lab/cases').find((c) => c.txId === 'TX-0041');
  call(CP, 'lab', 'POST', `/v1/lab/cases/${lc.id}/certificate`, { verdict: 'counterfeit', results: { visual: 'fail', marking: 'fail' } });
  ok(call(CP, 'seller3', 'GET', '/v1/transactions/TX-0041').status === 'lab_failed', 'verdict défavorable');
  for (let i = 0; i < 10; i++) CP.advanceDay();
  const t = call(CP, 'ops1', 'GET', '/v1/transactions/TX-0041');
  ok(t.status === 'settling' && t.orders[0].type === 'refund', 'remboursement réputé accepté');
  ok(t.orders[0].lines.some((l) => l.to === 'L1'), 'laboratoire payé pour son certificat');
  // Les enchères de démonstration se clôturent seules après 2 jours ouvrés.
  ok(call(CP, 'ops1', 'GET', '/v1/demands/DEM-0428').status === 'offers' || call(CP, 'ops1', 'GET', '/v1/demands/DEM-0428').status === 'no_offer', 'clôture automatique');
});

scenario('KYB et droits', (CP) => {
  const org = call(CP, 'public', 'POST', '/v1/organizations', { type: 'seller', name: 'Test SARL', country: 'France' });
  call(CP, 'public', 'POST', `/v1/organizations/${org.id}/kyb`, { iban: 'FR76', signatory: 'X', beneficiaries: 'Y' });
  call(CP, 'ops1', 'POST', `/v1/organizations/${org.id}/kyb/decision`, { decision: 'validated' }, [422]);
  call(CP, 'ops1', 'POST', `/v1/organizations/${org.id}/kyb/decision`, { decision: 'validated', sanctionsChecked: true });
  call(CP, 'public', 'GET', '/v1/transactions', null, [403]);
  call(CP, 'seller1', 'GET', '/v1/transactions/TX-0041', null, [404]);
  call(CP, 'buyer', 'GET', '/v1/inexistant', null, [404]);
  const imp = call(CP, 'seller1', 'POST', '/v1/stocklists', { csv: 'mpn,manufacturer,quantity,date_code\nXC2S50-5TQ144C,AMD Xilinx,400,2009/2012\nABC123,Foo,10,2020' });
  ok(imp.created.length === 2 && imp.possibleDuplicates.length === 1, 'import et détection de doublon');
});

scenario('format broker, SFTP, date code', (CP) => {
  const csv = 'Manufacturer,SKU,MPN,Product URL,Unit Price,Quantity,Price per 10 pcs,Price per 100 pcs,"Price per 1,000 pcs"\n' +
    'AMD Xilinx,HB-1,XC2S50-5TQ144C,https://exemple.invalid/1,"1,250.00",900,1200,1100,"1,000.50"\n' +
    'NXP,HB-2,,https://exemple.invalid/2,3,10,,,\n' +
    'NXP,HB-3,MC68HC11E1CFNE2,https://exemple.invalid/3,19.5,300,19,18,17';
  const job = call(CP, 'seller2', 'POST', '/v1/stocklists', { format: 'broker', csv });
  ok(job.created.length === 2 && job.rejected.length === 1 && job.missingDateCode === 2, 'rapport d\'import broker');
  const lot = call(CP, 'seller2', 'GET', '/v1/lots/' + job.created[0]);
  ok(lot.sku === 'HB-1' && lot.price === 1250 && lot.tiers[1000] === 1000.5 && lot.tiers[10] === 1200, 'prix et paliers lus, virgules des milliers comprises');
  const again = call(CP, 'seller2', 'POST', '/v1/stocklists', { csv: 'SKU;MPN;Quantity\nHB-1;XC2S50-5TQ144C;450' });
  ok(again.updated.length === 1 && again.created.length === 0 && call(CP, 'seller2', 'GET', '/v1/lots/' + job.created[0]).qty === 450, 'mise à jour par SKU, séparateur point-virgule');
  call(CP, 'seller2', 'GET', '/v1/stocklists/' + job.id);
  call(CP, 'seller1', 'GET', '/v1/stocklists/' + job.id, null, [404]);
  call(CP, 'seller2', 'POST', '/v1/webhooks/sftp/stocklist', { csv }, [403]);
  const sftp = CP.system('POST', '/v1/webhooks/sftp/stocklist', { sellerId: 'S1', csv: 'MPN,Quantity,Date Code\nLM317T,5000,2018' });
  ok(sftp.status === 201 && sftp.data.channel === 'sftp' && sftp.data.created.length === 1, 'dépôt SFTP traité');
  // Sans date code, pas d'enchère ; une fois complété, l'enchère passe.
  const d = call(CP, 'buyer', 'POST', '/v1/demands', { mpn: 'MC68HC11E1CFNE2', qty: 250, delivery: 'Lyon (France)' });
  const id = job.created[1];
  call(CP, 'seller2', 'PUT', `/v1/lots/${id}/questionnaire`, { answers: Object.fromEntries(CP.QUESTIONS.map((q) => [q.k, q.a[0]])) });
  call(CP, 'seller2', 'POST', `/v1/demands/${d.id}/bids`, { lotId: id, net: 18 }, [422]);
  // Le date code est donné à la consultation, puis reporté sur le lot.
  call(CP, 'seller2', 'POST', `/v1/demands/${d.id}/bids`, { lotId: id, net: 18, dateCode: '2013' });
  ok(call(CP, 'seller2', 'GET', '/v1/lots/' + id).dc === '2013', 'date code reporté sur le lot');
});

scenario('API fournisseur : clés, offres en masse, retrait, webhooks', (CP) => {
  const key = call(CP, 'seller2', 'POST', '/v1/organizations/S2/api-keys', { environment: 'live' });
  ok(key.secret.startsWith('cp_live_') && !call(CP, 'seller2', 'GET', '/v1/organizations/S2/api-keys')[0].secret, 'secret affiché une seule fois');
  call(CP, 'seller2', 'POST', '/v1/organizations/S1/api-keys', {}, [403]);
  call(CP, 'seller2', 'POST', '/v1/supplier/webhooks', { url: 'http://x.example', events: ['demand.created'] }, [422]);
  call(CP, 'seller2', 'POST', '/v1/supplier/webhooks', { url: 'https://erp.example.com/hook', events: ['demand.created', 'offer.accepted', 'transaction.updated'] });
  const r = call(CP, 'seller2', 'POST', '/v1/supplier/offers/bulk', { offers: [
    { sku: 'A1', mpn: 'lm317t', manufacturer: 'TI', quantity: 3000, unit_price: 0.4, price_breaks: [{ quantity: 1000, price: 0.35 }], date_code: '2019' },
    { sku: 'A2', mpn: '', quantity: 5 },
    { sku: 'A3', mpn: 'NE5532P', quantity: -1 },
  ] });
  ok(r.created === 1 && r.errors.length === 2 && r.errors[0].index === 1, 'erreurs ligne par ligne');
  call(CP, 'seller2', 'POST', '/v1/supplier/offers/bulk', { offers: Array.from({ length: 1001 }, (_, i) => ({ sku: 'X' + i, mpn: 'M', quantity: 1 })) }, [413]);
  const up = call(CP, 'seller2', 'PUT', '/v1/supplier/offers/A1', { mpn: 'LM317T', quantity: 2500, unit_price: 0.38 });
  ok(up.qty === 2500 && up.mpn === 'LM317T', 'mise à jour unitaire par SKU');
  ok(call(CP, 'seller2', 'GET', '/v1/supplier/offers?sku=A1')[0].price_breaks.length === 1, 'paliers conservés');
  // Une demande sur la référence déclenche un webhook ; l'offre retirée n'est plus sollicitée.
  const d = call(CP, 'buyer', 'POST', '/v1/demands', { mpn: 'LM317T', qty: 1000, delivery: 'Lyon (France)' });
  const hooks = call(CP, 'seller2', 'GET', '/v1/supplier/webhooks');
  ok(hooks.deliveries.some((x) => x.type === 'demand.created' && x.payload.demand_id === d.id && !('buyer' in x.payload)), 'webhook demand.created anonyme');
  call(CP, 'seller2', 'DELETE', '/v1/supplier/offers/A1');
  const d2 = call(CP, 'buyer', 'POST', '/v1/demands', { mpn: 'LM317T', qty: 10, delivery: 'Lyon (France)' });
  call(CP, 'seller2', 'GET', '/v1/demands/' + d2.id, null, [404]);
  call(CP, 'seller2', 'DELETE', '/v1/supplier/offers/INCONNU', null, [404]);
});

scenario('devises : offres en USD, CNY (RMB) et EUR', (CP) => {
  call(CP, 'seller2', 'POST', '/v1/supplier/offers/bulk', { offers: [{ sku: 'C1', mpn: 'X1', quantity: 5, currency: 'BTC' }] });
  ok(call(CP, 'seller2', 'GET', '/v1/supplier/offers?sku=C1').length === 0, 'devise inconnue refusée');
  call(CP, 'seller2', 'POST', '/v1/supplier/offers/bulk', { offers: [{ sku: 'C2', mpn: 'NE5532P', quantity: 500, unit_price: 2.6, currency: 'rmb' }] });
  ok(call(CP, 'seller2', 'GET', '/v1/supplier/offers?sku=C2')[0].currency === 'CNY', 'RMB normalisé en CNY');
  call(CP, 'seller3', 'POST', '/v1/stocklists', { csv: 'MPN,Quantity,Unit Price,Currency\nNE5532P,800,0.40,EUR' });
  const d = call(CP, 'buyer', 'POST', '/v1/demands', { mpn: 'NE5532P', qty: 300, delivery: 'Lyon (France)' });
  const q = Object.fromEntries(CP.QUESTIONS.map((x) => [x.k, x.a[0]]));
  const lot2 = call(CP, 'seller2', 'GET', '/v1/lots').find((l) => l.sku === 'C2');
  const lot3 = call(CP, 'seller3', 'GET', '/v1/lots').find((l) => l.mpn === 'NE5532P');
  call(CP, 'seller2', 'PUT', `/v1/lots/${lot2.id}/questionnaire`, { answers: q });
  call(CP, 'seller3', 'PUT', `/v1/lots/${lot3.id}/questionnaire`, { answers: q });
  const adv = call(CP, 'seller2', 'GET', '/v1/pricing/advice?mpn=NE5532P&currency=CNY');
  ok(adv.currency === 'CNY' && adv.high > adv.low, 'conseil de prix dans la devise du vendeur');
  call(CP, 'seller2', 'POST', `/v1/demands/${d.id}/bids`, { lotId: lot2.id, net: 2.9, currency: 'XYZ', dateCode: '2021' }, [422]);
  call(CP, 'seller2', 'POST', `/v1/demands/${d.id}/bids`, { lotId: lot2.id, net: 2.9, currency: 'RMB', dateCode: '2021' }); // 0,37 € environ
  const mine = call(CP, 'seller3', 'POST', `/v1/demands/${d.id}/bids`, { lotId: lot3.id, net: 0.39, currency: 'EUR', dateCode: '2019' });
  ok(mine.rank === 2, 'rang calculé sur l\'équivalent en euros');
  call(CP, 'ops1', 'POST', `/v1/demands/${d.id}/close`, {});
  const offers = call(CP, 'buyer', 'GET', `/v1/demands/${d.id}/offers`);
  ok(offers[0].seller === 'V-2' && offers[0].dc === '2021' && offers[0].currency === undefined, 'offre consolidée en euros, sans la devise du vendeur');
  const tx = call(CP, 'buyer', 'POST', `/v1/offers/${offers[0].id}/accept`, { labLevel: 0 });
  ok(call(CP, 'seller2', 'GET', '/v1/transactions/' + tx.id).netCurrency === 'CNY', 'le vendeur garde sa devise');
  call(CP, 'buyer', 'POST', `/v1/transactions/${tx.id}/signatures`, {});
  call(CP, 'seller2', 'POST', `/v1/transactions/${tx.id}/signatures`, {});
  call(CP, 'bank', 'POST', '/v1/webhooks/bank/incoming-transfer', { reference: tx.id, amount: tx.total });
  call(CP, 'seller2', 'POST', `/v1/transactions/${tx.id}/shipments`, { tracking: 'Z' });
  CP.system('POST', '/v1/webhooks/carrier', { txId: tx.id });
  call(CP, 'buyer', 'POST', `/v1/transactions/${tx.id}/inspection`, { decision: 'accept' });
  const o = call(CP, 'ops1', 'GET', '/v1/payment-orders').find((x) => x.txId === tx.id);
  const pay = o.lines.find((l) => l.to === 'S2');
  ok(pay.currency === 'CNY' && Math.abs(pay.amountCurrency - 2.9 * 300 * 0.97) < 0.01 && Math.abs(o.amount - tx.total) < 0.01, 'paiement en CNY, ordre soldé en euros');
});

scenario('notifications : WeCom et WeChat en chinois, e-mail', (CP) => {
  // V-4 (Shenzhen) a un robot WeCom et un compte de service WeChat liés dans les données de démonstration.
  const d = call(CP, 'buyer', 'POST', '/v1/demands', { mpn: 'XC2S50-5TQ144C', qty: 250, delivery: 'Intégrateur, Shenzhen (Chine)', dcMin: '2010' });
  const list = call(CP, 'seller4', 'GET', '/v1/organizations/S4/notification-channels');
  const wecom = list.deliveries.find((x) => x.channel === 'wecom' && x.type === 'demand.created');
  const oa = list.deliveries.find((x) => x.channel === 'wechat_oa' && x.type === 'demand.created');
  ok(wecom && wecom.payload.msgtype === 'markdown' && wecom.payload.markdown.content.includes('新询价') && wecom.payload.markdown.content.includes('中国 广东'.slice(0, 2)), 'message WeCom en chinois');
  ok(oa && oa.payload.template_id && oa.payload.url.endsWith('/vendeur/demandes/' + d.id), 'message modèle WeChat avec lien vers la demande');
  ok(!JSON.stringify(list.deliveries).includes('Atelier Lumen') && !JSON.stringify(list.deliveries).includes('Shenzhen (Chine)'.slice(0, 11) + ')'), 'aucune identité ni adresse de l\'acheteur');
  call(CP, 'seller1', 'GET', '/v1/organizations/S4/notification-channels', null, [403]);
  call(CP, 'seller1', 'POST', '/v1/organizations/S1/notification-channels', { type: 'wecom', target: 'https://exemple.com/hook', events: ['demand.created'] }, [422]);
  const mail = call(CP, 'seller1', 'POST', '/v1/organizations/S1/notification-channels', { type: 'email', target: 'ventes@exemple.com', lang: 'en', events: ['demand.created'] });
  const t = call(CP, 'seller1', 'POST', `/v1/organizations/S1/notification-channels/${mail.id}/test`, {});
  ok(t.payload.subject.startsWith('[Central.Parts] New RFQ'), 'e-mail d\'essai en anglais');
  // Liaison d'un compte de service par QR code.
  const oa2 = call(CP, 'seller2', 'POST', '/v1/organizations/S2/notification-channels', { type: 'wechat_oa', lang: 'zh', events: ['demand.created'] });
  ok(oa2.status === 'pending', 'canal WeChat en attente du scan');
  call(CP, 'seller2', 'POST', `/v1/organizations/S2/notification-channels/${oa2.id}/test`, {}, [409]);
  const qr = call(CP, 'seller2', 'POST', '/v1/wechat/qrcodes', { channelId: oa2.id });
  call(CP, 'seller2', 'POST', '/v1/webhooks/wechat', { scene: qr.scene, openid: 'x', event: 'subscribe' }, [403]);
  ok(CP.system('POST', '/v1/webhooks/wechat', { scene: 'inconnu', openid: 'x', event: 'subscribe' }).status === 404, 'QR code inconnu refusé');
  ok(CP.system('POST', '/v1/webhooks/wechat', { scene: qr.scene, openid: 'o6_test', event: 'subscribe' }).status === 201, 'scan WeChat');
  ok(call(CP, 'seller2', 'POST', `/v1/organizations/S2/notification-channels/${oa2.id}/test`, {}).payload.touser === 'o6_test', 'message envoyé à l\'openid lié');
  call(CP, 'seller2', 'DELETE', `/v1/organizations/S2/notification-channels/${oa2.id}`);
});

scenario('bac à sable : de l\'offre poussée à l\'expédition', (CP) => {
  call(CP, 'seller2', 'POST', '/v1/supplier/webhooks', { url: 'https://erp.example.com/hook', events: ['demand.created', 'offer.accepted'] });
  call(CP, 'seller2', 'POST', '/v1/supplier/offers/bulk', { offers: [{ sku: 'T1', mpn: 'TL431ACDBZR', quantity: 9000, unit_price: 0.9, currency: 'CNY' }] });
  call(CP, 'seller2', 'POST', '/v1/sandbox/demands', { mpn: 'INCONNU' }, [422]);
  const d = call(CP, 'seller2', 'POST', '/v1/sandbox/demands', { mpn: 'TL431ACDBZR', quantity: 2000 });
  ok(d.sandbox && call(CP, 'seller1', 'GET', '/v1/demands').every((x) => x.id !== d.id), 'demande de test visible du seul fournisseur');
  ok(call(CP, 'seller2', 'GET', '/v1/supplier/webhooks').deliveries.some((x) => x.payload.demand_id === d.id && x.payload.sandbox), 'webhook de test');
  call(CP, 'seller2', 'POST', `/v1/sandbox/demands/${d.id}/accept`, {}, [409]);
  const lot = call(CP, 'seller2', 'GET', '/v1/lots').find((l) => l.sku === 'T1');
  call(CP, 'seller2', 'PUT', `/v1/lots/${lot.id}/questionnaire`, { answers: Object.fromEntries(CP.QUESTIONS.map((q) => [q.k, q.a[0]])) });
  call(CP, 'seller2', 'POST', `/v1/demands/${d.id}/bids`, { lotId: lot.id, net: 0.85, currency: 'CNY', dateCode: '2024' });
  const t = call(CP, 'seller2', 'POST', `/v1/sandbox/demands/${d.id}/accept`, {});
  ok(t.status === 'to_sign_seller', 'offre retenue et signée par l\'acheteur fictif');
  call(CP, 'seller2', 'POST', `/v1/transactions/${t.id}/signatures`, {});
  ok(call(CP, 'seller2', 'GET', '/v1/transactions/' + t.id).status === 'to_ship', 'dépôt simulé : expédition demandée');
  call(CP, 'seller2', 'POST', `/v1/transactions/${t.id}/shipments`, { tracking: 'SBX-1' });
});

scenario('statut vérifié : KYB et abonnement à jour', (CP) => {
  ok(call(CP, 'seller1', 'GET', '/v1/organizations/S1/subscription').verified, 'V-1 vérifié au départ');
  call(CP, 'seller2', 'GET', '/v1/organizations/S1/subscription', null, [403]);
  const offers = (() => { call(CP, 'ops1', 'POST', '/v1/demands/DEM-0427/close', {}); return call(CP, 'buyer', 'GET', '/v1/demands/DEM-0427/offers'); })();
  ok(offers.every((o) => o.sellerVerified === true), 'badge vérifié sur les offres');
  for (let i = 0; i < 5; i++) CP.advanceDay(); // l'abonnement de V-1 expire au jour 4
  const sub = call(CP, 'seller1', 'GET', '/v1/organizations/S1/subscription');
  ok(!sub.verified && sub.subscription.status === 'expired', 'V-1 n\'est plus vérifié');
  ok(call(CP, 'seller1', 'GET', '/v1/notifications').some((n) => /expir/.test(n.text)), 'rappel et avis d\'expiration');
  // Une nouvelle demande ne lui est plus diffusée ; la recherche publique masque ses lots.
  const d = call(CP, 'buyer', 'POST', '/v1/demands', { mpn: 'MC68HC11E1CFNE2', qty: 50, delivery: 'Lyon (France)' });
  call(CP, 'seller1', 'GET', '/v1/demands/' + d.id, null, [404]);
  ok(call(CP, 'seller3', 'GET', '/v1/demands/' + d.id).id === d.id, 'les vendeurs vérifiés la reçoivent');
  call(CP, 'seller1', 'POST', `/v1/demands/DEM-0428/bids`, { lotId: 'LOT-104', net: 18, dateCode: '2012' }, [403, 409]);
  const renewed = call(CP, 'seller1', 'POST', '/v1/organizations/S1/subscription/renewal', {});
  ok(renewed.verified && renewed.subscription.daysLeft === 250, 'renouvellement : statut vérifié rétabli');
  // Un vendeur inscrit sans KYB validé ne peut pas s'abonner.
  const org = call(CP, 'public', 'POST', '/v1/organizations', { type: 'seller', name: 'Nouveau Broker' });
  call(CP, 'ops1', 'POST', `/v1/organizations/${org.id}/subscription/renewal`, {}, [409]);
});

scenario('acheteur en USD, vendeur payé en CNY', (CP) => {
  const d = call(CP, 'buyer2', 'POST', '/v1/demands', { mpn: 'XC2S50-5TQ144C', qty: 100, delivery: 'Usine, Denver (États-Unis)' });
  ok(d.sellers === undefined && call(CP, 'seller4', 'GET', '/v1/demands/' + d.id).zone === 'États-Unis', 'demande diffusée, zone seule');
  const q = Object.fromEntries(CP.QUESTIONS.map((x) => [x.k, x.a[0]]));
  call(CP, 'seller4', 'PUT', '/v1/lots/LOT-107/questionnaire', { answers: q });
  call(CP, 'seller4', 'POST', `/v1/demands/${d.id}/bids`, { lotId: 'LOT-107', net: 290, currency: 'CNY', dateCode: '2012' });
  call(CP, 'ops1', 'POST', `/v1/demands/${d.id}/close`, {});
  const offers = call(CP, 'buyer2', 'GET', `/v1/demands/${d.id}/offers`);
  const o = offers.find((x) => x.seller === 'V-4');
  ok(o.unitCurrency === 'USD' && Math.abs(o.unit - CP.fromEur(CP.toEur(290, 'CNY') * 1.12, 'USD')) < 0.02, 'offre consolidée en USD');
  const tx = call(CP, 'buyer2', 'POST', `/v1/offers/${o.id}/accept`, { labLevel: 1 });
  ok(tx.currency === 'USD' && Math.abs(tx.labFee - CP.fromEur(180, 'USD')) < 0.01, 'transaction et laboratoire en USD');
  call(CP, 'buyer2', 'POST', `/v1/transactions/${tx.id}/signatures`, {});
  call(CP, 'seller4', 'POST', `/v1/transactions/${tx.id}/signatures`, {});
  call(CP, 'bank', 'POST', '/v1/webhooks/bank/incoming-transfer', { reference: tx.id, amount: tx.total, currency: 'EUR' }, [422]);
  call(CP, 'bank', 'POST', '/v1/webhooks/bank/incoming-transfer', { reference: tx.id, amount: tx.total, currency: 'USD' });
  ok(Math.abs(call(CP, 'bank', 'GET', '/v1/escrow').balances.USD - tx.total) < 0.01, 'dépôt cantonné en USD');
  call(CP, 'seller4', 'POST', `/v1/transactions/${tx.id}/shipments`, { tracking: 'SF-1' });
  const lc = call(CP, 'lab', 'GET', '/v1/lab/cases').find((c) => c.txId === tx.id);
  call(CP, 'lab', 'POST', `/v1/lab/cases/${lc.id}/reception`, { qty: 100 });
  call(CP, 'lab', 'POST', `/v1/lab/cases/${lc.id}/certificate`, { verdict: 'pass', results: { visual: 'pass', marking: 'pass' } });
  call(CP, 'lab', 'POST', `/v1/lab/cases/${lc.id}/reshipment`, { tracking: 'R-1' });
  CP.system('POST', '/v1/webhooks/carrier', { txId: tx.id });
  call(CP, 'buyer2', 'POST', `/v1/transactions/${tx.id}/inspection`, { decision: 'accept' });
  const ord = call(CP, 'ops1', 'GET', '/v1/payment-orders').find((x) => x.txId === tx.id);
  const pay = ord.lines.find((l) => l.to === 'S4');
  ok(ord.currency === 'USD' && Math.abs(ord.amount - tx.total) < 0.02, 'ordre en USD, soldant le dépôt');
  ok(pay.currency === 'CNY' && Math.abs(pay.amountCurrency - 290 * 100 * 0.97) < 0.01, 'vendeur payé en CNY');
  call(CP, 'ops1', 'POST', `/v1/payment-orders/${ord.id}/approvals`, {});
  call(CP, 'ops2', 'POST', `/v1/payment-orders/${ord.id}/approvals`, {});
  call(CP, 'ops1', 'POST', `/v1/payment-orders/${ord.id}/transmit`, {});
  call(CP, 'bank', 'POST', `/bank/v1/orders/${ord.id}/execution`, {});
  ok(Math.abs(call(CP, 'bank', 'GET', '/v1/escrow').balances.USD) < 0.02, 'solde USD revenu à zéro');
  ok(call(CP, 'buyer2', 'GET', '/v1/transactions/' + tx.id).status === 'released', 'transaction soldée');
});

console.log(`${checks - failures}/${checks} vérifications réussies`);
process.exit(failures ? 1 : 0);
