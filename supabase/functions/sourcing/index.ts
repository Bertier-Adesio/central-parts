// Fonction Edge « sourcing » : recherche payante de composants rares ou introuvables (ADR 0033).
// Appelée par les pages https://central.parts/sourcing/ et /sourcing/suivi/ ; déployée sans vérification de jeton
// Supabase (--no-verify-jwt) : la page est publique, le webhook vient de GoCardless et porte sa propre signature.
//
//   POST /sourcing          {mpn, manufacturer?, qty, target_price?, target_currency?, needed_by?, condition, notes?,
//                            company, contact, email, country, vat?, lang}
//                           → pays couverts par GoCardless Pay By Bank : { id, mode: "bank", url } (page de paiement
//                             hébergée par GoCardless, virement depuis la banque de l'acheteur) ;
//                             autres pays : { id, mode: "proforma", tracking_url } (proforma envoyée par Central.Parts)
//   POST /sourcing/webhook  événements GoCardless signés : billing_requests fulfilled → montant relu sur le paiement, demande
//                           payée, opérateurs prévenus ; payments failed/cancelled → opérateurs prévenus
//   GET  /sourcing/status   (Authorization: Bearer <jeton du lien de suivi>) → état de la demande pour l'acheteur
//
// Secrets (jamais dans le dépôt) : GOCARDLESS_ACCESS_TOKEN, GOCARDLESS_WEBHOOK_SECRET ; GOCARDLESS_ENV (« live » en
// production, bac à sable sinon) ; GOCARDLESS_COUNTRIES (pays couverts par Pay By Bank, « FR,DE,IE » par défaut).
// Sans GOCARDLESS_ACCESS_TOKEN, toutes les demandes passent par la proforma.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { billingRequestBody, billingRequestFlowBody, failedPayments, fulfilledBillingRequests, gcBase, GC_VERSION, verifyWebhook } from '../_shared/gocardless.js';
import { viesValid } from '../_shared/vies.ts';
import { notifyOperators } from '../_shared/wechat.ts';

const ORIGINS = (Deno.env.get('SEARCH_ORIGINS') || 'https://central.parts').split(',');
const SITE = 'https://central.parts';
const COUNTRIES = (Deno.env.get('GOCARDLESS_COUNTRIES') || 'FR,DE,IE').split(',').map((c) => c.trim().toUpperCase());

