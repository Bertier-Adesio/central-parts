// Fonction Edge « wechat-events » : reçoit les événements du compte de service WeChat (消息推送, mode clair).
// Adresse à déclarer dans la console WeChat : https://<projet>.supabase.co/functions/v1/wechat-events
// Déployée sans vérification de jeton Supabase (--no-verify-jwt) : chaque appel est authentifié par la signature WeChat.
//
//   GET  : vérification de l'adresse par WeChat (renvoie echostr si la signature est bonne)
//   POST : événement ou message.
//     - scan du QR code de connexion au dépôt (scène dl_…) : rattache l'openid à la tentative et répond dans WeChat ;
//     - abonnement, scan d'un autre QR code du compte (stand, supports imprimés) ou message d'un fournisseur :
//       message d'accueil avec un lien de connexion personnel (15 minutes) vers la page de dépôt et d'inscription.
//       Le message automatique de la console WeChat ne s'applique plus une fois le 消息推送 activé ;
//     - bouton « 供应商 › 上传库存 » du menu (clic, clé DEPOT_LOGIN) : lien de connexion personnel (15 minutes),
//       pour tous, inscrits ou non : seul moyen simple de se connecter sur téléphone ;
//     - boutons du menu anglais des opérateurs (clés OP_PENDING, OP_REQUESTS, OP_HELP) : comme pending, requests et help ;
//     - message d'un opérateur (table operators) : commandes 待审核, 通过 ORG-…, 拒绝 ORG-… motif, 链接 (lien de
//       connexion pour tester la page) (ADR 0012) et suite
//       des demandes d'achat : 询单, 确认, 无货, 发票, 收款, 发货, 取消 PR-… (ADR 0014) ;
//     - commandes RFQ des plateformes (ADR 0023), opérateurs seulement : rfq, rfq DEM-…, rfq stats ORG-…,
//       approve DEM-… [only ORG-…], reject DEM-… motif, resend DEM-… [ORG-…] ;
//     - message d'un fournisseur : 确认 PR-… ou 无货 PR-… pour répondre à une demande d'achat ; 报价 DEM-… prix devise
//       délai date code [lot LOT-…] ou 无货 DEM-… pour répondre à une RFQ (refusé après l'échéance de 48 h) ;
//     - tout autre message d'un contact (texte, image, voix) : gardé en base et transféré aux opérateurs, qui
//       répondent par « reply <n°> texte » ; accusé de réception au contact rattaché, accueil sinon.
//
// Secrets de la fonction : WECHAT_TOKEN (le « Token » saisi dans la console WeChat), WECHAT_APPID et WECHAT_SECRET
// pour prévenir les fournisseurs de la décision.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { depotLinkText, isDepotMenuClick, operatorMenuCommand, parseWechatXml, replyText, sceneOf, wechatSignatureOk } from '../_shared/depot.js';
import {
  approvedNotice, linkErrorText, OPEN_REQUEST_STATUSES, operatorErrorText, operatorHelpText, operatorReplyText, operatorRequestsText,
  phoneBackLine, receivedText, rejectedNotice, scanReply, STATUS_EN, welcomeText,
} from '../_shared/robot-texts.js';
import { notifyOperators, requestAnswerNote, sendText, supplierCard } from '../_shared/wechat.ts';
import {
  rfqAnswerErrorText, rfqDeclineOkText, rfqDispatchText, rfqHelpText, rfqOperatorCard, rfqOperatorListText,
  rfqQuoteOkText, rfqStatsText,
} from '../_shared/robot-texts.js';
import { parseOperatorRfq, parseSupplierRfq } from '../_shared/rfq.js';
import { closeRfq, deliverWebhooks, dispatchRfq } from '../_shared/rfq-dispatch.ts';

// Textes du robot : _shared/robot-texts.js. Opérateur : anglais seul ; fournisseur ou inconnu : chinois et anglais.
const SITE = 'https://central.parts/depot/';

// Opérateur = openid présent dans la table operators : même identification que pour les commandes.
async function isOperator(db: SupabaseClient, openid: string): Promise<boolean> {
  const { data } = await db.from('operators').select('openid').eq('openid', openid).maybeSingle();
  return !!data;
}

// WeChat attend la réponse en 5 secondes au plus : les messages envoyés en plus partent après la réponse.
const later = (p: Promise<unknown>) => {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt) rt.waitUntil(p.catch(() => {})); else p.catch(() => {});
};

