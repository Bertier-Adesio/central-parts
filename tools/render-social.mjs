#!/usr/bin/env node
// Rend design/social-preview.html en site/social-preview-fr.png, -en.png et -zh.png (1200×630).
// Prérequis : Playwright (npm i -D playwright) et un Chromium ; lancer depuis la racine du dépôt :
//   node tools/render-social.mjs [fr en zh]   (toutes les langues par défaut ; CHROMIUM=/chemin/vers/chrome
//   pour un navigateur précis, PLAYWRIGHT=/chemin/vers/playwright si le paquet n'est pas installé dans le dépôt)

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const { chromium } = pw.default || pw;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.woff2': 'font/woff2' };

// Sert la page d'aperçu et les polices de site/assets/.
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const file = path === '/' ? join(ROOT, 'design/social-preview.html') : join(ROOT, 'site', path);
  let body;
  try { body = readFileSync(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.slice(path.lastIndexOf('.'))] || 'text/html; charset=utf-8' });
  res.end(body);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
const LANGS = process.argv.slice(2).length ? process.argv.slice(2) : ['fr', 'en', 'zh'];
for (const lang of LANGS) {
  await page.goto(`${base}?lang=${lang}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const out = join(ROOT, `site/social-preview-${lang}.png`);
  await page.screenshot({ path: out });
  console.log(out.replace(ROOT + '/', ''));
}
await browser.close();
server.close();
