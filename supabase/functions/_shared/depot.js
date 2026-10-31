// Outils partagés des fonctions « depot » et « wechat-events », sans dépendance (Deno et Node 22 : WebCrypto) ;
// testés par tools/test-import.mjs.

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

// Jeton de session du dépôt : société, openid et échéance, signés HMAC. Durée par défaut : 12 heures.
export async function signSession(secret, { org, openid }, ttlSeconds = 12 * 3600, now = Date.now()) {
  if (!secret || secret.length < 32) throw new Error('DEPOT_SECRET absent ou trop court');
  const body = b64url(enc.encode(JSON.stringify({ org, openid, exp: Math.floor(now / 1000) + ttlSeconds })));
  return body + '.' + b64url(await hmac(secret, body));
}

// Renvoie { org, openid } si le jeton est intact et valide, sinon null. org est null pour un compte qui s'inscrit.
export async function readSession(secret, token, now = Date.now()) {
  if (!secret || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const want = b64url(await hmac(secret, body));
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64url(body)));
    return p.exp > Math.floor(now / 1000) && p.openid ? { org: p.org || null, openid: p.openid } : null;
  } catch {
    return null;
  }
}

// Chemin du fichier dans le compartiment : <société>/<horodatage>-<nom ASCII>[-complet].<ext>
// Le nom d'origine peut être en chinois : on garde les caractères sûrs pour le stockage, l'extension, et on horodate.
export function storagePath(org, fileName, { complete = false, now = new Date() } = {}) {
  const m = /\.(csv|xls|xlsx)$/i.exec(String(fileName || ''));
  if (!m) return null;
  const ext = m[1].toLowerCase();
  let base = String(fileName).slice(0, -m[0].length).normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'stock';
  if (!complete) base = base.replace(/complet|full/gi, 'stock'); // seul le choix explicite remplace tout le stock
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261030-142501
  return `${org}/${stamp}-${base}${complete ? '-complet' : ''}.${ext}`;
}

// ---------------------------------------------------------------- connexion par QR code WeChat (扫码登录)

// Scène aléatoire portée par le QR code temporaire (32 caractères hexadécimaux, préfixe « dl_ »).
export function randomScene() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return 'dl_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// Signature des appels de WeChat vers notre serveur : sha1 des trois valeurs triées (token, timestamp, nonce).
export async function wechatSignatureOk(token, timestamp, nonce, signature) {
  if (!token || !timestamp || !nonce || !signature) return false;
  const s = [token, timestamp, nonce].sort().join('');
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', enc.encode(s)));
  const hex = Array.from(h, (x) => x.toString(16).padStart(2, '0')).join('');
  if (hex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// Message XML de WeChat (mode clair) → champs simples, par exemple { MsgType, Event, EventKey, FromUserName }.
/** @param {string} xml @returns {Record<string, string>} */
export function parseWechatXml(xml) {
  const out = {};
  for (const m of String(xml || '').matchAll(/<(\w+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

// Scène d'un événement de scan : SCAN (déjà abonné) ou subscribe (abonnement en scannant), sinon null.
export function sceneOf(msg) {
  if (msg.MsgType !== 'event') return null;
  if (msg.Event === 'SCAN') return msg.EventKey || null;
  if (msg.Event === 'subscribe' && msg.EventKey && msg.EventKey.startsWith('qrscene_')) return msg.EventKey.slice(8);
  return null;
}

// Réponse texte immédiate dans la conversation WeChat du fournisseur.
export function replyText(toUser, fromUser, content, now = Date.now()) {
  const cdata = (s) => '<![CDATA[' + String(s).replace(/\]\]>/g, ']]]]><![CDATA[>') + ']]>';
  return '<xml><ToUserName>' + cdata(toUser) + '</ToUserName><FromUserName>' + cdata(fromUser) + '</FromUserName>' +
    '<CreateTime>' + Math.floor(now / 1000) + '</CreateTime><MsgType>' + cdata('text') + '</MsgType><Content>' + cdata(content) + '</Content></xml>';
}

// 统一社会信用代码 (GB 32100-2015) : 18 caractères, clé de contrôle modulo 31. Même règle que app.credit_code_ok.
const CREDIT_CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const CREDIT_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
export function creditCodeOk(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(c)) return false;
  let t = 0;
  for (let i = 0; i < 17; i++) t += CREDIT_CHARS.indexOf(c[i]) * CREDIT_WEIGHTS[i];
  const k = (31 - (t % 31)) % 31;
  return CREDIT_CHARS[k] === c[17];
}

// Chemin de la photo de la licence : <société>/licence-<horodatage>.<ext> ; null si le format n'est pas accepté.
export function licensePath(org, fileName, now = new Date()) {
  const m = /\.(jpe?g|png|heic|webp|pdf)$/i.exec(String(fileName || ''));
  if (!m) return null;
  const ts = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${org}/licence-${ts}.${m[1].toLowerCase().replace('jpeg', 'jpg')}`;
}
