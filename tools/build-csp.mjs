// En-tête de sécurité Content-Security-Policy du site (ADR 0031), écrit dans site/.htaccess entre les repères
// « # CSP:BEGIN » et « # CSP:END ».
//
// Les pages ont chacune un <script> en ligne (règle du dépôt : un seul script vanilla en fin de page) : au lieu
// d'autoriser tout script en ligne ('unsafe-inline'), l'en-tête liste l'empreinte sha256 de chaque script en ligne
// publié. Un script injecté ou modifié sans relancer cet outil est donc refusé par le navigateur.
//
// Usage : node tools/build-csp.mjs           met à jour site/.htaccess
//         node tools/build-csp.mjs --check   échoue si l'en-tête n'est plus à jour (CI)
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = fileURLToPath(new URL('../site/', import.meta.url));
const HTACCESS = join(SITE, '.htaccess');
const SUPABASE = 'https://tuhbzziqyisdnqzfvtkh.supabase.co';

// Sources autorisées, en dehors des scripts en ligne. Toute nouvelle source externe doit être ajoutée ici, dans un
// commit qui dit pourquoi (accès depuis la Chine : ADR 0006).
const POLICY = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],                       // + empreintes des scripts en ligne
  'style-src': ["'self'", "'unsafe-inline'"],     // styles en ligne des pages (attributs style), sans risque d'exécution
  'img-src': ["'self'", 'data:', 'https://mp.weixin.qq.com'], // QR code de connexion WeChat (/depot/)
  'font-src': ["'self'"],
  'connect-src': ["'self'", SUPABASE],            // fonctions Edge et dépôt des fichiers (stockage Supabase)
  'form-action': ["'self'", 'mailto:'],           // formulaire de contact de l'accueil (mailto)
  'frame-ancestors': ["'none'"],                  // pas d'affichage dans un cadre (clickjacking)
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
};

function pages(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...pages(p));
    else if (name.endsWith('.html')) out.push(p);
  }
  return out.sort();
}

// Scripts en ligne exécutables : <script> sans src, hors données (application/ld+json, application/json).
export function inlineScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1];
    if (type && !/^(text|application)\/(javascript|ecmascript)$|^module$/i.test(type)) continue;
    out.push(m[2]);
  }
  return out;
}

export function header() {
  const hashes = new Set();
  const files = [];
  for (const f of pages(SITE)) {
    const scripts = inlineScripts(readFileSync(f, 'utf8'));
    for (const s of scripts) hashes.add(`'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`);
    if (scripts.length) files.push(relative(SITE, f));
  }
  const policy = { ...POLICY, 'script-src': [...POLICY['script-src'], ...[...hashes].sort()] };
  const value = Object.entries(policy).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
  return { value, files, count: hashes.size };
}

function block(value) {
  return ['# CSP:BEGIN — généré par node tools/build-csp.mjs, ne pas modifier à la main (ADR 0031)',
    '<IfModule mod_headers.c>',
    `  Header always set Content-Security-Policy "${value}"`,
    '  Header always set X-Frame-Options "DENY"',
    '</IfModule>',
    '# CSP:END'].join('\n');
}

// Texte de site/.htaccess avec l'en-tête à jour.
function nextHtaccess() {
  const { value, files, count } = header();
  const ht = readFileSync(HTACCESS, 'utf8');
  const re = /# CSP:BEGIN[\s\S]*?# CSP:END/;
  const next = re.test(ht) ? ht.replace(re, block(value)) : ht.replace(/\n*$/, '\n\n') + block(value) + '\n';
  return { ht, next, files, count };
}

// Met à jour l'en-tête (appelé aussi par tools/build-site.mjs après la génération des pages).
export function writeCsp() {
  const { ht, next, count } = nextHtaccess();
  if (next !== ht) writeFileSync(HTACCESS, next);
  return count;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { ht, next, files, count } = nextHtaccess();
  if (process.argv.includes('--check')) {
    if (next !== ht) {
      console.error('ÉCHEC : l\'en-tête CSP de site/.htaccess n\'est plus à jour (un script en ligne a changé). Lancer : node tools/build-csp.mjs');
      process.exit(1);
    }
    console.log(`CSP à jour : ${count} script(s) en ligne autorisé(s) par empreinte, ${files.length} page(s).`);
  } else {
    writeFileSync(HTACCESS, next);
    console.log(`site/.htaccess mis à jour : ${count} empreinte(s), ${files.length} page(s).`);
  }
}
