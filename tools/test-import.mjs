// Tests de lecture des fichiers de stock (supabase/functions/import-stock/parse.js)
// et des outils de la page de dépôt (supabase/functions/_shared/depot.js), et langue des messages du robot WeChat
// (supabase/functions/_shared/robot-texts.js).
// Usage : node tools/test-import.mjs
import { cleanUrl, decode, leadDays, mapRows, parseCSV, price, tierCell } from '../supabase/functions/import-stock/parse.js';
import { readFileSync } from 'node:fs';
import { creditCodeOk, registrationNumberOk, registrationLine, normalizeRegistrationNumber, licensePath, parseWechatXml, randomScene, readSession, replyText, sceneOf, signSession, storagePath, wechatSignatureOk } from '../supabase/functions/_shared/depot.js';
import { createHash } from 'node:crypto';
import { DEPOT_MENU_KEY, depotLinkText, isDepotMenuClick } from '../supabase/functions/_shared/depot.js';
import * as R from '../supabase/functions/_shared/robot-texts.js';

let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };

// Format broker, séparateur virgule, en-tête « Price per 1,000 pcs » entre guillemets, BOM.
const broker = '﻿Manufacturer,SKU,MPN,Product URL,Unit Price,Quantity,Price per 10 pcs,Price per 100 pcs,"Price per 1,000 pcs",Currency,Date Code\r\n' +
  'AMD Xilinx,HB-1,xc2s50-5tq144c,https://example.com/1,"1,250.00",400,"1,300.00",1250,1200,usd,2011\r\n' +
  'NXP,HB-2,,https://example.com/2,10,5,,,,USD,\r\n' +
  'NXP,HB-3,MC68HC11E1CFNE2,,10,zéro,,,,USD,\r\n' +
  'TI,HB-4,NE555DR,,0.11,"12,000",,,,RMB,\r\n';
const t = mapRows(parseCSV(broker));
ok(!t.error && t.total === 4, 'format broker lu : 4 lignes');
ok(t.rows.length === 2 && t.rejected.length === 2, '2 lignes retenues, 2 rejetées');
ok(t.rejected[0].line === 3 && t.rejected[0].reason === 'MPN manquant', 'ligne 3 : MPN manquant');
ok(t.rejected[1].line === 4 && t.rejected[1].reason === 'Quantité invalide', 'ligne 4 : quantité invalide');
const r = t.rows[0];
ok(r.mpn === 'XC2S50-5TQ144C' && r.sku === 'HB-1' && r.qty === 400 && r.dc === '2011', 'MPN en majuscules, SKU, quantité, date code');
ok(r.price === 1250 && r.tiers[10] === 1300 && r.tiers[100] === 1250 && r.tiers[1000] === 1200, 'prix et paliers, dont 1,000 pcs');
ok(r.currency === 'USD' && t.rows[1].currency === 'RMB', 'devise lue telle quelle (RMB normalisé par la base)');
ok(t.rows[1].qty === 12000, 'quantité « 12,000 » lue 12000');

// Séparateur point-virgule et décimales à la française (export Excel français).
const fr = 'MPN;Manufacturer;Quantity;Unit Price;Date Code\nLM358DR;Texas Instruments;1 000;0,09;2024\n';
const f = mapRows(parseCSV(fr));
ok(f.rows.length === 1 && f.rows[0].qty === 1000 && f.rows[0].price === 0.09, 'point-virgule, « 1 000 » et « 0,09 »');

// Format Octopart / ECIA.
const octo = 'Manufacturer Part Number\tManufacturer\tQuantity Available\tPackage Type\nSTM32F103C8T6\tST\t5000\tTray\n';
const o = mapRows(parseCSV(octo));
ok(o.rows.length === 1 && o.rows[0].pack === 'Tray' && o.rows[0].qty === 5000, 'tabulations, colonnes Octopart / ECIA');

