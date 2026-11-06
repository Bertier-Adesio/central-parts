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

// Stockage simulé (logos, ADR 0032) : dépôt par lien signé, lecture du logo déposé.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const uploads = [];
async function storage(route) {
  const req = route.request();
  if (req.method() === 'PUT') { uploads.push(new URL(req.url()).pathname); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); }
  return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
}

const browser = await chromium.launch();
async function open(viewport) {
  const page = await browser.newPage({ viewport, locale: 'fr-FR' });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|403|409|422)/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(BASE + '/functions/v1/admin/**', api);
  await page.route(BASE + '/storage/**', storage);
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
ok(!(await page.$('#d-depot')), 'fournisseur en attente : pas d\'accès à son dépôt');
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

// 8 ter. Accès au dépôt d'un fournisseur approuvé (ADR 0021, complément) : lien de 8 heures, ouvert dans un nouvel onglet.
await page.click('#d-depot');
await page.waitForSelector('#d-depot-link');
const depotHref = await page.getAttribute('#d-depot-link', 'href');
ok(/^https:\/\/central\.parts\/depot\/lien\/#k=[0-9a-f]{48}$/.test(depotHref) && await page.getAttribute('#d-depot-link', 'target') === '_blank'
  && (await page.getAttribute('#d-depot-link', 'rel')).includes('noopener'), 'dépôt : lien personnel ouvert dans un nouvel onglet');
ok(norm(await page.textContent('#d-depot-link')).includes('valable jusqu\'à') && mock.state.depotLinks?.length === 1 && mock.state.depotLinks[0].org === 'ORG-0110',
  'dépôt : lien demandé pour ce fournisseur, échéance affichée');

// 8 quater. Fiche société et contacts (ADR 0032) ; fabricants, distributeurs et page publique (migration 20261105000033).
await page.waitForSelector('#pf-view');
ok(norm(await page.textContent('#pf-mfrs')).includes('Aucun fabricant rattaché'), 'fiche société : aucun fabricant rattaché');
// Un seul responsable de la fiche dans /depot/ (migration 20261106000035), désigné ici.
ok(await page.inputValue('#pf-editor-i') === 'oFICTIF0110', 'responsable de la fiche : premier administrateur WeChat par défaut');
await page.click('#pf-editor button[type=submit]');
await page.waitForFunction(() => /Responsable de la fiche désigné/.test(document.getElementById('msg').textContent));
ok(calls('POST /supplier-editor') === 1, 'responsable de la fiche : désignation envoyée');
ok((await page.textContent('#pf-editor-st')).includes('Responsable de la fiche enregistré'), 'responsable de la fiche : confirmation affichée à côté du bouton');
await page.click('button[data-pf=edit]');
await page.fill('#pf-web', 'ftp://exemple');
await page.click('#pf-save');
await page.waitForSelector('#msg.err');
ok(norm(await page.textContent('#msg')).includes('Site web'), 'fiche : site web invalide refusé, message clair');
await page.fill('#pf-web', 'https://distributeur.example');
await page.fill('#pf-staff', '170');
await page.fill('#pf-rev', '1000000');
await page.fill('#pf-langs', 'zh, EN');
await page.fill('#pf-about-en', 'Fictitious distributor.');
await page.click('#pf-save');
await page.waitForSelector('#pf-view');
const pv = norm(await page.textContent('#pf-view'));
ok(pv.includes('1 000 000 USD') && pv.includes('中文, English') && pv.includes('Fictitious distributor.'), 'fiche société : chiffres, langues et présentation affichés');
await page.click('button[data-pf=cadd]');
await page.fill('#cf-name', 'Contact démo (fictif)');
await page.fill('#cf-email', 'pas-un-email');
await page.click('#pf-cf button[type=submit]');
ok(!(await page.evaluate(() => document.getElementById('cf-email').validity.valid)) && !(await page.$('#pf-contacts li')), 'contact : e-mail invalide bloqué avant envoi');
await page.fill('#cf-email', 'Ventes@Distributeur.Example');
await page.check('#cf-rfq');
await page.check('#cf-po');
await page.click('#pf-cf button[type=submit]');
await page.waitForSelector('#pf-contacts li');
const ctc = norm(await page.textContent('#pf-contacts'));
ok(ctc.includes('ventes@distributeur.example') && ctc.includes('RFQ') && ctc.includes('Commandes'), 'contact : ajouté, adresses préférées RFQ et commandes');

