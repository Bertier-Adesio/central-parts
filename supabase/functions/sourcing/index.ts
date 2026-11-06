// Fonction Edge « sourcing » : recherche payante de composants rares ou introuvables (ADR 0033).
// Appelée par les pages https://central.parts/sourcing/ et /sourcing/suivi/ ; déployée sans vérification de jeton
// Supabase (--no-verify-jwt) : la page est publique, le webhook vient de Stripe et porte sa propre signature.
//
//   POST /sourcing          {mpn, manufacturer?, qty, target_price?, target_currency?, needed_by?, condition, notes?,
//                            company, contact, email, country, vat?, lang}
//                           → { id, url } : demande créée (en attente de paiement) et adresse de la page de paiement
//                           Stripe Checkout ; 503 payment_unavailable si le paiement n'est pas encore configuré
//   POST /sourcing/webhook  événement Stripe signé (checkout.session.completed) → demande payée, opérateurs prévenus
//   GET  /sourcing/status   (Authorization: Bearer <jeton du lien de suivi>) → état de la demande pour l'acheteur
//
// Secrets (jamais dans le dépôt) : STRIPE_SECRET_KEY (sk_live_… ou sk_test_…), STRIPE_WEBHOOK_SECRET (whsec_…).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { checkoutForm, verifyStripeSignature } from '../_shared/stripe.js';
import { viesValid } from '../_shared/vies.ts';
import { notifyOperators } from '../_shared/wechat.ts';

const ORIGINS = (Deno.env.get('SEARCH_ORIGINS') || 'https://central.parts').split(',');
const SITE = 'https://central.parts';

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
  const u = new URL(req.url);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  try {
    // ---------------------------------------------------------------- webhook Stripe (corps brut, signature vérifiée)
    if (req.method === 'POST' && u.pathname.endsWith('/webhook')) {
      const raw = await req.text();
      const ok = await verifyStripeSignature(raw, req.headers.get('stripe-signature'), Deno.env.get('STRIPE_WEBHOOK_SECRET') || '');
      if (!ok) return json({ error: 'signature' }, 400);
      const ev = JSON.parse(raw);
      const s = ev?.data?.object || {};
      if (ev.type === 'checkout.session.completed' && s.payment_status === 'paid') {
        const { data } = await db.rpc('sourcing_mark_paid', { p_session: String(s.id), p_amount: Number(s.amount_total) });
        if (data) {
          const line = `Recherche de sourcing payée ${data.id} : ${data.mpn}${data.manufacturer ? ' (' + data.manufacturer + ')' : ''} × ${data.qty}, ` +
            `${data.company} (${data.country})${data.needed_by ? ', pour le ' + data.needed_by : ''}` +
            `${data.target_price ? ', prix cible ' + data.target_price + ' ' + data.target_currency : ''}. À traiter dans le back office, onglet Demandes.`;
          await notifyOperators(db, line).catch(() => {});
        }
      }
      return json({ received: true });
    }

    // ---------------------------------------------------------------- suivi (lien personnel)
    if (req.method === 'GET' && u.pathname.endsWith('/status')) {
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!/^[0-9a-f]{48}$/.test(token)) return json({ error: 'link_invalid' }, 401);
      const { data, error } = await db.rpc('sourcing_status', { p_token: token });
      if (error) return json({ error: 'server' }, 500);
      return data ? json(data) : json({ error: 'link_invalid' }, 401);
    }

    // ---------------------------------------------------------------- nouvelle demande et paiement
    if (req.method === 'POST' && !u.pathname.endsWith('/webhook')) {
      const key = Deno.env.get('STRIPE_SECRET_KEY') || '';
      if (!key) return json({ error: 'payment_unavailable' }, 503);
      const b = await req.json().catch(() => ({}));
      const vat = String(b.vat || '').toUpperCase().replace(/[\s.-]/g, '');
      const valid = vat ? await viesValid(vat) : null;
      if (valid === false) return json({ error: 'vat_invalid' }, 422);
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
      const lang = ['fr', 'en', 'zh'].includes(b.lang) ? b.lang : 'fr';
      const { data: r, error } = await db.rpc('create_sourcing_request', { p_ip: ip, p: { ...b, vat, vat_checked: valid === true, lang } });
      if (error) {
        if (error.code === 'CP429') return json({ error: 'rate_limited' }, 429);
        if (error.code === '22023') return json({ error: 'invalid', detail: error.message }, 422);
        return json({ error: 'server' }, 500);
      }
      const form = checkoutForm({ ...r, email: String(b.email || '').trim().toLowerCase(), lang, site: SITE });
      const s = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      const session = await s.json().catch(() => ({}));
      if (!s.ok || !session.url) return json({ error: 'payment_unavailable' }, 502);
      await db.rpc('sourcing_set_session', { p_id: r.id, p_session: session.id });
      return json({ id: r.id, url: session.url });
    }

    return json({ error: 'not_found' }, 404);
  } catch (e) {
    return json({ error: 'server', detail: String(e) }, 500);
  }
});
