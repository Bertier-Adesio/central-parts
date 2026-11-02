// Lecture d'une liste de stock fournisseur (CSV, ou feuille XLS/XLSX déjà convertie en tableau de lignes).
// Mêmes règles que la maquette (site/app/js/api.js, importRows) et data/formats.md.
// Module sans dépendance : utilisé par la fonction Edge (Deno) et par tools/test-import.mjs (Node).

// Correspondance des colonnes (format broker, Octopart, ECIA, en-têtes chinois courants) vers les champs du lot.
// Les en-têtes sont comparés sans casse, tirets, soulignés ni espaces répétés : « price-break-1 » = « price break 1 ».
export const COLUMNS = {
  mpn: ['mpn', 'manufacturer part number', 'part number', 'mfr part number', '型号', '料号', '规格型号'],
  mfr: ['manufacturer', 'mfr', 'manufacturer name', 'brand', '品牌', '厂商', '厂家', '制造商'],
  sku: ['sku', 'seller sku', 'distributor part number', 'product code', '产品编号', '商品编号', '物料编号'],
  // Lien vers la page du produit chez le vendeur (flux Octopart : « distributor-url »). Gardé pour les opérateurs
  // seulement (back office), jamais montré aux acheteurs : il révèle le vendeur (ADR 0022).
  url: ['distributor url', 'product url', 'product page', 'url', 'link', '产品链接', '链接'],
  // Fiche technique ou page du produit chez le fabricant (ADR 0022) ; gardée à part du lien du vendeur.
  datasheet: ['datasheet', 'datasheet url', 'datasheet link', 'data sheet', 'pdf', '规格书', '规格书链接', '数据手册', '技术资料'],
  // Description courte du produit, donnée par le vendeur (ADR 0022).
  desc: ['description', 'product description', 'part description', 'desc', '描述', '产品描述', '说明'],
  moq: ['moq', 'minimum order quantity', 'min order qty', 'min qty', '最小起订量', '起订量', '最小包装'],
  qty: ['quantity', 'qty', 'stock', 'quantity available', '数量', '库存', '库存数量', '现货数量'],
  dc: ['date code', 'datecode', 'dc', 'd/c', '批号', '批次', '年份'],
  // Boîtier ou emballage : « 封装 » (boîtier : SOT-23, SOP-8…) comme « 包装 » (emballage) vont dans le même champ.
  pack: ['packaging', 'package type', 'pack', 'package', 'case', '包装', '封装'],
  price: ['unit price', 'price', '单价', '价格'],
  p10: ['price per 10 pcs', 'price 10', 'price break 10'],
  p100: ['price per 100 pcs', 'price 100', 'price break 100'],
  p1000: ['price per 1,000 pcs', 'price per 1000 pcs', 'price 1000', 'price break 1000'],
  currency: ['currency', 'devise', '币种', '货币'],
  // Délai : « 1-3day », « 2 weeks », « 7天 », « 2周 » ; gardé en jours (le plus long de la fourchette).
  lead: ['lead time', 'leadtime', 'lead', 'delivery time', '货期', '交期', '交货期'],
  // Champs facultatifs repris des API DigiKey et TI (ADR 0024). Le boîtier est lu ici en plus de « pack » (qui garde
  // son contenu, pour les fichiers déjà déposés) ; l'API ne le présente pas comme un conditionnement.
  case: ['case', 'package case', 'case/package', 'package / case', '封装', '封装形式'],
  spq: ['spq', 'standard pack', 'standard pack quantity', 'standard package', 'standard package quantity', 'reel quantity', 'reel qty',
    'full reel', '标准包装', '标准包装数量', '整包数量', '整盘数量', '包装数量'],
  lifecycle: ['lifecycle', 'life cycle', 'lifecycle status', 'part status', 'product status', '生命周期', '产品状态'],
  eccn: ['eccn', 'export control classification number', '出口管制分类'],
  hts: ['hts', 'hts code', 'htsus', 'hs code', 'customs code', 'tariff code', '海关编码', 'hs编码'],
  coo: ['country of origin', 'coo', 'origin', 'made in', '原产地', '产地', '原产国'],
};