// Fabricants : création, logo, rattachement du distributeur agréé et du fabricant lui-même, publication.
await page.click('#tab-mfr');
await page.waitForSelector('#mfr-list li');
ok(norm(await page.textContent('#mfr-list')).includes('Aucun fabricant'), 'fabricants : liste vide au départ');
await page.click('#mfr-new');
await page.fill('#mf-name-i', 'Fabricant Démo (fictif)');
await page.fill('#mf-brands-i', 'Marque Démo, MD');
await page.fill('#mf-year', '2013');
await page.fill('#mf-units', '3000000000');
await page.fill('#mf-rev', '70000000');
await page.fill('#mf-cert', 'ISO 9001, IATF 16949');
await page.setInputFiles('#mf-logo-f', { name: 'logo.png', mimeType: 'image/png', buffer: PNG });
await page.click('#mf-save');
await page.waitForSelector('#mf-view');
const mv = norm(await page.textContent('#mf-view'));
ok(mv.includes('Marque Démo, MD') && mv.includes('3 000 000 000') && mv.includes('70 000 000 USD'), 'fabricant : créé, marques et chiffres affichés');
ok(uploads.some((u) => u.includes('/seller-logos/MFR-0001/')) && await page.getAttribute('#mf-logo', 'src') === BASE + '/storage/v1/object/public/seller-logos/MFR-0001/logo-1.png',
  'fabricant : logo déposé dans son dossier, affiché');
ok(await page.isDisabled('button[data-mf=publish]') && norm(await page.textContent('#mf-pub')).includes('il faut'), 'sans présentation : publication impossible');
const options = await page.$$eval('#ml-org option', (o) => o.map((x) => x.value));
ok(options.includes('ORG-0110') && options.includes('ORG-0111') && options.length === 2, 'rattachement : seulement les fabricants et distributeurs approuvés');
const openDet = (k) => page.$eval('#mfr-detail details[data-k="' + k + '"]', (d) => { d.open = true; });
await openDet('add');
await page.selectOption('#ml-org', 'ORG-0110');
await page.selectOption('#ml-role', 'authorized');
await page.click('#mf-link button[type=submit]');
await page.waitForFunction(() => document.querySelectorAll('#mf-dists li').length === 1);
await page.selectOption('#ml-org', 'ORG-0111');
await page.selectOption('#ml-role', 'self');
await page.click('#mf-link button[type=submit]');
await page.waitForFunction(() => document.querySelectorAll('#mf-dists li').length === 2);
ok((await page.$$('#mf-dists li')).length === 2 && (await page.$$('#ml-org option')).length === 0, 'deux comptes rattachés : distributeur agréé et direct fabricant');
// Rôle modifiable sans détacher (migration 20261105000034) : le distributeur passe en direct fabricant, puis revient.
await openDet('d-ORG-0110');
await page.selectOption('#mf-dists select[data-org="ORG-0110"]', 'self');
await page.waitForFunction(() => /Rôle modifié : Direct fabricant/.test(document.getElementById('msg').textContent));
ok(mock.state.mfrs[0].links.every((d) => d.role === 'self') && norm(await page.textContent('#msg')).includes('Rôle modifié'), 'rôle changé : deux comptes direct fabricant');
await page.selectOption('#mf-dists select[data-org="ORG-0110"]', 'authorized');
await page.waitForFunction(() => /Rôle modifié : Distributeur agréé/.test(document.getElementById('msg').textContent));
await page.click('button[data-mf=edit]');
await page.fill('#mf-about-en', 'Fictitious manufacturer of analog and discrete parts.');
await page.fill('#mf-about-zh', '虚构的制造商。');
await page.click('#mf-save');
await page.waitForSelector('#mf-view');
ok(norm(await page.textContent('#mf-view')).includes('虚构的制造商') && norm(await page.textContent('#mf-view')).includes('2013'), 'modification : présentation ajoutée, chiffres conservés');
// Publication : accord d'un compte rattaché requis (migration 20261106000035) ; correction proposée dans /depot/.
ok(await page.isDisabled('button[data-mf=publish]') && norm(await page.textContent('#mf-dists')).includes('accord en attente'), 'sans accord : publication impossible');
mock.state.mfrs[0].proposals = [{ id: 7, org_id: 'ORG-0111', at: new Date().toISOString(), status: 'pending', note: 'Merci de corriger.',
  proposed: { staff: '130', about: { fr: 'Présentation corrigée (fictive).' } } }];
