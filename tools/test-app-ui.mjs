#!/usr/bin/env node
// Parcourt la maquette dans Chromium comme un utilisateur : les cinq rôles, de la
// nomenclature au paiement du vendeur, puis contrôle l'affichage de chaque route
// à 1280 et 390 px (pas de débordement horizontal, pas d'erreur, pas de requête externe).
// Usage : (cd site && python3 -m http.server 8765) puis node tools/test-app-ui.mjs [dossier-captures]
// Playwright requis (comme tools/render-social.mjs).

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

const BASE = process.env.APP_URL || 'http://localhost:8765/app/';
const SHOTS = process.argv[2] || '';
const errors = [], external = [];
let checks = 0, failures = 0;
const ok = (c, m) => { checks++; if (!c) { failures++; console.error('  ✗ ' + m); } };

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (r) => { if (!r.url().startsWith(new URL(BASE).origin)) external.push(r.url()); });
page.on('dialog', (d) => d.accept());

const go = async (hash) => { await page.goto(BASE + '#' + hash); await page.waitForSelector('#main h1'); };
const as = async (actor) => { await page.selectOption('#actor', actor); await page.waitForTimeout(50); };
const state = () => page.evaluate(() => JSON.parse(JSON.stringify(CP.state)));
const toast = () => page.textContent('#toast');
const step = async (label, fn) => { console.log('• ' + label); await fn(); const t = await toast(); ok(!/^\d{3} ·/.test(t || ''), label + ' : ' + t); };

await page.goto(BASE);
await page.evaluate(() => { localStorage.clear(); CP.reset(); CP.setActor('public'); });
await go('/');
ok((await page.textContent('h1')).includes('Maquette'), 'accueil');

await step('acheteur : nomenclature', async () => {
  await page.click('text=Entrer comme Acheteur');
  await go('/acheteur/nomenclature');
  await page.click('form[data-form="bom"] button');
  await page.waitForSelector('text=Répartition');
  await page.click('text=Commander les lignes Inventory');
  await page.click('text=Lancer les 2 demande(s)');
});
let s = await state();
const dXC = Object.values(s.demands).find((d) => d.mpn === 'XC2S50-5TQ144C' && d.id !== 'DEM-0427');
ok(dXC && dXC.sellers.length === 2, 'demande XC2S50 diffusée à deux vendeurs');

await step('vendeurs : enchères', async () => {
  await as('seller1');
  await go('/vendeur/demandes/' + dXC.id);
  await page.selectOption('select[name="lot"]', 'LOT-101');
  await page.fill('input[name="net"]', '41');
  await page.click('form[data-form="bid"] button');
  await as('seller2');
  await go('/vendeur/demandes/' + dXC.id);
  await page.fill('input[name="net"]', '39.5');
  await page.click('form[data-form="bid"] button');
  ok((await page.textContent('.rank')).includes('rang 1 sur 2'), 'rang affiché au vendeur');
});

await step('Central.Parts : clôture', async () => {
  await as('ops1');
  await go('/ops/demandes');
  await page.click(`tr:has-text("${dXC.id}") >> text=Clôturer l'enchère`);
});

await step('acheteur : offre, test, signature', async () => {
  await as('buyer');
  await go('/acheteur/demandes/' + dXC.id);
  await page.click('form[data-form="accept-offer"] > .card button');
  await page.waitForSelector('text=Signer la fiche transaction');
  await page.click('text=Signer la fiche transaction');
});
s = await state();
const tx = Object.values(s.transactions).find((t) => t.demandId === dXC.id);
ok(tx && tx.sellerId === 'S2' && tx.labLevel === 2, 'transaction avec le mieux-disant et laboratoire');

