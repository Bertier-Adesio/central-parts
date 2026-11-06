// Fonction « admin » simulée, pour la démonstration locale (tools/demo-admin.mjs) et le test Chromium
// (tools/test-admin-ui.mjs) du back office site/admin/. Mêmes routes, mêmes réponses et mêmes règles que
// supabase/functions/admin/index.ts et les fonctions SQL admin_* (migrations 20261102000014, 20261102000020 pour les RFQ,
// 20261103000024 pour les demandes d'achat). Données fictives.
//
// Jetons simulés : DEMO-ADMIN (administrateur), DEMO-OTHER (compte connecté, pas administrateur) ; tout autre
// jeton est expiré (401).

export const ADMIN_EMAIL = 'admin@example.test';

const day = (d, h = 9, m = 0) => new Date(Date.UTC(2026, 9, d, h, m)).toISOString();

// Paliers propres à chaque référence : nombre de paliers et seuils varient d'une ligne à l'autre.
function tiers(base, i) {
  const steps = [[1, 100, 1000], [1, 50, 500, 2000], [10, 1000], [1, 100, 1000, 3000, 10000], [5, 250, 2500]][(i + Math.floor(i / 10)) % 5];
  return steps.map((min, k) => ({ min, price: +(base * (1 - 0.12 * k)).toFixed(4) }));
}

function lot(id, org, seller, mpn, manufacturer, pack, qty, base, currency, lead, i, source = 'file') {
  const t = tiers(base, i);
  return {
    // Prix unitaire = premier palier, comme l'import d'un fichier sans colonne de prix unitaire.
    id, org_id: org, seller, mpn, manufacturer, pack, qty, unit_price: t[0].price, currency, lead_days: lead,
    date_code: i % 3 ? '' : String(2300 + (i % 40)), source, updated_at: day(30, 8),
    breaks: t.map((b, k) => ({ from: b.min, to: t[k + 1] ? t[k + 1].min - 1 : null, price: b.price })),
  };
}

