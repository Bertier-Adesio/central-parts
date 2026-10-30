// Lecture d'une liste de stock fournisseur (CSV, ou feuille XLS/XLSX déjà convertie en tableau de lignes).
// Mêmes règles que la maquette (site/app/js/api.js, importRows) et data/formats.md.
// Module sans dépendance : utilisé par la fonction Edge (Deno) et par tools/test-import.mjs (Node).

// Correspondance des colonnes (format broker, Octopart, ECIA) vers les champs du lot.
export const COLUMNS = {
  mpn: ['mpn', 'manufacturer part number', 'part number', 'mfr_part_number'],
  mfr: ['manufacturer', 'mfr', 'manufacturer_name', 'brand'],
  sku: ['sku', 'seller sku', 'distributor part number'],
  url: ['product url', 'product_url', 'url', 'link'],
  qty: ['quantity', 'qty', 'stock', 'quantity_available', 'quantity available'],
  dc: ['date_code', 'datecode', 'date code', 'dc'],
  pack: ['packaging', 'package_type', 'package type', 'pack'],
  price: ['unit price', 'unit_price', 'price'],
  p10: ['price per 10 pcs', 'price_10', 'price break 10'],
  p100: ['price per 100 pcs', 'price_100', 'price break 100'],
  p1000: ['price per 1,000 pcs', 'price per 1000 pcs', 'price_1000', 'price break 1000'],
  currency: ['currency', 'devise'],
};

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
export function mapRows(table) {
  const rows = (table || []).map((r) => r.map((x) => (x == null ? '' : String(x).trim())));
  while (rows.length && !rows[0].some((x) => x)) rows.shift();
  if (rows.length < 2) return { error: 'Fichier vide : une ligne d\'en-tête et au moins une ligne attendues' };
  const head = rows.shift().map((h) => h.toLowerCase().replace(/\s+/g, ' '));
  const ix = {};
  for (const k of Object.keys(COLUMNS)) {
    ix[k] = -1;
    for (const n of COLUMNS[k]) if (ix[k] < 0) ix[k] = head.indexOf(n);
  }
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
    out.push({ line, mpn, mfr: get(f, 'mfr'), sku: get(f, 'sku'), url: get(f, 'url'), qty, dc: get(f, 'dc'),
      pack: get(f, 'pack'), price: price(get(f, 'price')), currency: get(f, 'currency').toUpperCase(), tiers });
  });
  return { rows: out, rejected, total: rows.length };
}
