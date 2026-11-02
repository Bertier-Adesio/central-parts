// Parcours du back office (site/admin/) dans Chromium, avec la fonction « admin » simulée (tools/admin-mock.mjs) :
// connexion, accès refusé à un non-administrateur, fiches Chine continentale (18 caractères) et Hong Kong
// (15 caractères), refus sans motif impossible, approbation, refus motivé, remise en attente, journal d'audit,
// stocks en lecture seule (1 812 références, paliers propres à chaque référence), affichage à 390 px.
// Usage : (cd site && python3 -m http.server 8765) & node tools/test-admin-ui.mjs
import { createMock, ADMIN_EMAIL } from './admin-mock.mjs';
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };

let mock = createMock();
async function api(route) {
  const req = route.request(), url = new URL(req.url());
  const token = (req.headers().authorization || '').replace(/^Bearer\s+/i, '');
  const [status, data] = mock.handle(req.method(), url.pathname.replace('/functions/v1/admin', '') || '/', url.searchParams,
    req.postData() ? JSON.parse(req.postData()) : {}, token);
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
}

const browser = await chromium.launch();
async function open(viewport) {
  const page = await browser.newPage({ viewport, locale: 'fr-FR' });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|403|409|422)/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(BASE + '/functions/v1/admin/**', api);
  await page.route(/^(?!http:\/\/localhost)/, (r) => { errors.push('requête externe : ' + r.request().url()); return r.abort(); });
  return { page, errors };
}
// Le format français sépare les milliers par une espace fine insécable : ramenée à une espace simple.
const norm = (t) => (t || '').replace(/[\u202f\u00a0]/g, ' ');
const calls = (p) => mock.state.calls.filter((c) => c === p).length;

// 1. Sans session : écran de connexion, demande du lien.
let { page, errors } = await open({ width: 1280, height: 900 });
await page.goto(BASE + '/admin/');
await page.waitForSelector('#v-login:not([hidden])');
ok(await page.getAttribute('meta[name=robots]', 'content') === 'noindex, nofollow', 'page non indexée (noindex)');
ok(!(await page.isVisible('#v-app')), 'sans session : aucune donnée affichée');
await page.fill('#login-email', ADMIN_EMAIL);
await page.click('#login-send');
await page.waitForSelector('#msg.ok');
ok(mock.state.logins[0] === ADMIN_EMAIL, 'lien de connexion demandé pour l\'adresse saisie');

// 2. Compte connecté mais pas administrateur : accès refusé, aucune donnée.
await page.goto('about:blank');
await page.goto(BASE + '/admin/#access_token=DEMO-OTHER&expires_in=3600');
await page.waitForSelector('#v-denied:not([hidden])');
ok(new URL(page.url()).hash === '', 'jeton retiré de l\'adresse');
ok(calls('GET /suppliers') === 0 && !(await page.isVisible('#v-app')), 'non-administrateur : accès refusé, aucune liste chargée');
await page.click('#denied-logout');
await page.waitForSelector('#v-login:not([hidden])');

// 3. Administrateur : liste des sociétés en attente, la plus récente d'abord.
await page.goto('about:blank');
await page.goto(BASE + '/admin/#access_token=DEMO-ADMIN&expires_in=3600');
await page.waitForSelector('#v-app:not([hidden]) #sup-list button[data-org]');
ok(norm(await page.textContent('#who-email')) === ADMIN_EMAIL, 'administrateur connecté affiché');
const order = await page.$$eval('#sup-list button[data-org]', (b) => b.map((x) => x.dataset.org));
ok(order.join(',') === 'ORG-0112,ORG-0108,ORG-0107', 'en attente : tri par date de demande, la plus récente d\'abord');
ok(norm(await page.textContent('[data-c=pending]')) === '(3)' && norm(await page.textContent('[data-c=rejected]')) === '(1)', 'compteurs par statut');
await page.click('#filters button[data-s=rejected]');
await page.waitForFunction(() => document.querySelectorAll('#sup-list button[data-org]').length === 1);
ok(norm(await page.textContent('#sup-list')).includes('上海样例贸易有限公司'), 'filtre « refusés » ; libellé chinois affiché');
await page.click('#filters button[data-s=pending]');
await page.waitForFunction(() => document.querySelectorAll('#sup-list button[data-org]').length === 3);

