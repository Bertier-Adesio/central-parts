// Recherche payante (ADR 0033) : signature des webhooks Stripe et session Checkout (supabase/functions/_shared/stripe.js).
// Usage : node tools/test-sourcing.mjs
import { checkoutForm, hmacHex, verifyStripeSignature } from '../supabase/functions/_shared/stripe.js';

let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };

// Secret fictif, propre au test (jamais un vrai secret).
const SECRET = 'whsec_test_fictif';
const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', amount_total: 5880 } } });
const t = 1762430000;
const sig = await hmacHex(SECRET, `${t}.${body}`);

ok(await verifyStripeSignature(body, `t=${t},v1=${sig}`, SECRET, t + 10), 'signature valide acceptée');
ok(await verifyStripeSignature(body, `t=${t},v1=${'0'.repeat(64)},v1=${sig}`, SECRET, t), 'une des signatures v1 suffit (rotation du secret)');
ok(!(await verifyStripeSignature(body + ' ', `t=${t},v1=${sig}`, SECRET, t)), 'corps modifié refusé');
ok(!(await verifyStripeSignature(body, `t=${t},v1=${sig}`, 'whsec_autre', t)), 'autre secret refusé');
ok(!(await verifyStripeSignature(body, `t=${t},v1=${sig}`, SECRET, t + 301)), 'événement de plus de 5 minutes refusé (rejeu)');
ok(!(await verifyStripeSignature(body, `v1=${sig}`, SECRET, t)), 'horodatage absent refusé');
ok(!(await verifyStripeSignature(body, `t=${t},v1=${sig}`, '', t)), 'secret non configuré : tout est refusé');
ok(!(await verifyStripeSignature(body, null, SECRET, t)), 'en-tête absent refusé');

const f = checkoutForm({ id: 'SRC-0001', mpn: 'CM8071505024905', amount_ttc: 5880, amount_ht: 4900, vat_rate: 0.2, email: 'achat@exemple.test',
  lang: 'fr', site: 'https://central.parts', token: 'a'.repeat(48) });
ok(f.get('mode') === 'payment' && f.get('line_items[0][price_data][currency]') === 'eur' && f.get('line_items[0][price_data][unit_amount]') === '5880',
  'session : paiement unique de 58,80 € en euros');
ok(f.get('line_items[0][price_data][product_data][name]') === 'Recherche de sourcing CM8071505024905 (49.00 € HT + TVA 20 %)', 'session : libellé avec HT et TVA');
ok(f.get('metadata[sourcing_id]') === 'SRC-0001' && f.get('client_reference_id') === 'SRC-0001' && f.get('customer_email') === 'achat@exemple.test', 'session : référence de la demande');
ok(f.get('success_url') === 'https://central.parts/sourcing/suivi/?lang=fr#' + 'a'.repeat(48) && f.get('cancel_url') === 'https://central.parts/sourcing/?lang=fr&cancel=1',
  'session : retour vers le suivi (jeton dans le fragment) ou le formulaire');
const g = checkoutForm({ id: 'SRC-0002', mpn: 'X', amount_ttc: 4900, amount_ht: 4900, vat_rate: 0, email: 'a@b.test', lang: 'en', site: 'https://central.parts', token: 'b'.repeat(48) });
ok(g.get('line_items[0][price_data][product_data][name]') === 'Sourcing search X (49.00 € HT)' && g.get('locale') === 'en', 'session sans TVA, en anglais');

console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