// Commandes RFQ de l'administrateur (ADR 0023), en anglais : rfq, rfq DEM-…, rfq stats ORG-…, approve DEM-… [only ORG-…],
// reject DEM-… motif, resend DEM-… [ORG-…]. Même contrôle que approve ORG-… : l'appelant est dans la table operators.
async function operatorRfqCommand(db: SupabaseClient, openid: string, text: string): Promise<string | null> {
  const c = parseOperatorRfq(text);
  if (!c) return null;
  const ref = String((c as { ref?: string }).ref || '');
  if (c.cmd === 'list') {
    const { data, error } = await db.rpc('list_pending_rfq');
    return error ? `RFQ: ${error.message}` : rfqOperatorListText((data || []) as Record<string, unknown>[] as never);
  }
  if (c.cmd === 'stats') {
    const { data, error } = await db.rpc('supplier_score', { p_org: c.org });
    return error ? `${c.org}: ${error.message}` : rfqStatsText(data);
  }
  if (c.cmd === 'show') {
    const { data, error } = await db.rpc('rfq_for_operator', { p_id: c.ref });
    return error || !data ? `${c.ref}: not found` : rfqOperatorCard(data);
  }
  if (c.cmd === 'approve') {
    const { data, error } = await db.rpc('approve_rfq', { p_id: c.ref, p_by: openid, p_only: c.only });
    if (error) return operatorErrorText(c.ref, error.message);
    if (data.status === 'no_offer') { later(deliverWebhooks(db)); return `Approved ${c.ref}: no matching supplier, closed as "no offer".`; }
    // Envoi après la réponse (WeChat attend 5 secondes au plus) ; le résumé arrive en message séparé.
    later((async () => { await sendText(db, openid, rfqDispatchText(ref, await dispatchRfq(db, ref))); await deliverWebhooks(db); })());
    return `Approved ${c.ref}: notifying ${(data.sellers || []).length} supplier(s)…`;
  }
  if (c.cmd === 'reject') {
    if (!c.reason) return `A reason is required: reject ${c.ref} reason`;
    const { error } = await db.rpc('reject_rfq', { p_id: c.ref, p_reason: c.reason, p_by: openid });
    if (error) return operatorErrorText(c.ref, error.message);
    later(deliverWebhooks(db));
    return `Rejected ${c.ref}. The platform is told the reason; no supplier was contacted.`;
  }
  // resend
  if (c.org) {
    const { error } = await db.rpc('resend_rfq', { p_id: c.ref, p_seller: c.org, p_by: openid });
    if (error) return operatorErrorText(c.ref + ' ' + c.org, error.message);
  }
  const org = c.org || null;
  later((async () => sendText(db, openid, rfqDispatchText(ref, await dispatchRfq(db, ref, org))))());
  return `Resending ${c.ref}${c.org ? ' to ' + c.org : ''}…`;
}

// Commandes des opérateurs. Renvoie la réponse immédiate ; les fiches et les avis aux fournisseurs partent en messages.
async function operatorCommand(db: SupabaseClient, openid: string, text: string): Promise<string> {
  const t = text.trim();
  const rfq = await operatorRfqCommand(db, openid, t);
  if (rfq !== null) return rfq;
  let m = /^(通过|ok|approve)\s+(ORG-\d+)\s*$/i.exec(t);
  if (m) {
    const org = m[2].toUpperCase();
    const { data: alias, error } = await db.rpc('approve_supplier', { p_org: org, p_by: openid });
    if (error) return operatorErrorText(org, error.message);
    later(tellAdmins(db, org, approvedNotice(alias)));
    return `Approved ${org} → ${alias}`;
  }
  m = /^(拒绝|reject)\s+(ORG-\d+)\s*(.*)$/is.exec(t);
  if (m) {
    const org = m[2].toUpperCase(), reason = m[3].trim();
    const { error } = await db.rpc('reject_supplier', { p_org: org, p_reason: reason, p_by: openid });
    if (error) return operatorErrorText(org, error.message);
    later(tellAdmins(db, org, rejectedNotice(reason)));
    return `Rejected ${org}`;
  }
  m = /^(确认|无货|发票|收款|发货|取消|询单|confirm|unavailable|proforma|paid|shipped|cancel|request)\s*(PR-\d+)\s*$/i.exec(t);
  if (m) {
    const ref = m[2].toUpperCase();
    const status = ({ 确认: 'confirmed', 无货: 'unavailable', 发票: 'proforma_sent', 收款: 'paid', 发货: 'shipped', 取消: 'cancelled',
      confirm: 'confirmed', unavailable: 'unavailable', proforma: 'proforma_sent', paid: 'paid', shipped: 'shipped', cancel: 'cancelled' } as Record<string, string>)[m[1].toLowerCase()];
    const { data, error } = status
      ? await db.rpc('operator_set_request_status', { p_ref: ref, p_status: status, p_by: openid })
      : await db.rpc('request_for_operator', { p_ref: ref });
    if (error || !data) return `${ref}: ${error?.message || 'not found'}`;
    return `${data.ref} · ${(STATUS_EN as Record<string, string>)[data.status] || data.status}\n${data.mpn} × ${data.qty} · ${data.unit_price ?? 'price to confirm'} ${data.currency}\n${data.buyer_company} · ${data.buyer_email}`;
  }
  // Réponse à un message transféré : « reply 123 texte ».
  m = /^(回复|reply)\s+#?(\d+)\s+([\s\S]+)$/i.exec(t);
  if (m) {
    const { data: to, error } = await db.rpc('reply_wechat_message', { p_id: Number(m[2]), p_content: m[3], p_by: openid });
    if (error || !to) return `Message #${m[2]}: ${error?.message || 'not found'}`;
    const sent = await sendText(db, to, operatorReplyText(m[3].trim()));
    return sent ? `Sent to #${m[2]}.` : `Not delivered: WeChat only delivers to people who wrote to the account in the last 48 hours.`;
  }
  // Lien de connexion personnel, pour tester la page comme un fournisseur (les opérateurs ne reçoivent pas l'accueil).
  if (/^(链接|link)$/i.test(t)) {
    const { data: scene, error } = await db.rpc('depot_login_link', { p_openid: openid });
    return error ? `Login link failed: ${error.message}` : `Login link (valid 15 minutes): ${SITE}?login=${scene}`;
  }
  // Demandes d'achat en cours, les plus récentes d'abord (bouton Review › Purchase requests).
  if (/^requests$/i.test(t)) {
    const { data, count, error } = await db.from('purchase_requests')
      .select('id, status, mpn, qty, buyer_company, created_at', { count: 'exact' })
      .in('status', OPEN_REQUEST_STATUSES).order('created_at', { ascending: false }).limit(10);
    return error ? `Purchase requests: ${error.message}` : operatorRequestsText(data || [], count ?? (data || []).length);
  }
  if (/^(待审核|pending)$/i.test(t)) {
    const { data } = await db.rpc('pending_suppliers');
    const list = (data || []) as Record<string, unknown>[];
    later((async () => { for (const s of list.slice(0, 10)) await sendText(db, openid, await supplierCard(db, s)); })());
    return list.length ? `Pending: ${list.length} compan${list.length > 1 ? 'ies' : 'y'}${list.length > 10 ? ' (first 10 shown)' : ''}` : 'No company pending.';
  }
  return operatorHelpText();
}

