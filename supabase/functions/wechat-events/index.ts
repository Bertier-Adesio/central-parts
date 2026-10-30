// Fonction Edge « wechat-events » : reçoit les événements du compte de service WeChat (消息推送, mode clair).
// Adresse à déclarer dans la console WeChat : https://<projet>.supabase.co/functions/v1/wechat-events
// Déployée sans vérification de jeton Supabase (--no-verify-jwt) : chaque appel est authentifié par la signature WeChat.
//
//   GET  : vérification de l'adresse par WeChat (renvoie echostr si la signature est bonne)
//   POST : événement. Un scan du QR code de connexion au dépôt (SCAN, ou subscribe avec la scène) rattache
//          l'openid à la tentative de connexion et répond au fournisseur dans WeChat ; tout le reste est ignoré.
//
// Secret de la fonction : WECHAT_TOKEN, le « Token » saisi dans la console WeChat.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { parseWechatXml, replyText, sceneOf, wechatSignatureOk } from '../_shared/depot.js';

const REPLIES: Record<string, string> = {
  ok: '已登录 Central.Parts 库存上传，请返回上传页面。\nLogged in to Central.Parts stock upload: go back to the upload page.',
  not_bound: '此微信账号尚未绑定供应商账户，请使用 Central.Parts 发给您的邀请链接。\nThis WeChat account is not linked yet: please use the invitation link sent by Central.Parts.',
  invite_invalid: '邀请链接无效、已过期或已被其他账号使用，请联系 Central.Parts。\nThe invitation link is invalid, expired or already used: please contact Central.Parts.',
  expired: '二维码已过期，请在上传页面刷新二维码。\nThis QR code has expired: refresh it on the upload page.',
};

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  const ok = await wechatSignatureOk(Deno.env.get('WECHAT_TOKEN') || '', q.get('timestamp'), q.get('nonce'), q.get('signature'));
  if (!ok) return new Response('forbidden', { status: 403 });
  if (req.method === 'GET') return new Response(q.get('echostr') || '', { headers: { 'Content-Type': 'text/plain' } });
  if (req.method !== 'POST') return new Response('success');

  const msg = parseWechatXml(await req.text());
  const scene = sceneOf(msg);
  if (!scene || !scene.startsWith('dl_')) return new Response('success');

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data, error } = await db.rpc('depot_login_scan', { p_scene: scene, p_openid: msg.FromUserName, p_unionid: null });
  const text = error ? null : REPLIES[data?.status];
  if (!text) return new Response('success');
  return new Response(replyText(msg.FromUserName, msg.ToUserName, text), { headers: { 'Content-Type': 'application/xml' } });
});
