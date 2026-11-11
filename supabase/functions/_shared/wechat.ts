// Appels à l'API du compte de service WeChat, partagés par les fonctions depot et wechat-events.
// Secrets : WECHAT_APPID, WECHAT_SECRET.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { registrationLine } from './depot.js';
import { supplierRequestText } from './robot-texts.js';

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
// Fiche d'une société en attente, pour les opérateurs (anglais) : profil, pièce fournie (photo, numéro, les deux),
// marques déclarées et lettre d'agrément (ADR 0034). Liens signés valables 7 jours, jamais montrés aux acheteurs.
const PROFILE_EN: Record<string, string> = { Manufacturer: 'manufacturer', Distributor: 'distributor', Spot: 'spot stock (broker or surplus: to choose)',
  Reseller: 'reseller', Broker: 'broker' };
export async function supplierCard(db: SupabaseClient, s: Record<string, unknown>): Promise<string> {
  const link = async (path: unknown, label: string, missing: string) => {
    if (!path) return missing;
    const { data } = await db.storage.from('supplier-docs').createSignedUrl(String(path), 7 * 24 * 3600);
    return data?.signedUrl ? `${label}: ${data.signedUrl}` : missing;
  };
  const spot = s.profile === 'Spot';
  return [
    `[Pending review] ${s.org_id} · ${s.name}`,
    s.code ? registrationLine(s) : 'Registration no.: not given',
    [s.city || 'city not given', PROFILE_EN[String(s.profile)] || s.profile, s.lines ? `${s.lines} stock lines` : ''].filter(Boolean).join(' · '),
    ...(s.brands ? [`Declared brands: ${s.brands}`] : []),
    await link(s.license_path, 'Business licence', 'Business licence: not uploaded'),
    ...(s.auth_letter_path ? [await link(s.auth_letter_path, 'Authorisation letter', 'Authorisation letter: unavailable')] : []),
    spot ? `Reply "approve ${s.org_id} broker", "approve ${s.org_id} surplus" or "reject ${s.org_id} reason"`
      : `Reply "approve ${s.org_id}" or "reject ${s.org_id} reason"`,
  ].join('\n');
}

// Avis aux opérateurs quand un fournisseur répond à une demande d'achat.
export function requestAnswerNote(r: { ref: string; mpn: string; qty: number }, ok: boolean): string {
  return `[Purchase request ${r.ref}] Supplier ${ok ? 'confirmed availability' : 'has no stock'}: ${r.mpn} × ${r.qty}.` +
    (ok ? ` Send the proforma, then reply "proforma ${r.ref}".` : '');
}

// Demande d'achat validée par un administrateur (ADR 0026) : prévient tous les contacts WeChat actifs du fournisseur.
// v : supplier_view renvoyé par decide_purchase_request. Renvoie le nombre de contacts effectivement prévenus.
export async function notifySupplierOfRequest(db: SupabaseClient, sellerId: string, v: Record<string, unknown>): Promise<number> {
  const { data } = await db.from('wechat_identities').select('openid').eq('org_id', sellerId).is('revoked_at', null);
  const sent = await Promise.all((data || []).map((w: { openid: string }) => sendText(db, w.openid, supplierRequestText(v))));
  return sent.filter(Boolean).length;
}