// Réponse d'un fournisseur à une RFQ de plateforme (ADR 0023) : 报价 DEM-… prix devise délai date code, ou 无货 DEM-….
// La base contrôle le contact (wechat_identities), l'échéance de 48 h, la réponse unique et la devise.
async function supplierRfqCommand(db: SupabaseClient, openid: string, text: string): Promise<string | null> {
  const q = parseSupplierRfq(text);
  if (!q) return null;
  if (q.kind === 'help') return rfqHelpText(q.ref);
  const { data, error } = await db.rpc('supplier_rfq_answer', q.kind === 'quote'
    ? { p_openid: openid, p_ref: q.ref, p_kind: 'quote', p_net: q.price, p_currency: q.currency, p_lead: q.lead, p_date_code: q.dateCode, p_lot: q.lot }
    : { p_openid: openid, p_ref: q.ref, p_kind: 'decline' });
  if (error) return rfqAnswerErrorText(q.ref, error.code || '', error.details || '');
  later((async () => {
    const { data: card } = await db.rpc('rfq_for_operator', { p_id: q.ref });
    const { data: me } = await db.from('wechat_identities').select('org_id').eq('openid', openid).maybeSingle();
    if (card && !card.sandbox) {
      const waiting = (card.sellers || []).filter((s: { response: string }) => s.response === 'pending').length;
      await notifyOperators(db, `[RFQ ${q.ref}] ${me?.org_id || '?'}: ${q.kind === 'quote' ? `quote ${q.price} ${q.currency}, ${q.lead} d` : 'no stock'}` +
        ` · ${waiting} supplier(s) still pending`);
    }
    if (data.all_done) await closeRfq(db, q.ref);
    await deliverWebhooks(db);
  })());
  return q.kind === 'quote' ? rfqQuoteOkText(data, q) : rfqDeclineOkText(data.ref);
}

// Réponse d'un fournisseur à une demande d'achat : 确认 PR-… (disponible) ou 无货 PR-… (indisponible).
async function supplierCommand(db: SupabaseClient, openid: string, text: string): Promise<string | null> {
  const rfq = await supplierRfqCommand(db, openid, text);
  if (rfq !== null) return rfq;
  const m = /^(确认|无货|confirm|unavailable)\s*(PR-\d+)\s*$/i.exec(text.trim());
  if (!m) return null;
  const ok = m[1] === '确认' || m[1].toLowerCase() === 'confirm';
  const { data, error } = await db.rpc('supplier_answer', { p_openid: openid, p_ref: m[2], p_ok: ok });
  if (error) return `未找到询单 ${m[2].toUpperCase()}。`;
  later(notifyOperators(db, requestAnswerNote(data, ok)));
  return ok ? `已确认询单 ${data.ref}，Central.Parts 将通知买方并安排后续。` : `已记录：询单 ${data.ref} 无货。`;
}

