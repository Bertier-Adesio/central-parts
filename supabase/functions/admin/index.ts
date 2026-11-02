// Fonction Edge « admin » : back office Central.Parts (https://central.parts/admin/, ADR 0018).
// Déployée sans vérification de jeton par la passerelle (--no-verify-jwt), pour que la demande de lien de connexion
// passe ; toutes les autres routes exigent le jeton Supabase Auth de l'administrateur, contrôlé ici (getUser) puis
// par la base : chaque fonction SQL admin_* est appelée AVEC ce jeton et refuse quiconque n'est pas membre de
// l'organisation Central.Parts (app.is_ops). La clé de service ne sert qu'à prévenir le fournisseur dans WeChat.
//
//   POST /admin/login     {email}           → envoie un lien de connexion (réponse identique que l'adresse existe ou non)
//   GET  /admin/me                          → administrateur connecté
//   GET  /admin/suppliers?status=pending    → fournisseurs (pending, validated, rejected ; vide : tous) et compteurs
//   GET  /admin/supplier?org=ORG-0107       → fiche, contacts, stock, journal des décisions
//   POST /admin/approve   {org}             → approuve (même fonction que « approve ORG-… » du robot)
//   POST /admin/reject    {org, reason}     → refuse, motif obligatoire (même fonction que « reject ORG-… motif »)
//   POST /admin/pending   {org, reason?}    → remet en attente (aucun message au fournisseur)
//   GET  /admin/stock                       → par fournisseur : références, dernier import, sources, devise
//   GET  /admin/lots?org=&q=&offset=        → références et paliers de prix, 50 par page (lecture seule)
//
// Secrets et variables (jamais dans le dépôt) : SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (fournis
// par Supabase), WECHAT_APPID et WECHAT_SECRET (déjà définis pour le robot), ADMIN_ORIGINS et ADMIN_SITE (facultatifs).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { sendText } from '../_shared/wechat.ts';

const ORIGINS = (Deno.env.get('ADMIN_ORIGINS') || 'https://central.parts,https://www.central.parts').split(',');
const SITE = Deno.env.get('ADMIN_SITE') || 'https://central.parts/admin/';
const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;

// Erreurs SQL → codes lus par la page.
const ERRORS: Record<string, [string, number]> = {
  '42501': ['forbidden', 403],
  CP005: ['reason_required', 422],
  CP006: ['already_pending', 409],
  P0002: ['not_allowed', 409],     // société inconnue, ou refus d'une société déjà approuvée
  PGRST301: ['session_expired', 401],
};

// Messages au fournisseur : mêmes textes que le robot WeChat (wechat-events, commandes approve / reject), pour que
// le fournisseur reçoive exactement la même chose quel que soit le canal de la décision. À garder identiques.
const APPROVED = (alias: string) =>
  `您的公司已通过 Central.Parts 审核（编号 ${alias}），库存已纳入 Central.Parts 平台。\nYour company has been approved by Central.Parts (${alias}).`;
const REJECTED = (reason: string) =>
  `您的公司未通过 Central.Parts 审核${reason ? '：' + reason : '。'}\n如有疑问，请直接回复此消息。`;

// WeChat n'a pas à retarder la réponse à la page : l'avis part après.
const later = (p: Promise<unknown>) => {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt) rt.waitUntil(p.catch(() => {})); else p.catch(() => {});
};

async function tellSupplier(org: string, text: string) {
  const svc = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data } = await svc.rpc('org_admins', { p_org: org });
  await Promise.all(((data || []) as string[]).map((o) => sendText(svc, o, text)));
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/admin/, '') || '/';
  const body = async () => (req.method === 'POST' ? await req.json().catch(() => ({})) : {});

  try {
    // ---------------------------------------------------------------- lien de connexion (Supabase Auth)
    if (req.method === 'POST' && path === '/login') {
      const { email } = await body();
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return json({ error: 'email' }, 422);
      const auth = createClient(URL_, ANON, { auth: { persistSession: false, flowType: 'implicit' } });
      // Aucun compte n'est créé ici : seules les adresses déjà inscrites dans Supabase Auth reçoivent un lien.
      // La réponse ne dit pas si l'adresse existe.
      await auth.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: SITE } });
      return json({ ok: true });
    }

    // ---------------------------------------------------------------- routes réservées aux administrateurs
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'session_expired' }, 401);
    const db = createClient(URL_, ANON, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: who, error: authError } = await db.auth.getUser(token);
    if (authError || !who?.user) return json({ error: 'session_expired' }, 401);

    // Appel d'une fonction SQL admin_* : réponse d'erreur prête (res) ou données (data).
    // deno-lint-ignore no-explicit-any
    const call = async (fn: string, args: Record<string, unknown> = {}): Promise<{ res?: Response; data?: any }> => {
      const { data, error } = await db.rpc(fn, args);
      if (error) {
        const [code, status] = ERRORS[error.code] || ['database', 500];
        return { res: json({ error: code, detail: error.message }, status) };
      }
      return { data };
    };
    const send = async (fn: string, args: Record<string, unknown> = {}) => {
      const r = await call(fn, args);
      return r.res || json(r.data);
    };
    const q = (k: string) => url.searchParams.get(k) || null;

    if (req.method === 'GET') {
      if (path === '/me') return send('admin_me');
      if (path === '/suppliers') {
        const status = q('status');
        if (status && !['pending', 'validated', 'rejected'].includes(status)) return json({ error: 'status' }, 422);
        return send('admin_suppliers', { p_status: status });
      }
      if (path === '/supplier') return send('admin_supplier', { p_org: q('org') });
      if (path === '/stock') return send('admin_stock_summary');
      if (path === '/lots') {
        return send('admin_lots', { p_org: q('org'), p_q: q('q') || '', p_limit: 50, p_offset: Number(q('offset')) || 0 });
      }
    }

    if (req.method === 'POST') {
      const { org, reason } = await body();
      if (typeof org !== 'string' || !/^[A-Z0-9-]{1,32}$/.test(org)) return json({ error: 'org' }, 422);
      if (path === '/approve') {
        const r = await call('admin_approve', { p_org: org });
        if (r.res) return r.res;
        later(tellSupplier(org, APPROVED(r.data.alias)));
        return json(r.data);
      }
      if (path === '/reject') {
        const why = typeof reason === 'string' ? reason.trim() : '';
        if (!why) return json({ error: 'reason_required' }, 422);
        const r = await call('admin_reject', { p_org: org, p_reason: why });
        if (r.res) return r.res;
        later(tellSupplier(org, REJECTED(why)));
        return json(r.data);
      }
      if (path === '/pending') {
        return send('admin_reset_pending', { p_org: org, p_reason: typeof reason === 'string' ? reason.trim() || null : null });
      }
    }
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    return json({ error: 'server', detail: String(e) }, 500);
  }
});
