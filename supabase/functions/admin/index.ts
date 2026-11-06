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
//   POST /admin/depot-link {org}            → lien vers le dépôt d'un fournisseur approuvé, au nom de l'administrateur,
//                                             valable 8 heures et inscrit au journal (ADR 0021, complément)
//   GET  /admin/stock                       → par fournisseur : références, dernier import, sources, devise
//   GET  /admin/lots?org=&q=&offset=        → références et paliers de prix, 50 par page (lecture seule)
//   GET  /admin/rfq?status=pending_validation → RFQ des plateformes (ADR 0023) ; status vide : toutes (100 dernières)
//   POST /admin/rfq/approve {id, only?}     → valide et diffuse (même fonction que « approve DEM-… » du robot)
//   POST /admin/rfq/reject  {id, reason}    → refuse, motif obligatoire (même fonction que « reject DEM-… motif »)
//   GET  /admin/requests?status=pending_validation → demandes d'achat du site (ADR 0026) ; status vide : toutes (100 dernières)
//   POST /admin/requests/approve {ref}      → valide et prévient le fournisseur dans WeChat (même fonction que « approve PR-… »)
//   POST /admin/requests/reject  {ref, reason} → refuse, motif interne obligatoire (même fonction que « reject PR-… motif »)
//   GET  /admin/supplier-addresses?org=ORG-0107 → adresses d'expédition du vendeur (ADR 0030)
//   GET  /admin/supplier-profile?org=ORG-0107   → fiche société : présentation, chiffres, paiement, contacts, fabricants rattachés (ADR 0032)
//   POST /admin/supplier-profile {org, profile} → enregistre la fiche (clé absente : inchangée)
//   POST /admin/supplier-editor {org, openid}   → désigne le seul compte WeChat qui modifie la fiche dans /depot/
//   GET  /admin/manufacturers                   → fabricants, leurs marques, leurs comptes rattachés et leur page publique
//   GET  /admin/manufacturer?id=MFR-0001        → fiche d'un fabricant
//   POST /admin/manufacturer {id?, manufacturer} → crée (sans id) ou modifie un fabricant
//   POST /admin/manufacturer/link {id, org, role} → rattache un compte : role self (le fabricant lui-même) ou authorized
//   POST /admin/manufacturer/unlink {id, org}   → détache un compte
//   POST /admin/manufacturer/publish {id, on}   → publie ou retire la page publique du fabricant (/fabricants/) ;
//                                               publication : accord d'un compte rattaché requis (migration 20261106000035)
//   POST /admin/manufacturer/consent {id, org, on} → enregistre l'accord reçu hors plateforme, ou le retire
//   POST /admin/manufacturer/proposal {proposal, apply} → applique ou écarte une correction proposée par un fournisseur
//   POST /admin/supplier-contact {org, contact} → ajoute (sans id) ou modifie un contact
//   POST /admin/supplier-contact/delete {org, id} → retire un contact
//   POST /admin/logo-upload-url {id, type}      → lien signé pour déposer le logo d'un fabricant (PNG, JPEG, WebP, 1 Mo)
//   GET  /admin/supplier-score?org=ORG-0107 → taux de traitement des RFQ d'un fournisseur (jamais montré à une plateforme)
//   GET  /admin/offer-views?org=ORG-0107    → consultations de ses offres par l'API d'offres, 8 semaines (ADR 0024)
//   GET  /admin/data-quality?org=ORG-0107   → complétude de ses fiches produit (future composante de sa notation)
//
// Secrets et variables (jamais dans le dépôt) : SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (fournis
// par Supabase), WECHAT_APPID et WECHAT_SECRET (déjà définis pour le robot), ADMIN_ORIGINS et ADMIN_SITE (facultatifs).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { approvedNotice, rejectedNotice } from '../_shared/robot-texts.js';
import { notifySupplierOfRequest, sendText } from '../_shared/wechat.ts';
import { deliverWebhooks, dispatchRfq } from '../_shared/rfq-dispatch.ts';