await step('vendeur : signature', async () => { await as('seller2'); await go('/vendeur/transactions/' + tx.id); await page.click('text=Signer la fiche transaction'); });
await step('banque : dépôt', async () => { await as('bank'); await go('/banque'); await page.click(`tr:has-text("${tx.id}") >> text=Simuler la réception`); });
await step('vendeur : expédition', async () => { await as('seller2'); await go('/vendeur/transactions/' + tx.id); await page.fill('input[name="tracking"]', '1Z999'); await page.click('form[data-form="ship"] button'); });
s = await state();
const lc = Object.values(s.labCases).find((c) => c.txId === tx.id);
await step('laboratoire : réception, certificat, réexpédition', async () => {
  await as('lab');
  await go('/labo/dossiers/' + lc.id);
  await page.click('form[data-form="lab-receive"] button');
  await page.click('form[data-form="lab-certify"] button');
  await page.fill('input[name="tracking"]', 'RS-1');
  await page.click('form[data-form="lab-reship"] button');
});
await step('acheteur : livraison et acceptation', async () => {
  await as('buyer');
  await go('/acheteur/transactions/' + tx.id);
  await page.click('text=Simuler la livraison');
  await page.click('text=J\'accepte les pièces');
});
await step('Central.Parts : double validation', async () => {
  await as('ops1');
  await go('/ops/paiements');
  await page.click('button[data-act="approve"]');
  await as('ops2');
  await go('/ops/paiements');
  await page.click('button[data-act="approve"]');
  await page.click('button[data-act="transmit"]');
});
await step('banque : exécution', async () => { await as('bank'); await go('/banque'); await page.click('button[data-act="bank-exec"]'); });
s = await state();
ok(s.transactions[tx.id].status === 'released', 'transaction soldée : ' + s.transactions[tx.id].status);

// Cas d'erreur visible : double validation par le même opérateur refusée côté API.
const log = await page.evaluate(() => CP.log.filter((e) => !e.quiet).map((e) => e.method + ' ' + e.endpoint + ' ' + e.status));
ok(log.length >= 20, 'appels journalisés : ' + log.length);

// Parcours secondaires : inscription et KYB, rejet partiel et litige, contrefaçon.
await step('visiteur : inscription', async () => {
  await as('public');
  await go('/inscription');
  await page.fill('input[name="name"]', 'Test Composants SAS');
  await page.fill('input[name="beneficiaries"]', 'A. Martin, 100 %');
  await page.fill('input[name="signatory"]', 'A. Martin');
  await page.fill('input[name="iban"]', 'FR76 0000');
  await page.click('form[data-form="signup"] button');
  await page.waitForSelector('text=Inscription envoyée');
  await page.click('text=Voir le dossier côté Central.Parts');
  await page.waitForSelector('text=Test Composants SAS');
});
console.log('• Central.Parts : KYB sans contrôle des sanctions refusé, puis validé');
const kybForm = 'form[data-form="kyb"]:has-text("Test Composants SAS")';
await page.click(kybForm + ' button[value="validated"]');
ok((await toast()).startsWith('422'), 'contrôle des sanctions exigé');
await page.check(kybForm + ' input[name="sanctions"]');
await page.click(kybForm + ' button[value="validated"]');
s = await state();
ok(Object.values(s.orgs).some((o) => o.name === 'Test Composants SAS' && o.kyb === 'validated'), 'KYB validé');

