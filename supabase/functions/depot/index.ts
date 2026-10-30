// Fonction Edge « depot » : connexion d'un fournisseur par WeChat et dépôt de ses fichiers de stock (ADR 0010).
// Appelée par la page https://central.parts/depot/ ; déployée sans vérification de jeton Supabase (--no-verify-jwt) :
// elle vérifie elle-même son jeton de session.
//
//   POST /depot/session     {code, invite?}  code WeChat (网页授权) → jeton de session et société
//   POST /depot/upload-url  {file_name, complete?}  → lien de dépôt signé vers le dossier de la société
//   GET  /depot/imports     → 20 derniers imports de la société, avec leur rapport
//
// Secrets de la fonction (tableau de bord ou `supabase secrets set`, jamais dans le dépôt) :
//   WECHAT_APPID, WECHAT_SECRET (compte de service), DEPOT_SECRET (64 caractères aléatoires).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { readSession, signSession, storagePath } from './lib.js';

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
    // ---------------------------------------------------------------- connexion WeChat
    if (req.method === 'POST' && path.endsWith('/session')) {
      const { code, invite } = await req.json().catch(() => ({}));
      if (!code) return json({ error: 'code_missing' }, 422);
      const url = 'https://api.weixin.qq.com/sns/oauth2/access_token?' + new URLSearchParams({
        appid: Deno.env.get('WECHAT_APPID') || '', secret: Deno.env.get('WECHAT_SECRET') || '',
        code, grant_type: 'authorization_code',
      });
      const wx = await (await fetch(url)).json();
      if (!wx.openid) return json({ error: 'wechat_refused', detail: wx.errmsg || null, errcode: wx.errcode || null }, 401);

      if (invite) {
        const { error } = await db.rpc('redeem_depot_invite', { p_token: invite, p_openid: wx.openid, p_unionid: wx.unionid || null });
        if (error) return json({ error: 'invite_invalid', detail: error.message }, 403);
      }
      const { data: who } = await db.rpc('depot_identity', { p_openid: wx.openid });
      if (!who) return json({ error: 'not_bound' }, 403);
      const token = await signSession(SECRET, { org: who.org_id, openid: wx.openid });
      return json({ token, org: { name: who.name, alias: who.alias, lang: who.lang } });
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