// Tableau venu d'une feuille XLSX (lignes vides en tête, cellules nombres).
const sheet = [[], ['MPN', 'Quantity', 'Currency'], ['TPS62130RGTR', 3000, 'CNH'], ['', '', '']];
const x = mapRows(sheet);
ok(x.rows.length === 1 && x.rows[0].qty === 3000 && x.rows[0].currency === 'CNH', 'feuille XLSX : en-tête après lignes vides, nombres');

// Flux distributeur Octopart : paliers en paires de colonnes, décimales à virgule, lien avec suivi.
const flux = 'manufacturer;mpn;sku;distributor-url;quantity;price-break-1;price-usd-1;price-break-2;price-usd-2;price-break-3;price-usd-3;moq\n' +
  'Texas Instruments;TPS62130RGTR;V-1;https://example.com/p/TPS62130RGTR?utm_source=octopart&utm_medium=referral&ref=7;10000;1;0,5195;10;0,5039;1000;0,4779;1\n';
const fx = mapRows(parseCSV(flux)).rows[0];
ok(fx && fx.price === 0.5195 && fx.currency === 'USD', 'flux Octopart : prix du palier 1 et devise lue dans l\'en-tête');
ok(fx && JSON.stringify(fx.tiers) === '{"10":0.5039,"1000":0.4779}', 'flux Octopart : paliers 10 et 1000');
ok(fx && fx.url === 'https://example.com/p/TPS62130RGTR?ref=7' && fx.moq === 1, 'flux Octopart : distributor-url gardée sans suivi utm (usage interne, ADR 0022) ; moq lu');
ok(cleanUrl('https://example.com/p/X?utm_source=octopart&ref=7') === 'https://example.com/p/X?ref=7', 'lien produit sans paramètres utm');
ok(cleanUrl('pas un lien') === '' && cleanUrl('') === '', 'texte qui n\'est pas un lien : écarté');
ok(cleanUrl('javascript:alert(1)') === '' && cleanUrl('ftp://example.com/a') === '', 'seuls les liens http(s) sont gardés');
ok(cleanUrl('https://example.com/' + 'a'.repeat(2100)) === '', 'lien de plus de 2 048 caractères écarté');

// Fiche technique et description (ADR 0022).
const ds = mapRows(parseCSV('mpn;quantity;datasheet;description\nNE555DR;100;https://www.ti.com/lit/ds/symlink/ne555.pdf?utm_campaign=x;"  Minuterie\n de précision   SOIC-8 "\n')).rows[0];
ok(ds && ds.datasheet === 'https://www.ti.com/lit/ds/symlink/ne555.pdf' && ds.desc === 'Minuterie de précision SOIC-8', 'fiche technique sans suivi, description nettoyée');
const dz = mapRows(parseCSV('型号,数量,规格书,产品描述\nSTM32F103C8T6,10,https://www.st.com/ds.pdf,32位单片机\n')).rows[0];
ok(dz && dz.datasheet === 'https://www.st.com/ds.pdf' && dz.desc === '32位单片机', 'en-têtes chinois : 规格书 et 产品描述');
ok(mapRows(parseCSV('mpn;quantity;description\nA1;1;' + 'x'.repeat(600) + '\n')).rows[0].desc.length === 500, 'description limitée à 500 caractères');
ok(mapRows(parseCSV('mpn;quantity\nA1;1\n')).rows[0].url === '' && mapRows(parseCSV('mpn;quantity\nA1;1\n')).rows[0].desc === '', 'sans colonnes : lien et description vides');

// En-têtes chinois.
const zh = mapRows(parseCSV('型号,品牌,数量,单价,批号,币种\nSTM32F103C8T6,ST,5000,1.2,2024+,RMB\n')).rows[0];
ok(zh && zh.mpn === 'STM32F103C8T6' && zh.mfr === 'ST' && zh.qty === 5000 && zh.price === 1.2 && zh.dc === '2024+' && zh.currency === 'RMB', 'en-têtes chinois : 型号, 品牌, 数量, 单价, 批号, 币种');

