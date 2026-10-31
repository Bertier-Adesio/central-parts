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
//     - message d'un opérateur (table operators) : commandes 待审核, 通过 ORG-…, 拒绝 ORG-… motif, 链接 (lien de
//       connexion pour tester la page) (ADR 0012) et suite
//       des demandes d'achat : 询单, 确认, 无货, 发票, 收款, 发货, 取消 PR-… (ADR 0014) ;
//     - message d'un fournisseur : 确认 PR-… ou 无货 PR-… pour répondre à une demande d'achat.
//
// Secrets de la fonction : WECHAT_TOKEN (le « Token » saisi dans la console WeChat), WECHAT_APPID et WECHAT_SECRET
// pour prévenir les fournisseurs de la décision.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { parseWechatXml, replyText, sceneOf, wechatSignatureOk } from '../_shared/depot.js';
import { notifyOperators, requestAnswerNote, sendText, supplierCard } from '../_shared/wechat.ts';

const REPLIES: Record<string, string> = {
  ok: '已登录 Central.Parts 库存上传，请返回上传页面。\nLogged in to Central.Parts stock upload: go back to the upload page.',
  not_bound: '已登录。请返回网页，注册您的公司。\nLogged in: go back to the web page to register your company.',
  invite_invalid: '邀请链接无效、已过期或已被其他账号使用，请联系 Central.Parts。\nThe invitation link is invalid, expired or already used: please contact Central.Parts.',
  expired: '二维码已过期，请在上传页面刷新二维码。\nThis QR code has expired: refresh it on the upload page.',
};

const SITE = 'https://central.parts/depot/';

// Message d'accueil (texte, liens cliquables dans WeChat ; 2 048 octets au plus).
const welcome = (scene: string) => [
  '感谢关注 Central.Parts！',
  '我们为中国原厂、分销商和贸易商拓展欧洲客户：欧洲 EMS、OEM 和设计公司直接查询您的现货。',
  '',
  `1. 注册公司、上传库存（15 分钟内有效，过期请发送任意消息获取新链接）：${SITE}?login=${scene}`,
  '2. 库存表模板：https://central.parts/depot/stock-template.csv',
  '3. 了解我们：https://central.parts/zh/',
  '',
  'electronica 2026 · 慕尼黑 · 11月10–13日 · B4 馆 251/12 展位，欢迎来访。',
  '',
  'Thank you for following Central.Parts. Link 1 registers your company and uploads your stock (valid 15 minutes). Meet us at electronica 2026, Hall B4, Booth 251/12.',
].join('\n');

// WeChat attend la réponse en 5 secondes au plus : les messages envoyés en plus partent après la réponse.
const later = (p: Promise<unknown>) => {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt) rt.waitUntil(p.catch(() => {})); else p.catch(() => {});
};