// 4. Fiche Hong Kong : libellé et numéro de 15 caractères ; fiche Chine continentale : 18 caractères.
await page.click('button[data-org="ORG-0108"]');
await page.waitForSelector('#d-org:text("ORG-0108")');
ok(norm(await page.textContent('#d-region')) === 'Hong Kong', 'Hong Kong : pays / région');
ok(norm(await page.textContent('#d-code-l')) === 'Registration no. (Hong Kong)', 'Hong Kong : libellé « Registration no. (Hong Kong) »');
ok(norm(await page.textContent('#d-code')) === '71234567-000-11' && norm(await page.textContent('#d-code')).length === 15, 'Hong Kong : numéro de 15 caractères complet');
ok(norm(await page.textContent('#d-name')).includes('香港測試元件有限公司') && !norm(await page.textContent('#sup-detail')).includes('�'), 'nom chinois (traditionnel) sans caractère cassé');
await page.click('button[data-org="ORG-0107"]');
await page.waitForSelector('#d-org:text("ORG-0107")');
ok(norm(await page.textContent('#d-region')) === 'Chine continentale', 'Chine : pays / région');
ok(norm(await page.textContent('#d-code-l')) === 'Credit code (Mainland China)', 'Chine : libellé « Credit code (Mainland China) »');
ok(norm(await page.textContent('#d-code')) === '91350100M000100Y43' && norm(await page.textContent('#d-code')).length === 18, 'Chine : numéro de 18 caractères complet');
const fiche = norm(await page.textContent('#sup-detail'));
ok(['深圳', 'Distributeur', 'CNH', '王经理', 'oFICTIF0107', 'heure de Paris', 'Déposée'].every((t) => fiche.includes(t)), 'fiche : ville, type, devise, contact, WeChat, date, licence');
ok(norm(await page.textContent('#d-log')).includes('Aucune décision'), 'journal vide avant toute décision');

// 5. Refus sans motif impossible ; annulation sans effet.
await page.click('#d-actions button[data-act=reject]');
await page.waitForSelector('#confirm[open]');
await page.click('#c-ok');
ok(await page.isVisible('#c-err') && norm(await page.textContent('#c-err')).includes('obligatoire'), 'refus sans motif : message « obligatoire »');
await page.fill('#c-reason', '    ');
await page.click('#c-ok');
ok(calls('POST /reject') === 0, 'refus sans motif (ou motif blanc) : aucun appel au serveur');
await page.click('#c-cancel');
ok(!(await page.isVisible('#confirm')) && norm(await page.textContent('#d-status')) === 'En attente', 'annulation : statut inchangé');

// 6. Approbation avec confirmation explicite.
await page.click('#d-actions button[data-act=approve]');
await page.waitForSelector('#confirm[open]');
ok(norm(await page.textContent('#c-title')).includes('ORG-0107') && !(await page.isVisible('#c-reason')), 'confirmation d\'approbation, sans motif');
ok(calls('POST /approve') === 0, 'rien n\'est envoyé avant la confirmation');
await page.click('#c-ok');
await page.waitForSelector('#d-status:text("Approuvée")');
ok(calls('POST /approve') === 1, 'approbation envoyée une fois');
ok(norm(await page.textContent('#d-log li')).includes('Approuvée') && norm(await page.textContent('#d-log li')).includes(ADMIN_EMAIL), 'journal : approbation, auteur');
ok(norm(await page.textContent('#d-org')).includes('V-7'), 'pseudonyme V-n attribué');
ok(mock.state.notified.at(-1)?.kind === 'approved', 'fournisseur prévenu comme avec le robot');
ok(!(await page.isVisible('#d-actions button[data-act=reject]')), 'société approuvée : pas de refus direct (remise en attente d\'abord)');