// Erreurs de fichier.
ok(mapRows(parseCSV('MPN,Quantity\n')).error.startsWith('Fichier vide'), 'fichier sans ligne de données');
ok(mapRows(parseCSV('Reference,Stock\nA,1\n')).error.startsWith('Colonnes obligatoires'), 'colonnes MPN ou quantité absentes');
ok(price('$12.5') === 12.5 && price('') === null && price('0') === null, 'prix : symbole, vide, zéro');

// Fichiers de prix de fabricants chinois (ADR 0022) : paliers dans une seule cellule, boîtier, délai, code produit.
ok(JSON.stringify(tierCell('10~90 0.0379|100~290 0.03|10000以上 0.0185')) === '[[10,0.0379],[100,0.03],[10000,0.0185]]', 'cellule de paliers : fourchettes et « 以上 »');
ok(JSON.stringify(tierCell('1-99: 0.5; 100+ 0.4')) === '[[1,0.5],[100,0.4]]', 'cellule de paliers : tirets, deux-points, « + », point-virgule');
ok(tierCell('0.25') === null && tierCell('') === null, 'simple prix : pas une cellule de paliers');
ok(tierCell('10~90 abc|100~290 0.03') === false, 'cellule de paliers illisible : signalée');
ok(leadDays('1-3day') === 3 && leadDays('2 weeks') === 14 && leadDays('7天') === 7 && leadDays('2-3周') === 21, 'délais : jours, semaines, chinois');
ok(leadDays('现货') === null && leadDays('') === null && leadDays('400 days') === null, 'délai illisible ou au-delà d\'un an : vide');
const fab = mapRows([['产品编号', '型号', '品牌', '封装', '包装数量', '库存', '价格', '批次', '货期'],
  ['A1', 'AMS1117-3.3', 'Marque fictive', 'SOT-223', '2500', '120000', '10~90 0.04|100~990 0.03|1000以上 0.02', '25+', '1-3day'],
  ['A2', 'B2', 'Marque fictive', 'SOT-23', '3000', '5000', '10~90 0.04|100~990 0.05', '25+', '1-3day'],
  ['A3', 'B3', 'Marque fictive', 'SOT-23', '3000', '5000', '10~90 abc', '25+', '1-3day']]);
const f1 = fab.rows[0];
ok(f1 && f1.sku === 'A1' && f1.pack === 'SOT-223' && f1.dc === '25+' && f1.lead === 3 && f1.qty === 120000, 'fichier fabricant : code produit, boîtier, lot, délai, stock');
ok(f1 && f1.price === 0.04 && JSON.stringify(f1.tiers) === '{"10":0.04,"100":0.03,"1000":0.02}', 'fichier fabricant : prix unitaire et paliers tirés de la cellule');
ok(fab.rejected.map((r) => r.code).join() === 'breaks_price_order,price_invalid', 'fichier fabricant : prix en hausse et cellule illisible rejetés');
for (const f of ['../site/depot/modele-fabricant.csv', '../site/depot/stock-template.csv', '../site/depot/lien/modele.csv']) {
  const m = mapRows(parseCSV(decode(readFileSync(new URL(f, import.meta.url))))).rows[0];
  ok(m && m.desc && m.datasheet.startsWith('https://') && m.url.startsWith('https://') && m.lead === 3 && Object.keys(m.tiers).length >= 2,
    'modèle ' + f.split('/').pop() + ' : lu en entier (description, fiche technique, lien, délai, paliers)');
}

