// Démonstration locale du back office (site/admin/) avec une API simulée : aucune connexion à Supabase,
// aucune donnée réelle, rien n'est envoyé (ni e-mail, ni message WeChat).
// Usage : node tools/demo-admin.mjs [port]   puis ouvrir l'adresse affichée (8766 par défaut).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMock } from './admin-mock.mjs';

const PORT = Number(process.argv[2]) || 8766;
const ROOT = fileURLToPath(new URL('../site/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.csv': 'text/csv' };
const { handle, state } = createMock();
const BASE = `http://localhost:${PORT}`;

createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  if (url.pathname.startsWith('/functions/v1/admin')) {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const [status, data] = handle(req.method, url.pathname.replace('/functions/v1/admin', '') || '/', url.searchParams, body, token);
    if (req.method === 'POST' && url.pathname.endsWith('/login') && status === 200) {
      console.log(`\nLien de connexion simulé pour ${body.email} (au lieu de l'e-mail) :\n  ${BASE}/admin/#access_token=DEMO-ADMIN&expires_in=3600\n`);
    }
    if (url.pathname.endsWith('/approve') || url.pathname.endsWith('/reject')) {
      const n = state.notified.at(-1);
      if (n && status === 200) console.log(`(simulé) Message WeChat au fournisseur ${n.org} : ${n.kind}${n.reason ? ' — ' + n.reason : ''}`);
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  }
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p.endsWith('/')) p += 'index.html';
  try {
    const file = await readFile(join(ROOT, p));
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404); res.end('Introuvable');
  }
}).listen(PORT, () => {
  console.log(`Démonstration du back office (API simulée, données fictives) :
  Administrateur connecté   ${BASE}/admin/#access_token=DEMO-ADMIN&expires_in=3600
  Compte non administrateur ${BASE}/admin/#access_token=DEMO-OTHER&expires_in=3600
  Écran de connexion        ${BASE}/admin/
Ctrl+C pour arrêter.`);
});