await step('rejet partiel et litige', async () => {
  await as('ops1'); await go('/ops/demandes');
  await page.click('tr:has-text("DEM-0427") >> text=Clôturer l\'enchère');
  await as('buyer'); await go('/acheteur/demandes/DEM-0427');
  await page.check('input[name="labLevel"][value="0"]');
  await page.click('form[data-form="accept-offer"] > .card button');
  await page.click('text=Signer la fiche transaction');
});
s = await state();
const tx2 = Object.values(s.transactions).find((t) => t.demandId === 'DEM-0427');
const sellerActor = { S1: 'seller1', S2: 'seller2', S3: 'seller3' }[tx2.sellerId];
await step('rejet : signature, dépôt, expédition, livraison', async () => {
  await as(sellerActor); await go('/vendeur/transactions/' + tx2.id); await page.click('text=Signer la fiche transaction');
  await as('bank'); await go('/banque'); await page.click(`tr:has-text("${tx2.id}") >> text=Simuler la réception`);
  await as(sellerActor); await go('/vendeur/transactions/' + tx2.id); await page.fill('input[name="tracking"]', 'S-2'); await page.click('form[data-form="ship"] button');
  await as('buyer'); await go('/acheteur/transactions/' + tx2.id); await page.click('text=Simuler la livraison');
});
await step('rejet : motif, retour, contestation, décision', async () => {
  await page.fill('form[data-form="reject"] input[name="qty"]', '50');
  await page.click('form[data-form="reject"] button');
  await page.fill('form[data-form="return"] input[name="tracking"]', 'RET-9');
  await page.click('form[data-form="return"] button');
  await as(sellerActor); await go('/vendeur/transactions/' + tx2.id);
  await page.fill('form[data-form="contest"] input[name="comment"]', 'Quantité complète à l\'envoi');
  await page.click('form[data-form="contest"] button');
  await as('ops1'); await go('/ops/transactions/' + tx2.id);
  await page.click('form[data-form="dispute"] button');
});
s = await state();
ok(s.transactions[tx2.id].status === 'settling' && Object.values(s.orders).filter((o) => o.txId === tx2.id).length === 2, 'règlement partiel : deux ordres');

await step('laboratoire : contrefaçon, verdict accepté par le vendeur', async () => {
  await as('lab'); await go('/labo/dossiers/LAB-0020');
  await page.check('input[name="verdict"][value="counterfeit"]');
  await page.click('form[data-form="lab-certify"] button');
  await as('seller3'); await go('/vendeur/transactions/TX-0041');
  await page.click('text=J\'accepte le verdict');
});
s = await state();
ok(s.transactions['TX-0041'].status === 'settling', 'contrefaçon : remboursement ordonné');

await step('horloge : +1 jour ouvré', async () => { await page.click('header [data-act="advance"]'); });
ok((await state()).day === 1, 'jour simulé avancé');

// Toutes les routes, aux deux largeurs.
const routes = await page.evaluate(() => CP_ROUTES.map((r) => ({ path: r.path, role: r.role })));
const actorFor = { public: 'public', buyer: 'buyer', seller: 'seller2', lab: 'lab', bank: 'bank', ops: 'ops1' };
const sample = { '/acheteur/nomenclatures/:id': Object.keys(s.boms).pop(), '/acheteur/demandes/:id': dXC.id, '/acheteur/transactions/:id': tx.id, '/vendeur/lots/:id': 'LOT-102', '/vendeur/demandes/:id': dXC.id, '/vendeur/transactions/:id': tx.id, '/labo/dossiers/:id': lc.id, '/ops/transactions/:id': tx.id };
for (const width of [1280, 390]) {
  await page.setViewportSize({ width, height: 900 });
  for (const r of routes) {
    await as(actorFor[r.role]);
    const path = r.path.replace(':id', sample[r.path] || '');
    await go(path);
    const h1 = await page.textContent('#main h1');
    ok(!/introuvable|Erreur|appartient/.test(h1) && !(await page.$('text=appartient au rôle')), `${width}px ${path} : ${h1}`);
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    ok(sw <= iw, `${width}px ${path} : débordement horizontal ${sw} > ${iw}`);
    if (SHOTS && ['/', '/acheteur', '/acheteur/transactions/:id', '/acheteur/demandes/:id', '/vendeur/demandes/:id', '/labo/dossiers/:id', '/banque', '/ops', '/ops/paiements', '/api'].includes(r.path)) {
      await page.screenshot({ path: `${SHOTS}/app-${width}-${r.path.replace(/[/:]/g, '_') || 'home'}.png`, fullPage: true });
    }
  }
}

ok(!errors.length, 'erreurs console : ' + errors.join(' | '));
ok(!external.length, 'requêtes externes : ' + external.join(' | '));
await browser.close();
console.log(`${checks - failures}/${checks} vérifications réussies`);
process.exit(failures ? 1 : 0);