const ORIGINS = (Deno.env.get('ADMIN_ORIGINS') || 'https://central.parts,https://www.central.parts').split(',');
const SITE = Deno.env.get('ADMIN_SITE') || 'https://central.parts/admin/';
const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;

// Erreurs SQL → codes lus par la page.
const ERRORS: Record<string, [string, number]> = {
  '42501': ['forbidden', 403],
  CP005: ['reason_required', 422],
  CP006: ['already_pending', 409],
  CP409: ['already_decided', 409], // RFQ déjà validée ou refusée
  '22023': ['invalid', 422],       // RFQ : société hors appariement (only)
  P0002: ['not_allowed', 409],     // société inconnue, ou refus d'une société déjà approuvée
  PGRST301: ['session_expired', 401],
};

// Messages au fournisseur : mêmes textes que le robot WeChat (wechat-events, commandes approve / reject), pris dans
// _shared/robot-texts.js, pour que le fournisseur reçoive exactement la même chose quel que soit le canal de la décision.
const APPROVED = approvedNotice;
const REJECTED = rejectedNotice;

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
      if (path === '/rfq') return send('admin_rfq_list', { p_status: url.searchParams.has('status') ? q('status') : 'pending_validation' });
      if (path === '/requests') {
        const status = url.searchParams.has('status') ? q('status') : 'pending_validation';
        if (status && !/^[a-z_]{1,32}$/.test(status)) return json({ error: 'status' }, 422);
        return send('admin_requests', { p_status: status });
      }
      if (path === '/supplier-profile') return send('admin_supplier_profile', { p_org: q('org') });
      if (path === '/manufacturers') return send('admin_manufacturers');
      if (path === '/manufacturer') return send('admin_manufacturer', { p_id: q('id') });
      if (path === '/supplier-addresses') return send('admin_seller_addresses', { p_org: q('org') });
      if (path === '/supplier-score') return send('admin_supplier_score', { p_org: q('org') });
      if (path === '/offer-views') return send('admin_offer_views', { p_org: q('org') });
      if (path === '/data-quality') return send('admin_supplier_data_quality', { p_org: q('org') });
      if (path === '/lots') {
        return send('admin_lots', { p_org: q('org'), p_q: q('q') || '', p_limit: 50, p_offset: Number(q('offset')) || 0 });
      }
    }

    // RFQ des plateformes : la décision passe par la base avec le jeton de l'administrateur ; la diffusion aux
    // fournisseurs (WeChat) se fait ensuite avec la clé de service, comme pour le robot.
    if (req.method === 'POST' && (path === '/rfq/approve' || path === '/rfq/reject')) {
      const { id, only, reason } = await body();
      if (typeof id !== 'string' || !/^DEM-\d{1,8}$/i.test(id)) return json({ error: 'id' }, 422);
      if (path === '/rfq/reject') {
        const why = typeof reason === 'string' ? reason.trim() : '';
        if (!why) return json({ error: 'reason_required' }, 422);
        const r = await call('admin_rfq_reject', { p_id: id, p_reason: why });
        if (r.res) return r.res;
        later(deliverWebhooks(createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })));
        return json(r.data);
      }
      const list = Array.isArray(only) && only.length ? only.map((x: unknown) => String(x).toUpperCase()) : null;
      const r = await call('admin_rfq_approve', { p_id: id, p_only: list });
      if (r.res) return r.res;
      const svc = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
      const dispatch = r.data.status === 'auction' ? await dispatchRfq(svc, r.data.id) : null;
      later(deliverWebhooks(svc));
      return json({ ...r.data, dispatch });
    }

    // Demandes d'achat du site (ADR 0026) : décision avec le jeton de l'administrateur, puis message WeChat au
    // fournisseur avec la clé de service, comme le robot.
    if (req.method === 'POST' && (path === '/requests/approve' || path === '/requests/reject')) {
      const { ref, reason } = await body();
      if (typeof ref !== 'string' || !/^PR-\d{1,8}$/i.test(ref.trim())) return json({ error: 'ref' }, 422);
      if (path === '/requests/reject') {
        const why = typeof reason === 'string' ? reason.trim() : '';
        if (!why) return json({ error: 'reason_required' }, 422);
        return send('admin_request_reject', { p_ref: ref.trim(), p_reason: why });
      }
      const r = await call('admin_request_approve', { p_ref: ref.trim() });
      if (r.res) return r.res;
      const { supplier_view: view, ...card } = r.data;
      const svc = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
      const notified = card.seller_id && view ? await notifySupplierOfRequest(svc, card.seller_id, view).catch(() => 0) : 0;
      return json({ ...card, notified });
    }

    // Fabricants (migration 20261105000033) : identifiés par leur id MFR-…, pas par une société.
    if (req.method === 'POST' && (path.startsWith('/manufacturer') || path === '/logo-upload-url')) {
      const b = await body();
      const id = typeof b.id === 'string' && /^MFR-[0-9]{1,10}$/.test(b.id) ? b.id : null;
      if (path === '/manufacturer') return send('admin_manufacturer_save', { p_id: id, p: b.manufacturer || {} });
      if (path === '/manufacturer/proposal') {
        if (!Number.isInteger(b.proposal)) return json({ error: 'id' }, 422);
        return send('admin_manufacturer_proposal_decide', { p_id: b.proposal, p_apply: b.apply === true });
      }
      if (!id) return json({ error: 'id' }, 422);
      if (path === '/manufacturer/link') return send('admin_manufacturer_link', { p_id: id, p_org: String(b.org || ''), p_role: String(b.role || '') });
      if (path === '/manufacturer/unlink') return send('admin_manufacturer_unlink', { p_id: id, p_org: String(b.org || '') });
      if (path === '/manufacturer/publish') return send('admin_manufacturer_publish', { p_id: id, p_on: b.on === true });
      if (path === '/manufacturer/consent') return send('admin_manufacturer_consent', { p_id: id, p_org: String(b.org || ''), p_on: b.on === true });
      if (path === '/logo-upload-url') {
        const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[String(b.type)];
        if (!ext) return json({ error: 'format' }, 422);
        const chk = await call('admin_manufacturer', { p_id: id }); // contrôle administrateur et fabricant
        if (chk.res) return chk.res;
        const svc = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
        const key = `${id}/logo-${Date.now()}.${ext}`;
        const { data, error } = await svc.storage.from('seller-logos').createSignedUploadUrl(key);
        if (error) return json({ error: 'storage' }, 500);
        return json({ signed_url: data.signedUrl, path: key, public_url: `${URL_}/storage/v1/object/public/seller-logos/${key}` });
      }
      return json({ error: 'not_found' }, 404);
    }

    if (req.method === 'POST') {
      const b = await body();
      const { org, reason } = b;
      if (typeof org !== 'string' || !/^[A-Z0-9-]{1,32}$/.test(org)) return json({ error: 'org' }, 422);
      // Fiche société et contacts (ADR 0032).
      if (path === '/supplier-profile') return send('admin_supplier_profile_save', { p_org: org, p: b.profile || {} });
      if (path === '/supplier-editor') return send('admin_set_profile_editor', { p_org: org, p_openid: String(b.openid || '') });
      if (path === '/supplier-contact') return send('admin_seller_contact_save', { p_org: org, p: b.contact || {} });
      if (path === '/supplier-contact/delete') return send('admin_seller_contact_delete', { p_org: org, p_id: String(b.id || '') });
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
      if (path === '/depot-link') {
        const r = await call('admin_depot_link', { p_org: org });
        if (r.res) return r.res;
        return json({ url: new URL('/depot/lien/', SITE).href + '#k=' + r.data.token, expires_at: r.data.expires_at });
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