await page.click('#tab-sup');
await page.click('#tab-mfr');
await page.waitForSelector('#mfr-list button[data-mfr]');
await page.click('#mfr-list button[data-mfr]');
await page.waitForSelector('#mf-props li');
ok(norm(await page.textContent('#mf-props')).includes('Présentation corrigée (fictive).') && norm(await page.textContent('#mf-props')).includes('Merci de corriger.'),
  'correction proposée par le fournisseur affichée');
await page.click('button[data-mf=papply]');
await page.waitForFunction(() => !document.getElementById('mf-props') && /Corrections appliquées/.test(document.getElementById('msg').textContent));
const applied = norm(await page.textContent('#mf-view'));
ok(applied.includes('130') && applied.includes('Présentation corrigée (fictive).') && applied.includes('虚构的制造商'), 'correction appliquée, autres langues conservées');
page.once('dialog', (d) => d.accept());
await openDet('d-ORG-0111');
await page.click('#mf-dists button[data-mf=consent][data-org="ORG-0111"]');
await page.waitForFunction(() => /accord donné/.test(document.getElementById('mf-dists').textContent));
ok(norm(await page.textContent('#mf-dists')).includes('(hors plateforme)') && !(await page.isDisabled('button[data-mf=publish]')), 'accord hors plateforme enregistré : publication possible');
let confirmText = '';
page.once('dialog', (d) => { confirmText = d.message(); d.accept(); });
await page.click('button[data-mf=publish]');
await page.waitForSelector('#mf-pub-link');
ok(confirmText.includes('accord du fabricant') && await page.getAttribute('#mf-pub-link', 'href') === '/fabricants/?b=Marque%20D%C3%A9mo',
  'publication : confirmation explicite, lien vers la page publique');
ok(norm(await page.textContent('#mf-pub')).includes(ADMIN_EMAIL) && norm(await page.textContent('#mfr-list')).includes('Page publiée'), 'publication : au nom de l\'administrateur, liste à jour');
await page.click('#tab-sup');
await page.click('button[data-org="ORG-0110"]');
await page.waitForSelector('#pf-mfrs li');
ok(norm(await page.textContent('#pf-mfrs')).includes('Fabricant Démo (fictif)') && norm(await page.textContent('#pf-mfrs')).includes('Distributeur agréé'),
  'fiche du distributeur : fabricant rattaché affiché');
await page.click('button[data-pf=mopen]');
await page.waitForSelector('#mf-view');
page.once('dialog', (d) => d.accept());
await page.click('button[data-mf=unpublish]');
await page.waitForSelector('button[data-mf=publish]');
ok(norm(await page.textContent('#mf-pub')).includes('non publiée'), 'page publique retirée');
page.once('dialog', (d) => d.accept());
await openDet('d-ORG-0110');
await page.click('#mf-dists button[data-mf=unlink][data-org="ORG-0110"]');
await page.waitForFunction(() => document.querySelectorAll('#mf-dists li').length === 1);
ok((await page.$$('#ml-org option')).length === 1, 'distributeur détaché, de nouveau proposé');
await page.click('#tab-sup');
await page.click('button[data-org="ORG-0110"]');
await page.waitForSelector('#d-org:text("ORG-0110")');

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
// Prix unitaire sous le premier palier (palier « 1 » d'un flux Octopart) : affiché comme première ligne.
await page.fill('#lot-q', 'GRM188');
await page.click('#lot-form button[type=submit]');
await page.waitForFunction(() => document.getElementById('lot-list').textContent.includes('GRM188R71H104KA93D'));
const grm = norm(await page.textContent('#lot-list tr'));
ok(/1 à 9\s*0,0031 USD/.test(grm) && /10 à 99\s*0,0029 USD/.test(grm), 'prix unitaire de 1 à 9 affiché avant le premier palier');
// Prix unitaire égal au premier palier (fichier de fabricant, minimum 10) : pas de ligne « 1 à 9 ».
await page.fill('#lot-q', 'CH340C');
await page.click('#lot-form button[type=submit]');
await page.waitForFunction(() => document.getElementById('lot-list').textContent.includes('CH340C'));
ok(!/(?<!\d)1 à 9(?!\d)/.test(norm(await page.textContent('#lot-list tr'))), 'pas de ligne « 1 à 9 » quand le prix unitaire est celui du premier palier');
// Prix 1KU (convention) : palier qui couvre 1 000 pièces.
await page.fill('#lot-q', 'GRM188');
await page.click('#lot-form button[type=submit]');
await page.waitForFunction(() => document.getElementById('lot-list').textContent.includes('GRM188R71H104KA93D'));
ok(norm(await page.textContent('#lot-list tr td.p1k')) === '0,0026 USD', 'prix 1KU : palier « 100 et plus » qui couvre 1 000 pièces');
ok((await page.textContent('table.lots thead')).includes('Prix 1 k'), 'colonne « Prix 1 k » dans le tableau');
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

