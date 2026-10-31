// Fonction Edge « depot » : connexion d'un fournisseur par QR code WeChat (扫码登录), inscription de sa société
// et dépôt de ses fichiers de stock (ADR 0010, 0012). Appelée par la page https://central.parts/depot/ ; déployée
// sans vérification de jeton Supabase (--no-verify-jwt) : elle vérifie elle-même son jeton de session.
//
//   POST /depot/qr          {invite?}  → QR code temporaire du compte de service (5 min) et sa scène
//   POST /depot/qr/poll     {scene}    → en attente, ou jeton de session une fois le QR code scanné
//                                        (status « ok » : société connue ; « register » : compte à inscrire)
//   GET  /depot/me          → société du compte (null s'il doit s'inscrire), et jeton de session à jour
//   POST /depot/register    {name, code, city, profile, currency}  → enregistre la société, en attente de validation
//   POST /depot/license-url {file_name}  → lien de dépôt signé pour la photo de la licence (营业执照)
//   POST /depot/license     {path}       → enregistre la licence et prévient les opérateurs dans WeChat
//   POST /depot/upload-url  {file_name, complete?}  → lien de dépôt signé vers le dossier de la société
//   GET  /depot/imports     → 20 derniers imports de la société, avec leur rapport
//   GET  /depot/requests    → demandes d'achat reçues par la société (90 jours), sans l'acheteur
//   POST /depot/requests/answer {ref, ok} → confirme ou refuse une demande d'achat (ADR 0014)
//   GET  /depot/contacts    → contacts et invitations en cours (administrateur)
//   POST /depot/invite      {label}      → lien d'invitation d'un collègue (administrateur)
//
// Le scan est reçu par la fonction wechat-events (消息推送). Secrets de la fonction (jamais dans le dépôt) :
//   WECHAT_APPID, WECHAT_SECRET (compte de service), DEPOT_SECRET (64 caractères aléatoires).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { licensePath, randomScene, readSession, signSession, storagePath } from '../_shared/depot.js';
import { notifyOperators, requestAnswerNote, supplierCard, wechatPost } from '../_shared/wechat.ts';

