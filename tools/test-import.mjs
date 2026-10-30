// Tests de lecture des fichiers de stock (supabase/functions/import-stock/parse.js)
// et des outils de la page de dépôt (supabase/functions/_shared/depot.js).
// Usage : node tools/test-import.mjs
import { cleanUrl, mapRows, parseCSV, price } from '../supabase/functions/import-stock/parse.js';
import { creditCodeOk, licensePath, parseWechatXml, randomScene, readSession, replyText, sceneOf, signSession, storagePath, wechatSignatureOk } from '../supabase/functions/_shared/depot.js';
import { createHash } from 'node:crypto';

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
ok(fx && fx.url === 'https://example.com/p/TPS62130RGTR?ref=7', 'lien produit sans paramètres utm');
ok(cleanUrl('pas un lien') === 'pas un lien' && cleanUrl('') === '', 'lien illisible gardé tel quel');

// En-têtes chinois.
const zh = mapRows(parseCSV('型号,品牌,数量,单价,批号,币种\nSTM32F103C8T6,ST,5000,1.2,2024+,RMB\n')).rows[0];
ok(zh && zh.mpn === 'STM32F103C8T6' && zh.mfr === 'ST' && zh.qty === 5000 && zh.price === 1.2 && zh.dc === '2024+' && zh.currency === 'RMB', 'en-têtes chinois : 型号, 品牌, 数量, 单价, 批号, 币种');

// Erreurs de fichier.
ok(mapRows(parseCSV('MPN,Quantity\n')).error.startsWith('Fichier vide'), 'fichier sans ligne de données');
ok(mapRows(parseCSV('Reference,Stock\nA,1\n')).error.startsWith('Colonnes obligatoires'), 'colonnes MPN ou quantité absentes');
ok(price('$12.5') === 12.5 && price('') === null && price('0') === null, 'prix : symbole, vide, zéro');

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
ok(licensePath('ORG-0105', '营业执照.JPEG', d) === 'ORG-0105/licence-20261030-142501.jpg' && licensePath('ORG-0105', 'a.pdf', d).endsWith('.pdf'), 'licence : chemin horodaté dans le dossier de la société');
ok(licensePath('ORG-0105', 'a.exe', d) === null, 'licence : format refusé');
ok(JSON.stringify(await readSession(secret, await signSession(secret, { org: null, openid: 'oNEW' }, 3600, now), now)) === '{"org":null,"openid":"oNEW"}', 'jeton : compte sans société, pour l\'inscription');

console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
