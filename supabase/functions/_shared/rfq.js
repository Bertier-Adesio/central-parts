// Route RFQ des plateformes (ADR 0023) : logique sans accès réseau ni base, partagée par les fonctions « rfq »,
// « wechat-events » et « admin », et testée sous Node par tools/test-rfq.mjs.
//   - lecture des commandes WeChat du fournisseur (报价 / 无货 DEM-…) et de l'administrateur (rfq, approve DEM-…) ;
//   - erreurs SQL → réponses HTTP de l'API plateforme ;
//   - empreinte des clés d'API, secrets et signature des webhooks (HMAC-SHA256, en-têtes CP-Signature, CP-Timestamp).
// Les textes envoyés dans WeChat sont dans robot-texts.js.

// Délai de réponse du fournisseur (heures réelles, à partir de l'envoi réussi) : même valeur que
// app.rfq_response_hours() en base. À ne pas confondre avec la fenêtre WeChat de 48 h ci-dessous.
export const RFQ_RESPONSE_HOURS = 48;
// Fenêtre WeChat : le compte de service n'envoie un texte libre qu'à un contact actif dans les 48 dernières heures.
// Gérée par WeChat (sendText échoue au-delà) ; la constante ne sert qu'aux messages d'explication.
export const WECHAT_FREE_TEXT_WINDOW_HOURS = 48;
export const RFQ_REMINDER_HOURS = 36;

export const CURRENCIES = ['EUR', 'USD', 'CNH', 'HKD', 'GBP', 'JPY'];
export const CLIENT_EVENTS = ['demand.validated', 'demand.rejected', 'demand.offers_ready', 'demand.no_offer', 'offer.expired'];
export const API_STATUSES = ['pending_validation', 'rejected', 'open', 'offers_ready', 'no_offer', 'ordered', 'cancelled'];

