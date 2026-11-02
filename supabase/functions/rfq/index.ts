// Fonction Edge « rfq » : API des plateformes clientes (Adesio, Luminovo, CalcuQuote…), route RFQ (ADR 0023).
// Même contrat que le futur service API métier (ADR 0008) : seule l'adresse de base changera.
// Adresse : https://<projet>.supabase.co/functions/v1/rfq/v1/…  (prévue : https://api.central.parts/v1/…)
// Déployée sans vérification de jeton Supabase (--no-verify-jwt) : chaque appel présente une clé d'API Central.Parts.
//
//   POST   /v1/demands                    RFQ (1 à 50 lignes), Idempotency-Key obligatoire → 202 ; portée demands:write
//   GET    /v1/demands?status=&customer_reference=&created_since=
//   GET    /v1/demands/{id}
//   POST   /v1/demands/{id}/cancel
//   GET    /v1/demands/{id}/offers         offres consolidées, prix tout compris (fournisseur jamais nommé)
//   POST   /v1/webhooks {url, events}      secret de signature affiché une seule fois
//   GET    /v1/webhooks
//   DELETE /v1/webhooks/{id}
//   GET    /v1/offers?mpn=&manufacturer=&qty=&currency=&source_category=   offres en direct (ADR 0024)
//   POST   /v1/offers/search {lines: [{line_id, mpn, manufacturer?, quantity?}], currency?}   nomenclature (500 lignes)
//   GET    /v1/offers/{offer_id}?qty=&currency=                          détail et prix à la quantité
//   GET    /v1/manufacturers?q=
//   Formats compatibles, pour réutiliser un connecteur existant (même clé, mêmes données) :
//   GET    /compat/digikey/products/v4/search/{mpn}/productdetails       (devise : en-tête X-DIGIKEY-Locale-Currency)
//   POST   /compat/digikey/products/v4/search/keyword {Keywords, Limit?, Offset?}
//   GET    /compat/ti/v2/store/products/{mpn}?currency=USD
//   GET    /v1/me, GET /v1/health
//   Bac à sable seulement (clé cp_test_) : simulent l'administrateur et le fournisseur de test, sans aucun envoi.
//   POST   /v1/sandbox/demands/{id}/approve
//   POST   /v1/sandbox/demands/{id}/respond {kind: "quote"|"decline", price, currency, lead_days, date_code}
//   Tâche planifiée (en-tête X-CP-Jobs-Secret = RFQ_JOBS_SECRET), toutes les 5 minutes :
//   POST   /jobs/tick                      rappels, expirations, clôtures, livraison des webhooks
//
// Secrets et variables : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (fournis par Supabase) ; RFQ_WEBHOOK_KEY (dérivation
// des secrets de webhooks), RFQ_JOBS_SECRET, RFQ_WECHAT_OPEN (« true » pour ouvrir la diffusion aux fournisseurs
// réels ; faux par défaut), WECHAT_APPID et WECHAT_SECRET (déjà définis pour le robot).
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { rfqOperatorCard } from '../_shared/robot-texts.js';
import { API_STATUSES, apiError, bearerKey, sha256Hex, webhookSecret } from '../_shared/rfq.js';
import {
  digiKeyError, digiKeyLocale, groupByManufacturer, offersInCurrency, parseOffersQuery, toDigiKeyKeyword, toDigiKeyProduct, toTiProduct,
} from '../_shared/catalog.js';
import { closeRfq, deliverWebhooks, dispatchRfq, tellCancelled, tick } from '../_shared/rfq-dispatch.ts';
import { notifyOperators } from '../_shared/wechat.ts';

type Auth = { key_id: string; org_id: string; org_name: string; sandbox: boolean; environment: string; scopes: string[];
  limit: number; remaining: number; reset: number };

const later = (p: Promise<unknown>) => {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt) rt.waitUntil(p.catch(() => {})); else p.catch(() => {});
};

