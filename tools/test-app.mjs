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

console.log(`${checks - failures}/${checks} vérifications réussies`);
process.exit(failures ? 1 : 0);