const ORIGINS = (Deno.env.get('DEPOT_ORIGINS') || 'https://central.parts').split(',');
const SECRET = Deno.env.get('DEPOT_SECRET') || '';
const SITE = 'https://central.parts/depot/';
// Erreurs de register_supplier (codes SQL) → codes affichés par la page.
const REGISTER_ERRORS: Record<string, string> = { CP001: 'code_invalid', CP002: 'company_exists', CP003: 'already_bound', CP004: 'fields' };

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
  // Sans secret de session, une connexion scannée serait consommée sans pouvoir être remise : on refuse avant tout.
  if (SECRET.length < 32) return json({ error: 'config', detail: 'DEPOT_SECRET absent ou trop court' }, 500);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const path = new URL(req.url).pathname;
  const body = async () => (req.method === 'POST' ? await req.json().catch(() => ({})) : {});

  try {
    // ---------------------------------------------------------------- connexion par QR code
    if (req.method === 'POST' && path.endsWith('/qr')) {
      const { invite } = await body();
      const scene = randomScene();
      const { error } = await db.rpc('depot_login_start', { p_scene: scene, p_invite: invite || null });
      if (error) return json({ error: invite ? 'invite_invalid' : 'database', detail: error.message }, invite ? 403 : 500);
      const qr = await wechatPost(db, '/cgi-bin/qrcode/create', { expire_seconds: 300, action_name: 'QR_STR_SCENE', action_info: { scene: { scene_str: scene } } });
      if (!qr.ticket) return json({ error: 'wechat_refused', errcode: qr.errcode ?? null, detail: qr.errmsg ?? null }, 502);
      return json({ scene, expires_in: qr.expire_seconds, image: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=' + encodeURIComponent(qr.ticket) });
    }

    if (req.method === 'POST' && path.endsWith('/qr/poll')) {
      const { scene } = await body();
      if (!scene) return json({ error: 'scene_missing' }, 422);
      const { data, error } = await db.rpc('depot_login_poll', { p_scene: scene });
      if (error) return json({ error: 'database', detail: error.message }, 500);
      if (data.status === 'register') return json({ status: 'register', token: await signSession(SECRET, { org: null, openid: data.openid }) });
      if (data.status !== 'ok') return json({ status: data.status });
      const token = await signSession(SECRET, { org: data.org.org_id, openid: data.openid });
      return json({ status: 'ok', token, org: data.org });
    }

    // ---------------------------------------------------------------- actions authentifiées
    const session = await readSession(SECRET, (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    if (!session) return json({ error: 'session_expired' }, 401);
    // La société est relue à chaque appel : inscription faite ailleurs, validation, révocation.
    const { data: who } = await db.rpc('depot_identity', { p_openid: session.openid });

    if (req.method === 'GET' && path.endsWith('/me')) {
      return json({ org: who, token: await signSession(SECRET, { org: who?.org_id || null, openid: session.openid }) });
    }

    if (req.method === 'POST' && path.endsWith('/register')) {
      if (who) return json({ error: 'already_bound' }, 409);
      const b = await body();
      const { data, error } = await db.rpc('register_supplier', {
        p_openid: session.openid, p_name: b.name, p_code: b.code, p_city: b.city, p_profile: b.profile, p_currency: b.currency || 'USD',
      });
      if (error) return json({ error: REGISTER_ERRORS[error.code] || 'database', detail: error.message }, error.code in REGISTER_ERRORS ? 422 : 500);
      return json({ org: data, token: await signSession(SECRET, { org: data.org_id, openid: session.openid }) });
    }

    if (!who) return json({ error: 'not_bound' }, 403);
    const org: string = who.org_id;

    if (req.method === 'POST' && path.endsWith('/license-url')) {
      const { file_name } = await body();
      const key = licensePath(org, file_name);
      if (!key) return json({ error: 'format', detail: 'JPG, PNG, HEIC, WEBP ou PDF' }, 422);
      const { data, error } = await db.storage.from('supplier-docs').createSignedUploadUrl(key);
      if (error) return json({ error: 'storage', detail: error.message }, 500);
      return json({ signed_url: data.signedUrl, path: key, max_bytes: 10485760 });
    }

    if (req.method === 'POST' && path.endsWith('/license')) {
      const { path: key } = await body();
      const { error } = await db.rpc('set_supplier_license', { p_org: org, p_path: key });
      if (error) return json({ error: 'database', detail: error.message }, 422);
      if (who.status === 'pending') {
        const { data: pending } = await db.rpc('pending_suppliers');
        const s = (pending || []).find((p: Record<string, unknown>) => p.org_id === org);
        if (s) await notifyOperators(db, await supplierCard(db, s));
      }
      return json({ ok: true });
    }

    if (who.status === 'rejected') return json({ error: 'rejected', detail: who.rejected_reason }, 403);

    if (req.method === 'POST' && path.endsWith('/upload-url')) {
      const { file_name, complete } = await body();
      const key = storagePath(org, file_name, { complete: !!complete });
      if (!key) return json({ error: 'format', detail: 'CSV, XLS ou XLSX' }, 422);
      const { data, error } = await db.storage.from('stock-imports').createSignedUploadUrl(key);
      if (error) return json({ error: 'storage', detail: error.message }, 500);
      return json({ signed_url: data.signedUrl, path: key, max_bytes: 52428800 });
    }

    if (req.method === 'GET' && path.endsWith('/imports')) {
      const { data, error } = await db.from('stock_imports')
        .select('id, file_name, status, rows_total, created, updated, rejected, duplicates, missing_date_code, withdrawn, error, report, received_at, processed_at')
        .eq('org_id', org).order('received_at', { ascending: false }).limit(20);
      if (error) return json({ error: 'database', detail: error.message }, 500);
      // Rapport allégé pour la page : 50 lignes rejetées au plus.
      return json(data.map((i) => ({ ...i, report: { rejected: (i.report?.rejected || []).slice(0, 50) } })));
    }

    if (req.method === 'GET' && path.endsWith('/requests')) {
      const { data, error } = await db.rpc('supplier_requests', { p_openid: session.openid });
      if (error) return json({ error: 'database', detail: error.message }, 500);
      return json(data);
    }

    if (req.method === 'POST' && path.endsWith('/requests/answer')) {
      const { ref, ok } = await body();
      const { data, error } = await db.rpc('supplier_answer', { p_openid: session.openid, p_ref: String(ref || ''), p_ok: !!ok });
      if (error) return json({ error: 'not_found' }, 404);
      await notifyOperators(db, requestAnswerNote(data, !!ok));
      return json(data);
    }

    if (req.method === 'GET' && path.endsWith('/contacts')) {
      const { data, error } = await db.rpc('org_contacts', { p_openid: session.openid });
      if (error) return json({ error: 'forbidden' }, 403);
      return json(data);
    }

    if (req.method === 'POST' && path.endsWith('/invite')) {
      const { label } = await body();
      const { data, error } = await db.rpc('create_member_invite', { p_openid: session.openid, p_label: String(label || '').slice(0, 40) });
      if (error) return json({ error: 'forbidden' }, 403);
      return json({ link: SITE + '?invite=' + data });
    }

    return json({ error: 'not_found' }, 404);
  } catch (err) {
    return json({ error: 'server', detail: err instanceof Error ? err.message : String(err) }, 500);
  }
});
