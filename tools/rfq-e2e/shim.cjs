// Passerelle minimale façon PostgREST pour tools/test-rfq-e2e.mjs : /rest/v1/rpc/<fn> (exécutées avec le rôle
// service_role, comme les fonctions Edge) et lectures simples de tables. Jamais utilisée en production.
const http = require('http');
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.PGHOST || '/var/tmp', port: Number(process.env.PGPORT || 54329), user: 'postgres',
  password: process.env.PGPASSWORD, database: process.env.DB || 'cp_e2e' });

async function rpc(fn, args) {
  const keys = Object.keys(args);
  const vals = keys.map((k) => {
    const v = args[k];
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v;
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  });
  const call = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
  const c = await pool.connect();
  try {
    await c.query('set role service_role');
    const r = await c.query(`select * from ${call} as r`, vals);
    const cols = r.fields.map((f) => f.name);
    if (cols.length === 1 && cols[0] === 'r') {
      // Fonction scalaire : une ligne ; setof : plusieurs.
      const isSet = (await c.query(`select proretset from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace limit 1`, [fn])).rows[0]?.proretset;
      return isSet ? r.rows.map((x) => x.r) : r.rows[0]?.r ?? null;
    }
    return r.rows;
  } finally {
    await c.query('reset role').catch(() => {});
    c.release();
  }
}

http.createServer(async (req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    const u = new URL(req.url, 'http://x');
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    try {
      let m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(u.pathname);
      if (m) return send(200, await rpc(m[1], body ? JSON.parse(body) : {}));
      m = /^\/rest\/v1\/(\w+)$/.exec(u.pathname);
      if (m && req.method === 'GET') {
        const where = [], vals = [];
        for (const [k, v] of u.searchParams) {
          if (k === 'select' || k === 'limit' || k === 'order') continue;
          const [op, ...rest] = v.split('.'); const val = rest.join('.');
          if (op === 'eq') { vals.push(val); where.push(`${k} = $${vals.length}`); }
          if (op === 'is' && val === 'null') where.push(`${k} is null`);
        }
        const r = await pool.query(`select ${u.searchParams.get('select') || '*'} from public.${m[1]}${where.length ? ' where ' + where.join(' and ') : ''}`, vals);
        if ((req.headers.accept || '').includes('vnd.pgrst.object')) return r.rows.length ? send(200, r.rows[0]) : send(406, { code: 'PGRST116', message: 'no rows' });
        return send(200, r.rows);
      }
      if (m) return send(201, []);
      send(404, { message: 'not found' });
    } catch (e) {
      send(400, { code: e.code, message: e.message, details: e.detail ?? null, hint: null });
    }
  });
}).listen(Number(process.env.SHIM_PORT || 54400), () => console.log('passerelle prête'));