// 7. Remise en attente (motif facultatif, aucun message), puis journal à deux entrées.
const sent = mock.state.notified.length;
await page.click('#d-actions button[data-act=pending]');
await page.fill('#c-reason', 'Licence à revoir');
await page.click('#c-ok');
await page.waitForSelector('#d-status:text("En attente")');
ok(mock.state.notified.length === sent, 'remise en attente : aucun message au fournisseur');
const log = await page.$$eval('#d-log li', (l) => l.map((x) => x.textContent));
ok(log.length === 2 && log[0].includes('Remise en attente') && log[0].includes('Licence à revoir') && log[1].includes('Approuvée'), 'journal : deux décisions, la plus récente d\'abord, avec le motif');

// 8. Refus motivé de la société de Hong Kong.
await page.click('button[data-org="ORG-0108"]');
await page.waitForSelector('#d-org:text("ORG-0108")');
await page.click('#d-actions button[data-act=reject]');
await page.fill('#c-reason', 'Numéro d\'immatriculation à vérifier');
await page.click('#c-ok');
await page.waitForSelector('#d-status:text("Refusée")');
ok(norm(await page.textContent('#d-reason')) === 'Numéro d\'immatriculation à vérifier', 'refus : motif affiché dans la fiche');
ok(norm(await page.textContent('#d-log li')).includes('Motif : Numéro d\'immatriculation à vérifier'), 'journal : refus et motif');
ok(mock.state.notified.at(-1)?.reason === 'Numéro d\'immatriculation à vérifier', 'refus : motif transmis au fournisseur comme avec le robot');
ok(!(await page.$$eval('#sup-list button[data-org]', (b) => b.map((x) => x.dataset.org))).includes('ORG-0108'), 'liste « en attente » mise à jour');

// 8 bis. Devise du dernier import et sa provenance (migration 20261102000017).
await page.click('#filters button[data-s=validated]');
await page.waitForSelector('button[data-org="ORG-0110"]');
await page.click('button[data-org="ORG-0110"]');
await page.waitForSelector('#d-org:text("ORG-0110")');
ok(norm(await page.textContent('#d-cur')) === 'USD (lue dans le fichier, 8 lignes) · USD (choisie au dépôt, 2 lignes)', 'fiche : devise du dernier import et provenance');

