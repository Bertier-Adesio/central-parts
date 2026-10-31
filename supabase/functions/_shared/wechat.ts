// Appels à l'API du compte de service WeChat, partagés par les fonctions depot et wechat-events.
// Secrets : WECHAT_APPID, WECHAT_SECRET.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

// Jeton d'accès partagé (stable_token), gardé en base jusqu'à cinq minutes avant son échéance.
export async function accessToken(db: SupabaseClient, force = false): Promise<string> {
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

// Appel POST à l'API ; un jeton périmé est renouvelé une fois.
export async function wechatPost(db: SupabaseClient, path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  for (const force of [false, true]) {
    const token = await accessToken(db, force);
    const r = await (await fetch('https://api.weixin.qq.com' + path + '?access_token=' + token, { method: 'POST', body })).json();
    if (r.errcode === undefined || ![40001, 40014, 42001].includes(r.errcode)) return r;
  }
  return { errcode: 40001, errmsg: 'access_token' };
}

// Message texte à un abonné (客服消息). WeChat ne le délivre qu'à quelqu'un qui a écrit au compte, scanné ou
// touché le menu dans les 48 dernières heures : l'envoi est tenté, un échec n'interrompt rien.
export async function sendText(db: SupabaseClient, openid: string, content: string): Promise<boolean> {
  try {
    const r = await wechatPost(db, '/cgi-bin/message/custom/send', { touser: openid, msgtype: 'text', text: { content } });
    return r.errcode === 0;
  } catch {
    return false;
  }
}

// Prévient tous les opérateurs (table operators).
export async function notifyOperators(db: SupabaseClient, content: string) {
  const { data } = await db.from('operators').select('openid');
  await Promise.all((data || []).map((o: { openid: string }) => sendText(db, o.openid, content)));
}

// Fiche d'une société en attente, pour les opérateurs (en anglais) : lien vers la licence valable 7 jours.
export async function supplierCard(db: SupabaseClient, s: Record<string, unknown>): Promise<string> {
  let license = 'Business licence: not uploaded';
  if (s.license_path) {
    const { data } = await db.storage.from('supplier-docs').createSignedUrl(String(s.license_path), 7 * 24 * 3600);
    if (data?.signedUrl) license = 'Business licence: ' + data.signedUrl;
  }
  return [
    `[Pending review] ${s.org_id} · ${s.name}`,
    `Credit code: ${s.code}`,
    `${s.city} · ${s.profile}${s.lines ? ` · ${s.lines} stock lines` : ''}`,
    license,
    `Reply "approve ${s.org_id}" or "reject ${s.org_id} reason"`,
  ].join('\n');
}

// Avis aux opérateurs quand un fournisseur répond à une demande d'achat.
export function requestAnswerNote(r: { ref: string; mpn: string; qty: number }, ok: boolean): string {
  return `[Purchase request ${r.ref}] Supplier ${ok ? 'confirmed availability' : 'has no stock'}: ${r.mpn} × ${r.qty}.` +
    (ok ? ` Send the proforma, then reply "proforma ${r.ref}".` : '');
}
