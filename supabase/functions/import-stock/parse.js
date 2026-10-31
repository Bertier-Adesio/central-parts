// Lecture d'une liste de stock fournisseur (CSV, ou feuille XLS/XLSX déjà convertie en tableau de lignes).
// Mêmes règles que la maquette (site/app/js/api.js, importRows) et data/formats.md.
// Module sans dépendance : utilisé par la fonction Edge (Deno) et par tools/test-import.mjs (Node).

// Correspondance des colonnes (format broker, Octopart, ECIA, en-têtes chinois courants) vers les champs du lot.
// Les en-têtes sont comparés sans casse, tirets, soulignés ni espaces répétés : « price-break-1 » = « price break 1 ».
export const COLUMNS = {
  mpn: ['mpn', 'manufacturer part number', 'part number', 'mfr part number', '型号', '料号', '规格型号'],
  mfr: ['manufacturer', 'mfr', 'manufacturer name', 'brand', '品牌', '厂商', '厂家', '制造商'],
  sku: ['sku', 'seller sku', 'distributor part number'],
  url: ['product url', 'url', 'link', 'distributor url'],
  qty: ['quantity', 'qty', 'stock', 'quantity available', '数量', '库存', '库存数量', '现货数量'],
  dc: ['date code', 'datecode', 'dc', 'd/c', '批号', '年份'],
  pack: ['packaging', 'package type', 'pack', '包装'],
  price: ['unit price', 'price', '单价', '价格'],
  p10: ['price per 10 pcs', 'price 10', 'price break 10'],
  p100: ['price per 100 pcs', 'price 100', 'price break 100'],
  p1000: ['price per 1,000 pcs', 'price per 1000 pcs', 'price 1000', 'price break 1000'],
  currency: ['currency', 'devise', '币种', '货币'],
};

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

// Lignes brutes (première ligne = en-têtes) → lignes normalisées pour apply_stock_import_batch.
// Les contrôles de fond (MPN, quantité, devise) sont refaits par la base ; ici on rejette l'illisible.
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
  // Paliers en paires de colonnes (flux distributeur Octopart) : « price-break-N » (quantité) et « price-usd-N » (prix).
  const breaks = {}, pairs = [];
  let pairCurrency = '';
  head.forEach((h, i) => {
    let m = h.match(/^price break (\d+)$/);
    if (m) { (breaks[m[1]] ||= {}).q = i; return; }
    m = h.match(/^price ([a-z]{3}) (\d+)$/);
    if (m) { (breaks[m[2]] ||= {}).p = i; pairCurrency ||= m[1].toUpperCase(); }
  });
  for (const b of Object.values(breaks)) if (b.q != null && b.p != null) pairs.push(b);
  if (ix.mpn < 0 || ix.qty < 0) return { error: 'Colonnes obligatoires absentes : référence fabricant (MPN) et quantité' };
  const get = (f, k) => (ix[k] >= 0 ? f[ix[k]] || '' : '');
  const out = [], rejected = [];
  rows.forEach((f, n) => {
    const line = n + 2;
    if (!f.some((x) => x)) return;
    const mpn = get(f, 'mpn').toUpperCase();
    const qtyText = get(f, 'qty').replace(/[\s,.'’]/g, '');
    const qty = /^\d+$/.test(qtyText) ? parseInt(qtyText, 10) : NaN;
    if (!mpn) { rejected.push({ line, reason: 'MPN manquant' }); return; }
    if (!(qty > 0)) { rejected.push({ line, reason: 'Quantité invalide' }); return; }
    const tiers = {};
    for (const [k, q] of [['p10', 10], ['p100', 100], ['p1000', 1000]]) { const v = price(get(f, k)); if (v) tiers[q] = v; }
    for (const b of pairs) {
      const q = parseInt(String(f[b.q] || '').replace(/[\s,.'’]/g, ''), 10), v = price(f[b.p]);
      if (q > 0 && v) tiers[q] = v;
    }
    // Sans colonne de prix unitaire : le prix du plus petit palier.
    let unit = price(get(f, 'price'));
    const mins = Object.keys(tiers).map(Number).sort((a, b) => a - b);
    if (unit == null && mins.length) { unit = tiers[mins[0]]; if (mins[0] === 1) delete tiers[1]; }
    out.push({ line, mpn, mfr: get(f, 'mfr'), sku: get(f, 'sku'), url: cleanUrl(get(f, 'url')), qty, dc: get(f, 'dc'),
      pack: get(f, 'pack'), price: unit, currency: (get(f, 'currency') || pairCurrency).toUpperCase(), tiers });
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
