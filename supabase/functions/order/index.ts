// Fonction Edge « order » : demandes d'achat depuis la recherche publique https://central.parts/recherche/ (ADR 0014).
// Déployée sans vérification de jeton Supabase (--no-verify-jwt) : un acheteur n'a pas de compte ; il suit sa demande
// avec le jeton reçu à la création.
//
//   GET  /order/quote?mpn&source&ship_from&qty&cur → prix unitaire et total tout compris, quantité couverte ou non
//   POST /order  {mpn, source, ship_from, qty, currency, company, vat, name, email, phone?, country, address, message?}
//                → référence, devis, lien de suivi ; prévient le fournisseur et les opérateurs dans WeChat
//   GET  /order/status?ref&k → statut de la demande (jamais le fournisseur)
//
// Le numéro de TVA est vérifié auprès du service VIES de la Commission européenne quand c'est possible.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { notifyOperators, sendText } from '../_shared/wechat.ts';

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

async function tellSupplier(db: SupabaseClient, sellerId: string, text: string) {
  const { data } = await db.from('wechat_identities').select('openid').eq('org_id', sellerId).is('revoked_at', null);
  await Promise.all((data || []).map((w: { openid: string }) => sendText(db, w.openid, text)));
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
      const { data, error } = await db.rpc('purchase_request_status', { p_ref: q.get('ref') || '', p_token: q.get('k') || '' });
      if (error) return fail(error);
      return data ? json(data) : json({ error: 'not_found' }, 404);
    }

    if (req.method === 'POST' && u.pathname.endsWith('/order')) {
      const b = await req.json().catch(() => ({}));
      const vat = String(b.vat || '').toUpperCase().replace(/[\s.-]/g, '');
      const valid = await viesValid(vat);
      if (valid === false) return json({ error: 'vat_invalid' }, 422);
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
      const { data, error } = await db.rpc('create_purchase_request', { p_ip: ip, p: { ...b, vat, vat_checked: valid === true } });
      if (error) return fail(error);

      // Fournisseur (sans l'acheteur) et opérateurs (fiche complète), après la réponse à l'acheteur.
      const notify = (async () => {
        const { data: sup } = await db.from('purchase_requests').select('seller_id, supplier_unit_price, supplier_currency, delivery_country').eq('id', data.ref).single();
        const { data: op } = await db.rpc('request_for_operator', { p_ref: data.ref });
        if (sup?.seller_id) {
          await tellSupplier(db, sup.seller_id, [
            `【新询单 ${data.ref}】`,
            `型号 ${op.mpn}，数量 ${op.qty}`,
            `您的单价 ${sup.supplier_unit_price ?? '待报价'} ${sup.supplier_currency}，交货国家 ${sup.delivery_country}`,
            `请在 24 小时内回复「确认 ${data.ref}」或「无货 ${data.ref}」，或在 ${SITE}/depot/ 处理。`,
          ].join('\n'));
        }
        await notifyOperators(db, [
          `[Purchase request ${op.ref}] ${op.mpn} × ${op.qty}`,
          `Buyer: ${op.buyer_company} · ${op.buyer_vat}${op.vat_checked ? ' (VIES checked)' : ' (not checked)'}`,
          `${op.buyer_name} · ${op.buyer_email}${op.buyer_phone ? ' · ' + op.buyer_phone : ''}`,
          `Delivery: ${op.delivery}`,
          `Price ${op.unit_price ?? 'to confirm'} ${op.currency} (total ${op.total ?? 'to confirm'})`,
          `Supplier ${op.supplier}: ${op.supplier_unit_price ?? '?'} ${op.supplier_currency}, stock ${op.lot_qty}`,
          op.message ? `Message: ${op.message}` : '',
        ].filter(Boolean).join('\n'));
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