// 9 bis. Demandes de prix : site web et API au même endroit, rien ne part avant la validation (ADR 0023, 0026).
ok((await page.textContent('#req-count')) === '5', 'onglet Demandes : compteur des demandes à valider (4 site, dont un panier de 2, + 1 API)');
await page.click('#tab-req');
await page.waitForSelector('#req-list li[data-ref="PR-0012"]');
const reqText = norm(await page.textContent('#req-list'));
ok(reqText.includes('Atelier Exemple (fictif)') && reqText.includes('NE555DR') && reqText.includes('ORG-0110 V-5') && reqText.includes('VIES vérifié'),
  'demande du site : acheteur, référence, fournisseur et prix des deux côtés');
ok(!reqText.includes('PR-0010'), 'filtre « À valider » : la demande déjà transmise n\'apparaît pas');
// Recherches payées de composants rares (migration 20261106000040) : listées avec l'acheteur, traitées ici.
await page.waitForSelector('#src-list li[data-src="SRC-0001"]');
const srcText = norm(await page.textContent('#src-list'));
ok(srcText.includes('CM8071505024905') && srcText.includes('achat@exemple.test') && srcText.includes('VIES vérifié') && srcText.includes('58,8 EUR'),
  'recherche payée : référence, acheteur, TVA vérifiée, montant payé');
await page.$eval('#src-list details', (d) => { d.open = true; });
await page.selectOption('#src-list select[name=status]', 'offers_sent');
await page.fill('#src-list textarea[name=buyer_note]', 'Deux offres envoyées par e-mail.');
await page.fill('#src-list input[name=credit_used_by]', 'pr-0042');
await page.click('#src-list form button[type=submit]');
await page.waitForFunction(() => /SRC-0001 enregistrée/.test(document.getElementById('msg').textContent));
ok(mock.state.sourcing[0].status === 'offers_sent' && mock.state.sourcing[0].credit_used_by === 'PR-0042' && mock.state.sourcing[0].buyer_note.includes('Deux offres'),
  'recherche traitée : état, message à l\'acheteur, déduction');
// Proforma (pays sans virement instantané) : à traiter tant que le virement n'est pas reçu, puis marquée payée à la main.
await page.waitForSelector('#src-list li[data-src="SRC-0002"]');
const pfText = norm(await page.textContent('#src-list li[data-src="SRC-0002"]'));
ok(pfText.includes('En attente de virement (proforma)') && pfText.includes('proforma de 49 EUR') && pfText.includes('proforma et virement'),
  'proforma : listée « À valider », montant à facturer, mode de paiement');
await page.$eval('#src-list li[data-src="SRC-0002"] details', (d) => { d.open = true; });
await page.selectOption('#src-list li[data-src="SRC-0002"] select[name=status]', 'paid');
await page.click('#src-list li[data-src="SRC-0002"] form button[type=submit]');
await page.waitForFunction(() => /SRC-0002 enregistrée/.test(document.getElementById('msg').textContent));
ok(mock.state.sourcing[1].status === 'paid' && mock.state.sourcing[1].paid_at, 'proforma : virement reçu, demande marquée payée');
ok(reqText.includes('Facturation') && reqText.includes('75000 Paris') && reqText.includes('Par Central.Parts (DAP), DHL préféré') && reqText.includes('Entrepôt Shenzhen (fictif) · Shenzhen CN'),
  'demande : facturation, transport choisi et adresse d\'expédition du lot (ADR 0030)');
