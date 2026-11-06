// Recherche payante (ADR 0033) : signature des webhooks GoCardless et corps des demandes de paiement Pay By Bank
// (supabase/functions/_shared/gocardless.js). Usage : node tools/test-sourcing.mjs
import { billingRequestBody, billingRequestFlowBody, failedPayments, fulfilledBillingRequests, gcBase, hmacHex, verifyWebhook } from '../supabase/functions/_shared/gocardless.js';

let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };

// Secret fictif, propre au test (jamais un vrai secret).
const SECRET = 'secret_webhook_fictif';
const body = JSON.stringify({ events: [
  { id: 'EV1', resource_type: 'billing_requests', action: 'fulfilled', links: { billing_request: 'BRQ_FICTIF_1', payment_request_payment: 'PM_FICTIF_1' } },
  { id: 'EV2', resource_type: 'billing_requests', action: 'created', links: { billing_request: 'BRQ_FICTIF_2' } },
  { id: 'EV3', resource_type: 'payments', action: 'confirmed', links: { payment: 'PM_FICTIF' } },
  { id: 'EV4', resource_type: 'payments', action: 'failed', links: { payment: 'PM_FICTIF_2' } },
] });
const sig = await hmacHex(SECRET, body);

ok(await verifyWebhook(body, sig, SECRET), 'signature valide acceptée');
ok(await verifyWebhook(body, sig.toUpperCase(), SECRET), 'signature en majuscules acceptée');
ok(!(await verifyWebhook(body + ' ', sig, SECRET)), 'corps modifié refusé');
ok(!(await verifyWebhook(body, sig, 'autre_secret')), 'autre secret refusé');
ok(!(await verifyWebhook(body, sig.slice(1), SECRET)), 'signature tronquée refusée');
ok(!(await verifyWebhook(body, sig, '')), 'secret non configuré : tout est refusé');
ok(!(await verifyWebhook(body, null, SECRET)), 'en-tête absent refusé');

const f = fulfilledBillingRequests(JSON.parse(body));
ok(f.length === 1 && f[0].brq === 'BRQ_FICTIF_1' && f[0].payment === 'PM_FICTIF_1', 'seules les demandes de paiement réglées (fulfilled) sont retenues, avec leur paiement');
const fp = failedPayments(JSON.parse(body));
ok(fp.length === 1 && fp[0].payment === 'PM_FICTIF_2' && fp[0].action === 'failed', 'paiement échoué repéré');
ok(fulfilledBillingRequests({}).length === 0 && fulfilledBillingRequests(null).length === 0, 'lot vide ou invalide : rien');

ok(gcBase('live') === 'https://api.gocardless.com' && gcBase(undefined) === 'https://api-sandbox.gocardless.com', 'production seulement avec GOCARDLESS_ENV=live');

const b = billingRequestBody({ id: 'SRC-0001', mpn: 'CM8071505024905', amount_ttc: 5880, amount_ht: 4900, vat_rate: 0.2, lang: 'fr' }).billing_requests;
ok(b.payment_request.amount === 5880 && b.payment_request.currency === 'EUR', 'paiement unique de 58,80 € en euros');
ok(b.payment_request.description === 'Recherche de sourcing CM8071505024905 (49.00 EUR HT + TVA 20 %)', 'libellé avec HT et TVA');
ok(b.metadata.sourcing_id === 'SRC-0001', 'référence de la demande en métadonnée');
const b2 = billingRequestBody({ id: 'SRC-0002', mpn: 'X'.repeat(200), amount_ttc: 4900, amount_ht: 4900, vat_rate: 0, lang: 'en' }).billing_requests;
ok(b2.payment_request.description.startsWith('Sourcing search X') && b2.payment_request.description.length === 140, 'sans TVA, en anglais, libellé limité à 140 caractères');

const fl = billingRequestFlowBody({ brq: 'BRQ_FICTIF_1', email: 'achat@exemple.test', company: 'Acheteur fictif', lang: 'zh', site: 'https://central.parts', token: 'a'.repeat(48) }).billing_request_flows;
ok(fl.redirect_uri === 'https://central.parts/sourcing/suivi/?lang=zh#' + 'a'.repeat(48) && fl.exit_uri === 'https://central.parts/sourcing/?lang=zh&cancel=1',
  'parcours : retour vers le suivi (jeton dans le fragment) ou le formulaire');
ok(fl.language === 'en' && fl.links.billing_request === 'BRQ_FICTIF_1' && fl.prefilled_customer.email === 'achat@exemple.test', 'parcours : langue, demande liée, acheteur pré-rempli');

console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