// Texte saisi dans WeChat : espaces et ponctuation pleine chasse ramenés à des espaces simples.
export function normalizeWechatText(text) {
  return String(text || '').replace(/[　，,，、；;：:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Réponse du fournisseur. Renvoie null si le texte n'est pas une commande RFQ, sinon
// { kind: 'decline', ref } ou { kind: 'quote', ref, price, currency, lead, dateCode, lot } ou { kind: 'help', ref }.
//   报价 DEM-0431 0.52 USD 7 2425          prix net unitaire, devise, délai en jours, date code
//   报价 DEM-0431 0.52 USD 7 2425 lot LOT-0187
//   无货 DEM-0431                           pas de stock
// Mots-clés anglais acceptés : quote, nostock / no stock.
export function parseSupplierRfq(text) {
  const t = normalizeWechatText(text);
  let m = /^(无货|沒貨|没货|no ?stock)\s*(DEM-\d+)$/i.exec(t);
  if (m) return { kind: 'decline', ref: m[2].toUpperCase() };
  m = /^(报价|報價|quote)\s*(DEM-\d+)(?:\s+(.*))?$/i.exec(t);
  if (!m) return null;
  const ref = m[2].toUpperCase();
  const tokens = (m[3] || '').split(' ').filter(Boolean);
  if (tokens.length < 3) return { kind: 'help', ref };
  const price = Number(tokens[0].replace(/[$¥￥€]/g, ''));
  const currency = tokens[1].toUpperCase() === 'RMB' || tokens[1].toUpperCase() === 'CNY' ? 'CNH' : tokens[1].toUpperCase();
  const leadMatch = /^(\d{1,4})(?:天|d|days?)?$/i.exec(tokens[2]);
  if (!Number.isFinite(price) || price <= 0 || !leadMatch) return { kind: 'help', ref };
  let dateCode = null, lot = null;
  for (let i = 3; i < tokens.length; i++) {
    const k = tokens[i];
    if (/^lot$/i.test(k) && tokens[i + 1]) { lot = tokens[++i].toUpperCase(); continue; }
    if (/^LOT-[\w-]+$/i.test(k)) { lot = k.toUpperCase(); continue; }
    if (!dateCode) dateCode = k.replace(/^(DC|D\/C|批号)/i, '') || null;
  }
  return { kind: 'quote', ref, price, currency, lead: Number(leadMatch[1]), dateCode, lot };
}

// Commandes RFQ de l'administrateur (en anglais). Renvoie null si le texte n'en est pas une.
//   rfq                                  demandes en attente
//   rfq DEM-0431                         fiche
//   rfq stats ORG-0101                   taux de traitement d'un fournisseur
//   approve DEM-0431 [only ORG-0101,ORG-0105]
//   reject DEM-0431 motif
//   resend DEM-0431 [ORG-0101]           renvoie aux fournisseurs non joints (tous, ou un seul)
export function parseOperatorRfq(text) {
  const t = String(text || '').trim();
  if (/^rfq$/i.test(t)) return { cmd: 'list' };
  let m = /^rfq\s+stats\s+(ORG-\d+|[A-Z0-9-]+)$/i.exec(t);
  if (m) return { cmd: 'stats', org: m[1].toUpperCase() };
  m = /^rfq\s+(DEM-\d+)$/i.exec(t);
  if (m) return { cmd: 'show', ref: m[1].toUpperCase() };
  m = /^(?:approve|ok|通过)\s+(DEM-\d+)(?:\s+only\s+(.+))?$/i.exec(t);
  if (m) {
    const only = m[2] ? m[2].split(/[\s,，]+/).filter(Boolean).map((x) => x.toUpperCase()) : null;
    return { cmd: 'approve', ref: m[1].toUpperCase(), only };
  }
  m = /^(?:reject|拒绝)\s+(DEM-\d+)\s*([\s\S]*)$/i.exec(t);
  if (m) return { cmd: 'reject', ref: m[1].toUpperCase(), reason: m[2].trim() };
  m = /^resend\s+(DEM-\d+)(?:\s+(ORG-\d+|[A-Z0-9-]+))?$/i.exec(t);
  if (m) return { cmd: 'resend', ref: m[1].toUpperCase(), org: m[2] ? m[2].toUpperCase() : null };
  return null;
}

// Erreurs SQL (codes posés par la migration 20261102000020) → statut HTTP et code d'erreur de l'API.
const SQL_ERRORS = {
  CP401: [401, 'unauthorized'], CP403: [403, 'forbidden'], P0002: [404, 'not_found'], CP409: [409, 'conflict'],
  '22023': [422, 'invalid'], CP005: [422, 'invalid'], CP429: [429, 'rate_limited'], CP410: [409, 'expired'],
  '42501': [403, 'forbidden'],
};
export function apiError(err) {
  const [status, code] = SQL_ERRORS[err?.code || ''] || [500, 'server'];
  const body = { error: { code, message: status === 500 ? 'Internal error' : String(err?.message || code) } };
  if (status === 422 && err?.details) body.error.field = err.details;
  const headers = {};
  if (status === 429) headers['Retry-After'] = String(/^\d+$/.test(err?.details || '') ? err.details : 60);
  return { status, body, headers };
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
}

// Clé présentée par la plateforme : « Bearer cp_live_… » ou « Bearer cp_test_… ». Renvoie la clé ou null.
export function bearerKey(header) {
  const m = /^Bearer\s+(cp_(?:live|test)_[A-Za-z0-9]{16,64})$/.exec(String(header || '').trim());
  return m ? m[1] : null;
}

// Secret de signature d'un abonnement : dérivé de RFQ_WEBHOOK_KEY et de son identifiant, jamais stocké.
export async function webhookSecret(masterKey, webhookId) {
  if (!masterKey) throw new Error('RFQ_WEBHOOK_KEY manquant');
  return 'whsec_' + (await hmacHex(masterKey, 'webhook:' + webhookId));
}

// Signature d'une livraison : CP-Signature = sha256=HMAC(secret, timestamp + "." + corps), CP-Timestamp = secondes Unix.
export async function signWebhook(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const ts = String(timestamp);
  return { 'CP-Timestamp': ts, 'CP-Signature': 'sha256=' + (await hmacHex(secret, ts + '.' + body)) };
}

// Vérification côté plateforme (documentée dans api/plateformes.md) : tolérance de 5 minutes.
export async function verifyWebhook(secret, body, headers, now = Math.floor(Date.now() / 1000)) {
  const ts = Number(headers['CP-Timestamp']);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) return false;
  const want = (await signWebhook(secret, body, ts))['CP-Signature'];
  return want === headers['CP-Signature'];
}

// Délai entre deux tentatives de livraison : 1, 2, 4… minutes, 2 heures au plus (comme record_webhook_delivery).
export function retryDelayMinutes(attempts) {
  return Math.min(120, 2 ** attempts);
}
