// Outils de la fonction « depot », sans dépendance (Deno et Node 22 : WebCrypto) ; testés par tools/test-import.mjs.

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

// Renvoie { org, openid } si le jeton est intact et valide, sinon null.
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
    return p.exp > Math.floor(now / 1000) && p.org && p.openid ? { org: p.org, openid: p.openid } : null;
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
