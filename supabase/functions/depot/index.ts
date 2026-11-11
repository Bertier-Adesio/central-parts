// Fonction Edge « depot » : connexion d'un fournisseur par QR code WeChat (扫码登录), inscription de sa société
// et dépôt de ses fichiers de stock (ADR 0010, 0012). Appelée par la page https://central.parts/depot/ ; déployée
// sans vérification de jeton Supabase (--no-verify-jwt) : elle vérifie elle-même son jeton de session.
//
//   POST /depot/qr          {invite?}  → QR code temporaire du compte de service (5 min) et sa scène
//   POST /depot/qr/poll     {scene}    → en attente, ou jeton de session une fois le QR code scanné
//                                        (status « ok » : société connue ; « register » : compte à inscrire)
//   GET  /depot/me          → société du compte (null s'il doit s'inscrire), et jeton de session à jour
//   POST /depot/doc-url     {kind: licence|agrement, file_name} → lien de dépôt signé pour une pièce déposée AVANT
//                           l'inscription (dossier pending/<empreinte de l'openid>/, ADR 0034)
//   POST /depot/register    {name, profile: Manufacturer|Distributor|Spot, currency, code?, region?, city?, license_path?,
//                           brands?, auth_path?, website?, wecom?, contacts: [{family_name, given_name, role, phone, wechat,
//                           email, duty}]} → enregistre la société, en attente de validation. Bloquent l'envoi : nom, profil,
//                           photo de la licence OU numéro, nom du contact principal, devise ; le reste se complète plus tard
//   POST /depot/signup      {name?, profile?, code?, region?, city?, brands?, website?, wecom?} → compléter sa fiche ; après
//                           l'approbation, le nom, le profil et le numéro ne changent plus que par Central.Parts (ADR 0034)
//   POST /depot/license-url {file_name}  → lien de dépôt signé pour la photo de la licence (营业执照)
//   POST /depot/license     {path}       → enregistre la licence et prévient les opérateurs dans WeChat
//   POST /depot/upload-url  {file_name, complete?, currency}  → lien de dépôt signé vers le dossier de la société ;
//                           currency (USD, CNH, EUR, HKD) : devise des prix si le fichier ne l'indique pas, obligatoire
//   GET  /depot/offers-status → validité des offres (en ligne, à reconfirmer, échéance) ; POST /depot/reconfirm → reconfirmer
//                           toutes les offres en stock sans nouveau fichier (ADR 0025)
//   GET  /depot/imports     → 20 derniers imports de la société, avec leur rapport (complétude des fiches produit comprise)
//   GET  /depot/quality     → complétude des fiches produit de la société, sur son stock en ligne (ADR 0024)
//   GET  /depot/requests    → demandes d'achat reçues par la société (90 jours), sans l'acheteur
//   POST /depot/requests/answer {ref, ok} → confirme ou refuse une demande d'achat (ADR 0014)
//   GET  /depot/rfqs        → RFQ des plateformes reçues (90 jours) et taux de traitement de la société (ADR 0023)
//   POST /depot/rfqs/answer {ref, kind: quote|decline, price, currency, lead_days, date_code} → réponse, refusée après
//                           l'échéance de 48 h (même fonction que 报价 / 无货 DEM-… dans WeChat)
//   GET  /depot/sourcing    → recherches payantes : éligibilité, inscription comme broker volontaire, recherches reçues
//   POST /depot/sourcing/join {on, labs} → s'inscrire (s'engager à répondre sous 48 h) ou se retirer ; laboratoires partenaires
//   POST /depot/sourcing/answer {ref, kind: quote|decline, price, currency, lead_days, date_code, qty?} → même fonction que
//                           报价 / 无货 SRC-… dans WeChat ; l'offre est montrée tout de suite à l'acheteur (ADR 0033)
//   GET  /depot/contacts    → contacts et invitations en cours (administrateur)
//   POST /depot/invite      {label}      → lien d'invitation d'un collègue (administrateur)
//   GET  /depot/company     → fiche de la société, contacts et fabricants rattachés (page, accord, correction en attente)
//   POST /depot/company     {profile}    → enregistre la fiche de la société (administrateur ; champs internes exclus)
//   POST /depot/company/contact {contact} → ajoute (sans id) ou modifie un contact ; /contact/delete {id} → le retire
//   POST /depot/manufacturer/propose {id, proposed, note} → corrections de la page d'un fabricant rattaché, appliquées
//                           après validation par Central.Parts (les opérateurs sont prévenus dans WeChat)
//   POST /depot/manufacturer/consent {id, on} → accord (ou retrait) sur la mention « distribué en Europe par
//                           Central.Parts » et le badge des offres (migration 20261106000035)
//
// Le scan est reçu par la fonction wechat-events (消息推送). Secrets de la fonction (jamais dans le dépôt) :
//   WECHAT_APPID, WECHAT_SECRET (compte de service), DEPOT_SECRET (64 caractères aléatoires).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { licensePath, pendingDocPath, pendingDocPrefix, randomScene, readSession, signSession, storagePath } from '../_shared/depot.js';
import { notifyOperators, requestAnswerNote, supplierCard, wechatPost } from '../_shared/wechat.ts';
import { closeRfq, deliverWebhooks } from '../_shared/rfq-dispatch.ts';
import { sourcingOfferOperatorText } from '../_shared/robot-texts.js';