// ---------------------------------------------------------------- listes des vendeurs (tools/fixtures)
const fixture = (n) => mapRows(parseCSV(decode(readFileSync(new URL('./fixtures/' + n, import.meta.url)))));
const good = fixture('liste-partenaire.csv');
ok(good.rows.length === 10 && good.rejected.length === 0, 'liste de test : 10 références acceptées');
ok(good.rows.every((r) => /^https:\/\/example\.com\//.test(r.url) && !r.url.includes('utm_') && r.currency === 'USD'), 'liste de test : distributor-url gardée sans suivi utm, devise USD');
const mt = good.rows.find((r) => r.mpn === 'MT41K128M16JT-107 IT:K');
ok(mt && mt.price === 3.9 && mt.tiers[1000] === 3.2 && mt.moq === 1, 'liste de test : référence avec espace et deux-points, paliers à virgule');
const ir = good.rows.find((r) => r.mpn === 'IRLML2502TRPBF');
ok(ir && ir.moq === 100 && ir.price === 0.062 && JSON.stringify(ir.tiers) === '{"100":0.062,"1000":0.055,"10000":0.048}', 'liste de test : premier palier à 100 gardé, MOQ 100');
const wrong = fixture('liste-erreurs.csv');
const codes = Object.fromEntries(wrong.rejected.map((r) => [r.line, r.code]));
ok(wrong.rows.length === 1 && wrong.rows[0].sku === 'E-0008', 'liste fausse : une seule ligne acceptée');
ok(codes[2] === 'qty_invalid', 'liste fausse : quantité négative');
ok(codes[3] === 'breaks_qty_order', 'liste fausse : paliers non croissants en quantité');
ok(codes[4] === 'breaks_price_order', 'liste fausse : prix en hausse avec la quantité');
ok(codes[5] === 'mpn_missing', 'liste fausse : MPN vide');
ok(codes[6] === 'price_invalid', 'liste fausse : prix nul');
ok(codes[7] === 'break_incomplete', 'liste fausse : palier sans prix');
ok(codes[8] === 'moq_invalid', 'liste fausse : MOQ à 0');
ok(wrong.rejected.every((r) => r.reason && r.code), 'liste fausse : code et libellé sur chaque rejet');
// GBK / GB18030 : en-têtes chinois enregistrés par Excel sur un poste chinois.
const gbk = Uint8Array.from([...Buffer.from('MPN,', 'latin1'), 0xca, 0xfd, 0xc1, 0xbf, ...Buffer.from('\nNE555DR,100\n', 'latin1')]);
const g = mapRows(parseCSV(decode(gbk)));
ok(g.rows.length === 1 && g.rows[0].qty === 100, 'fichier GBK : en-tête 数量 lu');
ok(decode(new TextEncoder().encode('型号,数量')) === '型号,数量', 'fichier UTF-8 : lu tel quel');

// ---------------------------------------------------------------- page de dépôt : jeton de session et chemin
const secret = 'x'.repeat(64);
const now = Date.UTC(2026, 9, 30, 14, 25, 1);
const tok = await signSession(secret, { org: 'ORG-0100', openid: 'oABC' }, 3600, now);
ok(JSON.stringify(await readSession(secret, tok, now + 1000)) === '{"org":"ORG-0100","openid":"oABC"}', 'jeton : lu avec le bon secret');
ok(await readSession(secret, tok, now + 3601 * 1000) === null, 'jeton : expiré après sa durée');
ok(await readSession('y'.repeat(64), tok, now) === null, 'jeton : refusé avec un autre secret');
const [body, sig] = tok.split('.');
const forged = Buffer.from(JSON.stringify({ org: 'S1', openid: 'oABC', exp: 9999999999 })).toString('base64url');
ok(await readSession(secret, forged + '.' + sig, now) === null, 'jeton : société falsifiée refusée');
ok(await readSession(secret, 'n importe quoi', now) === null && await readSession(secret, body, now) === null, 'jeton : illisible refusé');
let threw = false; try { await signSession('court', { org: 'A', openid: 'b' }); } catch { threw = true; }
ok(threw, 'jeton : secret trop court refusé');
const d = new Date(now);
ok(storagePath('ORG-0100', '库存表 IC.xlsx', { now: d }) === 'ORG-0100/20261030-142501-IC.xlsx', 'chemin : nom chinois réduit, horodaté');
ok(storagePath('ORG-0100', 'stock.CSV', { complete: true, now: d }) === 'ORG-0100/20261030-142501-stock-complet.csv', 'chemin : stock complet choisi explicitement');
ok(storagePath('ORG-0100', 'stock-complet.xlsx', { now: d }) === 'ORG-0100/20261030-142501-stock-stock.xlsx', 'chemin : « complet » dans le nom sans le choix : neutralisé');
ok(storagePath('ORG-0100', '../../S2/x.csv', { now: d }) === 'ORG-0100/20261030-142501-S2-x.csv', 'chemin : pas de sortie du dossier');
ok(storagePath('ORG-0100', 'notes.pdf', { now: d }) === null && storagePath('ORG-0100', '库存.xlsx', { now: d }) === 'ORG-0100/20261030-142501-stock.xlsx', 'chemin : PDF refusé, nom vide remplacé');

// ---------------------------------------------------------------- connexion par QR code WeChat
ok(/^dl_[0-9a-f]{32}$/.test(randomScene()) && randomScene() !== randomScene(), 'scène : aléatoire, 32 caractères hexadécimaux');
const wtok = 'jeton-test', ts = '1700000000', nonce = '42';
const wsig = createHash('sha1').update([wtok, ts, nonce].sort().join('')).digest('hex');
ok(await wechatSignatureOk(wtok, ts, nonce, wsig), 'signature WeChat : acceptée');
ok(!(await wechatSignatureOk('autre', ts, nonce, wsig)) && !(await wechatSignatureOk(wtok, ts, nonce, '')), 'signature WeChat : refusée si fausse ou absente');
const scanXml = '<xml><ToUserName><![CDATA[gh_cp]]></ToUserName><FromUserName><![CDATA[oFOURNISSEUR]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[SCAN]]></Event><EventKey><![CDATA[dl_abc]]></EventKey><Ticket><![CDATA[t]]></Ticket></xml>';
const scan = parseWechatXml(scanXml);
ok(scan.FromUserName === 'oFOURNISSEUR' && scan.CreateTime === '1700000000' && sceneOf(scan) === 'dl_abc', 'événement SCAN : openid et scène');
ok(sceneOf(parseWechatXml(scanXml.replace('[SCAN]', '[subscribe]').replace('[dl_abc]', '[qrscene_dl_abc]'))) === 'dl_abc', 'abonnement en scannant : scène sans préfixe');
ok(sceneOf(parseWechatXml(scanXml.replace('[SCAN]', '[subscribe]').replace('[dl_abc]', '[]'))) === null && sceneOf({ MsgType: 'text' }) === null, 'abonnement simple et message texte : ignorés');
const rep = replyText('oFOURNISSEUR', 'gh_cp', '已登录 ]]> test', 1700000000000);
const back = parseWechatXml(rep);
ok(back.ToUserName === 'oFOURNISSEUR' && back.MsgType === 'text' && back.CreateTime === '1700000000' && rep.includes('已登录'), 'réponse texte WeChat bien formée');

// ---------------------------------------------------------------- inscription des fournisseurs
ok(creditCodeOk('91350100M000100Y43') && creditCodeOk(' 91350100m000100y43 '), '统一社会信用代码 : exemple de la norme, minuscules et espaces');
ok(!creditCodeOk('91350100M000100Y44') && !creditCodeOk('91350100M00010OY43') && !creditCodeOk(''), '统一社会信用代码 : clé fausse, lettre O, vide');
// Numéro selon le pays / région (inscription hors de Chine continentale).
ok(registrationNumberOk('CN', '91350100M000100Y43') && !registrationNumberOk('CN', '123456789012345'), 'Chine : 18 caractères acceptés, 15 refusés');
ok(registrationNumberOk('HK', '123456789012345') && registrationNumberOk('HK', ' 1234 5678 ') && registrationNumberOk('OTHER', 'hrb-2026/77'), 'Hong Kong et autre pays : numéro libre de 5 à 30 caractères');
ok(!registrationNumberOk('HK', '') && !registrationNumberOk('HK', '1234') && !registrationNumberOk('HK', '1'.repeat(31)) && !registrationNumberOk('HK', '12345#') && !registrationNumberOk('HK', '-----'), 'Hong Kong : vide, trop court, trop long, caractère interdit refusés');
ok(!registrationNumberOk('', '12345678') && !registrationNumberOk('FR', '12345678'), 'pays / région obligatoire et connu');
ok(normalizeRegistrationNumber('HK', ' ab  12 ') === 'AB 12' && normalizeRegistrationNumber('CN', ' 9135 ') === '9135', 'numéro normalisé');
ok(registrationLine({ region: 'HK', code: '123456789012345' }) === 'Registration no. (Hong Kong): 123456789012345', 'message WeChat : numéro de Hong Kong de 15 caractères');
ok(registrationLine({ region: 'OTHER', code: 'HRB-2026/77' }) === 'Registration no. (other country): HRB-2026/77', 'message WeChat : autre pays');
ok(registrationLine({ region: null, code: '91350100M000100Y43' }) === 'Credit code (Mainland China): 91350100M000100Y43' && registrationLine({}) === 'Credit code (Mainland China): —', 'message WeChat : société inscrite avant la migration, numéro absent');
ok(licensePath('ORG-0105', '营业执照.JPEG', d) === 'ORG-0105/licence-20261030-142501.jpg' && licensePath('ORG-0105', 'a.pdf', d).endsWith('.pdf'), 'licence : chemin horodaté dans le dossier de la société');
ok(licensePath('ORG-0105', 'a.exe', d) === null, 'licence : format refusé');
ok(JSON.stringify(await readSession(secret, await signSession(secret, { org: null, openid: 'oNEW' }, 3600, now), now)) === '{"org":null,"openid":"oNEW"}', 'jeton : compte sans société, pour l\'inscription');

// Bouton « 供应商 › 上传库存 » du menu WeChat : lien de connexion personnel.
const click = parseWechatXml('<xml><ToUserName><![CDATA[gh_x]]></ToUserName><FromUserName><![CDATA[oABC]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[CLICK]]></Event><EventKey><![CDATA[DEPOT_LOGIN]]></EventKey></xml>');
ok(isDepotMenuClick(click), 'menu : clic sur « 上传库存 » reconnu');
ok(!isDepotMenuClick({ ...click, EventKey: 'AUTRE' }) && !isDepotMenuClick({ ...click, Event: 'VIEW' }) && !isDepotMenuClick({ MsgType: 'text', Content: 'DEPOT_LOGIN' }), 'menu : autre bouton, lien ou message ignorés');
const linkText = depotLinkText('https://central.parts/depot/?login=dl_' + 'a'.repeat(32));
ok(linkText.includes('?login=dl_' + 'a'.repeat(32)) && linkText.includes('15 分钟') && linkText.includes('valid 15 minutes') && Buffer.byteLength(linkText) < 2048, 'menu : réponse avec le lien, en chinois et en anglais, sous 2 048 octets');
const menu = JSON.parse((await import('node:fs')).readFileSync(new URL('../supabase/wechat/menu.json', import.meta.url), 'utf8'));
const upload = menu.button.flatMap((b) => b.sub_button || [b]).find((b) => b.name === '上传库存');
ok(upload && upload.type === 'click' && upload.key === DEPOT_MENU_KEY, 'menu.json : « 上传库存 » est un bouton clic, clé DEPOT_LOGIN');

// Langue des messages du robot WeChat (_shared/robot-texts.js) : opérateur → anglais seul ; fournisseur → inchangé.
const HAN = /[　-〿㐀-鿿豈-﫿＀-￯]/; // idéogrammes et ponctuation pleine chasse
const en = (t, label) => ok(typeof t === 'string' && t.length > 0 && !HAN.test(t), 'opérateur, anglais seul : ' + label);
const fakeUrl = 'https://central.parts/depot/?login=dl_xxxxxxxx';
for (const st of ['ok', 'not_bound', 'invite_invalid', 'expired']) en(R.scanReply(st, true), 'scan du QR code (' + st + ')');
ok(R.scanReply('inconnu', true) === null && R.scanReply('inconnu') === null, 'scan : statut inconnu, pas de réponse');
en(R.phoneBackLine(fakeUrl, true), 'lien de retour sur téléphone');
en(R.depotLinkText(fakeUrl, true), 'lien de connexion au centre fournisseurs (menu)');
ok(R.depotLinkText(fakeUrl, true).includes(fakeUrl), 'opérateur : le lien de connexion est bien dans le message');
en(R.linkErrorText(true), 'erreur de création du lien');
en(R.welcomeText('dl_xxxxxxxx', true), 'accueil');
ok(R.welcomeText('dl_xxxxxxxx', true).includes(fakeUrl) && !R.welcomeText('', true).includes('?login='), 'opérateur : accueil avec lien, ou sans lien si sa création échoue');
en(R.receivedText(true), 'accusé de réception');
en(R.operatorHelpText(), 'aide des commandes');
for (const c of ['pending', 'approve ORG-', 'reject ORG-', 'link', 'reply 123', 'request PR-', 'confirm PR-', 'unavailable PR-', 'proforma PR-', 'paid PR-', 'shipped PR-', 'cancel PR-'])
  ok(R.operatorHelpText().includes(c), 'aide : commande « ' + c + ' » listée');
en(R.operatorErrorText('ORG-0123', 'company not found'), 'erreur de commande approve / reject');
en(registrationLine({ region: 'HK', code: '12345678' }), 'ligne de numéro de la fiche [Pending review]');

// Messages écrits dans les fonctions (wechat-events, wechat.ts) pour les opérateurs : aucun caractère chinois hors
// des mots-clés de commande reconnus (expressions régulières et table des statuts).
const src = (f) => readFileSync(new URL('../supabase/functions/' + f, import.meta.url), 'utf8');
const ev = src('wechat-events/index.ts');
const opCmd = ev.slice(ev.indexOf('async function operatorCommand'), ev.indexOf('\n}\n', ev.indexOf('async function operatorCommand')));
const opLines = opCmd.split('\n').filter((l) => !/\.(exec|test)\(|^\s*\/\/|确认: 'confirmed'/.test(l));
ok(opLines.length > 20 && !opLines.some((l) => HAN.test(l)), 'opérateur, anglais seul : réponses aux commandes (Approved, Rejected, PR-…, Sent, Not delivered, Login link, Pending)');
const wt = src('_shared/wechat.ts');
const fn = (name) => wt.slice(wt.indexOf('export ' + (name === 'requestAnswerNote' ? 'function ' : 'async function ') + name), wt.indexOf('\n}\n', wt.indexOf(name)));
ok(!HAN.test(fn('supplierCard')) && fn('supplierCard').includes('[Pending review]'), 'opérateur, anglais seul : fiche [Pending review]');
ok(!HAN.test(fn('requestAnswerNote')) && fn('requestAnswerNote').includes('[Purchase request'), 'opérateur, anglais seul : avis [Purchase request]');
const fwd = ev.split('\n').find((l) => l.includes('[Message #'));
ok(fwd && !HAN.test(fwd), 'opérateur, anglais seul : message transféré [Message #n]');
ok(/if \(await isOperator\(db, msg\.FromUserName\)\) return reply\(await operatorCommand/.test(ev) && (ev.match(/from\('operators'\)/g) || []).length === 1,
  'opérateur : une seule identification (table operators), la même que pour les commandes');

// Fournisseur ou inconnu : textes d'avant, au caractère près (copiés de la version précédente de wechat-events).
const OLD = {
  ok: '已登录 Central.Parts 库存上传，请返回上传页面。\nLogged in to Central.Parts stock upload: go back to the upload page.',
  not_bound: '已登录。请返回网页，注册您的公司。\nLogged in: go back to the web page to register your company.',
  invite_invalid: '邀请链接无效、已过期或已被其他账号使用，请联系 Central.Parts。\nThe invitation link is invalid, expired or already used: please contact Central.Parts.',
  expired: '二维码已过期，请在上传页面刷新二维码。\nThis QR code has expired: refresh it on the upload page.',
};
for (const st of Object.keys(OLD)) ok(R.scanReply(st) === OLD[st] && R.scanReply(st, false) === OLD[st], 'fournisseur, inchangé : scan du QR code (' + st + ')');
ok(R.phoneBackLine(fakeUrl) === '\n\n手机上请点此返回 · On a phone, tap to go back:\n' + fakeUrl, 'fournisseur, inchangé : lien de retour sur téléphone');
const both = (t) => HAN.test(t) && /[A-Za-z]{4,} [A-Za-z]{2,}/.test(t);
ok(both(R.depotLinkText(fakeUrl)) && R.depotLinkText(fakeUrl).startsWith('点此登录 Central.Parts 供应商中心'), 'fournisseur, bilingue : lien de connexion au centre fournisseurs');
ok(R.linkErrorText() === '暂时无法生成登录链接，请稍后再试。\nThe login link could not be created, please try again later.', 'fournisseur, inchangé : erreur de création du lien');
const oldWelcome = (scene) => ['感谢关注 Central.Parts！', '我们为中国原厂、分销商和贸易商拓展欧洲客户：欧洲 EMS、OEM 和设计公司直接查询您的现货。', '',
  `1. 注册公司、上传库存（15 分钟内有效，过期请发送任意消息获取新链接）：https://central.parts/depot/?login=${scene}`,
  '2. 库存表模板：https://central.parts/depot/stock-template.csv', '3. 了解我们：https://central.parts/zh/', '',
  'electronica 2026 · 慕尼黑 · 11月10–13日 · B4 馆 251/12 展位，欢迎来访。', '',
  'Thank you for following Central.Parts. Link 1 registers your company and uploads your stock (valid 15 minutes). Meet us at electronica 2026, Hall B4, Booth 251/12.'].join('\n');
ok(R.welcomeText('dl_xxxxxxxx') === oldWelcome('dl_xxxxxxxx'), 'fournisseur, inchangé : accueil avec lien');
ok(R.welcomeText('') === oldWelcome('').replace(/\?login=\S*/, ''), 'fournisseur, inchangé : accueil sans lien');
ok(Buffer.byteLength(R.welcomeText('dl_' + 'a'.repeat(32))) < 2048 && Buffer.byteLength(R.welcomeText('dl_' + 'a'.repeat(32), true)) < 2048, 'accueil : sous 2 048 octets');
ok(R.receivedText() === '已收到您的消息，我们会尽快回复。\nMessage received, we will reply shortly.', 'fournisseur, inchangé : accusé de réception');
ok(R.approvedNotice('CP-S-0042') === '您的公司已通过 Central.Parts 审核（编号 CP-S-0042），库存已纳入 Central.Parts 平台。\nYour company has been approved by Central.Parts (CP-S-0042).', 'fournisseur, inchangé : avis de validation');
ok(R.rejectedNotice('licence illisible').startsWith('您的公司未通过 Central.Parts 审核：licence illisible\n如有疑问，请直接回复此消息。\n') && both(R.rejectedNotice('x')), 'fournisseur, bilingue : avis de refus (chinois d\'origine, puis anglais)');
ok(R.rejectedNotice('').startsWith('您的公司未通过 Central.Parts 审核。\n') && !R.rejectedNotice('').includes('reason above'), 'fournisseur : refus sans motif');
ok(R.operatorReplyText('Please send your stock list.') === 'Central.Parts 回复 · Reply from Central.Parts:\nPlease send your stock list.', 'fournisseur, bilingue : réponse d\'un opérateur (en-tête chinois et anglais, texte tel quel)');
const adm = src('admin/index.ts');
ok(/const APPROVED = approvedNotice;/.test(adm) && /const REJECTED = rejectedNotice;/.test(adm), 'back office : mêmes avis au fournisseur que le robot (robot-texts.js)');

console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