// Commandes des opérateurs. Renvoie la réponse immédiate ; les fiches et les avis aux fournisseurs partent en messages.
async function operatorCommand(db: SupabaseClient, openid: string, text: string): Promise<string> {
  const t = text.trim();
  let m = /^(通过|ok|approve)\s+(ORG-\d+)\s*$/i.exec(t);
  if (m) {
    const org = m[2].toUpperCase();
    const { data: alias, error } = await db.rpc('approve_supplier', { p_org: org, p_by: openid });
    if (error) return `${org}：${error.message}`;
    later(tellAdmins(db, org, `您的公司已通过 Central.Parts 审核（编号 ${alias}），库存已纳入 Central.Parts 平台。\nYour company has been approved by Central.Parts (${alias}).`));
    return `Approved ${org} → ${alias}`;
  }
  m = /^(拒绝|reject)\s+(ORG-\d+)\s*(.*)$/is.exec(t);
  if (m) {
    const org = m[2].toUpperCase(), reason = m[3].trim();
    const { error } = await db.rpc('reject_supplier', { p_org: org, p_reason: reason, p_by: openid });
    if (error) return `${org}：${error.message}`;
    later(tellAdmins(db, org, `您的公司未通过 Central.Parts 审核${reason ? '：' + reason : '。'}\n如有疑问，请直接回复此消息。`));
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
    return `${data.ref} · ${STATUS_EN[data.status] || data.status}\n${data.mpn} × ${data.qty} · ${data.unit_price ?? 'price to confirm'} ${data.currency}\n${data.buyer_company} · ${data.buyer_email}`;
  }
  // Lien de connexion personnel, pour tester la page comme un fournisseur (les opérateurs ne reçoivent pas l'accueil).
  if (/^(链接|link)$/i.test(t)) {
    const { data: scene, error } = await db.rpc('depot_login_link', { p_openid: openid });
    return error ? `Login link failed: ${error.message}` : `Login link (valid 15 minutes): ${SITE}?login=${scene}`;
  }
  if (/^(待审核|pending)$/i.test(t)) {
    const { data } = await db.rpc('pending_suppliers');
    const list = (data || []) as Record<string, unknown>[];
    later((async () => { for (const s of list.slice(0, 10)) await sendText(db, openid, await supplierCard(db, s)); })());
    return list.length ? `Pending: ${list.length} compan${list.length > 1 ? 'ies' : 'y'}${list.length > 10 ? ' (first 10 shown)' : ''}` : 'No company pending.';
  }
  return [
    '命令 · Commands:',
    '待审核 · pending',
    '通过 ORG-0123 · approve ORG-0123',
    '拒绝 ORG-0123 原因 · reject ORG-0123 reason',
    '链接 · link',
    '',
    '询单 · Purchase requests (PR-0001):',
    '询单 · request',
    '确认 · confirm',
    '无货 · unavailable',
    '发票 · proforma',
    '收款 · paid',
    '发货 · shipped',
    '取消 · cancel',
  ].join('\n');
}

// Messages aux opérateurs en anglais ; messages aux fournisseurs en chinois, avec une ligne en anglais.
const STATUS_EN: Record<string, string> = { submitted: 'awaiting supplier', confirmed: 'confirmed by supplier', unavailable: 'unavailable',
  proforma_sent: 'proforma sent', paid: 'paid', shipped: 'shipped', cancelled: 'cancelled' };

// Réponse d'un fournisseur à une demande d'achat : 确认 PR-… (disponible) ou 无货 PR-… (indisponible).
async function supplierCommand(db: SupabaseClient, openid: string, text: string): Promise<string | null> {
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
    let text = error ? null : REPLIES[data?.status];
    // Sur téléphone, reconnaître le QR code de la page ouvre cette conversation et ferme souvent la page :
    // un lien personnel (15 minutes) y ramène, déjà connecté. Sur ordinateur, la page se connecte seule.
    if (text && (data.status === 'ok' || data.status === 'not_bound')) {
      const { data: link } = await db.rpc('depot_login_link', { p_openid: msg.FromUserName });
      if (link) text += `\n\n手机上请点此返回 · On a phone, tap to go back:\n${SITE}?login=${link}`;
    }
    return text ? reply(text) : new Response('success');
  }

  if (msg.MsgType === 'text') {
    const { data: op } = await db.from('operators').select('openid').eq('openid', msg.FromUserName).maybeSingle();
    if (op) return reply(await operatorCommand(db, msg.FromUserName, msg.Content || ''));
    const answer = await supplierCommand(db, msg.FromUserName, msg.Content || '');
    if (answer) return reply(answer);
  }

  const greet = msg.MsgType === 'text' || (msg.MsgType === 'event' && (msg.Event === 'subscribe' || (msg.Event === 'SCAN' && scene)));
  if (!greet) return new Response('success');
  const { data: link, error } = await db.rpc('depot_login_link', { p_openid: msg.FromUserName });
  return reply(error ? welcome('').replace(/\?login=\S*/, '') : welcome(link));
});
