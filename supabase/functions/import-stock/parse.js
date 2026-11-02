// Lecture d'une liste de stock fournisseur (CSV, ou feuille XLS/XLSX déjà convertie en tableau de lignes).
// Mêmes règles que la maquette (site/app/js/api.js, importRows) et data/formats.md.
// Module sans dépendance : utilisé par la fonction Edge (Deno) et par tools/test-import.mjs (Node).

// Correspondance des colonnes (format broker, Octopart, ECIA, en-têtes chinois courants) vers les champs du lot.
// Les en-têtes sont comparés sans casse, tirets, soulignés ni espaces répétés : « price-break-1 » = « price break 1 ».
export const COLUMNS = {
  mpn: ['mpn', 'manufacturer part number', 'part number', 'mfr part number', '型号', '料号', '规格型号'],
  mfr: ['manufacturer', 'mfr', 'manufacturer name', 'brand', '品牌', '厂商', '厂家', '制造商'],
  sku: ['sku', 'seller sku', 'distributor part number'],
  url: ['product url', 'url', 'link'],          // « distributor-url » (flux Octopart) volontairement ignorée : jamais gardée
  moq: ['moq', 'minimum order quantity', 'min order qty', 'min qty', '最小起订量', '起订量', '最小包装'],
  qty: ['quantity', 'qty', 'stock', 'quantity available', '数量', '库存', '库存数量', '现货数量'],
  dc: ['date code', 'datecode', 'dc', 'd/c', '批号', '年份'],
  pack: ['packaging', 'package type', 'pack', '包装'],
  price: ['unit price', 'price', '单价', '价格'],
  p10: ['price per 10 pcs', 'price 10', 'price break 10'],
  p100: ['price per 100 pcs', 'price 100', 'price break 100'],
  p1000: ['price per 1,000 pcs', 'price per 1000 pcs', 'price 1000', 'price break 1000'],
  currency: ['currency', 'devise', '币种', '货币'],
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
    if (filled(get(f, 'price')) && price(get(f, 'price')) == null) { rejected.push(reject(line, 'price_invalid')); return; }
    // Paliers : quantité minimale et prix, tous deux présents et valides ; quantités croissantes, prix stables ou en baisse.
    const list = [];
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
    let unit = price(get(f, 'price'));
    const mins = Object.keys(tiers).map(Number).sort((a, b) => a - b);
    if (unit == null && mins.length) { unit = tiers[mins[0]]; if (mins[0] === 1) delete tiers[1]; }
    out.push({ line, mpn, mfr: get(f, 'mfr'), sku: get(f, 'sku'), url: cleanUrl(get(f, 'url')), qty, dc: get(f, 'dc'),
      pack: get(f, 'pack'), price: unit, currency: (get(f, 'currency') || pairCurrency).toUpperCase(), moq, tiers });
  });
  return { rows: out, rejected, total: rows.length };
}

// Lien produit sans paramètres de suivi (utm_*).
export function cleanUrl(v) {
  if (!v) return '';
  try {
    const u = new URL(v);
    for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
    return u.toString();
  } catch { return v; }
}
