// GoCardless sans bibliothèque (ADR 0033) : signature des webhooks et corps des demandes de paiement Pay By Bank.
// Module JavaScript pur, testé par tools/test-sourcing.mjs (Node) et utilisé par la fonction Edge sourcing (Deno).
// API : https://api.gocardless.com (production) ou https://api-sandbox.gocardless.com (bac à sable), version 2015-07-06.
// Documentation : docs.gocardless.com (api-reference/billing-request, billing-request-flow, webhooks, making-requests).

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const GC_VERSION = '2015-07-06';
export const gcBase = (env) => (env === 'live' ? 'https://api.gocardless.com' : 'https://api-sandbox.gocardless.com');

// HMAC-SHA256 en hexadécimal.
export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// En-tête Webhook-Signature : HMAC-SHA256 du corps brut avec le secret de l'endpoint, en hexadécimal. Comparaison en
// temps constant ; secret absent : tout est refusé.
export async function verifyWebhook(payload, signature, secret) {
  if (!secret || !signature) return false;
  const expected = await hmacHex(secret, payload);
  const s = String(signature).trim().toLowerCase();
  return s.length === expected.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0;
}

const eventsOf = (body) => (Array.isArray(body && body.events) ? body.events : []).filter((e) => e && e.links);

// Demandes de paiement réglées dans un lot d'événements : billing_requests « fulfilled » (l'acheteur a autorisé le
// virement depuis sa banque). Renvoie { brq: 'BRQ…', payment: 'PM…' ou null } ; le montant n'est pas dans l'événement,
// la fonction le relit sur le paiement (links.payment_request_payment).
export function fulfilledBillingRequests(body) {
  return eventsOf(body).filter((e) => e.resource_type === 'billing_requests' && e.action === 'fulfilled' && e.links.billing_request)
    .map((e) => ({ brq: String(e.links.billing_request), payment: e.links.payment_request_payment ? String(e.links.payment_request_payment) : null }));
}

// Paiements échoués ou annulés après l'autorisation : identifiants PM…, pour alerter les opérateurs.
export function failedPayments(body) {
  return eventsOf(body).filter((e) => e.resource_type === 'payments' && (e.action === 'failed' || e.action === 'cancelled') && e.links.payment)
    .map((e) => ({ payment: String(e.links.payment), action: e.action }));
}

// Corps de la demande de paiement unique (montant en centimes d'euro) et du parcours hébergé par GoCardless.
export function billingRequestBody({ id, mpn, amount_ttc, amount_ht, vat_rate, lang }) {
  const label = { fr: 'Recherche de sourcing', en: 'Sourcing search', zh: '寻源服务' }[lang] || 'Sourcing search';
  const vat = vat_rate > 0 ? ` (${(amount_ht / 100).toFixed(2)} EUR HT + TVA ${Math.round(vat_rate * 100)} %)` : ` (${(amount_ht / 100).toFixed(2)} EUR HT)`;
  return { billing_requests: { payment_request: { amount: amount_ttc, currency: 'EUR', description: `${label} ${mpn}${vat}`.slice(0, 140) },
    metadata: { sourcing_id: id } } };
}
export function billingRequestFlowBody({ brq, email, company, lang, site, token }) {
  return { billing_request_flows: {
    redirect_uri: `${site}/sourcing/suivi/?lang=${lang}#${token}`,
    exit_uri: `${site}/sourcing/?lang=${lang}&cancel=1`,
    language: { fr: 'fr', en: 'en', zh: 'en' }[lang] || 'en',
    prefilled_customer: { email, company_name: company },
    links: { billing_request: brq } } };
}
