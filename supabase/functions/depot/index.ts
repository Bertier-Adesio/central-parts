// Fonction Edge « depot » : connexion d'un fournisseur par QR code WeChat (扫码登录) et dépôt de ses fichiers de stock
// (ADR 0010). Appelée par la page https://central.parts/depot/ ; déployée sans vérification de jeton Supabase
// (--no-verify-jwt) : elle vérifie elle-même son jeton de session.
//
//   POST /depot/qr          {invite?}  → QR code temporaire du compte de service (5 min) et sa scène
//   POST /depot/qr/poll     {scene}    → en attente, ou jeton de session et société une fois le QR code scanné
//   POST /depot/upload-url  {file_name, complete?}  → lien de dépôt signé vers le dossier de la société
//   GET  /depot/imports     → 20 derniers imports de la société, avec leur rapport
//
// Le scan est reçu par la fonction wechat-events (消息推送). Secrets de la fonction (jamais dans le dépôt) :
//   WECHAT_APPID, WECHAT_SECRET (compte de service), DEPOT_SECRET (64 caractères aléatoires).
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { randomScene, readSession, signSession, storagePath } from '../_shared/depot.js';

const ORIGINS = (Deno.env.get('DEPOT_ORIGINS') || 'https://central.parts').split(',');
const SECRET = Deno.env.get('DEPOT_SECRET') || '';

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const path = new URL(req.url).pathname;

  try {
    // ---------------------------------------------------------------- connexion par QR code
    if (req.method === 'POST' && path.endsWith('/qr')) {
      const { invite } = await req.json().catch(() => ({}));
      const scene = randomScene();
      const { error } = await db.rpc('depot_login_start', { p_scene: scene, p_invite: invite || null });
      if (error) return json({ error: invite ? 'invite_invalid' : 'database', detail: error.message }, invite ? 403 : 500);
      const qr = await createQr(db, scene);
      if (!qr.ticket) return json({ error: 'wechat_refused', errcode: qr.errcode ?? null, detail: qr.errmsg ?? null }, 502);
      return json({ scene, expires_in: qr.expire_seconds, image: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=' + encodeURIComponent(qr.ticket) });
    }

    if (req.method === 'POST' && path.endsWith('/qr/poll')) {
      const { scene } = await req.json().catch(() => ({}));
      if (!scene) return json({ error: 'scene_missing' }, 422);
      const { data, error } = await db.rpc('depot_login_poll', { p_scene: scene });
      if (error) return json({ error: 'database', detail: error.message }, 500);
      if (data.status !== 'ok') return json({ status: data.status });
      const token = await signSession(SECRET, { org: data.org.org_id, openid: data.openid });
      return json({ status: 'ok', token, org: { name: data.org.name, alias: data.org.alias, lang: data.org.lang } });
    }

    // ---------------------------------------------------------------- actions authentifiées
    const session = await readSession(SECRET, (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    if (!session) return json({ error: 'session_expired' }, 401);
    // Le rattachement peut avoir été révoqué depuis la connexion.
    const { data: who } = await db.rpc('depot_identity', { p_openid: session.openid });
    if (!who || who.org_id !== session.org) return json({ error: 'not_bound' }, 403);

    if (req.method === 'POST' && path.endsWith('/upload-url')) {
      const { file_name, complete } = await req.json().catch(() => ({}));
      const key = storagePath(session.org, file_name, { complete: !!complete });
      if (!key) return json({ error: 'format', detail: 'CSV, XLS ou XLSX' }, 422);
      const { data, error } = await db.storage.from('stock-imports').createSignedUploadUrl(key);
      if (error) return json({ error: 'storage', detail: error.message }, 500);
      return json({ signed_url: data.signedUrl, path: key, max_bytes: 52428800 });
    }

    if (req.method === 'GET' && path.endsWith('/imports')) {
      const { data, error } = await db.from('stock_imports')
        .select('id, file_name, status, rows_total, created, updated, rejected, duplicates, missing_date_code, withdrawn, error, report, received_at, processed_at')
        .eq('org_id', session.org).order('received_at', { ascending: false }).limit(20);
      if (error) return json({ error: 'database', detail: error.message }, 500);
      // Rapport allégé pour la page : 50 lignes rejetées au plus.
      return json(data.map((i) => ({ ...i, report: { rejected: (i.report?.rejected || []).slice(0, 50) } })));
    }

    return json({ error: 'not_found' }, 404);
  } catch (err) {
    return json({ error: 'server', detail: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ---------------------------------------------------------------- API WeChat
// Jeton d'accès partagé (stable_token), gardé en base jusqu'à cinq minutes avant son échéance.
async function accessToken(db: SupabaseClient, force = false): Promise<string> {
  const appid = Deno.env.get('WECHAT_APPID') || '';
  if (!force) {
    const { data } = await db.from('wechat_access_tokens').select('token, expires_at').eq('appid', appid).maybeSingle();
    if (data && new Date(data.expires_at).getTime() - Date.now() > 5 * 60 * 1000) return data.token;
  }
  const r = await (await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid, secret: Deno.env.get('WECHAT_SECRET') || '', force_refresh: force }),
  })).json();
  if (!r.access_token) throw new Error('Jeton WeChat refusé : ' + (r.errcode ?? '') + ' ' + (r.errmsg ?? ''));
  await db.from('wechat_access_tokens').upsert({ appid, token: r.access_token, expires_at: new Date(Date.now() + r.expires_in * 1000).toISOString() });
  return r.access_token;
}

// QR code temporaire du compte de service portant la scène ; un jeton périmé est renouvelé une fois.
async function createQr(db: SupabaseClient, scene: string) {
  const body = JSON.stringify({ expire_seconds: 300, action_name: 'QR_STR_SCENE', action_info: { scene: { scene_str: scene } } });
  for (const force of [false, true]) {
    const token = await accessToken(db, force);
    const r = await (await fetch('https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=' + token, { method: 'POST', body })).json();
    if (r.ticket || ![40001, 40014, 42001].includes(r.errcode)) return r;
  }
  return { errcode: 40001, errmsg: 'access_token' };
}