async function tellAdmins(db: SupabaseClient, org: string, text: string) {
  const { data } = await db.rpc('org_admins', { p_org: org });
  await Promise.all(((data || []) as string[]).map((o) => sendText(db, o, text)));
}

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  const ok = await wechatSignatureOk(Deno.env.get('WECHAT_TOKEN') || '', q.get('timestamp'), q.get('nonce'), q.get('signature'));
  if (!ok) return new Response('forbidden', { status: 403 });
  if (req.method === 'GET') return new Response(q.get('echostr') || '', { headers: { 'Content-Type': 'text/plain' } });
  if (req.method !== 'POST') return new Response('success');

  const msg = parseWechatXml(await req.text());
  const scene = sceneOf(msg);
  const reply = (text: string) =>
    new Response(replyText(msg.FromUserName, msg.ToUserName, text), { headers: { 'Content-Type': 'application/xml' } });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  if (scene && scene.startsWith('dl_')) {
    const { data, error } = await db.rpc('depot_login_scan', { p_scene: scene, p_openid: msg.FromUserName, p_unionid: null });
    const op = await isOperator(db, msg.FromUserName);
    let text = error ? null : scanReply(data?.status, op);
    // Sur téléphone, reconnaître le QR code de la page ouvre cette conversation et ferme souvent la page :
    // un lien personnel (15 minutes) y ramène, déjà connecté. Sur ordinateur, la page se connecte seule.
    if (text && (data.status === 'ok' || data.status === 'not_bound')) {
      const { data: link } = await db.rpc('depot_login_link', { p_openid: msg.FromUserName });
      if (link) text += phoneBackLine(`${SITE}?login=${link}`, op);
    }
    return text ? reply(text) : new Response('success');
  }

  // Boutons du menu anglais des opérateurs (Pending companies, Commands) : même effet que la commande texte.
  // Ignorés pour quelqu'un qui n'est pas opérateur (il ne voit pas ce menu).
  const menuCmd = operatorMenuCommand(msg);
  if (menuCmd) {
    if (!(await isOperator(db, msg.FromUserName))) return new Response('success');
    return reply(await operatorCommand(db, msg.FromUserName, menuCmd));
  }

  // Bouton « 上传库存 » du menu : lien personnel vers la page de dépôt, déjà connecté (inscription si pas de société).
  if (isDepotMenuClick(msg)) {
    const op = await isOperator(db, msg.FromUserName);
    const { data: link, error } = await db.rpc('depot_login_link', { p_openid: msg.FromUserName });
    return reply(error ? linkErrorText(op) : depotLinkText(`${SITE}?login=${link}`, op));
  }

  if (msg.MsgType === 'text') {
    if (await isOperator(db, msg.FromUserName)) return reply(await operatorCommand(db, msg.FromUserName, msg.Content || ''));
    const answer = await supplierCommand(db, msg.FromUserName, msg.Content || '');
    if (answer) return reply(answer);
  }

  // Message d'un contact (texte, image, voix) : gardé en base et transféré aux opérateurs, qui répondent par « reply ».
  if (['text', 'image', 'voice'].includes(msg.MsgType)) {
    const content = msg.MsgType === 'text' ? msg.Content || '' : msg.MsgType === 'image' ? msg.PicUrl || '' : '(voice message)';
    const { data: logged } = await db.rpc('log_wechat_message', { p_openid: msg.FromUserName, p_kind: msg.MsgType, p_content: content });
    if (logged) {
      const who = logged.org_id ? `${logged.org_id} · ${logged.name}` : 'not registered';
      later(notifyOperators(db, `[Message #${logged.id}] ${who}\n${msg.MsgType === 'text' ? content : msg.MsgType + ': ' + content}\n\nReply: reply ${logged.id} your text`));
    }
    // Contact déjà rattaché : simple accusé de réception ; sinon, le message d'accueil avec le lien d'inscription.
    if (logged?.org_id) return reply(receivedText(await isOperator(db, msg.FromUserName)));
  }

  const greet = msg.MsgType === 'text' || msg.MsgType === 'image' || msg.MsgType === 'voice' ||
    (msg.MsgType === 'event' && (msg.Event === 'subscribe' || (msg.Event === 'SCAN' && scene)));
  if (!greet) return new Response('success');
  const op = await isOperator(db, msg.FromUserName);
  const { data: link, error } = await db.rpc('depot_login_link', { p_openid: msg.FromUserName });
  return reply(welcomeText(error ? '' : link, op));
});