ok(norm(await page.textContent('#rfq-list')).includes('DEM-1004') && !norm(await page.textContent('#rfq-list')).includes('DEM-1003'), 'RFQ de l\'API à valider');
// Refus sans motif : rien n'est envoyé.
await page.click('#req-list li[data-ref="PR-0011"] button[data-ract="req_reject"]');
await page.waitForSelector('#confirm[open]');
await page.click('#c-ok');
ok(await page.isVisible('#c-err') && calls('POST /requests/reject') === 0, 'refus d\'une demande sans motif : aucun appel');
await page.fill('#c-reason', 'Demande de test');
await page.click('#c-ok');
await page.waitForSelector('#confirm[open]', { state: 'detached' });
await page.waitForFunction(() => !document.querySelector('#req-list li[data-ref="PR-0011"]'));
ok(mock.state.requests.find((r) => r.ref === 'PR-0011').status === 'rejected' && !mock.state.notified.some((x) => x.ref === 'PR-0011'), 'demande refusée : fournisseur non prévenu');
// Validation : confirmation, puis le fournisseur est prévenu.
await page.click('#req-list li[data-ref="PR-0012"] button[data-ract="req_approve"]');
await page.waitForSelector('#confirm[open]');
ok(calls('POST /requests/approve') === 0, 'validation : rien n\'est envoyé avant la confirmation');
await page.click('#c-ok');
await page.waitForSelector('#msg.ok');
ok(norm(await page.textContent('#msg')).includes('PR-0012 validée et transmise au fournisseur'), 'validation : message de confirmation');
ok(mock.state.notified.some((x) => x.ref === 'PR-0012' && x.org === 'ORG-0110'), 'validation : fournisseur prévenu');
// Panier : chaque ligne porte son panier ; « Valider tout le panier » transmet les deux lignes à leurs fournisseurs.
await page.waitForFunction(() => !document.querySelector('#req-list li[data-ref="PR-0012"]'));
const cartCard = norm(await page.textContent('#req-list li[data-ref="PR-0015"]'));
ok(cartCard.includes('CART-0003') && cartCard.includes('(2 lignes)'), 'panier : référence et nombre de lignes sur la fiche');
await page.click('#req-list li[data-ref="PR-0015"] button[data-ract="cart_approve"]');
await page.waitForSelector('#confirm[open]');
ok(norm(await page.textContent('#c-title')).includes('CART-0003 (2 lignes)') && calls('POST /requests/approve') === 1, 'panier : confirmation, rien d\'envoyé avant');
await page.click('#c-ok');
await page.waitForSelector('#req-list li.empty');
ok(norm(await page.textContent('#msg')).includes('CART-0003 : 2 ligne(s) validée(s)'), 'panier : deux lignes validées');
ok(mock.state.notified.some((x) => x.ref === 'PR-0015' && x.org === 'ORG-0110') && mock.state.notified.some((x) => x.ref === 'PR-0016' && x.org === 'ORG-0111'),
  'panier : chaque fournisseur prévenu de sa ligne');
// RFQ de l'API : validation et diffusion.
await page.click('#rfq-list li[data-id="DEM-1004"] button[data-ract="rfq_approve"]');
await page.waitForSelector('#confirm[open]');
await page.click('#c-ok');
await page.waitForSelector('#rfq-list li.empty');
ok(mock.state.rfqs.find((d) => d.id === 'DEM-1004').status === 'auction', 'RFQ validée et diffusée');
ok((await page.isHidden('#req-count')), 'plus rien à valider : compteur masqué');
// Toutes les demandes : statuts et décisions.
await page.click('#req-filters button[data-r=""]');
await page.waitForSelector('#req-list li[data-ref="PR-0010"]');
const all = norm(await page.textContent('#req-list'));
ok(all.includes('Transmise au fournisseur') && all.includes('Refusée') && all.includes('Motif : Demande de test'), 'toutes les demandes : statuts et motif interne');
ok((await page.$$('#req-list button[data-ract]')).length === 0, 'demandes déjà traitées : plus de bouton de décision');
// Déjà traitée ailleurs (robot WeChat) : message clair, liste rafraîchie.
mock.state.requests.push({ ...mock.state.requests[0], ref: 'PR-0013', status: 'pending_validation', decided_at: null, decided_by: null });
await page.click('#req-filters button[data-r="pending_validation"]');
await page.waitForSelector('#req-list li[data-ref="PR-0013"]');
mock.state.requests.find((r) => r.ref === 'PR-0013').status = 'submitted';
await page.click('#req-list li[data-ref="PR-0013"] button[data-ract="req_approve"]');
await page.click('#c-ok');
await page.waitForSelector('#msg.info');
ok(norm(await page.textContent('#msg')).includes('déjà été traitée'), 'demande déjà traitée par le robot : message, sans erreur');