// Devises proposées au dépôt (mêmes codes que public.currencies et l'inscription).
const CURRENCIES = ['USD', 'CNH', 'EUR', 'HKD'];

const ORIGINS = (Deno.env.get('DEPOT_ORIGINS') || 'https://central.parts').split(',');
const SECRET = Deno.env.get('DEPOT_SECRET') || '';
const SITE = 'https://central.parts/depot/';
// Erreurs de register_supplier (codes SQL) → codes affichés par la page.
const REGISTER_ERRORS: Record<string, string> = { CP001: 'code_invalid', CP002: 'company_exists', CP003: 'already_bound', CP004: 'fields', CP008: 'verification' };

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

    // Pièce déposée avant l'inscription : photo de la licence, ou lettre d'agrément d'un distributeur.
    if (req.method === 'POST' && path.endsWith('/doc-url')) {
      if (who) return json({ error: 'already_bound' }, 409);
      const b = await body();
      const key = pendingDocPath(await pendingDocPrefix(session.openid), String(b.kind || ''), b.file_name);
      if (!key) return json({ error: 'format', detail: 'JPG, PNG, HEIC, WEBP ou PDF' }, 422);
      const { data, error } = await db.storage.from('supplier-docs').createSignedUploadUrl(key);
      if (error) return json({ error: 'storage', detail: error.message }, 500);
      return json({ signed_url: data.signedUrl, path: key, max_bytes: 10485760 });
    }

    if (req.method === 'POST' && path.endsWith('/register')) {
      if (who) return json({ error: 'already_bound' }, 409);
      const b = await body();
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      // Devise obligatoire, sans valeur par défaut ; photo OU numéro (contrôlé aussi en base, CP008).
      if (!['USD', 'CNH', 'EUR', 'HKD'].includes(String(b.currency || '').toUpperCase())) return json({ error: 'fields', field: 'currency' }, 422);
      if (!str(b.code) && !str(b.license_path)) return json({ error: 'verification' }, 422);
      const contacts = Array.isArray(b.contacts) ? b.contacts.slice(0, 4) : [];
      if (!contacts.length || !str(contacts[0]?.family_name) && !str(contacts[0]?.given_name)) return json({ error: 'fields', field: 'contact' }, 422);
      const { data, error } = await db.rpc('register_supplier', {
        p_openid: session.openid, p_name: b.name, p_code: str(b.code), p_city: str(b.city), p_profile: b.profile,
        p_currency: String(b.currency).toUpperCase(), p_region: str(b.region), p_license_path: str(b.license_path),
        p_brands: str(b.brands), p_auth_path: str(b.auth_path), p_website: str(b.website), p_wecom: str(b.wecom), p_contacts: contacts,
      });
      if (error) {
        return json({ error: REGISTER_ERRORS[error.code] || 'database', field: error.details || null, detail: error.message },
          error.code in REGISTER_ERRORS ? 422 : 500);
      }
      // Fiche pour les opérateurs dans WeChat : profil, pièce fournie, marques déclarées.
      const { data: pending } = await db.rpc('pending_suppliers');
      const s = (pending || []).find((p: Record<string, unknown>) => p.org_id === data.org_id);
      if (s) await notifyOperators(db, await supplierCard(db, s)).catch(() => {});
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
      const { file_name, complete, currency } = await body();
      // Devise des prix quand le fichier ne l'indique pas : choisie à chaque dépôt (obligatoire), transmise à l'import
      // par le suffixe « -devise-USD » du nom, comme « -complet » (migration 20261102000017).
      const cur = String(currency || '').toUpperCase();
      if (!CURRENCIES.includes(cur)) return json({ error: 'currency', detail: CURRENCIES.join(', ') }, 422);
      const base = storagePath(org, file_name, { complete: !!complete });
      if (!base) return json({ error: 'format', detail: 'CSV, XLS ou XLSX' }, 422);
      const key = base.replace(/\.([A-Za-z0-9]+)$/, `-devise-${cur}.$1`);
      const { data, error } = await db.storage.from('stock-imports').createSignedUploadUrl(key);
      if (error) return json({ error: 'storage', detail: error.message }, 500);
      return json({ signed_url: data.signedUrl, path: key, max_bytes: 52428800 });
    }

    // Complétude des fiches produit de la société (fabricant reconnu, description, fiche technique, boîtier, cycle de
    // vie, ECCN, HTS ; ADR 0024) : la sienne seulement.
    if (req.method === 'GET' && path.endsWith('/quality')) {
      const { data, error } = await db.rpc('supplier_own_data_quality', { p_openid: session.openid });
      if (error) return json({ error: 'database', detail: error.message }, 500);
      return json(data || {});
    }

    // Validité des offres (ADR 0025) : en ligne, à reconfirmer, échéance ; reconfirmation sans nouveau fichier.
    if (req.method === 'GET' && path.endsWith('/offers-status')) {
      const { data, error } = await db.rpc('seller_offer_status', { p_org: org });
      if (error) return json({ error: 'database', detail: error.message }, 500);
      return json(data || {});
    }
    if (req.method === 'POST' && path.endsWith('/reconfirm')) {
      const { data, error } = await db.rpc('seller_reconfirm', { p_org: org, p_by: session.openid, p_channel: 'depot' });
      if (error) return json({ error: error.code === 'P0002' ? 'no_stock' : 'database', detail: error.message }, error.code === 'P0002' ? 422 : 500);
      return json(data);
    }

    if (req.method === 'GET' && path.endsWith('/imports')) {
      const { data, error } = await db.from('stock_imports')
        .select('id, file_name, status, rows_total, created, updated, rejected, duplicates, missing_date_code, withdrawn, error, report, received_at, processed_at, currency, currency_used')
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

    if (req.method === 'GET' && path.endsWith('/rfqs')) {
      const { data, error } = await db.rpc('supplier_rfqs', { p_openid: session.openid });
      if (error) return json({ error: 'database', detail: error.message }, 500);
      return json(data);
    }

    if (req.method === 'POST' && path.endsWith('/rfqs/answer')) {
      const b = await body();
      const kind = b.kind === 'decline' ? 'decline' : 'quote';
      const { data, error } = await db.rpc('supplier_rfq_answer', {
        p_openid: session.openid, p_ref: String(b.ref || ''), p_kind: kind, p_net: kind === 'quote' ? Number(b.price) || null : null,
        p_currency: b.currency ?? null, p_lead: Number.isInteger(b.lead_days) ? b.lead_days : null, p_date_code: b.date_code ?? null, p_lot: null,
      });
      if (error) {
        const code = error.code === 'CP410' ? 'expired' : error.code === 'CP409' ? (/quoted|declined/.test(error.details || '') ? 'answered' : 'closed')
          : error.code === '22023' ? 'invalid' : 'not_found';
        return json({ error: code, field: error.details || null }, code === 'not_found' ? 404 : 409);
      }
      const done = (async () => {
        const { data: card } = await db.rpc('rfq_for_operator', { p_id: data.ref });
        if (card && !card.sandbox) {
          const waiting = (card.sellers || []).filter((s: { response: string }) => s.response === 'pending').length;
          await notifyOperators(db, `[RFQ ${data.ref}] answered on /depot/: ${kind === 'quote' ? `quote ${b.price} ${b.currency}` : 'no stock'} · ${waiting} supplier(s) still pending`);
        }
        if (data.all_done) await closeRfq(db, data.ref);
        await deliverWebhooks(db);
      })().catch(() => {});
      const rt = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (rt) rt.waitUntil(done); else await done;
      return json(data);
    }

    // ---------------------------------------------------------------- compléter sa fiche (ADR 0034)
    if (req.method === 'POST' && path.endsWith('/signup')) {
      const b = await body();
      const keep = ['name', 'profile', 'code', 'region', 'city', 'brands', 'website', 'wecom'];
      const p = Object.fromEntries(Object.entries(b).filter(([k, v]) => keep.includes(k) && (typeof v === 'string' || v === null)));
      const { data, error } = await db.rpc('supplier_signup_save', { p_openid: session.openid, p });
      if (error) {
        const code = error.code === '42501' ? 'forbidden' : REGISTER_ERRORS[error.code] || 'database';
        return json({ error: code }, error.code === '42501' ? 403 : 422);
      }
      return json(data);
    }

    // ---------------------------------------------------------------- recherches payantes : brokers volontaires (ADR 0033)
    if (req.method === 'GET' && path.endsWith('/sourcing')) {
      const { data, error } = await db.rpc('supplier_sourcing', { p_openid: session.openid });
      if (error) return json({ error: 'database', detail: error.message }, 500);
      return json(data || {});
    }
    if (req.method === 'POST' && path.endsWith('/sourcing/join')) {
      const b = await body();
      const { data, error } = await db.rpc('supplier_sourcing_join', { p_openid: session.openid, p_on: b.on === true,
        p_labs: typeof b.labs === 'string' ? b.labs.slice(0, 1000) : null });
      if (error) return json({ error: error.code === '42501' ? 'not_eligible' : 'database' }, error.code === '42501' ? 403 : 500);
      if (b.on === true) {
        await notifyOperators(db, `[Sourcing] ${who?.name || org} volunteers for paid searches${typeof b.labs === 'string' && b.labs.trim() ? ` · labs: ${b.labs.trim().slice(0, 200)}` : ''}`).catch(() => {});
      }
      return json(data);
    }
    if (req.method === 'POST' && path.endsWith('/sourcing/answer')) {
      const b = await body();
      const kind = b.kind === 'decline' ? 'decline' : 'quote';
      const qty = Number.isInteger(b.qty) && b.qty > 0 ? b.qty : null;
      const { data, error } = await db.rpc('sourcing_answer', {
        p_openid: session.openid, p_ref: String(b.ref || ''), p_kind: kind, p_net: kind === 'quote' ? Number(b.price) || null : null,
        p_currency: b.currency ?? null, p_lead: Number.isInteger(b.lead_days) ? b.lead_days : null, p_date_code: b.date_code ?? null, p_qty: qty,
      });
      if (error) {
        const code = error.code === 'CP409' ? (error.details || 'closed') : error.code === '22023' ? 'invalid' : 'not_found';
        return json({ error: code, field: error.details || null }, code === 'not_found' ? 404 : 409);
      }
      await notifyOperators(db, sourcingOfferOperatorText(data, { kind, price: b.price, currency: b.currency, lead: b.lead_days, qty }, org)).catch(() => {});
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

    // ---------------------------------------------------------------- fiche société et fabricants (migration 20261106000035)
    if (path.endsWith('/company') || path.includes('/company/') || path.includes('/manufacturer/')) {
      // Erreurs SQL → codes lus par la page.
      const fail = (e: { code?: string; message?: string }) =>
        e.code === '42501' ? json({ error: 'forbidden' }, 403) : e.code === '22023' ? json({ error: 'invalid', detail: e.message }, 422)
          : e.code === 'P0002' ? json({ error: 'not_found' }, 404) : json({ error: 'server' }, 500);
      const run = async (fn: string, args: Record<string, unknown>) => {
        const { data, error } = await db.rpc(fn, { p_openid: session.openid, ...args });
        return error ? fail(error) : json(data);
      };
      if (req.method === 'GET' && path.endsWith('/company')) return run('supplier_company', {});
      const b = await body();
      if (req.method === 'POST' && path.endsWith('/company')) return run('supplier_company_save', { p: b.profile || {} });
      if (req.method === 'POST' && path.endsWith('/company/contact')) return run('supplier_contact_save', { p: b.contact || {} });
      if (req.method === 'POST' && path.endsWith('/company/contact/delete')) return run('supplier_contact_delete', { p_id: String(b.id || '') });
      if (req.method === 'POST' && path.endsWith('/manufacturer/consent')) {
        return run('supplier_manufacturer_consent', { p_mfr: String(b.id || ''), p_on: b.on === true });
      }
      if (req.method === 'POST' && path.endsWith('/manufacturer/propose')) {
        const res = await run('supplier_manufacturer_propose', { p_mfr: String(b.id || ''), p: b.proposed || {}, p_note: String(b.note || '').slice(0, 2000) });
        if (res.ok) await notifyOperators(db, `Corrections proposées pour ${String(b.id)} par ${who?.name || who?.org_id} : à valider dans le back office, onglet Fabricants.`).catch(() => {});
        return res;
      }
    }

    return json({ error: 'not_found' }, 404);
  } catch (err) {
    return json({ error: 'server', detail: err instanceof Error ? err.message : String(err) }, 500);
  }
});
