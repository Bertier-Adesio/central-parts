// Fonction Edge « order » : demandes d'achat depuis la recherche publique https://central.parts/recherche/ (ADR 0014).
// Déployée sans vérification de jeton Supabase (--no-verify-jwt) : un acheteur n'a pas de compte ; il suit sa demande
// avec le jeton reçu à la création.
//
//   GET  /order/quote?mpn&source&ship_from&qty&cur → prix unitaire et total tout compris, quantité couverte ou non
//   POST /order  {mpn, source, ship_from, qty, currency, company, vat, name, email, phone?, country, address, message?}
//                → référence, devis, lien de suivi ; prévient les opérateurs dans WeChat. Le fournisseur n'est prévenu
//                  qu'après la validation d'un administrateur (back office ou robot, ADR 0026)
//   POST /order/cart {lines: [{mpn, source, ship_from, qty}], currency, company, vat, name, email, phone?, country,
//                address, message?} → panier CART-… (une demande PR-… par ligne, ADR 0028), devis, lien de suivi ;
//                prévient les opérateurs (un seul avis pour le panier)
//   POST /order/shipping {lines, currency} → livraison du panier par fournisseur (numérotés, jamais nommés) : conditions,
//                livraison offerte ou montant manquant (migration 20261103000029)
//   GET  /order/status?ref&k → statut de la demande ou du panier (CART-…), jamais le fournisseur
//
// Le numéro de TVA est vérifié auprès du service VIES de la Commission européenne quand c'est possible.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { notifyOperators } from '../_shared/wechat.ts';
import { purchaseCartOperatorNote, purchaseRequestOperatorNote } from '../_shared/robot-texts.js';

const ORIGINS = (Deno.env.get('SEARCH_ORIGINS') || 'https://central.parts').split(',');
const SITE = 'https://central.parts';
const ERRORS: Record<string, [string, number]> = { '22023': ['invalid', 422], P0002: ['not_found', 404], CP429: ['rate_limited', 429] };

// Vérification VIES (pays de l'Union) : true, false, ou null si le service ne répond pas ou ne couvre pas le pays.
async function viesValid(vat: string): Promise<boolean | null> {
  const m = /^([A-Z]{2})([0-9A-Z]+)$/.exec(vat);
  if (!m || ['GB', 'CH', 'NO'].includes(m[1])) return null;
  try {
    const r = await fetch(`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${m[1]}/vat/${m[2]}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const d = await r.json();
    return typeof d.isValid === 'boolean' ? d.isValid : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Content-Type': 'application/json',
    Vary: 'Origin',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
  const fail = (error: { code?: string; message: string }) => {
    const [code, status] = ERRORS[error.code || ''] || ['server', 500];
    return json({ error: code }, status);
  };
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const u = new URL(req.url), q = u.searchParams;

  try {
    if (req.method === 'GET' && u.pathname.endsWith('/quote')) {
      const { data, error } = await db.rpc('public_quote', {
        p_mpn: q.get('mpn') || '', p_source: q.get('source') || '', p_ship_from: q.get('ship_from') || '',
        p_qty: parseInt(q.get('qty') || '0', 10) || 0, p_currency: q.get('cur') || 'EUR',
      });
      return error ? fail(error) : json(data);
    }

    if (req.method === 'GET' && u.pathname.endsWith('/status')) {
      const ref = q.get('ref') || '';
      const { data, error } = /^CART-/i.test(ref)
        ? await db.rpc('purchase_cart_status', { p_cart: ref, p_token: q.get('k') || '' })
        : await db.rpc('purchase_request_status', { p_ref: ref, p_token: q.get('k') || '' });
      if (error) return fail(error);
      return data ? json(data) : json({ error: 'not_found' }, 404);
    }

    if (req.method === 'POST' && u.pathname.endsWith('/shipping')) {
      const b = await req.json().catch(() => ({}));
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
      const { data, error } = await db.rpc('cart_shipping', { p_ip: ip, p: { currency: b.currency, lines: Array.isArray(b.lines) ? b.lines : [] } });
      return error ? fail(error) : json(data);
    }

    if (req.method === 'POST' && u.pathname.endsWith('/cart')) {
      const b = await req.json().catch(() => ({}));
      const vat = String(b.vat || '').toUpperCase().replace(/[\s.-]/g, '');
      const valid = await viesValid(vat);
      if (valid === false) return json({ error: 'vat_invalid' }, 422);
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
      const { data, error } = await db.rpc('create_purchase_cart', { p_ip: ip, p: { ...b, vat, vat_checked: valid === true } });
      if (error) {
        if (error.code === 'P0002') return json({ error: 'not_found', mpn: error.details || null }, 404);
        // Quantité hors MOQ ou SPQ : référence, quantité minimale et SPQ du lot retenu (indice « min/spq »).
        if (error.code === 'CP422') {
          const [min, spq] = String(error.hint || '').split('/').map((x) => parseInt(x, 10) || null);
          return json({ error: 'qty_invalid', mpn: error.details || null, min_qty: min, spq }, 422);
        }
        return fail(error);
      }
      // Opérateurs seulement, un avis pour tout le panier : rien ne part chez les fournisseurs avant la validation.
      const notify = (async () => {
        const cards = [];
        for (const l of data.lines) {
          const { data: op } = await db.rpc('request_for_operator', { p_ref: l.ref });
          if (op) cards.push(op);
        }
        if (cards.length) await notifyOperators(db, purchaseCartOperatorNote(data.ref, cards, data.total, data.currency));
      })().catch(() => {});
      const rt = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (rt) rt.waitUntil(notify); else await notify;
      return json({ ...data, vat_checked: valid === true,
        status_url: `${SITE}/recherche/commande/?ref=${encodeURIComponent(data.ref)}&k=${data.token}` });
    }

    if (req.method === 'POST' && u.pathname.endsWith('/order')) {
      const b = await req.json().catch(() => ({}));
      const vat = String(b.vat || '').toUpperCase().replace(/[\s.-]/g, '');
      const valid = await viesValid(vat);
      if (valid === false) return json({ error: 'vat_invalid' }, 422);
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
      const { data, error } = await db.rpc('create_purchase_request', { p_ip: ip, p: { ...b, vat, vat_checked: valid === true } });
      if (error) return fail(error);

      // Opérateurs seulement : rien ne part chez le fournisseur avant la validation d'un administrateur (ADR 0026).
      const notify = (async () => {
        const { data: op } = await db.rpc('request_for_operator', { p_ref: data.ref });
        if (op) await notifyOperators(db, purchaseRequestOperatorNote(op));
      })().catch(() => {});
      const rt = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (rt) rt.waitUntil(notify); else await notify;

      return json({ ...data, vat_checked: valid === true,
        status_url: `${SITE}/recherche/commande/?ref=${encodeURIComponent(data.ref)}&k=${data.token}` });
    }

    return json({ error: 'not_found' }, 404);
  } catch (err) {
    return json({ error: 'server', detail: err instanceof Error ? err.message : String(err) }, 500);
  }
});