// 9 ter. Adresses d'expédition d'un vendeur (lecture), dans sa fiche.
await page.click('#tab-sup');
await page.click('#filters button[data-s=""]');
await page.waitForSelector('#sup-list button[data-org="ORG-0110"]');
await page.click('#sup-list button[data-org="ORG-0110"]');
await page.waitForFunction(() => (document.getElementById('d-addr') || {}).textContent?.includes('Entrepôt Shenzhen'));
const addr = norm(await page.textContent('#d-addr'));
ok(addr.includes('par défaut') && addr.includes('Futian, bâtiment 1, 518000 Shenzhen, CN') && addr.includes('Entrepôt Hong Kong (fictif)') && addr.includes('10 lot(s)'),
  'fiche vendeur : adresses d\'expédition, la principale signalée');

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
await page.click('#tab-req');
await page.waitForSelector('#req-list li[data-ref]');
ok(await wide(), '390 px : demandes sans défilement horizontal');
ok(errors.length === 0, 'aucune erreur console ni requête externe (390 px) : ' + errors.join(' | '));
await page.close();

// 11. Session expirée : retour à la connexion.
({ page, errors } = await open({ width: 1280, height: 900 }));
await page.goto(BASE + '/admin/#access_token=PERIME&expires_in=3600');
await page.waitForSelector('#v-login:not([hidden])');
ok(norm(await page.textContent('#msg')).includes('Session expirée'), 'jeton expiré : retour à la connexion');
await page.close();

// 12. Plusieurs onglets du même navigateur : une connexion vaut pour tous, une déconnexion aussi.
mock = createMock();
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'fr-FR' });
  const tabs = [];
  for (let i = 0; i < 2; i++) {
    const p = await ctx.newPage();
    await p.route(BASE + '/functions/v1/admin/**', api);
    await p.route(/^(?!http:\/\/localhost)/, (r) => r.abort());
    tabs.push(p);
  }
  const [a, b] = tabs;
  await b.goto(BASE + '/admin/');
  await b.waitForSelector('#v-login:not([hidden])');
  await a.goto(BASE + '/admin/#access_token=DEMO-ADMIN&expires_in=3600');
  await a.waitForSelector('#v-app:not([hidden])');
  await b.waitForSelector('#v-app:not([hidden])');
  ok(norm(await b.textContent('#who-email')) === ADMIN_EMAIL, 'onglets : l\'onglet resté sur la connexion se connecte quand le lien est ouvert dans un autre');
  const c = await ctx.newPage();
  await c.route(BASE + '/functions/v1/admin/**', api);
  await c.goto(BASE + '/admin/');
  await c.waitForSelector('#v-app:not([hidden])');
  ok(await c.isHidden('#v-login'), 'onglets : un nouvel onglet est déjà connecté');
  await a.click('#logout');
  await b.waitForSelector('#v-login:not([hidden])');
  await c.waitForSelector('#v-login:not([hidden])');
  ok(norm(await b.textContent('#msg')).includes('autre onglet') && await c.isHidden('#v-app'), 'onglets : se déconnecter dans un onglet déconnecte les autres');
  const stored = await a.evaluate(() => [localStorage.getItem('cp-admin-session'), sessionStorage.getItem('cp-admin-session')]);
  ok(stored[0] === null && stored[1] === null, 'onglets : aucun jeton gardé après la déconnexion');
  // Jeton expiré dans le stockage partagé : effacé, écran de connexion.
  await c.evaluate(() => localStorage.setItem('cp-admin-session', JSON.stringify({ token: 'X', exp: 1 })));
  await c.reload();
  await c.waitForSelector('#v-login:not([hidden])');
  ok(await c.evaluate(() => localStorage.getItem('cp-admin-session')) === null, 'onglets : jeton expiré effacé du stockage');
  await ctx.close();
}
await browser.close();

console.log(`${n - bad}/${n} contrôles du back office passés.`);
process.exit(bad ? 1 : 0);