// deno-lint-ignore no-explicit-any
const KEY = () => Deno.env.get('GOCARDLESS_ACCESS_TOKEN') || '';
// Appel à l'API GoCardless (en-têtes : docs.gocardless.com/docs/api-reference/making-requests).
const gc = (method: string, path: string, body?: unknown, idem?: string) => fetch(gcBase(Deno.env.get('GOCARDLESS_ENV')) + path, {
  method,
  headers: { Authorization: `Bearer ${KEY()}`, 'GoCardless-Version': GC_VERSION, Accept: 'application/json', 'Content-Type': 'application/json',
    ...(idem ? { 'Idempotency-Key': idem } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (res) => ({ ok: res.ok, data: await res.json().catch(() => ({})) }));

// deno-lint-ignore no-explicit-any
const summary = (d: any) => `${d.mpn}${d.manufacturer ? ' (' + d.manufacturer + ')' : ''} × ${d.qty}, ${d.company} (${d.country})`;

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
    // ---------------------------------------------------------------- webhook GoCardless (corps brut, signature vérifiée)
    if (req.method === 'POST' && u.pathname.endsWith('/webhook')) {
      const raw = await req.text();
      const ok = await verifyWebhook(raw, req.headers.get('webhook-signature'), Deno.env.get('GOCARDLESS_WEBHOOK_SECRET') || '');
      // 498 : réponse attendue par GoCardless pour une signature invalide.
      if (!ok) return json({ error: 'invalid_signature' }, 498);
      const body = JSON.parse(raw);
      for (const { brq, payment } of fulfilledBillingRequests(body)) {
        // Montant relu sur le paiement (absent de l'événement) ; échec de lecture : 500, GoCardless renvoie l'événement.
        let amount: number | null = null;
        if (payment) {
          const pm = await gc('GET', '/payments/' + encodeURIComponent(payment));
          if (!pm.ok) return json({ error: 'payment_lookup' }, 500);
          amount = Number(pm.data?.payments?.amount);
          if (['failed', 'cancelled', 'customer_approval_denied'].includes(pm.data?.payments?.status)) continue;
        }
        const { data } = await db.rpc('sourcing_mark_paid', { p_ref: brq, p_amount: amount });
        if (data) {
          await notifyOperators(db, `Recherche de sourcing payée ${data.id} : ${summary(data)}` +
            `${data.needed_by ? ', pour le ' + data.needed_by : ''}${data.target_price ? ', prix cible ' + data.target_price + ' ' + data.target_currency : ''}.` +
            ' À traiter dans le back office, onglet Demandes.').catch(() => {});
        }
      }
      for (const f of failedPayments(body)) {
        await notifyOperators(db, `Paiement GoCardless ${f.payment} ${f.action === 'failed' ? 'échoué' : 'annulé'} : vérifier dans le tableau de bord` +
          ' GoCardless et, si la recherche de sourcing était marquée payée, la repasser en attente avec l\'acheteur.').catch(() => {});
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
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const vat = String(b.vat || '').toUpperCase().replace(/[\s.-]/g, '');
      const valid = vat ? await viesValid(vat) : null;
      if (valid === false) return json({ error: 'vat_invalid' }, 422);
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
      const lang = ['fr', 'en', 'zh'].includes(b.lang) ? b.lang : 'fr';
      const key = KEY();
      const country = String(b.country || '').trim().toUpperCase();
      const mode = key && COUNTRIES.includes(country) ? 'bank' : 'proforma';
      const { data: r, error } = await db.rpc('create_sourcing_request', { p_ip: ip, p: { ...b, vat, vat_checked: valid === true, lang, payment_mode: mode } });
      if (error) {
        if (error.code === 'CP429') return json({ error: 'rate_limited' }, 429);
        if (error.code === '22023') return json({ error: 'invalid', detail: error.message }, 422);
        return json({ error: 'server' }, 500);
      }
      const tracking = `${SITE}/sourcing/suivi/?lang=${lang}#${r.token}`;
      if (mode === 'proforma') {
        await notifyOperators(db, `Recherche de sourcing demandée ${r.id} : ${summary(r)}. Proforma de ${(r.amount_ttc / 100).toFixed(2)} EUR à envoyer` +
          ` à ${String(b.email || '').trim()} ; à marquer payée dans le back office à réception du virement.`).catch(() => {});
        return json({ id: r.id, mode, tracking_url: tracking });
      }
      // Pay By Bank : demande de paiement (clé d'idempotence : la demande), puis parcours hébergé par GoCardless.
      const brq = await gc('POST', '/billing_requests', billingRequestBody({ ...r, lang }), 'sourcing-' + r.id);
      const brqId = brq.data?.billing_requests?.id;
      if (!brq.ok || !brqId) return json({ error: 'payment_unavailable' }, 502);
      await db.rpc('sourcing_set_payment_ref', { p_id: r.id, p_ref: brqId });
      const flow = await gc('POST', '/billing_request_flows', billingRequestFlowBody({ brq: brqId, email: String(b.email || '').trim().toLowerCase(),
        company: String(b.company || '').trim(), lang, site: SITE, token: r.token }));
      const url = flow.data?.billing_request_flows?.authorisation_url;
      if (!flow.ok || !url) return json({ error: 'payment_unavailable' }, 502);
      return json({ id: r.id, mode, url });
    }

    return json({ error: 'not_found' }, 404);
  } catch (e) {
    return json({ error: 'server', detail: String(e) }, 500);
  }
});