export function createMock() {
  const orgs = [
    { org_id: 'ORG-0107', name: '深圳测试电子有限公司 (fictif)', alias: 'P-91350100M000100Y43', region: 'CN', code: '91350100M000100Y43',
      city: '深圳', country: 'CN', profile: 'Distributor', currency: 'CNH', lang: 'zh', status: 'pending', rejected_reason: null,
      requested_at: day(31, 9, 12), decided_at: null, has_license: true, registered_by: 'oFICTIF0107',
      contacts: [{ label: '王经理', role: 'admin', openid: 'oFICTIF0107', bound_at: day(31, 9, 12), last_login_at: day(31, 9, 40) }],
      decisions: [] },
    { org_id: 'ORG-0108', name: '香港測試元件有限公司 Harbour Test Components (fictif)', alias: 'P-71234567-000-11', region: 'HK',
      code: '71234567-000-11', city: 'Hong Kong', country: 'HK', profile: 'Broker', currency: 'USD', lang: 'zh', status: 'pending',
      rejected_reason: null, requested_at: day(32, 7, 5), decided_at: null, has_license: false, registered_by: 'oFICTIF0108',
      contacts: [{ label: '陳小姐', role: 'admin', openid: 'oFICTIF0108', bound_at: day(32, 7, 5), last_login_at: day(32, 7, 5) }],
      decisions: [] },
    { org_id: 'ORG-0112', name: 'Société hors Chine (fictif)', alias: 'P-202612345K', region: 'OTHER', code: '202612345K',
      city: 'Singapore', country: null, profile: 'Reseller', currency: 'USD', lang: 'en', status: 'pending', rejected_reason: null,
      requested_at: day(32, 10, 30), decided_at: null, has_license: false, registered_by: 'oFICTIF0112', contacts: [], decisions: [] },
    { org_id: 'ORG-0109', name: '上海样例贸易有限公司 (fictif)', alias: 'P-91310000MA1FL1MMXL', region: 'CN', code: '91310000MA1FL1MMXL',
      city: '上海', country: 'CN', profile: 'Reseller', currency: 'USD', lang: 'zh', status: 'rejected', rejected_reason: '营业执照不清晰',
      requested_at: day(28, 14), decided_at: day(29, 8), has_license: true, registered_by: 'oFICTIF0109',
      contacts: [{ label: null, role: 'admin', openid: 'oFICTIF0109', bound_at: day(28, 14), last_login_at: day(29, 9) }],
      decisions: [{ action: 'rejected', from_status: 'pending', reason: '营业执照不清晰', at: day(29, 8), by: 'WeChat · Opérateur (fictif)' }] },
    { org_id: 'ORG-0110', name: 'Fournisseur partenaire de démonstration (fictif)', alias: 'V-5', region: 'CN', code: '91440300MA5FDEM008',
      city: '深圳', country: 'CN', profile: 'Distributor', currency: 'USD', lang: 'zh', status: 'validated', rejected_reason: null,
      requested_at: day(25, 10), decided_at: day(26, 9), has_license: true, registered_by: 'oFICTIF0110',
      contacts: [{ label: '李先生', role: 'admin', openid: 'oFICTIF0110', bound_at: day(25, 10), last_login_at: day(30, 8) }],
      decisions: [{ action: 'approved', from_status: 'pending', reason: null, at: day(26, 9), by: 'WeChat · Opérateur (fictif)' }],
      import: { file_name: 'demo-9-novembre.csv', status: 'done', received_at: day(30, 8), rows_total: 10, rejected: 0,
        currency: 'USD', currency_used: { 'USD|file': 8, 'USD|upload': 2 } } },
    { org_id: 'ORG-0111', name: '东莞示例半导体有限公司 Fabricant fictif (1 812 réf.)', alias: 'V-6', region: 'CN', code: '91440300MA5FB0X014',
      city: '东莞', country: 'CN', profile: 'Manufacturer', currency: 'CNH', lang: 'zh', status: 'validated', rejected_reason: null,
      requested_at: day(20, 6), decided_at: day(21, 9), has_license: true, registered_by: 'oFICTIF0111',
      contacts: [{ label: '张总', role: 'admin', openid: 'oFICTIF0111', bound_at: day(20, 6), last_login_at: day(31, 3) }],
      decisions: [{ action: 'approved', from_status: 'pending', reason: null, at: day(21, 9), by: 'WeChat · Opérateur (fictif)' }],
      import: { file_name: '库存表-2026-10-31.xlsx', status: 'done', received_at: day(31, 3, 20), rows_total: 1812, rejected: 0 } },
  ];

  // Les 10 références de la démonstration du 9 novembre (fournisseur partenaire) ; prix fictifs.
  const demo = [
    ['STM32G071RBT6', 'STMicroelectronics', 'LQFP-64', 4800, 1.62], ['TPS62130RGTR', 'Texas Instruments', 'VQFN-16', 12000, 0.71],
    ['GRM188R71H104KA93D', 'Murata', '0603', 900000, 0.0025], ['CH340C', 'WCH', 'SOP-16', 80000, 0.27],
    ['ESP32-C3-MINI-1-N4', 'Espressif', 'Module', 25000, 1.38], ['LM358DR', 'Texas Instruments', 'SOIC-8', 60000, 0.06],
    ['AMS1117-3.3', 'Advanced Monolithic Systems', 'SOT-223', 150000, 0.03], ['NE555DR', 'Texas Instruments', 'SOIC-8', 30000, 0.08],
    ['1N4148W', 'onsemi', 'SOD-123', 500000, 0.004], ['BSS138', 'onsemi', 'SOT-23', 240000, 0.012],
  ];
  const lots = demo.map(([mpn, mf, pack, qty, p], i) => lot('LOT-D' + i, 'ORG-0110', orgs[4].name, mpn, mf, pack, qty, p, 'USD', 5, i));
  // Lien du vendeur, fiche technique et description sur les premières références (ADR 0022), adresses fictives.
  Object.assign(lots[0], { description: 'Microcontrôleur Arm Cortex-M0+ 128 Ko, LQFP-64',
    datasheet_url: 'https://fabricant.example/ds/STM32G071RBT6.pdf', product_url: 'https://vendeur.example/p/STM32G071RBT6' });
  Object.assign(lots[1], { product_url: 'javascript:alert(1)' });
  // Flux Octopart : le palier « 1 » devient le prix unitaire, les paliers commencent à 10.
  Object.assign(lots[2], { unit_price: 0.0031, breaks: [{ from: 10, to: 99, price: 0.0029 }, { from: 100, to: null, price: 0.0026 }] });
  // 1 812 références d'un fabricant (familles courantes, numérotées pour rester fictives), paliers propres à chacune.
  const fam = [['SS34', 'SMA'], ['1N4148W', 'SOD-123'], ['BSS138', 'SOT-23'], ['LM358', 'SOP-8'], ['AMS1117', 'SOT-223'],
    ['TL431', 'SOT-23'], ['MMBT3904', 'SOT-23'], ['SMBJ5.0A', 'SMB'], ['78L05', 'SOT-89'], ['LM2596S', 'TO-263']];
  for (let i = 0; i < 1812; i++) {
    const [f, pack] = fam[i % fam.length];
    lots.push(lot('LOT-U' + i, 'ORG-0111', orgs[5].name, `${f}-F${String(i + 1).padStart(4, '0')}`, 'Fabricant fictif', pack,
      ((i * 7919) % 50000) + 1000, 0.01 + ((i * 37) % 300) / 1000, 'CNH', 7 + (i % 3) * 7, i));
  }
  lots.push(lot('LOT-C1', 'ORG-0107', orgs[0].name, 'CJ-NE555-F01', '长电 (fictif)', 'SOP-8', 20000, 0.35, 'CNH', 3, 1));
  orgs[0].import = { file_name: '库存.csv', status: 'done', received_at: day(31, 9, 30), rows_total: 1, rejected: 0 };

  // Demandes d'achat du site (fiches request_for_operator) et RFQ des plateformes (rfq_for_operator), fictives.
  const req = (ref, status, mpn, qty, price, total, company, created) => ({
    ref, origin: 'site', status, mpn, qty, currency: 'EUR', unit_price: price, total, supplier: 'ORG-0110 V-5', seller_id: 'ORG-0110',
    source: 'distributor', ship_from: 'CN', supplier_unit_price: +(price / 1.1 * 1.08).toFixed(4), supplier_currency: 'USD', lot_qty: 30000,
    buyer_company: company, buyer_vat: 'FR00999999999', vat_checked: true, buyer_name: 'Acheteur Test', buyer_email: 'achats@example.com',
    buyer_phone: null, delivery: 'FR · 1 rue de l\'Exemple, 69000 Lyon', message: null, created_at: created, updated_at: created,
    decided_at: status === 'pending_validation' ? null : created, decided_by: status === 'pending_validation' ? null : 'admin:' + ADMIN_EMAIL,
    reject_reason: null, answered_at: null, billing: 'FR · 2 avenue de l\'Exemple, 75000 Paris', transport: { mode: 'central', carrier: 'DHL' },
    ship_address: { label: 'Entrepôt Shenzhen (fictif)', city: 'Shenzhen', country: 'CN' } });
  const requests = [
    req('PR-0012', 'pending_validation', 'NE555DR', 2000, 0.0957, 191.4, 'Atelier Exemple (fictif)', day(33, 9, 5)),
    req('PR-0011', 'pending_validation', 'STM32G071RBT6', 500, 1.9, 950, 'Bureau d\'études Test (fictif)', day(33, 8, 40)),
    req('PR-0010', 'submitted', 'LM358DR', 1000, 0.07, 70, 'EMS Démo (fictif)', day(32, 15)),
    // Panier de deux lignes (ADR 0028), deux fournisseurs.
    { ...req('PR-0015', 'pending_validation', 'CH340C', 5000, 0.30, 1500, 'Intégrateur Panier (fictif)', day(33, 9, 30)), cart_id: 'CART-0003', cart_lines: 2 },
    { ...req('PR-0016', 'pending_validation', 'SS34-F0001', 20000, 0.02, 400, 'Intégrateur Panier (fictif)', day(33, 9, 30)), cart_id: 'CART-0003', cart_lines: 2,
      supplier: 'ORG-0111 V-6', seller_id: 'ORG-0111', supplier_currency: 'CNH' },
  ];
  const rfqs = [
    { id: 'DEM-1004', status: 'pending_validation', rfq_id: 'RFQ-0040', client: 'ORG-0102 Plateforme de chiffrage (fictif)', mpn: 'TPS62130RGTR',
      manufacturer: 'Texas Instruments', qty: 3000, ship_to: 'FR', currency: 'EUR', created_at: day(33, 7, 30), candidates: ['ORG-0110'], bids: 0 },
    { id: 'DEM-1003', status: 'auction', rfq_id: 'RFQ-0039', client: 'ORG-0102 Plateforme de chiffrage (fictif)', mpn: 'CH340C', qty: 10000,
      ship_to: 'DE', currency: 'EUR', created_at: day(32, 11), validated_by: 'admin:' + ADMIN_EMAIL,
      sellers: [{ org: 'ORG-0110', notify: 'sent', response: 'pending' }], bids: 0 },
  ];
  const state = { orgs, lots, requests, rfqs, notified: [], calls: [], logins: [], profiles: {}, mfrs: [] };
  // Fiche société (ADR 0032), comme admin_supplier_profile : vide au départ, contacts à part, fabricants rattachés.
  const profile = (o) => {
    const p = state.profiles[o.org_id] ||= { org_id: o.org_id, about: {}, positioning: {}, certifications: [], languages: [],
      payment_methods: [], contacts: [] };
    p.identities = (o.contacts || []).map((c) => ({ openid: c.openid, label: c.label, role: c.role }));
    p.profile_editor = p.profile_editor || (o.contacts || []).find((c) => c.role === 'admin')?.openid || null;
    p.manufacturers = state.mfrs.flatMap((m) => m.links.filter((d) => d.org_id === o.org_id)
      .map((d) => ({ id: m.id, name: m.name, brands: m.brands, role: d.role, public_page: m.public_page })));
    return p;
  };
  // Fabricants (migration 20261105000033), comme app.manufacturer_json.
  const mjson = (m) => ({ ...m, can_publish: m.brands.length > 0 && Object.keys(m.about).length > 0 && m.links.some((d) => d.consent_at),
    proposals: (m.proposals || []).filter((r) => r.status === 'pending'),
    distributors: m.links.map((d) => { const o = find(d.org_id); return { org_id: o.org_id, name: o.name, role: d.role, status: o.status,
      consent_at: d.consent_at || null, consent_by: d.consent_by || null,
      offers: lots.filter((l) => l.org_id === o.org_id && l.qty > 0 && m.brands.some((b) => b.toUpperCase() === l.manufacturer.toUpperCase())).length }; }) });
  const mfind = (id) => state.mfrs.find((m) => m.id === id);
  const bad = (detail) => [422, { error: 'invalid', detail }];
  const tri = (x) => Object.fromEntries(Object.entries(x || {}).filter(([k, v]) => ['fr', 'en', 'zh'].includes(k) && String(v).trim()).map(([k, v]) => [k, String(v).trim()]));
  let contactSeq = 0;
  const find = (id) => orgs.find((o) => o.org_id === id);
  const lines = (id) => lots.filter((l) => l.org_id === id && l.qty > 0).length;
  const decide = (o, action, reason) => {
    o.decisions.unshift({ action, from_status: o.status, reason: reason || null, at: new Date().toISOString(), by: ADMIN_EMAIL });
  };
  const fiche = (o) => {
    const { import: imp, ...rest } = o;
    const srcs = [...new Set(lots.filter((l) => l.org_id === o.org_id).map((l) => l.source))];
    return { ...rest, stock: { lines: lines(o.org_id), lines_total: lots.filter((l) => l.org_id === o.org_id).length, sources: srcs }, last_import: imp || null };
  };

  // Renvoie [statut HTTP, corps] pour une requête vers /functions/v1/admin.
  function handle(method, path, query, body, token) {
    state.calls.push(`${method} ${path}`);
    if (method === 'POST' && path === '/login') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email || '').trim())) return [422, { error: 'email' }];
      state.logins.push(body.email);
      return [200, { ok: true }];
    }
    if (token === 'DEMO-OTHER') return [403, { error: 'forbidden' }];
    if (token !== 'DEMO-ADMIN') return [401, { error: 'session_expired' }];

    if (method === 'GET') {
      if (path === '/me') return [200, { email: ADMIN_EMAIL, display_name: 'Administrateur (démo)' }];
      if (path === '/suppliers') {
        const s = query.get('status');
        const counts = {};
        for (const o of orgs) counts[o.status] = (counts[o.status] || 0) + 1;
        const rows = orgs.filter((o) => !s || o.status === s).sort((a, b) => b.requested_at.localeCompare(a.requested_at))
          .map((o) => ({ org_id: o.org_id, name: o.name, alias: o.alias, region: o.region, code: o.code, city: o.city, profile: o.profile,
            currency: o.currency, status: o.status, requested_at: o.requested_at, decided_at: o.decided_at, lines: lines(o.org_id) }));
        return [200, { counts, rows }];
      }
      if (path === '/supplier') {
        const o = find(query.get('org'));
        return o ? [200, fiche(o)] : [409, { error: 'not_allowed' }];
      }
      if (path === '/stock') {
        return [200, orgs.filter((o) => lots.some((l) => l.org_id === o.org_id)).map((o) => ({
          org_id: o.org_id, name: o.name, alias: o.alias, status: o.status, currency: o.currency, lines: lines(o.org_id),
          sources: [...new Set(lots.filter((l) => l.org_id === o.org_id).map((l) => l.source))],
          last_import_at: o.import?.received_at || null, last_import_file: o.import?.file_name || null,
        })).sort((a, b) => String(b.last_import_at).localeCompare(String(a.last_import_at)))];
      }
      if (path === '/requests') {
        const s = query.has('status') ? query.get('status') : 'pending_validation';
        const counts = {};
        for (const r of requests) counts[r.status] = (counts[r.status] || 0) + 1;
        return [200, { counts, rows: requests.filter((r) => !s || r.status === s) }];
      }
      if (path === '/rfq') {
        const s = query.has('status') ? query.get('status') : 'pending_validation';
        return [200, rfqs.filter((d) => !s || d.status === s)];
      }
      if (path === '/supplier-profile') {
        const o = find(query.get('org'));
        return o ? [200, profile(o)] : [409, { error: 'not_allowed' }];
      }
      if (path === '/manufacturers') return [200, state.mfrs.map(mjson)];
      if (path === '/manufacturer') { const m = mfind(query.get('id')); return m ? [200, mjson(m)] : [409, { error: 'not_allowed' }]; }
      if (path === '/supplier-addresses') {
        return [200, query.get('org') === 'ORG-0110' ? [
          { id: 'ADR-0001', label: 'Entrepôt Shenzhen (fictif)', address: 'Futian, bâtiment 1', postal_code: '518000', city: 'Shenzhen', country: 'CN', contact: '李先生', phone: null, is_default: true, lots: 10 },
          { id: 'ADR-0002', label: 'Entrepôt Hong Kong (fictif)', address: 'Kwun Tong, unit 2', postal_code: null, city: 'Hong Kong', country: 'HK', contact: null, phone: null, is_default: false, lots: 0 }] : []];
      }
      if (path === '/lots') {
        const org = query.get('org'), q = (query.get('q') || '').toLowerCase(), off = Math.max(0, Number(query.get('offset')) || 0);
        const m = lots.filter((l) => (!org || l.org_id === org) &&
          (!q || l.mpn.toLowerCase().includes(q) || l.manufacturer.toLowerCase().includes(q) || (l.pack || '').toLowerCase().includes(q)
            || (l.description || '').toLowerCase().includes(q)))
          .sort((a, b) => a.seller.localeCompare(b.seller) || a.mpn.toUpperCase().localeCompare(b.mpn.toUpperCase()));
        return [200, { total: m.length, rows: m.slice(off, off + 50) }];
      }
    }
    if (method === 'POST' && (path === '/requests/approve' || path === '/requests/reject')) {
      const r = requests.find((x) => x.ref === String(body.ref || '').trim().toUpperCase());
      if (!/^PR-\d{1,8}$/i.test(String(body.ref || '').trim())) return [422, { error: 'ref' }];
      const why = String(body.reason || '').trim();
      if (path === '/requests/reject' && !why) return [422, { error: 'reason_required' }];
      if (!r) return [409, { error: 'not_allowed' }];
      if (r.status !== 'pending_validation') return [409, { error: 'already_decided' }];
      Object.assign(r, { decided_at: new Date().toISOString(), decided_by: 'admin:' + ADMIN_EMAIL });
      if (path === '/requests/reject') {
        Object.assign(r, { status: 'rejected', reject_reason: why });
        return [200, { ...r, supplier_view: null }];
      }
      r.status = 'submitted';
      state.notified.push({ org: r.seller_id, kind: 'request', ref: r.ref });
      return [200, { ...r, notified: 1 }];
    }
    if (method === 'POST' && (path === '/rfq/approve' || path === '/rfq/reject')) {
      const d = rfqs.find((x) => x.id === String(body.id || '').trim().toUpperCase());
      if (!/^DEM-\d{1,8}$/i.test(String(body.id || '').trim())) return [422, { error: 'id' }];
      const why = String(body.reason || '').trim();
      if (path === '/rfq/reject' && !why) return [422, { error: 'reason_required' }];
      if (!d) return [409, { error: 'not_allowed' }];
      if (d.status !== 'pending_validation') return [409, { error: 'already_decided' }];
      if (path === '/rfq/reject') {
        Object.assign(d, { status: 'rejected', rejected_reason: why });
        return [200, d];
      }
      Object.assign(d, { status: 'auction', validated_by: 'admin:' + ADMIN_EMAIL,
        sellers: (d.candidates || []).map((o) => ({ org: o, notify: 'sent', response: 'pending' })) });
      delete d.candidates;
      state.notified.push({ org: (d.sellers[0] || {}).org, kind: 'rfq', ref: d.id });
      return [200, { ...d, dispatch: { sent: d.sellers.length } }];
    }
    if (method === 'POST' && (path.startsWith('/manufacturer') || path === '/logo-upload-url')) {
      if (path === '/manufacturer') {
        const f = body.manufacturer || {};
        if (f.website && !/^https?:\/\//.test(f.website)) return bad('Site web : adresse http(s) attendue');
        if ('brands' in f && state.mfrs.some((m) => m.id !== body.id && m.brands.some((b) => f.brands.map((x) => x.toUpperCase()).includes(b.toUpperCase()))))
          return bad('Marque déjà attribuée à un autre fabricant');
        let m = body.id ? mfind(body.id) : null;
        if (body.id && !m) return [409, { error: 'not_allowed' }];
        if (!m) {
          if (!String(f.name || '').trim()) return bad('Valeur invalide : nom obligatoire');
          m = { id: 'MFR-' + String(state.mfrs.length + 1).padStart(4, '0'), name: '', brands: [], about: {}, positioning: {}, certifications: [], languages: [],
            logo_path: null, public_page: false, links: [] };
          state.mfrs.push(m);
        }
        for (const k of ['founded_year', 'area_m2', 'staff', 'annual_units', 'revenue_usd']) if (k in f) m[k] = f[k] === '' ? null : Number(f[k]);
        for (const k of ['name', 'website', 'hq_city', 'production_site', 'logo_path']) if (k in f) m[k] = f[k] || null;
        for (const k of ['brands', 'certifications', 'languages']) if (k in f) m[k] = [...new Set(f[k])];
        for (const k of ['about', 'positioning']) if (k in f) m[k] = tri(f[k]);
        return [200, mjson(m)];
      }
      if (path === '/manufacturer/proposal') {
        const pm = state.mfrs.find((x) => (x.proposals || []).some((r) => r.id === body.proposal && r.status === 'pending'));
        if (!pm) return [409, { error: 'not_allowed' }];
        const r = pm.proposals.find((x) => x.id === body.proposal);
        if (body.apply) for (const [k, v] of Object.entries(r.proposed)) pm[k] = (k === 'about' || k === 'positioning') ? { ...pm[k], ...v } : v;
        r.status = body.apply ? 'applied' : 'dismissed';
        return [200, mjson(pm)];
      }
      const m = mfind(body.id);
      if (!m) return [422, { error: 'id' }];
      if (path === '/manufacturer/consent') {
        const d = m.links.find((x) => x.org_id === body.org);
        if (!d) return [409, { error: 'not_allowed' }];
        Object.assign(d, body.on ? { consent_at: new Date().toISOString(), consent_by: 'admin:' + ADMIN_EMAIL + ' (hors plateforme)' } : { consent_at: null, consent_by: null });
        if (!m.links.some((x) => x.consent_at)) m.public_page = false;
        return [200, mjson(m)];
      }
      if (path === '/manufacturer/link') {
        const o = find(body.org);
        if (!o) return [409, { error: 'not_allowed' }];
        if (!['Manufacturer', 'Distributor'].includes(o.profile)) return bad('Seul un fabricant ou un distributeur peut être rattaché (pas un revendeur, broker ou excédent)');
        if (!['self', 'authorized'].includes(body.role)) return bad('Rôle : self ou authorized');
        const i = m.links.findIndex((d) => d.org_id === o.org_id);
        if (i >= 0) m.links[i].role = body.role; else m.links.push({ org_id: o.org_id, role: body.role });
        return [200, mjson(m)];
      }
      if (path === '/manufacturer/unlink') { m.links = m.links.filter((d) => d.org_id !== body.org); return [200, mjson(m)]; }
      if (path === '/manufacturer/publish') {
        if (body.on && !mjson(m).can_publish) return bad('Page publique : marque, présentation et accord requis');
        Object.assign(m, { public_page: !!body.on, public_page_by: 'admin:' + ADMIN_EMAIL, public_page_at: new Date().toISOString() });
        return [200, mjson(m)];
      }
      if (path === '/logo-upload-url') {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(body.type)) return [422, { error: 'format' }];
        const key = `${m.id}/logo-1.png`;
        return [200, { signed_url: '/storage/v1/object/upload/sign/seller-logos/' + key, path: key }];
      }
    }
    if (method === 'POST') {
      const o = find(body.org);
      if (!o) return [409, { error: 'not_allowed' }];
      if (path === '/supplier-profile') {
        const p = profile(o), f = body.profile || {};
        if (f.website && !/^https?:\/\//.test(f.website)) return [422, { error: 'invalid', detail: 'Site web : adresse http(s) attendue' }];
        for (const k of ['founded_year', 'area_m2', 'staff', 'annual_units', 'revenue_usd', 'min_order_usd']) if (k in f) p[k] = f[k] === '' ? null : Number(f[k]);
        for (const k of ['website', 'hq_city', 'production_site', 'payment_terms']) if (k in f) p[k] = f[k] || null;
        for (const k of ['certifications', 'languages', 'payment_methods']) if (k in f) p[k] = [...new Set(f[k])];
        for (const k of ['about', 'positioning']) if (k in f) p[k] = tri(f[k]);
        return [200, profile(o)];
      }
      if (path === '/supplier-contact') {
        const p = profile(o), c = body.contact || {};
        if (!String(c.name || '').trim() || (c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email))) return [422, { error: 'invalid', detail: 'Contact invalide : nom obligatoire, e-mail au bon format' }];
        const row = { ...c, email: c.email ? c.email.toLowerCase() : null, id: c.id || 'CTC-' + String(++contactSeq).padStart(4, '0') };
        const i = p.contacts.findIndex((x) => x.id === row.id);
        if (i >= 0) p.contacts[i] = row; else p.contacts.push(row);
        return [200, profile(o)];
      }
      if (path === '/supplier-editor') {
        const c = (o.contacts || []).find((x) => x.openid === body.openid);
        if (!c) return [409, { error: 'not_allowed' }];
        c.role = 'admin';
        profile(o).profile_editor = c.openid;
        return [200, profile(o)];
      }
      if (path === '/supplier-contact/delete') {
        const p = profile(o);
        p.contacts = p.contacts.filter((x) => x.id !== body.id);
        return [200, profile(o)];
      }
      if (path === '/approve') {
        if (o.status !== 'validated') {
          if (!/^V-\d+$/.test(o.alias)) o.alias = 'V-' + (Math.max(...orgs.map((x) => +(/^V-(\d+)$/.exec(x.alias) || [0, 0])[1])) + 1);
          decide(o, 'approved'); o.status = 'validated'; o.rejected_reason = null; o.decided_at = new Date().toISOString();
        }
        state.notified.push({ org: o.org_id, kind: 'approved' });
        return [200, { org_id: o.org_id, status: 'validated', alias: o.alias }];
      }
      if (path === '/reject') {
        const why = String(body.reason || '').trim();
        if (!why) return [422, { error: 'reason_required' }];
        if (o.status === 'validated') return [409, { error: 'not_allowed' }];
        decide(o, 'rejected', why); o.status = 'rejected'; o.rejected_reason = why; o.decided_at = new Date().toISOString();
        state.notified.push({ org: o.org_id, kind: 'rejected', reason: why });
        return [200, { org_id: o.org_id, status: 'rejected' }];
      }
      if (path === '/depot-link') {
        // Comme admin_depot_link : fournisseur approuvé seulement, lien de 8 heures inscrit au journal.
        if (o.status !== 'validated') return [409, { error: 'not_allowed' }];
        const expires_at = new Date(Date.now() + 8 * 3600e3).toISOString();
        (state.depotLinks ||= []).push({ org: o.org_id, expires_at });
        return [200, { url: 'https://central.parts/depot/lien/#k=' + 'd'.repeat(48), expires_at }];
      }
      if (path === '/pending') {
        if (o.status === 'pending') return [409, { error: 'already_pending' }];
        decide(o, 'pending', String(body.reason || '').trim()); o.status = 'pending'; o.rejected_reason = null; o.decided_at = new Date().toISOString();
        return [200, { org_id: o.org_id, status: 'pending' }];
      }
    }
    return [404, { error: 'not_found' }];
  }
  return { state, handle };
}