const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(data === null ? null : JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
const fail = (err: { code?: string; message?: string; details?: string } | null, extra: Record<string, string> = {}) => {
  const e = apiError(err);
  return reply(e.body, e.status, { ...e.headers, ...extra });
};
const failWith = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
  reply({ error: { code, message } }, status, extra);

// Après un événement : livrer tout de suite ce qui est dû (la tâche planifiée rattrape les échecs).
const deliverSoon = (db: SupabaseClient) => later(deliverWebhooks(db, 20));

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/rfq(?=\/|$)/, '') || '/';
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  try {
    // ---------------------------------------------------------------- tâche planifiée
    if (path === '/jobs/tick') {
      const secret = Deno.env.get('RFQ_JOBS_SECRET') || '';
      if (req.method !== 'POST' || !secret || req.headers.get('x-cp-jobs-secret') !== secret) return failWith(403, 'forbidden', 'Forbidden');
      return reply(await tick(db));
    }

    // ---------------------------------------------------------------- authentification
    const key = bearerKey(req.headers.get('authorization'));
    if (!key) return failWith(401, 'unauthorized', 'Missing or malformed API key (Authorization: Bearer cp_live_… or cp_test_…)');
    const { data: auth, error: authErr } = await db.rpc('rfq_auth', { p_key_hash: await sha256Hex(key) });
    if (authErr) return fail(authErr, authErr.code === 'CP429' ? { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '0' } : {});
    const a = auth as Auth;
    // Une clé cp_test_ ne vaut que pour le bac à sable, une clé cp_live_ que pour la production.
    if (key.startsWith('cp_test_') !== (a.environment === 'sandbox')) return failWith(401, 'unauthorized', 'Key environment mismatch');
    const rl = { 'X-RateLimit-Limit': String(a.limit), 'X-RateLimit-Remaining': String(a.remaining), 'X-RateLimit-Reset': String(a.reset) };
    const ok = (data: unknown, status = 200) => reply(data, status, rl);
    const ko = (err: { code?: string; message?: string; details?: string } | null) => fail(err, rl);
    const org = a.org_id;
    const body = async () => {
      const text = await req.text();
      try { return { text, json: text ? JSON.parse(text) : {} }; } catch { return { text, json: null }; }
    };
    let m: RegExpExecArray | null;

    if (req.method === 'GET' && path === '/v1/health') return ok({ status: 'ok', time: new Date().toISOString() });
    if (req.method === 'GET' && path === '/v1/me') {
      return ok({ client: { id: org, name: a.org_name }, key: { prefix: key.slice(0, 12), environment: a.environment === 'sandbox' ? 'test' : 'live', scopes: a.scopes } });
    }

    // ---------------------------------------------------------------- demandes
    if (path === '/v1/demands' && req.method === 'POST') {
      if (!a.scopes.includes('demands:write')) return failWith(403, 'forbidden', 'This key may not create RFQs (scope demands:write)', rl);
      const idem = req.headers.get('idempotency-key') || '';
      if (!idem) return failWith(422, 'invalid', 'Idempotency-Key header is required', rl);
      const b = await body();
      if (!b.json || typeof b.json !== 'object' || Array.isArray(b.json)) return failWith(422, 'invalid', 'Body must be a JSON object', rl);
      const { data, error } = await db.rpc('create_rfq', {
        p_org: org, p_idempotency_key: idem, p_request_hash: await sha256Hex(b.text), p: b.json, p_sandbox: a.sandbox,
      });
      if (error) return ko(error);
      // Administrateurs prévenus (fiche complète), sauf bac à sable.
      if (!a.sandbox) {
        later((async () => {
          for (const d of data.demands as { id: string; status: string }[]) {
            if (d.status !== 'pending_validation') continue;
            const { data: card } = await db.rpc('rfq_for_operator', { p_id: d.id });
            if (card && !card.validated_by && card.status === 'pending_validation') await notifyOperators(db, rfqOperatorCard(card, 'New RFQ'));
          }
        })());
      }
      return ok(data, 202);
    }
    if (path === '/v1/demands' && req.method === 'GET') {
      const status = url.searchParams.get('status');
      if (status && !API_STATUSES.includes(status)) return failWith(422, 'invalid', 'Unknown status', rl);
      const since = url.searchParams.get('created_since');
      if (since && Number.isNaN(Date.parse(since))) return failWith(422, 'invalid', 'created_since must be ISO 8601', rl);
      const { data, error } = await db.rpc('rfq_demands_for_client', {
        p_org: org, p_status: status, p_customer_reference: url.searchParams.get('customer_reference'), p_created_since: since,
      });
      return error ? ko(error) : ok({ demands: data });
    }
    if ((m = /^\/v1\/demands\/(DEM-\d+)$/i.exec(path)) && req.method === 'GET') {
      const { data, error } = await db.rpc('rfq_demand_for_client', { p_org: org, p_id: m[1] });
      if (error) return ko(error);
      return data ? ok(data) : failWith(404, 'not_found', 'Unknown demand', rl);
    }
    if ((m = /^\/v1\/demands\/(DEM-\d+)\/offers$/i.exec(path)) && req.method === 'GET') {
      const { data, error } = await db.rpc('rfq_offers_for_client', { p_org: org, p_id: m[1] });
      return error ? ko(error) : ok(data);
    }
    if ((m = /^\/v1\/demands\/(DEM-\d+)\/cancel$/i.exec(path)) && req.method === 'POST') {
      const { data, error } = await db.rpc('cancel_rfq', { p_org: org, p_id: m[1] });
      if (error) return ko(error);
      later(tellCancelled(db, data.demand.id, data.notify));
      return ok(data.demand);
    }

    // ---------------------------------------------------------------- offres en direct (ADR 0024)
    if (path === '/v1/offers' && req.method === 'GET') {
      const q = parseOffersQuery(url.searchParams);
      if (q.error) return reply({ error: { code: 'invalid', message: q.error, field: q.field } }, 422, rl);
      const { data, error } = await db.rpc('catalog_offers', { p_org: org, ...q.args, p_sandbox: a.sandbox });
      return error ? ko(error) : ok(data);
    }
    if (path === '/v1/offers/search' && req.method === 'POST') {
      const b = await body();
      if (!b.json || typeof b.json !== 'object' || Array.isArray(b.json)) return failWith(422, 'invalid', 'Body must be a JSON object', rl);
      const { data, error } = await db.rpc('catalog_search', { p_org: org, p: b.json, p_sandbox: a.sandbox });
      return error ? ko(error) : ok(data);
    }
    if ((m = /^\/v1\/offers\/(cpo_[0-9a-f]{20})$/.exec(path)) && req.method === 'GET') {
      const qty = url.searchParams.get('qty');
      if (qty && !/^\d{1,9}$/.test(qty)) return failWith(422, 'invalid', 'qty must be a positive integer', rl);
      const { data, error } = await db.rpc('catalog_offer', { p_org: org, p_offer_id: m[1], p_qty: qty ? Number(qty) : null,
        p_currency: url.searchParams.get('currency'), p_sandbox: a.sandbox });
      return error ? ko(error) : ok(data);
    }
    if (path === '/v1/manufacturers' && req.method === 'GET') {
      const { data, error } = await db.rpc('catalog_manufacturers', { p_q: url.searchParams.get('q') || '', p_sandbox: a.sandbox });
      return error ? ko(error) : ok(data);
    }

    // Formats compatibles : une seule devise par réponse (celle demandée, USD par défaut) ; sans conversion activée,
    // seules les offres dans cette devise (et les offres sur demande) y figurent.
    const compatOffers = async (mpn: string, currency: string) => {
      const { data, error } = await db.rpc('catalog_offers', { p_org: org, p_mpn: mpn, p_currency: currency, p_sandbox: a.sandbox });
      if (error) return { error };
      return { mpn: data.mpn as string, offers: offersInCurrency(data.offers, currency) };
    };
    if ((m = /^\/compat\/digikey\/products\/v4\/search\/(.+)\/productdetails$/.exec(path)) && req.method === 'GET') {
      const currency = (req.headers.get('x-digikey-locale-currency') || 'USD').toUpperCase();
      const r = await compatOffers(decodeURIComponent(m[1]), currency);
      if (r.error) return ko(r.error);
      if (!r.offers.length) return reply(digiKeyError(404, 'Product not found'), 404, rl);
      return ok({ Product: toDigiKeyProduct(r.mpn, groupByManufacturer(r.offers)[0]), SearchLocaleUsed: digiKeyLocale(currency) });
    }
    if (path === '/compat/digikey/products/v4/search/keyword' && req.method === 'POST') {
      const b = await body();
      const kw = String(b.json?.Keywords || '').trim();
      if (!kw) return reply(digiKeyError(400, 'Keywords is required'), 400, rl);
      const currency = (req.headers.get('x-digikey-locale-currency') || 'USD').toUpperCase();
      const r = await compatOffers(kw, currency);
      if (r.error) return ko(r.error);
      const limit = Math.min(Math.max(Number(b.json?.Limit) || 50, 1), 50), offset = Math.max(Number(b.json?.Offset) || 0, 0);
      return ok(toDigiKeyKeyword(r.mpn, r.offers, currency, limit, offset));
    }
    if ((m = /^\/compat\/ti\/v2\/store\/products\/(.+)$/.exec(path)) && req.method === 'GET') {
      const currency = (url.searchParams.get('currency') || 'USD').toUpperCase();
      const r = await compatOffers(decodeURIComponent(m[1]), currency);
      if (r.error) return ko(r.error);
      const p = toTiProduct(r.mpn, r.offers, currency);
      return p ? ok(p) : reply({ errors: [{ message: 'Product not found' }] }, 404, rl);
    }

    // ---------------------------------------------------------------- webhooks de la plateforme
    if (path === '/v1/webhooks' && req.method === 'POST') {
      const b = await body();
      const { data, error } = await db.rpc('rfq_webhook_create', { p_org: org, p_url: b.json?.url ?? null, p_events: Array.isArray(b.json?.events) ? b.json.events : null });
      if (error) return ko(error);
      const master = Deno.env.get('RFQ_WEBHOOK_KEY') || '';
      // Secret affiché une seule fois : il n'est pas en base, il est dérivé de RFQ_WEBHOOK_KEY.
      return ok({ ...data, signing_secret: master ? await webhookSecret(master, data.id) : null }, 201);
    }
    if (path === '/v1/webhooks' && req.method === 'GET') {
      const { data, error } = await db.rpc('rfq_webhooks', { p_org: org });
      return error ? ko(error) : ok({ webhooks: data });
    }
    if ((m = /^\/v1\/webhooks\/(WHK-\d+)$/i.exec(path)) && req.method === 'DELETE') {
      const { error } = await db.rpc('rfq_webhook_delete', { p_org: org, p_id: m[1] });
      return error ? ko(error) : reply(null, 204, rl);
    }

    // ---------------------------------------------------------------- bac à sable
    if ((m = /^\/v1\/sandbox\/demands\/(DEM-\d+)\/(approve|respond)$/i.exec(path)) && req.method === 'POST') {
      if (!a.sandbox) return failWith(403, 'forbidden', 'Sandbox endpoints need a cp_test_ key', rl);
      const ref = m[1].toUpperCase();
      const { data: mine } = await db.rpc('rfq_demand_for_client', { p_org: org, p_id: ref });
      if (!mine) return failWith(404, 'not_found', 'Unknown demand', rl);
      if (m[2].toLowerCase() === 'approve') {
        const { error } = await db.rpc('approve_rfq', { p_id: ref, p_by: 'sandbox:' + a.key_id });
        if (error) return ko(error);
        await dispatchRfq(db, ref);
        deliverSoon(db);
        const { data } = await db.rpc('rfq_demand_for_client', { p_org: org, p_id: ref });
        return ok(data);
      }
      // Réponse du fournisseur de test : son compte WeChat fictif répond comme dans WeChat.
      const b = await body();
      const { data: contacts } = await db.rpc('rfq_contacts', { p_id: ref, p_all: true });
      const c = ((contacts || []) as { openids: string[]; card: { response?: string } }[]).find((x) => x.card.response === 'pending');
      if (!c?.openids?.length) return failWith(409, 'conflict', 'No sandbox supplier is waiting for an answer', rl);
      const kind = b.json?.kind === 'decline' ? 'decline' : 'quote';
      const { data: ans, error } = await db.rpc('supplier_rfq_answer', {
        p_openid: c.openids[0], p_ref: ref, p_kind: kind, p_net: b.json?.price ?? null, p_currency: b.json?.currency ?? null,
        p_lead: b.json?.lead_days ?? null, p_date_code: b.json?.date_code ?? null, p_lot: null,
      });
      if (error) return ko(error);
      if (ans.all_done) await closeRfq(db, ref);
      deliverSoon(db);
      const { data } = await db.rpc('rfq_demand_for_client', { p_org: org, p_id: ref });
      return ok(data);
    }

    return failWith(404, 'not_found', 'Unknown endpoint', rl);
  } catch (err) {
    console.error(err);
    return failWith(500, 'server', 'Internal error');
  }
});
