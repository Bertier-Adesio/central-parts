// Stripe sans bibliothèque (ADR 0033) : signature des webhooks et corps des sessions Checkout.
// Module JavaScript pur, testé par tools/test-sourcing.mjs (Node) et utilisé par la fonction Edge sourcing (Deno).

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// HMAC-SHA256 en hexadécimal.
export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// En-tête Stripe-Signature « t=1700000000,v1=abc…,v1=def… » : vrai si une signature v1 correspond au corps brut et si
// l'horodatage date de moins de `tolerance` secondes (rejeu refusé).
export async function verifyStripeSignature(payload, header, secret, now = Math.floor(Date.now() / 1000), tolerance = 300) {
  if (!secret || !header) return false;
  const parts = String(header).split(',').map((p) => p.trim().split('='));
  const t = Number((parts.find(([k]) => k === 't') || [])[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(now - t) > tolerance) return false;
  const expected = await hmacHex(secret, `${t}.${payload}`);
  // Comparaison en temps constant.
  return sigs.some((s) => s.length === expected.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0);
}

// Corps (application/x-www-form-urlencoded) d'une session Checkout pour une recherche payée par carte.
export function checkoutForm({ id, mpn, amount_ttc, amount_ht, vat_rate, email, lang, site, token }) {
  const label = { fr: 'Recherche de sourcing', en: 'Sourcing search', zh: '寻源服务' }[lang] || 'Sourcing search';
  const vat = vat_rate > 0 ? ` (${(amount_ht / 100).toFixed(2)} € HT + TVA ${Math.round(vat_rate * 100)} %)` : ` (${(amount_ht / 100).toFixed(2)} € HT)`;
  const f = new URLSearchParams();
  f.set('mode', 'payment');
  f.set('payment_method_types[0]', 'card');
  f.set('line_items[0][quantity]', '1');
  f.set('line_items[0][price_data][currency]', 'eur');
  f.set('line_items[0][price_data][unit_amount]', String(amount_ttc));
  f.set('line_items[0][price_data][product_data][name]', `${label} ${mpn}${vat}`);
  f.set('client_reference_id', id);
  f.set('metadata[sourcing_id]', id);
  f.set('customer_email', email);
  f.set('locale', { fr: 'fr', en: 'en', zh: 'zh' }[lang] || 'auto');
  f.set('success_url', `${site}/sourcing/suivi/?lang=${lang}#${token}`);
  f.set('cancel_url', `${site}/sourcing/?lang=${lang}&cancel=1`);
  return f;
}
