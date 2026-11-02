// Fonction « admin » simulée, pour la démonstration locale (tools/demo-admin.mjs) et le test Chromium
// (tools/test-admin-ui.mjs) du back office site/admin/. Mêmes routes, mêmes réponses et mêmes règles que
// supabase/functions/admin/index.ts et les fonctions SQL admin_* (migration 20261102000014). Données fictives.
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

  const state = { orgs, lots, notified: [], calls: [], logins: [] };
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
      if (path === '/lots') {
        const org = query.get('org'), q = (query.get('q') || '').toLowerCase(), off = Math.max(0, Number(query.get('offset')) || 0);
        const m = lots.filter((l) => (!org || l.org_id === org) &&
          (!q || l.mpn.toLowerCase().includes(q) || l.manufacturer.toLowerCase().includes(q) || (l.pack || '').toLowerCase().includes(q)
            || (l.description || '').toLowerCase().includes(q)))
          .sort((a, b) => a.seller.localeCompare(b.seller) || a.mpn.toUpperCase().localeCompare(b.mpn.toUpperCase()));
        return [200, { total: m.length, rows: m.slice(off, off + 50) }];
      }
    }
    if (method === 'POST') {
      const o = find(body.org);
      if (!o) return [409, { error: 'not_allowed' }];
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