// 9. Stocks et offres : résumé, 1 812 références paginées, recherche, paliers ; aucune action d'écriture.
await page.click('#tab-stock');
await page.waitForSelector('#stock-sum tr[data-org]');
const sum = norm(await page.textContent('#stock-sum'));
ok(sum.includes('1 812') && sum.includes('库存表-2026-10-31.xlsx') && sum.includes('demo-9-novembre.csv'), 'résumé : nombre de références et dernier import');
await page.click('#stock-sum tr[data-org="ORG-0111"]');
await page.waitForFunction(() => document.getElementById('lot-count').textContent.replace(/[\u202f\u00a0]/g, ' ').includes('1 812'));
ok(norm(await page.textContent('#lot-count')).includes('1 à 50 sur 1 812') && (await page.$$('#lot-list > tr')).length === 50, 'fichier de 1 812 références : 50 par page');
await page.click('#lot-next');
await page.waitForFunction(() => document.getElementById('lot-count').textContent.replace(/[\u202f\u00a0]/g, ' ').includes('51 à 100'));
ok(true, 'page suivante');
const nTiers = await page.$$eval('#lot-list > tr', (r) => r.slice(0, 5).map((x) => x.querySelectorAll('table.breaks tr').length));
ok(new Set(nTiers).size > 1, 'paliers propres à chaque référence (nombre de paliers variable)');
await page.selectOption('#lot-org', 'ORG-0110');
await page.waitForFunction(() => document.getElementById('lot-count').textContent.replace(/[\u202f\u00a0]/g, ' ').includes('sur 10'));
ok(norm(await page.textContent('#lot-list')).includes('STM32G071RBT6'), 'démonstration du 9 novembre : 10 références');
await page.fill('#lot-q', 'sot-223');
await page.click('#lot-form button[type=submit]');
await page.waitForFunction(() => / sur 1\.$/.test(document.getElementById('lot-count').textContent.replace(/[\u202f\u00a0]/g, ' ')));
const row = norm(await page.textContent('#lot-list tr'));
ok(row.includes('AMS1117-3.3') && row.includes('SOT-223') && row.includes('150 000') && row.includes('5 j'), 'recherche par boîtier : référence, stock, délai');
ok(/1 à 49/.test(row) && /2 000 et plus/.test(row), 'paliers « de … à … » et dernier palier « et plus »');
// Lien du vendeur, fiche technique et description (ADR 0022) ; un lien qui n'est pas http(s) n'est jamais cliquable.
await page.fill('#lot-q', 'cortex');
await page.click('#lot-form button[type=submit]');
await page.waitForFunction(() => document.getElementById('lot-list').textContent.includes('STM32G071RBT6'));
const st = await page.$('#lot-list tr');
ok((await st.textContent()).includes('Microcontrôleur Arm Cortex-M0+'), 'description affichée et cherchable');
ok(await st.$eval('a[href="https://fabricant.example/ds/STM32G071RBT6.pdf"]', (a) => a.target === '_blank' && a.rel.includes('noreferrer')), 'fiche technique : lien externe, sans transmettre l\'adresse');
ok(await st.$('a[href="https://vendeur.example/p/STM32G071RBT6"]') !== null, 'page chez le vendeur : lien visible des administrateurs');
await page.fill('#lot-q', 'TPS62130');
await page.click('#lot-form button[type=submit]');
await page.waitForFunction(() => document.getElementById('lot-list').textContent.includes('TPS62130RGTR'));
ok((await page.$$('#lot-list a[href^="javascript"]')).length === 0, 'lien « javascript: » jamais rendu cliquable');
ok((await page.$$('#p-stock button[data-act], #p-stock input:not([type=search])')).length === 0, 'stocks : aucune action de modification');

ok(errors.length === 0, 'aucune erreur console ni requête externe (1280 px) : ' + errors.join(' | '));
await page.close();

// 10. Téléphone (390 px) : pas de défilement horizontal, fiche puis retour à la liste.
mock = createMock();
({ page, errors } = await open({ width: 390, height: 844 }));
await page.goto(BASE + '/admin/#access_token=DEMO-ADMIN&expires_in=3600');
await page.waitForSelector('#sup-list button[data-org]');
const wide = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
ok(await wide(), '390 px : liste sans défilement horizontal');
await page.click('button[data-org="ORG-0108"]');
await page.waitForSelector('#d-code-l:text("Registration no. (Hong Kong)")');
ok(!(await page.isVisible('#sup-list')) && (await page.isVisible('#back')), '390 px : fiche seule, bouton retour');
ok(await wide(), '390 px : fiche sans défilement horizontal');
await page.click('#back');
ok(await page.isVisible('#sup-list'), '390 px : retour à la liste');
await page.click('#tab-stock');
await page.waitForSelector('#lot-list tr');
ok(await wide(), '390 px : stocks sans défilement horizontal');
ok(errors.length === 0, 'aucune erreur console ni requête externe (390 px) : ' + errors.join(' | '));
await page.close();

// 11. Session expirée : retour à la connexion.
({ page, errors } = await open({ width: 1280, height: 900 }));
await page.goto(BASE + '/admin/#access_token=PERIME&expires_in=3600');
await page.waitForSelector('#v-login:not([hidden])');
ok(norm(await page.textContent('#msg')).includes('Session expirée'), 'jeton expiré : retour à la connexion');
await browser.close();

console.log(`${n - bad}/${n} contrôles du back office passés.`);
process.exit(bad ? 1 : 0);