// Octets du fichier → texte : UTF-8 par défaut ; repli en GB18030, qui couvre GBK (Excel « CSV » sur un poste chinois).
/** @param {Uint8Array} buf @returns {string} */
export function decode(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gb18030').decode(buf);
  }
}

const norm = (h) => String(h).toLowerCase().replace(/[\s_-]+/g, ' ').trim();

// CSV : séparateur deviné sur la première ligne (; tabulation ou ,), champs entre guillemets, BOM retiré.
export function parseCSV(text) {
  text = String(text || '').replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const sep = [';', '\t', ','].sort((a, b) => countOutsideQuotes(first, b) - countOutsideQuotes(first, a))[0];
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur.trim()); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur.trim()); cur = '';
      if (row.some((x) => x)) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur.trim());
  if (row.some((x) => x)) rows.push(row);
  return rows;
}

function countOutsideQuotes(line, sep) {
  let n = 0, q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (ch === sep && !q) n++; }
  return n;
}

// Prix : « 1,250.00 », « 1250,00 », « $12.5 » ; null si vide ou non positif.
export function price(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d,.\-]/g, '').replace(/,(\d{1,4})$/, '.$1').replace(/,/g, ''));
  return n > 0 ? n : null;
}

// Raisons de rejet : un code stable (traduit par les pages en anglais et en chinois) et un libellé français
// gardé pour la page /depot/ existante.
export const REASONS = {
  mpn_missing: 'MPN manquant',
  qty_invalid: 'Quantité invalide',
  moq_invalid: 'MOQ invalide',
  price_invalid: 'Prix invalide',
  break_incomplete: 'Palier incomplet : quantité ou prix manquant',
  breaks_qty_order: 'Paliers non croissants en quantité',
  breaks_price_order: 'Prix des paliers en hausse',
};
const reject = (line, code) => ({ line, code, reason: REASONS[code] });
const int = (v) => { const t = String(v ?? '').replace(/[\s,.'’]/g, ''); return /^\d+$/.test(t) ? parseInt(t, 10) : NaN; };
const filled = (v) => v != null && String(v).trim() !== '';

// Lignes brutes (première ligne = en-têtes) → lignes normalisées pour apply_stock_import_batch.
// Chaque ligne est acceptée ou rejetée avec sa raison ; la base refait les contrôles de fond (MPN, quantité, devise).
/** @returns {{ error?: string, rows: any[], rejected: any[], total: number }} */
export function mapRows(table) {
  const rows = (table || []).map((r) => r.map((x) => (x == null ? '' : String(x).trim())));
  while (rows.length && !rows[0].some((x) => x)) rows.shift();
  if (rows.length < 2) return { error: 'Fichier vide : une ligne d\'en-tête et au moins une ligne attendues' };
  const head = rows.shift().map(norm);
  const ix = {};
  for (const k of Object.keys(COLUMNS)) {
    ix[k] = -1;
    for (const n of COLUMNS[k]) if (ix[k] < 0) ix[k] = head.indexOf(norm(n));
  }
  // Paliers en paires de colonnes (flux distributeur Octopart) : « price-break-N » (quantité) et « price-usd-N » (prix),
  // pris dans l'ordre de N.
  const breaks = {}, pairs = [];
  let pairCurrency = '';
  head.forEach((h, i) => {
    let m = h.match(/^price break (\d+)$/);
    if (m) { (breaks[m[1]] ||= {}).q = i; return; }
    m = h.match(/^price ([a-z]{3}) (\d+)$/);
    if (m) { (breaks[m[2]] ||= {}).p = i; pairCurrency ||= m[1].toUpperCase(); }
  });
  for (const k of Object.keys(breaks).sort((a, b) => a - b)) if (breaks[k].q != null && breaks[k].p != null) pairs.push(breaks[k]);
  if (ix.mpn < 0 || ix.qty < 0) return { error: 'Colonnes obligatoires absentes : référence fabricant (MPN) et quantité' };
  const get = (f, k) => (ix[k] >= 0 ? f[ix[k]] || '' : '');
  const out = [], rejected = [];
  rows.forEach((f, n) => {
    const line = n + 2;
    if (!f.some((x) => x)) return;
    const mpn = get(f, 'mpn').toUpperCase();
    const qty = int(get(f, 'qty'));
    if (!mpn) { rejected.push(reject(line, 'mpn_missing')); return; }
    if (!(qty > 0)) { rejected.push(reject(line, 'qty_invalid')); return; }
    let moq = null;
    if (filled(get(f, 'moq'))) { moq = int(get(f, 'moq')); if (!(moq >= 1)) { rejected.push(reject(line, 'moq_invalid')); return; } }
    // Colonne de prix qui contient tous les paliers (fichiers de fabricants chinois) : « 10~90 0.0379|…|10000以上 0.0185 ».
    const cell = get(f, 'price');
    const cellTiers = tierCell(cell);
    if (cellTiers === false) { rejected.push(reject(line, 'price_invalid')); return; }
    if (!cellTiers && filled(cell) && price(cell) == null) { rejected.push(reject(line, 'price_invalid')); return; }
    // Paliers : quantité minimale et prix, tous deux présents et valides ; quantités croissantes, prix stables ou en baisse.
    const list = cellTiers ? [...cellTiers] : [];
    for (const [k, q] of [['p10', 10], ['p100', 100], ['p1000', 1000]]) {
      if (!filled(get(f, k))) continue;
      const v = price(get(f, k));
      if (v == null) { rejected.push(reject(line, 'price_invalid')); return; }
      list.push([q, v]);
    }
    for (const b of pairs) {
      const hasQ = filled(f[b.q]), hasP = filled(f[b.p]);
      if (!hasQ && !hasP) continue;
      if (!hasQ || !hasP) { rejected.push(reject(line, 'break_incomplete')); return; }
      const q = int(f[b.q]), v = price(f[b.p]);
      if (!(q > 0)) { rejected.push(reject(line, 'break_incomplete')); return; }
      if (v == null) { rejected.push(reject(line, 'price_invalid')); return; }
      list.push([q, v]);
    }
    for (let i = 1; i < list.length; i++) {
      if (list[i][0] <= list[i - 1][0]) { rejected.push(reject(line, 'breaks_qty_order')); return; }
      if (list[i][1] > list[i - 1][1]) { rejected.push(reject(line, 'breaks_price_order')); return; }
    }
    const tiers = {};
    for (const [q, v] of list) tiers[q] = v;
    // Sans colonne de prix unitaire : le prix du plus petit palier.
    let unit = cellTiers ? null : price(cell);
    const mins = Object.keys(tiers).map(Number).sort((a, b) => a - b);
    if (unit == null && mins.length) { unit = tiers[mins[0]]; if (mins[0] === 1) delete tiers[1]; }
    const spq = int(get(f, 'spq'));
    out.push({ line, mpn, mfr: get(f, 'mfr'), sku: get(f, 'sku'), url: cleanUrl(get(f, 'url')),
      datasheet: cleanUrl(get(f, 'datasheet')), desc: cleanText(get(f, 'desc')), lead: leadDays(get(f, 'lead')), qty, dc: get(f, 'dc'),
      pack: get(f, 'pack'), price: unit, currency: (get(f, 'currency') || pairCurrency).toUpperCase(), moq, tiers,
      // Facultatifs : vides ou illisibles, ils sont simplement ignorés (jamais un motif de rejet).
      case: cleanText(get(f, 'case')).slice(0, 60), spq: spq >= 1 ? spq : null, lifecycle: lifecycle(get(f, 'lifecycle')),
      eccn: cleanText(get(f, 'eccn')).toUpperCase().slice(0, 20), hts: get(f, 'hts').replace(/[^0-9]/g, '').slice(0, 20),
      coo: country(get(f, 'coo')) });
  });
  return { rows: out, rejected, total: rows.length };
}

// Lien sans paramètres de suivi (utm_*) ; seuls les liens http(s) de 2 048 caractères au plus sont gardés,
// pour qu'un texte ou un lien « javascript: » ne devienne jamais un lien cliquable dans le back office.
export function cleanUrl(v) {
  if (!v) return '';
  try {
    const u = new URL(String(v).trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
    const out = u.toString();
    return out.length <= 2048 ? out : '';
  } catch { return ''; }
}

// Cellule de paliers « quantité~quantité prix », séparés par « | », « ; » ou un retour à la ligne ; le dernier
// palier peut s'écrire « 10000以上 0.0185 » ou « 10000+ 0.0185 ». Renvoie [[quantité minimale, prix]…],
// null si la cellule n'est pas une liste de paliers (simple prix), false si elle en est une mais illisible.
export function tierCell(v) {
  const t = String(v || '').trim();
  if (!t || !(/[~|]|以上/.test(t) || /^\d[\d,]*\s*(?:[-–+]|至|到)/.test(t))) return null;
  const list = [];
  for (const part of t.split(/[|;\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d[\d,]*)\s*(?:(?:~|-|–|至|到)\s*\d[\d,]*|以上|及以上|\+)?\s*[:：]?\s*([^\s:：]+)$/);
    if (!m) return false;
    const q = int(m[1]), p = price(m[2]);
    if (!(q > 0) || p == null) return false;
    list.push([q, p]);
  }
  return list.length ? list : false;
}

// Délai en jours : « 1-3day » → 3, « 2 weeks » → 14, « 7天 » → 7, « 2-3周 » → 21 ; null si illisible ou au-delà d'un an.
export function leadDays(v) {
  const t = String(v || '').toLowerCase().replace(/\s+/g, '');
  const m = t.match(/^(?:(\d+)(?:-|~|–|至|到))?(\d+)(day|days|d|天|日|工作日|week|weeks|wk|w|周|星期)?$/);
  if (!m) return null;
  const n = parseInt(m[2], 10) * (/^(week|weeks|wk|w|周|星期)$/.test(m[3] || '') ? 7 : 1);
  return n <= 365 ? n : null;
}

// Cycle de vie normalisé : active, nrnd (déconseillé pour les nouvelles conceptions), last_time_buy, obsolete ; null sinon.
export function lifecycle(v) {
  const t = String(v || '').toLowerCase().trim();
  if (!t) return null;
  if (/nrnd|not recommended|不推荐/.test(t)) return 'nrnd';
  if (/\bltb\b|last.?time|\beol\b|end of life|最后购买/.test(t)) return 'last_time_buy';
  if (/obsolete|discontinued|停产|淘汰/.test(t)) return 'obsolete';
  if (/^(active|production|in production|preview)$|量产|在产|生产中/.test(t)) return 'active';
  return null;
}

// Pays d'origine en code ISO 3166 alpha-2 : code de deux lettres, ou nom courant (anglais, français, chinois).
const COUNTRIES = { china: 'CN', chine: 'CN', 中国: 'CN', prc: 'CN', taiwan: 'TW', 台湾: 'TW', malaysia: 'MY', malaisie: 'MY', 马来西亚: 'MY',
  philippines: 'PH', 菲律宾: 'PH', thailand: 'TH', thaïlande: 'TH', 泰国: 'TH', vietnam: 'VN', 越南: 'VN', japan: 'JP', japon: 'JP', 日本: 'JP',
  korea: 'KR', 'south korea': 'KR', corée: 'KR', 韩国: 'KR', 'united states': 'US', usa: 'US', 'états-unis': 'US', 美国: 'US',
  mexico: 'MX', mexique: 'MX', 墨西哥: 'MX', germany: 'DE', allemagne: 'DE', 德国: 'DE', 'hong kong': 'HK', 香港: 'HK',
  singapore: 'SG', singapour: 'SG', 新加坡: 'SG', india: 'IN', inde: 'IN', 印度: 'IN', indonesia: 'ID', 印度尼西亚: 'ID' };
export function country(v) {
  const t = String(v || '').trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  return COUNTRIES[t.toLowerCase()] || null;
}

// Description : espaces et retours à la ligne réduits à une espace, 500 caractères au plus.
export function cleanText(v) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}
